"""五阶段领域编排的状态图版本（E3）：形状与 ``agents.pipeline.Pipeline`` 一致。

## 图

::

    intake ──▶ qc ──▶ device_monitor ──┐
           └───────────────────────────┴─▶ fault_diagnosis ──▶
                                              operations_dispatch ──▶ archive

``qc → device_monitor`` 是**顺序边**而非数据依赖：阶段共用同一条 ``MessageBus``
与 trace 文件（都不是线程安全的），消息编号又由发布顺序决定，所以两条分支必须
按 ``pipeline.py`` 的串行顺序产生副作用。``fault_diagnosis`` 仍然等两条上游都
完成（汇合语义由状态图引擎保证）。

节点**不重新实现**任何阶段逻辑：每个阶段仍由一个 ``PipelineStage`` 描述，
执行时交给 ``Pipeline`` 本体（每个阶段一条单阶段 Pipeline，共享同一条
``MessageBus`` 与同一个 trace 文件）。也就是说 ``_input_text`` / 结论契约 /
审批门 / 产物提取 / 消息留痕全部走既有代码，图只负责「谁在什么时候跑」。

## 等价的运行方式

* ``engine="builtin"`` —— 自带状态图引擎，就绪节点按阶段顺序串行执行；
* ``engine="langgraph"`` —— 用 ``adapter_langgraph`` 把同一份 ``GraphSpec``
  编成 LangGraph 图；没装 langgraph 时抛 ``EngineUnavailable``；
* ``engine="auto"``（``run_five_stage`` 的默认值）—— 有 langgraph 就用，
  没有就回退到 builtin。``parity`` 默认显式用 ``builtin``：两条路径都已经
  由 ``qc → device_monitor`` 的顺序边钉住消息顺序，默认值只是少一层不确定性。

## 结果

``FiveStageResult`` 同时提供两种读法：

* ``.pipeline_result`` —— 真正的 ``agents.pipeline.PipelineResult``；
* ``.stages`` / ``.messages`` / ``.trace_path`` / ``.artifacts`` / ``.checks``
  —— 与回放日志同名同形的字段（``stages`` 即 ``outcomes``）。

本模块只用标准库（langgraph 仅由可选适配层在运行时探测）。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence

from ..agents import runtime
from ..agents.blackboard import Blackboard
from ..agents.bus import Message, MessageBus
from ..agents.pipeline import (
    Pipeline,
    PipelineResult,
    PipelineStage,
    StageOutcome,
)
from ..agents.trace.reader import read_trace
from ..agents.trace.writer import TraceWriter
from . import adapter_langgraph
from .state_graph import StateGraph

#: 阶段执行顺序（= pipeline.py 文档里的链路顺序）。
STAGE_ORDER = ("qc", "device_monitor", "fault_diagnosis",
               "operations_dispatch", "archive")

#: 各阶段的发布主题与消费主题（与 ``config/agents/*.json`` 一一对应）。
STAGE_TOPICS = {
    "qc": "qc.verdict",
    "device_monitor": "device.health",
    "fault_diagnosis": "fault.diagnosis",
    "operations_dispatch": "dispatch.work_order",
    "archive": "archive.done",
}
STAGE_CONSUMES = {
    "qc": ("data.observations",),
    "device_monitor": ("data.device",),
    "fault_diagnosis": ("qc.verdict", "device.health"),
    "operations_dispatch": ("fault.diagnosis",),
    "archive": ("dispatch.work_order",),
}
STAGE_NOTES = {
    "qc": "对本批观测做质量控制：检查相位阶跃并给出结论。",
    "device_monitor": "汇总台站设备读数健康度（含缺测）并给出结论。",
    "fault_diagnosis": "结合质控结论与设备健康度做故障研判，引用规程。",
    "operations_dispatch": "按研判结果建单并评估是否需要设备动作"
                           "（高风险动作需人工批准）。",
    "archive": "把本次全链摘要作为合成产物归档。",
}

#: intake 之后的两条分支：两条数据消息分别进入各自的消费阶段。
INTAKE_TARGETS = ("qc", "device_monitor")

#: 状态键前缀：每个阶段只写 ``outcome_<阶段名>`` 这一个键。
#: 并行分支各写各的键 —— LangGraph 的默认通道是同一步单写，回写整份汇总字典
#: 会在并行超步里互相覆盖（甚至直接报 InvalidUpdateError）。
OUTCOME_PREFIX = "outcome_"

#: 闸门结论：``gate_answer_<阶段名>`` -> ``{"approved":…, "by":…, "note":…}``
GATE_KEY_PREFIX = "gate_answer_"
#: 展示层：当前卡在哪个闸门。**故意与原生挂起并存**——前端要显示"卡在哪"，
#: 关掉这一步会让看板失去"为什么停"的可见性。
GATE_STATUS_KEY = "gate_status"


def outcome_key(stage_name: str) -> str:
    return OUTCOME_PREFIX + stage_name


@dataclass(frozen=True)
class FiveStageResult:
    """一次图执行的结果；``pipeline_result`` 与 ``Pipeline.run`` 完全同形。"""

    pipeline_result: PipelineResult
    checks: dict

    @property
    def stages(self) -> tuple[StageOutcome, ...]:
        return self.pipeline_result.outcomes

    @property
    def outcomes(self) -> tuple[StageOutcome, ...]:
        """``stages`` 的别名，对齐 ``PipelineResult.outcomes``。"""
        return self.pipeline_result.outcomes

    @property
    def messages(self) -> tuple[Message, ...]:
        return self.pipeline_result.messages

    @property
    def trace_path(self) -> str:
        return self.pipeline_result.trace_path

    @property
    def artifacts(self) -> dict[str, dict]:
        """阶段名 → 该阶段提取出的产物（按工具名提取，口径同 pipeline.py）。"""
        return {outcome.stage: dict(outcome.artifacts) for outcome in self.stages}

    def to_pipeline_result(self) -> PipelineResult:
        return self.pipeline_result


def _ordered_stages(
    stages: Iterable[PipelineStage],
) -> tuple[tuple[str, PipelineStage], ...]:
    """按规范顺序排列阶段，并拒绝缺项/多项/重名。"""
    by_name: dict[str, PipelineStage] = {}
    for stage in stages:
        if stage.name in by_name:
            raise ValueError(f"阶段重名：{stage.name!r}")
        by_name[stage.name] = stage
    missing = [name for name in STAGE_ORDER if name not in by_name]
    extra = sorted(set(by_name) - set(STAGE_ORDER))
    if missing or extra:
        raise ValueError(
            f"五阶段图需要且只需要 {list(STAGE_ORDER)}；缺 {missing}，多 {extra}")
    return tuple((name, by_name[name]) for name in STAGE_ORDER)


def build_five_stage_graph(
    pipelines: Mapping[str, Pipeline],
    intake: Sequence[tuple[str, dict]],
    *,
    gate_stages: Sequence[str] = (),
    gate_asks: Optional[Mapping[str, Any]] = None,
) -> StateGraph:
    """把已经接好线的单阶段 Pipeline 装成五阶段状态图。

    ``gate_stages`` 里的阶段会在**跑完之后**插一个原生闸门节点：图在那里原地
    挂起，等人给结论。挂起用的是 :mod:`fieldstation.graph.gate` 的
    ``interrupt()``，所以进程可以关掉，重启后 ``Command(resume=...)`` 继续。

    闸门节点**不重跑阶段本体**：阶段的产物已经在状态里了，闸门只读它。
    这一点很重要 —— 实测 ``interrupt()`` 所在节点在恢复时会从函数开头重跑，
    所以闸门节点里 ``interrupt()`` 之前不能有副作用。
    """
    missing = [name for name in STAGE_ORDER if name not in pipelines]
    if missing:
        raise ValueError(f"缺少阶段的 Pipeline：{missing}")

    asks = dict(gate_asks or {})
    unknown_gates = [n for n in gate_stages if n not in STAGE_ORDER]
    if unknown_gates:
        raise ValueError(f"闸门阶段不在五阶段里：{unknown_gates}")

    def intake_node(state: dict) -> dict:
        msg_ids: list[str] = []
        topics: list[str] = []
        for topic, payload in intake:
            message = pipelines[STAGE_ORDER[0]].bus.publish(
                topic, sender="intake", payload=payload)
            msg_ids.append(message.msg_id)
            topics.append(topic)
        return {"intake": {"topics": topics, "msg_ids": msg_ids}}

    def stage_node(name: str):
        def node(state: dict) -> dict:
            # 复用 Pipeline.run 本体：输入拼装、trace、结论契约、产物提取全走原路径。
            outcome = pipelines[name].run().outcomes[0]
            # 只写自己的键：并行分支各写各的，不回写整份汇总字典（LangGraph 的
            # 默认通道同一步只收一次写入，回写汇总键会互相覆盖/直接报错）。
            return {outcome_key(name): outcome.to_dict()}
        node.__name__ = f"stage_{name}"
        return node

    def gate_node(name: str):
        """闸门：原地挂起，等人批。

        **``interrupt()`` 之前不许有副作用**（实测恢复时本节点从头重跑）。
        这里只从 state 里读已经算好的阶段结论，不做任何写操作。
        """
        def node(state: dict) -> dict:
            from .gate import GateAnswer, GateAsk, interrupt_value

            ask = asks.get(name)
            if ask is None:
                record = state.get(outcome_key(name)) or {}
                ask = GateAsk(
                    stage=name,
                    action=str((record.get("conclusion") or {}).get("action") or name),
                    reason=str((record.get("conclusion") or {}).get("reason") or ""),
                )
            answer = GateAnswer.from_any(interrupt_value(ask))
            return {
                GATE_KEY_PREFIX + name: answer.to_dict(),
                # 展示层：前端要显示"卡在哪个闸门"。原生挂起之外仍保留这个字段。
                GATE_STATUS_KEY: {"stage": name, "verdict": (
                    "approved" if answer.approved else "rejected")},
            }
        node.__name__ = f"gate_{name}"
        return node

    graph = StateGraph(dict)
    graph.add_node("intake", intake_node)
    for name in STAGE_ORDER:
        graph.add_node(name, stage_node(name))
    for name in gate_stages:
        graph.add_node(f"gate_{name}", gate_node(name))

    for target in INTAKE_TARGETS:
        graph.add_edge("intake", target)
    # qc → device_monitor 是一条**顺序边**，不是数据依赖：五个阶段共用同一条
    # MessageBus 与 trace 文件（都不是线程安全的），而 msg_id 由发布顺序决定。
    # 真正并行执行两条分支会让「qc 的结论先发」变成调度运气（LangGraph 按节点名
    # 字典序跑，实测 device_monitor 会抢在 qc 前面），消息编号随宿主变化 ——
    # 与 pipeline.py 的串行口径对不上。汇合点 fault_diagnosis 仍然等两者都完成。
    graph.add_edge("qc", "device_monitor")
    graph.add_edge("qc", "fault_diagnosis")
    graph.add_edge("device_monitor", "fault_diagnosis")
    graph.add_edge("fault_diagnosis", "operations_dispatch")
    graph.add_edge("operations_dispatch", "archive")

    # 闸门插在阶段之后：阶段产物先落进状态，闸门再停下来。
    for name in gate_stages:
        graph.add_edge(name, f"gate_{name}")
    return graph


def _outcome_from_record(record: Mapping) -> StageOutcome:
    return StageOutcome(
        stage=record["stage"],
        topic=record["topic"],
        message_id=record["message_id"],
        conclusion=dict(record.get("conclusion") or {}),
        evidence_call_ids=tuple(record.get("evidence_call_ids") or ()),
        tool_calls=tuple(record.get("tool_calls") or ()),
        artifacts=dict(record.get("artifacts") or {}),
    )


def _checks(
    result: PipelineResult,
    intake: Sequence[tuple[str, dict]],
    trace_path: str | Path,
) -> dict:
    """与回放日志同名的四项自检（bool，不隐藏失败）。"""
    expected_topics = [topic for topic, _ in intake] + [
        STAGE_TOPICS[name] for name in STAGE_ORDER]
    expected_senders = ["intake"] * len(intake) + list(STAGE_ORDER)
    messages = result.messages
    trace = read_trace(trace_path)
    stage_inputs = [event for event in trace
                    if event.get("kind") == "stage_input"]
    message_events = [event for event in trace
                      if event.get("kind") == "message"]
    return {
        "chain_complete": (
            [outcome.stage for outcome in result.outcomes] == list(STAGE_ORDER)
            and [message.topic for message in messages] == expected_topics
            and [message.sender for message in messages] == expected_senders
        ),
        "messages_in_trace": (
            len(message_events) == len(messages) == len(expected_topics)
            and [event.get("msg_id") for event in message_events]
            == [message.msg_id for message in messages]
        ),
        "conclusions_valid": all(
            isinstance(outcome.conclusion, dict)
            and isinstance(outcome.conclusion.get("attribution"), dict)
            and bool(outcome.conclusion["attribution"].get("fault_type"))
            for outcome in result.outcomes
        ),
        "stage_inputs_traced": len(stage_inputs) == len(STAGE_ORDER),
    }


def run_five_stage(
    stages: Iterable[PipelineStage],
    *,
    bus: MessageBus,
    trace_path: str | Path,
    intake: Sequence[tuple[str, dict]] = (),
    metrics: TraceWriter | None = None,
    board: Blackboard | None = None,
    max_turns: int = runtime.MAX_TURNS_DEFAULT,
    engine: str = "auto",
    thread_id: str | None = None,
    checkpoint: object | None = None,
    resume: Iterable[str] | None = None,
    gate_stages: Sequence[str] = (),
    gate_asks: Mapping[str, Any] | None = None,
    gate_resume: Any = None,
    gate_checkpointer: object | None = None,
) -> FiveStageResult:
    """跑五阶段图，返回与 ``Pipeline.run`` 同形的结果。

    每个阶段用一条**单阶段** ``Pipeline``（共享 bus / trace / metrics / board）：
    阶段名互不相同，所以订阅不会重复；输入拼装只读总线，先跑的阶段发布的
    消息自然成为后跑阶段的输入，与串联执行完全一致。

    ## 闸门（原生挂起）

    传 ``gate_stages`` 就在这些阶段**之后**插一个闸门。闸门用
    ``langgraph.types.interrupt()`` 原地挂起，需要三样东西同时到齐：

    * ``engine="langgraph"``（自带 runner 没有挂起能力）
    * ``gate_checkpointer``（持久化检查点，否则重启就丢）
    * ``thread_id``（同一线程才能续跑）

    第一次调用会停在闸门；拿到结论后用 :func:`resume_five_stage` 配上
    同一个 ``thread_id`` 和 ``gate_resume`` 继续。

    三个条件缺任何一个都会显式报错，**不静默降级** ——
    "以为有闸门、其实没停"是这个功能最危险的失败方式。
    """
    if engine not in ("auto", "builtin", "langgraph"):
        raise ValueError(
            f"未知引擎 {engine!r}（可选 auto / builtin / langgraph）")
    ordered = _ordered_stages(stages)
    trace_path = Path(trace_path)

    wants_gate = bool(gate_stages) or gate_resume is not None
    if wants_gate:
        if engine == "builtin":
            raise ValueError(
                "闸门需要 engine='langgraph'：自带 runner 没有 interrupt()，"
                "用它会得到一个「看起来停了、其实没停」的结果")
        if gate_checkpointer is None:
            raise ValueError(
                "闸门需要 gate_checkpointer：不落检查点的话重启就丢，等于没做")
        if not thread_id:
            raise ValueError("闸门需要 thread_id：续跑必须回到同一条线程")

    pipelines = {
        name: Pipeline(bus, trace_path, [stage], metrics=metrics,
                       max_turns=max_turns, board=board)
        for name, stage in ordered
    }
    graph = build_five_stage_graph(
        pipelines, intake, gate_stages=gate_stages, gate_asks=gate_asks)
    initial = {"intake": None}

    use_langgraph = engine == "langgraph" or (
        engine == "auto" and adapter_langgraph.available())
    if use_langgraph:
        if checkpoint is not None or resume is not None:
            raise ValueError(
                "checkpoint/resume 目前只由自带 runner 支持"
                "（engine='builtin'）；langgraph 适配层不读写本包的检查点")
        runner = adapter_langgraph.compile_graph(graph.compile().spec)
        if wants_gate:
            state = runner.invoke_resumable(
                initial,
                config=_gate_config(thread_id),
                checkpointer=gate_checkpointer,
                resume_value=gate_resume,
            )
        else:
            state = runner.invoke(initial)
    else:
        state = graph.compile().invoke(
            initial, thread_id=thread_id, checkpoint=checkpoint, resume=resume)

    records = {
        name: state.get(outcome_key(name)) for name in STAGE_ORDER
    }
    missing = [name for name, record in records.items() if record is None]
    if missing:
        if _paused_at(state):
            # 挂在闸门上是**正常状态**，不是缺产物。用专门的返回让调用方能区分
            # "跑完了" 与 "停下来等人"，不用去猜异常字符串。
            return FiveStageResult(
                PipelineResult((), bus.messages, str(trace_path)),
                {"paused": True, "gate": _gate_status(state),
                 "completed_stages": [n for n, r in records.items() if r is not None]},
            )
        raise RuntimeError(f"图执行结束但缺少阶段产物：{missing}")
    outcomes = tuple(_outcome_from_record(records[name]) for name in STAGE_ORDER)
    result = PipelineResult(outcomes, bus.messages, str(trace_path))
    checks = _checks(result, intake, trace_path)
    if gate_stages:
        checks["gate"] = _gate_status(state)
    return FiveStageResult(result, checks)


def _gate_config(thread_id: str) -> dict:
    from .gate import thread_config

    return thread_config(thread_id)


def _paused_at(state: Mapping) -> bool:
    """图是不是停在闸门上（``__interrupt__`` 存在即表示挂起）。"""
    return bool(state.get("__interrupt__"))


def _gate_status(state: Mapping) -> Optional[dict]:
    """展示层：卡在哪个闸门、等人批什么。"""
    raw = state.get("__interrupt__")
    if not raw:
        return state.get(GATE_STATUS_KEY)
    first = raw[0] if isinstance(raw, (list, tuple)) and raw else raw
    value = getattr(first, "value", None)
    if value is None and isinstance(first, Mapping):
        value = first.get("value")
    return {"paused": True, "ask": value}


def resume_five_stage(
    *,
    thread_id: str,
    decision: Any,
    stages: Iterable[PipelineStage],
    bus: MessageBus,
    trace_path: str | Path,
    gate_checkpointer: object,
    intake: Sequence[tuple[str, dict]] = (),
    metrics: TraceWriter | None = None,
    board: Blackboard | None = None,
    max_turns: int = runtime.MAX_TURNS_DEFAULT,
    gate_stages: Sequence[str] = (),
) -> FiveStageResult:
    """有人批了：带着结论从闸门那行继续。

    **必须用同一个 ``thread_id`` 和同一个 checkpointer 文件**，否则接不上 ——
    LangGraph 靠 ``thread_id`` 找快照，换一个就是另一条线程。
    """
    return run_five_stage(
        stages, bus=bus, trace_path=trace_path, intake=intake, metrics=metrics,
        board=board, max_turns=max_turns, engine="langgraph",
        thread_id=thread_id, gate_stages=gate_stages,
        gate_resume=decision, gate_checkpointer=gate_checkpointer,
    )
