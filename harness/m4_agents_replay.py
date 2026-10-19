#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M4：四类 Agent 的确定性回放与验收分数（M4-1 至 M4-4）。

与 ``harness/qc_agent_replay.py`` 同构：声明式配置 + 过滤注册表 + 结论契约 +
工具证据，FakeProvider 脚本化回合，trace 逐字节可对拍。5 条场景：

* ``device_monitor``        设备状态监测（读数含 1 条缺测的空值负例）
* ``fault_diagnosis``       故障研判（证据同时挂工具输出与知识库检索条目）
* ``operations_dispatch+``  调度：高风险动作过审批门并放行
* ``operations_dispatch-``  调度：同一动作被驳回、不执行
* ``archive``               归档：合成产物强制进 ``synthetic/`` 隔离路径

M4-2 的「回放分数不劣于 M3 基线」以 ``logs/qc_agent_replay.json``（M3，
2026-10-18：结论契约 valid、证据引用有效）为对照，判定写进 summary。

用法::

    python harness/m4_agents_replay.py --fixture harness/fixtures/m4_agents_replay_20261019.json
    python harness/m4_agents_replay.py --fixture <path> --bless
    python harness/m4_agents_replay.py --verify-log logs/m4_agents_replay.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.agents import runtime  # noqa: E402
from fieldstation.agents.approval import ApprovalGate, ApproveAll, RejectAll  # noqa: E402
from fieldstation.agents.conclusion import ConclusionContract, validate_conclusion  # noqa: E402
from fieldstation.agents.config import build, load_agent_config  # noqa: E402
from fieldstation.agents.knowledge import (  # noqa: E402
    KnowledgeBase,
    knowledge_search_tool,
    load_documents,
)
from fieldstation.agents.providers.base import ChatResponse  # noqa: E402
from fieldstation.agents.providers.fake import FakeProvider  # noqa: E402
from fieldstation.agents.tools import ToolRegistry  # noqa: E402
from fieldstation.agents.tools.archive_tools import ArchiveExportTool  # noqa: E402
from fieldstation.agents.tools.qc_tools import (  # noqa: E402
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
)
from fieldstation.agents.tools.station_tools import station_health_tool  # noqa: E402
from fieldstation.agents.tools.work_order_tools import (  # noqa: E402
    CreateWorkOrderTool,
    ExecuteDeviceActionTool,
)
from fieldstation.agents.trace.reader import read_trace  # noqa: E402
from fieldstation.agents.trace.writer import TraceWriter  # noqa: E402
from fieldstation.store import product  # noqa: E402
from fieldstation.store.work_order import WorkOrderService  # noqa: E402

FIXTURE_KIND = "fieldstation.m4_agents_replay.fixture"
FIXTURE_VERSION = 1
LOG_KIND = "fieldstation.m4_agents_replay.log"
LOG_NAME = "m4_agents_replay.json"
METRICS_NAME = "m4_agents_metrics.jsonl"
CONFIG_DIR = ROOT / "config" / "agents"
KB_DOCS = ROOT / "data" / "kb" / "knowledge.jsonl"

#: M3 基线（logs/qc_agent_replay.json，2026-10-18）：契约 valid 且证据引用有效
M3_BASELINE = {"contract_valid": True, "evidence_valid": True}

#: 归档场景期望的隔离路径（synthetic=true 由 store/product._isolated 强制改写）
ARCHIVE_EXPECTED_PATH = "qc/m4/synthetic/SYNTHETIC_summary.json"


def _sha256_canonical(obj) -> str:
    return hashlib.sha256(product.canonical_json(obj).encode("utf-8")).hexdigest()


