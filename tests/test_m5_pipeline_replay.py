"""M5：全链回放基线（五阶段消息链、消息全量落 trace、归档字节跨平台一致）。

与 `tests/test_m4_agents_replay.py` 同构：临时 fixture 上跑「bless → 两跑 →
复校」，另加两条针对**已提交基线**的检查 —— 这是第一条在 CI（Linux）上重跑
的已提交基线，用来钉住「归档 sha 进 trace 后仍逐字节可复现」这一跨平台性质。
"""
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
REPLAY = ROOT / "harness" / "m5_pipeline_replay.py"
COMMITTED_FIXTURE = ROOT / "harness" / "fixtures" / "m5_pipeline_replay_20261019.json"
COMMITTED_LOG = ROOT / "logs" / "m5_pipeline_replay.json"
_SHA_RE = re.compile(r"(?m)^sha256: ([0-9a-f]{64})$")


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(REPLAY), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=240)


class TestM5PipelineReplay(unittest.TestCase):
    def test_bless_then_two_runs_and_revalidate(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fixture = td / "fixture.json"
            bless = _run("--fixture", str(fixture), "--bless",
                         "--log-dir", str(td / "bless"))
            self.assertEqual(bless.returncode, 0, bless.stdout + bless.stderr)
            self.assertIn("checks 10/10", bless.stdout)
            self.assertIn("7 条消息", bless.stdout)

            r1 = _run("--fixture", str(fixture), "--log-dir", str(td / "run1"))
            r2 = _run("--fixture", str(fixture), "--log-dir", str(td / "run2"))
            self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr)
            self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
            s1 = _SHA_RE.search(r1.stdout)
            s2 = _SHA_RE.search(r2.stdout)
            self.assertIsNotNone(s1, r1.stdout)
            self.assertIsNotNone(s2, r2.stdout)
            self.assertEqual(s1.group(1), s2.group(1))

            log = td / "run1" / "m5_pipeline_replay.json"
            verify = _run("--verify-log", str(log))
            self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
            self.assertIn("全部有效", verify.stdout)

    def test_committed_fixture_and_log_revalidate(self):
        """已提交的基线在任意宿主机上重跑应逐字节一致（CI 上真跑一遍）。"""
        with tempfile.TemporaryDirectory() as td:
            run = _run("--fixture", str(COMMITTED_FIXTURE),
                       "--log-dir", str(Path(td) / "run"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertIn("PASS M5 回放基线与 fixture 一致", run.stdout)
        verify = _run("--verify-log", str(COMMITTED_LOG))
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)

    def test_tampered_evidence_fails_revalidation(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fixture = td / "fixture.json"
            bless = _run("--fixture", str(fixture), "--bless",
                         "--log-dir", str(td / "bless"))
            self.assertEqual(bless.returncode, 0, bless.stdout + bless.stderr)
            run = _run("--fixture", str(fixture), "--log-dir", str(td / "run"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

            log = td / "run" / "m5_pipeline_replay.json"
            data = json.loads(log.read_text(encoding="utf-8"))
            evidence = data["stages"][0]["conclusion"]["attribution"]["evidence"]
            evidence[0]["call_id"] = "t9999"
            log.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                           encoding="utf-8")

            verify = _run("--verify-log", str(log))
            self.assertEqual(verify.returncode, 1,
                             verify.stdout + verify.stderr)
            self.assertIn("没有对应工具结果", verify.stdout)

    def test_drifted_fixture_fails(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fixture = td / "fixture.json"
            bless = _run("--fixture", str(fixture), "--bless",
                         "--log-dir", str(td / "bless"))
            self.assertEqual(bless.returncode, 0, bless.stdout + bless.stderr)

            data = json.loads(fixture.read_text(encoding="utf-8"))
            data["stages"][0]["sha256"] = "0" * 64
            fixture.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                               encoding="utf-8")

            run = _run("--fixture", str(fixture), "--log-dir", str(td / "run"))
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("FAIL", run.stdout)


if __name__ == "__main__":
    unittest.main()
