#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Anthropic Messages → OpenAI Chat Completions 代理（给 Claude SDK 接本地模型用）。

Claude 的 SDK / CLI 只会说 Anthropic Messages（``POST /v1/messages``），而本地
Ollama、llama.cpp、vLLM 这些服务说的是 OpenAI ``/chat/completions``。本脚本在
中间做一层**无状态**翻译，让 SDK 直接指过来：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8765 python your_claude_sdk_script.py
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | ``/v1/messages`` | Anthropic 请求 → OpenAI 请求 → Anthropic 响应 |
| GET | ``/health`` | ``{"ok": true, "upstream": ..., "dry_run": ...}``，只报配置，不探测上游 |

## 映射口径

* ``system``（字符串或 text 块数组）→ 首条 ``role=system`` 消息。
* ``messages[]`` 的 text 块按顺序以换行拼接；``tool_use`` → assistant 的
  ``tool_calls``；``tool_result`` → ``role=tool`` 消息，且**排在**同一轮 user
  文本之前（OpenAI 要求 tool 消息紧跟 assistant 的 tool_calls）。
* 图片 / 文档 / thinking 块**不转发**，只记一条日志 —— 日志里只出现 blob 的
  类型与 media_type，绝不出现 base64 内容。
* ``tools[].input_schema`` → ``tools[].function.parameters``；
  ``tool_choice`` 的 ``auto / any / tool / none`` → ``auto / required /
  {"type":"function",...} / none``。
* ``stop_reason``：``length`` → ``max_tokens``；有 tool_calls → ``tool_use``；
  其余 → ``end_turn``。``length`` 优先于 ``tool_use``（截断要显式暴露）。
* 流式：上游 SSE 的 ``delta.content`` → ``text_delta``；``tool_calls`` 参数增量
  → ``input_json_delta``（原样片段，SDK 自己拼）。文本与工具块按出现顺序开块、
  关块，保证 ``content_block_start/delta/stop`` 不会被交错；真的交错到达的迟到
  增量会被丢弃并记日志（宁可少一段参数，也不发出非法事件序列）。

## 设计决定（非事实断言）

* **纯标准库**：本仓库核心无第三方依赖，这层代理同样不引 ``aiohttp``。
* **只监听 ``127.0.0.1``**：代理握着上游 key（若配了），默认不外露。
* **未知字段忽略并记日志**，缺 ``model`` / ``messages`` 回 400 —— 静默丢弃
  请求字段会让「配置没生效」表现成「模型不听话」，比报错更难查。
* **上游 HTTP 状态码原样保留**（500 → 500、429 → 429），只把错误体换成
  Anthropic 的 ``{"type":"error","error":{...}}`` 形状；只有「连不上」这种
  没有状态码的情况才用 502。
* **``--dry-run`` 不建上游连接**：返回固定结构的假响应，方便离线跑通 SDK 的
  解析与重试逻辑。默认只打印监听地址后退出（验收用自检）；要真挂在端口上
  演练，加 ``--serve``。
* **日志不打印 API key**：key 只出现在 ``Authorization`` 头里；所有要落日志或
  回给客户端的错误文本先过 ``_scrub``。

## 用法

```bash
python tools/anthropic_shim.py                        # 127.0.0.1:8765 → $OPENAI_BASE_URL
python tools/anthropic_shim.py --upstream http://127.0.0.1:11434/v1
python tools/anthropic_shim.py --dry-run --port 0     # 自检：打印地址后退出
python tools/anthropic_shim.py --dry-run --serve      # 离线演练：真的挂起服务
```

上游地址取 ``--upstream``，其次环境变量 ``OPENAI_BASE_URL``，最后
``http://127.0.0.1:11434/v1``。key 只从 ``OPENAI_API_KEY`` 读（不上命令行，
避免进进程列表）。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Iterator

LOG = logging.getLogger("anthropic_shim")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_UPSTREAM = "http://127.0.0.1:11434/v1"
DEFAULT_TIMEOUT_S = 120.0
MAX_BODY_BYTES = 8 * 1024 * 1024
#: 错误文本回显上限：上游错误体可能很长，截断后仍然能定位问题。
MAX_ERROR_CHARS = 300

#: Anthropic 请求里本代理认识的顶层字段。其余字段记日志后忽略。
KNOWN_REQUEST_FIELDS = frozenset({
    "model", "messages", "system", "max_tokens", "temperature", "top_p",
    "top_k", "stop_sequences", "stream", "tools", "tool_choice", "metadata",
    "thinking", "betas", "anthropic_version", "anthropic_beta", "service_tier",
    "container", "context_management", "mcp_servers",
})
#: 认识、但 OpenAI 报文没有对应位置的字段：记一条日志再丢。
UNSUPPORTED_REQUEST_FIELDS = frozenset({
    "top_k", "metadata", "thinking", "betas", "anthropic_version",
    "anthropic_beta", "service_tier", "container", "context_management",
    "mcp_servers",
})


def _default_warn(message: str) -> None:
    LOG.warning("%s", message)


_ERROR_TYPE_BY_STATUS = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    422: "invalid_request_error",
    429: "rate_limit_error",
    500: "api_error",
    502: "api_error",
    503: "api_error",
    529: "overloaded_error",
}


# --------------------------------------------------------------------------
# 错误
# --------------------------------------------------------------------------

