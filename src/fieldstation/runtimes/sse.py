# -*- coding: utf-8 -*-
"""SSE 解析与两个协议到内部事件的翻译（纯函数，可离线测）。

* OpenAI 兼容（OpenCode 用的就是这个）：``data: {...}`` 分块，``[DONE]`` 结束。
* Anthropic Messages（Claude SDK 用的）：``event: xxx`` + ``data: {...}`` 成对出现。

## 九种事件里有三种不由 provider 产生

``tool.result`` / ``approval.request`` / ``approval.result`` 这三件事，provider
不知道：

* 工具真的跑完了没有 —— 是我们的运行循环执行的，provider 只「想」调工具；
* 要不要人批 —— 是我们的审批门决定的；
* 人批了没有 —— 更是我们的台账。

所以两个翻译器除了读 provider 的原始流，还要认一个**内部回填**入口
（:data:`INTERNAL_KEY`）：运行循环把这三类事件按契约字段灌进来，
翻译器原样转成 :class:`Event`。

这样做的目的只有一个：**让这三件事在两侧字段完全一致，由同一份代码维持**。
如果让两侧各自拼接，字段名一天就会分叉（A 用 ``call_id``、B 用 ``callId``），
而那种错不会报错——只是界面上一半能渲染一半不能。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .base import Event

#: 内部回填的信封键。**不上线路**：它只是翻译函数的第二个入口。
#:
#: 形状：``{"fsa_internal": {"tool_result": {...}}}``
INTERNAL_KEY = "fsa_internal"

#: 内部可回填的三类事件。
INTERNAL_KINDS = ("tool_result", "approval_request", "approval_result")

#: ``tool.result`` 的字段顺序（契约 §3.5）。两侧必须一致，前端按序渲染卡片。
TOOL_RESULT_FIELDS = ("id", "name", "ok", "data", "error", "duration_ms")

#: ``approval.request`` 的字段顺序（契约 §3.6）。
APPROVAL_REQUEST_FIELDS = ("approval_id", "call_id", "name", "risk",
                           "reason", "prompt", "requested_by")

#: ``approval.result`` 的字段顺序（契约 §3.7）。
APPROVAL_RESULT_FIELDS = ("approval_id", "call_id", "verdict", "by", "note")


def _ordered(payload: dict, fields: tuple[str, ...]) -> dict:
    """按契约字段顺序重排；**缺失字段补空、多余字段丢掉**。

    为什么要重排：两侧的 dict 构造顺序天然不同。不重排的话 ``json.dumps``
    出来的字节就不同，前端「按固定顺序渲染」和「逐字节比对回放」两件事都做不成。

    缺字段补空而不是省略：省略会让前端读 ``data['name']`` 抛 KeyError；
    补空至少能渲染出一个空位，看得见就没那么糟。
    """
    return {k: payload.get(k, "" if k not in ("ok", "data", "error") else None)
            for k in fields}


def _internal_events(kind: str, payload: dict, session_id: str) -> list[Event]:
    """把一条内部回填转成 ``Event``。**未知的内部类型不静默丢**。"""
    if kind == "tool_result":
        body = _ordered(payload, TOOL_RESULT_FIELDS)
        # 成败只看 ok，不从 data 里有没有键去猜（契约 §3.5 明确要求）
        if not body.get("ok"):
            body["data"] = None
            body["error"] = body.get("error") or {
                "code": "E_INTERNAL", "message": "工具失败但未给错误",
                "retryable": False}
        else:
            body["error"] = body.get("error") or None
            body["data"] = body.get("data") or {}
        return [Event("tool.result", session_id, body)]

    if kind == "approval_request":
        return [Event("approval.request", session_id,
                      _ordered(payload, APPROVAL_REQUEST_FIELDS))]

    if kind == "approval_result":
        return [Event("approval.result", session_id,
                      _ordered(payload, APPROVAL_RESULT_FIELDS))]

    return [Event("error", session_id, {
        "class": "execution",
        "message": "未知的内部回填类型：%r（只认 %s）" % (kind, INTERNAL_KINDS),
        "retryable": False,
    })]


def _try_internal(data: dict, session_id: str) -> list[Event] | None:
    """若这条 payload 是内部回填，转成事件返回；否则返回 ``None``。

    先判再转，是因为 provider 的正常分块里不会出现 :data:`INTERNAL_KEY`——
    真出现了说明有人在伪造，那时按内部回填处理反而是对的。
    """
    if INTERNAL_KEY not in data:
        return None
    inner = data.get(INTERNAL_KEY)
    if not isinstance(inner, dict) or not inner:
        return [Event("error", session_id, {
            "class": "input",
            "message": "%s 必须是非空 object" % INTERNAL_KEY,
            "retryable": False})]
    out: list[Event] = []
    for kind, payload in inner.items():
        out.extend(_internal_events(kind, payload if isinstance(payload, dict) else {},
                                    session_id))
    return out


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

    # 内部回填优先：它不走 provider 的流，是我们自己灌进来的
    internal = _try_internal(chunk, state.session_id)
    if internal is not None:
        return internal

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

    # 内部回填优先，**且不受 event 名影响**：运行循环可能把信封键放在 event
    # 参数上，也可能只放在 JSON 体里。判据只看 body 里有没有 INTERNAL_KEY——
    # provider 的正常分块绝不会带它。
    internal = _try_internal(data, state.session_id)
    if internal is not None:
        return internal

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
