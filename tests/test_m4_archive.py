"""M4-4：归档导出工具与合成/真实数据隔离。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.agents.tools.archive_tools import ArchiveExportTool


class TestArchiveExport(unittest.TestCase):
    def test_real_export(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tool = ArchiveExportTool(root)
            result = tool.invoke({
                "relative_path": "runs/run1/report.json",
                "payload": {"status": "ok"},
                "synthetic": False,
            })
            self.assertTrue(result.ok, result.error)
            self.assertEqual(result.data["path"], "runs/run1/report.json")
            self.assertTrue((root / "runs/run1/report.json").is_file())

    def test_synthetic_is_isolated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tool = ArchiveExportTool(root)
            result = tool.invoke({
                "relative_path": "runs/run1/report.json",
                "payload": {"status": "ok"},
                "synthetic": True,
            })
            self.assertTrue(result.ok, result.error)
            self.assertEqual(
                result.data["path"],
                "runs/run1/synthetic/SYNTHETIC_report.json")
            self.assertTrue(
                (root / result.data["path"]).is_file())

    def test_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            tool = ArchiveExportTool(Path(td))
            for path in ("../outside.json", "a/../../outside.json", "C:/x.json"):
                with self.subTest(path=path):
                    result = tool.invoke({
                        "relative_path": path,
                        "payload": {},
                        "synthetic": False,
                    })
                    self.assertFalse(result.ok)
                    self.assertIn("路径", result.error or "")

    def test_bad_payload_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            result = ArchiveExportTool(Path(td)).invoke({
                "relative_path": "x.json", "payload": [], "synthetic": False})
            self.assertFalse(result.ok)
            self.assertIn("payload", result.error or "")


if __name__ == "__main__":
    unittest.main()
