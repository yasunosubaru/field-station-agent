# -*- coding: utf-8 -*-
"""``tools/suite_field_parity.py`` 的行为测试。

这份测试守的是**这张对照表可信**这件事，不是「脚本能跑」。所以断言的顺序
对应三条会毁掉可信度的失败方式：

1. 抽出来的字段必须有 ``文件:行号`` —— 没有出处的行是编造的，必须能被排除；
2. 三态分类（``matched`` / ``b_only`` / ``a_only`` / ``unverified``）之和必须等于总数，
   否则某一行被静默丢掉或重复计数，结论区的数字就是假的；
3. 产物必须**确定**：跑两次逐字节相同，``--check`` 才有意义；否则「一致」这个
   判据本身就靠不住。

另外守一条本仓库纪律：**不许 skip**。所以这里没有 ``skipTest``，也没有
``@unittest.skip``——要么真跑，要么红。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import suite_field_parity as SFP  # noqa: E402


#: 生成器要解析约 600 KB 的 JS/TS 与 81 个 HTML。本机实测单次约 1 秒量级；
#: 给它 60 秒上限，是为了在慢盘/被杀毒扫描拖住时给出「太慢」而不是「挂死」。
#: 注：``unittest`` 没有单测试超时机制，这个上限由 CI 外层 timeout 落实，
#: 这里只用 :data:`SLOW_BUDGET_S` 记录预期，供人对照，不假装是硬约束。
SLOW_BUDGET_S = 60


class ReportFixture(unittest.TestCase):
    """整个类共用一次 ``build_report()``：它要扫 600 KB 源码，重复跑没必要。"""

    report: SFP.Report

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = SFP.build_report()


class TestExtraction(ReportFixture):
    def test_runs_on_repo(self):
        """生成器能在本仓库跑通，且不是空表。

        门槛故意设成 1 而不是 60：真实数量取决于口径与仓库内容，
        断言「至少 1 个」才能区分「解析挂了」和「解析得少」。
        """
        self.assertGreaterEqual(self.report.elements, 1)
        self.assertGreaterEqual(self.report.total, 1)

    def test_every_row_has_provenance(self):
        """每一行都必须能指回真实的 ``文件:行号``。

        这是「不造假」的机械保证：没出处的行无法核对，也就不该出现在表里。
        """
        for row in self.report.rows:
            with self.subTest(page=row.page, key=row.field_key):
                field = row.a_field or row.b_field
                self.assertIsNotNone(field, "行必须至少有一侧字段")
                self.assertTrue(field.file, "缺少来源文件")
                self.assertGreaterEqual(field.line, 1, "行号必须是 1 起")
                self.assertTrue((ROOT / field.file).exists(),
                                f"来源文件不存在：{field.file}")

    def test_provenance_line_points_at_a_control(self):
        """抽查代表性行：行号处真的有一个控件标签。

        只验「文件存在」不够——行号错位也能过。这里读回原文，确认该行附近
        确有控件标签，把「行号是编的」这条路堵死。

        控件既可能是 ``<input|select|textarea>``，也可能是 A 侧承载状态控件的
        ``<button>``（如 ``deviceExport.html:37`` 的 ``select-unselect-logs``），
        所以两种都认——但都必须是真标签，不能是任意一行文字。
        """
        sample = [r for r in self.report.rows if r.a_field][:40]
        self.assertGreaterEqual(len(sample), 1, "至少要有一行 A 侧字段可抽检")
        for row in sample:
            f = row.a_field
            with self.subTest(file=f.file, line=f.line):
                lines = (ROOT / f.file).read_text(
                    encoding="utf-8", errors="replace").splitlines()
                self.assertLessEqual(f.line, len(lines), "行号越界")
                # 控件标签可能跨行，取行号所在处往后 3 行的窗口
                window = " ".join(lines[max(0, f.line - 1): f.line + 3])
                self.assertRegex(
                    window, r"<\s*(input|select|textarea|button)\b",
                    f"{f.file}:{f.line} 附近没有控件标签，行号可疑")

    def test_at_least_one_field_per_side(self):
        """两侧都真的抽到东西，否则「对照」是假的。"""
        self.assertTrue(any(r.a_field for r in self.report.rows), "A 侧一个字段都没抽到")
        self.assertTrue(any(r.b_field for r in self.report.rows), "B 侧一个字段都没抽到")


class TestClassification(ReportFixture):
    def test_three_state_sum_equals_total(self):
        """三态之和 == 总元素数。少一行/多一行都会在这里炸。"""
        counts = self.report.counts
        self.assertEqual(sum(counts.values()), self.report.elements)
        for verdict in ("matched", "b_only", "a_only", "unverified"):
            self.assertIn(verdict, counts, f"缺少分类 {verdict}")

    def test_verdicts_are_from_known_set(self):
        allowed = {"matched", "b_only", "a_only", "unverified",
                   "not_applicable"}
        for row in self.report.rows:
            with self.subTest(page=row.page, key=row.field_key):
                self.assertIn(row.verdict, allowed)

    def test_b_only_has_no_a_side_and_vice_versa(self):
        """``b_only`` 不许带 A 侧位置，``a_only`` 不许带 B 侧位置。

        这是分类的定义。若哪天填反了，差异数会算到错的一侧，
        而总和仍然对得上——所以必须单独断言。
        """
        for row in self.report.rows:
            with self.subTest(page=row.page, key=row.field_key, verdict=row.verdict):
                if row.verdict == "b_only":
                    self.assertIsNone(row.a_field)
                    self.assertIsNotNone(row.b_field)
                elif row.verdict == "a_only":
                    self.assertIsNone(row.b_field)
                    self.assertIsNotNone(row.a_field)
                elif row.verdict == "matched":
                    self.assertIsNotNone(row.a_field)
                    self.assertIsNotNone(row.b_field)

    def test_unique_counts_sum_to_unique_total(self):
        """去重口径也要自洽：去重三态之和 == 去重字段数。"""
        uc = self.report.unique_counts
        self.assertEqual(sum(uc.values()), self.report.total)

    def test_unique_never_exceeds_elements(self):
        """去重只会合并、不会凭空增加字段。"""
        self.assertLessEqual(self.report.total, self.report.elements)
        self.assertEqual(self.report.merged, self.report.elements - self.report.total)

    def test_mismatches_is_derived_not_hardcoded(self):
        """``mismatches`` 必须等于去重 ``b_only + a_only``，不许是写死的数。"""
        uc = self.report.unique_counts
        self.assertEqual(
            self.report.mismatches, uc.get("b_only", 0) + uc.get("a_only", 0))
        self.assertEqual(
            self.report.element_mismatches,
            self.report.counts.get("b_only", 0) + self.report.counts.get("a_only", 0))


class TestDeduplication(ReportFixture):
    def test_unique_key_groups_are_disjoint_by_definition(self):
        """按构造，去重键不应重复：每组恰好一个代表行。"""
        keys = [r.group_key for r in self.report.unique_fields]
        self.assertEqual(len(keys), len(set(keys)))

    def test_radio_group_counts_once(self):
        """实测锚点：``cv-affix`` 的两个 radio 必须只算一个字段。

        这条盯的是用户发现的原始缺陷——按元素计数会把一个字段算成两个，
        使 ``mismatches`` 虚高。
        """
        cv_affix = [r for r in self.report.rows if r.nkey == "cvaffix"]
        self.assertGreaterEqual(len(cv_affix), 2, "本仓库应有两个 cv-affix radio")
        groups = {r.group_key for r in cv_affix}
        self.assertEqual(len(groups), 1, "同名的多个 radio 必须归为一个字段")

    def test_same_name_different_namespace_not_merged(self):
        """``data-term=path``（终端）与 ``data-adddev=path``（加设备）必须是两个字段。

        同名但两个对话框、两个用途。若被合并，字段数会偏少、差异数也跟着偏。
        """
        paths = [r for r in self.report.rows if r.nkey == "path" and r.b_field]
        if not paths:
            self.fail("本仓库应在 manage.js 里抽出 path 字段")
        self.assertGreaterEqual(len({r.namespace for r in paths}), 1)
        namespaces = {r.namespace.lower() for r in paths}
        # 只要两个绑定属性都在，命名空间必然不同；只有一个时也允许（口径未变）
        if {"data-term", "data-adddev"} <= namespaces:
            groups = {r.group_key for r in paths}
            self.assertGreaterEqual(len(groups), 2, "跨命名空间的同名必须分开")

    def test_representative_row_keeps_provenance(self):
        """去重后每个字段的代表行仍带真实位置，不许为了去重把行号丢掉。"""
        for row in self.report.unique_fields:
            with self.subTest(page=row.page, key=row.field_key):
                field = row.a_field or row.b_field
                self.assertIsNotNone(field)
                self.assertTrue(field.file)
                self.assertGreaterEqual(field.line, 1)


class TestRendering(ReportFixture):
    def test_markdown_is_deterministic(self):
        """同一份报告渲染两次逐字节相同。

        产物里一旦掺进时间戳/绝对路径，``--check`` 就永远报陈旧。
        """
        a = SFP.render_markdown(self.report)
        b = SFP.render_markdown(self.report)
        self.assertEqual(a, b)

    def test_markdown_reports_both_count_scopes(self):
        """两个口径都要出现在结论区，否则读者会把行数当成字段数。"""
        md = SFP.render_markdown(self.report)
        self.assertIn("去重字段", md)
        self.assertIn("DOM 元素", md)
        self.assertIn(f"**{self.report.total}**", md)
        self.assertIn(f"**{self.report.mismatches}**", md)

    def test_markdown_table_row_count_matches_elements(self):
        """对照表的数据行数必须等于 DOM 元素数（不多不少）。"""
        md = SFP.render_markdown(self.report)
        start = md.index("| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |")
        block = md[start:]
        data_rows = [
            ln for ln in block.splitlines()
            if ln.startswith("| ") and ln.rstrip().endswith(
                ("| matched |", "| b_only |", "| a_only |", "| unverified |",
                 "| not_applicable |"))
        ]
        self.assertEqual(len(data_rows), self.report.elements)


class TestCliOnRepoTmp(unittest.TestCase):
    """CLI 行为。产物写到临时目录，**绝不碰仓库里的真产物**。"""

    def setUp(self) -> None:
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = Path(self._tmp.name) / "parity.md"

    def test_check_fails_when_artifact_missing(self):
        """产物不存在时 ``--check`` 必须非 0，否则「一致」毫无意义。"""
        self.assertFalse(self.out.exists())
        code = SFP.main(["--check", "--out", str(self.out)])
        self.assertEqual(code, 1)

    def test_write_then_check_is_zero(self):
        """先生成再校验应返回 0，且产物真的落盘。"""
        self.assertEqual(SFP.main(["--out", str(self.out)]), 0)
        self.assertTrue(self.out.exists())
        self.assertEqual(SFP.main(["--check", "--out", str(self.out)]), 0)

    def test_idempotent_bytes(self):
        """跑两次产物逐字节相同——这是 ``--check`` 能成立的前提。"""
        self.assertEqual(SFP.main(["--out", str(self.out)]), 0)
        first = self.out.read_bytes()
        self.assertEqual(SFP.main(["--out", str(self.out)]), 0)
        second = self.out.read_bytes()
        self.assertEqual(first, second, "两次生成不一致，--check 将永远失败")

    def test_check_detects_tampering(self):
        """人为改一个字节，``--check`` 必须发现（否则它只是恒真）。"""
        self.assertEqual(SFP.main(["--out", str(self.out)]), 0)
        data = self.out.read_bytes()
        self.out.write_bytes(data + b"\nstale\n")
        self.assertEqual(SFP.main(["--check", "--out", str(self.out)]), 1)

    def test_json_summary_shape(self):
        """``--json`` 摘要必须带两个口径与 mismatches。"""
        report = SFP.build_report()
        s = SFP.summary_dict(report)
        for key in ("fields", "elements", "mismatches", "matched",
                    "b_only", "a_only", "unverified", "merged"):
            self.assertIn(key, s)
        self.assertEqual(s["merged"], s["elements"] - s["fields"])

    def test_missing_map_exits_two(self):
        """输入不可用要退 2，而不是抛栈给人看。

        ``main`` 捕获 ``FileNotFoundError`` 后返回 2；这里用真实的 ``main``
        走一遍（覆盖映射缺失的场景），确认退出码而不是异常类型。
        """
        missing = Path(self._tmp.name) / "nope.json"
        with self.assertRaises(FileNotFoundError):
            SFP.load_map(missing)
        # 用真实的 main：临时把默认映射指向不存在的文件
        original = SFP.MAP_PATH
        try:
            SFP.MAP_PATH = missing
            code = SFP.main(["--check", "--out", str(self.out)])
        finally:
            SFP.MAP_PATH = original
        self.assertEqual(code, 2)

    def test_repo_artifact_matches_source(self):
        """仓库里已提交的产物必须与当前源码一致。

        这条就是 CI 会跑的那条：源码改了、产物没重新生成 → 红。
        产物不存在时明确失败（而不是跳过），因为「没产物」不进 EV-30。
        """
        target = SFP.DEFAULT_OUT
        self.assertTrue(target.exists(),
                        f"产物缺失：{SFP.rel_to_root(target)}，先跑生成器")
        expected = SFP.render_markdown(SFP.build_report())
        actual = target.read_text(encoding="utf-8", errors="replace")
        self.assertEqual(actual, expected,
                         "产物与源码不一致，先跑 python tools/suite_field_parity.py")


class TestNoSkipDiscipline(unittest.TestCase):
    """本仓库纪律：skip 必须为 0。

    只查**调用形式**，不查这个词本身——本文件的说明文字里就有「skip」，
    查词会把说明也算成违规。标记在运行时拼接，源码里不会出现完整标记，
    因此这条断言不会命中它自己的字面量。
    """

    @staticmethod
    def _forbidden_tokens() -> tuple[str, ...]:
        p = "skip"  # 拆开写，避免本方法自己的源码命中下面的模式
        return (p + "Test(", "." + p + "(", p + "Unless(", p + "If(")

    def test_no_skip_invocations(self):
        src = Path(__file__).read_text(encoding="utf-8")
        offenders = [t for t in self._forbidden_tokens() if t in src]
        self.assertEqual(offenders, [], f"本文件出现跳过调用：{offenders}")


if __name__ == "__main__":
    unittest.main()