class ShimError(Exception):
    """带 HTTP 状态与 Anthropic 错误类型的失败。"""

    def __init__(self, status: int, message: str,
                 error_type: str | None = None) -> None:
        super().__init__(message)
        self.status = int(status)
        self.message = message
        self.error_type = error_type or error_type_for_status(self.status)


class UpstreamUnreachable(Exception):
    """上游连不上（没有 HTTP 状态码可保留）。"""


def error_type_for_status(status: int) -> str:
    """HTTP 状态 → Anthropic 错误 ``type``。"""
    if status in _ERROR_TYPE_BY_STATUS:
        return _ERROR_TYPE_BY_STATUS[status]
    return "api_error" if status >= 500 else "invalid_request_error"


def anthropic_error(status: int, message: str,
                    error_type: str | None = None) -> dict:
    """Anthropic 风格错误体。"""
    return {
        "type": "error",
        "error": {
            "type": error_type or error_type_for_status(status),
            "message": message,
        },
    }


def _warn(warn: Callable[[str], None] | None, message: str) -> None:
    (warn or _default_warn)(message)


def _as_int(value) -> int:
    """usage 字段归一：bool / None / 字符串都不是有效计数。"""
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _decode(raw) -> str:
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw).decode("utf-8", "replace")
    if isinstance(raw, str):
        return raw
    return ""


def display_url(url: str) -> str:
    """打印用 URL：把 ``user:pass@`` 抹掉，路径与查询串保持原样。"""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    if not (parts.username or parts.password):
        return url
    netloc = parts.hostname or ""
    if parts.port:
        netloc += ":%d" % parts.port
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment))


# --------------------------------------------------------------------------
# 请求映射：Anthropic → OpenAI
# --------------------------------------------------------------------------

def build_upstream_request(body, warn: Callable[[str], None] | None = None):
    """把 Anthropic Messages 请求体翻成 OpenAI Chat Completions 请求体。

    返回 ``(payload, model)``。``warn`` 收到「被忽略的字段 / 内容块」的中文说明；
    缺 ``model`` 或 ``messages`` 抛 :class:`ShimError` 400。
    """
    if not isinstance(body, dict):
        raise ShimError(400, "请求体必须是 JSON 对象")

    for key in sorted(set(body) - KNOWN_REQUEST_FIELDS):
        _warn(warn, "忽略未知请求字段 %r" % key)
    for key in sorted(set(body) & UNSUPPORTED_REQUEST_FIELDS):
        _warn(warn, "请求字段 %r 在 OpenAI 通道没有对应位置，已忽略" % key)

    model = body.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ShimError(400, "缺 model（必填，非空字符串）")

    raw_messages = body.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        raise ShimError(400, "缺 messages（必填，非空数组）")

    messages: list = []
    for position, message in enumerate(raw_messages):
        if not isinstance(message, dict):
            raise ShimError(400, "messages[%d] 不是对象" % position)
        _append_openai_message(message, "messages[%d]" % position, messages, warn)

    if not messages:
        raise ShimError(
            400, "messages 里没有可转发的内容（图片 / 文档块会被忽略）")

    payload: dict = {
        "model": model.strip(),
        "messages": messages,
        "stream": bool(body.get("stream", False)),
    }

    max_tokens = body.get("max_tokens")
    if max_tokens is not None:
        if (isinstance(max_tokens, bool) or not isinstance(max_tokens, int)
                or max_tokens <= 0):
            raise ShimError(400, "max_tokens 必须是正整数")
        payload["max_tokens"] = max_tokens

    for key in ("temperature", "top_p"):
        value = body.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ShimError(400, "%s 必须是数字" % key)
        payload[key] = float(value)

    stop = body.get("stop_sequences")
    if stop is not None:
        if not isinstance(stop, list) or not all(
                isinstance(item, str) for item in stop):
            raise ShimError(400, "stop_sequences 必须是字符串数组")
        if stop:
            payload["stop"] = list(stop)

    tools = body.get("tools")
    if tools is not None:
        if not isinstance(tools, list):
            raise ShimError(400, "tools 必须是数组")
        converted = _convert_tools(tools, warn)
        if converted:
            payload["tools"] = converted
            choice = _convert_tool_choice(body.get("tool_choice"), warn)
            if choice is not None:
                payload["tool_choice"] = choice
        elif body.get("tool_choice") is not None:
            _warn(warn, "tools 为空，tool_choice 已忽略")

    if payload["stream"]:
        # 多数 OpenAI 兼容服务端默认不在流里给 usage；要了才有 output_tokens。
        payload["stream_options"] = {"include_usage": True}

    system = _convert_system(body.get("system"), warn)
    if system:
        messages.insert(0, {"role": "system", "content": system})

    return payload, payload["model"]


def _convert_system(system, warn: Callable[[str], None] | None) -> str:
    if system is None:
        return ""
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        parts: list[str] = []
        for index, block in enumerate(system):
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
            else:
                _warn(warn, "system[%d] 不是 text 块，已忽略" % index)
        return "\n".join(parts)
    _warn(warn, "system 既不是字符串也不是块数组，已忽略")
    return ""


