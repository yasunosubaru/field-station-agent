"""OllamaProvider：本地 Ollama 通道（spec §5 双轨的本地侧）。

M3-0 的落地（issue #50）：接口形状由 ``providers/base.py`` 定死
（``chat(messages, tools) -> ChatResponse``），本模块把该接口接到本机 Ollama 的
``POST /api/chat`` 上。配置全部外置（``config/providers.json``），换模型不改代码。

设计决定（非事实断言）：

* **纯标准库** ``urllib`` —— CLAUDE.md §4「仓库核心无第三方依赖」对本模块同样适用；
  Ollama 的 HTTP 接口用 ``urllib.request`` 足够，不值得为此引依赖。
* **错误语义：不静默**。服务不可达 / 非 200 / 响应体不是 JSON，一律抛
  ``ProviderError``（带 host:port 与状态码或原文片段）。静默返回空响应会让评测把
  「模型没说话」当成「模型说没事」—— 那正是 KI-10 那类「半截写法静默吞错」的
  provider 版。``ProviderError`` 继承 ``RuntimeError``，与 FakeProvider 用尽时的
  异常类型一致，调用方按同一类异常处理。
* **tool_calls 归一在这里做**：Ollama 返回 ``{"function": {"name":..., "arguments":…}}``，
  而 ``runtime._dispatch`` 认的是 ``{"name":..., "args":…}``。翻译放 provider，
  runtime 不需要知道 Ollama 的报文长什么样。
* ``think`` / ``options``（temperature、seed、num_ctx）**原样透传**，本模块不对
  「设了 temperature=0 就可复现」作任何声称 —— 是否真可复现由
  ``tools/probe_provider_live.py`` 实测，结论进 ``docs/decisions/``。
* ``model`` 是必填配置，缺了在构造时抛错 —— 宁可炸在启动，不可猜一个默认模型
  把评测跑在错误的模型上。

本模块只用标准库。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from .base import ChatMessage, ChatResponse, Provider

DEFAULT_URL = "http://127.0.0.1:11434"


class ProviderError(RuntimeError):
    """Ollama 通道错误：配置缺项 / 不可达 / 非 200 / 响应体不可解析。"""


class OllamaProvider(Provider):
    """接本机（或内网）Ollama 服务的 provider。"""

    name = "ollama"

    def __init__(self, config: dict):
        self._url = (config.get("url") or DEFAULT_URL).rstrip("/")
        self._model = config.get("model") or ""
        if not self._model:
            raise ProviderError(
                f"Ollama 配置缺 model（config keys: {sorted(config)}）—— "
                "不猜默认模型，评测必须写明跑在哪个模型上")
        self._options = dict(config.get("options") or {})
        self._think = config.get("think")
        self._timeout = float(config.get("timeout_s", 300))

    def chat(self, messages: list[ChatMessage], tools: list[dict]) -> ChatResponse:
        payload: dict = {
            "model": self._model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": False,
            "options": self._options,
        }
        if tools:
            payload["tools"] = tools
        if self._think is not None:
            payload["think"] = bool(self._think)

        try:
            req = urllib.request.Request(
                self._url + "/api/chat",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                body = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200]
            raise ProviderError(
                f"Ollama 返回 HTTP {exc.code}（model={self._model!r}）：{detail}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise ProviderError(
                f"Ollama 不可达（{self._url}，model={self._model!r}）：{exc}") from exc
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                f"Ollama 响应不是 JSON（前 120 字符：{body[:120]!r}）") from exc

        message = data.get("message") or {}
        tool_calls = [
            {"name": (tc.get("function") or {}).get("name", ""),
             "args": (tc.get("function") or {}).get("arguments") or {}}
            for tc in message.get("tool_calls") or []
        ]
        usage: dict = {}
        if "prompt_eval_count" in data:
            usage["prompt_tokens"] = data["prompt_eval_count"]
        if "eval_count" in data:
            usage["completion_tokens"] = data["eval_count"]
        return ChatResponse(content=message.get("content", ""),
                            tool_calls=tool_calls, usage=usage)
