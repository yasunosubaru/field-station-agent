# -*- coding: utf-8 -*-
"""运行时契约与两个协议的翻译（离线，不连网）。"""
import json
import unittest

from fieldstation.runtimes import Event, FakeRuntime, RuntimeRequest, coerce_events
from fieldstation.runtimes.sse import (AnthropicState, OpenAIState, iter_sse,
                                       translate_anthropic, translate_openai)


class TestSseReader(unittest.TestCase):
    def test_pairs_event_and_data(self):
        lines = ["event: ping", "data: {\"a\":1}", "", "data: [DONE]", ""]
        self.assertEqual(list(iter_sse(lines)),
                         [("ping", '{"a":1}'), (None, "[DONE]")])

    def test_ignores_comments_and_blank_runs(self):
        lines = [": keep-alive", "", "", "data: x", ""]
        self.assertEqual(list(iter_sse(lines)), [(None, "x")])

    def test_crlf_and_bytes(self):
        lines = [b"data: {}\r\n", b"\r\n"]
        self.assertEqual(list(iter_sse(lines)), [(None, "{}")])


class TestOpenAITranslate(unittest.TestCase):
    def _feed(self, payloads):
        state = OpenAIState("s1")
        out = []
        for p in payloads:
            out.extend(translate_openai(p, state))
        return out

    def test_text_stream(self):
        events = self._feed([
            json.dumps({"choices": [{"delta": {"content": "你"}}]}),
            json.dumps({"choices": [{"delta": {"content": "好"}}]}),
            json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 2}}),
            "[DONE]",
        ])
        kinds = [e.type for e in events]
        self.assertEqual(events[0].type, "session.start")
        self.assertEqual("".join(e.data["text"] for e in events if e.type == "message.delta"), "你好")
        self.assertIn("usage", kinds)
        self.assertEqual(events[-1].type, "message.done")

    def test_tool_call_accumulates_fragments(self):
        events = self._feed([
            json.dumps({"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "call_1", "function": {"name": "fsa_qc", "arguments": "{\"a\""}}]}}]}),
            json.dumps({"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": ":1}"}}]}}]}),
            json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
        ])
        calls = [e for e in events if e.type == "tool.call"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].data["name"], "fsa_qc")
        self.assertEqual(json.loads(calls[0].data["arguments"]), {"a": 1})

    def test_bad_json_becomes_error_event(self):
        events = translate_openai("{oops", OpenAIState("s"))
        self.assertEqual(events[0].type, "error")


class TestAnthropicTranslate(unittest.TestCase):
    def test_text_and_tool(self):
        state = AnthropicState("s2")
        out = []
        out += translate_anthropic("message_start", json.dumps({"type": "message_start"}), state)
        out += translate_anthropic("content_block_delta",
                                   json.dumps({"delta": {"type": "text_delta", "text": "hi"}}), state)
        out += translate_anthropic("content_block_start", json.dumps(
            {"content_block": {"type": "tool_use", "id": "tu1", "name": "fsa_health"}}), state)
        out += translate_anthropic("content_block_delta", json.dumps(
            {"delta": {"type": "input_json_delta", "partial_json": "{\"station\":"}}), state)
        out += translate_anthropic("content_block_delta", json.dumps(
            {"delta": {"type": "input_json_delta", "partial_json": "\"BADG\"}"}}), state)
        out += translate_anthropic("content_block_stop", json.dumps({"type": "content_block_stop"}), state)
        out += translate_anthropic("message_delta", json.dumps(
            {"delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 7}}), state)
        out += translate_anthropic("message_stop", json.dumps({"type": "message_stop"}), state)

        kinds = [e.type for e in out]
        self.assertEqual(kinds[0], "session.start")
        self.assertIn("message.delta", kinds)
        tool = [e for e in out if e.type == "tool.call"][0]
        self.assertEqual(tool.data["name"], "fsa_health")
        self.assertEqual(json.loads(tool.data["arguments"]), {"station": "BADG"})
        self.assertEqual(out[-1].data["reason"], "tool_calls")

    def test_unknown_event_is_ignored(self):
        self.assertEqual(translate_anthropic("ping", json.dumps({"type": "ping"}), AnthropicState("s")), [])


class TestContract(unittest.TestCase):
    def test_fake_runtime_yields_valid_events(self):
        runtime = FakeRuntime()
        events = list(runtime.run(RuntimeRequest("s3", "hi")))
        self.assertTrue(all(isinstance(e, Event) for e in events))
        self.assertEqual([e.type for e in events], ["session.start", "message.delta", "message.done"])

    def test_unknown_type_is_rejected(self):
        with self.assertRaises(ValueError):
            coerce_events([{"type": "nope", "session_id": "s", "data": {}}])

    def test_event_roundtrip(self):
        raw = {"type": "message.delta", "session_id": "s", "data": {"text": "x"}}
        self.assertEqual(coerce_events([raw])[0].to_dict(), raw)


if __name__ == "__main__":
    unittest.main()
