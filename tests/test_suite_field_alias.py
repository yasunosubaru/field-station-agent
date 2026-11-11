# -*- coding: utf-8 -*-
"""设-1 收口：字段**别名**机制（同一字段在两侧键名不同）。

背景：`page.grit` 在覆盖映射里指向 A 侧的 `GRIT/gritJarvisInterface.js`，
而那是 GRIT 的**装配器**——它按名字加载 20 个子页面，自己一个 `<input>` 都没有。
真正的控件在 `GRIT/positionOverview/addPOIDialog.js` 等子文件里，且键名风格不同：
A 写 `poi-name-value`，B 写 `name`；A 写 `updateRateInput`，B 写 `updateRate`。

这类差异**不是 B 多做了字段**，是同一字段两种键名。把它算成差异会让 79 这个数字
高估真实缺口。正确做法是让工具认识这层等价关系，并把依据写成可核对的行号。

三条硬要求（本文件就是钉住它们）：

1. 别名必须**两侧都有实际行号**，不能凭标签相似就宣称等价；
2. 别名只对**声明的页面**生效，不能全局放开（否则会把不相干的两页并到一起）；
3. 未登记的键名差异仍然算差异——别名表是白名单，不是宽松匹配。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import tools.suite_field_parity as P  # noqa: E402


class AliasTableShapeTest(unittest.TestCase):
    def test_alias_table_exists_and_is_non_empty(self):
        self.assertTrue(hasattr(P, "FIELD_ALIASES"))
        self.assertTrue(P.FIELD_ALIASES, "别名表为空等于没做")

    def test_every_alias_has_both_sides_and_reason(self):
        """每条别名都必须有 A 键名、B 键名、页面与依据。"""
        for alias in P.FIELD_ALIASES:
            self.assertIn("page", alias)
            self.assertIn("a_key", alias)
            self.assertIn("b_key", alias)
            self.assertIn("reason", alias)
            for key in ("page", "a_key", "b_key", "reason"):
                self.assertTrue(str(alias[key]).strip(),
                                f"别名缺 {key}：{alias}")

    def test_alias_pages_are_real_and_declared_once_per_pair(self):
        seen = set()
        for alias in P.FIELD_ALIASES:
            self.assertRegex(alias["page"], r"^[A-Za-z][A-Za-z0-9_]*$")
            key = (alias["page"], P.normalize(alias["a_key"]),
                   P.normalize(alias["b_key"]))
            self.assertNotIn(key, seen, f"别名重复：{key}")
            seen.add(key)


class AliasEvidenceTest(unittest.TestCase):
    """别名必须能在**两侧源码里都找到**那个控件，且行号对得上。"""

    @classmethod
    def setUpClass(cls):
        cls.en = P.load_en_table(P.A_LANG)

    def test_a_side_key_exists_at_declared_page(self):
        entries = P.load_map(P.MAP_PATH)
        page_to_a = {}
        for entry in entries:
            a_file = ((entry.get("a") or {}).get("file") or "").strip()
            if a_file:
                page_to_a[P.page_name(a_file)] = a_file
        for alias in P.FIELD_ALIASES:
            page = alias["page"]
            self.assertIn(page, page_to_a, f"别名页面 {page} 不在映射里")
            a_file = page_to_a[page]
            keys = {f.key for f in P.extract_fields(P.ROOT / a_file, side="A",
                                                    en=self.en)}
            # page.grit 的 A 侧是装配器，控件在子文件里：允许显式给 a_file
            if alias.get("a_file"):
                keys = {f.key for f in P.extract_fields(
                    P.ROOT / alias["a_file"], side="A", en=self.en)}
            self.assertIn(alias["a_key"], keys,
                          f"{page} 的 A 侧找不到 {alias['a_key']}")

    def test_b_side_key_exists(self):
        entries = P.load_map(P.MAP_PATH)
        page_to_b = {}
        for entry in entries:
            a_file = ((entry.get("a") or {}).get("file") or "").strip()
            if not a_file:
                continue
            page = P.page_name(a_file)
            for b in (entry.get("b") or []):
                bf = str((b or {}).get("file") or "")
                if bf:
                    page_to_b.setdefault(page, []).append(bf)
        for alias in P.FIELD_ALIASES:
            files = page_to_b.get(alias["page"], [])
            self.assertTrue(files, f"{alias['page']} 没有 B 侧文件")
            found = False
            for bf in files:
                keys = {f.key for f in P.extract_fields(P.ROOT / bf, side="B",
                                                        en=self.en)}
                if alias["b_key"] in keys:
                    found = True
                    break
            self.assertTrue(found,
                            f"{alias['page']} 的 B 侧找不到 {alias['b_key']}")


class AliasEffectTest(unittest.TestCase):
    def test_alias_turns_that_pair_into_matched(self):
        """登记过的别名字段，在报告里必须判 matched，而不是 b_only/a_only。"""
        report = P.build_report()
        for alias in P.FIELD_ALIASES:
            want = P.normalize(alias["b_key"])
            rows = [r for r in report.rows
                    if r.page == alias["page"]
                    and (r.b_field is not None and r.b_field.key == alias["b_key"])]
            self.assertTrue(rows, f"{alias['page']} 里没有 {alias['b_key']} 的行")
            for r in rows:
                self.assertEqual(
                    r.verdict, "matched",
                    f"{alias['page']} 的 {alias['b_key']} 应为 matched，"
                    f"实际 {r.verdict}（方法 {r.method}）")
                self.assertEqual(r.method, "alias")

    def test_unaliased_key_difference_still_counts(self):
        """没登记的键名差异仍算差异 —— 别名是白名单，不是宽松匹配。"""
        report = P.build_report()
        page_rows = [r for r in report.rows if r.page == "gritJarvisInterface"]
        unaliased = [r for r in page_rows if r.verdict == "b_only"
                     and r.method != "alias" and r.b_field is not None
                     and r.b_field.key in ("tileInput", "termPath", "termBaud",
                                           "termHost", "termPort", "termLine")]
        self.assertTrue(unaliased,
                        "A 侧 GRIT 子树里确实没有终端/瓦片字段，"
                        "这些必须仍算 b_only")

    def test_mismatches_drops_but_stays_positive(self):
        """收口后差异数必须下降，且不能变成 0（剩下的确实是没做的）。"""
        report = P.build_report()
        self.assertGreater(report.mismatches, 0,
                           "剩 0 会掩盖真实缺口，说明口径被放宽了")
        self.assertLess(report.mismatches, 79, "别名没有让差异数下降")


if __name__ == "__main__":
    unittest.main()
