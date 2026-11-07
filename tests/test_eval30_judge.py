#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`tools/eval30_judge.py` 的行为覆盖（契约 §1.2 的六条机器规则）。

## 为什么每条规则都要有负例

判分器的错法只有一个方向是危险的：**把 FAIL 判成 PASS**。评分脚本自己"太宽容"
和评分口径本身错，在一份报告里长得一模一样 —— 都不会报错，只会让结论变好看。
所以六条规则各有一个正例和一个反例，反例比正例更重要：

| 规则 | 反例钉住什么 |
|---|---|
| S1 | 工具链顺序错了 / 根本没调 |
| S2 | 证据引用失败调用、工具名不符、重复引用 |
| S3 | 结论不合 ADR-004、数值越界、区间里找不到字段 |
| S4 | 哈希不符、bytes 不符、路径跑出 artifacts/ |
| S5 | pending 期间就执行、拒绝后仍执行、结论先于请求 |
| S6 | 把"不能机判"当成通过（这条最容易犯） |

## 契约解析也要钉

`eval-30.md` 是判分口径的唯一来源，解析器读错表就等于换了口径。所以这里断言：
解析出 30 条、EV-17 的 `row_count` 是 4,924,800、EV-08 明确"不需要结论"、
EV-08 / EV-20 是仅有的两条可机判 S6。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "eval30_judge.py"

sys.path.insert(0, str(ROOT / "tools"))
import eval30_judge as J  # noqa: E402


def _events(*items: dict) -> list[dict]:
    return list(items)


def _call(call_id: str, name: str, arguments: str = "{}") -> dict:
    return {"type": "tool.call", "session_id": "s1", "data": {"id": call_id, "name": name, "arguments": arguments}}


def _result(call_id: str, name: str, ok: bool = True, data: dict | None = None,
            error: dict | None = None, artifact: dict | None = None) -> dict:
    d: dict = {"id": call_id, "name": name, "ok": ok}
    if data is not None:
        d["data"] = data
    if error is not None:
        d["error"] = error
    if artifact is not None:
        d["artifact_ref"] = artifact
    return {"type": "tool.result", "session_id": "s1", "data": d}


def _done(content) -> dict:
    return {"type": "message.done", "session_id": "s1", "data": {"reason": "stop", "content": content}}


def _conclusion(evidence: list[dict], **extra) -> str:
    body = {
        "attribution": {"fault_type": "data_gap", "evidence": evidence},
        "recommendation": "重新采集该时段",
        "confidence": 0.8,
    }
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


class ContractParsing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tasks = {t.task_id: t for t in J.load_tasks()}

    def test_thirty_tasks(self):
        self.assertEqual(len(self.tasks), 30)

    def test_tool_chain_parsed(self):
        self.assertEqual(
            self.tasks["EV-02"].tools,
            ["robust_stats", "slip_detect", "continuity_verdict", "magnitude_verdict"])

    def test_exact_values_come_from_expect_column(self):
        """`row_count=4,924,800` 写在「期望输出」列，不在「判分方式」列。"""
        exact = dict(self.tasks["EV-17"].exact)
        self.assertEqual(exact["row_count"], 4924800.0)
        self.assertEqual(exact["epochs"], 86400.0)

    def test_ranges_parsed(self):
        ranges = {name: (lo, hi) for name, lo, hi in self.tasks["EV-18"].ranges}
        self.assertEqual(ranges["p50"], (42.0, 48.0))
        self.assertEqual(ranges["p99"], (52.0, 59.0))

    def test_zero_tool_tasks(self):
        for tid in ("EV-08", "EV-29", "EV-30"):
            self.assertEqual(self.tasks[tid].tools, [], tid)

    def test_no_conclusion_tasks(self):
        """EV-08 明确「不给结论」，EV-29/EV-30 是 CLI 与对照表，也没有对话结论。"""
        for tid in ("EV-08", "EV-29", "EV-30"):
            self.assertFalse(self.tasks[tid].needs_conclusion, tid)

    def test_only_two_s6_are_machine_checkable(self):
        """其余 S6 必须落进 manual —— 把"不能机判"当通过是这个脚本最贵的错法。"""
        self.assertEqual(set(J.S6_MACHINE), {"EV-08", "EV-20"})

    def test_empty_contract_is_fatal(self):
        """解析不出任务必须是硬失败，不能静默返回空表然后"0 条全部通过"。"""
        with self.assertRaises(J.JudgeInputError):
            J.parse_tasks_or_exit("| 不是 | 任务表 |\n|---|---|")


