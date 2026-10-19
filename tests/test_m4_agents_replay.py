"""M4：四类 Agent 回放基线（审批双路径、合成隔离与漂移检测）。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPLAY = ROOT / "harness" / "m4_agents_replay.py"
_SHA_RE = re.compile(r"(?m)^sha256: ([0-9a-f]{64})$")


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(REPLAY), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=240)


class TestM4AgentsReplay(unittest.TestCase):
    def test_bless_then_two_runs_and_revalidate(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fixture = td / "fixture.json"
            bless = _run("--fixture", str(fixture), "--bless",
                         "--log-dir", str(td / "bless"))
            self.assertEqual(bless.returncode, 0, bless.stdout + bless.stderr)
            self.assertIn("not_worse_than_m3=True", bless.stdout)

            r1 = _run("--fixture", str(fixture), "--log-dir", str(td / "run1"))
            r2 = _run("--fixture", str(fixture), "--log-dir", str(td / "run2"))
            self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr)
            self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
            s1 = _SHA_RE.search(r1.stdout)
            s2 = _SHA_RE.search(r2.stdout)
            self.assertIsNotNone(s1, r1.stdout)
            self.assertIsNotNone(s2, r2.stdout)
            self.assertEqual(s1.group(1), s2.group(1))

            log = td / "run1" / "m4_agents_replay.json"
            verify = _run("--verify-log", str(log))
            self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
            self.assertIn("checks 全过", verify.stdout)

    def test_tampered_evidence_fails_revalidation(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fixture = td / "fixture.json"
            bless = _run("--fixture", str(fixture), "--bless",
                         "--log-dir", str(td / "bless"))
            self.assertEqual(bless.returncode, 0, bless.stdout + bless.stderr)
            run = _run("--fixture", str(fixture), "--log-dir", str(td / "run"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

            log = td / "run" / "m4_agents_replay.json"
            data = json.loads(log.read_text(encoding="utf-8"))
            scenario = data["scenarios"][0]
            conclusion = json.loads(scenario["conclusion"])
            conclusion["attribution"]["evidence"][0]["call_id"] = "t9999"
            scenario["conclusion"] = json.dumps(conclusion, ensure_ascii=False)
            log.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                           encoding="utf-8")

            verify = _run("--verify-log", str(log))
            self.assertEqual(verify.returncode, 1,
                             verify.stdout + verify.stderr)
            self.assertIn("不存在", verify.stdout)

    def test_drifted_fixture_fails(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fixture = td / "fixture.json"
            bless = _run("--fixture", str(fixture), "--bless",
                         "--log-dir", str(td / "bless"))
            self.assertEqual(bless.returncode, 0, bless.stdout + bless.stderr)

            data = json.loads(fixture.read_text(encoding="utf-8"))
            first = sorted(data["scenarios"])[0]
            data["scenarios"][first]["sha256"] = "0" * 64
            fixture.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                               encoding="utf-8")

            run = _run("--fixture", str(fixture), "--log-dir", str(td / "run"))
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("FAIL", run.stdout)


if __name__ == "__main__":
    unittest.main()
