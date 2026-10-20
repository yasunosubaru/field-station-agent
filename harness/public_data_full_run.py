"""公开数据全流程演示（M5 之后的「公开数据版」，用于结题标准演示）。

跑一条**完整五阶段链**：intake → qc → device_monitor → fault_diagnosis →
operations_dispatch（高风险动作过审批门）→ archive。

与 M5-1 回放的差别（都是刻意为之，写在这里免得被误读）：

* **设备侧输入是公开数据**：Open-Meteo 八达岭逐小时气象（登记在
  ``data/public/manifest.json``，CC BY 4.0），按一条**示例规则**给低温小时打
  ``low_temp`` 标记 → 真实触发一次设备质量标记。这条规则是演示用的示例阈值，
  **不是工程判据**（见 ``docs/operations/public-data.md``）。
* **模型换成「事实合成器」**（``FactProvider``）：它按上游消息里的真实内容决定调
  哪个工具、传什么参数，并在工具返回后**用返回的真实数字**拼结论 —— 结论里的每个
  数字都能在 trace 的 ``tool_result`` 里对上，不是写死的文案。
* **观测侧仍是合成样本**：公开的 GNSS 观测文件自 1999 年起都是 CRINEX（gfzrnx
  私有紧缩），本仓库按既有决定不解码（见 ``docs/operations/public-data.md`` 与
  issue #99）。这一段的结论来自**真实判据在合成数据上的计算**。

输出 ``logs/public_data_full_run_202401d01.json``：**确定性**（不含时间戳与耗时），
同一输入两次运行逐字节相同。演示汇报见
``docs/reports/2026-10-20-公开数据全流程演示与DoD核对.md``。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT / "harness")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from m5_pipeline_replay import KB_DOCS, STATION, _sample, _scenario  # noqa: E402
from public_data_replay import readings_from_open_meteo  # noqa: E402

from fieldstation.agents.approval import ApprovalGate, ApproveAll  # noqa: E402
from fieldstation.agents.bus import MessageBus  # noqa: E402
from fieldstation.agents.conclusion import ConclusionContract  # noqa: E402
from fieldstation.agents.config import build, load_agent_config  # noqa: E402
from fieldstation.agents.knowledge import (  # noqa: E402
    KnowledgeBase,
    knowledge_search_tool,
    load_documents,
)
from fieldstation.agents.pipeline import (  # noqa: E402
    Pipeline,
    PipelineStage,
    reading_payloads,
)
from fieldstation.agents.providers.base import ChatResponse  # noqa: E402
from fieldstation.agents.tools import ToolRegistry  # noqa: E402
from fieldstation.agents.tools.archive_tools import ArchiveExportTool  # noqa: E402
from fieldstation.agents.tools.qc_tools import (  # noqa: E402
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
    slip_detect_tool,
)
from fieldstation.agents.tools.station_tools import station_health_tool  # noqa: E402
from fieldstation.agents.tools.work_order_tools import (  # noqa: E402
    CreateWorkOrderTool,
    ExecuteDeviceActionTool,
)
from fieldstation.agents.trace.reader import read_trace  # noqa: E402
from fieldstation.agents.trace.writer import TraceWriter  # noqa: E402
from fieldstation.store.work_order import WorkOrderService  # noqa: E402

LOG_KIND = "fieldstation.public_data_full_run.log"
LOG_VERSION = 1
CONFIG_DIR = ROOT / "config" / "agents"
PUBLIC_SAMPLE = (ROOT / "data" / "public" / "samples" /
                 "openmeteo_badg_202401_d01.json")
MANIFEST = ROOT / "data" / "public" / "manifest.json"

#: 演示规则：机房温度低于该值记 ``low_temp`` 质量标记（**示例阈值，非工程判据**）。
LOW_TEMP_C = -10.0
#: 知识库查询词：按**真实发现**挑规程（词表来自 data/kb/knowledge.jsonl 的实测命中）。
KB_RULES = (
    ("phase_slip", "持续相位阶跃 定平链路 处理"),
    ("device_flag", "读数 持续 偏离 基线"),
    ("high_risk", "高风险 动作 审批 远程重启"),
    ("archive", "合成产物 归档"),
)

#: 故障类型 → 面向人的说法（工单标题用；原始 fault_type 仍写进 description，可回查）
FAULT_PHRASE = {
    "phase_slip_detected": "载波相位周跳/持续阶跃",
    "no_phase_slip_detected": "未检出周跳",
    "device_quality_flag": "设备读数质量异常",
    "device_normal": "设备读数正常",
    "phase_slip_with_device_degradation": "载波相位周跳 + 设备读数异常",
    "quality_review_with_device_degradation": "质量复核 + 设备读数异常",
    "quality_review": "质量复核",
    "remediation_dispatched": "处置已派发",
    "archive_exported": "已归档",
}

_PAYLOAD_RE = re.compile(
    r"^\[(m\d+)\] topic=(\S+) sender=(\S+) refs=\[[^\]]*\] payload=(\{.*\})$")


# ------------------------------------------------------------------ 工具函数
def _payloads(messages) -> list[tuple[str, str, dict]]:
    """从**最后一条 user 消息**里取出上游消息的 (msg_id, topic, payload)。

    注意不能只看 ``messages[-1]``：拼结论时最后一条是工具返回，user 消息在更早
    之前 —— 一旦取错，上游结论就会是空的（第一版就踩了这个坑）。
    """
    user_text = ""
    for message in messages:
        if message.role == "user":
            user_text = message.content
    out = []
    for line in user_text.splitlines():
        match = _PAYLOAD_RE.match(line.strip())
        if match:
            out.append((match.group(1), match.group(2), json.loads(match.group(4))))
    return out


def _tool_results(messages) -> list[tuple[str, str, dict]]:
    """从对话里取出工具返回 (工具名, call_id, 结果)。"""
    out = []
    for message in messages:
        if message.role != "tool":
            continue
        head, _, body = message.content.partition("] ")
        parts = head.strip("[]").split("][")
        name = parts[0] if parts else ""
        call_id = parts[1] if len(parts) > 1 else ""
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {"error": body}
        out.append((name, call_id, data))
    return out


def _conclusion(fault_type: str, evidence: list[dict], recommendation: str,
                 confidence: float = 0.9) -> str:
    return json.dumps({
        "attribution": {"fault_type": fault_type, "evidence": evidence},
        "recommendation": recommendation,
        "confidence": confidence,
    }, ensure_ascii=False, sort_keys=True)


# ------------------------------------------------------------ 事实合成器
class FactProvider:
    """按上游消息决定工具调用，用工具返回的**真实数字**拼结论。

    它替代模型，只用于公开数据演示：工具是真的、判据是真的，结论里的数字来自
    工具返回 —— 不是写死的文案。
    """

    name = "fact"

    def __init__(self, plan, compose):
        self._plan = plan
        self._compose = compose
        self._planned = False

    def chat(self, messages, tools):
        if not self._planned:
            self._planned = True
            return ChatResponse(content="", tool_calls=self._plan(messages))
        return ChatResponse(content=self._compose(_tool_results(messages), messages))


def _qc_plan(messages):
    payloads = _payloads(messages)
    observations = next((p for _, _, p in payloads if "groups" in p), {})
    calls = []
    for group in observations.get("groups", []):
        calls.append({"name": "slip_detect", "args": group["tool_args"],
                      "reason": f"质控 {group['key']}", "confidence": 0.9})
    return calls


def _qc_compose(results, messages):
    evidence = []
    slips = 0
    for name, call_id, data in results:
        counts = data.get("counts") or {}
        indices = list(data.get("slip_indices") or [])
        slips += int(counts.get("union", 0) or 0)
        evidence.append({
            "call_id": call_id, "tool": name,
            "finding": (f"counts={dict(counts)}，slip_indices={indices}，"
                        f"n_epochs={data.get('n_epochs')}"),
        })
    fault_type = "phase_slip_detected" if slips else "no_phase_slip_detected"
    recommendation = (f"检出 {slips} 处周跳/相位阶跃，按相位滑移流程复查定平链路"
                      if slips else "本批未检出周跳/相位阶跃，可继续下游处理")
    return _conclusion(fault_type, evidence, recommendation)


def _device_plan(messages):
    payloads = _payloads(messages)
    device = next((p for _, _, p in payloads if "readings" in p), {})
    return [{"name": "station_health",
             "args": {"readings": device.get("readings", [])},
             "reason": "汇总公开数据台站读数健康度", "confidence": 0.9}]


def _device_compose(results, messages):
    evidence = []
    status = "unknown"
    score = None
    missing = 0
    flags: list[str] = []
    for name, call_id, data in results:
        summary = data.get("summary") or {}
        missing = int(summary.get("missing", 0) or 0)
        for station in data.get("stations") or []:
            status = station.get("status")
            score = station.get("health_score")
            flags = list(station.get("quality_flags") or [])
        evidence.append({
            "call_id": call_id, "tool": name,
            "finding": (f"健康度 {score}（{status}），缺测 {missing} 条，"
                        f"质量标记 {flags}"),
        })
    fault_type = "device_quality_flag" if (flags or missing) else "device_normal"
    recommendation = (f"台站读数异常（质量标记 {flags}、缺测 {missing} 条），"
                      f"按规程 {LOW_TEMP_C}°C 低温示例规则派单处置"
                      if (flags or missing) else "台站读数正常，无需派单")
    return _conclusion(fault_type, evidence, recommendation)


def _diagnosis_plan(messages):
    """按**真实发现**挑规程：质控有周跳 → 相位规程；设备有标记 → 偏离基线规程。"""
    payloads = _payloads(messages)
    qc = next((p for _, _, p in payloads if "conclusion" in p), {})
    device = next((p for _, _, p in payloads
                   if (p.get("artifacts") or {}).get("station_health")), {})
    qc_type = ((qc.get("conclusion") or {}).get("attribution") or {}).get("fault_type", "")
    health = ((device.get("artifacts") or {}).get("station_health") or {})
    statuses = [s.get("status") for s in health.get("stations") or []]
    calls = []
    if "phase_slip" in qc_type:
        calls.append({"name": "knowledge_search",
                      "args": {"query": dict(KB_RULES)["phase_slip"], "limit": 2},
                      "reason": "质控检出相位阶跃，查相位处置规程", "confidence": 0.9})
    if any(status and status != "ok" for status in statuses):
        calls.append({"name": "knowledge_search",
                      "args": {"query": dict(KB_RULES)["device_flag"], "limit": 2},
                      "reason": "设备读数异常，查传感器偏离规程", "confidence": 0.9})
    if not calls:
        calls.append({"name": "knowledge_search",
                      "args": {"query": dict(KB_RULES)["phase_slip"], "limit": 2},
                      "reason": "无明确异常，按基线规程复核", "confidence": 0.9})
    return calls


def _diagnosis_compose(results, messages):
    evidence = []
    doc_ids = []
    for name, call_id, data in results:
        hits = data.get("results") or []
        doc_ids.extend(hit.get("doc_id") for hit in hits)
        if hits:
            finding = (f"命中规程 {doc_ids[-len(hits):]}："
                       + "；".join(hit.get("title", "") for hit in hits))
        else:
            finding = "知识库无命中"
        evidence.append({"call_id": call_id, "tool": name, "finding": finding})
    upstream = _payloads(messages)
    qc = next((p for _, _, p in upstream if "conclusion" in p), {})
    device = next((p for _, _, p in upstream
                   if (p.get("artifacts") or {}).get("station_health")), {})
    qc_type = ((qc.get("conclusion") or {}).get("attribution") or {}).get("fault_type", "")
    health = ((device.get("artifacts") or {}).get("station_health") or {})
    stations = health.get("stations") or []
    score = next((s.get("health_score") for s in stations), None)
    status = next((s.get("status") for s in stations), None)
    fault_type = "phase_slip" if "phase_slip" in qc_type else "quality_review"
    if status and status != "ok":
        fault_type += "_with_device_degradation"
    return _conclusion(
        fault_type, evidence,
        f"按命中规程处置：质控 {qc_type}，设备健康度 {score}（{status}）")


def _dispatch_plan(messages):
    payloads = _payloads(messages)
    diagnosis = next((p for _, _, p in payloads if "conclusion" in p), {})
    conclusion = diagnosis.get("conclusion") or {}
    attribution = conclusion.get("attribution") or {}
    fault_type = attribution.get("fault_type", "")
    evidence_ids = list(diagnosis.get("evidence_call_ids") or [])
    description = (f"研判 {fault_type}；证据 {evidence_ids}；"
                   f"建议 {conclusion.get('recommendation', '')}")
    phrase = FAULT_PHRASE.get(fault_type, fault_type)
    calls = [
        {"name": "create_work_order", "args": {
            "station_id": STATION,
            "title": f"{STATION} {phrase} 处置",
            "priority": "P1",
            "risk": "medium",
            "description": description,
            "action": "restart_receiver",
            "evidence_call_ids": evidence_ids},
         "reason": "按研判结论建单", "confidence": 0.9},
        {"name": "knowledge_search",
         "args": {"query": dict(KB_RULES)["high_risk"], "limit": 2},
         "reason": "高风险动作需按审批规程执行", "confidence": 0.9},
        {"name": "execute_device_action", "args": {
            "station_id": STATION, "action": "restart_receiver",
            "reason": description, "confidence": 0.9},
         "reason": "重启接收机并复查定平链路", "confidence": 0.9},
    ]
    return calls


def _dispatch_compose(results, messages):
    evidence = []
    order = None
    action = None
    docs = []
    for name, call_id, data in results:
        if name == "create_work_order":
            order = data
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": (f"工单 {data.get('order_id')} 已建：{data.get('title')}"
                            f"（{data.get('priority')}）")})
        elif name == "execute_device_action":
            action = data
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": (f"动作 {data.get('action')} 状态 {data.get('status')}"
                            f"（{data.get('execution_mode')}）")})
        else:
            hits = data.get("results") or []
            docs.extend(hit.get("doc_id") for hit in hits)
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": f"命中规程 {docs}"})
    return _conclusion(
        "remediation_dispatched", evidence,
        (f"已建工单 {order.get('order_id') if order else '?'}，"
         f"动作 {action.get('action') if action else '?'} 已提交（需人工审批）"))


def _archive_plan(messages):
    payloads = _payloads(messages)
    dispatch = next((p for _, _, p in payloads if "artifacts" in p), {})
    order = (dispatch.get("artifacts") or {}).get("work_order") or {}
    return [
        {"name": "archive_export", "args": {
            "relative_path": "pipeline/m5_public/chain_summary.json",
            "payload": {
                "station": STATION,
                "order": {"order_id": order.get("order_id"),
                          "priority": order.get("priority"),
                          "status": order.get("status")},
                "source": "public data full run demo"},
            "synthetic": True},
         "reason": "把本次公开数据全链摘要归档", "confidence": 0.9},
        {"name": "knowledge_search",
         "args": {"query": dict(KB_RULES)["archive"], "limit": 2},
         "reason": "核对归档隔离规程", "confidence": 0.9},
    ]


def _archive_compose(results, messages):
    evidence = []
    written = None
    for name, call_id, data in results:
        if name == "archive_export":
            written = data
            size = f"，{data.get('bytes')} B" if data.get("bytes") else ""
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": (f"已写入 {data.get('path')}（sha256 {data.get('sha256')}"
                            f"{size}，synthetic={data.get('synthetic')}）")})
        else:
            hits = data.get("results") or []
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": f"命中规程 {[h.get('doc_id') for h in hits]}"})
    return _conclusion(
        "archive_exported", evidence,
        f"全链摘要已归档到 {written.get('path') if written else '?'}")


# ------------------------------------------------------------------ 数据准备
def public_device_payload() -> tuple[dict, dict]:
    """公开气象 → 设备读数 → intake payload；返回 (payload, 数据源说明)。"""
    data = json.loads(PUBLIC_SAMPLE.read_text(encoding="utf-8"))
    readings = readings_from_open_meteo(data)
    flagged = 0
    for index, reading in enumerate(readings):
        if (reading.metric == "temperature_c" and reading.value is not None
                and reading.value < LOW_TEMP_C):
            readings[index] = replace(reading, quality_flag="low_temp")
            flagged += 1
    payload = {
        "station": STATION,
        "n_readings": len(readings),
        "readings": reading_payloads(readings),
        "source": {
            "kind": "public",
            "dataset": "Open-Meteo 历史归档（八达岭，逐小时气象）",
            "license": "CC BY 4.0",
            "attribution": "Open-Meteo.com（ERA5 再分析）",
            "sample": PUBLIC_SAMPLE.relative_to(ROOT).as_posix(),
        },
    }
    summary = {
        "kind": "public",
        "n_readings": len(readings),
        "n_low_temp_flagged": flagged,
        "rule": f"temperature_c < {LOW_TEMP_C} → quality_flag=low_temp（演示用示例阈值）",
        "sample": PUBLIC_SAMPLE.relative_to(ROOT).as_posix(),
    }
    return payload, summary


def _manifest_entry(sample_sha: str) -> dict:
    if not MANIFEST.is_file():
        return {}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for source in manifest.get("sources", []):
        if source.get("sha256") == sample_sha:
            return {key: source.get(key) for key in
                    ("id", "title", "url", "license", "attribution", "retrieved",
                     "sha256", "used_for")}
    return {}


# ------------------------------------------------------------------ 核对
def _checks(result, trace: list[dict], device_payload: dict,
            archive_root: Path) -> dict:
    events = trace
    message_events = [e for e in events if e.get("kind") == "message"]
    approvals = [e for e in events if e.get("kind") == "approval"]
    tool_results = [e for e in events if e.get("kind") == "tool_result"]
    stages = {outcome.stage: outcome for outcome in result.outcomes}
    order = (stages.get("operations_dispatch").artifacts.get("work_order")
             if "operations_dispatch" in stages else None) or {}
    action = (stages.get("operations_dispatch").artifacts.get("device_action")
              if "operations_dispatch" in stages else None) or {}
    archive = (stages.get("archive").artifacts.get("archive")
               if "archive" in stages else None) or {}
    archive_file = archive_root / str(archive.get("path") or "")
    return {
        "chain_complete": len(result.outcomes) == 5 and len(result.messages) == 7,
        "device_input_is_public": device_payload.get("source", {}).get("kind") == "public",
        "messages_in_trace": (
            len(message_events) == len(result.messages)
            and [e.get("msg_id") for e in message_events]
            == [m.msg_id for m in result.messages]),
        "evidence_resolved": all(
            call_id in {e.get("call_id") for e in tool_results if e.get("ok")}
            for outcome in result.outcomes
            for call_id in outcome.evidence_call_ids),
        "approval_recorded": (
            len(approvals) == 1
            and approvals[0].get("verdict") == "approved"
            and approvals[0].get("by") == "approve_all"
            and approvals[0].get("action") == "execute_device_action"
            and approvals[0].get("risk") == "high"),
        "work_order_created": bool(order.get("order_id")),
        "action_executed": action.get("status") == "accepted"
        and action.get("execution_mode") == "simulated",
        "archive_isolated": (
            "synthetic/" in str(archive.get("path") or "")
            and "SYNTHETIC_" in str(archive.get("path") or "")
            and archive_file.is_file()),
    }


# ------------------------------------------------------------------ 运行
def run(out_path: Path) -> dict:
    sample_sha = hashlib.sha256(PUBLIC_SAMPLE.read_bytes()).hexdigest()
    device_payload, device_summary = public_device_payload()
    scene = _scenario(_sample())

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        kb = KnowledgeBase(td / "kb.sqlite3")
        kb.index(load_documents(KB_DOCS))
        archive_root = td / "archive"
        base = ToolRegistry()
        for tool in (knowledge_search_tool(kb), station_health_tool(),
                     robust_stats_tool(), continuity_verdict_tool(),
                     magnitude_verdict_tool(), slip_detect_tool(),
                     CreateWorkOrderTool(WorkOrderService()),
                     ExecuteDeviceActionTool(), ArchiveExportTool(archive_root)):
            base.register(tool)

        specs = (
            ("qc", "qc.json", "qc.verdict", ("data.observations",), _qc_plan, _qc_compose),
            ("device_monitor", "device_monitor.json", "device.health",
             ("data.device",), _device_plan, _device_compose),
            ("fault_diagnosis", "fault_diagnosis.json", "fault.diagnosis",
             ("qc.verdict", "device.health"), _diagnosis_plan, _diagnosis_compose),
            ("operations_dispatch", "operations_dispatch.json", "dispatch.work_order",
             ("fault.diagnosis",), _dispatch_plan, _dispatch_compose),
            ("archive", "archive.json", "archive.done", ("dispatch.work_order",),
             _archive_plan, _archive_compose),
        )
        stages = []
        for name, config, topic, consumes, plan, compose in specs:
            cfg = load_agent_config(str(CONFIG_DIR / config))
            provider = FactProvider(plan, compose)
            agent, scoped = build(cfg, provider, base)
            stages.append(PipelineStage(
                name=name, agent=agent, registry=scoped, topic=topic,
                consumes=consumes, note=f"{name} 阶段：按上游消息调用工具并据返回下结论",
                approval=(ApprovalGate(approver=ApproveAll())
                          if name == "operations_dispatch" else None),
                contract=ConclusionContract()))

        trace_path = td / "trace.jsonl"
        bus = MessageBus(TraceWriter(trace_path))
        pipeline = Pipeline(bus, trace_path, stages)
        result = pipeline.run(intake=[
            ("data.observations", scene["observations"]),
            ("data.device", device_payload),
        ])
        trace = read_trace(trace_path)
        checks = _checks(result, trace, device_payload, archive_root)

    passed = sum(1 for value in checks.values() if value)
    log = {
        "kind": LOG_KIND,
        "version": LOG_VERSION,
        "data_sources": {
            "device": {
                **_manifest_entry(sample_sha),
                **device_summary,
            },
            "observations": {
                "kind": "synthetic",
                "reason": ("公开的 GNSS 观测文件自 1999 年起都是 CRINEX（gfzrnx 私有紧缩），"
                           "本仓库按既有决定不解码 —— 见 docs/operations/public-data.md 与 issue #99"),
                "note": "质控结论来自**真实判据在合成数据上的计算**，不是写死的文案",
            },
        },
        "demo_rules": {
            "low_temp_c": LOW_TEMP_C,
            "note": "演示用示例阈值，不是工程判据",
        },
        "chain": {
            "stages": [outcome.to_dict() for outcome in result.outcomes],
            "messages": [message.to_dict() for message in result.messages],
        },
        "approval": [event for event in trace if event.get("kind") == "approval"],
        "archive": (result.outcomes[-1].artifacts.get("archive")
                    if result.outcomes else {}),
        "checks": checks,
        "summary": {
            "checks": f"{passed}/{len(checks)}",
            "stages": len(result.outcomes),
            "messages": len(result.messages),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(log, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    return log


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="公开数据全流程演示（五阶段链 + 结题标准核对）")
    parser.add_argument("--out",
                        default=str(ROOT / "logs" / "public_data_full_run_202401d01.json"))
    args = parser.parse_args(argv)
    try:
        log = run(Path(args.out))
    except Exception as exc:  # noqa: BLE001 —— 演示脚本：失败要看得见
        print(f"[阻断] {type(exc).__name__}: {exc}")
        return 2
    failed = [name for name, ok in log["checks"].items() if not ok]
    print(f"[OK] {args.out}：{log['summary']['stages']} 阶段 / "
          f"{log['summary']['messages']} 消息 / checks {log['summary']['checks']}"
          + (f"（失败：{', '.join(failed)}）" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
