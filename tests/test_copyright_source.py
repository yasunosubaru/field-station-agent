"""软著源程序文档（M7-2）的生成与口径。

钉住：

* 页数：每页 50 行，文档展示前 30 + 后 30 页（总页数不足 60 时全收）；
* 页眉：软件名 + 版本 + 「第 N 页 / 共 M 页」，N 是**原始页号**（后 30 页从 M-29 起）；
* 只收原创：派生件（ingest/rules/…）与移植件（audit_claims/selftest/…）不得出现；
* 确定性：两次生成逐字节相同，入库文档与生成器一致。
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
TOOL = ROOT / "tools" / "make_copyright_source.py"
COMMITTED_DOC = ROOT / "docs" / "m7" / "软著-源程序.txt"
COMMITTED_SUMMARY = ROOT / "logs" / "copyright_source_summary.json"


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = "src"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=300)


class TestCopyrightSource(unittest.TestCase):
    def _build(self, td: Path) -> tuple[Path, Path, dict]:
        doc = td / "doc.txt"
        summary_path = td / "summary.json"
        run = _run("--out", str(doc), "--summary", str(summary_path))
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        return doc, summary_path, summary

    def test_page_layout_and_header(self):
        with tempfile.TemporaryDirectory() as td:
            doc, _, summary = self._build(Path(td))
            text = doc.read_text(encoding="utf-8")
            self.assertEqual(summary["lines_per_page"], 50)
            self.assertEqual(summary["pages_shown"], 60)
            self.assertEqual(summary["pages_total"],
                             (summary["lines"] + 49) // 50)
            self.assertIn("第 1 页 / 共", text)
            last_page = summary["pages_total"]
            self.assertIn(f"第 {last_page} 页 / 共 {last_page} 页", text)
            # 后 30 页从 total-29 起
            self.assertIn(f"第 {last_page - 29} 页 / 共 {last_page} 页", text)
            self.assertIn("野外台站智能体运行与评估系统 V1.0", text)

    def test_only_original_code(self):
        with tempfile.TemporaryDirectory() as td:
            doc, _, summary = self._build(Path(td))
            text = doc.read_text(encoding="utf-8")
            # 断言的是**文件标记**：代码里引用这些包是正常的（如 trial_ledger 引用 ingest.reader）
            for excluded in ("src/fieldstation/ingest/", "src/fieldstation/rules/",
                             "tools/audit_claims.py", "tools/sync_code_counts.py",
                             "tools/make_cli_figures.py", "harness/selftest.py"):
                self.assertNotIn(f"# ===== 文件：{excluded}", text, excluded)
            # 前 30 页展示的必须是软件本体（核心运行时），不是周边工具
            markers = re.findall(r"# ===== 文件：(\S+) =====", text)
            self.assertTrue(markers, "no file markers")
            self.assertTrue(markers[0].startswith("src/fieldstation/agents/"),
                            markers[0])
            self.assertGreater(summary["files"], 20)

    def test_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            first = td / "a.txt"
            second = td / "b.txt"
            for doc in (first, second):
                run = _run("--out", str(doc), "--summary", str(td / "s.json"))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertNotIn(b"\r\n", first.read_bytes())

    def test_manual_numbers_match_summary(self):
        """说明书里引用的规模数字必须与 summary 一致（验收：数字能回源）。"""
        summary = json.loads(COMMITTED_SUMMARY.read_text(encoding="utf-8"))
        manual = (ROOT / "docs" / "m7" / "软著-软件说明书.md").read_text(
            encoding="utf-8")
        self.assertIn(f"{summary['files']} 个文件", manual)
        self.assertIn(f"{summary['lines']:,} 行", manual)
        self.assertIn(f"{summary['pages_total']} 页", manual)

    def test_committed_doc_matches_regeneration(self):
        with tempfile.TemporaryDirectory() as td:
            doc, summary_path, _ = self._build(Path(td))
            self.assertEqual(doc.read_bytes(), COMMITTED_DOC.read_bytes())
            fresh = json.loads(summary_path.read_text(encoding="utf-8"))
            committed = json.loads(COMMITTED_SUMMARY.read_text(encoding="utf-8"))
            # document 是生成时的输出路径，临时目录里必然不同；其余字段必须一致
            self.assertEqual(fresh.pop("document"), "doc.txt")
            committed.pop("document")
            self.assertEqual(fresh, committed)


if __name__ == "__main__":
    unittest.main()
