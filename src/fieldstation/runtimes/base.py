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


#: 全项目唯一允许的模型。纪-1 的硬闸门就钉在这个常量上。
#:
#: 为什么是名字而不是"按 provider 允许"：模型选择一旦能由请求体决定，
#: 评测、复盘与计费就都说不清"这次到底是谁答的"。允许清单只有一个元素，
#: 新增模型必须同时改这里、``docs/`` 与测试 —— 那正是"显式"的含义。
CANONICAL_MODEL = "deepseek-v4.1-flash"

#: 允许清单（裸规范名）。带 provider 前缀的写法由 :func:`normalize_model` 归一。
MODEL_ALLOWLIST = frozenset({CANONICAL_MODEL})

#: 错误码：请求要求了允许清单以外的模型。
MODEL_NOT_ALLOWED = "E_MODEL_NOT_ALLOWED"


class ModelNotAllowed(RuntimeError):
    """请求的模型不在 :data:`MODEL_ALLOWLIST` 内。

    ``code`` 是给 SSE ``error`` 事件用的机器可读码；消息里保留被拒的原始
    模型名与允许清单，方便调用方一眼看出"我传错了"而不是"服务坏了"。
    """

    code = MODEL_NOT_ALLOWED

    def __init__(self, model: str, *, allowed=MODEL_ALLOWLIST) -> None:
        self.model = str(model or "")
        self.allowed = tuple(sorted(allowed))
        super().__init__(
            "模型 %r 不在允许清单内（只允许 %s）；换模型必须显式改代码与文档"
            % (self.model, ", ".join(self.allowed)))


def normalize_model(model: str) -> str:
    """把请求里的模型名归一成裸规范名；不在清单内抛 :class:`ModelNotAllowed`。

    * 空值 → :data:`CANONICAL_MODEL`（调用方没指定时用唯一模型，而不是"随便"）
    * ``provider/model`` → 取 ``model`` 部分；provider 前缀由各运行时自己合成
    * 其余不在清单内的名字 → 拒绝

    只认最后一个 ``/`` 之后的段：``commandcode/deepseek-v4.1-flash`` 合法，
    ``commandcode/other/x`` 不合法（``x`` 不在清单）。
    """
    text = str(model or "").strip()
    if not text:
        return CANONICAL_MODEL
    name = text.rsplit("/", 1)[-1].strip()
    if name not in MODEL_ALLOWLIST:
        raise ModelNotAllowed(text)
    return name


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
    model: str = CANONICAL_MODEL
    system: str = ""
    tools: list[dict] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    max_steps: int = 12

    def __post_init__(self) -> None:
        # 纪-1：模型闸门放在契约对象上，而不是散在各个适配器里。
        # 这样无论请求从 SSE、CLI 还是脚本进来，都必须先过这一关；
        # 适配器拿到的 ``req.model`` 永远是裸规范名，前缀由它自己合成。
        self.model = normalize_model(self.model)


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
