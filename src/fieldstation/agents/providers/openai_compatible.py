"""OpenAICompatibleProvider：任何讲 OpenAI ``/v1/chat/completions`` 的通道。

契约见 ``docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md`` §7：

* ``POST {base_url}/v1/chat/completions``，``Authorization: Bearer <key>``；
* 支持 ``stream=true``（SSE），失败按固定错误分类返回；
* 设置里 ``provider / base_url / model / temperature`` 进 ``settings.json``，
  **key 只进 DPAPI 的 ``secrets.bin``**（``tools/secret_store.py``）。本模块
  不读 ``settings.json``、不读 ``secrets.bin``、不落盘 —— 调用方取出明文 key
  后以 ``api_key`` 传进构造器。

设计决定（非事实断言）：

* **纯标准库 ``urllib``**：CLAUDE.md §4「仓库核心无第三方依赖」对本模块同样
  适用，一个 ``/v1/chat/completions`` 不值得为它引 ``requests``/``openai``。
* **``model`` 必填**：缺了在构造时炸，不猜默认模型 —— 与 OllamaProvider 同一条
  理由，评测必须写明跑在哪个模型上。``base_url`` 同理，不替用户补默认地址。
* **``base_url`` 只去尾斜杠，不替用户补 ``/v1``**：契约写的是
  ``base_url + /v1/chat/completions``。把 ``https://host/v1`` 填进来会变成
  ``/v1/v1/...``；错误消息里带完整 URL，一次就能看出来。
* **key 不进任何消息**：``Authorization`` 头只出现在请求里；所有抛出的文本先过
  ``_scrub``，把 key 换成 ``***``。本模块不 ``print``、不写日志。
* **默认走流式**：契约要求 ``chat`` 委托 ``chat_stream(..., on_token=None)``，
  所以默认行为是 ``stream: true`` 再在本地拼完整响应。少数只认非流式的网关
  可以用 ``"stream": false`` 关掉 —— 那是显式配置，不是隐式回退。
* **流结束必须见到 ``[DONE]`` 或 ``finish_reason``**，否则按「流中断」抛
  ``ProviderError``：半截回答被当成完整回答，是比报错更贵的错误。
* **tool_call 参数必须是合法 JSON 对象**：解析不了就抛，不拿 ``{}`` 蒙混 ——
  拿空参数去执行工具，等于替模型编造了一次调用。
* ``usage`` 只在服务端给了才填（流式需要服务端支持
  ``stream_options.include_usage``，默认请求它，可用 ``stream_options: false``
  关掉）；没给就是空 dict，不补 0。

本模块只用标准库。
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Callable

from .base import ChatMessage, ChatResponse, Provider
from .ollama import ProviderError, tools_to_wire as _registry_tools_to_wire

#: 契约 §7 的端点；``base_url`` 里不要再带 ``/v1``。
CHAT_PATH = "/v1/chat/completions"

#: 默认超时（秒）。120 与契约里桌面端的手感一致：够慢模型答完，又不至于挂死。
DEFAULT_TIMEOUT_S = 120.0


def tools_to_wire(tools: list[dict]) -> list[dict]:
    """工具描述 → OpenAI function schema。

    接受两种入参：``ToolRegistry.describe()`` 的仓库口径（``name / description /
    params / risk``），以及已经是 ``{"type": "function", "function": {...}}``
    的报文口径（原样透传，方便调用方自己拼 schema）。翻译逻辑与 Ollama 通道
    共用 ``ollama.tools_to_wire``，两个通道的工具报文不会长歪。
    """
    wire: list[dict] = []
    for t in tools:
        if t.get("type") == "function" and isinstance(t.get("function"), dict):
            wire.append(t)
        else:
            wire.extend(_registry_tools_to_wire([t]))
    return wire


class OpenAICompatibleProvider(Provider):
    """接任意 OpenAI 兼容 ``/v1/chat/completions`` 服务的 provider。"""

    name = "openai_compatible"

    def __init__(self, config: dict):
        base_url = str(config.get("base_url") or "").strip()
        if not base_url:
            raise ProviderError(
                f"openai_compatible 配置缺 base_url（config keys: {sorted(config)}）"
                " —— 不猜默认地址，设置里必须写明服务地址")
        self._base_url = base_url.rstrip("/")

        self._model = str(config.get("model") or "").strip()
        if not self._model:
            raise ProviderError(
                f"openai_compatible 配置缺 model（config keys: {sorted(config)}）"
                " —— 不猜默认模型，必须写明跑在哪个模型上")

        #: key 只在内存里；空字符串表示「不带 Authorization 头」（本机免鉴权服务）。
        self._api_key = str(config.get("api_key") or "")
        self._timeout = float(config.get("timeout_s", DEFAULT_TIMEOUT_S))
        self._stream = bool(config.get("stream", True))
        self._stream_options = bool(config.get("stream_options", True))
        temperature = config.get("temperature")
        self._temperature = None if temperature is None else float(temperature)

    # ── 请求构造 ────────────────────────────────────────────────────────

    def _headers(self) -> dict:
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if self._stream else "application/json",
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _scrub(self, text: str) -> str:
        """把 key 从要抛出的文本里抹掉（服务端偶尔会把 key 回显进错误体）。"""
        if self._api_key:
            return text.replace(self._api_key, "***")
        return text

    def _payload(self, messages: list[ChatMessage], tools: list[dict],
                 stream: bool) -> dict:
        payload: dict = {
            "model": self._model,
            "messages": [{"role": m.role, "content": m.content}
                         for m in messages],
            "stream": stream,
        }
        if self._temperature is not None:
            payload["temperature"] = self._temperature
        if tools:
            payload["tools"] = tools_to_wire(tools)
        if stream and self._stream_options:
            # 不加这个，多数服务端的流式响应里没有 usage。
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _open(self, payload: dict):
        """发一次请求，返回已拿到响应头的 response；错误统一成 ProviderError。"""
        req = urllib.request.Request(
            self._base_url + CHAT_PATH,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        try:
            return urllib.request.urlopen(req, timeout=self._timeout)
        except urllib.error.HTTPError as exc:
            detail = self._error_body(exc)
            raise ProviderError(self._scrub(
                f"openai_compatible 返回 HTTP {exc.code}"
                f"（{self._base_url}，model={self._model!r}）：{detail}")) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise ProviderError(self._scrub(
                    f"openai_compatible 超时（{self._base_url}，"
                    f"model={self._model!r}，timeout={self._timeout:g}s）：{exc.reason}"
                )) from exc
            raise ProviderError(self._scrub(
                f"openai_compatible 不可达（{self._base_url}，"
                f"model={self._model!r}）：{exc.reason}")) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderError(self._scrub(
                f"openai_compatible 超时（{self._base_url}，"
                f"model={self._model!r}，timeout={self._timeout:g}s）")) from exc
        except OSError as exc:
            raise ProviderError(self._scrub(
                f"openai_compatible 连接失败（{self._base_url}，"
                f"model={self._model!r}）：{exc}")) from exc

    @staticmethod
    def _error_body(exc: urllib.error.HTTPError) -> str:
        """取 HTTP 错误体前 200 字符；读不出来就不带（错误信息本身不能丢）。"""
        try:
            raw = exc.read()
        except Exception:  # noqa: BLE001  —— 错误体读失败不该盖住状态码
            return "<响应体不可读>"
        return raw.decode("utf-8", "replace")[:200]

    # ── 响应归一 ────────────────────────────────────────────────────────

    @staticmethod
    def _usage_from(raw) -> dict:
        usage: dict = {}
        if isinstance(raw, dict):
            for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
                if raw.get(key) is not None:
                    usage[key] = raw[key]
        return usage

    @staticmethod
    def _parse_arguments(name: str, raw) -> dict:
        """tool_call 的 ``arguments`` → dict。非法就抛，不拿空 dict 顶替。"""
        if isinstance(raw, dict):
            return raw
        text = (raw or "").strip() if isinstance(raw, str) else ""
        if not text:
            return {}
        try:
            args = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                f"openai_compatible 的 tool_call 参数不是 JSON"
                f"（name={name!r}，前 120 字符：{text[:120]!r}）") from exc
        if not isinstance(args, dict):
            raise ProviderError(
                f"openai_compatible 的 tool_call 参数不是 JSON 对象"
                f"（name={name!r}，实际类型：{type(args).__name__}）")
        return args

    # ── 对外接口 ────────────────────────────────────────────────────────

    def chat(self, messages: list[ChatMessage], tools: list[dict]) -> ChatResponse:
        """一次完整调用。默认走流式再把碎片拼回来（契约 §7）。"""
        if self._stream:
            return self.chat_stream(messages, tools, on_token=None)
        return self._chat_once(messages, tools)

    def _chat_once(self, messages: list[ChatMessage],
                   tools: list[dict]) -> ChatResponse:
        """非流式路径：一次 JSON 往返。仅 ``stream: false`` 时使用。"""
        resp = self._open(self._payload(messages, tools, stream=False))
        try:
            body = resp.read().decode("utf-8", "replace")
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderError(self._scrub(
                f"openai_compatible 读取响应超时（{self._base_url}，"
                f"timeout={self._timeout:g}s）")) from exc
        except OSError as exc:
            raise ProviderError(self._scrub(
                f"openai_compatible 读取响应失败（{self._base_url}）：{exc}")) from exc
        finally:
            resp.close()

        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                f"openai_compatible 响应不是 JSON（前 120 字符：{body[:120]!r}）"
            ) from exc
        if isinstance(data, dict) and data.get("error"):
            raise ProviderError(self._scrub(
                "openai_compatible 响应内含 error："
                f"{json.dumps(data['error'], ensure_ascii=False)[:200]}"))
        choices = (data.get("choices") if isinstance(data, dict) else None) or []
        if not choices:
            raise ProviderError(
                f"openai_compatible 响应没有 choices（前 120 字符：{body[:120]!r}）")
        message = choices[0].get("message") or {}
        tool_calls = []
        for tc in message.get("tool_calls") or []:
            fn = tc.get("function") or {}
            name = fn.get("name", "")
            tool_calls.append({"name": name,
                               "args": self._parse_arguments(
                                   name, fn.get("arguments"))})
        return ChatResponse(content=message.get("content") or "",
                            tool_calls=tool_calls,
                            usage=self._usage_from(
                                data.get("usage") if isinstance(data, dict) else None))

    def chat_stream(self, messages: list[ChatMessage], tools: list[dict],
                    on_token: Callable[[str], None] | None = None) -> ChatResponse:
        """SSE 流式调用：每个 content 增量交给 ``on_token``，返回拼好的完整响应。"""
        payload = self._payload(messages, tools, stream=True)
        resp = self._open(payload)

        content_parts: list[str] = []
        #: index → {"name": str, "arguments": str}；增量按 index 合并。
        calls: dict[int, dict] = {}
        usage: dict = {}
        saw_event = False
        finished = False
        try:
            for raw_line in resp:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line:
                    continue
                if line.startswith(":"):
                    # SSE 注释/心跳（如 vLLM 的 ": ping"），跳过。
                    continue
                if not line.startswith("data:"):
                    if not saw_event:
                        raise ProviderError(self._scrub(
                            "openai_compatible 响应不是 SSE 流"
                            f"（{self._base_url}，首行：{line[:120]!r}）"))
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    finished = True
                    break
                if not data:
                    continue
                saw_event = True
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError as exc:
                    raise ProviderError(
                        "openai_compatible 流的 data 不是 JSON"
                        f"（前 120 字符：{data[:120]!r}）") from exc
                if isinstance(chunk, dict) and chunk.get("error"):
                    raise ProviderError(self._scrub(
                        "openai_compatible 流内 error："
                        f"{json.dumps(chunk['error'], ensure_ascii=False)[:200]}"))
                if not isinstance(chunk, dict):
                    raise ProviderError(
                        "openai_compatible 流的 data 不是 JSON 对象"
                        f"（前 120 字符：{data[:120]!r}）")
                self._absorb_chunk(chunk, content_parts, calls, usage, on_token)
                if self._has_finish_reason(chunk):
                    finished = True
        except ProviderError:
            raise
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderError(self._scrub(
                f"openai_compatible 流式读取超时（{self._base_url}，"
                f"timeout={self._timeout:g}s）")) from exc
        except OSError as exc:
            raise ProviderError(self._scrub(
                f"openai_compatible 流中断（{self._base_url}）：{exc}")) from exc
        finally:
            resp.close()

        if not finished:
            raise ProviderError(self._scrub(
                f"openai_compatible 流提前结束（{self._base_url}）："
                "未收到 [DONE] 或 finish_reason —— 半截回答不当作完整回答"))
        return ChatResponse(
            content="".join(content_parts),
            tool_calls=self._finalize_calls(calls),
            usage=usage,
        )

    def _absorb_chunk(self, chunk: dict, content_parts: list[str],
                      calls: dict[int, dict], usage: dict,
                      on_token: Callable[[str], None] | None) -> None:
        """吸收一个 SSE chunk：正文增量、tool_calls 增量、usage。"""
        if chunk.get("usage"):
            usage.update(self._usage_from(chunk["usage"]))
        choices = chunk.get("choices") or []
        if not choices or not isinstance(choices[0], dict):
            return
        delta = choices[0].get("delta")
        if not isinstance(delta, dict):
            return

        piece = delta.get("content")
        if piece:
            content_parts.append(piece)
            if on_token is not None:
                on_token(piece)

        for tc in delta.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            index = tc.get("index")
            if not isinstance(index, int):
                index = 0
            slot = calls.setdefault(index, {"name": "", "arguments": ""})
            fn = tc.get("function") or {}
            name = fn.get("name")
            if name:
                if name == slot["name"]:
                    # 非规范服务端把完整 name 在每块里重复发：不叠加。
                    pass
                else:
                    slot["name"] += name
            arguments = fn.get("arguments")
            if arguments:
                slot["arguments"] += (arguments if isinstance(arguments, str)
                                      else json.dumps(arguments,
                                                      ensure_ascii=False))

    @staticmethod
    def _has_finish_reason(chunk: dict) -> bool:
        choices = chunk.get("choices") or []
        return bool(choices) and isinstance(choices[0], dict) \
            and choices[0].get("finish_reason") is not None

    def _finalize_calls(self, calls: dict[int, dict]) -> list[dict]:
        """按 index 顺序把增量 tool_calls 变成 ``{name, args}``。"""
        result: list[dict] = []
        for index in sorted(calls):
            slot = calls[index]
            name = slot.get("name", "")
            result.append({"name": name,
                           "args": self._parse_arguments(
                               name, slot.get("arguments"))})
        return result