class S1ToolChain(unittest.TestCase):
    def setUp(self):
        self.task = next(t for t in J.load_tasks() if t.task_id == "EV-17")

    def test_pass_in_order(self):
        ev = _events(_call("t1", "data_query"),
                     _result("t1", "data_query", data={"row_count": 4924800, "epochs": 86400}),
                     _done(_conclusion([{"call_id": "t1", "tool": "data_query", "finding": "行数"}])))
        row = J.Judge(self.task, ev).run()
        self.assertEqual(row["failed_rules"], [], row["notes"])

    def test_fail_wrong_order(self):
        task = next(t for t in J.load_tasks() if t.task_id == "EV-21")
        ev = _events(_call("t1", "data_query"), _result("t1", "data_query"),
                     _call("t2", "data_partitions"), _result("t2", "data_partitions"))
        row = J.Judge(task, ev).run()
        self.assertIn("S1", row["failed_rules"])

    def test_pass_with_inserted_readonly_call(self):
        """契约 §1.2：未注明「恰好」时允许插入只读补充调用。"""
        ev = _events(_call("t0", "kb_search"), _result("t0", "kb_search"),
                     _call("t1", "data_query"), _result("t1", "data_query"))
        row = J.Judge(self.task, ev).run()
        self.assertNotIn("S1", row["failed_rules"], row["notes"])

    def test_fail_zero_calls(self):
        row = J.Judge(self.task, _events()).run()
        self.assertIn("S1", row["failed_rules"])

class S2EvidenceClosure(unittest.TestCase):
    def setUp(self):
        self.task = next(t for t in J.load_tasks() if t.task_id == "EV-01")

    def test_pass(self):
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health", data={"health_score": 0.9}),
                     _call("t2", "kb_search"), _result("t2", "kb_search", data={}),
                     _done(_conclusion([{"call_id": "t1", "tool": "station_health", "finding": "健康度 0.9"}])))
        row = J.Judge(self.task, ev).run()
        self.assertNotIn("S2", row["failed_rules"], row["notes"])

    def test_fail_failed_call_referenced(self):
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health", ok=False),
                     _done(_conclusion([{"call_id": "t1", "tool": "station_health", "finding": "x"}])))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S2", row["failed_rules"])
        self.assertTrue(any("不在成功的 tool.result" in n for n in row["notes"]), row["notes"])

    def test_fail_tool_name_mismatch(self):
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health"),
                     _done(_conclusion([{"call_id": "t1", "tool": "kb_search", "finding": "x"}])))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S2", row["failed_rules"])
        self.assertTrue(any("工具名不符" in n for n in row["notes"]), row["notes"])

    def test_fail_duplicate_reference(self):
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health"),
                     _done(_conclusion([
                         {"call_id": "t1", "tool": "station_health", "finding": "a"},
                         {"call_id": "t1", "tool": "station_health", "finding": "b"}])))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S2", row["failed_rules"])

    def test_fail_empty_evidence(self):
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health"),
                     _done(_conclusion([])))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S2", row["failed_rules"])

    def test_fail_no_conclusion_at_all(self):
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health"),
                     {"type": "message.done", "session_id": "s1", "data": {"reason": "stop", "content": "自由文本"}})
        row = J.Judge(self.task, ev).run()
        self.assertIn("S2", row["failed_rules"])


