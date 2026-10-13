"""FakeProvider：按预置顺序返回响应的测试替身，不接真实模型。

M0 只测框架本身：空链路能跑通（有输入 → 有 trace → 有输出）即可，
真实模型（本地/API）在 M3 接入。用尽预置响应后抛 ``RuntimeError``
（由 tests/test_runtime.py::TestFakeProvider::test_exhausted_provider_raises 钉死）。

本模块只用标准库。
"""
from __future__ import annotations

from .base import ChatMessage, ChatResponse, Provider


class FakeProvider(Provider):
    """每次 ``chat`` 按构造顺序返回一条预置响应，用尽后抛 ``RuntimeError``。"""

    name = "fake"

    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self._i = 0

    def chat(self, messages: list[ChatMessage], tools: list[dict]) -> ChatResponse:
        if self._i >= len(self._responses):
            raise RuntimeError(
                f"FakeProvider 已用尽：预置 {len(self._responses)} 条响应，"
                f"已返回 {self._i} 条")
        content = self._responses[self._i]
        self._i += 1
        return ChatResponse(content=content)
