# -*- coding: utf-8 -*-
"""运行时网关：对外一个 SSE 端点，对内在两个运行时之间切换。

设计要点（对应 ADR-009）：
* 两个运行时**互不依赖**——任一不可用只影响它自己那条请求，另一条照常；
* 切换是**显式**的：请求里带 ``runtime``，不自动回退（自动切换会让"哪次用了谁"说不清）；
* 对外只吐统一事件（``Event``），调用方不需要知道下面是谁。

不引第三方：HTTP 用标准库 ``http.server``，流用 SSE。
"""
from __future__ import annotations

import json
from dataclasses import asdict
from typing import Iterable, Iterator

from .base import (
    CANONICAL_MODEL,
    MODEL_NOT_ALLOWED,
    Event,
    ModelNotAllowed,
    Runtime,
    RuntimeRequest,
    RuntimeUnavailable,
)
from .impl import ClaudeRuntime, FakeRuntime, OpenAICompatibleRuntime


class RuntimeRegistry:
    """名字 → 运行时。``available()`` 只报状态，不替调用方做决定。"""

    def __init__(self, runtimes: Iterable[Runtime] | None = None):
        items = list(runtimes or [OpenAICompatibleRuntime(), ClaudeRuntime()])
        self._by_name = {r.name: r for r in items}

    def names(self) -> list[str]:
        return sorted(self._by_name)

    def get(self, name: str) -> Runtime:
        runtime = self._by_name.get(name)
        if runtime is None:
            raise RuntimeUnavailable("没有这个运行时：%r（可选 %s）" % (name, self.names()))
        return runtime

    def status(self) -> dict:
        out = {}
        for name, runtime in self._by_name.items():
            try:
                out[name] = {"available": bool(runtime.available())}
            except Exception as exc:  # noqa: BLE001 —— 探测失败也要报状态，不能炸端点
                out[name] = {"available": False, "error": str(exc)[:120]}
        return out

    def pick(self, name: str) -> Runtime:
        """显式选择；不可用就抛，**不**自动换另一个。"""
        runtime = self.get(name)
        if not runtime.available():
            raise RuntimeUnavailable("运行时 %r 当前不可用" % name)
        return runtime


def sse_bytes(event: Event) -> bytes:
    """一条事件 → 一个 SSE 帧（event 名用类型，data 是完整 JSON）。"""
    payload = json.dumps(event.to_dict(), ensure_ascii=False)
    return ("event: %s\ndata: %s\n\n" % (event.type, payload)).encode("utf-8")


def stream_chat(registry: RuntimeRegistry, body: dict) -> Iterator[bytes]:
    """把一次请求变成 SSE 字节流；任何异常都变成 error 事件，不让连接悬着。

    请求体：``{"runtime": "...", "session_id": "...", "prompt": "...", "model": "...",
              "system": "...", "tools": [...], "history": [...]}``
    """
    name = str(body.get("runtime") or "")
    session_id = str(body.get("session_id") or "")
    try:
        runtime = registry.pick(name)
    except RuntimeUnavailable as exc:
        yield sse_bytes(Event("error", session_id,
                               {"class": "environment", "message": str(exc)}))
        return

    try:
        req = RuntimeRequest(
            session_id=session_id,
            prompt=str(body.get("prompt") or ""),
            model=str(body.get("model") or CANONICAL_MODEL),
            system=str(body.get("system") or ""),
            tools=list(body.get("tools") or []),
            history=list(body.get("history") or []),
        )
    except ModelNotAllowed as exc:
        # 纪-1：模型闸门在契约对象上，请求构造这一步就会拒；
        # 归类 input（调用方传错了），不是环境故障，重试也不会变好。
        yield sse_bytes(Event("error", session_id, {
            "class": "input",
            "code": MODEL_NOT_ALLOWED,
            "message": str(exc),
            "retryable": False,
        }))
        return
    try:
        for event in runtime.run(req):
            yield sse_bytes(event)
    except ModelNotAllowed as exc:
        # 运行时若绕过契约自己校验，也走同一个错误形状，不降级成 execution。
        yield sse_bytes(Event("error", session_id, {
            "class": "input",
            "code": MODEL_NOT_ALLOWED,
            "message": str(exc),
            "retryable": False,
        }))
    except RuntimeUnavailable as exc:
        yield sse_bytes(Event("error", session_id,
                               {"class": "environment", "message": str(exc)}))
    except Exception as exc:  # noqa: BLE001 —— 运行时内部错误要变成事件
        yield sse_bytes(Event("error", session_id,
                               {"class": "execution",
                                "message": "%s: %s" % (type(exc).__name__, exc)}))


def status_payload(registry: RuntimeRegistry) -> dict:
    return {"runtimes": registry.status(), "model_default": CANONICAL_MODEL}
