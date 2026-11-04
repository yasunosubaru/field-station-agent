# -*- coding: utf-8 -*-
"""SSE 解析与两个协议到内部事件的翻译（纯函数，可离线测）。

* OpenAI 兼容（OpenCode 用的就是这个）：``data: {...}`` 分块，``[DONE]`` 结束。
* Anthropic Messages（Claude SDK 用的）：``event: xxx`` + ``data: {...}`` 成对出现。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .base import Event


def iter_sse(lines):
    """把 SSE 行流变成 (event, data) 对；忽略注释与空行，兼容 CRLF。"""
    event_name = None
    data_lines: list[str] = []
    for raw in lines:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        line = line.rstrip("\r\n")
        if not line:
            if data_lines:
                payload = "\n".join(data_lines)
                data_lines = []
                yield event_name, payload
                event_name = None
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].lstrip())
            continue
    if data_lines:
        yield event_name, "\n".join(data_lines)


@dataclass
class OpenAIState:
    """OpenAI 流式里工具调用是分片到达的，要按 index 拼。"""

    session_id: str
    tool_buf: dict = field(default_factory=dict)   # index -> {id,name,arguments}
    started: bool = False


def translate_openai(payload: str, state: OpenAIState) -> list[Event]:
    """OpenAI chat.completion.chunk → 内部事件。"""
    if payload.strip() == "[DONE]":
        return [Event("message.done", state.session_id, {"reason": "done"})]
    try:
        chunk = json.loads(payload)
    except json.JSONDecodeError:
        return [Event("error", state.session_id, {"class": "execution", "message": "SSE 不是合法 JSON"})]

    events: list[Event] = []
    if not state.started:
        state.started = True
        events.append(Event("session.start", state.session_id, {"runtime": "opencode"}))

    for choice in chunk.get("choices") or []:
        delta = choice.get("delta") or {}
        text = delta.get("content")
        if text:
            events.append(Event("message.delta", state.session_id, {"text": text}))
        for call in delta.get("tool_calls") or []:
            idx = int(call.get("index", 0))
            buf = state.tool_buf.setdefault(idx, {"id": "", "name": "", "arguments": ""})
            if call.get("id"):
                buf["id"] = call["id"]
            fn = call.get("function") or {}
            if fn.get("name"):
                buf["name"] = fn["name"]
            if fn.get("arguments"):
                buf["arguments"] += fn["arguments"]
        finish = choice.get("finish_reason")
        if finish:
            for idx in sorted(state.tool_buf):
                buf = state.tool_buf[idx]
                events.append(Event("tool.call", state.session_id,
                                    {"id": buf["id"] or "call_%d" % idx,
                                     "name": buf["name"], "arguments": buf["arguments"]}))
            state.tool_buf.clear()
            events.append(Event("message.done", state.session_id, {"reason": finish}))

    usage = chunk.get("usage")
    if usage:
        events.append(Event("usage", state.session_id, {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
        }))
    return events


@dataclass
class AnthropicState:
    session_id: str
    started: bool = False
    current_tool: dict | None = None
    stop_reason: str | None = None


_ANTHROPIC_STOP = {"end_turn": "stop", "tool_use": "tool_calls", "max_tokens": "length"}


def translate_anthropic(event: str | None, payload: str, state: AnthropicState) -> list[Event]:
    """Anthropic SSE（message_start / content_block_* / message_delta / message_stop）→ 内部事件。"""
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return [Event("error", state.session_id, {"class": "execution", "message": "SSE 不是合法 JSON"})]

    kind = event or data.get("type") or ""
    if kind == "message_start":
        if not state.started:
            state.started = True
            return [Event("session.start", state.session_id, {"runtime": "claude"})]
        return []

    if kind == "content_block_start":
        block = data.get("content_block") or {}
        if block.get("type") == "tool_use":
            state.current_tool = {"id": block.get("id", ""), "name": block.get("name", ""),
                                  "arguments": ""}
        return []

    if kind == "content_block_delta":
        delta = data.get("delta") or {}
        if delta.get("type") == "text_delta" and delta.get("text"):
            return [Event("message.delta", state.session_id, {"text": delta["text"]})]
        if delta.get("type") == "input_json_delta" and state.current_tool is not None:
            state.current_tool["arguments"] += delta.get("partial_json", "")
        return []

    if kind == "content_block_stop":
        if state.current_tool is not None:
            tool, state.current_tool = state.current_tool, None
            return [Event("tool.call", state.session_id,
                          {"id": tool["id"], "name": tool["name"],
                           "arguments": tool["arguments"] or "{}"})]
        return []

    if kind == "message_delta":
        delta = data.get("delta") or {}
        if delta.get("stop_reason"):
            state.stop_reason = _ANTHROPIC_STOP.get(delta["stop_reason"], delta["stop_reason"])
        usage = data.get("usage") or {}
        if usage:
            return [Event("usage", state.session_id, {
                "completion_tokens": usage.get("output_tokens", 0),
                "prompt_tokens": usage.get("input_tokens", 0),
            })]
        return []

    if kind == "message_stop":
        return [Event("message.done", state.session_id, {"reason": state.stop_reason or "stop"})]

    return []