def _append_openai_message(message: dict, where: str, out: list,
                           warn: Callable[[str], None] | None) -> None:
    role = message.get("role")
    if role not in ("user", "assistant"):
        raise ShimError(
            400, "%s.role 非法：%r（只支持 user / assistant）" % (where, role))

    content = message.get("content")
    if isinstance(content, str):
        out.append({"role": role, "content": content})
        return
    if not isinstance(content, list):
        raise ShimError(400, "%s.content 必须是字符串或内容块数组" % where)

    texts: list[str] = []
    tool_calls: list = []
    tool_results: list = []
    for block_index, block in enumerate(content):
        block_where = "%s.content[%d]" % (where, block_index)
        if not isinstance(block, dict):
            _warn(warn, "%s 不是对象，已忽略" % block_where)
            continue
        block_type = block.get("type")
        if block_type == "text":
            text = block.get("text")
            if isinstance(text, str) and text:
                texts.append(text)
        elif block_type == "tool_use":
            if role != "assistant":
                _warn(warn, "%s 的 tool_use 出现在 %s 消息里，"
                            "仍按 assistant 工具调用转写" % (block_where, role))
            tool_calls.append(_convert_tool_use(block, block_where, warn))
        elif block_type == "tool_result":
            if role != "user":
                _warn(warn, "%s 的 tool_result 出现在 assistant 消息里，"
                            "仍按 tool 消息转写" % block_where)
            converted = _convert_tool_result(block, block_where, warn)
            if converted is not None:
                tool_results.append(converted)
        elif block_type == "image":
            _warn_image(warn, block_where, block)
        elif block_type == "document":
            _warn(warn, "%s 忽略 document 内容块：本代理不转文档" % block_where)
        elif block_type == "thinking":
            _warn(warn, "%s 忽略 thinking 内容块" % block_where)
        else:
            _warn(warn, "%s 忽略未知内容块类型 %r" % (block_where, block_type))

    text = "\n".join(texts)
    # tool 消息必须紧跟在 assistant 的 tool_calls 之后、user 文本之前。
    out.extend(tool_results)

    if role == "assistant":
        if not text and not tool_calls:
            _warn(warn, "%s 没有可转写的内容，已跳过" % where)
            return
        converted = {"role": "assistant", "content": text if text else None}
        if tool_calls:
            converted["tool_calls"] = tool_calls
        out.append(converted)
    else:
        if text:
            out.append({"role": "user", "content": text})
        elif not tool_results:
            _warn(warn, "%s 没有可转写的内容，已跳过" % where)


def _convert_tool_use(block: dict, where: str,
                      warn: Callable[[str], None] | None) -> dict:
    name = block.get("name")
    if not isinstance(name, str) or not name:
        raise ShimError(400, "%s 的 tool_use 缺 name" % where)
    call_id = block.get("id")
    if not isinstance(call_id, str) or not call_id:
        call_id = "call_" + uuid.uuid4().hex[:24]
        _warn(warn, "%s 的 tool_use 缺 id，生成 %s" % (where, call_id))
    arguments = block.get("input")
    if not isinstance(arguments, dict):
        _warn(warn, "%s 的 tool_use.input 不是对象，按空对象处理" % where)
        arguments = {}
    for key in sorted(set(block) - {"type", "id", "name", "input"}):
        _warn(warn, "%s 的 tool_use 忽略未知字段 %r" % (where, key))
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, ensure_ascii=False),
        },
    }


def _convert_tool_result(block: dict, where: str,
                         warn: Callable[[str], None] | None):
    tool_use_id = block.get("tool_use_id")
    if not isinstance(tool_use_id, str) or not tool_use_id:
        _warn(warn, "%s 的 tool_result 缺 tool_use_id，无法对应 tool_call，"
                    "已忽略" % where)
        return None
    text = _flatten_tool_result(block.get("content"), where, warn)
    if block.get("is_error"):
        _warn(warn, "%s 的 tool_result 标记 is_error=true；OpenAI 消息没有"
                    "对应字段，原文保留" % where)
    return {"role": "tool", "tool_call_id": tool_use_id, "content": text}


def _flatten_tool_result(content, where: str,
                         warn: Callable[[str], None] | None) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for index, block in enumerate(content):
            if not isinstance(block, dict):
                _warn(warn, "%s.content[%d] 不是对象，已忽略" % (where, index))
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif block_type == "image":
                _warn_image(warn, "%s.content[%d]" % (where, index), block)
            else:
                _warn(warn, "%s.content[%d] 忽略未知块类型 %r"
                            % (where, index, block_type))
        return "\n".join(parts)
    _warn(warn, "%s 的 tool_result.content 是 %s，按 JSON 字符串处理"
                % (where, type(content).__name__))
    return json.dumps(content, ensure_ascii=False)


def _warn_image(warn: Callable[[str], None] | None, where: str,
                block: dict) -> None:
    source = block.get("source")
    if not isinstance(source, dict):
        source = {}
    # 只记 media_type / source 类型，绝不记 base64 或 URL（可能带签名）。
    detail = source.get("media_type") or source.get("type") or "?"
    _warn(warn, "%s 忽略 image 内容块（media_type=%s）：本代理不转图片"
                % (where, detail))


def _convert_tools(tools: list,
                   warn: Callable[[str], None] | None) -> list:
    converted: list = []
    for index, tool in enumerate(tools):
        if not isinstance(tool, dict):
            _warn(warn, "tools[%d] 不是对象，已忽略" % index)
            continue
        name = tool.get("name")
        if not isinstance(name, str) or not name:
            raise ShimError(400, "tools[%d] 缺 name" % index)
        schema = tool.get("input_schema")
        if not isinstance(schema, dict):
            _warn(warn, "tools[%d] 缺 input_schema，按空对象处理" % index)
            schema = {"type": "object", "properties": {}}
        function = {"name": name, "parameters": schema}
        description = tool.get("description")
        if isinstance(description, str) and description:
            function["description"] = description
        for key in sorted(set(tool) - {"name", "description", "input_schema"}):
            _warn(warn, "tools[%d] 忽略未知字段 %r" % (index, key))
        converted.append({"type": "function", "function": function})
    return converted