class S3Numbers(unittest.TestCase):
    def setUp(self):
        self.task = next(t for t in J.load_tasks() if t.task_id == "EV-18")

    def test_pass_in_range(self):
        ev = _events(
            _call("t1", "data_aggregate"),
            _result("t1", "data_aggregate", data={"p50": 45.0, "p95": 53.0, "p99": 55.0}),
            _done(_conclusion([{"call_id": "t1", "tool": "data_aggregate", "finding": "分位数"}])))
        row = J.Judge(self.task, ev).run()
        self.assertNotIn("S3", row["failed_rules"], row["notes"])

    def test_fail_out_of_range(self):
        ev = _events(
            _call("t1", "data_aggregate"),
            _result("t1", "data_aggregate", data={"p50": 99.0, "p95": 53.0, "p99": 55.0}),
            _done(_conclusion([{"call_id": "t1", "tool": "data_aggregate", "finding": "分位数"}])))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S3", row["failed_rules"])
        self.assertTrue(any("p50=99.0" in n for n in row["notes"]), row["notes"])

    def test_fail_missing_field(self):
        ev = _events(
            _call("t1", "data_aggregate"),
            _result("t1", "data_aggregate", data={"p50": 45.0}),
            _done(_conclusion([{"call_id": "t1", "tool": "data_aggregate", "finding": "缺 p95/p99"}])))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S3", row["failed_rules"])

    def test_fail_contract_violation(self):
        bad = json.dumps({"attribution": {"fault_type": "x"}, "recommendation": "y"})
        ev = _events(_call("t1", "data_aggregate"), _result("t1", "data_aggregate"), _done(bad))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S3", row["failed_rules"])

    def test_fail_confidence_out_of_unit_interval(self):
        body = _conclusion([{"call_id": "t1", "tool": "data_aggregate", "finding": "x"}], confidence=1.5)
        ev = _events(_call("t1", "data_aggregate"), _result("t1", "data_aggregate"), _done(body))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S3", row["failed_rules"])

    def test_exact_value_is_exact(self):
        """契约 §3.2：计数类精确相等。四舍五入后"看起来一样"不算通过。"""
        task = next(t for t in J.load_tasks() if t.task_id == "EV-21")
        ev = _events(
            _call("t1", "data_partitions"), _result("t1", "data_partitions"),
            _call("t2", "data_query"),
            _result("t2", "data_query", data={"row_count": 205199}),
            _done(_conclusion([{"call_id": "t2", "tool": "data_query", "finding": "行数"}])))
        row = J.Judge(task, ev).run()
        self.assertIn("S3", row["failed_rules"])
        self.assertTrue(any("205199" in n for n in row["notes"]), row["notes"])

    def test_no_conclusion_required_passes_s3(self):
        """EV-08 明说不给结论 —— 没有结论不能判 S3 失败。"""
        task = next(t for t in J.load_tasks() if t.task_id == "EV-08")
        row = J.Judge(task, _events()).run()
        self.assertNotIn("S3", row["failed_rules"], row["notes"])


