"""M3-2/M3-3：结构化结论、证据引用、trace 回放所需字段。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.agents import runtime
from fieldstation.agents.conclusion import (
    ConclusionContract,
    ConclusionRejected,
    validate_conclusion,
)
from fieldstation.agents.providers.base import ChatResponse
from fieldstation.agents.providers.fake import FakeProvider
from fieldstation.agents.tools import ToolRegistry
from fieldstation.agents.tools.qc_tools import magnitude_verdict_tool
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter


def _conclusion(**overrides) -> dict:
    data = {
        "attribution": {
            "fault_type": "nonphysical_rmse",
            "evidence": [{
                "call_id": "t0001",
                "tool": "magnitude_verdict",
                "finding": "RMSE 126922.1 TECU 超过物理上限",
            }],
        },
        "recommendation": "拒绝该反演输出并复查接收机钟与定平链路",
        "confidence": 0.99,
    }
    data.update(overrides)
    return data


def _trace(call_id="t0001", tool="magnitude_verdict", ok=True) -> list[dict]:
    return [
        {"kind": "run_start", "agent": "qc", "i": 0, "input_digest": "x"},
        {"kind": "provider_call", "agent": "qc", "i": 0, "input_digest": "x"},
        {
            "kind": "tool_call", "agent": "qc", "i": 1,
            "input_digest": "x", "call_id": call_id, "tool": tool,
            "args": {"rmse": 126922.1}, "approved": True,
        },
        {
            "kind": "tool_result", "agent": "qc", "i": 1,
            "input_digest": "x", "call_id": call_id, "tool": tool,
            "ok": ok, "error": None,
            "result": {"rejected": True} if ok else None,
        },
        {"kind": "run_end", "agent": "qc", "i": 2, "input_digest": "x"},
    ]


class TestConclusionContract(unittest.TestCase):
    def test_valid_conclusion(self):
        result = validate_conclusion(
            json.dumps(_conclusion(), ensure_ascii=False), _trace())
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.conclusion["attribution"]["fault_type"],
                         "nonphysical_rmse")
        self.assertEqual(result.evidence_call_ids, ("t0001",))

    def test_non_json_rejected(self):
        result = validate_conclusion("我觉得大概有问题", _trace())
        self.assertFalse(result.valid)
        self.assertIn("JSON", "；".join(result.errors))

    def test_missing_field_rejected(self):
        data = _conclusion()
        del data["recommendation"]
        result = validate_conclusion(json.dumps(data), _trace())
        self.assertFalse(result.valid)
        self.assertIn("recommendation", "；".join(result.errors))

    def test_fabricated_call_id_rejected(self):
        result = validate_conclusion(json.dumps(_conclusion()), _trace("t9999"))
        self.assertFalse(result.valid)
        self.assertIn("不存在", "；".join(result.errors))

    def test_tool_name_must_match_call(self):
        result = validate_conclusion(
            json.dumps(_conclusion(), ensure_ascii=False),
            _trace(tool="continuity_verdict"))
        self.assertFalse(result.valid)
        self.assertIn("工具名", "；".join(result.errors))

    def test_failed_tool_call_cannot_be_evidence(self):
        result = validate_conclusion(
            json.dumps(_conclusion(), ensure_ascii=False),
            _trace(ok=False))
        self.assertFalse(result.valid)
        self.assertIn("成功", "；".join(result.errors))

    def test_confidence_range_and_type(self):
        for bad in (-0.01, 1.01, True, "0.9", float("nan")):
            with self.subTest(bad=bad):
                data = _conclusion(confidence=bad)
                result = validate_conclusion(
                    json.dumps(data, ensure_ascii=False), _trace())
                self.assertFalse(result.valid)
                self.assertIn("confidence", "；".join(result.errors))

    def test_duplicate_evidence_rejected(self):
        data = _conclusion()
        data["attribution"]["evidence"].append(
            dict(data["attribution"]["evidence"][0]))
        result = validate_conclusion(json.dumps(data, ensure_ascii=False), _trace())
        self.assertFalse(result.valid)
        self.assertIn("重复", "；".join(result.errors))

    def test_empty_evidence_rejected(self):
        data = _conclusion()
        data["attribution"]["evidence"] = []
        result = validate_conclusion(json.dumps(data, ensure_ascii=False), _trace())
        self.assertFalse(result.valid)
        self.assertIn("至少", "；".join(result.errors))


class TestRuntimeContract(unittest.TestCase):
    def _agent(self, responses):
        reg = ToolRegistry()
        reg.register(magnitude_verdict_tool())
        return (
            runtime.Agent(name="qc", system_prompt="s",
                          provider=FakeProvider(responses),
                          tools=reg.describe()),
            reg,
        )

    def test_valid_contract_is_marked_in_trace(self):
        agent, reg = self._agent([
            ChatResponse(content="", tool_calls=[
                {"name": "magnitude_verdict", "args": {"rmse": 126922.1}}]),
            json.dumps(_conclusion(), ensure_ascii=False),
        ])
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            out = runtime.run(
                agent, "评估", TraceWriter(path), registry=reg,
                contract=ConclusionContract(), capture_tool_results=True)
            events = read_trace(path)
        self.assertEqual(json.loads(out), _conclusion())
        valid = [e for e in events if e["kind"] == "conclusion_valid"]
        self.assertEqual(len(valid), 1)
        self.assertEqual(valid[0]["evidence_call_ids"], ["t0001"])
        self.assertNotIn("conclusion_rejected",
                         [e["kind"] for e in events])

    def test_invalid_contract_raises_and_marks_rejection(self):
        bad = _conclusion(confidence=1.7)
        agent, reg = self._agent([
            ChatResponse(content="", tool_calls=[
                {"name": "magnitude_verdict", "args": {"rmse": 126922.1}}]),
            json.dumps(bad, ensure_ascii=False),
        ])
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            with self.assertRaises(ConclusionRejected):
                runtime.run(
                    agent, "评估", TraceWriter(path), registry=reg,
                    contract=ConclusionContract(), capture_tool_results=True)
            events = read_trace(path)
        rejected = [e for e in events if e["kind"] == "conclusion_rejected"]
        self.assertEqual(len(rejected), 1)
        self.assertIn("confidence", "；".join(rejected[0]["errors"]))
        self.assertNotIn("conclusion_valid",
                         [e["kind"] for e in events])

    def test_contract_evidence_must_point_to_real_successful_call(self):
        fabricated = _conclusion()
        fabricated["attribution"]["evidence"][0]["call_id"] = "t9999"
        agent, reg = self._agent([
            ChatResponse(content="", tool_calls=[
                {"name": "magnitude_verdict", "args": {"rmse": 126922.1}}]),
            json.dumps(fabricated, ensure_ascii=False),
        ])
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            with self.assertRaises(ConclusionRejected):
                runtime.run(
                    agent, "评估", TraceWriter(path), registry=reg,
                    contract=ConclusionContract(), capture_tool_results=True)
            events = read_trace(path)
        rejected = [e for e in events if e["kind"] == "conclusion_rejected"][0]
        self.assertIn("不存在", "；".join(rejected["errors"]))


class TestTracePayloadAndMetrics(unittest.TestCase):
    def test_tool_result_and_call_share_call_id(self):
        reg = ToolRegistry()
        reg.register(magnitude_verdict_tool())
        agent = runtime.Agent(
            name="qc", system_prompt="s",
            provider=FakeProvider([
                ChatResponse(content="", tool_calls=[
                    {"name": "magnitude_verdict", "args": {"rmse": 43.1}}]),
                "答",
            ]),
            tools=reg.describe(),
        )
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            runtime.run(agent, "评估", TraceWriter(path), registry=reg,
                        capture_tool_results=True)
            events = read_trace(path)
        call = [e for e in events if e["kind"] == "tool_call"][0]
        result = [e for e in events if e["kind"] == "tool_result"][0]
        self.assertEqual(call["call_id"], result["call_id"])
        self.assertEqual(call["args"], {"rmse": 43.1})
        self.assertEqual(result["result"], {"rejected": False, "rmse": 43.1,
                                            "cap_tecu": 500.0,
                                            "applicable": True, "reason": "",
                                            "criterion": None})

    def test_metrics_sink_records_usage_and_nonnegative_duration(self):
        reg = ToolRegistry()
        reg.register(magnitude_verdict_tool())
        agent = runtime.Agent(
            name="qc", system_prompt="s",
            provider=FakeProvider([
                ChatResponse(
                    content="", tool_calls=[
                        {"name": "magnitude_verdict", "args": {"rmse": 43.1}}],
                    usage={"prompt_tokens": 7, "completion_tokens": 2}),
                ChatResponse(content="答", usage={
                    "prompt_tokens": 9, "completion_tokens": 1}),
            ]),
            tools=reg.describe(),
        )
        with tempfile.TemporaryDirectory() as td:
            trace = Path(td) / "t.jsonl"
            metrics = Path(td) / "m.jsonl"
            runtime.run(agent, "评估", TraceWriter(trace), registry=reg,
                        metrics=TraceWriter(metrics))
            metric_events = read_trace(metrics)
        provider_metrics = [
            e for e in metric_events if e["kind"] == "provider_metrics"]
        tool_metrics = [
            e for e in metric_events if e["kind"] == "tool_metrics"]
        self.assertEqual(len(provider_metrics), 2)
        self.assertEqual(provider_metrics[0]["usage"],
                         {"prompt_tokens": 7, "completion_tokens": 2})
        self.assertGreaterEqual(provider_metrics[0]["duration_ms"], 0)
        self.assertEqual(len(tool_metrics), 1)
        self.assertGreaterEqual(tool_metrics[0]["duration_ms"], 0)


if __name__ == "__main__":
    unittest.main()
