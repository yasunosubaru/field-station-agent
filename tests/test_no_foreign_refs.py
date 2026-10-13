"""门卫：源项目包名不得以任何形式留在 `.py` 里（含注释与 docstring）。

扫描范围是 `src/` `tests/` `harness/` `tools/` 下所有 `.py`，**不豁免任何
文件** —— 包括本文件自身与 `harness/` 的两个脚本。检查器给自己开豁免口子，
等于把门禁最想拦的那条路留给后来的人：任何人把残留写进检查器文件就再也
扫不出来。

由此产生一个约束：哨兵串与 brief Interfaces 指定的接口测试名都**不能以字面量
落盘**（本文件在扫描范围内，写出来会先命中自己，这条门禁从第一天起永远红）。
两者都由字符串拼接构造：unittest 按 `test*` 前缀发现用例，装配出来的完整名字
（见 `TEST_NAME`）与 brief 逐字一致 —— 跑测试时的输出行就是证据。
"""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: 扫描的四个目录（缺目录时 rglob 返回空，不会抛错）。
SCAN_DIRS = ("src", "tests", "harness", "tools")

#: 源项目包名。**由拼接构造**，理由见模块 docstring。
NEEDLE = "gns" + "stec"

#: brief Interfaces 指定的接口测试名，同样由拼接构造。
TEST_NAME = "test_no_" + "gns" + "stec" + "_references"


def foreign_ref_hits() -> list[str]:
    """扫描四个目录下全部 `.py`，返回含源项目包名的文件相对路径（排序稳定）。"""
    hits = []
    for rel in SCAN_DIRS:
        for p in sorted((ROOT / rel).rglob("*.py")):
            if NEEDLE in p.read_text(encoding="utf-8", errors="replace"):
                hits.append(p.relative_to(ROOT).as_posix())
    return hits


class TestNoForeignRefs(unittest.TestCase):
    def _assert_clean(self):
        hits = foreign_ref_hits()
        self.assertEqual(hits, [], f"残留源项目包名引用: {hits}")


# 接口名由拼接装配：unittest 发现的名字与 brief 逐字一致，而源码里不落字面量。
setattr(TestNoForeignRefs, TEST_NAME, TestNoForeignRefs._assert_clean)


if __name__ == "__main__":
    unittest.main()
