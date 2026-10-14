"""RINEX 2 头段 `PRN / # OF OBS` 记录的解析回归（issue #4 / KI-01）。

## 钉住什么

`rinex2.py:263-267` 解析该可选记录时，`rest = ln[3:].split()` 从第 4 列起切，
而标签（`_is` 判据要求出现在 `ln[40:]`）必在其中 —— 只要 `sid = ln[0:3].strip()`
非空（**第 1-3 列非空的不合规行**），`int(float('PRN'))` 必抛未捕获 `ValueError`。
本文件钉住两件事：

1. **规范行不崩**：RINEX 2.11（与 1993 原版）Table A.1 该记录格式
   `3X,A1,I2,9I6` —— 第 1-3 列必须空白 ⇒ `sid` 恒空 ⇒ 整行跳过（现状：记录
   被静默丢弃、`prn_obs` 恒空，因全仓只写不读，无可观测影响）。
2. **不合规行（第 1-3 列非空）不再未捕获崩溃**，且**头部解析继续走到 END OF
   HEADER**（用其后的 `# OF SATELLITES` 被读到来证明），坏记录**整条跳过、
   不猜解析结果**（`prn_obs` 不写入带标签词垃圾的值）。

背景、规范原文定位与 231 个真实文件的影响面实测见
`docs/known-issues.md` KI-01 的 2026-10-14 更正（issue #4 第 1 轮证伪了
"规范写法必崩"的原论断 —— 崩溃只发生在不合规行上）。
"""
from __future__ import annotations

import unittest

from fieldstation.ingest.rinex2 import Rinex2Obs

# 最小 RINEX 2.11 观测头：版本/程序/站名/首历元/观测类型齐全，
# 让 _parse_header 走真实分支而不是短路。
HDR = """     2.11           OBSERVATION DATA    G                   RINEX VERSION / TYPE
PROG                                                 PGM / RUN BY / DATE
TESTSTN                                                     MARKER NAME
  2024     1     1     0     0    0.0000000      GPS         TIME OF FIRST OBS
     4    C1    L1    D1    S1                              # / TYPES OF OBSERV
"""

# END OF HEADER 之前、PRN 记录**之后**再放一条头记录 —— 它被读到即证明
# 解析没有在坏行处中断。
SAT_COUNT = "     4" + " " * 34 + "# OF SATELLITES\n"

FOOT = """                                                            END OF HEADER
 24 01 01 00 00 00.0000000  0  4G01G02G03G04
"""

_COUNTS = (942, 940, 940, 940, 941, 940, 940, 940, 941)


def prn_line_spec() -> str:
    """规范列布局 `3X,A1,I2,9I6`：第 1-3 列空白、A1 系统字母在第 4 列、
    I2 PRN 在第 5-6 列、9I6 占第 7-60 列，标签从第 61 列起。"""
    body = "   G16" + "".join("%6d" % v for v in _COUNTS)
    assert len(body) == 60, len(body)
    return body + "PRN / # OF OBS\n"


def prn_line_noncompliant() -> str:
    """**不合规行**：PRN 数字占据第 1-3 列（违反 3X）—— issue #4 的崩溃形态。
    `sid = ln[0:3].strip()` 非空 ⇒ 进入赋值分支 ⇒ `rest` 混入标签词 ⇒
    修复前 `ValueError: could not convert string to float: 'PRN'`。"""
    body = " 16" + "".join("%6d" % v for v in _COUNTS)
    body += " " * (60 - len(body))
    assert len(body) == 60, len(body)
    return body + "PRN / # OF OBS\n"


def parse_with(prn_line: str) -> Rinex2Obs:
    """PRN 记录插在观测类型之后、`# OF SATELLITES` 与 END OF HEADER 之前。"""
    return Rinex2Obs(text=HDR + prn_line + SAT_COUNT + FOOT)


class TestPrnObsHeader(unittest.TestCase):
    def test_spec_line_parses_without_crash(self):
        """规范行（第 1-3 列空白）不崩，头解析完整 —— 现状回归。
        记录被静默跳过（`sid` 为空进不到赋值分支）：`prn_obs` 恒空，
        该行为全仓只写不读、无下游影响，故按现状断言、不擅自改语义。"""
        r = parse_with(prn_line_spec())
        self.assertEqual(r.header.obs_types, ["C1", "L1", "D1", "S1"])
        self.assertEqual(r.header.n_sat_declared, 4)
        self.assertEqual(r.header.prn_obs, {})

    def test_noncompliant_line_no_uncaught_crash(self):
        """**RED→GREEN 的主测**：第 1-3 列非空的不合规行，修复前抛
        `ValueError: could not convert string to float: 'PRN'`（未捕获、
        冒泡出解析器）。修复后不再崩溃、头解析继续（`# OF SATELLITES`
        仍被读到）、坏记录整条跳过不猜 —— `prn_obs` 不含任何键值。"""
        r = parse_with(prn_line_noncompliant())
        self.assertEqual(r.header.obs_types, ["C1", "L1", "D1", "S1"])
        self.assertEqual(r.header.n_sat_declared, 4)
        self.assertEqual(r.header.prn_obs, {})


if __name__ == "__main__":
    unittest.main()
