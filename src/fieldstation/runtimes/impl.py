# -*- coding: utf-8 -*-
"""两个运行时的薄实现 + 一个可脚本化的假运行时。

网络部分都用标准库 ``urllib``；解析在 :mod:`sse` 里，纯函数、可离线测。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from .base import Event, RuntimeRequest, RuntimeUnavailable
from .sse import (AnthropicState, OpenAIState, iter_sse, translate_anthropic,
                  translate_openai)


def _post_json(url: str, body: dict, headers: dict, timeout: float = 120.0):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        req.add_header(key, value)
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as exc:  # 端口没起/连不上都算运行时不可用
        raise RuntimeUnavailable("连不上运行时 %s：%s" % (url, exc)) from exc


class OpenAICompatibleRuntime:
    """任何 OpenAI 兼容端点（vLLM / Ollama / 网关；默认 http://127.0.0.1:11434/v1）。"""

    name = "openai-compatible"

    def __init__(self, base_url: str = "http://127.0.0.1:11434/v1",
                 api_key: str = "", timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def available(self) -> bool:
        try:
            with urllib.request.urlopen(self.base_url + "/models", timeout=3) as resp:
                return resp.status < 500
        except Exception:  # noqa: BLE001
            return False

    def run(self, req: RuntimeRequest):
        body = {
            "model": req.model,
            "stream": True,
            "messages": [{"role": "system", "content": req.system}] if req.system else [],
        }
        body["messages"].extend(req.history or [])
        body["messages"].append({"role": "user", "content": req.prompt})
        if req.tools:
            body["tools"] = [{"type": "function", "function": t} for t in req.tools]

        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
        state = OpenAIState(req.session_id)
        resp = _post_json(self.base_url + "/chat/completions", body, headers, self.timeout)
        with resp:
            for _, payload in iter_sse(resp):
                for event in translate_openai(payload, state):
                    yield event

    def cancel(self, session_id: str) -> None:
        # OpenAI 兼容端点通常没有取消接口；调用方直接关闭迭代即可
        return None


class ClaudeRuntime:
    """Claude Agent SDK 侧：走 Anthropic Messages（可指向 anthropic_shim）。"""

    name = "claude"

    def __init__(self, base_url: str = "http://127.0.0.1:8765",
                 api_key: str = "", timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def available(self) -> bool:
        try:
            with urllib.request.urlopen(self.base_url + "/health", timeout=3) as resp:
                return resp.status == 200
        except Exception:  # noqa: BLE001
            return False

    def run(self, req: RuntimeRequest):
        body = {
            "model": req.model,
            "max_tokens": 4096,
            "stream": True,
            "messages": [{"role": "user", "content": req.prompt}],
        }
        if req.system:
            body["system"] = req.system
        if req.tools:
            body["tools"] = req.tools

        headers = {"x-api-key": self.api_key, "anthropic-version": "2023-06-01"} if self.api_key else {}
        state = AnthropicState(req.session_id)
        resp = _post_json(self.base_url + "/v1/messages", body, headers, self.timeout)
        with resp:
            for event_name, payload in iter_sse(resp):
                for event in translate_anthropic(event_name, payload, state):
                    yield event

    def cancel(self, session_id: str) -> None:
        return None


class FakeRuntime:
    """脚本化运行时：按预设事件序列吐出，用于离线测试与演示。"""

    name = "fake"

    def __init__(self, script: list[dict] | None = None):
        self.script = script or [
            {"type": "session.start", "data": {"runtime": "fake"}},
            {"type": "message.delta", "data": {"text": "（演示）"}},
            {"type": "message.done", "data": {"reason": "stop"}},
        ]

    def available(self) -> bool:
        return True

    def run(self, req: RuntimeRequest):
        for item in self.script:
            yield Event(str(item["type"]), req.session_id, dict(item.get("data") or {}))

    def cancel(self, session_id: str) -> None:
        return None


#: 兼容旧名：OpenCode 的 v2 API 不是 OpenAI 兼容的（实测 /openapi.json 401，
#: serve 会打印 server password），要接它得单独写原生适配器。在那之前，
#: 这个名字指向通用 OpenAI 兼容实现，避免"以为已经接了 OpenCode"。
OpenCodeRuntime = OpenAICompatibleRuntime