def _convert_tool_choice(choice, warn: Callable[[str], None] | None):
    if choice is None:
        return None
    if isinstance(choice, str):
        if choice in ("auto", "none", "required"):
            return choice
        _warn(warn, "未知 tool_choice %r，已忽略" % choice)
        return None
    if not isinstance(choice, dict):
        _warn(warn, "tool_choice 不是对象，已忽略")
        return None
    kind = choice.get("type")
    if kind == "auto":
        return "auto"
    if kind == "any":
        return "required"
    if kind == "none":
        return "none"
    if kind == "tool":
        name = choice.get("name")
        if not isinstance(name, str) or not name:
            raise ShimError(400, "tool_choice.type=tool 缺 name")
        return {"type": "function", "function": {"name": name}}
    _warn(warn, "未知 tool_choice.type=%r，已忽略" % kind)
    return None


# --------------------------------------------------------------------------
# 响应映射：OpenAI → Anthropic（非流式）
# --------------------------------------------------------------------------

def message_id_from(raw) -> str:
    """上游 id → Anthropic 形状的 message id（``msg_`` 前缀，字符集合收敛）。"""
    clean = re.sub(r"[^A-Za-z0-9_-]", "", str(raw or ""))[:64]
    return "msg_" + (clean or uuid.uuid4().hex[:24])


def map_stop_reason(finish_reason, has_tool_calls: bool,
                    warn: Callable[[str], None] | None = None) -> str:
    """OpenAI ``finish_reason`` → Anthropic ``stop_reason``。

    ``length`` 优先：即使同时带着 tool_calls，被截断这件事也要先暴露，
    否则调用方会把半截参数当完整工具调用执行。
    """
    if finish_reason == "length":
        return "max_tokens"
    if finish_reason in ("tool_calls", "function_call") or has_tool_calls:
        return "tool_use"
    if finish_reason in (None, "stop", "end_turn"):
        return "end_turn"
    _warn(warn, "未识别的 finish_reason=%r，按 end_turn 处理" % finish_reason)
    return "end_turn"


def to_anthropic_response(data, *, model: str,
                          warn: Callable[[str], None] | None = None) -> dict:
    """OpenAI 非流式响应 → Anthropic Message 对象。"""
    if not isinstance(data, dict):
        raise ShimError(502, "上游响应不是 JSON 对象")
    if data.get("error"):
        raise ShimError(502, "上游响应内含 error：%s"
                        % json.dumps(data["error"], ensure_ascii=False)
                        [:MAX_ERROR_CHARS])

    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ShimError(502, "上游响应没有 choices")
    choice = choices[0] if isinstance(choices[0], dict) else {}
    message = choice.get("message")
    if not isinstance(message, dict):
        message = {}

    content: list = []
    text = _flatten_openai_content(message.get("content"))
    if text:
        content.append({"type": "text", "text": text})

    tool_calls = message.get("tool_calls")
    if tool_calls is not None and not isinstance(tool_calls, list):
        _warn(warn, "上游 message.tool_calls 不是数组，已忽略")
        tool_calls = []
    for index, call in enumerate(tool_calls or []):
        if not isinstance(call, dict):
            _warn(warn, "上游 tool_calls[%d] 不是对象，已忽略" % index)
            continue
        function = call.get("function")
        if not isinstance(function, dict):
            function = {}
        name = function.get("name")
        if not isinstance(name, str):
            name = ""
        call_id = call.get("id")
        if not isinstance(call_id, str) or not call_id:
            call_id = "toolu_" + uuid.uuid4().hex[:24]
            _warn(warn, "上游 tool_calls[%d] 缺 id，生成 %s" % (index, call_id))
        content.append({
            "type": "tool_use",
            "id": call_id,
            "name": name,
            "input": _parse_arguments(function.get("arguments"), warn),
        })

    if not content:
        _warn(warn, "上游响应既没有文本也没有工具调用，返回空文本块")
        content.append({"type": "text", "text": ""})

    has_tool_use = any(isinstance(block, dict)
                       and block.get("type") == "tool_use"
                       for block in content)
    usage = data.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    return {
        "id": message_id_from(data.get("id")),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": map_stop_reason(choice.get("finish_reason"),
                                       has_tool_use, warn),
        "stop_sequence": None,
        "usage": {
            "input_tokens": _as_int(usage.get("prompt_tokens")),
            "output_tokens": _as_int(usage.get("completion_tokens")),
        },
    }


