#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``tools/anthropic_shim.py`` 的用例：纯函数映射 + 假上游，不建 socket、不联网。

覆盖五类：请求映射（system / 多轮 / 图片 / tools）、响应映射（文本 / 工具 /
stop_reason）、SSE 帧序列（文本与工具各一条）、错误（上游 5xx、缺字段）、
dry-run（固定假响应，且证明没有碰 socket）。
"""
from __future__ import annotations

import json
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import anthropic_shim as shim  # noqa: E402

MODEL = "deepseek-chat"
SECRET = "sk-test-should-never-be-logged"


def quiet_log(level, message):
    """测试里不往 stderr 打日志；需要断言的用例自己收集。"""


def base_request(**overrides):
    body = {
        "model": MODEL,
        "max_tokens": 256,
        "messages": [{"role": "user", "content": "你好"}],
    }
    body.update(overrides)
    return body


def tool_definition():
    return {
        "name": "query_station",
        "description": "查询台站某段时间的观测情况",
        "input_schema": {
            "type": "object",
            "properties": {"station": {"type": "string"}},
            "required": ["station"],
        },
    }


class FakeTransport:
    """记录调用并按预置返回 ``(status, body)``；流式的 body 是行列表。"""

    def __init__(self, status=200, body=b""):
        self.status = status
        self.body = body
        self.calls = []

    def post(self, payload, stream):
        self.calls.append({"payload": payload, "stream": stream})
        return self.status, self.body


class BoomTransport:
    def post(self, payload, stream):
        raise shim.UpstreamUnreachable("connection refused")


def sse_line(chunk):
    return ("data: %s\n\n" % json.dumps(chunk, ensure_ascii=False)).encode("utf-8")


# --------------------------------------------------------------------------
# 请求映射
# --------------------------------------------------------------------------

class RequestMappingTest(unittest.TestCase):
    def test_system_multiturn_image_and_tools(self):
        warnings = []
        body = {
            "model": MODEL,
            "max_tokens": 512,
            "temperature": 0.2,
            "system": "你是台站质控助手。",
            "messages": [
                {"role": "user", "content": "查一下 BADG"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "好的，我先查。"},
                ]},
                {"role": "user", "content": [
                    {"type": "text", "text": "顺便看这张图"},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png",
                        "data": "aGVsbG8=",
                    }},
                ]},
            ],
            "tools": [tool_definition()],
            "foo": "bar",
        }

        payload, model = shim.build_upstream_request(body, warn=warnings.append)

        self.assertEqual(model, MODEL)
        self.assertEqual(payload["model"], MODEL)
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["max_tokens"], 512)
        self.assertAlmostEqual(payload["temperature"], 0.2)
        self.assertEqual(
            [m["role"] for m in payload["messages"]],
            ["system", "user", "assistant", "user"])
        self.assertEqual(payload["messages"][0],
                         {"role": "system", "content": "你是台站质控助手。"})
        self.assertEqual(payload["messages"][1]["content"], "查一下 BADG")
        self.assertEqual(payload["messages"][2]["content"], "好的，我先查。")

        function = payload["tools"][0]["function"]
        self.assertEqual(payload["tools"][0]["type"], "function")
        self.assertEqual(function["name"], "query_station")
        self.assertEqual(function["description"], "查询台站某段时间的观测情况")
        self.assertEqual(function["parameters"],
                         tool_definition()["input_schema"])

        self.assertNotIn("foo", payload)
        joined = "\n".join(warnings)
        self.assertIn("foo", joined)
        self.assertIn("image", joined)
        self.assertIn("image/png", joined)
        # 图片数据本身不能进日志。
        self.assertNotIn("aGVsbG8=", joined)

    def test_system_block_array_is_joined(self):
        body = base_request(system=[
            {"type": "text", "text": "第一段"},
            {"type": "text", "text": "第二段"},
        ])
        payload, _ = shim.build_upstream_request(body, warn=quiet_log)
        self.assertEqual(payload["messages"][0],
                         {"role": "system", "content": "第一段\n第二段"})

    def test_tool_use_and_tool_result(self):
        body = {
            "model": MODEL,
            "max_tokens": 128,
            "messages": [
                {"role": "user", "content": "查 BADG"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "我查一下"},
                    {"type": "tool_use", "id": "toolu_1",
                     "name": "query_station",
                     "input": {"station": "BADG"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1",
                     "content": [{"type": "text", "text": "42 条"}]},
                    {"type": "text", "text": "继续"},
                ]},
            ],
            "tools": [tool_definition()],
            "tool_choice": {"type": "tool", "name": "query_station"},
        }

        payload, _ = shim.build_upstream_request(body, warn=quiet_log)

        self.assertEqual(
            [m["role"] for m in payload["messages"]],
            ["user", "assistant", "tool", "user"])
        assistant = payload["messages"][1]
        self.assertEqual(assistant["content"], "我查一下")
        call = assistant["tool_calls"][0]
        self.assertEqual(call["id"], "toolu_1")
        self.assertEqual(call["function"]["name"], "query_station")
        self.assertEqual(json.loads(call["function"]["arguments"]),
                         {"station": "BADG"})
        self.assertEqual(payload["messages"][2], {
            "role": "tool",
            "tool_call_id": "toolu_1",
            "content": "42 条",
        })
        self.assertEqual(payload["messages"][3],
                         {"role": "user", "content": "继续"})
        self.assertEqual(payload["tool_choice"],
                         {"type": "function",
                          "function": {"name": "query_station"}})

    def test_tool_choice_variants_and_stop_sequences(self):
        cases = {
            "auto": "auto",
            "any": "required",
            "none": "none",
        }
        for anthropic_kind, openai_value in cases.items():
            with self.subTest(kind=anthropic_kind):
                body = base_request(
                    tools=[tool_definition()],
                    tool_choice={"type": anthropic_kind},
                    stop_sequences=["END"],
                )
                payload, _ = shim.build_upstream_request(body, warn=quiet_log)
                self.assertEqual(payload["tool_choice"], openai_value)
                self.assertEqual(payload["stop"], ["END"])

    def test_assistant_tool_call_has_no_fake_text(self):
        body = base_request(messages=[
            {"role": "user", "content": "查 BADG"},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_9",
                 "name": "query_station", "input": {}},
            ]},
        ])
        payload, _ = shim.build_upstream_request(body, warn=quiet_log)
        assistant = payload["messages"][1]
        self.assertIsNone(assistant["content"])
        self.assertEqual(assistant["tool_calls"][0]["function"]["arguments"], "{}")

    def test_unknown_fields_and_types_are_logged(self):
        warnings = []
        body = base_request(
            top_k=40,
            metadata={"user_id": "u1"},
            messages=[{"role": "user", "content": [
                {"type": "thinking", "thinking": "..."},
                {"type": "text", "text": "在"},
            ]}],
        )
        payload, _ = shim.build_upstream_request(body, warn=warnings.append)
        self.assertNotIn("top_k", payload)
        self.assertNotIn("metadata", payload)
        joined = "\n".join(warnings)
        self.assertIn("top_k", joined)
        self.assertIn("metadata", joined)
        self.assertIn("thinking", joined)

    def test_bad_role_is_rejected(self):
        body = base_request(messages=[{"role": "system", "content": "x"}])
        with self.assertRaises(shim.ShimError) as caught:
            shim.build_upstream_request(body, warn=quiet_log)
        self.assertEqual(caught.exception.status, 400)


# --------------------------------------------------------------------------
# 响应映射（非流式）
# --------------------------------------------------------------------------

class ResponseMappingTest(unittest.TestCase):
    def test_plain_text(self):
        data = {
            "id": "chatcmpl-xyz",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "台站一切正常。"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4},
        }
        message = shim.to_anthropic_response(data, model=MODEL, warn=quiet_log)

        self.assertEqual(message["id"], "msg_chatcmpl-xyz")
        self.assertEqual(message["type"], "message")
        self.assertEqual(message["role"], "assistant")
        self.assertEqual(message["model"], MODEL)
        self.assertEqual(message["content"],
                         [{"type": "text", "text": "台站一切正常。"}])
        self.assertEqual(message["stop_reason"], "end_turn")
        self.assertIsNone(message["stop_sequence"])
        self.assertEqual(message["usage"],
                         {"input_tokens": 12, "output_tokens": 4})

    def test_tool_calls(self):
        data = {
            "id": "chatcmpl-tool",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "query_station",
                            "arguments": '{"station": "BADG"}',
                        },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 9},
        }
        message = shim.to_anthropic_response(data, model=MODEL, warn=quiet_log)

        self.assertEqual(message["stop_reason"], "tool_use")
        self.assertEqual(len(message["content"]), 1)
        block = message["content"][0]
        self.assertEqual(block["type"], "tool_use")
        self.assertEqual(block["id"], "call_1")
        self.assertEqual(block["name"], "query_station")
        self.assertEqual(block["input"], {"station": "BADG"})

    def test_text_before_tool_use(self):
        data = {"choices": [{
            "message": {"content": "先查一下", "tool_calls": [{
                "id": "call_2",
                "function": {"name": "query_station",
                             "arguments": "{}"},
            }]},
            "finish_reason": "tool_calls",
        }]}
        message = shim.to_anthropic_response(data, model=MODEL, warn=quiet_log)
        self.assertEqual([block["type"] for block in message["content"]],
                         ["text", "tool_use"])

    def test_length_maps_to_max_tokens_even_with_tool_calls(self):
        data = {"choices": [{
            "message": {"content": "半截", "tool_calls": [{
                "id": "call_3",
                "function": {"name": "query_station",
                             "arguments": '{"station":'},
            }]},
            "finish_reason": "length",
        }]}
        warnings = []
        message = shim.to_anthropic_response(data, model=MODEL,
                                             warn=warnings.append)
        self.assertEqual(message["stop_reason"], "max_tokens")
        self.assertIn("JSON", "\n".join(warnings))

    def test_empty_message_still_has_a_content_block(self):
        data = {"choices": [{
            "message": {"content": ""},
            "finish_reason": "stop",
        }]}
        warnings = []
        message = shim.to_anthropic_response(data, model=MODEL,
                                             warn=warnings.append)
        self.assertEqual(message["content"], [{"type": "text", "text": ""}])
        self.assertTrue(any("空文本" in item for item in warnings))


# --------------------------------------------------------------------------
# SSE 帧序列
# --------------------------------------------------------------------------

class StreamMappingTest(unittest.TestCase):
    def collect(self, translator, chunks):
        events = list(translator.start())
        for chunk in chunks:
            events.extend(translator.feed(chunk))
        events.extend(translator.finish())
        return events

    def test_text_stream_frame_sequence(self):
        chunks = [
            {"choices": [{"index": 0, "finish_reason": None,
                          "delta": {"role": "assistant", "content": ""}}]},
            {"choices": [{"index": 0, "finish_reason": None,
                          "delta": {"content": "你"}}]},
            {"choices": [{"index": 0, "finish_reason": None,
                          "delta": {"content": "好"}}]},
            {"choices": [{"index": 0, "finish_reason": "stop",
                          "delta": {}}]},
            {"choices": [],
             "usage": {"prompt_tokens": 5, "completion_tokens": 7}},
        ]
        translator = shim.StreamTranslator(
            model=MODEL, message_id="msg_test", warn=quiet_log)
        events = self.collect(translator, chunks)

        self.assertEqual([event["type"] for event in events], [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ])

        start = events[0]["message"]
        self.assertEqual(start["id"], "msg_test")
        self.assertEqual(start["model"], MODEL)
        self.assertEqual(start["content"], [])
        self.assertIsNone(start["stop_reason"])

        block_start = events[1]
        self.assertEqual(block_start["index"], 0)
        self.assertEqual(block_start["content_block"],
                         {"type": "text", "text": ""})

        deltas = [event["delta"]["text"] for event in events
                  if event["type"] == "content_block_delta"]
        self.assertEqual(deltas, ["你", "好"])

        self.assertEqual(events[4]["index"], 0)
        delta = events[5]
        self.assertEqual(delta["delta"]["stop_reason"], "end_turn")
        self.assertIsNone(delta["delta"]["stop_sequence"])
        self.assertEqual(delta["usage"]["output_tokens"], 7)
        self.assertEqual(delta["usage"]["input_tokens"], 5)

    def test_tool_call_stream_frame_sequence(self):
        chunks = [
            {"choices": [{"index": 0, "finish_reason": None, "delta": {
                "tool_calls": [{
                    "index": 0, "id": "call_1", "type": "function",
                    "function": {"name": "query_station", "arguments": ""},
                }],
            }}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {
                "tool_calls": [{
                    "index": 0,
                    "function": {"arguments": '{"sta'},
                }],
            }}]},
            {"choices": [{"index": 0, "finish_reason": None, "delta": {
                "tool_calls": [{
                    "index": 0,
                    "function": {"arguments": 'tion":"BADG"}'},
                }],
            }}]},
            {"choices": [{"index": 0, "finish_reason": "tool_calls",
                          "delta": {}}]},
            {"choices": [],
             "usage": {"prompt_tokens": 8, "completion_tokens": 3}},
        ]
        translator = shim.StreamTranslator(
            model=MODEL, message_id="msg_tool", warn=quiet_log)
        events = self.collect(translator, chunks)

        self.assertEqual([event["type"] for event in events], [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ])

        block_start = events[1]
        self.assertEqual(block_start["content_block"]["type"], "tool_use")
        self.assertEqual(block_start["content_block"]["id"], "call_1")
        self.assertEqual(block_start["content_block"]["name"], "query_station")
        self.assertEqual(block_start["content_block"]["input"], {})

        partials = [event["delta"]["partial_json"] for event in events
                    if event["type"] == "content_block_delta"]
        self.assertEqual("".join(partials), '{"station":"BADG"}')
        self.assertEqual(events[5]["delta"]["stop_reason"], "tool_use")

    def test_arguments_before_name_are_buffered(self):
        translator = shim.StreamTranslator(
            model=MODEL, message_id="msg_tool", warn=quiet_log)
        events = list(translator.start())

        # 首块只给参数、不给 name：不能立刻开块（Anthropic 的 tool_use 需要 name）。
        events += translator.feed({"choices": [{"delta": {"tool_calls": [{
            "index": 0, "function": {"arguments": '{"station":'}}]}}]})
        self.assertEqual([event["type"] for event in events],
                         ["message_start"])

        events += translator.feed({"choices": [{"delta": {"tool_calls": [{
            "index": 0, "id": "call_9",
            "function": {"name": "query_station",
                         "arguments": '"BADG"}'}}]}}]})
        self.assertEqual([event["type"] for event in events], [
            "message_start", "content_block_start", "content_block_delta"])
        self.assertEqual(events[1]["content_block"]["name"], "query_station")
        self.assertEqual(events[2]["delta"]["partial_json"],
                         '{"station":"BADG"}')

        events += translator.finish()
        self.assertEqual(events[-1]["type"], "message_stop")

    def test_render_sse_has_event_and_data(self):
        frame = shim.render_sse({"type": "message_start", "message": {}})
        text = frame.decode("utf-8")
        self.assertTrue(text.startswith("event: message_start\ndata: "))
        self.assertTrue(text.endswith("\n\n"))
        payload = json.loads(text.split("data: ", 1)[1].strip())
        self.assertEqual(payload["type"], "message_start")

    def test_late_tool_delta_after_block_close_is_dropped(self):
        warnings = []
        translator = shim.StreamTranslator(
            model=MODEL, message_id="msg_late", warn=warnings.append)
        events = list(translator.start())
        events += translator.feed({"choices": [{"delta": {"tool_calls": [{
            "index": 0, "id": "call_a",
            "function": {"name": "query_station", "arguments": "{}"}}]}}]})
        events += translator.feed({"choices": [{"delta": {"tool_calls": [{
            "index": 1, "id": "call_b",
            "function": {"name": "query_station", "arguments": ""}}]}}]})
        # 块 0 已经关掉；迟到的增量必须丢弃，否则事件序列非法。
        late = translator.feed({"choices": [{"delta": {"tool_calls": [{
            "index": 0, "function": {"arguments": '{"station":'}}]}}]})
        self.assertEqual(late, [])
        self.assertTrue(any("丢弃" in item for item in warnings))
        events += translator.finish()
        self.assertEqual(events[-1]["type"], "message_stop")

    def test_sse_metadata_lines_are_skipped(self):
        lines = [
            b"event: chunk\n",
            b"id: 1\n",
            b"retry: 1000\n",
            b"data: {\"choices\": [{\"delta\": {\"content\": \"x\"}}]}\n\n",
            b"data: [DONE]\n\n",
        ]
        chunks = list(shim.iter_openai_chunks(lines))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["choices"][0]["delta"]["content"], "x")


# --------------------------------------------------------------------------
# 端到端（假 transport，不建 socket）
# --------------------------------------------------------------------------

class ShimRespondTest(unittest.TestCase):
    def test_non_stream_text(self):
        completion = {
            "id": "chatcmpl-1",
            "choices": [{"message": {"content": "正常"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        }
        transport = FakeTransport(200, json.dumps(completion).encode("utf-8"))
        proxy = shim.Shim("http://upstream.test/v1", transport=transport,
                          log=quiet_log)

        response = proxy.respond(base_request())

        self.assertFalse(response.is_stream)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["content"],
                         [{"type": "text", "text": "正常"}])
        self.assertEqual(transport.calls[0]["stream"], False)
        self.assertFalse(transport.calls[0]["payload"]["stream"])

    def test_stream_is_translated_end_to_end(self):
        lines = [
            sse_line({"choices": [{"index": 0, "finish_reason": None,
                                   "delta": {"role": "assistant",
                                             "content": "台"}}]}),
            sse_line({"choices": [{"index": 0, "finish_reason": None,
                                   "delta": {"content": "站"}}]}),
            sse_line({"choices": [{"index": 0, "finish_reason": "stop",
                                   "delta": {}}]}),
            b"data: [DONE]\n\n",
        ]
        transport = FakeTransport(200, lines)
        proxy = shim.Shim("http://upstream.test/v1", transport=transport,
                          log=quiet_log)

        response = proxy.respond(base_request(stream=True))

        self.assertTrue(response.is_stream)
        events = list(response.events)
        self.assertEqual(events[0]["type"], "message_start")
        self.assertEqual(events[-1]["type"], "message_stop")
        text = "".join(event["delta"]["text"] for event in events
                       if event["type"] == "content_block_delta")
        self.assertEqual(text, "台站")
        sent = transport.calls[0]["payload"]
        self.assertTrue(sent["stream"])
        self.assertEqual(sent["stream_options"], {"include_usage": True})

    def test_mid_stream_error_becomes_error_event(self):
        lines = [
            sse_line({"choices": [{"delta": {"content": "半"}}]}),
            sse_line({"error": {"message": "upstream exploded"}}),
        ]
        transport = FakeTransport(200, lines)
        proxy = shim.Shim("http://upstream.test/v1", transport=transport,
                          log=quiet_log)

        response = proxy.respond(base_request(stream=True))
        events = list(response.events)

        self.assertEqual(events[0]["type"], "message_start")
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("upstream exploded", events[-1]["error"]["message"])
        self.assertFalse(any(event["type"] == "message_stop"
                             for event in events))

    def test_non_sse_upstream_body_is_rejected(self):
        transport = FakeTransport(200, b"<html>not sse</html>")
        proxy = shim.Shim("http://upstream.test/v1", transport=transport,
                          log=quiet_log)
        response = proxy.respond(base_request(stream=True))
        events = list(response.events)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("SSE", events[-1]["error"]["message"])


# --------------------------------------------------------------------------
# 错误
# --------------------------------------------------------------------------

class ErrorTest(unittest.TestCase):
    def make_proxy(self, status, body=b"", **kwargs):
        transport = FakeTransport(status, body)
        return shim.Shim("http://upstream.test/v1", transport=transport,
                         log=quiet_log, **kwargs), transport

    def test_upstream_500_keeps_status_and_uses_anthropic_error(self):
        proxy, _ = self.make_proxy(
            500, b'{"error": {"message": "model overloaded"}}')
        response = proxy.respond(base_request())

        self.assertFalse(response.is_stream)
        self.assertEqual(response.status, 500)
        self.assertEqual(response.body["type"], "error")
        self.assertEqual(response.body["error"]["type"], "api_error")
        self.assertIn("model overloaded", response.body["error"]["message"])

    def test_upstream_400_keeps_status_and_error_type(self):
        proxy, _ = self.make_proxy(
            400, b'{"error": {"message": "bad max_tokens"}}')
        response = proxy.respond(base_request())
        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"]["type"],
                         "invalid_request_error")

    def test_upstream_429_maps_to_rate_limit(self):
        proxy, _ = self.make_proxy(429, b'{"error": {"message": "slow down"}}')
        response = proxy.respond(base_request())
        self.assertEqual(response.status, 429)
        self.assertEqual(response.body["error"]["type"], "rate_limit_error")

    def test_upstream_stream_error_status_is_json_not_sse(self):
        proxy, _ = self.make_proxy(500, b'{"error": {"message": "boom"}}')
        response = proxy.respond(base_request(stream=True))
        self.assertFalse(response.is_stream)
        self.assertEqual(response.status, 500)

    def test_unreachable_upstream_is_502(self):
        proxy = shim.Shim("http://upstream.test/v1",
                          transport=BoomTransport(), log=quiet_log)
        response = proxy.respond(base_request())
        self.assertEqual(response.status, 502)
        self.assertEqual(response.body["error"]["type"], "api_error")
        self.assertIn("不可达", response.body["error"]["message"])

    def test_missing_model_is_400(self):
        body = {"messages": [{"role": "user", "content": "hi"}]}
        proxy = shim.Shim(dry_run=True, log=quiet_log)
        response = proxy.respond(body)
        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"]["type"],
                         "invalid_request_error")
        self.assertIn("model", response.body["error"]["message"])

    def test_missing_messages_is_400(self):
        proxy = shim.Shim(dry_run=True, log=quiet_log)
        response = proxy.respond({"model": MODEL})
        self.assertEqual(response.status, 400)
        self.assertIn("messages", response.body["error"]["message"])

    def test_empty_messages_is_400(self):
        proxy = shim.Shim(dry_run=True, log=quiet_log)
        response = proxy.respond(base_request(messages=[]))
        self.assertEqual(response.status, 400)
        self.assertIn("messages", response.body["error"]["message"])

    def test_non_object_body_is_400(self):
        proxy = shim.Shim(dry_run=True, log=quiet_log)
        response = proxy.respond([1, 2, 3])
        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"]["type"],
                         "invalid_request_error")

    def test_api_key_is_scrubbed_from_error_text(self):
        proxy, _ = self.make_proxy(
            500, ("{\"error\": {\"message\": \"bad key %s\"}}" % SECRET)
            .encode("utf-8"), api_key=SECRET)
        response = proxy.respond(base_request())
        message = response.body["error"]["message"]
        self.assertNotIn(SECRET, message)
        self.assertIn("***", message)


# --------------------------------------------------------------------------
# dry-run
# --------------------------------------------------------------------------

class DryRunTest(unittest.TestCase):
    def test_fixed_response_without_socket(self):
        with mock.patch.object(socket, "socket",
                               side_effect=AssertionError("dry-run 不应建 socket")), \
                mock.patch.object(socket, "create_connection",
                                  side_effect=AssertionError("dry-run 不应联网")):
            proxy = shim.Shim(dry_run=True, log=quiet_log)
            response = proxy.respond(base_request(tools=[tool_definition()]))

        self.assertFalse(response.is_stream)
        self.assertEqual(response.status, 200)
        text = response.body["content"][0]["text"]
        self.assertIn("[dry-run]", text)
        self.assertIn("1 条消息", text)
        self.assertIn("1 个工具定义", text)
        self.assertEqual(response.body["stop_reason"], "end_turn")
        self.assertEqual(response.body["usage"],
                         {"input_tokens": 0, "output_tokens": 0})
        self.assertIsInstance(proxy.transport, shim.DryRunTransport)

    def test_dry_run_stream_is_a_full_frame_sequence(self):
        proxy = shim.Shim(dry_run=True, log=quiet_log)
        response = proxy.respond(base_request(stream=True))
        events = list(response.events)

        self.assertEqual(events[0]["type"], "message_start")
        self.assertEqual(events[1]["type"], "content_block_start")
        self.assertEqual(events[-2]["type"], "message_delta")
        self.assertEqual(events[-1]["type"], "message_stop")
        text = "".join(event["delta"]["text"] for event in events
                       if event["type"] == "content_block_delta")
        self.assertIn("[dry-run]", text)

    def test_dry_run_transport_records_no_network(self):
        transport = shim.DryRunTransport()
        status, body = transport.post(base_request(), stream=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8"))["id"],
                         "chatcmpl-dryrun")
        self.assertEqual(transport.calls, [{"stream": False}])


# --------------------------------------------------------------------------
# 健康检查与命令行默认值
# --------------------------------------------------------------------------

class HealthAndCliTest(unittest.TestCase):
    def test_health_reports_configuration(self):
        proxy = shim.Shim("http://127.0.0.1:9999/v1",
                          dry_run=True, log=quiet_log)
        health = proxy.health()
        self.assertTrue(health["ok"])
        self.assertEqual(health["upstream"], "http://127.0.0.1:9999/v1")
        self.assertTrue(health["dry_run"])

    def test_health_masks_upstream_credentials(self):
        proxy = shim.Shim("http://user:pass@host.test/v1",
                          dry_run=True, log=quiet_log)
        self.assertEqual(proxy.health()["upstream"], "http://host.test/v1")

    def test_upstream_defaults_to_openai_base_url(self):
        with mock.patch.dict(os.environ,
                             {"OPENAI_BASE_URL": "http://example.test/v1"}):
            args = shim.make_parser().parse_args([])
        self.assertEqual(args.upstream, "http://example.test/v1")
        self.assertEqual(args.port, shim.DEFAULT_PORT)
        self.assertEqual(args.host, "127.0.0.1")

    def test_upstream_falls_back_to_local_ollama(self):
        env = dict(os.environ)
        env.pop("OPENAI_BASE_URL", None)
        with mock.patch.dict(os.environ, env, clear=True):
            args = shim.make_parser().parse_args([])
        self.assertEqual(args.upstream, shim.DEFAULT_UPSTREAM)

    def test_display_url_masks_credentials(self):
        self.assertEqual(
            shim.display_url("http://user:pass@host.test:9000/v1"),
            "http://host.test:9000/v1")
        self.assertEqual(shim.display_url("http://host.test/v1"),
                         "http://host.test/v1")


if __name__ == "__main__":
    unittest.main()
