# -*- coding: utf-8 -*-
"""运行时网关的离线测试：注册表、SSE 帧、错误事件。不连网。"""
import json
import unittest

from fieldstation.runtimes import FakeRuntime, RuntimeRequest, RuntimeUnavailable
from fieldstation.runtimes.service import (RuntimeRegistry, sse_bytes, status_payload,
                                           stream_chat)


class BrokenRuntime:
    name = "broken"

    def available(self):
        return True

    def run(self, req):
        raise RuntimeError("boom")

    def cancel(self, session_id):
        return None


class OffRuntime:
    name = "off"

    def available(self):
        return False

    def run(self, req):
        raise AssertionError("不该被调用")

    def cancel(self, session_id):
        return None


def frames(chunks):
    """把 SSE 字节流拆成 (event, data) 列表。"""
    out = []
    for chunk in chunks:
        text = chunk.decode("utf-8")
        assert text.endswith("\n\n")
        lines = [line for line in text.splitlines() if line]
        event = next(line.split(":", 1)[1].strip() for line in lines if line.startswith("event:"))
        data = next(line.split(":", 1)[1].strip() for line in lines if line.startswith("data:"))
        out.append((event, json.loads(data)))
    return out


class TestRegistry(unittest.TestCase):
    def test_names_and_get(self):
        reg = RuntimeRegistry([FakeRuntime()])
        self.assertEqual(reg.names(), ["fake"])
        self.assertIsInstance(reg.get("fake"), FakeRuntime)

    def test_unknown_raises_with_options(self):
        reg = RuntimeRegistry([FakeRuntime()])
        with self.assertRaises(RuntimeUnavailable) as ctx:
            reg.get("opencode")
        self.assertIn("fake", str(ctx.exception))

    def test_pick_does_not_fall_back(self):
        reg = RuntimeRegistry([FakeRuntime(), OffRuntime()])
        with self.assertRaises(RuntimeUnavailable):
            reg.pick("off")      # 不许自动换 fake

    def test_status_reports_both(self):
        reg = RuntimeRegistry([FakeRuntime(), OffRuntime()])
        status = reg.status()
        self.assertTrue(status["fake"]["available"])
        self.assertFalse(status["off"]["available"])

    def test_status_survives_probe_exception(self):
        class Exploding:
            name = "boom"

            def available(self):
                raise RuntimeError("probe failed")

            def run(self, req):
                return iter(())

            def cancel(self, session_id):
                return None

        status = RuntimeRegistry([Exploding()]).status()
        self.assertFalse(status["boom"]["available"])
        self.assertIn("probe failed", status["boom"]["error"])


class TestStream(unittest.TestCase):
    def test_happy_path_frames(self):
        reg = RuntimeRegistry([FakeRuntime()])
        got = frames(stream_chat(reg, {"runtime": "fake", "session_id": "s1", "prompt": "hi"}))
        self.assertEqual([name for name, _ in got], ["session.start", "message.delta", "message.done"])
        self.assertEqual(got[1][1]["data"]["text"], "（演示）")
        self.assertEqual(got[0][1]["session_id"], "s1")

    def test_unavailable_runtime_yields_error_event(self):
        reg = RuntimeRegistry([OffRuntime()])
        got = frames(stream_chat(reg, {"runtime": "off", "session_id": "s2", "prompt": "x"}))
        self.assertEqual(got[0][0], "error")
        self.assertEqual(got[0][1]["data"]["class"], "environment")

    def test_unknown_runtime_yields_error_event(self):
        reg = RuntimeRegistry([FakeRuntime()])
        got = frames(stream_chat(reg, {"runtime": "nope", "session_id": "s3", "prompt": "x"}))
        self.assertEqual(got[0][0], "error")
        self.assertIn("没有这个运行时", got[0][1]["data"]["message"])

    def test_runtime_exception_becomes_error_event(self):
        reg = RuntimeRegistry([BrokenRuntime()])
        got = frames(stream_chat(reg, {"runtime": "broken", "session_id": "s4", "prompt": "x"}))
        self.assertEqual(got[-1][0], "error")
        self.assertEqual(got[-1][1]["data"]["class"], "execution")

    def test_sse_frame_shape(self):
        raw = sse_bytes(__import__("fieldstation.runtimes", fromlist=["Event"]).Event(
            "message.delta", "s", {"text": "你好"}))
        text = raw.decode("utf-8")
        self.assertTrue(text.startswith("event: message.delta\n"))
        self.assertIn('"text": "你好"', text)
        self.assertTrue(text.endswith("\n\n"))

    def test_status_payload_shape(self):
        payload = status_payload(RuntimeRegistry([FakeRuntime()]))
        self.assertEqual(payload["model_default"], "deepseek-v4.1-flash")
        self.assertIn("fake", payload["runtimes"])


if __name__ == "__main__":
    unittest.main()
