"""端到端链路编排：观测数据进，工单与归档出（M5-1，issue #60）。

链路形状（阶段名 = agent 名，主题 = 阶段产物的去向）::

    intake ──data.observations──▶ qc ──qc.verdict──────────────────────┐
           ──data.device───────▶ device_monitor ──device.health──▶     │
                                    fault_diagnosis ──fault.diagnosis──┤
                                       operations_dispatch ──dispatch.work_order──▶ archive
                                            ──archive.done──▶ (落盘产物)

## 规格与约束

* **阶段之间只有消息**：阶段间的**数据**默认只经总线 —— 一个阶段的输入文本由它
  ``consumes`` 的主题上已发布的消息拼出（``Pipeline._input_text``）；要传什么，
  先发布。除此之外，输入文本开头还有一行 ``PipelineStage.note``（本阶段声明的
  任务说明，编译期常量，随输入一起进 ``input_digest``）。注意 ``note`` 不出现在
  trace 里：只看日志的复核者无法从日志还原它 —— M5-4 若要求输入全量可见，
  需要为它另加一条事件。
* **黑板是第二条、且是声明式的通道**（M5-2）：阶段要读写共享上下文（台站/告警/
  工单），就在 ``board_reads`` / ``board_writes`` 里声明范围；``Pipeline`` 按声明
  造视图、把 ``board_read`` / ``board_write`` 注入该阶段**自己的**注册表（克隆，
  不污染别的阶段）。没声明就没有这两个工具，也没有别的路径能碰到黑板。
  黑板调用照常落 ``tool_call`` / ``tool_result``，不需要新的 trace 事件类型。
* **消息全量落 trace**：总线的 ``message`` 事件与各阶段 runtime 事件写入同一条
  trace 文件，读一遍文件就能看到全序（M5-4 的核对建立在这条上）。
* **每阶段一个 ``TraceWriter`` 视图**：runtime 的结论校验只看
  ``list(trace.events)``；各阶段用独立视图，前一阶段的 ``t0001`` 类 call_id
  就不能给后一阶段的证据背书（``tests/test_m5_pipeline.py`` 钉死）。落入的是
  同一个文件，顺序仍是程序顺序。
* **结论契约强制**：每个阶段用 ``ConclusionContract`` 校验，失败沿
  ``ConclusionRejected`` 抛出 —— 链路绝不把无效结论当阶段产物发布。
* **进程内、同步、无中间件**（spec §8 的 YAGNI）：阶段串行执行，顺序即列表顺序。

## 设计决定（非事实断言）

* ``refs`` 取该阶段消费的**全部**上游 msg_id（按发布顺序去重）——
  「消息 → 工具调用（call_id）→ 结论」的证据链里，消息这一半由它补齐。
* 产物提取按**工具名**：``station_health`` / ``create_work_order`` /
  ``execute_device_action`` / ``archive_export`` 的成功结果进入阶段
  ``artifacts``。按名字而不是让阶段自报 —— 名字对不上的缺项看得见，自报错了
  没人能发现。同一工具在阶段内被调多次时以最后一次为准。
* **归档 payload 不由链路自动塞运行期内容**：archive agent 的 scripted args
  是静态骨架，全链证据在日志与 trace 里。真模型下也没有「自动填充」这个口子，
  回放与真实路径的接口保持一致。

本模块只用标准库。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path

from ..constants import DEFAULT_PAIR, meas_cycle_sign
from ..model import Observation, pair_observations
from ..store import product
from ..store.model import StationReading, to_dict as reading_to_dict
from . import runtime
from .approval import ApprovalGate
from .blackboard import Blackboard, BoardView, check_patterns
from .bus import Message, MessageBus
from .conclusion import ConclusionContract, ConclusionRejected
from .runtime import Agent
from .tools import ToolRegistry
from .tools.board_tools import BOARD_TOOL_NAMES, board_tools
from .trace.writer import TraceWriter

#: 这些工具的成功结果会进入阶段产物（artifacts），键名去掉工具前缀。
ARTIFACT_KEYS = {
    "station_health": "station_health",
    "create_work_order": "work_order",
    "execute_device_action": "device_action",
    "archive_export": "archive",
}


@dataclass
class PipelineStage:
    """一个可在链路上运行的阶段：agent + 它的过滤注册表 + 发布主题与消费主题。

    ``board_reads`` / ``board_writes`` 是这个阶段对共享黑板的**声明范围**
    （前缀模式，``*`` 全通；见 ``blackboard.py``）。声明为空就没有黑板工具 ——
    声明是唯一的能力来源，不依赖配置里的工具白名单。
    """

    name: str
    agent: Agent
    registry: ToolRegistry
    topic: str
    consumes: tuple[str, ...] = ()
    note: str = ""
    approval: ApprovalGate | None = None
    contract: ConclusionContract = field(default_factory=ConclusionContract)
    board_reads: tuple[str, ...] = ()
    board_writes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not (self.name or "").strip():
            raise ValueError("阶段名不能为空")
        if not (self.topic or "").strip():
            raise ValueError(f"阶段 {self.name!r} 的发布主题不能为空")
        self.consumes = tuple(self.consumes)
        if len(set(self.consumes)) != len(self.consumes):
            raise ValueError(f"阶段 {self.name!r} 的消费主题有重复：{self.consumes}")
        self.board_reads = check_patterns(self.board_reads)
        self.board_writes = check_patterns(self.board_writes)

    @property
    def uses_board(self) -> bool:
        return bool(self.board_reads or self.board_writes)


@dataclass(frozen=True)
class StageOutcome:
    """一个阶段的对外产物：结论、证据、工具调用摘要、提取出的产物。"""

    stage: str
    topic: str
    message_id: str
    conclusion: dict
    evidence_call_ids: tuple[str, ...]
    tool_calls: tuple[dict, ...]
    artifacts: dict

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "topic": self.topic,
            "message_id": self.message_id,
            "conclusion": self.conclusion,
            "evidence_call_ids": list(self.evidence_call_ids),
            "tool_calls": list(self.tool_calls),
            "artifacts": self.artifacts,
        }


@dataclass(frozen=True)
class PipelineResult:
    """一次全链运行的记录。trace 文件里另有同序的全部事件。"""

    outcomes: tuple[StageOutcome, ...]
    messages: tuple[Message, ...]
    trace_path: str


def _artifacts(events: list[dict]) -> dict:
    """从阶段本地的 tool_result 事件里按工具名提取产物（最后一次为准）。"""
    out: dict[str, dict] = {}
    for event in events:
        if event.get("kind") != "tool_result" or not event.get("ok"):
            continue
        key = ARTIFACT_KEYS.get(event.get("tool"))
        if key is None:
            continue
        data = event.get("result")
        if isinstance(data, dict):
            out[key] = data
    return out


class Pipeline:
    """把若干 ``PipelineStage`` 按序串成一条链；消息走总线，留痕走 trace。

    传 ``board`` 时，按每个阶段的 ``board_reads`` / ``board_writes`` 声明造受控
    视图，并把黑板工具注入该阶段**克隆出来的**注册表与工具描述列表。不传
    ``board`` 时行为与 M5-1 完全一致（阶段若声明了范围会直接报错 —— 声明必须有板）。
    """

    def __init__(
        self,
        bus: MessageBus,
        trace_path: str | Path,
        stages: list[PipelineStage] | tuple[PipelineStage, ...],
        *,
        metrics: TraceWriter | None = None,
        max_turns: int = runtime.MAX_TURNS_DEFAULT,
        board: Blackboard | None = None,
    ) -> None:
        names = [s.name for s in stages]
        topics = [s.topic for s in stages]
        if len(set(names)) != len(names):
            raise ValueError(f"阶段名重复：{names}")
        if len(set(topics)) != len(topics):
            raise ValueError(f"阶段发布主题重复：{topics}")
        declared = [s.name for s in stages if s.uses_board]
        if declared and board is None:
            raise ValueError(
                f"阶段声明了黑板范围但没有传 board：{declared}")
        self.bus = bus
        self.trace_path = Path(trace_path)
        self.stages = tuple(stages)
        self.metrics = metrics
        self.max_turns = max_turns
        self.board = board
        #: 阶段名 → 该阶段的受控视图（声明为空的阶段没有视图）。
        self.views: dict[str, BoardView] = {}
        #: 阶段名 → (实际使用的 agent, 实际使用的注册表) —— 黑板工具已注入。
        self._wired: dict[str, tuple[Agent, ToolRegistry]] = {}
        for stage in self.stages:
            for topic in stage.consumes:
                self.bus.subscribe(stage.name, topic)
            # 黑板工具只能由本类按声明注入：阶段注册表里预置任何一个都算装配错误。
            # 只“追加声明的方向”不够 —— 预置的 board_read 会在只声明写的阶段里
            # 原样留下，等于绕过声明（终审实测）。
            preexisting = [name for name in BOARD_TOOL_NAMES
                           if stage.registry.get(name) is not None]
            if preexisting:
                raise ValueError(
                    f"阶段 {stage.name!r} 的注册表里预置了黑板工具 {preexisting}："
                    "黑板工具只能由 Pipeline 按 board_reads/board_writes 声明注入")
            if not stage.uses_board:
                self._wired[stage.name] = (stage.agent, stage.registry)
                continue
            view = board.scope(stage.board_reads, stage.board_writes,
                               actor=stage.name)
            self.views[stage.name] = view
            registry = stage.registry.clone()
            read_tool, write_tool = board_tools(view)
            if stage.board_reads:
                registry.register(read_tool)
            if stage.board_writes:
                registry.register(write_tool)
            self._wired[stage.name] = (
                replace(stage.agent, tools=registry.describe()), registry)

    def wired(self, stage_name: str) -> tuple[Agent, ToolRegistry]:
        """该阶段实际使用的 (agent, 注册表)（黑板工具注入后）。测试用。"""
        return self._wired[stage_name]

    # ------------------------------------------------------------- 输入拼装
    def _input_text(self, stage: PipelineStage) -> str:
        lines: list[str] = []
        if stage.note:
            lines.append(f"【任务】{stage.note}")
        lines.append("【上游消息】")
        got = 0
        for message in self.bus.messages:
            if message.topic not in stage.consumes:
                continue
            lines.append(
                f"[{message.msg_id}] topic={message.topic} sender={message.sender} "
                f"refs={list(message.refs)} payload={product.canonical_json(message.payload)}")
            got += 1
        if not got:
            lines.append("(无上游消息)")
        return "\n".join(lines)

    def _refs(self, stage: PipelineStage) -> tuple[str, ...]:
        if not stage.consumes:
            return ()
        refs: list[str] = []
        for message in self.bus.inbox(stage.name):
            if message.msg_id not in refs:
                refs.append(message.msg_id)
        return tuple(refs)

    # ----------------------------------------------------------------- 运行
    def run(self, intake: list[tuple[str, dict]] | tuple[tuple[str, dict], ...] = ()) -> PipelineResult:
        """先发布数据接入消息，再按序跑各阶段；返回全链记录。

        任一阶段违反结论契约都会抛 ``ConclusionRejected`` —— 半条链路不算通过。
        """
        for topic, payload in intake:
            self.bus.publish(topic, sender="intake", payload=payload)

        outcomes: list[StageOutcome] = []
        for stage in self.stages:
            text = self._input_text(stage)
            # 阶段本地视图：runtime 的结论校验只看这一个阶段的事件。
            stage_trace = TraceWriter(self.trace_path)
            agent, registry = self._wired[stage.name]
            content = runtime.run(
                agent,
                text,
                stage_trace,
                registry=registry,
                approval=stage.approval,
                max_turns=self.max_turns,
                contract=stage.contract,
                capture_tool_results=True,
                metrics=self.metrics,
            )
            events = list(stage_trace.events)
            validation = stage.contract.validate(content, events)
            if not validation.valid:
                raise ConclusionRejected(validation.errors, validation.conclusion)
            tool_calls = tuple(
                {"call_id": event["call_id"], "tool": event["tool"],
                 "ok": bool(event["ok"])}
                for event in events
                if event.get("kind") == "tool_result" and "call_id" in event)
            artifacts = _artifacts(events)
            message = self.bus.publish(
                stage.topic,
                sender=stage.name,
                payload={
                    "stage": stage.name,
                    "conclusion": validation.conclusion,
                    "evidence_call_ids": list(validation.evidence_call_ids),
                    "tool_calls": list(tool_calls),
                    "artifacts": artifacts,
                },
                refs=self._refs(stage),
            )
            outcomes.append(StageOutcome(
                stage=stage.name,
                topic=stage.topic,
                message_id=message.msg_id,
                conclusion=validation.conclusion,
                evidence_call_ids=validation.evidence_call_ids,
                tool_calls=tool_calls,
                artifacts=artifacts,
            ))
        return PipelineResult(tuple(outcomes), self.bus.messages, str(self.trace_path))


# --------------------------------------------------------------- 数据接入桥
def observation_payload(
    observations: list[Observation],
    *,
    system: str = "GPS",
    adr_sign: str = "adr",
    max_groups: int = 4,
) -> dict:
    """把观测批次整理成一条可发布的消息 payload。

    每个卫星组的 ``tool_args`` 就是 ``slip_detect`` 的完整入参（序列行沿用
    ``tests/test_agent_config.py::_slip_args`` 的口径）—— 模型照抄即可调用，
    不存在「把数据改写成工具要的形状」这一步自由发挥。

    * 只接受**单站**批次：混站会让「这批数据属于哪站」在消息里消失；
    * 大序列按 ``max_groups`` 截断（组数与总量都记在 payload 里，截断可见）；
    * 空批次直接报错：发布一条空的观测消息，下游会以为「数据没问题」。
    """
    if not observations:
        raise ValueError("空观测批次：没有可发布的观测消息")
    stations = {ob.station for ob in observations}
    if len(stations) != 1:
        raise ValueError(f"observation_payload 只接受单站批次，收到 {sorted(stations)}")

    pairs = pair_observations(observations)
    signal_1, signal_2 = DEFAULT_PAIR[system]
    sign = meas_cycle_sign(adr_sign)
    groups: list[dict] = []
    for station_id, sys_name, sv in sorted(pairs):
        if sys_name != system:
            continue
        series = pairs[(station_id, sys_name, sv)]
        rows = []
        for epoch in series:
            row: dict = {
                "gps_week": epoch.gps_week,
                "gps_tow_s": epoch.gps_tow_s,
                "quality_flag": epoch.quality_flag,
            }
            for signal in (signal_1, signal_2):
                ob = epoch.get(signal)
                row[signal] = None if ob is None else {
                    "psr_m": ob.psr_m, "adr_cycles": ob.adr_cycles}
            rows.append(row)
        groups.append({
            "key": f"{sys_name} {sv:02d}",
            "n_epochs": len(series),
            "tool_args": {
                "series": rows,
                "system": sys_name,
                "signal_1": signal_1,
                "signal_2": signal_2,
                "sign": sign,
            },
        })
    return {
        "station": observations[0].station,
        "system": system,
        "n_obs": len(observations),
        "groups_total": len(groups),
        "groups": groups[:max_groups],
    }


def reading_payloads(readings: list[StationReading]) -> list[dict]:
    """台站读数 → ``station_health`` 入参列表（沿用 ``store.model.to_dict`` 口径）。"""
    return [reading_to_dict(reading) for reading in readings]
