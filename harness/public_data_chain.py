"""公开数据链路：公开设备读数 + 合成观测，跑完整五阶段链（issue #98）。

与 M5-1 回放（``harness/m5_pipeline_replay.py``）的区别，三条：

* **设备侧输入 = 公开数据**：Open-Meteo 八达岭 24 小时样本（CC BY 4.0，入库样本
  ``data/public/samples/openmeteo_badg_202401_d01.json``），按演示规则
  （气温 < -10 °C 记 ``low_temp``）真实触发设备质量标记；
* **观测侧 = 与 M5-1 相同的合成样本**（公开 GNSS 观测自 1999 年起全是 CRINEX，
  仓库按既有决定不解码 —— 见 ``docs/operations/public-data.md`` 与 issue #99）；
* **模型 = 事实合成器**（``harness/fact_provider.py``）：按上游消息选工具与参数，
  结论按工具返回的真实数字拼 —— 结论里的每个数字都能在 trace 里对上。

输出 ``logs/public_data_chain_202401d01.json``：与 M5-1 回放日志**同形**
（trace / messages / stages / artifacts / checks / summary），看板可直接消费
（``tools/make_station_dashboard.py``）。记录确定性：无时间戳、无耗时，两次运行
逐字节相同。

用法：
    python harness/public_data_chain.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT / "harness")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fact_provider import FactProvider, STAGE_PLANS  # noqa: E402
from m5_pipeline_replay import (  # noqa: E402
    CONFIG_DIR,
    KB_DOCS,
    STATION,
    _sample,
    _scenario,
    _sha256_canonical,
)
from public_data_replay import (  # noqa: E402
    apply_low_temp_rule,
    readings_from_open_meteo,
)

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

LOG_KIND = "fieldstation.public_data_chain.log"
LOG_VERSION = 1
DEVICE_SAMPLE = (ROOT / "data" / "public" / "samples" /
                 "openmeteo_badg_202401_d01.json")
ARCHIVE_PATH = "pipeline/m5_public/chain_summary.json"
LOW_TEMP_C = -10.0


def device_payload() -> tuple[dict, dict]:
    """公开气象样本 → 设备读数 → intake payload；返回 (payload, 数据源说明)。"""
    data = json.loads(DEVICE_SAMPLE.read_text(encoding="utf-8"))
    readings = apply_low_temp_rule(readings_from_open_meteo(data),
                                   threshold_c=LOW_TEMP_C)
    payload = {
        "station": STATION,
        "n_readings": len(readings),
        "readings": reading_payloads(readings),
        "source": {
            "kind": "public",
            "dataset": "Open-Meteo 八达岭 2024-01-01 逐小时气象",
            "license": "CC BY 4.0",
            "attribution": "Open-Meteo.com（ERA5 再分析）",
            "sample": DEVICE_SAMPLE.relative_to(ROOT).as_posix(),
            "sha256": hashlib.sha256(DEVICE_SAMPLE.read_bytes()).hexdigest(),
        },
    }
    summary = {
        "kind": "public",
        "dataset": "Open-Meteo 八达岭 2024-01-01 逐小时气象",
        "license": "CC BY 4.0",
        "attribution": "Open-Meteo.com（ERA5 再分析）",
        "n_readings": len(readings),
        "n_low_temp_flagged": sum(1 for r in readings if r.quality_flag == "low_temp"),
        "rule": f"temperature_c < {LOW_TEMP_C} → quality_flag=low_temp（演示用示例阈值）",
        "sample": DEVICE_SAMPLE.relative_to(ROOT).as_posix(),
    }
    return payload, summary


def _checks(result, trace: list[dict], payload: dict, archive_root: Path) -> dict:
    message_events = [e for e in trace if e.get("kind") == "message"]
    approvals = [e for e in trace if e.get("kind") == "approval"]
    tool_results = [e for e in trace if e.get("kind") == "tool_result"]
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
        "device_input_is_public": payload.get("source", {}).get("kind") == "public",
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
        "action_executed": (action.get("status") == "accepted"
                            and action.get("execution_mode") == "simulated"),
        "archive_isolated": (
            "synthetic/" in str(archive.get("path") or "")
            and "SYNTHETIC_" in str(archive.get("path") or "")
            and archive_file.is_file()),
    }


def run(out_path: Path) -> dict:
    payload, device_summary = device_payload()
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
            ("qc", "qc.json", "qc.verdict", ("data.observations",), None),
            ("device_monitor", "device_monitor.json", "device.health",
             ("data.device",), None),
            ("fault_diagnosis", "fault_diagnosis.json", "fault.diagnosis",
             ("qc.verdict", "device.health"), None),
            ("operations_dispatch", "operations_dispatch.json",
             "dispatch.work_order", ("fault.diagnosis",),
             partial(STAGE_PLANS["operations_dispatch"][0], station=STATION)),
            ("archive", "archive.json", "archive.done",
             ("dispatch.work_order",),
             partial(STAGE_PLANS["archive"][0], relative_path=ARCHIVE_PATH)),
        )
        stages = []
        for name, config, topic, consumes, plan in specs:
            default_plan, compose = STAGE_PLANS[name]
            cfg = load_agent_config(str(CONFIG_DIR / config))
            provider = FactProvider(plan or default_plan, compose)
            agent, scoped = build(cfg, provider, base)
            stages.append(PipelineStage(
                name=name, agent=agent, registry=scoped, topic=topic,
                consumes=consumes,
                note=f"{name} 阶段：按上游消息调用工具并据返回下结论",
                approval=(ApprovalGate(approver=ApproveAll())
                          if name == "operations_dispatch" else None),
                contract=ConclusionContract()))

        trace_path = td / "trace.jsonl"
        bus = MessageBus(TraceWriter(trace_path))
        pipeline = Pipeline(bus, trace_path, stages)
        result = pipeline.run(intake=[
            ("data.observations", scene["observations"]),
            ("data.device", payload),
        ])
        trace = read_trace(trace_path)
        checks = _checks(result, trace, payload, archive_root)

    passed = sum(1 for value in checks.values() if value)
    stage_records = []
    for spec, outcome in zip(specs, result.outcomes):
        record = outcome.to_dict()
        record["config_hash"] = hashlib.sha256(
            (CONFIG_DIR / spec[1]).read_bytes()).hexdigest()[:16]
        stage_records.append(record)

    log = {
        "kind": LOG_KIND,
        "version": LOG_VERSION,
        "scenario": "public-data-chain",
        "data_sources": {
            "device": device_summary,
            "observations": {
                "kind": "synthetic",
                "reason": ("公开 GNSS 观测自 1999 年起全是 CRINEX（gfzrnx 私有紧缩），"
                           "仓库按既有决定不解码 —— 见 issue #99"),
            },
        },
        "stages": stage_records,
        "messages": [message.to_dict() for message in result.messages],
        "checks": checks,
        "summary": {
            "stages": len(stage_records),
            "messages": len(result.messages),
            "checks": f"{passed}/{len(checks)}",
            # 事实合成器不调用模型，token 记 0 并在 note 里写明（别冒充模型成本）
            "tokens": {"prompt": 0, "completion": 0},
            "tokens_note": "事实合成器不调用模型：token 为 0，不是模型成本",
        },
        "trace": trace,
        "trace_sha256": _sha256_canonical(trace),
    }
    log["sha256"] = _sha256_canonical({
        key: log[key] for key in ("scenario", "data_sources", "stages",
                                  "messages", "checks", "summary", "trace_sha256")
    })
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(log, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    return log


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="公开数据链路：公开设备读数 + 合成观测 + 事实合成器")
    parser.add_argument(
        "--out", default=str(ROOT / "logs" / "public_data_chain_202401d01.json"))
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
