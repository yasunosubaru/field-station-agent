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
import os
from dataclasses import asdict
from pathlib import Path
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


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None else value.strip()


def _load_providers_config() -> dict:
    """读 ``config/providers.json``（与 ``agents/providers`` 同一份口径）。

    仓库里本来就有这份配置（M3-0，issue #50：「换模型 / 换通道只改这个文件，
    代码零改动」）。但运行时的默认构造原先完全没读它，于是打包产物里
    谁也不知道该连哪儿。这里补上，优先级：**环境变量 > 配置文件 > 硬编码默认**。
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "config" / "providers.json"
        if candidate.is_file():
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
            providers = data.get("providers")
            return providers if isinstance(providers, dict) else {}
    return {}


def _default_runtimes() -> list[Runtime]:
    """按「环境变量 > config/providers.json > 硬编码默认」构造运行时。

    ## 为什么必须可配

    原先这里是裸的 `[OpenAICompatibleRuntime(), ClaudeRuntime()]` ——
    两个都用**硬编码默认端点**（`127.0.0.1:11434` = Ollama、`127.0.0.1:8765` = shim）。
    打包产物里没有任何东西会把真实后端地址告诉它，用户装上发一条消息就得到：

        event: error
        data: {"class":"environment","message":"连不上运行时
               http://127.0.0.1:11434/v1/chat/completions：HTTP Error 404"}

    ——「装上什么都不能用」的直接原因。

    ## ``api_model`` 为什么必须单独一项

    ``RuntimeRequest.model`` 受纪-1 约束，**对外只有 ``deepseek-v4.1-flash``**
    一个名字。但真实端点要的是带前缀的形式（commandcode 要
    ``deepseek/deepseek-v4.1-flash``，Ollama 要 ``qwen3.8-...:latest``）。
    所以拆成两层：规范名管「闸门」，``api_model`` 管「实际发什么」。
    """
    providers = _load_providers_config()
    ollama = providers.get("ollama") if isinstance(providers.get("ollama"), dict) else {}
    gateway = (providers.get("openai") if isinstance(providers.get("openai"), dict)
               else {})

    base = (_env("FSA_OPENAI_BASE_URL")
            or str(gateway.get("url") or "").strip()
            or (str(ollama.get("url") or "").rstrip("/") + "/v1"
                if ollama.get("url") else "")
            or "http://127.0.0.1:11434/v1")
    if not base.startswith("http"):
        base = "http://127.0.0.1:11434/v1"

    api_model = (_env("FSA_OPENAI_MODEL")
                 or str(gateway.get("model") or "").strip()
                 or str(ollama.get("model") or "").strip())
    api_key = _env("FSA_OPENAI_API_KEY") or str(gateway.get("api_key") or "").strip()
    proxy = (_env("FSA_HTTP_PROXY") or str(gateway.get("proxy") or "").strip()
             or _env("HTTPS_PROXY") or _env("https_proxy"))

    openai = OpenAICompatibleRuntime(
        base_url=base,
        api_key=api_key,
        api_model=api_model,
        proxy=proxy,
    )
    claude = ClaudeRuntime(
        base_url=_env("FSA_CLAUDE_BASE_URL", "http://127.0.0.1:8765"),
        api_key=_env("FSA_CLAUDE_API_KEY"),
    )
    return [openai, claude]


class RuntimeRegistry:
    """名字 → 运行时。``available()`` 只报状态，不替调用方做决定。

    原先这里是裸的 `[OpenAICompatibleRuntime(), ClaudeRuntime()]` ——
    两个都用**硬编码默认端点**（`127.0.0.1:11434` = Ollama、`127.0.0.1:8765` = shim）。
    打包产物里没有任何东西会把真实后端地址告诉它，于是用户装上之后
    发一条消息就得到：

        event: error
        data: {"class":"environment","message":"连不上运行时
               http://127.0.0.1:11434/v1/chat/completions：HTTP Error 404"}

    ——「什么都点不动」的直接原因。所以这里改成**从环境变量读**，
    并允许调用方显式传 `runtimes=[...]` 覆盖（测试与嵌入方用）。

    环境变量（都不给就退回原默认值，行为不变）：

    | 变量 | 作用 | 默认 |
    |---|---|---|
    | ``FSA_OPENAI_BASE_URL`` | OpenAI 兼容端点 | ``http://127.0.0.1:11434/v1`` |
    | ``FSA_OPENAI_API_KEY`` | 该端点的密钥 | 空 |
    | ``FSA_CLAUDE_BASE_URL`` | Claude / shim 端点 | ``http://127.0.0.1:8765`` |
    | ``FSA_CLAUDE_API_KEY`` | 该端点的密钥 | 空 |
    | ``FSA_CLAUDE_USE_SDK`` | ``1`` 用官方 Agent SDK，``0`` 走 HTTP | 见 ``ClaudeRuntime`` |
    """

    def __init__(self, runtimes: Iterable[Runtime] | None = None):
        items = list(runtimes) if runtimes is not None else _default_runtimes()
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
