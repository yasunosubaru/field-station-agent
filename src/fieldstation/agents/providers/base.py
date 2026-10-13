"""provider 抽象层：消息/响应数据类、Provider 协议、get_provider 工厂。

这是 spec §4「provider 抽象」的落地：``chat(messages, tools) -> response``，
配置全部外置。M0 只提供 fake；真实模型（本地 Ollama / 云 API）在 M3 接入，
本模块只把接口形状定死，不接真实模型。

设计决定（非事实断言）：
  * ``get_provider`` 目前只认 ``"fake"``，遇到未知名字抛 ``ValueError``，
    且**不留** ``NotImplementedError`` 的 TODO 分支 —— 一个未实现的占位分支
    会让 Task 8 的回放评测以为还有别的执行路径可走。
  * ``Provider`` 是 ``@runtime_checkable`` 协议：任何带 ``name`` 属性与
    ``chat`` 方法的对象都在结构上满足它，换模型不需要改调用方代码。

本模块只用标准库。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class ChatMessage:
    """一条对话消息。"""

    role: str
    content: str


@dataclass
class ChatResponse:
    """一次模型调用的返回：正文 + 工具调用 + 用量。

    ``tool_calls`` / ``usage`` 默认空 —— 单轮纯文本回答用不到它们，
    但字段必须存在，接口形状才能定死。
    """

    content: str
    tool_calls: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)


@runtime_checkable
class Provider(Protocol):
    """模型适配层协议：一个 ``name`` 属性 + 一个 ``chat`` 方法。"""

    name: str

    def chat(self, messages: list[ChatMessage], tools: list[dict]) -> ChatResponse:
        ...


def get_provider(name: str, config: dict) -> Provider:
    """按名字与配置构造 provider。M0 只认 ``"fake"``，未知名字抛 ``ValueError``。"""
    if name == "fake":
        from .fake import FakeProvider

        return FakeProvider(list(config.get("responses", [])))
    raise ValueError(f"未知 provider: {name!r}（当前只支持 'fake'，真实 provider 在 M3 接入）")
