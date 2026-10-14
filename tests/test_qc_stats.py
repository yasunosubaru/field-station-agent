# -*- coding: utf-8 -*-
"""`rules/qc.py` 三个统计纯函数的**直接**测试。

背景：`median` / `mad` / `robust_z` 此前只被 `detect_slips` 间接跑到，
**没有任何测试直接调用过它们**（见 issue #11）。这三个函数是数据质控的数学底座
—— 智能体判断"这条观测是不是异常"靠它们的输出对不对，必须有可直接追溯的用例。

每个用例都做过变异自检：把函数改坏，对应测试必须变红（证据见 commit message
与 issue #11 的评论）。
"""
from __future__ import annotations

import math
import unittest

from fieldstation import constants
from fieldstation.rules import qc

MISSING = constants.MISSING


def _finite(v):
    return math.isfinite(v)


class TestMedian(unittest.TestCase):
    """`median(values)`：中位数；偶数取中间两个平均；先剔除非有限值。"""

    def test_odd_count_takes_middle(self):
        # 排序 [1,2,3]，n=3 -> mid=1 -> vals[1]==2
        self.assertEqual(qc.median([1.0, 3.0, 2.0]), 2.0)

    def test_even_count_averages_middle_two(self):
        # 排序 [1,2,3,4]，n=4 -> mid=2 -> (vals[1]+vals[2])/2 == 2.5
        self.assertEqual(qc.median([1.0, 3.0, 4.0, 2.0]), 2.5)

    def test_non_finite_values_are_excluded_not_counted(self):
        # NaN 被剔除，只剩 [1.0, 3.0] -> (1+3)/2 == 2.0
        # 若把 NaN 当作排序值参与计算，结果会变 NaN / 排序抛错
        self.assertEqual(qc.median([1.0, float("nan"), 3.0]), 2.0)

    def test_infinite_values_are_excluded(self):
        # inf 同样只被剔除（math.isfinite 对 inf 返回 False）
        self.assertEqual(qc.median([1.0, float("inf"), 3.0]), 2.0)

    def test_empty_list_returns_missing(self):
        # 空列表 -> MISSING（NaN）。注意不能用 == nan 比较
        self.assertFalse(_finite(qc.median([])))

    def test_all_non_finite_returns_missing(self):
        self.assertFalse(_finite(qc.median([float("nan"), float("inf")])))


class TestMad(unittest.TestCase):
    """`mad(values, med=None)`：中位数绝对偏差 = median(|v - med|)。"""

    def test_basic_deviation(self):
        # median = 2 -> devs = [1,1,0] -> 排序 [0,1,1] -> 中位数 1.0
        self.assertEqual(qc.mad([1.0, 3.0, 2.0]), 1.0)

    def test_even_count_deviation_averages(self):
        # median = 2.5 -> devs = [1.5,0.5,0.5,1.5] -> (0.5+1.5)/2 == 1.0
        self.assertEqual(qc.mad([1.0, 2.0, 3.0, 4.0]), 1.0)

    def test_explicit_median_argument_is_honoured(self):
        # 传入不同的 med 必须改变结果（证明参数不是摆设）
        # med=2 -> devs=[1,1,0] -> 1.0 ；med=4 -> devs=[3,1,2] -> 排序[1,2,3] -> 2.0
        self.assertEqual(qc.mad([1.0, 3.0, 2.0], med=4.0), 2.0)

    def test_non_finite_median_gives_missing(self):
        # 源码：med 非有限 -> 直接返回 MISSING，不再算偏差
        self.assertFalse(_finite(qc.mad([1.0, 2.0], med=float("nan"))))

    def test_all_non_finite_values_give_missing(self):
        self.assertFalse(_finite(qc.mad([float("nan"), float("inf")])))


class TestRobustZ(unittest.TestCase):
    """`robust_z(values)`：(v-med)/(1.4826*mad)；分母退化则整列 MISSING。"""

    def test_normal_case(self):
        # median=2, mad=1, scale=1.4826
        #   (1-2)/1.4826 = -0.6744907594765952
        #   (3-2)/1.4826 = +0.6744907594765952
        #   (2-2)/1.4826 = 0.0
        z = qc.robust_z([1.0, 3.0, 2.0])
        self.assertEqual(len(z), 3)
        # 1/1.4826 = 0.6744907594765952
        self.assertAlmostEqual(z[0], -0.6744908, places=7)
        self.assertAlmostEqual(z[1], 0.6744908, places=7)
        self.assertEqual(z[2], 0.0)

    def test_constant_series_hits_zero_scale_branch(self):
        # 常量序列：median=5, mad=0 -> scale=0 -> 退化分支，整列 MISSING
        # 这条最关键：若 0 分母没守住，会抛 ZeroDivisionError
        z = qc.robust_z([5.0, 5.0, 5.0])
        self.assertEqual(len(z), 3)
        for v in z:
            self.assertFalse(_finite(v))

    def test_single_element_hits_zero_scale_branch(self):
        # 单元素同样 mad=0 -> 退化
        z = qc.robust_z([1.0])
        self.assertEqual(len(z), 1)
        self.assertFalse(_finite(z[0]))

    def test_two_equal_elements_hit_zero_scale_branch(self):
        z = qc.robust_z([2.0, 2.0])
        self.assertEqual(len(z), 2)
        for v in z:
            self.assertFalse(_finite(v))

    def test_non_finite_entries_propagate_missing(self):
        # 非有限值本身出 MISSING，不参与中位数/偏差（已被剔除），
        # 但输出中**有对应位置**，不会静默少一个元素
        z = qc.robust_z([1.0, float("nan"), 3.0])
        self.assertEqual(len(z), 3)
        self.assertTrue(_finite(z[0]))
        self.assertFalse(_finite(z[1]))
        self.assertTrue(_finite(z[2]))

    def test_output_is_ordered_by_input(self):
        # 输出必须与输入**同序**，不能因内部排序而串位
        z = qc.robust_z([4.0, 1.0, 3.0, 2.0])
        self.assertEqual(len(z), 4)
        # 最大元素对应最大 z
        self.assertEqual(max(range(4), key=lambda i: z[i]), 0)
        self.assertEqual(min(range(4), key=lambda i: z[i]), 1)


if __name__ == "__main__":
    unittest.main()