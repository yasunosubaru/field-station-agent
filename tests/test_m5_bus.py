"""M5-1 进程内消息总线：顺序号、全量落 trace、投递顺序、序列化纪律。

这些测试钉死的是 M5-4「消息全量落 trace、不存在隐藏状态」的地基：
* msg_id 只由发布顺序决定 —— 不含时间戳/随机量，两次运行 trace 才能逐字节相同；
* trace 里的 ``message`` 事件带 payload **本体**（不是 digest），事后核对时
  不必重放代码就能读出「谁在什么时候说了什么」；
* payload 必须可 JSON 序列化且拒绝 NaN/Inf —— 脏 payload 进 trace 会让
  下游对拍与归档全部失效，宁可发布时就炸。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.agents.bus import Message, MessageBus
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter


class TestMessageBus(unittest.TestCase):
    def _bus(self, td: str) -> tuple[MessageBus, Path]:
        path = Path(td) / "trace.jsonl"
        return MessageBus(TraceWriter(path)), path

    def test_publish_assigns_sequential_ids_and_writes_full_message(self):
        with tempfile.TemporaryDirectory() as td:
            bus, path = self._bus(td)
            first = bus.publish("data.obs", "intake", {"n_obs": 3})
            second = bus.publish("data.device", "intake", {"readings": []})
            self.assertEqual((first.msg_id, second.msg_id), ("m0001", "m0002"))
            self.assertEqual(first.to_dict(), {
                "msg_id": "m0001", "topic": "data.obs", "sender": "intake",
                "refs": [], "payload": {"n_obs": 3}})
            events = read_trace(path)
            self.assertEqual([e["kind"] for e in events], ["message", "message"])
            self.assertEqual(events[0], {**first.to_dict(), "kind": "message"})
            self.assertEqual(events[1], {**second.to_dict(), "kind": "message"})

    def test_inbox_gets_messages_in_publish_order_and_stays_isolated(self):
        with tempfile.TemporaryDirectory() as td:
            bus, _ = self._bus(td)
            bus.subscribe("qc", "data.obs")
            bus.subscribe("archive", "qc.verdict")
            bus.publish("data.obs", "intake", {"i": 1})
            bus.publish("unrelated.topic", "x", {"i": 99})
            bus.publish("data.obs", "intake", {"i": 2})
            self.assertEqual([m.payload["i"] for m in bus.inbox("qc")], [1, 2])
            self.assertEqual(bus.inbox("archive"), ())
            self.assertEqual([m.msg_id for m in bus.messages], ["m0001", "m0002", "m0003"])

    def test_inbox_of_unknown_subscriber_raises(self):
        with tempfile.TemporaryDirectory() as td:
            bus, _ = self._bus(td)
            with self.assertRaises(KeyError):
                bus.inbox("nobody")

    def test_duplicate_subscription_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            bus, _ = self._bus(td)
            bus.subscribe("qc", "data.obs")
            with self.assertRaises(ValueError) as cm:
                bus.subscribe("qc", "data.obs")
            self.assertIn("重复订阅", str(cm.exception))
            bus.subscribe("qc", "data.device")  # 同一收件人订另一个主题是合法的

    def test_payload_must_be_json_serializable(self):
        with tempfile.TemporaryDirectory() as td:
            bus, _ = self._bus(td)
            for bad in ({"x": float("nan")}, {"x": {1, 2}}, {"x": object()}):
                with self.assertRaises(ValueError):
                    bus.publish("t", "s", bad)
            with self.assertRaises(ValueError):
                bus.publish("t", "s", ["not", "a", "dict"])  # type: ignore[arg-type]

    def test_topic_sender_refs_must_be_nonempty(self):
        with tempfile.TemporaryDirectory() as td:
            bus, _ = self._bus(td)
            with self.assertRaises(ValueError):
                bus.publish("", "s", {})
            with self.assertRaises(ValueError):
                bus.publish("t", "  ", {})
            with self.assertRaises(ValueError):
                bus.publish("t", "s", {}, refs=("",))

    def test_refs_recorded_in_order(self):
        with tempfile.TemporaryDirectory() as td:
            bus, path = self._bus(td)
            bus.publish("a", "s", {})
            bus.publish("b", "s", {})
            msg = bus.publish("c", "s", {"ok": True}, refs=("m0002", "m0001"))
            self.assertEqual(msg.refs, ("m0002", "m0001"))
            self.assertEqual(read_trace(path)[-1]["refs"], ["m0002", "m0001"])

    def test_identical_runs_produce_identical_trace_bytes(self):
        def run(td: str) -> bytes:
            bus, path = self._bus(td)
            bus.subscribe("qc", "data.obs")
            bus.publish("data.obs", "intake", {"n_obs": 3, "note": "中文"})
            bus.publish("qc.verdict", "qc", {"fault_type": "none"}, refs=("m0001",))
            return path.read_bytes()

        with tempfile.TemporaryDirectory() as td1, tempfile.TemporaryDirectory() as td2:
            one, two = run(td1), run(td2)
        self.assertEqual(one, two)
        self.assertNotIn(b"\r\n", one)

    def test_no_trace_writer_still_logs_messages(self):
        bus = MessageBus()
        bus.publish("t", "s", {"i": 1})
        self.assertEqual([m.msg_id for m in bus.messages], ["m0001"])

    def test_message_is_immutable(self):
        with tempfile.TemporaryDirectory() as td:
            bus, _ = self._bus(td)
            msg = bus.publish("t", "s", {"i": 1})
            with self.assertRaises(Exception):
                msg.topic = "other"  # type: ignore[misc]

    def test_payload_is_copied_not_aliased(self):
        with tempfile.TemporaryDirectory() as td:
            bus, path = self._bus(td)
            payload = {"i": 1}
            msg = bus.publish("t", "s", payload)
            payload["i"] = 999
            self.assertEqual(msg.payload, {"i": 1})
            self.assertEqual(read_trace(path)[0]["payload"], {"i": 1})
            self.assertIsInstance(json.dumps(msg.payload), str)


if __name__ == "__main__":
    unittest.main()
