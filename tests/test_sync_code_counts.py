#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`tools/sync_code_counts.py` 的正/负例覆盖（KI-05 补测试）。

## 为什么负例必须在仓库外做

同步脚本把 README 位置写死为 `ROOT / "README.md"`（`ROOT = 脚本上溯两级`），
在真仓库上跑「错数字」用例等于**把错数写进真 README** —— 所以整个用例链
在 `tempfile` 里造一个独立小 git 仓库，把两个工具**复制**进去跑：

1. **负例（关键）**：块里的数字先人为写错（999）—— `audit_claims.py`
   必须识别为 `FAIL` 并非零退出。数字错了没人报，才是结题材料最贵的错法；
2. **正例**：`sync_code_counts.py` 必须把错数**改写**成 `git ls-files`
   实测值（2 文件 / 14 行 / 1 测试），并兑现「现状」表占位行；
3. **闭环**：改写之后 `audit_claims.py` 必须全过（exit 0）。

独立仓库需要 `git init` + `git add`（`git ls-files` 的口径是 index，
只写文件不入 index 会得到空口径 → 脚本按设计报「空数字」退出 2）。

子进程编码沿用 `tests/test_audit_claims.py::_run` 的成对约定。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: 故意写错的数字。块里出现它即代表「README 过时/被人手改错」。
WRONG = 999

#: 副本仓库里两个 .py 的行数（10 + 4），同步后 README 必须等于它。
SRC_LINES, TEST_LINES = 10, 4


def _run(repo: Path, script: str, *args):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run(
        [sys.executable, str(repo / "tools" / script), *args],
        cwd=str(repo), capture_output=True, text=True, encoding="utf-8",
        errors="replace", env=env, timeout=300)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def _build_copy_repo(base: Path) -> Path:
    """在 base 下造一个带错 README 的独立小 git 仓库，返回其根。"""
    repo = base / "copy-repo"
    for sub in ("src", "tests", "tools"):
        (repo / sub).mkdir(parents=True, exist_ok=True)
    for name in ("sync_code_counts.py", "audit_claims.py"):
        shutil.copy(ROOT / "tools" / name, repo / "tools" / name)
    (repo / "src" / "mod_a.py").write_text(
        "x = 1\n" * SRC_LINES, encoding="utf-8", newline="\n")
    (repo / "tests" / "test_a.py").write_text(
        "y = 2\n" * TEST_LINES, encoding="utf-8", newline="\n")
    (repo / "README.md").write_text(
        "# 副本 README\n\n"
        "| 项 | 状态 |\n|---|---|\n| 代码量表 | 待同步 |\n\n"
        "<!-- CODE_COUNTS:BEGIN -->\n"
        "## 代码量（机维护，请勿手改）\n\n"
        f"- 入库 Python 文件数：**{WRONG}** 个\n"
        f"- 入库 Python 行数：**{WRONG}** 行\n"
        f"- 入库测试文件数：**{WRONG}** 个\n"
        "<!-- CODE_COUNTS:END -->\n\n"
        "## 设计文档\n",
        encoding="utf-8", newline="\n")
    for cmd in (["git", "init"], ["git", "add", "README.md", "src", "tests", "tools"]):
        r = subprocess.run(cmd, cwd=str(repo), capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError(f"{cmd} 失败（用例前提不成立）: "
                               f"{r.stdout}{r.stderr}")
    return repo


class TestSyncCodeCounts(unittest.TestCase):
    def test_help_exits_zero(self):
        """`--help` 不写任何文件即可用（argparse 路径）。"""
        r = subprocess.run([sys.executable,
                            str(ROOT / "tools" / "sync_code_counts.py"),
                            "--help"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=str(ROOT), timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("usage", r.stdout + r.stderr)

    def test_wrong_numbers_are_detected_by_audit(self):
        """负例：改错的数字必须被识别为不符（FAIL + 非零退出）。"""
        with tempfile.TemporaryDirectory() as td:
            repo = _build_copy_repo(Path(td))
            rc, out = _run(repo, "audit_claims.py")
            self.assertEqual(rc, 1, out)          # 1 = 存在 FAIL（脚本约定）
            self.assertIn("FAIL", out)
            self.assertIn(str(WRONG), out)        # 报的是那个错数，不是崩了

    def test_sync_rewrites_wrong_block(self):
        """正例：同步脚本把错数改写成 git ls-files 实测值。"""
        with tempfile.TemporaryDirectory() as td:
            repo = _build_copy_repo(Path(td))
            rc, out = _run(repo, "sync_code_counts.py")
            self.assertEqual(rc, 0, out)
            text = (repo / "README.md").read_text(encoding="utf-8")
            self.assertNotIn(str(WRONG), text, "错数仍留在 README 里")
            self.assertIn(f"入库 Python 文件数：**2** 个", text)
            self.assertIn(f"入库 Python 行数：**{SRC_LINES + TEST_LINES}** 行", text)
            self.assertIn("入库测试文件数：**1** 个", text)
            # 「现状」表占位行被兑现为指向机维护块
            self.assertIn("| 代码量表 | 见下方「代码量（机维护）」节 |", text)

    def test_audit_passes_after_sync(self):
        """闭环：改写之后回源核对必须全过 —— 同步与核对共用同一口径。"""
        with tempfile.TemporaryDirectory() as td:
            repo = _build_copy_repo(Path(td))
            rc, out = _run(repo, "sync_code_counts.py")
            self.assertEqual(rc, 0, out)
            rc, out = _run(repo, "audit_claims.py")
            self.assertEqual(rc, 0, out)
            self.assertIn("FAIL 0", out)


if __name__ == "__main__":
    unittest.main()
