"""M5-1 端到端链路编排：阶段顺序、输入只来自消息、消息全量落 trace、产物提取。

钉死的核心不变量：

* 每个阶段的输入**只**由它声明的上游消息拼出（「不存在隐藏状态」的机器化表达）；
* 结论校验按**阶段本地**事件进行 —— 前一阶段的 call_id 不能给后一阶段的证据背书；
* 发布的每条消息都以 ``message`` 事件出现在同一条 trace 里，且 payload 一致。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fieldstation import synthetic
from fieldstation.agents.bus import MessageBus
from fieldstation.agents.conclusion import ConclusionRejected
from fieldstation.agents.pipeline import (
    Pipeline,
    PipelineStage,
    observation_payload,
    reading_payloads,
)
from fieldstation.agents.providers.base import ChatMessage, ChatResponse
from fieldstation.agents.runtime import Agent
from fieldstation.agents.tools import ToolRegistry, ToolResult
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter
from fieldstation.store.model import StationReading


class _EchoTool:
    name = "echo"
    description = "回显参数（测试替身）"
    params = {"value": "任意值"}
    risk = "low"

    def invoke(self, args):
        return ToolResult(ok=True, data={"echo": args.get("value")})


class _WorkOrderStub:
    """名字与真工具一致：验证产物提取按工具名走，而不是靠阶段自己声明。"""

    name = "create_work_order"
    description = "建单（测试替身）"
    params = {}
    risk = "low"

    def invoke(self, args):
        return ToolResult(ok=True, data={"order_id": "WO-0001", "status": "open"})


class _RecordingProvider:
    """记录每次 chat 收到的完整消息列表，供「输入从哪来」断言用。"""

    name = "recording"

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[list[ChatMessage]] = []
        self._i = 0

    def chat(self, messages, tools):
        self.calls.append(list(messages))
        response = self.responses[self._i]
        self._i += 1
        return response if isinstance(response, ChatResponse) else ChatResponse(content=response)


def _conclusion(fault_type, evidence):
    return json.dumps({
        "attribution": {
            "fault_type": fault_type,
            "evidence": [{"call_id": c, "tool": t, "finding": f"证据 {c}"}
                         for c, t in evidence],
        },
        "recommendation": "按规程处理",
        "confidence": 0.9,
    }, ensure_ascii=False, sort_keys=True)


def _stage(name, topic, consumes, responses, tools, *, note=""):
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    provider = _RecordingProvider(responses)
    agent = Agent(name=name, system_prompt=f"你是 {name} 助手",
                  provider=provider, tools=registry.describe())
    return PipelineStage(name=name, agent=agent, registry=registry, topic=topic,
                         consumes=tuple(consumes), note=note), provider


def _user_input(provider) -> str:
    return provider.calls[0][-1].content


class TestPipeline(unittest.TestCase):
    def _chain(self, td: str, *, second_responses=None):
        """两阶段链：qc 消费 data.obs，device 消费 qc.verdict。"""
        first = [
            ChatResponse(content="", tool_calls=[{"name": "echo", "args": {"value": 1}}]),
            ChatResponse(content=_conclusion("stage1", [("t0001", "echo")])),
        ]
        second = second_responses if second_responses is not None else [
            ChatResponse(content="", tool_calls=[{"name": "echo", "args": {"value": 2}}]),
            ChatResponse(content=_conclusion("stage2", [("t0001", "echo")])),
        ]
        s1, p1 = _stage("qc", "qc.verdict", ("data.obs",), first, [_EchoTool()],
                        note="评估批次质量")
        s2, p2 = _stage("device", "device.health", ("qc.verdict",), second, [_EchoTool()],
                        note="汇总设备健康度")
        trace_path = Path(td) / "trace.jsonl"
        bus = MessageBus(TraceWriter(trace_path))
        pipe = Pipeline(bus, trace_path, [s1, s2])
        result = pipe.run(intake=[("data.obs", {"n_obs": 3})])
        return result, p1, p2, trace_path

    def test_chain_runs_and_publishes_in_order(self):
        with tempfile.TemporaryDirectory() as td:
            result, _, _, _ = self._chain(td)
            self.assertEqual([o.stage for o in result.outcomes], ["qc", "device"])
            self.assertEqual([m.msg_id for m in result.messages],
                             ["m0001", "m0002", "m0003"])
            self.assertEqual([m.topic for m in result.messages],
                             ["data.obs", "qc.verdict", "device.health"])
            self.assertEqual([m.sender for m in result.messages],
                             ["intake", "qc", "device"])
            self.assertEqual(result.messages[1].refs, ("m0001",))
            self.assertEqual(result.messages[2].refs, ("m0002",))
            self.assertEqual(result.outcomes[0].evidence_call_ids, ("t0001",))
            self.assertEqual(
                result.outcomes[0].conclusion["attribution"]["fault_type"], "stage1")
            self.assertEqual(
                result.messages[1].payload["conclusion"]["attribution"]["fault_type"],
                "stage1")
            self.assertEqual(result.outcomes[0].tool_calls,
                             ({"call_id": "t0001", "tool": "echo", "ok": True},))

    def test_stage_inputs_come_only_from_consumed_messages(self):
        with tempfile.TemporaryDirectory() as td:
            _, p1, p2, _ = self._chain(td)
            text1, text2 = _user_input(p1), _user_input(p2)
            self.assertIn("topic=data.obs", text1)
            self.assertIn('"n_obs":3', text1)
            self.assertIn("评估批次质量", text1)
            self.assertNotIn("qc.verdict", text1)      # 自己还没发布
            self.assertIn("topic=qc.verdict", text2)
            self.assertIn('"fault_type":"stage1"', text2)
            self.assertNotIn("n_obs", text2)           # 没声明消费的数据不进输入
            self.assertNotIn("device.health", text2)
            self.assertIn("汇总设备健康度", text2)

    def test_stage_input_events_record_note_messages_and_digest(self):
        """KI-11：输入全量落 trace —— note、消费的消息、与 run_start 一致的摘要。"""
        with tempfile.TemporaryDirectory() as td:
            _, _, _, trace_path = self._chain(td)
            events = read_trace(trace_path)
            inputs = [e for e in events if e["kind"] == "stage_input"]
            self.assertEqual([e["agent"] for e in inputs], ["qc", "device"])
            self.assertEqual([e["note"] for e in inputs],
                             ["评估批次质量", "汇总设备健康度"])
            self.assertEqual(inputs[0]["msg_ids"], ["m0001"])
            self.assertEqual(inputs[1]["msg_ids"], ["m0002"])
            self.assertTrue(all(e["i"] == 0 for e in inputs))
            run_starts = [e for e in events if e["kind"] == "run_start"]
            self.assertEqual([e["input_digest"] for e in inputs],
                             [e["input_digest"] for e in run_starts])

    def test_all_messages_land_in_trace_with_full_payload(self):
        with tempfile.TemporaryDirectory() as td:
            result, _, _, trace_path = self._chain(td)
            events = read_trace(trace_path)
            message_events = [e for e in events if e["kind"] == "message"]
            self.assertEqual([e["msg_id"] for e in message_events],
                             ["m0001", "m0002", "m0003"])
            for event, message in zip(message_events, result.messages):
                self.assertEqual(event, {**message.to_dict(), "kind": "message"})
            self.assertEqual(message_events[0]["payload"], {"n_obs": 3})
            # 消息事件与阶段运行事件在同一条 trace 里全序排列
            kinds = [e["kind"] for e in events]
            self.assertEqual(kinds.index("message"), 0)
            self.assertIn("run_start", kinds)
            self.assertIn("run_end", kinds)

    def test_stage_conclusion_validated_against_own_events_only(self):
        # qc 阶段的 t0001 是成功调用；device 阶段不调工具却引用它 —— 必须被拒
        bad = [ChatResponse(content=_conclusion("stage2", [("t0001", "echo")]))]
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ConclusionRejected):
                self._chain(td, second_responses=bad)

    def test_non_json_conclusion_is_rejected(self):
        bad = [ChatResponse(content="我觉得这批数据没问题")]
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ConclusionRejected):
                self._chain(td, second_responses=bad)

    def test_artifacts_extracted_by_tool_name(self):
        responses = [
            ChatResponse(content="", tool_calls=[
                {"name": "create_work_order", "args": {"station_id": "BADG"}}]),
            ChatResponse(content=_conclusion("dispatch", [("t0001", "create_work_order")])),
        ]
        with tempfile.TemporaryDirectory() as td:
            stage, _ = _stage("dispatch", "dispatch.work_order", ("data.obs",),
                              responses, [_WorkOrderStub()])
            trace_path = Path(td) / "trace.jsonl"
            pipe = Pipeline(MessageBus(TraceWriter(trace_path)), trace_path, [stage])
            result = pipe.run(intake=[("data.obs", {})])
            self.assertEqual(result.outcomes[0].artifacts["work_order"]["order_id"],
                             "WO-0001")

    def test_tool_call_summary_marks_unregistered_failures(self):
        responses = [
            ChatResponse(content="", tool_calls=[
                {"name": "not_registered", "args": {}},
                {"name": "echo", "args": {"value": 1}}]),
            ChatResponse(content=_conclusion("qc", [("t0002", "echo")])),
        ]
        with tempfile.TemporaryDirectory() as td:
            stage, _ = _stage("qc", "qc.verdict", ("data.obs",), responses, [_EchoTool()])
            trace_path = Path(td) / "trace.jsonl"
            pipe = Pipeline(MessageBus(TraceWriter(trace_path)), trace_path, [stage])
            result = pipe.run(intake=[("data.obs", {})])
            self.assertEqual(result.outcomes[0].tool_calls,
                             ({"call_id": "t0001", "tool": "not_registered", "ok": False},
                              {"call_id": "t0002", "tool": "echo", "ok": True}))

    def test_duplicate_stage_names_or_topics_rejected(self):
        responses = [ChatResponse(content=_conclusion("x", [("t0001", "echo")])),
                     ChatResponse(content="")]
        s1, _ = _stage("qc", "qc.verdict", (), responses[:1], [_EchoTool()])
        s2, _ = _stage("qc", "other.topic", (), responses[:1], [_EchoTool()])
        with tempfile.TemporaryDirectory() as td:
            trace_path = Path(td) / "trace.jsonl"
            with self.assertRaises(ValueError):
                Pipeline(MessageBus(TraceWriter(trace_path)), trace_path, [s1, s2])

    def test_identical_runs_produce_identical_trace_bytes(self):
        def run(td: str) -> bytes:
            _, _, _, trace_path = self._chain(td)
            return trace_path.read_bytes()

        with tempfile.TemporaryDirectory() as td1, tempfile.TemporaryDirectory() as td2:
            self.assertEqual(run(td1), run(td2))


class TestBridges(unittest.TestCase):
    def test_observation_payload_gives_ready_slip_tool_args(self):
        cfg = synthetic.default_cfg(n_epochs=4, systems=["GPS"],
                                    sats={"GPS": [1]}, slips=[])
        obs, _, _ = synthetic.generate(cfg)
        payload = observation_payload(obs)
        self.assertEqual(payload["station"], "SYNTH")
        self.assertEqual(payload["n_obs"], 8)          # 4 历元 × 1 星 × 2 信号
        self.assertEqual([g["key"] for g in payload["groups"]], ["GPS 01"])
        group = payload["groups"][0]
        self.assertEqual(group["n_epochs"], 4)
        args = group["tool_args"]
        self.assertEqual((args["system"], args["signal_1"], args["signal_2"]),
                         ("GPS", "L1", "L2"))
        self.assertEqual(len(args["series"]), 4)
        row = args["series"][0]
        self.assertEqual(set(row), {"gps_week", "gps_tow_s", "quality_flag", "L1", "L2"})
        self.assertEqual(set(row["L1"]), {"psr_m", "adr_cycles"})
        json.dumps(payload, allow_nan=False)

    def test_observation_payload_respects_max_groups(self):
        cfg = synthetic.default_cfg(n_epochs=2, systems=["GPS"],
                                    sats={"GPS": [1, 2, 3]}, slips=[])
        obs, _, _ = synthetic.generate(cfg)
        payload = observation_payload(obs, max_groups=2)
        self.assertEqual([g["key"] for g in payload["groups"]], ["GPS 01", "GPS 02"])
        self.assertEqual(payload["groups_total"], 3)

    def test_observation_payload_rejects_empty_or_mixed_station(self):
        with self.assertRaises(ValueError):
            observation_payload([])
        cfg = synthetic.default_cfg(n_epochs=1, systems=["GPS"],
                                    sats={"GPS": [1]}, slips=[])
        obs, _, _ = synthetic.generate(cfg)
        obs[-1].station = "OTHER"
        with self.assertRaises(ValueError):
            observation_payload(obs)

    def test_reading_payloads_use_store_dict(self):
        reading = StationReading(
            station_id="BADG", sensor="power", metric="voltage",
            value=12.0, unit="V",
            observed_at=datetime(2026, 10, 19, 8, 0, tzinfo=timezone.utc),
            quality_flag="")
        payloads = reading_payloads([reading])
        self.assertEqual(payloads[0], {
            "station_id": "BADG", "sensor": "power", "metric": "voltage",
            "value": 12.0, "unit": "V",
            "observed_at": "2026-10-19T08:00:00+00:00", "quality_flag": ""})
        json.dumps(payloads, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