class S4Artifacts(unittest.TestCase):
    def setUp(self):
        self.task = next(t for t in J.load_tasks() if t.task_id == "EV-28")

    def _write(self, tmp: Path, payload: bytes = b"%PDF-1.4\nhello") -> tuple[Path, str]:
        import hashlib
        root = tmp / "artifacts"
        root.mkdir(parents=True, exist_ok=True)
        p = root / "graph.pdf"
        p.write_bytes(payload)
        return root, hashlib.sha256(payload).hexdigest()

    def test_pass(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            root, digest = self._write(tmp)
            ref = {"name": "graph.pdf", "sha256": digest,
                   "bytes": (root / "graph.pdf").stat().st_size, "path": str(root / "graph.pdf")}
            ev = _events(_call("t1", "workflow_artifacts"),
                         _result("t1", "workflow_artifacts", artifact=ref))
            row = J.Judge(self.task, ev, artifacts_root=root).run()
            self.assertNotIn("S4", row["failed_rules"], row["notes"])

    def test_fail_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            root, _digest = self._write(tmp)
            ref = {"name": "graph.pdf", "sha256": "0" * 64,
                   "bytes": (root / "graph.pdf").stat().st_size, "path": str(root / "graph.pdf")}
            ev = _events(_call("t1", "workflow_artifacts"),
                         _result("t1", "workflow_artifacts", artifact=ref))
            row = J.Judge(self.task, ev, artifacts_root=root).run()
            self.assertIn("S4", row["failed_rules"])

    def test_fail_bytes_mismatch(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            root, digest = self._write(tmp)
            ref = {"name": "graph.pdf", "sha256": digest, "bytes": 999999,
                   "path": str(root / "graph.pdf")}
            ev = _events(_call("t1", "workflow_artifacts"),
                         _result("t1", "workflow_artifacts", artifact=ref))
            row = J.Judge(self.task, ev, artifacts_root=root).run()
            self.assertIn("S4", row["failed_rules"])

    def test_fail_path_outside_artifacts(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            root, digest = self._write(tmp)
            outside = tmp / "elsewhere.bin"
            outside.write_bytes(b"x")
            ref = {"name": "x", "sha256": digest, "path": str(outside)}
            ev = _events(_call("t1", "workflow_artifacts"),
                         _result("t1", "workflow_artifacts", artifact=ref))
            row = J.Judge(self.task, ev, artifacts_root=root).run()
            self.assertIn("S4", row["failed_rules"])
            self.assertTrue(any("不在 artifacts/" in n for n in row["notes"]), row["notes"])

    def test_fail_missing_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "artifacts"
            root.mkdir()
            ref = {"name": "ghost.pdf", "sha256": "a" * 64, "path": str(root / "ghost.pdf")}
            ev = _events(_call("t1", "workflow_artifacts"),
                         _result("t1", "workflow_artifacts", artifact=ref))
            row = J.Judge(self.task, ev, artifacts_root=root).run()
            self.assertIn("S4", row["failed_rules"])

    def test_fail_expected_artifact_absent(self):
        """任务期望里有 artifact/sha256 却一条 artifact_ref 都没有 —— 那是漏了。"""
        ev = _events(_call("t1", "workflow_artifacts"), _result("t1", "workflow_artifacts"))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S4", row["failed_rules"])


class S5Approval(unittest.TestCase):
    def setUp(self):
        self.task = next(t for t in J.load_tasks() if t.task_id == "EV-05")

    @staticmethod
    def _req(approval_id: str, call_id: str, name: str) -> dict:
        return {"type": "approval.request", "session_id": "s1", "data": {
            "approval_id": approval_id, "call_id": call_id, "name": name,
            "risk": "high", "reason": "会重启接收机", "prompt": "允许重启？"}}

    @staticmethod
    def _res(approval_id: str, call_id: str, verdict: str) -> dict:
        return {"type": "approval.result", "session_id": "s1", "data": {
            "approval_id": approval_id, "call_id": call_id, "verdict": verdict, "by": "auto"}}

    def test_pass_rejected_path(self):
        ev = _events(
            _call("t1", "execute_device_action"),
            self._req("ap-01", "t1", "execute_device_action"),
            self._res("ap-01", "t1", "rejected"),
            _result("t1", "execute_device_action", ok=False,
                    error={"code": "E_APPROVAL_DENIED", "message": "人工拒绝", "retryable": False}))
        row = J.Judge(self.task, ev).run()
        self.assertNotIn("S5", row["failed_rules"], row["notes"])

    def test_fail_pending_executed(self):
        ev = _events(
            _call("t1", "execute_device_action"),
            self._req("ap-01", "t1", "execute_device_action"),
            _result("t1", "execute_device_action", ok=True),   # 结论还没来就执行了
            self._res("ap-01", "t1", "approved"))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S5", row["failed_rules"])
        self.assertTrue(any("pending" in n for n in row["notes"]), row["notes"])

    def test_fail_executed_after_rejection(self):
        ev = _events(
            _call("t1", "execute_device_action"),
            self._req("ap-01", "t1", "execute_device_action"),
            self._res("ap-01", "t1", "rejected"),
            _result("t1", "execute_device_action", ok=True))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S5", row["failed_rules"])
        self.assertTrue(any("仍然成功执行" in n for n in row["notes"]), row["notes"])

    def test_fail_result_before_request(self):
        ev = _events(
            _call("t1", "execute_device_action"),
            self._res("ap-01", "t1", "approved"),
            self._req("ap-01", "t1", "execute_device_action"))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S5", row["failed_rules"])

    def test_fail_dangling_request(self):
        ev = _events(_call("t1", "execute_device_action"),
                     self._req("ap-01", "t1", "execute_device_action"))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S5", row["failed_rules"])
        self.assertTrue(any("一直没有结论" in n for n in row["notes"]), row["notes"])

    def test_fail_no_approval_at_all_when_required(self):
        """任务要求 S5 却一条审批事件都没有 —— 不能当成"不需要审批"。"""
        ev = _events(_call("t1", "execute_device_action"),
                     _result("t1", "execute_device_action", ok=True))
        row = J.Judge(self.task, ev).run()
        self.assertIn("S5", row["failed_rules"])


class S6Boundary(unittest.TestCase):
    def test_ev08_zero_calls_pass(self):
        task = next(t for t in J.load_tasks() if t.task_id == "EV-08")
        ev = _events({"type": "message.done", "session_id": "s1",
                      "data": {"reason": "stop", "content": "请说明是哪台站、哪个时段？"}})
        row = J.Judge(task, ev).run()
        self.assertNotIn("S6", row["failed_rules"], row["notes"])

    def test_ev08_fails_when_tools_called(self):
        task = next(t for t in J.load_tasks() if t.task_id == "EV-08")
        ev = _events(_call("t1", "station_health"), _result("t1", "station_health"))
        row = J.Judge(task, ev).run()
        self.assertIn("S6", row["failed_rules"])
        self.assertTrue(any("零工具调用" in n for n in row["notes"]), row["notes"])

    def test_ev20_readonly_pass(self):
        task = next(t for t in J.load_tasks() if t.task_id == "EV-20")
        ev = _events(_call("t1", "data_query"),
                     _result("t1", "data_query", ok=False,
                             error={"code": "E_READONLY", "message": "只读库", "retryable": False}))
        row = J.Judge(task, ev).run()
        self.assertNotIn("S6", row["failed_rules"], row["notes"])

    def test_ev20_fails_when_statement_executed(self):
        task = next(t for t in J.load_tasks() if t.task_id == "EV-20")
        ev = _events(_call("t1", "data_query"), _result("t1", "data_query", ok=True))
        row = J.Judge(task, ev).run()
        self.assertIn("S6", row["failed_rules"])

    def test_unmachine_checkable_s6_goes_manual_not_pass(self):
        """这是本文件最重要的一条：不能机判就必须落 manual，绝不能算通过。"""
        task = next(t for t in J.load_tasks() if t.task_id == "EV-10")
        self.assertIn("S6", task.rules)
        ev = _events(_call("t1", "pipeline_status"), _result("t1", "pipeline_status"),
                     _done(_conclusion([{"call_id": "t1", "tool": "pipeline_status", "finding": "暂停"}],
                                       confidence=0.95)))
        row = J.Judge(task, ev).run()
        self.assertEqual(row["manual_rules"], ["S6"])
        self.assertFalse(row["pass"], "含人判项的行不能算通过")


class Cli(unittest.TestCase):
    def _run(self, *args: str) -> tuple[int, str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = "src"
        env["PYTHONIOENCODING"] = "utf-8"
        r = subprocess.run([sys.executable, str(TOOL), *args], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           cwd=str(ROOT), env=env)
        return r.returncode, r.stdout + r.stderr

    def test_list_tasks_ok(self):
        rc, out = self._run("--list-tasks")
        self.assertEqual(rc, 0, out)
        self.assertIn("共 30 条", out)

    def test_missing_log_is_blocked_not_failed(self):
        """契约 §3.3：环境阻塞既不判 pass 也不判 fail，单列。"""
        with tempfile.TemporaryDirectory() as td:
            rc, out = self._run("--events-dir", td, "--runtime", "opencode")
            self.assertEqual(rc, 1, out)       # 有阻塞项 → 非零退出
            self.assertIn("环境阻塞 30", out)
            self.assertIn("BLOCK", out)

    def test_bad_json_is_fatal(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "EV-01.jsonl"
            p.write_text("{不是 JSON\n", encoding="utf-8")
            rc, out = self._run("--events", str(p), "--task", "EV-01")
            self.assertEqual(rc, 2, out)
            self.assertIn("不是合法 JSON", out)

    def test_unknown_task_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "x.jsonl"
            p.write_text("", encoding="utf-8")
            rc, out = self._run("--events", str(p), "--task", "EV-99")
            self.assertEqual(rc, 2, out)

    def test_perfect_run_exits_zero(self):
        """一条真正全过的日志必须 exit 0 —— 否则这个判分器永远无法用来放行。"""
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "EV-17.jsonl"
            ev = _events(
                _call("t1", "data_query"),
                _result("t1", "data_query", data={"row_count": 4924800, "epochs": 86400}),
                _done(_conclusion([{"call_id": "t1", "tool": "data_query", "finding": "行数对上"}])))
            p.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in ev) + "\n",
                         encoding="utf-8")
            rc, out = self._run("--events", str(p), "--task", "EV-17")
            self.assertEqual(rc, 0, out)
            self.assertIn("PASS", out)


if __name__ == "__main__":
    unittest.main()