def _flatten_openai_content(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for part in value:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    return ""


def _parse_arguments(raw, warn: Callable[[str], None] | None) -> dict:
    """tool_calls 的 arguments → dict；非法就告警并按 ``{}``，不让整轮崩掉。"""
    if isinstance(raw, dict):
        return raw
    text = raw.strip() if isinstance(raw, str) else ""
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        _warn(warn, "工具参数不是合法 JSON（%d 字符），按空对象处理" % len(text))
        return {}
    if not isinstance(value, dict):
        _warn(warn, "工具参数不是 JSON 对象（实际 %s），按空对象处理"
                    % type(value).__name__)
        return {}
    return value


# --------------------------------------------------------------------------
# 响应映射：流式
# --------------------------------------------------------------------------

class StreamTranslator:
    """OpenAI SSE chunk → Anthropic SSE 事件。

    ``feed`` 只吸收一个 chunk 并返回要发的事件；``start`` / ``finish`` 分别负责
    开场与收尾。这样服务端可以在读到第一个 chunk 之前就把 ``message_start``
    发出去（SDK 需要尽快看到消息 id）。
    """

    def __init__(self, *, model: str, message_id: str,
                 warn: Callable[[str], None] | None = None) -> None:
        self.model = model
        self.message_id = message_id
        self._warn = warn
        self._next_index = 0
        self._current: dict | None = None
        #: OpenAI tool_call index → {id, name, started, block, buffer}
        self._tools: dict[int, dict] = {}
        self._finish_reason = None
        self._usage: dict = {}
        self._saw_tool = False
        self._closed = False

    # ── 对外 ────────────────────────────────────────────────────────────

    def start(self) -> list:
        return [{
            "type": "message_start",
            "message": {
                "id": self.message_id,
                "type": "message",
                "role": "assistant",
                "model": self.model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        }]

    def feed(self, chunk: dict) -> list:
        if not isinstance(chunk, dict):
            return []
        events: list = []
        usage = chunk.get("usage")
        if isinstance(usage, dict):
            self._usage.update(usage)

        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            return events
        choice = choices[0] if isinstance(choices[0], dict) else {}
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            delta = {}

        text = _flatten_openai_content(delta.get("content"))
        if text:
            events.extend(self._open_text_block())
            events.append({
                "type": "content_block_delta",
                "index": self._current["index"],
                "delta": {"type": "text_delta", "text": text},
            })

        for call in delta.get("tool_calls") or []:
            if isinstance(call, dict):
                events.extend(self._absorb_tool_delta(call))

        if choice.get("finish_reason") is not None:
            self._finish_reason = choice.get("finish_reason")
        return events

    def finish(self) -> list:
        if self._closed:
            return []
        self._closed = True
        events: list = []
        # 首块没有 name 的工具有可能把参数一直攒着，收尾时一并补发。
        for index in sorted(self._tools):
            slot = self._tools[index]
            if slot["started"]:
                continue
            _warn(self._warn, "工具调用 %d 到流结束都没有 name，仍按空 name 开块"
                              % index)
            events.extend(self._start_tool_block(slot))
            if slot["buffer"]:
                events.append(self._json_delta(slot, slot["buffer"]))
                slot["buffer"] = ""
        events.extend(self._close_current_block())

        usage = {"output_tokens": _as_int(self._usage.get("completion_tokens"))}
        if self._usage.get("prompt_tokens") is not None:
            usage["input_tokens"] = _as_int(self._usage.get("prompt_tokens"))
        events.append({
            "type": "message_delta",
            "delta": {
                "stop_reason": map_stop_reason(self._finish_reason,
                                               self._saw_tool, self._warn),
                "stop_sequence": None,
            },
            "usage": usage,
        })
        events.append({"type": "message_stop"})
        return events

    # ── 块状态机 ────────────────────────────────────────────────────────

    def _open_text_block(self) -> list:
        if self._current is not None and self._current["kind"] == "text":
            return []
        events = self._close_current_block()
        index = self._next_index
        self._next_index += 1
        events.append({
            "type": "content_block_start",
            "index": index,
            "content_block": {"type": "text", "text": ""},
        })
        self._current = {"kind": "text", "index": index}
        return events

    def _absorb_tool_delta(self, call: dict) -> list:
        raw_index = call.get("index")
        index = raw_index if isinstance(raw_index, int) else 0
        slot = self._tools.get(index)
        if slot is None:
            slot = {"id": "", "name": "", "started": False,
                    "block": None, "buffer": ""}
            self._tools[index] = slot

        call_id = call.get("id")
        if isinstance(call_id, str) and call_id and not slot["id"]:
            slot["id"] = call_id

        function = call.get("function")
        if not isinstance(function, dict):
            function = {}
        name = function.get("name")
        if isinstance(name, str) and name:
            if slot["started"]:
                _warn(self._warn, "工具调用 %d 的 name 在开块后再次出现，"
                                  "忽略该增量" % index)
            elif not slot["name"]:
                slot["name"] = name

        arguments = function.get("arguments")
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments, ensure_ascii=False)
        if not isinstance(arguments, str):
            arguments = ""

        events: list = []
        if not slot["started"]:
            slot["buffer"] += arguments
            if not slot["name"]:
                # 还不知道工具名，参数先攒着；收到 name 的那一刻补发。
                return events
            events.extend(self._start_tool_block(slot))
            if slot["buffer"]:
                events.append(self._json_delta(slot, slot["buffer"]))
                slot["buffer"] = ""
            return events

        if arguments:
            # 块已经关掉之后才到的增量不能硬塞：Anthropic 的事件序列要求
            # content_block_delta 落在开/关之间，否则 SDK 会整条流报错。
            if (self._current is None
                    or self._current.get("kind") != "tool"
                    or self._current.get("index") != slot["block"]):
                _warn(self._warn,
                      "工具调用 %d 的参数增量在块关闭后到达，已丢弃" % index)
                return events
            events.append(self._json_delta(slot, arguments))
        return events

    def _start_tool_block(self, slot: dict) -> list:
        events = self._close_current_block()
        index = self._next_index
        self._next_index += 1
        tool_id = slot["id"] or ("toolu_" + uuid.uuid4().hex[:24])
        events.append({
            "type": "content_block_start",
            "index": index,
            "content_block": {
                "type": "tool_use",
                "id": tool_id,
                "name": slot["name"],
                "input": {},
            },
        })
        slot["started"] = True
        slot["block"] = index
        self._saw_tool = True
        self._current = {"kind": "tool", "index": index}
        return events

    def _json_delta(self, slot: dict, partial: str) -> dict:
        return {
            "type": "content_block_delta",
            "index": slot["block"],
            "delta": {"type": "input_json_delta", "partial_json": partial},
        }

    def _close_current_block(self) -> list:
        if self._current is None:
            return []
        index = self._current["index"]
        self._current = None
        return [{"type": "content_block_stop", "index": index}]


def iter_openai_chunks(lines: Iterator) -> Iterator[dict]:
    """上游 SSE 行 → chunk 字典。``[DONE]`` 结束；坏帧抛 502。"""
    saw_event = False
    for raw in lines:
        line = raw.decode("utf-8", "replace") if isinstance(
            raw, (bytes, bytearray)) else str(raw)
        line = line.strip()
        if not line or line.startswith(":"):
            continue
        if line.startswith(("event:", "id:", "retry:")):
            # 标准 SSE 的元数据行；OpenAI 通道不用，但别把它当成坏帧。
            continue
        if not line.startswith("data:"):
            if not saw_event:
                raise ShimError(502, "上游不是 SSE 流（首行：%r）" % line[:80])
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            return
        if not data:
            continue
        saw_event = True
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError as exc:
            raise ShimError(502, "上游 SSE 的 data 不是合法 JSON") from exc
        if not isinstance(chunk, dict):
            raise ShimError(502, "上游 SSE 的 data 不是 JSON 对象")
        if chunk.get("error"):
            raise ShimError(502, "上游流内返回 error：%s"
                            % json.dumps(chunk["error"], ensure_ascii=False)
                            [:MAX_ERROR_CHARS])
        yield chunk


def _ensure_line_iterable(raw):
    """把 bytes / str 兜底成按行迭代；正常情况下上游给的就是行迭代器。"""
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw).splitlines(keepends=True)
    if isinstance(raw, str):
        return [line.encode("utf-8")
                for line in raw.splitlines(keepends=True)]
    return raw


