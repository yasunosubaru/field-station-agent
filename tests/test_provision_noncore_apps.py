# -*- coding: utf-8 -*-
"""预置可选应用：只测纯函数（合表、比对、找运行目录），不碰真实 APPDATA。"""
import json
import tempfile
import unittest
from pathlib import Path

from tools.provision_noncore_apps import (compare_tree, find_app_root,
                                          merge_catalog, rebuild_catalog_zip)


class TestMergeCatalog(unittest.TestCase):
    def test_adds_new_key(self):
        merged, added, changed = merge_catalog({"a": 1}, {"b": 2})
        self.assertEqual(merged, {"a": 1, "b": 2})
        self.assertEqual(added, ["b"])
        self.assertEqual(changed, [])

    def test_keeps_unknown_entries(self):
        merged, _, _ = merge_catalog({"keep": {"x": 1}}, {"new": {}})
        self.assertIn("keep", merged)

    def test_updates_changed_entry(self):
        merged, added, changed = merge_catalog({"a": {"v": 1}}, {"a": {"v": 2}})
        self.assertEqual(merged["a"], {"v": 2})
        self.assertEqual(added, [])
        self.assertEqual(changed, ["a"])

    def test_idempotent(self):
        first, _, _ = merge_catalog({"a": 1}, {"b": 2})
        second, added, changed = merge_catalog(first, {"b": 2})
        self.assertEqual(second, first)
        self.assertEqual((added, changed), ([], []))

    def test_does_not_mutate_input(self):
        existing = {"a": 1}
        merge_catalog(existing, {"b": 2})
        self.assertEqual(existing, {"a": 1})


class TestCompareTree(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.src = self.root / "app"
        self.dst = self.root / "target"
        (self.src / "view").mkdir(parents=True)
        (self.src / "package.json").write_text('{"name":"x"}', encoding="utf-8")
        (self.src / "view" / "index.js").write_text("console.log(1)", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_all_missing_when_target_absent(self):
        result = compare_tree(self.src, self.dst)
        self.assertEqual(len(result["missing"]), 2)

    def test_identical(self):
        (self.dst / "view").mkdir(parents=True)
        (self.dst / "package.json").write_text('{"name":"x"}', encoding="utf-8")
        (self.dst / "view" / "index.js").write_text("console.log(1)", encoding="utf-8")
        result = compare_tree(self.src, self.dst)
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["different"], [])

    def test_detects_content_change_of_same_size(self):
        (self.dst / "view").mkdir(parents=True)
        (self.dst / "package.json").write_text('{"name":"x"}', encoding="utf-8")
        (self.dst / "view" / "index.js").write_text("console.log(2)", encoding="utf-8")
        result = compare_tree(self.src, self.dst)
        self.assertEqual(result["different"], ["view/index.js"])


class TestAppRoot(unittest.TestCase):
    def test_root_with_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "app"
            d.mkdir()
            (d / "package.json").write_text("{}", encoding="utf-8")
            self.assertEqual(find_app_root(d), d)

    def test_nested_one_level(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "app"
            (d / "inner").mkdir(parents=True)
            (d / "inner" / "package.json").write_text("{}", encoding="utf-8")
            self.assertEqual(find_app_root(d), d / "inner")

    def test_none_when_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "app"
            d.mkdir()
            self.assertIsNone(find_app_root(d))


class TestCatalogZip(unittest.TestCase):
    def test_rebuilds_zip_from_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cat = root / "NonCoreAppsData"
            cat.mkdir()
            (cat / "nonCoreAppData.json").write_text(json.dumps({"a": 1}), encoding="utf-8")
            out = rebuild_catalog_zip(root)
            self.assertIsNotNone(out)
            import zipfile
            with zipfile.ZipFile(out) as z:
                self.assertIn("NonCoreAppsData/nonCoreAppData.json", z.namelist())


if __name__ == "__main__":
    unittest.main()
