"""可选适配层：把同一份 ``GraphSpec`` 编成 LangGraph 图。

LangGraph **不是本项目的依赖**。``available()`` 只做探测；``compile_graph``
在没装时抛 ``EngineUnavailable``，由 ``five_stage`` 退回自带 runner。

## 三处必要的适配（否则并行超步会炸）

1. **根 reducer**：``StateGraph(dict)`` 在 LangGraph 1.x 里是单个
   ``__root__`` 通道（``LastValue``），同一步里两个节点各回写整份状态就会报
   ``InvalidUpdateError: At key '__root__': Can receive only one value per step``。
   这里把 ``dict`` 状态包成 ``Annotated[dict, _merge_states]``，用与本包
   ``CompiledGraph`` 相同的浅合并语义做 reducer：并行分支各写各的键，互不挤掉。
   若调用方显式声明了 TypedDict / Annotated schema，就原样使用（此时并行节点
   必须写互不相同的键 —— LangGraph 的默认通道是 LastValue）。
2. **fan-in 边**：LangGraph 的普通边是**逐边触发**，一个节点有多条普通入边时
   会在每个上游完成时各触发一次（实测 ``device_monitor`` 跑了两次、脚本化
   provider 被用尽）。这里把同一目标的多条边合并成 ``add_edge([上游...], 目标)``，
   与本包引擎的「等全部前置完成、只执行一次」对齐。
3. **``max_concurrency=1``**：阶段节点会写共享的 ``MessageBus`` 与 trace 文件
   （都不是线程安全的），消息顺序又决定 ``msg_id``。限成 1 让同一超步的就绪
   节点串行执行，避免并发写坏消息编号；图的形状（分支、汇合）不变。

本模块只在函数内部 import langgraph，模块导入本身永远安全。
"""
from __future__ import annotations

from typing import Annotated, Any

from .state_graph import GraphSpec


class EngineUnavailable(RuntimeError):
    """本机没有可用的 langgraph（或版本不兼容）。"""


def available() -> bool:
    """探测 ``import langgraph.graph`` 是否可用；不抛异常。"""
    try:
        import langgraph.graph  # noqa: F401
    except Exception:  # ImportError / 依赖缺失 / 版本冲突
        return False
    return True


def _merge_states(left, right) -> dict:
    """与 ``CompiledGraph`` 一致的浅合并：后写覆盖同键，键集合取并集。"""
    merged = dict(left or {})
    merged.update(right or {})
    return merged


def _state_schema(state_cls: Any):
    """``dict``/``None`` 状态用带根 reducer 的 Annotated；其余原样使用。"""
    if state_cls is None or state_cls is dict:
        return Annotated[dict, _merge_states]
    return state_cls


def compile_graph(spec: GraphSpec):
    """把 ``GraphSpec`` 编成 LangGraph 的可执行图。

    返回 ``LangGraphRunner``（``.invoke(state)`` 直接给最终状态）。失败原因
    只有两类：没有 langgraph（``EngineUnavailable``）或图本身不合法（让
    langgraph 自己的异常透出，不吞）。
    """
    if not available():
        raise EngineUnavailable(
            "未安装 langgraph：可选适配层不可用，请使用自带 runner"
            "（five_stage 的 engine='builtin'），或先安装 langgraph")
    try:
        from langgraph.graph import END, START, StateGraph as LangStateGraph
    except Exception as exc:  # 版本差异导致的导入失败
        raise EngineUnavailable(f"langgraph 导入失败：{exc}") from exc

    graph = LangStateGraph(_state_schema(spec.state_cls))
    for name, fn in spec.nodes:
        graph.add_node(name, fn)
    # 同一个目标的多条普通边合并成一条「等待全部上游」的 fan-in 边。
    # 逐条 add_edge 会让目标节点在每个上游完成时各触发一次（LangGraph 的普通
    # 边是逐边触发，不自动汇合），五阶段里 device_monitor 就会跑两遍、把脚本化
    # provider 用尽。合并后语义与本包引擎一致：全部前置完成才执行，且只执行一次。
    sources_by_target: dict[str, list[str]] = {}
    for source, target in spec.edges:
        sources_by_target.setdefault(target, []).append(source)
    for target, sources in sources_by_target.items():
        graph.add_edge(sources[0] if len(sources) == 1 else sources, target)
    for edge in spec.conditional:
        mapping = dict(edge.mapping) if edge.mapping else None
        graph.add_conditional_edges(edge.source, edge.router, mapping)
    for entry in spec.entries:
        graph.add_edge(START, entry)
    # 没有出边的节点要显式接 END，否则 langgraph 不知道图在哪结束。
    targets = {target for _, target in spec.edges}
    targets.update(
        target for edge in spec.conditional for target in edge.static_targets())
    for name in spec.node_names:
        if name not in targets:
            graph.add_edge(name, END)
    return LangGraphRunner(graph.compile(), spec)


class LangGraphRunner:
    """薄包装：让 langgraph 应用与自带 ``CompiledGraph`` 的调用面一致。"""

    #: 就绪节点串行执行（共享 bus/trace 不是线程安全的，且消息顺序进 msg_id）。
    DEFAULT_CONFIG = {"max_concurrency": 1}

    def __init__(self, app, spec: GraphSpec) -> None:
        self._app = app
        self.spec = spec

    def invoke(self, state: dict | None = None,
               config: dict | None = None) -> dict:
        merged = dict(self.DEFAULT_CONFIG)
        if config:
            merged.update(config)
        return self._app.invoke(dict(state or {}), config=merged)