def render_sse(event: dict) -> bytes:
    """一个 Anthropic SSE 帧（``event:`` + ``data:`` + 空行）。"""
    event_type = event.get("type", "message")
    payload = json.dumps(event, ensure_ascii=False)
    return ("event: %s\ndata: %s\n\n" % (event_type, payload)).encode("utf-8")


# --------------------------------------------------------------------------
# 传输层：默认走 urllib；测试注入假 transport；dry-run 不建连接
# --------------------------------------------------------------------------

class HttpTransport:
    """对 ``{upstream}/chat/completions`` 的一次 POST。"""

    def __init__(self, base_url: str, api_key: str = "",
                 timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.base_url = str(base_url).rstrip("/")
        self._api_key = api_key
        self.timeout = float(timeout)

    @property
    def chat_url(self) -> str:
        return self.base_url + "/chat/completions"

    def _headers(self, stream: bool) -> dict:
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
        }
        if self._api_key:
            headers["Authorization"] = "Bearer " + self._api_key
        return headers

    def post(self, payload: dict, stream: bool):
        """返回 ``(status, body)``；流式成功时 ``body`` 是行迭代器。

        上游 HTTP 错误也按 ``(status, bytes)`` 返回，让调用方保留状态码；
        连不上才抛 :class:`UpstreamUnreachable`。
        """
        request = urllib.request.Request(
            self.chat_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=self._headers(stream),
            method="POST",
        )
        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read()
            except Exception:  # noqa: BLE001 —— 读不到错误体不该盖住状态码
                body = b""
            finally:
                exc.close()
            return int(exc.code), body
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise UpstreamUnreachable("%s：%s" % (self.chat_url, reason)) from exc

        if stream:
            return 200, _iter_response_lines(response)
        try:
            return 200, response.read()
        finally:
            response.close()


def _iter_response_lines(response) -> Iterator[bytes]:
    try:
        for line in response:
            yield line
    finally:
        response.close()


#: dry-run 的固定文案；用例断言它、用户也一眼能认出没走真模型。
DRY_RUN_TEXT = "[dry-run] 未转发上游：收到 {messages} 条消息、{tools} 个工具定义。"


class DryRunTransport:
    """不建任何连接的假上游：固定文本、固定 usage、固定 chunk 序列。"""

    def __init__(self) -> None:
        self.calls: list = []

    def post(self, payload: dict, stream: bool):
        self.calls.append({"stream": bool(stream)})
        text = DRY_RUN_TEXT.format(
            messages=len(payload.get("messages") or []),
            tools=len(payload.get("tools") or []))
        completion = {
            "id": "chatcmpl-dryrun",
            "object": "chat.completion",
            "created": 0,
            "model": payload.get("model"),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0,
                      "total_tokens": 0},
        }
        if not stream:
            return 200, json.dumps(completion, ensure_ascii=False).encode("utf-8")

        base = {"id": "chatcmpl-dryrun", "object": "chat.completion.chunk",
                "created": 0, "model": payload.get("model")}
        chunks = [
            dict(base, choices=[{"index": 0, "finish_reason": None,
                                 "delta": {"role": "assistant",
                                           "content": ""}}]),
            dict(base, choices=[{"index": 0, "finish_reason": None,
                                 "delta": {"content": text}}]),
            dict(base, choices=[{"index": 0, "finish_reason": "stop",
                                 "delta": {}}]),
            dict(base, choices=[], usage={"prompt_tokens": 0,
                                          "completion_tokens": 0,
                                          "total_tokens": 0}),
        ]
        lines = [("data: %s\n\n" % json.dumps(chunk, ensure_ascii=False))
                 .encode("utf-8") for chunk in chunks]
        lines.append(b"data: [DONE]\n\n")
        return 200, lines


