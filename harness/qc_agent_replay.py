#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M3-3：质量校验 Agent 的结构化结论回放基线。

与 M0 的 ``harness/replay.py`` 分开：后者保留原有单轮自由文本基线；本脚本使用
M3 的真实装配路径（声明式配置 + 过滤注册表 + 结论契约 + 工具证据）跑一条
确定性回放，并能从已落盘日志重新校验证据引用。

用法::

    python harness/qc_agent_replay.py --fixture harness/fixtures/qc_agent_replay_20261018.json
    python harness/qc_agent_replay.py --fixture <path> --bless
    python harness/qc_agent_replay.py --verify-log logs/qc_agent_replay.json
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
from fieldstation.agents.conclusion import ConclusionContract, validate_conclusion  # noqa: E402
from fieldstation.agents.config import build, load_agent_config  # noqa: E402
from fieldstation.agents.providers.base import ChatResponse  # noqa: E402
from fieldstation.agents.providers.fake import FakeProvider  # noqa: E402
from fieldstation.agents.tools import ToolRegistry  # noqa: E402
from fieldstation.agents.tools.qc_tools import (  # noqa: E402
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
    slip_detect_tool,
)
from fieldstation.agents.trace.reader import read_trace  # noqa: E402
from fieldstation.agents.trace.writer import TraceWriter  # noqa: E402
from fieldstation.store import product  # noqa: E402

FIXTURE_KIND = "fieldstation.qc_agent_replay.fixture"
FIXTURE_VERSION = 1
LOG_KIND = "fieldstation.qc_agent_replay.log"
LOG_NAME = "qc_agent_replay.json"
METRICS_NAME = "qc_agent_metrics.jsonl"
CONFIG_PATH = ROOT / "config" / "agents" / "qc.json"

CONCLUSION = {
    "attribution": {
        "fault_type": "nonphysical_rmse",
        "evidence": [{
            "call_id": "t0001",
            "tool": "magnitude_verdict",
            "finding": "RMSE 126922.1 TECU 超过 500 TECU 物理上限",
        }],
    },
    "recommendation": "拒绝该反演输出，复查接收机钟与相位定平链路",
    "confidence": 0.99,
}

RESPONSES = [
    ChatResponse(
        content="",
        tool_calls=[{
            "name": "magnitude_verdict",
            "args": {"rmse": 126922.1},
        }],
        usage={"prompt_tokens": 12, "completion_tokens": 4},
    ),
    ChatResponse(
        content=json.dumps(CONCLUSION, ensure_ascii=False, sort_keys=True),
        usage={"prompt_tokens": 20, "completion_tokens": 30},
    ),
]


def _sha256_canonical(obj) -> str:
    return hashlib.sha256(product.canonical_json(obj).encode("utf-8")).hexdigest()


def _config_hash() -> str:
    data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return _sha256_canonical(data)


def _registry() -> ToolRegistry:
    reg = ToolRegistry()
    for tool in (
        robust_stats_tool(),
        slip_detect_tool(),
        continuity_verdict_tool(),
        magnitude_verdict_tool(),
    ):
        reg.register(tool)
    return reg


def run_once(log_dir: Path) -> dict:
    cfg = load_agent_config(CONFIG_PATH)
    base = _registry()
    provider = FakeProvider(list(RESPONSES))
    agent, scoped = build(cfg, provider, base)
    log_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = log_dir / METRICS_NAME
    metrics_path.write_text("", encoding="utf-8")

    with tempfile.TemporaryDirectory() as td:
        trace_path = Path(td) / "trace.jsonl"
        conclusion = runtime.run(
            agent,
            "评估 RMSE=126922.1 TECU 的反演输出；先调用量级守卫，再给结构化结论。",
            TraceWriter(trace_path),
            registry=scoped,
            contract=ConclusionContract(),
            capture_tool_results=True,
            metrics=TraceWriter(metrics_path),
        )
        trace = read_trace(trace_path)

    validation = validate_conclusion(conclusion, trace, contract=ConclusionContract())
    if not validation.valid:
        raise RuntimeError("回放结论未通过证据校验：" + "；".join(validation.errors))

    payload = {"conclusion": conclusion, "trace": trace}
    actual = _sha256_canonical(payload)
    metrics = read_trace(metrics_path)
    return {
        "kind": LOG_KIND,
        "version": FIXTURE_VERSION,
        "config_hash": _config_hash(),
        "conclusion": conclusion,
        "conclusion_validation": {
            "valid": True,
            "evidence_call_ids": list(validation.evidence_call_ids),
        },
        "trace": trace,
        "metrics_count": len(metrics),
        "trace_sha256": _sha256_canonical(trace),
        "actual_sha256": actual,
    }


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False, sort_keys=True)
        fh.write("\n")


def _write_fixture(path: Path, record: dict) -> None:
    _write_json(path, {
        "kind": FIXTURE_KIND,
        "version": FIXTURE_VERSION,
        "config_hash": record["config_hash"],
        "expected_sha256": record["actual_sha256"],
        "blessed": {
            "trace_sha256": record["trace_sha256"],
            "conclusion": json.loads(record["conclusion"]),
            "evidence_call_ids":
                record["conclusion_validation"]["evidence_call_ids"],
        },
    })


def verify_log(path: Path) -> int:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[阻断] 读不了日志 {path}: {exc}")
        return 2
    if record.get("kind") != LOG_KIND:
        print(f"[阻断] {path} 不是 M3 Agent 回放日志")
        return 2
    result = validate_conclusion(
        record.get("conclusion", ""), record.get("trace", []),
        contract=ConclusionContract())
    if not result.valid:
        print("FAIL 结论证据校验失败：" + "；".join(result.errors))
        return 1
    print("PASS 证据引用有效：" + ", ".join(result.evidence_call_ids))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="质量校验 Agent 结构化结论回放")
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
    record = run_once(log_dir)
    _write_json(log_dir / LOG_NAME, record)

    print(f"  config_hash {record['config_hash']}")
    print(f"  evidence    {record['conclusion_validation']['evidence_call_ids']}")
    print(f"  trace       {len(record['trace'])} events")
    print(f"  metrics     {record['metrics_count']} events")
    print(f"sha256: {record['actual_sha256']}")

    if args.bless:
        _write_fixture(fixture_path, record)
        print(f"[BLESS] 已写入 {fixture_path}")
        return 0

    expected = str(fixture.get("expected_sha256", ""))
    expected_config = str(fixture.get("config_hash", ""))
    good = (expected == record["actual_sha256"]
            and expected_config == record["config_hash"])
    print(f"  expected    {expected}")
    if good:
        print("PASS 结构化结论、证据引用与 trace 基线一致")
        return 0
    print("FAIL 结构化结论、证据引用或 trace 基线不一致")
    return 1


if __name__ == "__main__":
    sys.exit(main())
