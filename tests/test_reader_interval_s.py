#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`reader.ObservationFile.interval_s` 在头段没有 `INTERVAL` 记录时的兜底值。

回归对象是 `docs/known-issues.md` 的 **KI-02**：头段没写 `INTERVAL` 时这个属性
返回 `nan`，而不是它自己注释里写的兜底常量 30.0。

## 机制（为什么是 nan 而不是 30.0）

`src/fieldstation/ingest/reader.py` 的属性体（修复前）：

    v = self._hdr.get("interval_s")   # 头段没这条记录 -> MISSING
    v = float(v)                      # MISSING 就是 nan，float(nan) 不抛异常
    if v and v > 0: return v          # nan > 0 为假，落空
    ts = ... if False else None       # 恒假死代码，什么也没算
    return v or 30.0                  # nan 是 truthy -> 原样返回 nan

`MISSING` 是 `fieldstation.constants.MISSING`（即 `float("nan")`）。RINEX 2 与
RINEX 3 的解析器都把 `header.interval_s` 初始化成它，只有真的读到 `INTERVAL`
记录才会被赋成别的值。所以**头段没写这条记录时，兜底从来没有生效过**。
`capability_report()` 又把这个值原样搬进报告，NaN 就这样漏到使用者手上。

## 两个方向都要钉住

- 没有 `INTERVAL`（夹具 `RINEX3_OBS`，这也是 RINEX 3 的真实情形）→ 兜底 30.0；
- 有 `INTERVAL`（夹具 `RINEX2_OBS`，写的是 15.00）→ 读到 15.0，不被兜底覆盖。

只钉前一条的话，"不看 `INTERVAL`、直接写死 30.0"也能过测试，这条断言就证明不了
`INTERVAL` 记录真的被读了 —— 后一条是它的对照。
"""
from __future__ import annotations

import math
import os
import tempfile
import unittest

from fieldstation.ingest import reader
from tests.fixtures_rinex import RINEX2_OBS, RINEX3_OBS

_TMPDIR = tempfile.mkdtemp(prefix="fieldstation-interval-s-")

#: 兜底常量，与 `reader.py` 里那个值同源（改动一处就要改两处）。
FALLBACK_S = 30.0


def _open(text: str, name: str):
    """构造 `ObservationFile`。KI-03 修复后不再需要屏蔽句柄告警。"""
    path = os.path.join(_TMPDIR, name)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return reader.ObservationFile(path)


def tearDownModule() -> None:
    import shutil
    shutil.rmtree(_TMPDIR, ignore_errors=True)


class TestIntervalFallback(unittest.TestCase):
    """KI-02：头段没有 `INTERVAL` 时，`interval_s` 必须是有限数。"""

    def test_rinex3_without_interval_returns_fallback(self):
        of = _open(RINEX3_OBS, "no_interval.rnx")
        self.assertEqual(of.info["format"], "RINEX3")
        self.assertTrue(
            math.isfinite(of.interval_s),
            "interval_s 应为有限数，实际是 %r" % (of.interval_s,))
        self.assertEqual(of.interval_s, FALLBACK_S)

    def test_capability_report_interval_is_finite(self):
        """`capability_report()` 把这个值原样搬出去，NaN 不能从这里漏给使用者。"""
        rep = _open(RINEX3_OBS, "no_interval_report.rnx").capability_report()
        self.assertIn("interval_s", rep)
        self.assertTrue(
            math.isfinite(rep["interval_s"]),
            "capability_report()['interval_s'] 应为有限数，实际是 %r"
            % (rep["interval_s"],))

    def test_declared_interval_is_not_replaced_by_fallback(self):
        """对照：夹具写了 `INTERVAL 15.00`，不能被兜底 30.0 盖掉。"""
        of = _open(RINEX2_OBS, "with_interval.rnx")
        self.assertEqual(of.info["format"], "RINEX2")
        self.assertEqual(of.interval_s, 15.0)
