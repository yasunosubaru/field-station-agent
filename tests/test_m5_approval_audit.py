"""M5-4：审批门端到端联调与消息全量落 trace 核对（issue #63）。

三条：

* 审计本身全过（13/13），且入库记录与当前生成器逐字节一致（确定性、钉 LF）；
* 拒绝路径**确实停住**：换回 ``ApproveAll`` 时审计必须报失败 —— 否则这个审计
  只是在自证「跑完了」，不能证明审批门停得住；
* 两次运行输出相同。
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "harness" / "m5_approval_audit.py"
COMMITTED_LOG = ROOT / "logs" / "m5_approval_audit.json"


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(AUDIT), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=240)


def _load_audit_module():
    spec = importlib.util.spec_from_file_location("m5_approval_audit", AUDIT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestApprovalAudit(unittest.TestCase):
    def test_audit_passes_and_log_matches_committed(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "audit.json"
            run = _run("--out", str(out))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertIn("checks 13/13", run.stdout)
            self.assertIn("停在审批门", run.stdout)
            self.assertEqual(
                out.read_bytes(), COMMITTED_LOG.read_bytes(),
                "logs/m5_approval_audit.json 与审计输出不一致：重新运行 "
                "python harness/m5_approval_audit.py 并提交")

    def test_audit_log_deterministic_and_lf(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            first, second = td / "a.json", td / "b.json"
            for out in (first, second):
                run = _run("--out", str(out))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            raw = first.read_bytes()
            self.assertNotIn(b"\r\n", raw)
            self.assertTrue(raw.endswith(b"\n"))

    def test_audit_detects_deny_path_that_did_not_stop(self):
        """把「拒绝」换成放行：审批门没停住，审计必须失败（不是恒真）。"""
        module = _load_audit_module()
        from fieldstation.agents.approval import ApproveAll

        log = module.run_audit(deny_approver=ApproveAll())
        self.assertFalse(log["checks"]["deny_stopped"])
        self.assertFalse(log["checks"]["deny_approval_recorded"])
        self.assertFalse(log["checks"]["deny_action_not_executed"])
        failed = [name for name, ok in log["checks"].items() if not ok]
        self.assertIn("deny_stopped", failed)
        self.assertTrue(any(not ok for ok in log["checks"].values()))
        # 放行路径本身仍然通过 —— 失败定位在拒绝路径，不是整条链坏了
        self.assertTrue(log["checks"]["approve_trace_matches_m5_1"])

    def test_deny_path_messages_and_rejection_are_audited(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "audit.json"
            run = _run("--out", str(out))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            log = json.loads(out.read_text(encoding="utf-8"))
            topics = [message["topic"] for message in log["deny"]["messages"]]
            self.assertNotIn("dispatch.work_order", topics)
            self.assertNotIn("archive.done", topics)
            self.assertEqual(log["deny"]["approval"][0]["verdict"], "rejected")
            self.assertEqual(log["deny"]["approval"][0]["by"], "reject_all")
            self.assertIn("未获人工批准", log["deny"]["action_error"])
            self.assertTrue(any("不存在于成功的工具调用中"
                                in error for error in log["deny"]["rejected_errors"]))
            self.assertEqual(log["approve"]["approval"][0]["verdict"], "approved")
            self.assertEqual(log["approve"]["action_result"]["status"], "accepted")


if __name__ == "__main__":
    unittest.main()
