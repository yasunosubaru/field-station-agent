"""智能体工具层：工具协议、结果类型、注册表。

spec §4 的「工具注册」原本推迟到 M3，本模块把其中**框架无关**的部分先做实：
不管 M3 最后选 LangGraph 还是 Pydantic AI，都需要「一个能在运行期按名字找到工具、
并把工具描述喂给模型」的注册表。框架相关的那部分（框架自己的 tool 机制与 MCP 适配层）
仍等选型落地后再接，本模块不自造。

三条设计约束：

* **工具是适配层，不是重新实现。** 判据一律在 ``rules/``，本层只负责把 ``rules/``
  的纯函数包成智能体能调的形。谁在 ``agents/`` 里重新写一遍统计口径，
  哪天道和 ``rules/`` 走了分叉，没人会发现。
* **失败要报，不要抛。** 工具返回 ``ToolResult(ok=False, error=...)``，
  让模型看见失败并换路；抛异常会把整个运行循环打崩，一次输入不合法就整轮报废。
* **结果必须可 JSON 序列化。** 不可序列化的返回会让回放评测崩在中间。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class ToolResult:
    """一次工具调用的结果。

    ``ok=False`` 时 ``data`` 为空、``error`` 必填。**调用方读 ok 再读 data**，
    不要靠 ``data`` 里有没有某个键来猜成败。
    """

    ok: bool
    data: dict = field(default_factory=dict)
    error: str | None = None


@runtime_checkable
class Tool(Protocol):
    """一个可被智能体调用的确定性工具。"""

    name: str
    description: str
    params: dict
    risk: str

    def invoke(self, args: dict) -> ToolResult:
        ...


class ToolRegistry:
    """按名字存工具，并把描述列表喂给模型。"""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        """登记一个工具。**重名直接报错**，不静默覆盖。

        静默覆盖最坏的情况是：后注册的工具顶着前一个的名字被调用，
        而调用方（包括模型）看到的还是原来那个名字与描述。这种错不会报错，
        只会给出一个看起来正常的错答案。
        """
        if tool.name in self._tools:
            raise ValueError(
                f"工具重名：{tool.name!r}（已注册 {self._tools[tool.name].__class__.__name__}）")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))

    def describe(self) -> list[dict]:
        """喂给 provider 的工具描述列表。键集合固定，多了少了都算接口漂移。"""
        return [
            {
                "name": t.name,
                "description": t.description,
                "params": t.params,
                "risk": t.risk,
            }
            for t in (self._tools[n] for n in self.names())
        ]

    def invoke(self, name: str, args: dict) -> ToolResult:
        t = self._tools.get(name)
        if t is None:
            raise KeyError(f"未注册的工具：{name!r}（已注册：{self.names()}）")
        return t.invoke(args)
