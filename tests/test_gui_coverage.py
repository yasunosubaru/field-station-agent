#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""覆盖矩阵生成器：不漏项、不引用不存在的证据、不和源码漂移。

这份测试保护的是**盘点本身的诚实性**，不是某条业务规则：

* A 的每个 view 目录都必须有归属（映射或 internal），否则生成器报错；
* 每个 ``a_only`` / ``partial`` 必须有 workflow 或 backlog，不能只写「缺」；
* 映射里引用的 ``文件:行`` 必须真的能找到，workflow 必须真的存在于 ``workflows/``；
* 已提交的矩阵/清单必须与当前源码生成结果一致（``--check``）。
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "gui_coverage.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("gui_coverage", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Generator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module()

    def test_committed_outputs_are_current(self):
        self.assertEqual(self.mod.main(["--check"]), 0)

    def test_generation_is_deterministic(self):
        first_matrix, first_inventory = self.mod.generate()
        second_matrix, second_inventory = self.mod.generate()
        self.assertEqual(first_matrix, second_matrix)
        self.assertEqual(first_inventory, second_inventory)

    def test_every_view_is_mapped(self):
        map_data = self.mod.load_map()
        a = self.mod.scan_a()
        self.assertEqual(self.mod.validate(map_data, a, self.mod.scan_b()), [])

    def test_gap_rows_have_handling(self):
        map_data = self.mod.load_map()
        for entry in map_data["entries"]:
            if entry["disposition"] in ("a_only", "partial"):
                self.assertTrue(
                    entry.get("workflow") or entry.get("backlog"),
                    f"{entry['id']} 有缺口但没有处理方式")

    def test_workflow_references_exist(self):
        map_data = self.mod.load_map()
        workflows = {w["id"] for w in self.mod.scan_b()["workflows"]}
        for entry in map_data["entries"]:
            if entry.get("workflow"):
                self.assertIn(entry["workflow"], workflows, entry["id"])

    def test_missing_view_mapping_is_reported(self):
        map_data = self.mod.load_map()
        a = self.mod.scan_a()
        errors = self.mod.validate(map_data, a, self.mod.scan_b())
        self.assertEqual(errors, [])
        # 去掉一个已映射的 view，生成器必须报「A 目录未映射」
        mapped = {e["a"]["file"] for e in map_data["entries"]
                  if isinstance(e.get("a"), dict) and e["a"].get("file")}
        first_view = next(v for v in a["views"] if v["path"] in mapped)
        stripped = {
            "version": map_data["version"],
            "internal": map_data["internal"],
            "entries": [e for e in map_data["entries"]
                        if not (isinstance(e.get("a"), dict)
                                and e["a"].get("file") == first_view["path"])],
        }
        errors = self.mod.validate(stripped, a, self.mod.scan_b())
        self.assertTrue(any("未映射" in e for e in errors), errors)

    def test_bad_workflow_is_reported(self):
        map_data = self.mod.load_map()
        a = self.mod.scan_a()
        broken = json.loads(json.dumps(map_data))
        target = next(e for e in broken["entries"] if e.get("workflow"))
        target["workflow"] = "no.such.workflow"
        errors = self.mod.validate(broken, a, self.mod.scan_b())
        self.assertTrue(any("no.such.workflow" in e for e in errors), errors)

    def test_bad_evidence_line_is_reported(self):
        map_data = self.mod.load_map()
        a = self.mod.scan_a()
        broken = json.loads(json.dumps(map_data))
        target = next(e for e in broken["entries"] if e.get("b"))
        target["b"][0]["find"] = "这句话不在任何源码里"
        errors = self.mod.validate(broken, a, self.mod.scan_b())
        self.assertTrue(any("找不到" in e for e in errors), errors)

    def test_check_detects_stale_matrix(self):
        with tempfile.TemporaryDirectory() as tmp:
            matrix = Path(tmp) / "19.md"
            inventory = Path(tmp) / "inventory.json"
            matrix.write_text("过期内容\n", encoding="utf-8")
            inventory.write_text("{}\n", encoding="utf-8")
            with mock.patch.object(self.mod, "MATRIX_PATH", matrix), \
                    mock.patch.object(self.mod, "INVENTORY_PATH", inventory):
                self.assertEqual(self.mod.main(["--check"]), 1)

    def test_inventory_lists_both_sides(self):
        matrix_text, inventory_text = self.mod.generate()
        inventory = json.loads(inventory_text)
        self.assertIn("a", inventory)
        self.assertIn("b", inventory)
        self.assertTrue(inventory["a"]["views"])
        expected = [
            "gui.app.install", "gui.app.update", "gui.device.add",
            "gui.device.update", "gui.graph.export", "gui.graph.newproject",
            "gui.suite.autoupdate", "script.device.restart",
        ]
        self.assertEqual([w["id"] for w in inventory["b"]["workflows"]], expected)
        for workflow_id in expected:
            self.assertIn(workflow_id, matrix_text)

    def test_matrix_lists_gaps_and_internal_dirs(self):
        matrix_text, _ = self.mod.generate()
        self.assertIn("A−B 清单", matrix_text)
        self.assertIn("未纳入 A 的 view 目录", matrix_text)
        self.assertIn("languageSupport", matrix_text)


if __name__ == "__main__":
    unittest.main()
