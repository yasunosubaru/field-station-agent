"""一致性：``pipeline.py`` 与五阶段状态图对同一份合成输入的阶段结论必须相同。

用例只用仓库里已有的合成输入（``harness/fixtures/m5_pipeline_replay_20261020.json``
的 ``sample`` 参数），不新增重复数据文件。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fieldstation.graph.five_stage import (
    STAGE_ORDER,
    STAGE_TOPICS,
    run_five_stage,
)
from fieldstation.graph.parity import (
    COMPARE_FIELDS,
    compare,
    compare_stage_records,
    load_scenario,
    scenario_from_sample,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "harness" / "fixtures" / "m5_pipeline_replay_20261020.json"


class TestParityOnCommittedFixture(unittest.TestCase):
    def test_graph_and_pipeline_agree_field_by_field(self):
        scenario = load_scenario(FIXTURE)
        self.assertEqual([topic for topic, _ in scenario.intake],
                         ["data.observations", "data.device"])
        with tempfile.TemporaryDirectory() as td:
            pipeline_records, graph_records, problems = compare(scenario, td)
        self.assertEqual(len(pipeline_records), len(STAGE_ORDER))
        self.assertEqual([record["stage"] for record in graph_records],
                         list(STAGE_ORDER))
        self.assertEqual(problems, [], "\n".join(problems))
        for record in pipeline_records:
            self.assertEqual(set(record), {
                "stage", "topic", "message_id", "conclusion",
                "evidence_call_ids", "tool_calls", "artifacts"})

    def test_graph_result_has_pipeline_result_shape(self):
        scenario = load_scenario(FIXTURE)
        from fieldstation.agents.bus import MessageBus
        from fieldstation.agents.pipeline import PipelineResult
        from fieldstation.agents.trace.writer import TraceWriter
        from fieldstation.graph.parity import build_stage_set

        with tempfile.TemporaryDirectory() as td:
            stages = build_stage_set(Path(td) / "setup", scenario)
            trace_path = Path(td) / "trace.jsonl"
            bus = MessageBus(TraceWriter(trace_path))
            result = run_five_stage(stages, bus=bus, trace_path=trace_path,
                                    intake=list(scenario.intake))
            self.assertIsInstance(result.pipeline_result, PipelineResult)
            self.assertEqual(result.to_pipeline_result(), result.pipeline_result)
            self.assertEqual([outcome.stage for outcome in result.stages],
                             list(STAGE_ORDER))
            self.assertEqual([message.topic for message in result.messages],
                             ["data.observations", "data.device"]
                             + [STAGE_TOPICS[name] for name in STAGE_ORDER])
            self.assertEqual(set(result.artifacts), set(STAGE_ORDER))
            self.assertTrue(result.checks["chain_complete"])
            self.assertTrue(result.checks["messages_in_trace"])
            self.assertTrue(result.checks["conclusions_valid"])
            self.assertTrue(result.checks["stage_inputs_traced"])
            # 工单与归档产物的键来自 pipeline.py 的 ARTIFACT_KEYS。
            self.assertIn("work_order",
                          result.artifacts["operations_dispatch"])
            self.assertIn("archive", result.artifacts["archive"])

    def test_explicit_intake_fixture_is_accepted(self):
        scenario = scenario_from_sample(json.loads(
            FIXTURE.read_text(encoding="utf-8"))["sample"])
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "input.json"
            path.write_text(json.dumps(
                {"intake": [[topic, payload]
                            for topic, payload in scenario.intake]},
                ensure_ascii=False), encoding="utf-8")
            loaded = load_scenario(path)
        self.assertEqual(loaded.intake, scenario.intake)


class TestComparisonDetectsDrift(unittest.TestCase):
    def test_changed_conclusion_is_reported(self):
        left = [{"stage": "qc", "topic": "qc.verdict", "message_id": "m0003",
                 "conclusion": {"attribution": {"fault_type": "a"}},
                 "evidence_call_ids": ["t0001"], "tool_calls": [],
                 "artifacts": {}}]
        right = json.loads(json.dumps(left))
        right[0]["conclusion"]["attribution"]["fault_type"] = "b"
        problems = compare_stage_records(left, right)
        self.assertEqual(len(problems), 1)
        self.assertIn("qc.conclusion", problems[0])

    def test_changed_stage_sequence_is_reported(self):
        left = [{"stage": "qc"}]
        right = [{"stage": "device_monitor"}]
        problems = compare_stage_records(left, right)
        self.assertTrue(problems)
        self.assertIn("阶段序列不一致", problems[0])

    def test_compared_field_set_matches_stage_outcome_interface(self):
        self.assertEqual(COMPARE_FIELDS, (
            "stage", "topic", "message_id", "conclusion",
            "evidence_call_ids", "tool_calls", "artifacts"))


class TestParityCli(unittest.TestCase):
    def test_module_cli_exits_zero_and_prints_agreement(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = "src"
        env["PYTHONIOENCODING"] = "utf-8"
        run = subprocess.run(
            [sys.executable, "-m", "fieldstation.graph.parity",
             "--fixture", str(FIXTURE)],
            cwd=str(ROOT), env=env, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=240)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("一致", run.stdout)
        for name in STAGE_ORDER:
            self.assertIn(name, run.stdout)


if __name__ == "__main__":
    unittest.main()
