# -*- coding: utf-8 -*-
"""运行时契约（E1）。

两个 Agent 运行时（OpenCode / Claude Agent SDK）各自独立，但都必须产出**同一套内部事件**。
这里放协议、事件形状与两个"翻译器"的纯函数，网络部分各自实现，便于离线测试。

事件形状与 ``docs/contracts/agent-events.md`` 对齐：
    {"type": "...", "session_id": "...", "data": {...}}
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Iterator, Protocol


class RuntimeUnavailable(RuntimeError):
    """运行时的进程/端口不可用（不是"这次回答失败了"）。"""


@dataclass
class Event:
    type: str
    session_id: str
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"type": self.type, "session_id": self.session_id, "data": dict(self.data)}


TYPES = (
    "session.start",
    "message.delta",
    "message.done",
    "tool.call",
    "tool.result",
    "approval.request",
    "approval.result",
    "usage",
    "error",
)


@dataclass
class RuntimeRequest:
    session_id: str
    prompt: str
    model: str = "deepseek-v4.1-flash"
    system: str = ""
    tools: list[dict] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    max_steps: int = 12


class Runtime(Protocol):
    """两个实现：opencode.py / claude.py。

    约束：两个运行时**不共享状态、不互相代理**；UI 只认 Event。
    """

    name: str

    def available(self) -> bool: ...

    def run(self, req: RuntimeRequest) -> Iterator[Event]: ...

    def cancel(self, session_id: str) -> None: ...


def coerce_events(items: Iterable[dict]) -> list[Event]:
    """把 dict 序列转成 Event，顺便校验类型名（未知类型直接报错，不静默丢）。"""
    out: list[Event] = []
    for raw in items:
        kind = str(raw.get("type") or "")
        if kind not in TYPES:
            raise ValueError("未知事件类型：%r（只认 %s）" % (kind, ", ".join(TYPES)))
        out.append(Event(kind, str(raw.get("session_id") or ""), dict(raw.get("data") or {})))
    return out
