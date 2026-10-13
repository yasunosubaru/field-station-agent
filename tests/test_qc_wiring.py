#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QC 必须先于消费方运行 —— 不变量测试。

## 这个文件存在的唯一原因

`qc.run_qc` 是**就地修改** `EpochPair` 的：它写 `arc_id` 与 `quality_flag`。
漏调它不会报错、不会警告，只是让 `arc_id` 恒为 -1、`quality_flag` 恒为 0，
于是下游把整条序列当成一段连续弧。本项目下游的第一个消费方是**弧段编号的
赋予与使用**（弧段 id 决定哪几个历元属于同一弧）。

源项目（GNSS TEC 反演）的同名文件钉的是同一条不变量，消费方是「反演」。
本项目**不搬** `inversion.py`（spec §1.4），故本文件按同一条不变量重写，
消费方换成弧段编号。

原文件中依赖源项目反演模块与上个项目 `run` 入口的
`TestRealDataNoUnphysicalTec`、`TestRunPyWiring` 不迁移 ——
前者需要外部 RINEX/SP3/GIM 数据与反演，后者静态检查的是上个项目的 run.py。

## 合成器从哪来

等价逻辑在源项目的 `test_qc_wiring.py::_mk_obs`，该文件要重写，
故提取为共用工具 `t7_support.make_pairs`。
"""
from __future__ import annotations

import json
import unittest

from fieldstation.rules import qc
from tests import t7_support

#: `run_qc(pairs_by_key, cfg)` 的 cfg 是 **dict**（源实现里是 `cfg.get(...)`），
#: 传 `QCConfig` 实例会在 `run_qc` 内部抛 AttributeError。
#: 空 dict 落到 `default_qc_config` 的硬编码默认值，与 `default_qc_config(None)`
#: 产出的 `QCConfig` 完全一致。
_CFG: dict = {}


class TestQcRunsBeforeConsumer(unittest.TestCase):
    """不接 QC 会怎样 —— 逐条把症状钉死。"""

    def test_arc_id_stays_minus_one_without_qc(self):
        """症状基线：漏调 `qc.run_qc` 时 arc_id 恒 -1。这是要防的那个 bug。"""
        pairs = t7_support.make_pairs(n=200, gap_after=100)
        self.assertTrue(pairs)
        for prs in pairs.values():
            for ep in prs:
                self.assertEqual(ep.arc_id, -1)
                self.assertEqual(ep.quality_flag, 0)

    def test_qc_assigns_real_arc_ids(self):
        """接上 `qc.run_qc` 之后 arc_id 必须被真的赋值。"""
        pairs = t7_support.make_pairs(n=200, gap_after=100)
        qc.run_qc(pairs, _CFG)
        ids = {ep.arc_id for prs in pairs.values() for ep in prs}
        self.assertNotEqual(ids, {-1}, "run_qc 之后 arc_id 仍是 -1，说明没生效")
        self.assertTrue(all(isinstance(i, int) and i >= 0 for i in ids), ids)

    def test_qc_splits_on_large_data_gap(self):
        """核心症状：序列中间有 3600 s 间断却没切段，跨空档把历元算进同一弧。"""
        pairs = t7_support.make_pairs(n=200, gap_after=100, gap_extra=3600)
        qc.run_qc(pairs, _CFG)
        arc_ids = {ep.arc_id for prs in pairs.values() for ep in prs}
        self.assertGreaterEqual(
            len(arc_ids), 2,
            f"含 3600 s 间断的序列必须切成 >=2 段，实得 {sorted(arc_ids)}")
        series = next(iter(pairs.values()))
        self.assertNotEqual(series[99].arc_id, series[100].arc_id)

    def test_qc_report_is_serialisable(self):
        """报告会被直接 json 化（智能体工具的返回契约），不能含不可序列化对象。"""
        pairs = t7_support.make_pairs(n=50)
        report = qc.run_qc(pairs, _CFG)
        json.dumps(report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
