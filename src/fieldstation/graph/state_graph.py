"""最小状态图引擎（标准库）：顺序、条件分支、并行汇合、增量合并。

## 契约

* ``StateGraph(state_cls)`` —— ``state_cls`` 是状态类型的声明（``dict`` 或
  ``TypedDict`` 一类）；运行期状态始终是普通 ``dict``；
* ``add_node(name, fn)`` —— 节点函数签名 ``fn(state) -> dict | None``，
  返回的 dict **增量合并**进状态（浅合并，键覆盖），``None`` 视为无改动；
* ``add_edge(a, b)`` —— ``a`` 完成后激活 ``b``；
* ``add_conditional_edges(node, router, mapping=None)`` —— ``node`` 完成后调用
  ``router(state)``，返回目标节点名（或名字列表），``mapping`` 可把路由键翻译
  成节点名；
* ``compile()`` —— 校验并返回可执行的 ``CompiledGraph``；
* ``invoke(state)`` —— 执行并返回最终状态。

## 汇合语义

一个节点只有在**全部前置**（普通入边 + 条件入边）都结束（done / skipped）
之后才会执行。两条上游都指向它时，它等两者都完成 —— 这正是五阶段里
``fault_diagnosis`` 等 ``qc`` 与 ``device_monitor`` 的形状。条件分支里被跳过的
一支视为已结束、不阻塞汇合点：汇合点在至少一条上游产出后执行（两条都激活时
必须等齐）。就绪节点按 ``add_node`` 的声明顺序串行执行：结果确定、trace 可
逐字节比对（与 ``agents/trace/writer.py`` 的纪律一致），不引入线程调度带来的
顺序抖动。

## 条件分支语义

* 给了 ``mapping``：候选目标在编译期已知，未命中的候选会被标记 ``skipped``，
  且从它出发的普通边不会激活下游（分支不会「半条腿」跑下去）；
* 没给 ``mapping``：路由返回值直接当节点名。此时除路由源之外、没有普通入边
  的节点都视为「等待路由判决」—— 被选中才执行，否则在静止期标为 ``skipped``。
  动态路由无法在编译期做连通性校验，图会退化为运行期校验（目标已执行则报错）。

## 错误

定义错误（重名节点、未知端点、环）在 ``compile()`` 抛
``GraphDefinitionError``；执行错误（节点返回值不是 dict、图停滞、条件目标已
执行）抛 ``GraphExecutionError``。都继承 ``ValueError``，调用方可以只捕
``ValueError``。
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping as AbcMapping
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

NodeFn = Callable[[dict], "dict | None"]
RouterFn = Callable[[dict], "str | Iterable[str] | None"]


class GraphError(ValueError):
    """状态图定义或执行的基类错误。"""


class GraphDefinitionError(GraphError):
    """图定义不合法（重名、未知节点、环等），编译期抛出。"""


class GraphExecutionError(GraphError):
    """执行期错误（节点返回值非法、图停滞等）。"""


def _canonical(obj: Any) -> str:
    """稳定序列化：与 trace 的 JSONL 口径一致（紧凑、UTF-8、键排序）。"""
    try:
        return json.dumps(obj, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise GraphExecutionError(f"状态不可 JSON 序列化：{exc}") from exc


def digest_of(obj: Any, length: int = 16) -> str:
    """对象摘要（默认 16 位十六进制），与 ``runtime.digest_input`` 同长度口径。

    用于检查点里的 ``input_digest`` / ``output_digest``：同输入同摘要，
    不掺时间戳或随机量。
    """
    return hashlib.sha256(_canonical(obj).encode("utf-8")).hexdigest()[:length]


@dataclass(frozen=True)
class ConditionalEdge:
    """一条条件边：``source`` 结束后由 ``router`` 决定走哪些目标。"""

    source: str
    router: RouterFn
    mapping: tuple[tuple[str, str], ...] = ()

    def resolve(self, value) -> tuple[str, ...]:
        """把路由返回值翻译成目标节点名（保持返回顺序、去重）。"""
        if value is None:
            return ()
        if isinstance(value, str):
            raw: Iterable = (value,)
        else:
            try:
                raw = tuple(value)
            except TypeError as exc:
                raise GraphExecutionError(
                    f"条件路由 {self.source!r} 必须返回字符串或字符串列表，"
                    f"收到 {type(value).__name__}") from exc
        table = dict(self.mapping)
        targets: list[str] = []
        for name in raw:
            if not isinstance(name, str) or not name.strip():
                raise GraphExecutionError(
                    f"条件路由 {self.source!r} 返回了非节点名：{name!r}")
            target = table.get(name, name)
            if target not in targets:
                targets.append(target)
        return tuple(targets)

    def static_targets(self) -> tuple[str, ...]:
        """编译期已知的候选目标（只有显式 mapping 才可知）。"""
        return tuple(dict.fromkeys(target for _, target in self.mapping))


@dataclass(frozen=True)
class GraphSpec:
    """图的静态描述：自带 runner 与 langgraph 适配层都从它起步。

    ``state_cls`` 是 ``StateGraph(state_cls)`` 声明的状态类型：自带 runner
    运行期始终用普通 dict；langgraph 适配层在它是 ``dict``/``None`` 时套一层
    根 reducer（与自带 runner 的浅合并等价），声明成 TypedDict 时则按该 schema
    建通道（此时并行节点必须写互不相同的键）。
    """

    nodes: tuple[tuple[str, NodeFn], ...]
    edges: tuple[tuple[str, str], ...]
    conditional: tuple[ConditionalEdge, ...]
    entries: tuple[str, ...]
    state_cls: Any = dict

    @property
    def node_names(self) -> tuple[str, ...]:
        return tuple(name for name, _ in self.nodes)


class StateGraph:
    """状态图定义器；``compile()`` 之后才可执行。"""

    def __init__(self, state_cls: Any = dict) -> None:
        self.state_cls = state_cls
        self._nodes: dict[str, NodeFn] = {}
        self._edges: list[tuple[str, str]] = []
        self._conditional: list[ConditionalEdge] = []
        self._compiled = False

    # ---------------------------------------------------------------- 定义
    def add_node(self, name: str, fn: NodeFn) -> "StateGraph":
        self._reject_after_compile()
        if not isinstance(name, str) or not name.strip():
            raise GraphDefinitionError("节点名必须是非空字符串")
        if name in self._nodes:
            raise GraphDefinitionError(f"节点重名：{name!r}")
        if not callable(fn):
            raise GraphDefinitionError(f"节点 {name!r} 的处理函数不可调用")
        self._nodes[name] = fn
        return self

    def add_edge(self, source: str, target: str) -> "StateGraph":
        self._reject_after_compile()
        for name in (source, target):
            if not isinstance(name, str) or not name.strip():
                raise GraphDefinitionError("边的端点必须是非空字符串")
        self._edges.append((source, target))
        return self

    def add_conditional_edges(
        self,
        node: str,
        router: RouterFn,
        mapping: Mapping[str, str] | Iterable[tuple[str, str]] | None = None,
    ) -> "StateGraph":
        self._reject_after_compile()
        if not isinstance(node, str) or not node.strip():
            raise GraphDefinitionError("条件边的源节点必须是非空字符串")
        if not callable(router):
            raise GraphDefinitionError(f"条件边 {node!r} 的路由不可调用")
        if any(edge.source == node for edge in self._conditional):
            raise GraphDefinitionError(f"节点 {node!r} 已有一条条件边")
        pairs: tuple[tuple[str, str], ...] = ()
        if mapping is not None:
            items = mapping.items() if isinstance(mapping, AbcMapping) else mapping
            pairs = tuple((str(k), str(v)) for k, v in items)
            if not pairs:
                raise GraphDefinitionError(
                    f"条件边 {node!r} 的 mapping 不能为空（不需要翻译就不要传）")
        self._conditional.append(ConditionalEdge(node, router, pairs))
        return self

    def _reject_after_compile(self) -> None:
        if self._compiled:
            raise GraphDefinitionError("图已编译，不能再修改定义")

    # ---------------------------------------------------------------- 编译
    def compile(self) -> "CompiledGraph":
        if not self._nodes:
            raise GraphDefinitionError("空图：至少需要一个节点")

        names = tuple(self._nodes)
        known = set(names)
        for source, target in self._edges:
            for name in (source, target):
                if name not in known:
                    raise GraphDefinitionError(
                        f"边引用了未声明的节点：{name!r}（已声明：{sorted(known)}）")
        for edge in self._conditional:
            if edge.source not in known:
                raise GraphDefinitionError(
                    f"条件边引用了未声明的节点：{edge.source!r}")
            for key, target in edge.mapping:
                if target not in known:
                    raise GraphDefinitionError(
                        f"条件边 {edge.source!r} 的 mapping[{key!r}] 指向未声明节点 "
                        f"{target!r}")

        plain_preds: dict[str, set[str]] = {name: set() for name in names}
        plain_targets: dict[str, list[str]] = {name: [] for name in names}
        for source, target in self._edges:
            plain_preds[target].add(source)
            plain_targets[source].append(target)

        mapped_targets: set[str] = set()
        dynamic_sources: list[str] = []
        for edge in self._conditional:
            if edge.mapping:
                mapped_targets.update(edge.static_targets())
            else:
                dynamic_sources.append(edge.source)

        entries = [
            name for name in names
            if not plain_preds[name]
            and name not in mapped_targets
            and not any(source != name for source in dynamic_sources)
        ]
        # 没有普通入边的路由源本身必须是入口，否则谁都等不到它。
        for source in dynamic_sources:
            if not plain_preds[source] and source not in entries:
                entries.append(source)
        if not entries:
            raise GraphDefinitionError(
                "图没有入口节点（每个节点都有入边，或全部被条件边遮挡）")

        if dynamic_sources:
            # 动态路由的候选在编译期不可知，跳过静态连通性检查；
            # 运行期会用「目标已执行」与静止期 skipped 两条判据兜底。
            reachable = set(names)
        else:
            mapped_by_source = {
                edge.source: set(edge.static_targets())
                for edge in self._conditional if edge.mapping
            }
            reachable = self._reachable(entries, plain_targets, mapped_by_source)
            missing = [name for name in names if name not in reachable]
            if missing:
                raise GraphDefinitionError(
                    f"节点不可达（没有从入口出发的边）：{missing}")
            self._reject_cycles(names, plain_preds, self._conditional)

        conditional_by_source = {edge.source: edge for edge in self._conditional}
        self._compiled = True
        spec = GraphSpec(
            nodes=tuple((name, self._nodes[name]) for name in names),
            edges=tuple(self._edges),
            conditional=tuple(self._conditional),
            entries=tuple(entries),
            state_cls=self.state_cls,
        )
        return CompiledGraph(
            spec=spec,
            plain_preds=plain_preds,
            plain_targets=plain_targets,
            conditional=conditional_by_source,
            dynamic_sources=tuple(dynamic_sources),
            state_cls=self.state_cls,
        )

    @staticmethod
    def _reachable(entries, plain_targets, mapped_by_source) -> set[str]:
        """从入口出发的静态可达集合（普通边 + 有 mapping 的条件边）。"""
        seen: set[str] = set()
        queue = list(entries)
        while queue:
            node = queue.pop()
            if node in seen:
                continue
            seen.add(node)
            queue.extend(plain_targets.get(node, ()))
            queue.extend(mapped_by_source.get(node, ()))
        return seen

    @staticmethod
    def _reject_cycles(names, plain_preds, conditional) -> None:
        preds = {name: set(plain_preds[name]) for name in names}
        for edge in conditional:
            for target in edge.static_targets():
                preds[target].add(edge.source)
        # Kahn 拓扑排序；剩下的就是环上的节点。
        indegree = {name: len(preds[name]) for name in names}
        children: dict[str, list[str]] = {name: [] for name in names}
        for name in names:
            for pred in preds[name]:
                children[pred].append(name)
        queue = [name for name in names if indegree[name] == 0]
        visited = 0
        while queue:
            node = queue.pop()
            visited += 1
            for child in children[node]:
                indegree[child] -= 1
                if indegree[child] == 0:
                    queue.append(child)
        if visited != len(names):
            stuck = sorted(name for name in names if indegree[name] > 0)
            raise GraphDefinitionError(f"图有环，无法编排：{stuck}")


class CompiledGraph:
    """可执行的状态图。节点按声明顺序串行推进，汇合点等待全部前置。"""

    def __init__(
        self,
        *,
        spec: GraphSpec,
        plain_preds: dict[str, set[str]],
        plain_targets: dict[str, list[str]],
        conditional: dict[str, ConditionalEdge],
        dynamic_sources: tuple[str, ...],
        state_cls: Any,
    ) -> None:
        self.spec = spec
        self.state_cls = state_cls
        self._nodes = dict(spec.nodes)
        self._plain_preds = plain_preds
        self._plain_targets = plain_targets
        self._conditional = conditional
        self._dynamic_sources = dynamic_sources
        self._order = spec.node_names
        #: 条件边（有 mapping 时）在编译期的候选目标 → 源节点。
        self._mapped_preds: dict[str, set[str]] = {name: set() for name in self._order}
        for edge in spec.conditional:
            for target in edge.static_targets():
                self._mapped_preds[target].add(edge.source)

    def spec_dict(self) -> dict:
        """供 CLI / 适配层读取的静态描述（节点函数不进 JSON）。"""
        return {
            "nodes": list(self.spec.node_names),
            "edges": [list(edge) for edge in self.spec.edges],
            "conditional": [
                {"source": edge.source,
                 "mapping": {key: target for key, target in edge.mapping}}
                for edge in self.spec.conditional
            ],
            "entries": list(self.spec.entries),
        }

    # ----------------------------------------------------------------- 执行
    def invoke(
        self,
        state: Mapping[str, Any] | None = None,
        *,
        thread_id: str | None = None,
        checkpoint: Any = None,
        resume: Iterable[str] | None = None,
    ) -> dict:
        """执行整张图，返回最终状态。

        ``checkpoint`` 只需实现 ``record(thread_id, node, input_digest,
        output_digest)`` 与 ``resume(thread_id) -> Iterable[str]``（见
        ``checkpoint.CheckpointStore``）。给了 ``checkpoint`` 就必须给
        ``thread_id``。

        ``resume`` 是本次要跳过的节点名集合；省略时从 ``checkpoint`` 里取。
        **跳过只代表不再执行**，被跳过节点的产物必须已经包含在传入的 ``state``
        里 —— 检查点只存摘要，不存产物本体（同 trace 的 ``result_digest``
        纪律）。这样恢复的语义是「沿用上次的中间状态，只补跑没做完的节点」。
        """
        if checkpoint is not None:
            if not isinstance(thread_id, str) or not thread_id.strip():
                raise GraphExecutionError("使用 checkpoint 时必须提供非空 thread_id")
            missing = [name for name in ("record", "resume")
                       if not callable(getattr(checkpoint, name, None))]
            if missing:
                raise GraphExecutionError(
                    f"checkpoint 缺少方法 {missing}（应实现 record/resume）")

        initial = dict(state or {})
        if resume is None:
            skip = set(checkpoint.resume(thread_id)) if checkpoint else set()
        else:
            skip = {str(name) for name in resume}
        unknown = sorted(name for name in skip if name not in set(self._order))
        if unknown:
            raise GraphExecutionError(f"resume 指定了未知节点：{unknown}")

        status = {name: "pending" for name in self._order}
        activated: set[str] = set(self.spec.entries)
        routed: set[str] = set()
        state = initial

        def ready(node: str) -> bool:
            for pred in self._plain_preds[node]:
                if status[pred] not in ("done", "skipped"):
                    return False
            for pred in self._mapped_preds[node]:
                if status[pred] not in ("done", "skipped"):
                    return False
            for source in self._dynamic_sources:
                if source != node and status[source] not in ("done", "skipped"):
                    return False
            return True

        def finish(node: str) -> None:
            """节点结束后的统一收尾：激活下游、必要时执行路由。"""
            for target in self._plain_targets[node]:
                activated.add(target)
            edge = self._conditional.get(node)
            if edge is None or node in routed:
                return
            targets = edge.resolve(edge.router(state))
            for target in targets:
                if target not in self._nodes:
                    raise GraphExecutionError(
                        f"条件路由 {node!r} 返回了未声明的节点：{target!r}")
                if status[target] == "done":
                    raise GraphExecutionError(
                        f"条件路由 {node!r} 的目标 {target!r} 已经执行过："
                        "路由必须指向尚未推进的分支")
                activated.add(target)
            routed.add(node)

        while True:
            progressed = False
            for node in self._order:
                if status[node] != "pending":
                    continue
                if not ready(node):
                    continue
                if node not in activated:
                    status[node] = "skipped"
                    progressed = True
                    continue
                if node in skip:
                    status[node] = "done"
                    finish(node)
                    progressed = True
                    continue

                snapshot = dict(state)
                output = self._nodes[node](snapshot)
                if output is None:
                    delta: dict = {}
                elif isinstance(output, AbcMapping):
                    delta = dict(output)
                else:
                    raise GraphExecutionError(
                        f"节点 {node!r} 必须返回 dict 或 None，"
                        f"收到 {type(output).__name__}")
                state.update(delta)
                if checkpoint is not None:
                    checkpoint.record(
                        thread_id, node,
                        input_digest=digest_of(snapshot),
                        output_digest=digest_of(delta),
                    )
                status[node] = "done"
                finish(node)
                progressed = True

            if not progressed:
                break

        pending = [name for name in self._order if status[name] == "pending"]
        if pending:
            blocked = [name for name in pending if name in activated]
            if blocked:
                raise GraphExecutionError(
                    f"图停滞：节点 {blocked} 已激活但前置未完成"
                    "（检查条件边与普通边是否互相等待）")
            for name in pending:
                status[name] = "skipped"
        return state