# --------------------------------------------------------------------------
# 代理主体
# --------------------------------------------------------------------------

@dataclass
class Response:
    """一次 ``/v1/messages`` 的结果：要么 JSON，要么事件流。"""

    status: int
    body: dict | None = None
    events: Iterator[dict] | None = None

    @property
    def is_stream(self) -> bool:
        return self.events is not None


class Shim:
    """请求翻译 + 上游调用 + 错误归一。"""

    def __init__(self, upstream: str = DEFAULT_UPSTREAM, *,
                 dry_run: bool = False, api_key: str = "",
                 timeout: float = DEFAULT_TIMEOUT_S,
                 log: Callable[[str, str], None] | None = None,
                 transport=None) -> None:
        self.upstream = str(upstream or DEFAULT_UPSTREAM)
        self.dry_run = bool(dry_run)
        self._api_key = api_key or ""
        self._log = log or _default_log
        if transport is not None:
            self.transport = transport
        elif self.dry_run:
            self.transport = DryRunTransport()
        else:
            self.transport = HttpTransport(self.upstream, api_key=self._api_key,
                                           timeout=timeout)

    # ── 小工具 ──────────────────────────────────────────────────────────

    def _warn(self, message: str) -> None:
        self._log("warning", message)

    def _info(self, message: str) -> None:
        self._log("info", message)

    def _scrub(self, text: str) -> str:
        """把 key 从错误文本里抹掉（上游偶尔会把 Authorization 回显进错误体）。"""
        if self._api_key:
            return text.replace(self._api_key, "***")
        return text

    def health(self) -> dict:
        return {
            "ok": True,
            "upstream": display_url(self.upstream),
            "dry_run": self.dry_run,
        }

    # ── 入口 ────────────────────────────────────────────────────────────

    def respond(self, body) -> Response:
        try:
            payload, model = build_upstream_request(body, warn=self._warn)
        except ShimError as exc:
            return Response(exc.status, body=anthropic_error(
                exc.status, self._scrub(exc.message), exc.error_type))

        stream = bool(payload.get("stream"))
        self._info("/v1/messages model=%s messages=%d tools=%d stream=%s"
                   % (model, len(payload["messages"]),
                      len(payload.get("tools") or []), stream))

        if not stream:
            return self._respond_once(payload, model)

        try:
            status, raw = self.transport.post(payload, stream=True)
        except UpstreamUnreachable as exc:
            return self._unreachable(exc)
        status = int(status)
        if status != 200:
            return self._upstream_error(status, raw)

        translator = StreamTranslator(model=model,
                                      message_id=message_id_from(None),
                                      warn=self._warn)
        return Response(200, events=self._event_stream(translator, raw))

    def _respond_once(self, payload: dict, model: str) -> Response:
        try:
            status, raw = self.transport.post(payload, stream=False)
        except UpstreamUnreachable as exc:
            return self._unreachable(exc)
        status = int(status)
        if status < 200 or status >= 300:
            return self._upstream_error(status, raw)

        try:
            data = json.loads(_decode(raw))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return Response(502, body=anthropic_error(
                502, "上游响应不是 JSON"))
        if isinstance(data, dict) and data.get("error"):
            return self._upstream_error(502, raw)
        try:
            message = to_anthropic_response(data, model=model,
                                            warn=self._warn)
        except ShimError as exc:
            return Response(exc.status, body=anthropic_error(
                exc.status, self._scrub(exc.message), exc.error_type))
        return Response(200, body=message)

    def _event_stream(self, translator: StreamTranslator,
                      raw) -> Iterator[dict]:
        for event in translator.start():
            yield event
        try:
            for chunk in iter_openai_chunks(_ensure_line_iterable(raw)):
                for event in translator.feed(chunk):
                    yield event
            for event in translator.finish():
                yield event
        except ShimError as exc:
            self._warn("流式翻译中断：%s" % exc.message)
            yield {"type": "error",
                   "error": {"type": exc.error_type,
                             "message": self._scrub(exc.message)}}
        except Exception as exc:  # noqa: BLE001 —— 半个流不能把连接挂死
            self._warn("流式翻译异常：%s: %s"
                       % (type(exc).__name__, self._scrub(str(exc))))
            yield {"type": "error",
                   "error": {"type": "api_error",
                             "message": "流式翻译失败：%s"
                                        % type(exc).__name__}}

    # ── 错误归一 ────────────────────────────────────────────────────────

    def _unreachable(self, exc: Exception) -> Response:
        message = self._scrub("上游不可达（%s）：%s"
                              % (display_url(self.upstream), exc))
        return Response(502, body=anthropic_error(502, message))

    def _upstream_error(self, status: int, raw) -> Response:
        text = _decode(raw)
        detail = ""
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            error = parsed.get("error")
            if isinstance(error, dict):
                detail = str(error.get("message") or "")
            elif isinstance(error, str):
                detail = error
            if not detail:
                detail = str(parsed.get("message") or "")
        else:
            detail = text
        detail = self._scrub(detail.strip())[:MAX_ERROR_CHARS]
        message = "上游返回 HTTP %d" % status
        if detail:
            message += "：" + detail
        return Response(status, body=anthropic_error(status, message))


