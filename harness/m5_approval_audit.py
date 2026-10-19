"""M5-4：审批门端到端联调 + 消息全量落 trace 核对（issue #63）。

跑**两条完整链路**，装配与 M5-1 逐字相同，只换审批者：

* **放行**（``ApproveAll``）：trace 的规范 sha 必须等于 M5-1 已提交日志的
  ``trace_sha256`` —— 证明联调没有另起一条链，也防止本文件与 M5-1 的装配悄悄分叉；
* **拒绝**（``RejectAll``）：高风险动作 ``execute_device_action`` 停在审批门，
  不执行、不发布 ``dispatch.work_order``、archive 不启动；阶段结论因证据缺失被
  ``ConclusionRejected`` 拒绝 —— 不会把没做的事写成做完了。

再对两条 trace 做核对（任一条不成立即退出码 1）：

1. **消息 ↔ trace 双射**：放行路径的 ``PipelineResult.messages`` 每一条在 trace 里
   有且只有一条 ``message`` 事件（``msg_id`` 与 payload 规范 JSON 一致），trace 里
   没有多余的 message 事件；拒绝路径没有 ``dispatch.work_order`` / ``archive.done``。
2. **refs 闭合**：每条消息引用的上游 ``msg_id`` 都存在，且先于它发布。
3. **payload 全量**：``message`` 事件带完整 payload（dict），不是 digest 或摘要。
4. **审批记录**：放行路径恰有一条 ``approval``（verdict=approved、by=approve_all、
   action=execute_device_action、risk=high）；拒绝路径恰有一条（verdict=rejected、
   by=reject_all），该动作 ``tool_call`` 的 ``approved=false``、``tool_result``
   的 ``ok=false`` 且原因为「未获人工批准，未执行」。

输出 ``logs/m5_approval_audit.json``：确定性（无时间戳/耗时，钉 LF），同一份
fixture 两次生成逐字节相同；``tests/test_m5_approval_audit.py`` 钉死。

退出码：``0`` 全部核对通过；``1`` 有核对项失败；``2`` 用法/IO 错误。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT), str(ROOT / "harness")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from m5_pipeline_replay import (  # noqa: E402
    CONFIG_DIR,
    DEFAULT_FIXTURE,
    KB_DOCS,
    N_EPOCHS,
    STAGE_SPECS,
    _sample,
    _scenario,
    _scripted,
    _sha256_canonical,
)

from fieldstation.agents.approval import (  # noqa: E402
    ApprovalGate,
    ApproveAll,
    RejectAll,
)
from fieldstation.agents.bus import MessageBus  # noqa: E402
from fieldstation.agents.conclusion import (  # noqa: E402
    ConclusionContract,
    ConclusionRejected,
)
from fieldstation.agents.config import build, load_agent_config  # noqa: E402
from fieldstation.agents.knowledge import (  # noqa: E402
    KnowledgeBase,
    knowledge_search_tool,
    load_documents,
)
from fieldstation.agents.pipeline import Pipeline, PipelineStage  # noqa: E402
from fieldstation.agents.providers.fake import FakeProvider  # noqa: E402
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
from fieldstation.store import product  # noqa: E402
from fieldstation.store.work_order import WorkOrderService  # noqa: E402

LOG_KIND = "fieldstation.m5_approval_audit.log"
LOG_VERSION = 1
LOG_NAME = "m5_approval_audit.json"
BASELINE_LOG = ROOT / "logs" / "m5_pipeline_replay.json"
HIGH_RISK_ACTION = "execute_device_action"


def _display_path(path: Path) -> str:
    """对外显示用路径：仓库内用相对路径，仓库外用文件名（不泄露本机绝对路径）。"""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.name


# ------------------------------------------------------------------ 装配
def _build(approver, td: Path):
    """装配与 M5-1 相同的五阶段链；只换审批者。返回 (pipeline, scene, obs, trace)。"""
    scene = _scenario(_sample())
    obs = scene["observations"]
    if obs["n_obs"] != N_EPOCHS * 2 * 2:
        raise RuntimeError(
            f"样本形状异常：n_obs {obs['n_obs']} != {N_EPOCHS * 2 * 2}")
    scripted = _scripted(obs)

    kb = KnowledgeBase(td / "kb.sqlite3")
    kb.index(load_documents(KB_DOCS))
    base = ToolRegistry()
    for tool in (knowledge_search_tool(kb), station_health_tool(),
                 robust_stats_tool(), continuity_verdict_tool(),
                 magnitude_verdict_tool(), slip_detect_tool(),
                 CreateWorkOrderTool(WorkOrderService()),
                 ExecuteDeviceActionTool(), ArchiveExportTool(td / "archive")):
        base.register(tool)

    stages: list[PipelineStage] = []
    for name, config, topic, consumes, note in STAGE_SPECS:
        cfg = load_agent_config(str(CONFIG_DIR / config))
        if cfg.name != name:
            raise RuntimeError(
                f"配置 {config} 的 name={cfg.name!r} 与阶段名 {name!r} 不符")
        agent, scoped = build(cfg, FakeProvider(list(scripted[name])), base)
        stages.append(PipelineStage(
            name=name, agent=agent, registry=scoped, topic=topic,
            consumes=consumes, note=note,
            approval=(ApprovalGate(approver=approver)
                      if name == "operations_dispatch" else None),
            contract=ConclusionContract()))

    trace_path = td / "trace.jsonl"
    bus = MessageBus(TraceWriter(trace_path))
    return Pipeline(bus, trace_path, stages), scene, obs, trace_path


# ------------------------------------------------------------------ 核对
def _message_events(trace: list[dict]) -> list[dict]:
    return [event for event in trace if event.get("kind") == "message"]


def _events(trace: list[dict], kind: str, **match) -> list[dict]:
    return [event for event in trace if event.get("kind") == kind
            and all(event.get(key) == value for key, value in match.items())]


def _check_messages(trace: list[dict], result_messages=None) -> dict[str, bool]:
    events = _message_events(trace)
    checks = {
        "payload_full": all(isinstance(event.get("payload"), dict)
                            and bool(event.get("payload"))
                            for event in events),
        "refs_closed": True,
    }
    seen: set[str] = set()
    for event in events:
        refs = event.get("refs") or []
        if any(ref not in seen for ref in refs):
            checks["refs_closed"] = False
        seen.add(event.get("msg_id"))
    if result_messages is not None:
        by_id = {event.get("msg_id"): event for event in events}
        checks["bijection"] = (
            len(events) == len(result_messages)
            and all(by_id.get(message.msg_id, {}).get("payload")
                    == message.payload for message in result_messages)
            and len({message.msg_id for message in result_messages}) == len(events))
    return checks


def _check_approval(trace: list[dict], *, verdict: str, by: str) -> bool:
    records = _events(trace, "approval")
    return (len(records) == 1
            and records[0].get("verdict") == verdict
            and records[0].get("by") == by
            and records[0].get("action") == HIGH_RISK_ACTION
            and records[0].get("risk") == "high")


def run_audit(fixture_path: Path = DEFAULT_FIXTURE, *, deny_approver=None) -> dict:
    """跑放行/拒绝两条链并返回审计记录（不写盘）。

    ``deny_approver`` 仅供测试注入（例如传 ``ApproveAll()`` 验证「没停住会被
    审计发现」）；缺省用 ``RejectAll()``。
    """
    fixture = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
    baseline = json.loads(BASELINE_LOG.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as td1, tempfile.TemporaryDirectory() as td2:
        approve_pipeline, scene, obs, approve_trace_path = _build(
            ApproveAll(), Path(td1))
        approve_result = approve_pipeline.run(
            intake=[("data.observations", obs), ("data.device", scene["device"])])
        approve_trace = read_trace(approve_trace_path)

        deny_pipeline, _, _, deny_trace_path = _build(
            deny_approver or RejectAll(), Path(td2))
        rejected: ConclusionRejected | None = None
        deny_result = None
        try:
            deny_result = deny_pipeline.run(
                intake=[("data.observations", obs),
                        ("data.device", scene["device"])])
        except ConclusionRejected as exc:
            rejected = exc
        deny_trace = read_trace(deny_trace_path)

    approve_checks = _check_messages(approve_trace, approve_result.messages)
    deny_checks = _check_messages(deny_trace)
    deny_messages = _message_events(deny_trace)
    deny_topics = {event.get("topic") for event in deny_messages}
    deny_action_results = [
        event for event in _events(deny_trace, "tool_result",
                                   tool=HIGH_RISK_ACTION)]
    deny_action_calls = [
        event for event in _events(deny_trace, "tool_call",
                                   tool=HIGH_RISK_ACTION)]

    checks = {
        "approve_trace_matches_m5_1": (
            _sha256_canonical(approve_trace) == baseline.get("trace_sha256")),
        "approve_messages_bijection": approve_checks.get("bijection", False),
        "approve_payload_full": approve_checks["payload_full"],
        "approve_refs_closed": approve_checks["refs_closed"],
        "approve_chain_complete": (
            len(approve_result.outcomes) == len(STAGE_SPECS)
            and len(approve_result.messages) == len(STAGE_SPECS) + 2),
        "approve_approval_recorded": _check_approval(
            approve_trace, verdict="approved", by="approve_all"),
        "approve_action_executed": any(
            event.get("ok") and (event.get("result") or {}).get("status") == "accepted"
            for event in _events(approve_trace, "tool_result",
                                 tool=HIGH_RISK_ACTION)),
        "deny_stopped": (deny_result is None and rejected is not None),
        "deny_approval_recorded": _check_approval(
            deny_trace, verdict="rejected", by="reject_all"),
        "deny_action_not_executed": (
            len(deny_action_calls) == 1
            and deny_action_calls[0].get("approved") is False
            and len(deny_action_results) == 1
            and deny_action_results[0].get("ok") is False
            and "未获人工批准" in str(deny_action_results[0].get("error"))),
        "deny_no_dispatch_or_archive": not (
            {"dispatch.work_order", "archive.done"} & deny_topics),
        "deny_payload_full": deny_checks["payload_full"],
        "deny_refs_closed": deny_checks["refs_closed"],
    }
    checks_passed = sum(1 for value in checks.values() if value)
    return {
        "kind": LOG_KIND,
        "version": LOG_VERSION,
        "source": {
            "fixture": _display_path(Path(fixture_path)),
            "fixture_sha256": fixture.get("sha256"),
            "baseline_log": _display_path(BASELINE_LOG),
            "baseline_trace_sha256": baseline.get("trace_sha256"),
        },
        "approve": {
            "trace_sha256": _sha256_canonical(approve_trace),
            "messages": [
                {"msg_id": message.msg_id, "topic": message.topic,
                 "sender": message.sender, "refs": list(message.refs)}
                for message in approve_result.messages],
            "approval": _events(approve_trace, "approval"),
            "tool_calls": [
                {"call_id": event.get("call_id"), "tool": event.get("tool"),
                 "approved": event.get("approved")}
                for event in _events(approve_trace, "tool_call")],
            "action_result": next(
                (event.get("result") for event in _events(
                    approve_trace, "tool_result", tool=HIGH_RISK_ACTION)
                 if event.get("ok")), None),
        },
        "deny": {
            "trace_sha256": _sha256_canonical(deny_trace),
            "messages": [
                {"msg_id": event.get("msg_id"), "topic": event.get("topic"),
                 "sender": event.get("sender"), "refs": list(event.get("refs") or [])}
                for event in deny_messages],
            "approval": _events(deny_trace, "approval"),
            "action_error": (deny_action_results[0].get("error")
                             if deny_action_results else None),
            "rejected_errors": list(rejected.errors) if rejected else None,
        },
        "checks": checks,
        "summary": {
            "checks": f"{checks_passed}/{len(checks)}",
            "approve_messages": len(approve_result.messages),
            "deny_messages": len(deny_messages),
        },
    }


# --------------------------------------------------------------------- CLI
def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(obj, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="M5-4：审批门端到端联调 + 消息全量落 trace 核对")
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--out", default=str(ROOT / "logs" / LOG_NAME))
    args = parser.parse_args(argv)

    try:
        log = run_audit(Path(args.fixture))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[阻断] 读不了 fixture/基线日志：{exc}")
        return 2
    log["sha256"] = _sha256_canonical(
        {key: log[key] for key in ("source", "approve", "deny", "checks", "summary")})
    _write_json(Path(args.out), log)

    failed = [name for name, ok in log["checks"].items() if not ok]
    print(f"放行路径：{log['summary']['approve_messages']} 条消息，"
          f"trace sha256 {log['approve']['trace_sha256'][:16]}…")
    print(f"拒绝路径：停在审批门（{log['summary']['deny_messages']} 条消息），"
          f"trace sha256 {log['deny']['trace_sha256'][:16]}…")
    print(f"checks {log['summary']['checks']}："
          f"{'全部通过' if not failed else '失败 ' + ', '.join(failed)}")
    print(f"[OK] 审计记录 {_display_path(Path(args.out))}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