def _config_hash(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    return _sha256_canonical(data)


def _readings(*, with_missing: bool) -> list[dict]:
    """设备读数：固定时间戳，``with_missing`` 时插入一条缺测。"""
    rows = [
        {"station_id": "BADG", "sensor": "power", "metric": "voltage",
         "value": 12.0, "unit": "V",
         "observed_at": "2026-10-19T08:00:00+00:00", "quality_flag": ""},
        {"station_id": "BADG", "sensor": "link", "metric": "rssi",
         "value": -88.0, "unit": "dBm",
         "observed_at": "2026-10-19T08:05:00+00:00", "quality_flag": ""},
    ]
    if with_missing:
        rows.insert(1, {
            "station_id": "BADG", "sensor": "power", "metric": "voltage",
            "value": None, "unit": "V",
            "observed_at": "2026-10-19T08:03:00+00:00", "quality_flag": "missing"})
    return rows


CONCLUSIONS = {
    "device_monitor": {
        "attribution": {
            "fault_type": "power_reading_missing",
            "evidence": [{
                "call_id": "t0001", "tool": "station_health",
                "finding": ("BADG 供电电压 2 条中缺测 1 条；健康度 0.667、"
                            "状态 degraded（标记 missing）"),
            }],
        },
        "recommendation": "先核对供电传感器与采集链路，确认缺测原因后再决定是否派单",
        "confidence": 0.8,
    },
    "fault_diagnosis": {
        "attribution": {
            "fault_type": "nonphysical_rmse",
            "evidence": [
                {"call_id": "t0001", "tool": "magnitude_verdict",
                 "finding": "RMSE 126922.1 TECU 超过 500 TECU 物理上限"},
                {"call_id": "t0002", "tool": "knowledge_search",
                 "finding": "命中规程 qc-nonphysical-rmse：超限应拒绝输出并复查定平链路"},
                {"call_id": "t0003", "tool": "station_health",
                 "finding": "BADG 读数健康度 1.0、状态 ok，问题集中在反演输出而非设备侧"},
            ],
        },
        "recommendation": "拒绝该反演输出，复查接收机钟与相位定平链路；设备侧暂无需动作",
        "confidence": 0.97,
    },
    "operations_dispatch_approved": {
        "attribution": {
            "fault_type": "link_outage",
            "evidence": [
                {"call_id": "t0001", "tool": "create_work_order",
                 "finding": "工单 WO-0001 已建：BADG P0 网络失联"},
                {"call_id": "t0002", "tool": "execute_device_action",
                 "finding": "重启接收机已获人工批准并受理（simulated）"},
            ],
        },
        "recommendation": "跟踪重启结果；若 15 分钟内未恢复，升级为现场处置",
        "confidence": 0.95,
    },
    "operations_dispatch_rejected": {
        "attribution": {
            "fault_type": "link_outage",
            "evidence": [{
                "call_id": "t0001", "tool": "create_work_order",
                "finding": "工单 WO-0001 已建：BADG P0 网络失联，等待人工决策",
            }],
        },
        "recommendation": "重启请求被驳回、未执行任何设备动作；转人工确认现场状态后重新评估",
        "confidence": 0.6,
    },
    "archive": {
        "attribution": {
            "fault_type": "archive_exported",
            "evidence": [
                {"call_id": "t0001", "tool": "archive_export",
                 "finding": "合成产物已隔离写入 qc/m4/synthetic/SYNTHETIC_summary.json"},
                {"call_id": "t0002", "tool": "knowledge_search",
                 "finding": "命中归档规程 archive-synthetic：合成数据必须进 synthetic/ 目录"},
            ],
        },
        "recommendation": "归档完成；该产物为合成数据，不得与真实产物混放",
        "confidence": 0.9,
    },
}


def _dispatch_responses(conclusion: dict) -> list[ChatResponse]:
    return [
        ChatResponse(content="", tool_calls=[{
            "name": "create_work_order",
            "args": {"station_id": "BADG", "title": "台站连续失联",
                     "priority": "P0", "risk": "medium",
                     "description": "4G 链路连续 30 分钟无上报",
                     "action": "restart_receiver"},
        }], usage={"prompt_tokens": 48, "completion_tokens": 10}),
        ChatResponse(content="", tool_calls=[{
            "name": "execute_device_action",
            "args": {"station_id": "BADG", "action": "restart_receiver",
                     "reason": "连续失联，需远程重启接收机", "confidence": 0.99},
        }], usage={"prompt_tokens": 70, "completion_tokens": 12}),
        ChatResponse(content=json.dumps(conclusion, ensure_ascii=False, sort_keys=True),
                     usage={"prompt_tokens": 90, "completion_tokens": 60}),
    ]


def _tool_results(trace: list[dict]) -> dict[str, dict]:
    return {e["call_id"]: e for e in trace
            if e.get("kind") == "tool_result" and isinstance(e.get("call_id"), str)}


def _contract_ok(validation) -> bool:
    if not validation.valid:
        return False
    evidence = validation.conclusion["attribution"]["evidence"]
    return len(validation.evidence_call_ids) == len(evidence)


def _check_device_monitor(trace, validation, ctx) -> dict:
    first = _tool_results(trace).get("t0001", {})
    summary = (first.get("result") or {}).get("summary") or {}
    return {
        "contract_valid": _contract_ok(validation),
        "null_reading_tolerated": bool(first.get("ok")) and summary.get("missing") == 1,
    }


def _check_fault_diagnosis(trace, validation, ctx) -> dict:
    results = _tool_results(trace)
    kb_ok = False
    for call_id in validation.evidence_call_ids:
        event = results.get(call_id, {})
        if event.get("tool") != "knowledge_search":
            continue
        rows = (event.get("result") or {}).get("results") or []
        if any(row.get("doc_id") == "qc-nonphysical-rmse" for row in rows):
            kb_ok = True
    return {
        "contract_valid": _contract_ok(validation),
        "kb_hit_cited": kb_ok,
    }


def _check_dispatch(trace, validation, ctx, *, approved: bool) -> dict:
    results = _tool_results(trace)
    verdicts = {e.get("verdict") for e in trace if e.get("kind") == "approval"}
    action = results.get("t0002", {})
    checks = {
        "contract_valid": _contract_ok(validation),
        "work_order_created": bool(results.get("t0001", {}).get("ok")),
    }
    if approved:
        checks["approval_approved"] = verdicts == {"approved"}
        checks["action_executed"] = bool(action.get("ok"))
    else:
        checks["approval_rejected"] = verdicts == {"rejected"}
        checks["action_blocked"] = (not action.get("ok")
                                    and "批准" in (action.get("error") or ""))
    return checks


def _check_archive(trace, validation, ctx) -> dict:
    first = _tool_results(trace).get("t0001", {})
    data = first.get("result") or {}
    return {
        "contract_valid": _contract_ok(validation),
        "synthetic_isolated": (data.get("path") == ARCHIVE_EXPECTED_PATH
                               and (ctx["archive_root"] / ARCHIVE_EXPECTED_PATH).is_file()),
    }


def _scenarios() -> list[dict]:
    return [
        {
            "key": "device_monitor",
            "config": "device_monitor.json",
            "input": "台站 BADG 一批供电与链路读数如下（含 1 条缺测）。请汇总健康度并给出结论。",
            "responses": [
                ChatResponse(content="", tool_calls=[{
                    "name": "station_health",
                    "args": {"readings": _readings(with_missing=True)}}],
                    usage={"prompt_tokens": 40, "completion_tokens": 8}),
                ChatResponse(content=json.dumps(
                    CONCLUSIONS["device_monitor"], ensure_ascii=False, sort_keys=True),
                    usage={"prompt_tokens": 60, "completion_tokens": 40}),
            ],
            "gate": None,
            "check": _check_device_monitor,
        },
        {
            "key": "fault_diagnosis",
            "config": "fault_diagnosis.json",
            "input": "反演输出 RMSE=126922.1 TECU 超限。先做量级守卫、再查规程，给出故障研判。",
            "responses": [
                ChatResponse(content="", tool_calls=[{
                    "name": "magnitude_verdict", "args": {"rmse": 126922.1}}],
                    usage={"prompt_tokens": 44, "completion_tokens": 6}),
                ChatResponse(content="", tool_calls=[
                    {"name": "knowledge_search",
                     "args": {"query": "RMSE 超过 500 TECU", "limit": 3}},
                    {"name": "station_health",
                     "args": {"readings": _readings(with_missing=False)}},
                ], usage={"prompt_tokens": 66, "completion_tokens": 14}),
                ChatResponse(content=json.dumps(
                    CONCLUSIONS["fault_diagnosis"], ensure_ascii=False, sort_keys=True),
                    usage={"prompt_tokens": 96, "completion_tokens": 70}),
            ],
            "gate": None,
            "check": _check_fault_diagnosis,
        },
        {
            "key": "operations_dispatch+",
            "config": "operations_dispatch.json",
            "input": "台站 BADG 连续 30 分钟无上报。请建单，并评估是否需要重启接收机。",
            "responses": _dispatch_responses(CONCLUSIONS["operations_dispatch_approved"]),
            "gate": "approve",
            "check": lambda trace, validation, ctx: _check_dispatch(
                trace, validation, ctx, approved=True),
        },
        {
            "key": "operations_dispatch-",
            "config": "operations_dispatch.json",
            "input": "台站 BADG 连续 30 分钟无上报。请建单，并评估是否需要重启接收机。",
            "responses": _dispatch_responses(CONCLUSIONS["operations_dispatch_rejected"]),
            "gate": "reject",
            "check": lambda trace, validation, ctx: _check_dispatch(
                trace, validation, ctx, approved=False),
        },
        {
            "key": "archive",
            "config": "archive.json",
            "input": "把本次质控汇总作为合成产物归档。",
            "responses": [
                ChatResponse(content="", tool_calls=[
                    {"name": "archive_export", "args": {
                        "relative_path": "qc/m4/summary.json",
                        "payload": {"run": "m4-replay", "result": "passed",
                                    "note": "synthetic replay artifact"},
                        "synthetic": True}},
                    {"name": "knowledge_search",
                     "args": {"query": "合成产物归档放在哪里", "limit": 3}},
                ], usage={"prompt_tokens": 38, "completion_tokens": 12}),
                ChatResponse(content=json.dumps(
                    CONCLUSIONS["archive"], ensure_ascii=False, sort_keys=True),
                    usage={"prompt_tokens": 58, "completion_tokens": 44}),
            ],
            "gate": None,
            "check": _check_archive,
        },
    ]


def _run_scenario(spec: dict, metrics_path: Path) -> dict:
    cfg_path = CONFIG_DIR / spec["config"]
    cfg = load_agent_config(cfg_path)
    provider = FakeProvider(list(spec["responses"]))
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        kb = KnowledgeBase(td / "kb.sqlite3")
        kb.index(load_documents(KB_DOCS))
        base = ToolRegistry()
        for tool in (
            knowledge_search_tool(kb),
            station_health_tool(),
            robust_stats_tool(),
            continuity_verdict_tool(),
            magnitude_verdict_tool(),
            CreateWorkOrderTool(WorkOrderService()),
            ExecuteDeviceActionTool(),
            ArchiveExportTool(td / "archive"),
        ):
            base.register(tool)
        agent, scoped = build(cfg, provider, base)
        trace_path = td / "trace.jsonl"
        gates = {"approve": ApprovalGate(approver=ApproveAll()),
                 "reject": ApprovalGate(approver=RejectAll())}
        conclusion = runtime.run(
            agent, spec["input"], TraceWriter(trace_path),
            registry=scoped, approval=gates.get(spec["gate"]),
            contract=ConclusionContract(), capture_tool_results=True,
            metrics=TraceWriter(metrics_path))
        trace = read_trace(trace_path)
        validation = validate_conclusion(
            conclusion, trace, contract=ConclusionContract())
        if not validation.valid:
            raise RuntimeError(
                f"{spec['key']} 结论未通过证据校验：" + "；".join(validation.errors))
        checks = spec["check"](trace, validation, {"archive_root": td / "archive"})
        results = _tool_results(trace)
        record = {
            "key": spec["key"],
            "config": spec["config"],
            "config_hash": _config_hash(cfg_path),
            "conclusion": conclusion,
            "evidence_call_ids": list(validation.evidence_call_ids),
            "evidence_tools": [results[cid].get("tool")
                               for cid in validation.evidence_call_ids],
            "checks": checks,
            "trace": trace,
            "trace_sha256": _sha256_canonical(trace),
        }
    record["sha256"] = _sha256_canonical({
        k: record[k] for k in
        ("key", "config", "config_hash", "conclusion", "checks", "trace")})
    return record


def run_once(log_dir: Path) -> dict:
    log_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = log_dir / METRICS_NAME
    metrics_path.write_text("", encoding="utf-8")
    scenarios = [_run_scenario(spec, metrics_path) for spec in _scenarios()]

    evidence_total = 0
    evidence_valid = 0
    for s in scenarios:
        evidence = json.loads(s["conclusion"])["attribution"]["evidence"]
        evidence_total += len(evidence)
        if s["checks"]["contract_valid"]:
            evidence_valid += len(s["evidence_call_ids"])
    contract_valid = sum(1 for s in scenarios if s["checks"]["contract_valid"])
    checks_total = sum(len(s["checks"]) for s in scenarios)
    checks_passed = sum(1 for s in scenarios for v in s["checks"].values() if v)
    summary = {
        "scenarios": len(scenarios),
        "contract_valid": contract_valid,
        "checks": f"{checks_passed}/{checks_total}",
        "evidence": f"{evidence_valid}/{evidence_total}",
        "baseline_m3": dict(M3_BASELINE),
        "not_worse_than_m3": (contract_valid == len(scenarios)
                              and evidence_valid == evidence_total),
    }
    log = {
        "kind": LOG_KIND,
        "version": FIXTURE_VERSION,
        "scenarios": scenarios,
        "summary": summary,
    }
    log["sha256"] = _sha256_canonical({
        "scenarios": [s["sha256"] for s in scenarios], "summary": summary})
    return log


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False, sort_keys=True)
        fh.write("\n")


