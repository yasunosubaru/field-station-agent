"""一致性核对：``pipeline.py`` 串行链路 vs 五阶段状态图。

::

    $env:PYTHONPATH="src"; python -m fieldstation.graph.parity \
        --fixture harness/fixtures/m5_pipeline_replay_20261020.json

两遍都从**同一份 fixture** 重建输入、装配同一套阶段（同一配置、同一工具、
同一脚本化 provider），只有执行器不同：

1. ``Pipeline(bus, trace, stages).run(intake)`` —— 既有串行链路；
2. ``run_five_stage(...)`` —— 状态图（默认自带 runner）。

逐阶段比对 ``stage / topic / message_id / conclusion / evidence_call_ids /
tool_calls / artifacts``；全部相同打印「一致」并退出 0，否则逐字段打印差异
并退出 1。用法/IO/装配错误退出 2。

## fixture 形状

优先读 ``{"intake": [[topic, payload], ...]}``（显式输入）。仓库里已有的
``harness/fixtures/m5_pipeline_replay_20261020.json`` 不含完整 payload，只含
``sample`` 合成参数，本模块按该参数重建同样的观测批次与设备读数 —— 与
``harness/m5_pipeline_replay.py`` 的样本口径一致（固定种子 + GPS 01 L1 持续
阶跃 + 三条设备读数）。这样不必往仓库里再塞一份重复的合成数据。

脚本化响应由输入 payload 直接算出（``slip_detect`` 的 ``tool_args`` 取自
``data.observations.groups``），不手抄常量。两遍使用完全相同的响应序列，
所以任何差异都只能来自编排本身。

本模块只用标准库。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from ..agents.approval import ApprovalGate, ApproveAll
from ..agents.bus import MessageBus
from ..agents.conclusion import ConclusionContract
from ..agents.config import build, load_agent_config
from ..agents.knowledge import KnowledgeBase, knowledge_search_tool, load_documents
from ..agents.pipeline import Pipeline, PipelineStage, observation_payload, reading_payloads
from ..agents.providers.base import ChatResponse
from ..agents.providers.fake import FakeProvider
from ..agents.tools import ToolRegistry
from ..agents.tools.archive_tools import ArchiveExportTool
from ..agents.tools.qc_tools import (
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
    slip_detect_tool,
)
from ..agents.tools.station_tools import station_health_tool
from ..agents.tools.work_order_tools import CreateWorkOrderTool, ExecuteDeviceActionTool
from ..agents.trace.writer import TraceWriter
from ..store.model import StationReading
from ..store.work_order import WorkOrderService
from .. import synthetic
from .five_stage import (
    STAGE_CONSUMES,
    STAGE_NOTES,
    STAGE_ORDER,
    STAGE_TOPICS,
    run_five_stage,
)

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_DIR = ROOT / "config" / "agents"
KB_DOCS = ROOT / "data" / "kb" / "knowledge.jsonl"
DEFAULT_FIXTURE = ROOT / "harness" / "fixtures" / "m5_pipeline_replay_20261020.json"

#: 比对字段：与 ``StageOutcome.to_dict`` 的接口面一致。
COMPARE_FIELDS = ("stage", "topic", "message_id", "conclusion",
                  "evidence_call_ids", "tool_calls", "artifacts")


@dataclass(frozen=True)
class Scenario:
    """一次核对需要的全部输入。"""

    intake: tuple[tuple[str, dict], ...]
    source: str = ""

    @property
    def payloads(self) -> dict[str, dict]:
        return {topic: payload for topic, payload in self.intake}


# --------------------------------------------------------------- fixture 读入
def _canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _device_readings(station: str) -> list[StationReading]:
    """与 harness/m5_pipeline_replay.py::_device_readings 同口径的三条读数。"""
    def at(text: str) -> datetime:
        return datetime.fromisoformat(text)

    return [
        StationReading(station_id=station, sensor="power", metric="voltage",
                       value=12.0, unit="V",
                       observed_at=at("2026-10-19T08:00:00+00:00"),
                       quality_flag=""),
        StationReading(station_id=station, sensor="link", metric="rssi",
                       value=-88.0, unit="dBm",
                       observed_at=at("2026-10-19T08:05:00+00:00"),
                       quality_flag=""),
        StationReading(station_id=station, sensor="uplink", metric="packets_5min",
                       value=None, unit="count",
                       observed_at=at("2026-10-19T08:10:00+00:00"),
                       quality_flag="missing"),
    ]


def _apply_postprocess(observations, postprocess: dict) -> None:
    """按 fixture 的 ``postprocess`` 给目标序列加持续阶跃（就地修改）。"""
    target = str(postprocess.get("target") or "").strip()
    parts = target.split()
    if len(parts) != 3:
        raise ValueError(
            f"postprocess.target 形状应为 '<系统> <PRN> <信号>'，收到 {target!r}")
    system, sv_text, signal = parts
    sv = int(sv_text)
    from_index = int(postprocess["from_index"])
    step_cycles = float(postprocess["step_cycles"])

    series = sorted(
        (ob for ob in observations
         if (ob.system, ob.sv, ob.signal) == (system, sv, signal)),
        key=lambda ob: ob.gps_tow_s)
    if len(series) <= from_index:
        raise ValueError(
            f"postprocess 目标历元不足：{target} 只有 {len(series)} 个，"
            f"需要索引 {from_index}")
    start_tow = series[from_index].gps_tow_s
    for ob in series:
        if ob.gps_tow_s >= start_tow - 1e-9:
            ob.adr_cycles += step_cycles


def scenario_from_sample(meta: dict) -> Scenario:
    """按 fixture 的合成参数重建观测批次与设备读数（固定种子，可复现）。"""
    required = ("seed", "station", "n_epochs", "systems", "sats")
    missing = [key for key in required if key not in meta]
    if missing:
        raise ValueError(f"sample 缺少字段 {missing}，无法重建合成输入")
    cfg = synthetic.default_cfg(
        seed=int(meta["seed"]),
        station=str(meta["station"]),
        n_epochs=int(meta["n_epochs"]),
        systems=[str(name) for name in meta["systems"]],
        sats={str(k): [int(v) for v in values]
              for k, values in dict(meta["sats"]).items()},
        slips=[dict(slip) for slip in meta.get("generator_slips") or []],
    )
    observations, _truth, _merged = synthetic.generate(cfg)
    postprocess = meta.get("postprocess")
    if postprocess:
        _apply_postprocess(observations, dict(postprocess))

    station = str(meta["station"])
    readings = reading_payloads(_device_readings(station))
    return Scenario(intake=(
        ("data.observations", observation_payload(observations)),
        ("data.device", {
            "station": station,
            "n_readings": len(readings),
            "readings": readings,
        }),
    ))


def load_scenario(path: str | Path) -> Scenario:
    """读 fixture：显式 ``intake`` 优先，否则按 ``sample`` 合成参数重建。"""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"读不了 fixture {path}：{exc}") from exc
    except ValueError as exc:
        raise ValueError(f"fixture 不是合法 JSON（{path}）：{exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"fixture 顶层必须是 JSON object（{path}）")

    if "intake" in data:
        raw = data["intake"]
        if not isinstance(raw, list) or not raw:
            raise ValueError("fixture.intake 必须是非空数组")
        intake: list[tuple[str, dict]] = []
        for index, item in enumerate(raw):
            if (not isinstance(item, (list, tuple)) or len(item) != 2
                    or not isinstance(item[0], str)
                    or not isinstance(item[1], dict)):
                raise ValueError(
                    f"fixture.intake[{index}] 必须是 [topic, payload(dict)]")
            intake.append((item[0], dict(item[1])))
        return Scenario(intake=tuple(intake), source=str(path))

    sample = data.get("sample")
    if isinstance(sample, dict):
        return Scenario(intake=scenario_from_sample(sample).intake,
                        source=str(path))
    raise ValueError(
        f"fixture {path} 既没有 intake，也没有可重建的 sample 参数")


# --------------------------------------------------------------- 脚本化响应
def _conclusion(fault_type: str, evidence: list[dict], recommendation: str,
                confidence: float = 0.9) -> str:
    return json.dumps({
        "attribution": {"fault_type": fault_type, "evidence": evidence},
        "recommendation": recommendation,
        "confidence": confidence,
    }, ensure_ascii=False, sort_keys=True)


def scripted_responses(scenario: Scenario) -> dict[str, list[ChatResponse]]:
    """五个阶段各一段脚本；工具入参由输入 payload 算出，不手抄常量。"""
    payloads = scenario.payloads
    observations = payloads.get("data.observations") or {}
    device = payloads.get("data.device") or {}
    groups = list(observations.get("groups") or [])
    if not groups:
        raise ValueError("data.observations 不含 groups，无法脚本化 slip_detect")
    readings = device.get("readings")
    if not isinstance(readings, list) or not readings:
        raise ValueError("data.device 不含 readings，无法脚本化 station_health")

    first = groups[0]
    station = str(device.get("station") or observations.get("station") or "")
    qc_calls = [
        ChatResponse(content="", tool_calls=[
            {"name": "slip_detect", "args": group["tool_args"]}])
        for group in groups
    ]
    qc_evidence = [
        {"call_id": f"t{index + 1:04d}", "tool": "slip_detect",
         "finding": f"{group.get('key')} 的相位连续性检查已完成"}
        for index, group in enumerate(groups)
    ]

    return {
        "qc": qc_calls + [ChatResponse(content=_conclusion(
            "phase_continuity_checked", qc_evidence,
            "按阶跃检测结果标记可疑相位段，转入故障研判"))],
        "device_monitor": [
            ChatResponse(content="", tool_calls=[
                {"name": "station_health", "args": {"readings": readings}}]),
            ChatResponse(content=_conclusion(
                "device_health_checked",
                [{"call_id": "t0001", "tool": "station_health",
                  "finding": "台站读数健康度已汇总（含缺测统计）"}],
                "核对缺测指标的上行链路与遥测缓存")),
        ],
        "fault_diagnosis": [
            ChatResponse(content="", tool_calls=[{
                "name": "knowledge_search",
                "args": {"query": "持续相位阶跃 定平链路 处理", "limit": 3}}]),
            ChatResponse(content=_conclusion(
                "phase_slip_with_uplink_loss",
                [{"call_id": "t0001", "tool": "knowledge_search",
                  "finding": "命中相位阶跃与链路异常相关规程"}],
                "按规程隔离可疑相位段并复查定平链路")),
        ],
        "operations_dispatch": [
            ChatResponse(content="", tool_calls=[{
                "name": "create_work_order",
                "args": {"station_id": station,
                         "title": "相位阶跃与上行遥测缺测处置",
                         "priority": "P0", "risk": "medium",
                         "description": "QC 检出相位阶跃；设备侧上行遥测缺测",
                         "action": "restart_receiver"}}]),
            ChatResponse(content="", tool_calls=[{
                "name": "execute_device_action",
                "args": {"station_id": station, "action": "restart_receiver",
                         "reason": "相位阶跃疑似接收机异常，远程重启后复检",
                         "confidence": 0.9}}]),
            ChatResponse(content=_conclusion(
                "phase_slip_remediation",
                [{"call_id": "t0001", "tool": "create_work_order",
                  "finding": "工单已建"},
                 {"call_id": "t0002", "tool": "execute_device_action",
                  "finding": "设备动作已获审批并受理（simulated）"}],
                "跟踪重启与链路恢复情况")),
        ],
        "archive": [
            ChatResponse(content="", tool_calls=[{
                "name": "archive_export",
                "args": {"relative_path": "pipeline/graph/chain_summary.json",
                         "payload": {
                             "run": "graph-parity",
                             "station": station,
                             "source": first.get("key"),
                         },
                         "synthetic": True}}]),
            ChatResponse(content=_conclusion(
                "archive_exported",
                [{"call_id": "t0001", "tool": "archive_export",
                  "finding": "全链摘要已隔离写入 synthetic/ 目录"}],
                "归档完成；合成产物不得与真实产物混放")),
        ],
    }


# ------------------------------------------------------------------ 造阶段
def build_stage_set(
    workdir: str | Path,
    scenario: Scenario,
    *,
    config_dir: str | Path = DEFAULT_CONFIG_DIR,
) -> list[PipelineStage]:
    """按五份配置装配阶段；每次调用都给一套全新的 provider 与工具状态。"""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    config_dir = Path(config_dir)

    kb = KnowledgeBase(workdir / "kb.sqlite3")
    kb.index(load_documents(KB_DOCS))
    base = ToolRegistry()
    for tool in (knowledge_search_tool(kb), station_health_tool(),
                 robust_stats_tool(), continuity_verdict_tool(),
                 magnitude_verdict_tool(), slip_detect_tool(),
                 CreateWorkOrderTool(WorkOrderService()),
                 ExecuteDeviceActionTool(),
                 ArchiveExportTool(workdir / "archive")):
        base.register(tool)

    scripted = scripted_responses(scenario)
    stages: list[PipelineStage] = []
    for name in STAGE_ORDER:
        config_path = config_dir / f"{name}.json"
        cfg = load_agent_config(str(config_path))
        if cfg.name != name:
            raise ValueError(
                f"配置 {config_path} 的 name={cfg.name!r} 与阶段名 {name!r} 不符")
        agent, scoped = build(cfg, FakeProvider(list(scripted[name])), base)
        stages.append(PipelineStage(
            name=name, agent=agent, registry=scoped,
            topic=STAGE_TOPICS[name], consumes=STAGE_CONSUMES[name],
            note=STAGE_NOTES[name],
            approval=(ApprovalGate(approver=ApproveAll())
                      if name == "operations_dispatch" else None),
            contract=ConclusionContract()))
    return stages


def run_pipeline(
    scenario: Scenario,
    workdir: str | Path,
    *,
    config_dir: str | Path = DEFAULT_CONFIG_DIR,
) -> list[dict]:
    """串行链路一遍，返回阶段记录（``StageOutcome.to_dict``）。"""
    stages = build_stage_set(workdir, scenario, config_dir=config_dir)
    trace_path = Path(workdir) / "trace.jsonl"
    bus = MessageBus(TraceWriter(trace_path))
    result = Pipeline(bus, trace_path, stages).run(intake=list(scenario.intake))
    return [outcome.to_dict() for outcome in result.outcomes]


def run_graph(
    scenario: Scenario,
    workdir: str | Path,
    *,
    config_dir: str | Path = DEFAULT_CONFIG_DIR,
    engine: str = "builtin",
) -> list[dict]:
    """状态图一遍，返回同形阶段记录。"""
    stages = build_stage_set(workdir, scenario, config_dir=config_dir)
    trace_path = Path(workdir) / "trace.jsonl"
    bus = MessageBus(TraceWriter(trace_path))
    result = run_five_stage(
        stages, bus=bus, trace_path=trace_path,
        intake=list(scenario.intake), engine=engine)
    return [outcome.to_dict() for outcome in result.stages]


# ------------------------------------------------------------------ 比对
def _short(value, limit: int = 160) -> str:
    text = _canonical(value)
    return text if len(text) <= limit else text[:limit] + "…"


def compare_stage_records(
    expected: list[dict],
    actual: list[dict],
    *,
    fields: tuple[str, ...] = COMPARE_FIELDS,
) -> list[str]:
    """逐阶段逐字段比对；返回问题清单（空 = 一致）。"""
    problems: list[str] = []
    expected_names = [record.get("stage") for record in expected]
    actual_names = [record.get("stage") for record in actual]
    if expected_names != actual_names:
        problems.append(
            f"阶段序列不一致：pipeline {expected_names} / graph {actual_names}")
        return problems
    by_name = {record.get("stage"): record for record in actual}
    for left in expected:
        name = left.get("stage")
        right = by_name.get(name) or {}
        for field in fields:
            if left.get(field) != right.get(field):
                problems.append(
                    f"{name}.{field} 不一致：\n"
                    f"    pipeline: {_short(left.get(field))}\n"
                    f"    graph   : {_short(right.get(field))}")
    return problems


def compare(
    scenario: Scenario,
    work_root: str | Path,
    *,
    config_dir: str | Path = DEFAULT_CONFIG_DIR,
    engine: str = "builtin",
) -> tuple[list[dict], list[dict], list[str]]:
    """在 ``work_root`` 下的两个子目录里各跑一遍并比对。"""
    work_root = Path(work_root)
    pipeline_records = run_pipeline(
        scenario, work_root / "pipeline", config_dir=config_dir)
    graph_records = run_graph(
        scenario, work_root / "graph", config_dir=config_dir, engine=engine)
    return pipeline_records, graph_records, compare_stage_records(
        pipeline_records, graph_records)


# -------------------------------------------------------------------- CLI
def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m fieldstation.graph.parity",
        description="比对 pipeline.py 与五阶段状态图的阶段结论是否一致")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE,
                        help="输入 fixture（默认 %(default)s）")
    parser.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR,
                        help="agent 配置目录（默认 %(default)s）")
    parser.add_argument("--engine", choices=("builtin", "langgraph", "auto"),
                        default="builtin",
                        help="图的执行器（默认 builtin：与串行链路消息顺序一致）")
    parser.add_argument("--work-dir", type=Path, default=None,
                        help="保留中间产物的目录（默认临时目录，跑完删除）")
    args = parser.parse_args(argv)

    try:
        scenario = load_scenario(args.fixture)
    except ValueError as exc:
        print(f"[parity] {exc}", file=sys.stderr)
        return 2

    print(f"[parity] fixture {args.fixture}（{len(scenario.intake)} 条输入消息）")
    print(f"[parity] engine  {args.engine}")

    if args.work_dir is not None:
        try:
            records, problems = _run_in(Path(args.work_dir), scenario,
                                        args.config_dir, args.engine)
        except (OSError, ValueError, RuntimeError) as exc:
            print(f"[parity] 执行失败：{exc}", file=sys.stderr)
            return 2
    else:
        with tempfile.TemporaryDirectory() as td:
            try:
                records, problems = _run_in(Path(td), scenario,
                                            args.config_dir, args.engine)
            except (OSError, ValueError, RuntimeError) as exc:
                print(f"[parity] 执行失败：{exc}", file=sys.stderr)
                return 2

    for record in records:
        failed = any(problem.startswith(f"{record['stage']}.") for problem in problems)
        print(f"  {record['stage']:<20} {'FAIL' if failed else 'PASS'}  "
              f"结论 {record.get('conclusion', {}).get('attribution', {}).get('fault_type', '?')}")
    if problems:
        for problem in problems:
            print(f"  FAIL {problem}")
        print(f"[parity] 不一致：{len(problems)} 处")
        return 1
    print("[parity] 一致")
    return 0


def _run_in(
    work_root: Path,
    scenario: Scenario,
    config_dir: Path,
    engine: str,
) -> tuple[list[dict], list[str]]:
    pipeline_records, _graph_records, problems = compare(
        scenario, work_root, config_dir=config_dir, engine=engine)
    return pipeline_records, problems


if __name__ == "__main__":
    sys.exit(main())
