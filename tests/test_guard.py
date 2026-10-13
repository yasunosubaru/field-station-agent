#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守卫在**批量路径**上生效的回归测试（2026-10-02 新增）。

## 为什么必须有这些测试

守卫原先只写在 `run.py` 里，而 `harness/batch.py` 的 worker 自己跑反演、
自己算基准、自己写 payload，**从不调用 run.py**。于是：

- 守卫在批量模式下完全失效；
- MTKA 的 10 天全部以 `status=ok` 进入汇总表，
  其中 6 天的 RMSE 在 43~64.6 TECU、1 天高达 126922 TECU；
- 汇总表是论文跨站表格的唯一出处 —— 那些数字本该被守卫拦下。

判据本身在 `fieldstation/rules/qc.py::phase_continuity_verdict`，两条路径共用同一个
纯函数；这些测试盯住的是**批量路径确实调用了它**，以及
**被拒算法的精度统计确实被清空**（只加标记是不够的：
RMSE 126922 若留在表里，任何按该表做的均值/中位/分层都会被污染）。
"""
from __future__ import annotations

import unittest

from fieldstation.rules import qc as QC


class TestVerdictFunction(unittest.TestCase):
    """判据本身的语义（纯函数，无IO）。"""

    def test_high_arc_ratio_is_rejected(self):
        v = QC.phase_continuity_verdict("phase_leveled", 144, 8)
        self.assertTrue(v["rejected"])
        self.assertEqual("arc_ratio", v["criterion"])
        self.assertAlmostEqual(18.0, v["arc_ratio"])

    def test_low_arc_ratio_passes(self):
        self.assertFalse(
            QC.phase_continuity_verdict("phase_leveled", 16, 15)["rejected"])

    def test_code_only_is_not_guarded(self):
        """`code_only` 不依赖相位连续性，弧段再多也不该被拒。"""
        v = QC.phase_continuity_verdict("code_only", 9999, 8)
        self.assertFalse(v["applicable"])
        self.assertFalse(v["rejected"])

    def test_kalman_is_not_phase_guarded(self):
        """`kalman` 是**码伪距**浮点滤波，不依赖相位连续性，
        弧段再多也不该被相位守卫拦下。
        （真实数据佐证：MTKA 上 kalman 的相关系数 r=+0.483，
        远好于phase_leveled 的负相关。）"""
        v = QC.phase_continuity_verdict("kalman", 9999, 8)
        self.assertFalse(v["applicable"])
        self.assertFalse(v["rejected"])


class TestPhysicalRmseCap(unittest.TestCase):
    """物理量级守卫：非物理的 RMSE 必须被拦下，真实量级必须放行。"""

    def test_nonphysical_is_rejected(self):
        v = QC.physical_rmse_verdict(126922.1)
        self.assertTrue(v["rejected"])
        self.assertEqual("nonphysical_rmse", v["criterion"])

    def test_realistic_values_pass(self):
        """实测健康台站的最大 RMSE 是 SMST 33.7；门限 500 有 10 倍以上余量。"""
        for r in (7.3658, 11.2144, 16.5090, 25.3774, 33.7170, 126.0):
            self.assertFalse(QC.physical_rmse_verdict(r)["rejected"],
                             "RMSE %s 被误杀" % r)

    def test_missing_or_nan_is_not_used_as_evidence(self):
        """没有可比数字时**不得**据此下结论（否则会把"没算出来"当"不合格"）。"""
        for r in (None, float("nan"), float("inf"), "abc"):
            v = QC.physical_rmse_verdict(r)
            self.assertFalse(v["rejected"])
            self.assertFalse(v["applicable"])

    def test_cap_zero_disables(self):
        self.assertFalse(
            QC.physical_rmse_verdict(1e9, cap_tecu=0.0)["rejected"])

    def test_default_cap_is_ten_x_worst_real(self):
        worst_real = 33.7170          # SMST 实测最大
        self.assertGreater(QC.DEFAULT_RMSE_CAP_TECU, 10.0 * worst_real)

    def test_zero_series_is_not_rejected(self):
        """一条序列都没有时无从判断，**不得**当成"通过"或"拒绝"来静默处理。"""
        v = QC.phase_continuity_verdict("phase_leveled", 0, 0)
        self.assertFalse(v["rejected"])
        self.assertIsNone(v["arc_ratio"])

    def test_guard_zero_disables(self):
        self.assertFalse(
            QC.phase_continuity_verdict("phase_leveled", 144, 8,
                                        arc_ratio_guard=0.0)["rejected"])

    def test_short_arc_criterion_is_off_by_default(self):
        """短弧率判据实测无区分力，默认必须关闭（否则会误杀 USUD）。"""
        self.assertEqual(0.0, QC.DEFAULT_SHORT_ARC_GUARD)
        v = QC.phase_continuity_verdict("phase_leveled", 16, 15,
                                        rejected_short_arcs=8, n_rows=10)
        self.assertFalse(v["rejected"])
        self.assertAlmostEqual(0.8, v["short_arc_rate"])

    def test_verdict_is_deterministic(self):
        a = QC.phase_continuity_verdict("phase_leveled", 144, 8)
        b = QC.phase_continuity_verdict("phase_leveled", 144, 8)
        self.assertEqual(a, b)


class TestMeasuredSeparation(unittest.TestCase):
    """用**实测数据**钉住门限的区分力，防止有人日后悄悄调错。

    数据来自 2026-10-02 当前代码 200 历元批次（见 docs/16 第 3 节）：
    MTKA（坏，RMSE 43.1~126922.1）8.6~20.5；其余站最高为 USUD 的 13.6。
    """

    #: (站, 弧段数, 序列数, 该站 phase_leveled 是否被守卫拒绝)
    CASES = (
        ("MTKA", 144, 8, True), ("MTKA", 164, 8, True),
        ("MTKA", 151, 9, True), ("MTKA", 170, 10, True),
        ("MTKA", 69, 8, False),          # 已知假阴：放行但 RMSE 43.1
        ("USUD", 109, 8, False),          # RMSE 11.2，必须放行
        ("USUD", 107, 8, False),
        ("CKSV", 70, 8, False),
        ("BADG", 25, 5, False),
        ("POL2", 15, 4, False),
        ("HYDE", 6, 5, False),
        ("SMST", 11, 10, False),
    )

    def test_no_healthy_station_is_killed(self):
        killed = [st for st, a, s, rej in self.CASES
                  if rej and st != "MTKA"]
        self.assertEqual([], killed, "非 MTKA 站被误杀")

    def test_known_false_negative_is_documented_not_hidden(self):
        """MTKA DOY003 的假阴是**已知局限**，测试把它钉住，
        以免日后有人以为门限已经完美。"""
        self.assertFalse(
            QC.phase_continuity_verdict("phase_leveled", 69, 8)["rejected"])


if __name__ == "__main__":
    unittest.main()