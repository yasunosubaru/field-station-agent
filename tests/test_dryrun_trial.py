"""试运行演练（M6-1/2/3 dry run）的行为钉死。

重点：逐日记录与汇总**算得对**、**可复现**，且敏感度扫描的结论与判据口径一致
（持续阶跃 1 cycle 可检出；单历元尖峰 1–20 cycle 检不出）。
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
HARNESS = ROOT / "harness" / "dryrun_trial.py"
COMMITTED = ROOT / "logs" / "dryrun_trial_202401.json"
COMMITTED_SUMMARY = ROOT / "logs" / "dryrun_trial_summary_202401.json"


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(HARNESS), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=300)


class TestDryRunTrial(unittest.TestCase):
    def test_summary_numbers(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            run = _run("--out", str(td / "run.json"),
                       "--summary", str(td / "summary.json"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            log = json.loads((td / "run.json").read_text(encoding="utf-8"))
            summary = log["summary"]
            self.assertEqual(summary["days"], 31)
            self.assertEqual(summary["availability"], 1.0)
            self.assertEqual(summary["injected_days"], 15)
            self.assertEqual(summary["detected_days"], 15)
            self.assertEqual(summary["detection_rate"], 1.0)
            self.assertEqual(summary["false_positive_days"], 0)
            self.assertEqual(summary["low_temp_hours"], 189)
            self.assertEqual(len(log["rows"]), 31)
            for row in log["rows"]:
                self.assertIn(row["date"][:4], ("2024",))
                self.assertEqual(row["qc"]["slip_indices"],
                                 [30] if row["injected"] else [])

    def test_sensitivity_matches_judgement_semantics(self):
        with tempfile.TemporaryDirectory() as td:
            run = _run("--out", str(Path(td) / "run.json"),
                       "--summary", str(Path(td) / "summary.json"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            summary = json.loads((Path(td) / "summary.json").read_text(encoding="utf-8"))
            table = {(row["mode"], row["cycles"]): row["detected"]
                     for row in summary["sensitivity"]}
            # 持续阶跃：1 cycle 起全部检出
            for cycles in (1.0, 2.0, 3.0, 5.0, 10.0, 20.0):
                self.assertTrue(table[("sustained", cycles)], cycles)
            # 单历元尖峰：1–20 cycle 全部检不出（判据口径如此）
            for cycles in (1.0, 2.0, 3.0, 5.0, 10.0, 20.0):
                self.assertFalse(table[("spike", cycles)], cycles)

    def test_committed_outputs_match_regeneration(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            run = _run("--out", str(td / "run.json"),
                       "--summary", str(td / "summary.json"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual((td / "run.json").read_bytes(), COMMITTED.read_bytes())
            self.assertEqual((td / "summary.json").read_bytes(),
                             COMMITTED_SUMMARY.read_bytes())

    def test_two_runs_identical_and_lf(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            for name in ("a", "b"):
                run = _run("--out", str(td / f"{name}.json"),
                           "--summary", str(td / f"{name}-s.json"))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual((td / "a.json").read_bytes(), (td / "b.json").read_bytes())
            raw = (td / "a.json").read_bytes()
            self.assertNotIn(b"\r\n", raw)
            self.assertTrue(raw.endswith(b"\n"))


if __name__ == "__main__":
    unittest.main()