def _default_log(level: str, message: str) -> None:
    LOG.log(getattr(logging, level.upper(), logging.INFO), "%s", message)


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

def make_handler(shim: Shim):
    """按 ``shim`` 构造请求处理类（``ThreadingHTTPServer`` 用）。"""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "anthropic-shim/1.0"

        # ── 路由 ────────────────────────────────────────────────────────

        def do_GET(self):  # noqa: N802 —— BaseHTTPRequestHandler 的约定
            path = urllib.parse.urlsplit(self.path).path
            if path == "/health":
                self._send_json(200, shim.health())
            else:
                self._send_json(404, anthropic_error(
                    404, "未知路径 %r（只有 GET /health 与 POST /v1/messages）"
                         % path))

        def do_POST(self):  # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            if path != "/v1/messages":
                self._send_json(404, anthropic_error(
                    404, "未知路径 %r（只有 GET /health 与 POST /v1/messages）"
                         % path))
                return
            body = self._read_json_body()
            if body is None:
                return
            try:
                response = shim.respond(body)
            except Exception as exc:  # noqa: BLE001 —— 不把 traceback 吐给客户端
                LOG.error("处理 /v1/messages 失败：%s", type(exc).__name__)
                self._send_json(500, anthropic_error(
                    500, "代理内部错误，详情见服务端日志"))
                return
            if response.events is None:
                self._send_json(response.status, response.body or anthropic_error(
                    response.status, "代理没有产出响应体"))
            else:
                self._send_stream(response.events)

        # ── 请求体 ──────────────────────────────────────────────────────

        def _read_json_body(self):
            raw_length = self.headers.get("Content-Length")
            try:
                length = int(raw_length) if raw_length is not None else -1
            except (TypeError, ValueError):
                length = -1
            if length < 0:
                self._send_json(400, anthropic_error(
                    400, "缺 Content-Length（本代理只接受定长请求体）"))
                return None
            if length > MAX_BODY_BYTES:
                self.close_connection = True
                self._send_json(413, anthropic_error(
                    413, "请求体超过上限 %d 字节" % MAX_BODY_BYTES))
                return None
            if length == 0:
                self._send_json(400, anthropic_error(400, "请求体为空"))
                return None
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, anthropic_error(
                    400, "请求体不是合法 JSON"))
                return None
            if not isinstance(body, dict):
                self._send_json(400, anthropic_error(
                    400, "请求体必须是 JSON 对象"))
                return None
            return body

        # ── 响应 ────────────────────────────────────────────────────────

        def _send_json(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                LOG.debug("客户端在响应写完前断开")

        def _send_stream(self, events: Iterator[dict]) -> None:
            self.send_response(200)
            self.send_header("Content-Type",
                             "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            # 事件流没有 Content-Length，用关闭连接来界定结尾。
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                for event in events:
                    self.wfile.write(render_sse(event))
                    self.wfile.flush()
                    if event.get("type") in ("message_stop", "error"):
                        break
            except (BrokenPipeError, ConnectionResetError):
                LOG.debug("客户端在流结束前断开")
            finally:
                close = getattr(events, "close", None)
                if callable(close):
                    close()

        def log_message(self, fmt, *args):  # noqa: A003 —— 基类方法名
            # 默认实现往 stderr 打请求行；这里降级，且从不打印请求头/体。
            LOG.debug("%s - %s", self.address_string(), fmt % args)

    return Handler


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Anthropic Messages → OpenAI Chat Completions 代理",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    parser.add_argument(
        "--upstream",
        default=os.environ.get("OPENAI_BASE_URL") or DEFAULT_UPSTREAM,
        help="上游 OpenAI 兼容服务根地址（含 /v1），默认取 OPENAI_BASE_URL，"
             "再缺省 %(default)s")
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help="监听地址（默认只监听本机回环）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="监听端口；0 表示让系统分配")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S,
                        help="上游请求超时（秒）")
    parser.add_argument("--dry-run", action="store_true",
                        help="不转发上游，返回固定结构的假响应")
    parser.add_argument("--serve", action="store_true",
                        help="与 --dry-run 搭配时真正挂起服务；"
                             "默认只打印监听地址后退出（自检）")
    parser.add_argument("--log-level", default="INFO",
                        help="日志级别（DEBUG/INFO/WARNING/ERROR）")
    return parser


def main(argv=None) -> int:
    args = make_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s")

    api_key = os.environ.get("OPENAI_API_KEY", "")
    shim = Shim(args.upstream, dry_run=args.dry_run, api_key=api_key,
                timeout=args.timeout)

    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(shim))
    except OSError as exc:
        print("[阻断] 无法监听 %s:%s：%s" % (args.host, args.port, exc),
              file=sys.stderr)
        return 2
    server.daemon_threads = True

    host, port = server.server_address[0], server.server_address[1]
    print("ANTHROPIC_SHIM_READY http://%s:%d  upstream=%s%s"
          % (host, port, display_url(shim.upstream),
             "  (dry-run)" if shim.dry_run else ""))
    sys.stdout.flush()

    if args.dry_run and not args.serve:
        # 验收路径：能起、能打印、然后干净退出，不留下后台进程。
        server.server_close()
        return 0

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