def _write_fixture(path: Path, log: dict) -> None:
    _write_json(path, {
        "kind": FIXTURE_KIND,
        "version": FIXTURE_VERSION,
        "scenarios": {
            s["key"]: {"config_hash": s["config_hash"], "sha256": s["sha256"]}
            for s in log["scenarios"]},
        "sha256": log["sha256"],
    })


def verify_log(path: Path) -> int:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[阻断] 读不了日志 {path}: {exc}")
        return 2
    if record.get("kind") != LOG_KIND:
        print(f"[阻断] {path} 不是 M4 Agent 回放日志")
        return 2
    all_ok = True
    for s in record.get("scenarios", []):
        result = validate_conclusion(
            s.get("conclusion", ""), s.get("trace", []),
            contract=ConclusionContract())
        checks = s.get("checks") or {}
        checks_ok = bool(checks) and all(checks.values())
        ok = result.valid and checks_ok
        all_ok = all_ok and ok
        detail = ", ".join(result.evidence_call_ids) or "(无)"
        if ok:
            print(f"PASS {s.get('key')}: 证据引用 {detail}；checks 全过")
        else:
            errors = list(result.errors) or ["checks 未全过：" + str(checks)]
            print(f"FAIL {s.get('key')}: " + "；".join(errors))
    n = len(record.get("scenarios", []))
    if all_ok:
        print(f"PASS {n} 个场景的证据引用与 checks 全部有效")
        return 0
    print("FAIL 存在结论证据无效或 checks 未全过的场景")
    return 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="M4 四类 Agent 确定性回放")
    ap.add_argument("--fixture", help="fixture JSON 路径")
    ap.add_argument("--log-dir", default=str(ROOT / "logs"))
    ap.add_argument("--bless", action="store_true")
    ap.add_argument("--verify-log", help="只重新校验一份已落盘日志")
    args = ap.parse_args(argv)

    if args.verify_log:
        return verify_log(Path(args.verify_log))
    if not args.fixture:
        print("[阻断] 缺少 --fixture")
        return 2

    fixture_path = Path(args.fixture)
    if not fixture_path.is_absolute():
        fixture_path = (Path.cwd() / fixture_path).resolve()
    fixture = None
    if fixture_path.exists():
        try:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[阻断] 读不了 fixture {fixture_path}: {exc}")
            return 2
        if fixture.get("kind") != FIXTURE_KIND:
            print("[阻断] fixture kind 不匹配")
            return 2
    elif not args.bless:
        print(f"[阻断] 找不到 fixture {fixture_path}（新建基线请加 --bless）")
        return 2

    log_dir = Path(args.log_dir)
    if not log_dir.is_absolute():
        log_dir = (Path.cwd() / log_dir).resolve()
    log = run_once(log_dir)
    _write_json(log_dir / LOG_NAME, log)

    ok = True
    for s in log["scenarios"]:
        passed = sum(1 for v in s["checks"].values() if v)
        total = len(s["checks"])
        expected = ((fixture or {}).get("scenarios") or {}).get(s["key"]) or {}
        good = (expected.get("config_hash") == s["config_hash"]
                and expected.get("sha256") == s["sha256"])
        ok = ok and good
        tag = "bless" if args.bless else ("PASS" if good else "FAIL")
        print(f"  {s['key']:<24} checks {passed}/{total}  "
              f"sha256 {s['sha256'][:12]}…  {tag}")

    summary = log["summary"]
    print(f"  summary scenarios {summary['contract_valid']}/{summary['scenarios']} valid, "
          f"checks {summary['checks']}, evidence {summary['evidence']}, "
          f"not_worse_than_m3={summary['not_worse_than_m3']}")
    if not args.bless:
        same = fixture.get("sha256") == log["sha256"]
        ok = ok and same
        print(f"  expected    {fixture.get('sha256')}")
    print(f"sha256: {log['sha256']}")

    if args.bless:
        _write_fixture(fixture_path, log)
        print(f"[BLESS] 已写入 {fixture_path}")
        return 0
    if ok and summary["not_worse_than_m3"]:
        print("PASS M4 回放基线与 fixture 一致")
        return 0
    print("FAIL M4 回放基线与 fixture 不一致")
    return 1


if __name__ == "__main__":
    sys.exit(main())
