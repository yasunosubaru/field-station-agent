"""PROVENANCE.md 的双向核对。

两条断言各盯一个方向，**不钉死具体文件清单的第一条**：

  1. `test_every_provenance_entry_has_file`：表里每一行的「新位置」都指向
     真实存在的文件 —— 登记指向一个不存在的路径，等于把搬运账记在了空气里。
  2. `test_every_moved_file_has_provenance_entry`：`DERIVED_FROM_SOURCE` 里
     每一个从源项目派生的文件都有对应行 —— 漏登记的反面案例是
     `tests/test_constants.py`（Task 2 改写自源 `test_units.py`，
     当时 brief 只要求登记 `src/` 两行，一直漏到 Task 8 才补）。

登记规则（brief 原文口径）：**只要文件内容有一部分来自源项目，就必须登记，
不管它在 `src/` 还是 `tests/`，也不管改动多少。** 全原样搬的登记、重写的也登记。

登记范围由 brief Step 1 逐字给定，就是 `DERIVED_FROM_SOURCE` 这 17 个文件。
`agents/`、`harness/`、`tools/` 与 `tests/{__init__,test_layout,fixtures_rinex,
runtime,ingest,audit_claims}.py` 不在该清单内 —— 本测试只断言清单内外两个方向，
不替登记表做清单之外的推断。

`registered_locations()` 与 `DERIVED_FROM_SOURCE` 被 `harness/selftest.py`
第 3 项复用 —— 门禁与测试共用同一份解析器，口径不会各说各话。
"""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVENANCE = ROOT / "PROVENANCE.md"

#: 从源项目派生、按登记规则必须出现在「新位置」列里的文件
#: （清单与 brief Step 1 逐字一致）。
DERIVED_FROM_SOURCE = (
    "src/fieldstation/constants.py",
    "src/fieldstation/model.py",
    "src/fieldstation/rules/qc.py",
    "src/fieldstation/ingest/rinex2.py",
    "src/fieldstation/ingest/rinex3.py",
    "src/fieldstation/ingest/hatanaka.py",
    "src/fieldstation/ingest/registry.py",
    "src/fieldstation/ingest/reader.py",
    "src/fieldstation/synthetic.py",
    "src/fieldstation/store/product.py",
    "tests/test_constants.py",
    "tests/t7_support.py",
    "tests/test_qc.py",
    "tests/test_qc_wiring.py",
    "tests/test_slips_sigma.py",
    "tests/test_guard.py",
    "tests/test_pipeline.py",
)


def registered_locations() -> list[str]:
    """解析 PROVENANCE.md 主表的「新位置」列，返回相对路径列表。

    只认**恰好 6 列**且以 `|` 开头的行：表头（`新位置`）、分隔行（`---`）
    与文件里其他表格因此被自然排除。单元格两端的反引号剥掉。
    """
    out: list[str] = []
    if not PROVENANCE.is_file():
        return out
    for line in PROVENANCE.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 6:
            continue
        loc = cells[5].strip("`").strip()
        if not loc or loc == "新位置" or set(loc) <= {"-", ":"}:
            continue
        out.append(loc)
    return out


class TestProvenance(unittest.TestCase):
    def test_every_provenance_entry_has_file(self):
        """方向 1：表里每一行的「新位置」都指向真实存在的文件。"""
        registered = registered_locations()
        self.assertTrue(
            registered,
            "PROVENANCE.md 表格解析为空 —— 解析器或表格格式走样，方向 1 无法成立")
        ghosts = [p for p in registered if not (ROOT / p).is_file()]
        self.assertEqual(
            ghosts, [], f"PROVENANCE 登记的新位置在仓库里不存在: {ghosts}")

    def test_every_moved_file_has_provenance_entry(self):
        """方向 2：每个从源项目派生的文件都有一行登记。"""
        registered = registered_locations()
        missing = [p for p in DERIVED_FROM_SOURCE if p not in registered]
        self.assertEqual(
            missing, [], f"这些派生文件未在 PROVENANCE.md 登记: {missing}")


if __name__ == "__main__":
    unittest.main()
