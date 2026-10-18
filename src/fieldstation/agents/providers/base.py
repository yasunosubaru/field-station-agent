"""provider 抽象层：消息/响应数据类、Provider 协议、get_provider 工厂。

这是 spec §4「provider 抽象」的落地：``chat(messages, tools) -> response``，
配置全部外置。M0 只提供 fake；M3-0（issue #50）接入本地 Ollama 通道，
云 API 通道的选型见 X-1（issue #71）的结论，接入时按同一协议加分支。

设计决定（非事实断言）：
  * ``get_provider`` 只认在 ``config/providers.json`` 里配过的名字，遇到未知名字
    抛 ``ValueError``，且**不留** ``NotImplementedError`` 的 TODO 分支 ——
    一个未实现的占位分支会让回放评测以为还有别的执行路径可走。
    新接一个通道 = 加一个真实分支 + 配置项，而不是留占位。
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
    """按名字与配置构造 provider。

    ``fake`` 是测试替身（按预置顺序返回）；``ollama`` 是 M3-0 接入的本地通道
    （配置见 ``config/providers.json``）。未知名字抛 ``ValueError``，不留占位分支。
    """
    if name == "fake":
        from .fake import FakeProvider

        return FakeProvider(list(config.get("responses", [])))
    if name == "ollama":
        from .ollama import OllamaProvider

        return OllamaProvider(config)
    raise ValueError(f"未知 provider: {name!r}（支持 'fake' 与 'ollama'，"
                     "配置见 config/providers.json）")
