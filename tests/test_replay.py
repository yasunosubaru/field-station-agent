"""回放式评测器（`harness/replay.py`）的契约测试：两条路径，一正一负。

  1. `test_two_runs_same_sha256`（正例）：同一 fixture 连跑两次，
     退出码都必须是 0，且两次打印的 SHA256 逐字相同 —— 回放基线
     「同输入同输出」的可执行定义。顺带核对日志里落盘的哈希与 stdout 一致。
  2. `test_wrong_expectation_exits_nonzero`（**负例**）：把 fixture 里的期望
     改错，退出码必须是 1，且输出里出现「不一致」—— 钉住"因为期望不符而失败"，
     不是"因为脚本崩了"（崩溃也返回非零，光断言非零区分不出这两者）。

运行方式与 README 固定命令一致：子进程带 `PYTHONPATH=src`、cwd 在仓库根。
日志一律落到临时目录（`--log-dir`），测试不污染仓库的 `logs/`。

本文件只用标准库；不接真实模型、不联网 —— 被测的 replay 自己也只用 FakeProvider。
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
REPLAY = ROOT / "harness" / "replay.py"
FIXTURE = ROOT / "harness" / "fixtures" / "replay_20261013.json"

#: replay 打印的机读行（在 mismatch 与 match 两条路径上都必须出现）。
_SHA_RE = re.compile(r"(?m)^sha256: ([0-9a-f]{64})$")


def _run(fixture: Path, log_dir: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    # 子进程 stdout 走管道时，Windows 上默认按 locale（本机 cp936）编码，
    # 而本测试按 UTF-8 解码 —— 中文断言词会变乱码，"因为期望不符而失败"
    # 就断言不出来了。钉死子进程 stdio 编码，两边口径才一致。
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(REPLAY), "--fixture", str(fixture),
         "--log-dir", str(log_dir)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=600)


def _sha(stdout: str) -> str | None:
    m = _SHA_RE.search(stdout)
    return m.group(1) if m else None


class TestReplay(unittest.TestCase):
    def test_two_runs_same_sha256(self):
        """正例：同 fixture 两次运行，退出码 0 且 SHA256 相同。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            r1 = _run(FIXTURE, td / "log1")
            r2 = _run(FIXTURE, td / "log2")
            out = r1.stdout + r1.stderr + "\n---\n" + r2.stdout + r2.stderr
            self.assertEqual(r1.returncode, 0, out)
            self.assertEqual(r2.returncode, 0, out)
            s1, s2 = _sha(r1.stdout), _sha(r2.stdout)
            self.assertIsNotNone(s1, f"stdout 里没有机读 sha256 行:\n{r1.stdout}")
            self.assertIsNotNone(s2, f"stdout 里没有机读 sha256 行:\n{r2.stdout}")
            self.assertEqual(s1, s2)
            # 日志确实落到 --log-dir，且记录的哈希与 stdout 一致
            logs = list((td / "log1").glob("replay_*.json"))
            self.assertEqual(len(logs), 1, f"日志文件数 {len(logs)} != 1")
            record = json.loads(logs[0].read_text(encoding="utf-8"))
            self.assertEqual(s1, record.get("actual_sha256"))

    def test_wrong_expectation_exits_nonzero(self):
        """负例：fixture 期望被改错 -> 退出码 1，且报「不一致」而非崩溃。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
            fx["expected_sha256"] = "0" * 64          # 故意改错期望归因
            bad = td / "bad_fixture.json"
            bad.write_text(json.dumps(fx, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            r = _run(bad, td / "log")
            out = r.stdout + r.stderr
            self.assertEqual(r.returncode, 1,
                             f"期望改错后应退出码 1，实得 {r.returncode}:\n{out}")
            self.assertIn("不一致", out)
            self.assertNotIn("Traceback", out)


if __name__ == "__main__":
    unittest.main()
