import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHECKER = ROOT / "tools" / "check_datadict.py"

HEADER = ("| 字段 | 单位 | 采样率 | 单位类型 | 允许范围 | 缺失标记 | "
          "质控判据 | 来源设备 | 备注 |")
SEP = "|---|---|---|---|---|---|---|---|---|"

GOOD_ROW = ("| 供电电压 | V | 0.2 Hz | 数值 | 0-60 | -999 | 越界判异常 | "
            "UPS-1200 | |")


def doc(status="草稿", rows=(GOOD_ROW,), header=HEADER, sep=SEP, extra=""):
    body = "\n".join([header, sep, *rows]) if header else "（本节暂无表格）"
    return (f"# 数据字典\n\n状态：{status}\n\n## 传感观测字段\n\n{body}\n{extra}")


class TestCheckDataDict(unittest.TestCase):
    """M1 数据字典的完整性门禁。

    状态=草稿 只报不算（此刻表是空的，不该把 M1 开局就卡红）；
    状态=完成 才强制必填列非空 —— 「填完了」的判据必须是机器说了算，
    不能靠提交者自己声称填完。
    """

    def _run(self, doc_text):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td) / "数据字典.md"
            p.write_text(doc_text, encoding="utf-8")
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            r = subprocess.run([sys.executable, str(CHECKER), "--doc", str(p)],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", cwd=str(ROOT), env=env)
            return r.returncode, r.stdout + r.stderr

    # ---------- 草稿态 ----------
    def test_draft_with_no_rows_passes(self):
        """草稿态允许空表 —— 否则 M1 开局的骨架表就把门禁打红了。"""
        rc, out = self._run(doc(status="草稿", rows=()))
        self.assertEqual(rc, 0, out)
        self.assertIn("草稿", out)

    def test_draft_with_incomplete_rows_passes_but_counts_debt(self):
        """草稿态不强制，但要把待补数报出来，让人知道自己欠了多少。"""
        rc, out = self._run(doc(status="草稿", rows=("| 供电电压 | V | | | | | | | |",)))
        self.assertEqual(rc, 0, out)
        self.assertIn("待补", out)

    # ---------- 完成态 ----------
    def test_complete_with_all_columns_passes(self):
        rc, out = self._run(doc(status="完成", rows=(GOOD_ROW,)))
        self.assertEqual(rc, 0, out)

    def test_complete_with_blank_required_column_fails(self):
        """「采样率」留空 = 漏填，必须 FAIL 并指出是哪一行哪一列。"""
        row = "| 供电电压 | V |  | 数值 | 0-60 | -999 | 越界判异常 | UPS | |"
        rc, out = self._run(doc(status="完成", rows=(row,)))
        self.assertEqual(rc, 1, out)
        self.assertIn("采样率", out)

    def test_complete_with_multiple_bad_rows_reports_each(self):
        bad1 = "| A | V | 0.1 Hz | 数值 | | -1 | | UPS | |"      # 缺缺失标记与判据
        bad2 = "| B | | | | | | | | |"                            # 全空
        rc, out = self._run(doc(status="完成", rows=(GOOD_ROW, bad1, bad2)))
        self.assertEqual(rc, 1, out)
        self.assertIn("A", out)
        self.assertIn("B", out)

    def test_pending_with_reason_is_accepted(self):
        """"待补：还没拿到型号" 是合法交付，不算漏填 —— 但要计入待补数。"""
        row = "| 探头温度 | ℃ | 待补：厂家没给采样率 | 数值 | | -999 | 越界判异常 | PT100 | |"
        rc, out = self._run(doc(status="完成", rows=(row,)))
        self.assertEqual(rc, 0, out)
        self.assertIn("待补", out)

    def test_pending_without_reason_counts_as_missing(self):
        """"待补" 后面没有原因 = 没说法，等于漏填。"""
        row = "| 探头温度 | ℃ | 待补 | 数值 | | -999 | 越界判异常 | PT100 | |"
        rc, out = self._run(doc(status="完成", rows=(row,)))
        self.assertEqual(rc, 1, out)
        self.assertIn("采样率", out)

    # ---------- 阻断：格式错 / 文件错 ----------
    def test_wrong_header_is_blocked(self):
        """表头写错 = 结构没对上，不能当漏填处理，要直接阻断让人改格式。"""
        bad = "| 指标 | 单位 | 采样率 | 类型 | 范围 | 缺失 | 判据 | 设备 | 备注 |"
        rc, out = self._run(doc(status="完成", header=bad))
        self.assertEqual(rc, 2, out)

    def test_illegal_status_is_blocked(self):
        rc, out = self._run(doc(status="写完了"))
        self.assertEqual(rc, 2, out)

    def test_missing_file_is_blocked(self):
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        r = subprocess.run([sys.executable, str(CHECKER),
                            "--doc", str(ROOT / "does-not-exist.md")],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=str(ROOT), env=env)
        self.assertEqual(r.returncode, 2)

    # ---------- 仓库里那份必须存在且可解析 ----------
    def test_repo_dictionary_exists_and_parses(self):
        """本仓库的数据字典本体必须存在，且能被自己的检查器接受。"""
        target = ROOT / "docs" / "m1" / "数据字典.md"
        self.assertTrue(target.exists(), f"缺 {target}")
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        r = subprocess.run([sys.executable, str(CHECKER)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=str(ROOT), env=env)
        self.assertIn(r.returncode, (0, 1), r.stdout + r.stderr)


class TestParserUnit(unittest.TestCase):
    """直接测解析函数，不走子进程 —— 边界条件在这里钉住。"""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / "tools"))
        import check_datadict as cd
        cls.cd = cd

    def test_extracts_status_and_rows(self):
        text = doc(status="完成", rows=(GOOD_ROW, "| B | W | 1 Hz | 数值 | | -9 | ok | PMU | |"))
        status, rows, err = self.cd.parse(text)
        self.assertIsNone(err)
        self.assertEqual(status, "完成")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["字段"], "供电电压")

    def test_optional_columns_may_be_blank(self):
        status, rows, err = self.cd.parse(doc(status="完成", rows=(GOOD_ROW,)))
        self.assertIsNone(err)
        self.assertEqual(rows[0]["允许范围"], "0-60")

    def test_comment_rows_are_ignored(self):
        row = "<!-- 模板示例行，填的时候删掉 -->"
        status, rows, err = self.cd.parse(doc(status="完成", rows=(row, GOOD_ROW)))
        self.assertIsNone(err)
        self.assertEqual(len(rows), 1)

    def test_multiline_comment_block_is_ignored(self):
        """跨行 HTML 注释 —— 注释块中间那行以 `|` 开头，会被当成真数据行。

        这是实测踩到的：数据字典的示例行写成两行注释块时，检查器把示例
        当成了字段行数 1。人会写多行注释，所以这里必须钉住。
        """
        block = ("<!-- 示例行，填表时删掉：\n"
                 "| 供电电压 | V | 0.2 Hz | 数值 | 0-60 | -999 | 越界 | UPS | |\n"
                 "-->")
        status, rows, err = self.cd.parse(doc(status="完成", rows=(block,)))
        self.assertIsNone(err)
        self.assertEqual(rows, [], f"注释块里的示例行被当成了数据：{rows}")

    def test_multiline_comment_does_not_swallow_real_rows(self):
        """注释块结束后，后面的真实数据行仍要被读到。"""
        block = ("<!-- 示例行：\n"
                 "| X | V | 1 Hz | 数值 | | -1 | ok | D | |\n"
                 "-->")
        status, rows, err = self.cd.parse(doc(status="完成", rows=(block, GOOD_ROW)))
        self.assertIsNone(err)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["字段"], "供电电压")


if __name__ == "__main__":
    unittest.main()