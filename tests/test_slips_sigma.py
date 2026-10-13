#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""周跳检测的 sigma 退化处理 —— 回归测试。

## 这个文件存在的唯一原因

`qc.py:detect_slips` 曾经有三处缺陷，全部在真实数据上暴露过：

1. `diag["sigma_gf_window"]` 是**硬编码的 None**。第 224 行真正算出的
   per-epoch sigma 从没被记录，于是「sigma_gf=None」看起来像算失败，
   其实只是没实现。诊断信息不可信 -> 「周跳检出率」这个数字无法评估。

2. 方法 A 的判据写成
       (sigma > 0 and |r| > k*sigma) or sigma == 0
   历史窗口去趋势后完全平直时 sigma 恰为 0，于是**任何**
   |r| > slip_min_jump_tecU 的历元都被判成周跳 —— 那等于把「除零」
   写成了一个显式旁路。

3. 方法 B 里 `sigma_big = sigma_mw > 0`，当 sigma_mw 退化为 0 时
   （实测 KAZA 全部 25 条序列都是 0.0）退化成硬编码的 `|d| > 10 TECU`
   绝对阈值 —— 与数据无关的魔数，且让各站的检出率不可比。

现在统一用物理地板 `slip_sigma_floor_tecu`（默认 1.0 TECU，
依据 1 ns ≈ 0.55 TECU）代替这两条旁路，并把真实 sigma 记进诊断。
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fieldstation.rules import qc as QC          # noqa: E402
from fieldstation import model as S              # noqa: E402

L1_HZ, L2_HZ = 1575.42e6, 1227.60e6


def _series(adr_jump_at=None, n=400, noise=0.0, dt=30.0, flat=False):
    """造一条双频观测序列。

    * `adr_jump_at` -> 在该历元给 L1 加一个模糊度阶跃（真周跳）
    * `flat=True`   -> 造出「去趋势后完全平直」的历史（sigma 退化为 0）
    """
    from fieldstation import constants as C
    lam1, lam2 = C.C_LIGHT / L1_HZ, C.C_LIGHT / L2_HZ
    out = []
    for i in range(n):
        psr = 2.2e7 + 1.0 * i * dt
        # 平直历史：每个历元都完全落在一条直线上，没有逐点残差
        jitter = 0.0 if flat else (noise if i % 2 else -noise)
        jump = 100.0 if (adr_jump_at is not None and i >= adr_jump_at) else 0.0
        base = dict(station="TST", receiver_id="", gps_week=2300,
                    gps_tow_s=100000.0 + i * dt, system="GPS", sv=3,
                    elev_deg=45.0, azim_deg=180.0, sys_code=0, sig_code=0)
        out.append(S.Observation(
            signal="L1", freq_hz=L1_HZ, psr_m=psr,
            adr_cycles=-(psr / lam1) - jump - jitter, doppler_hz=float("nan"),
            cn0_dbhz=45.0, **base))
        out.append(S.Observation(
            signal="L2", freq_hz=L2_HZ, psr_m=psr,
            adr_cycles=-(psr / lam2) - jitter, doppler_hz=float("nan"),
            cn0_dbhz=42.0, **base))
    return S.pair_observations(out)[("TST", "GPS", 3)]


def _cfg(**over):
    a = {"adr_sign": "adr", "leveling_tau_TECU": 0.4, "sigma_psr_m": 0.3,
         "min_arc_len_s": 600.0, "shell_height_km": 450.0}
    a.update(over)
    return {"algo": a, "qc": {}, "shell_height_km": 450.0,
            "elev_mask_deg": 15.0, "dt_s": 30.0,
            "stations": {"TST": {"lat_deg": 0.0, "lon_deg": 0.0, "h_m": 0.0}}}


def _run(ser, **over):
    cfg = QC.default_qc_config(_cfg(**over))
    return QC.detect_slips(ser, "GPS", "L1", "L2", -1.0, cfg)


class TestSlipSigmaDiagnostics(unittest.TestCase):
    """坑 1：诊断里的 sigma_gf_window 曾经是硬编码的 None。"""

    def test_sigma_gf_window_is_reported(self):
        _slips, d = _run(_series(noise=0.01))
        self.assertIsNotNone(d["sigma_gf_window"],
                             "sigma_gf_window 又变回 None 了？")
        sg = d["sigma_gf_window"]
        for k in ("n", "median", "p10", "p90", "n_zero", "floor_used"):
            self.assertIn(k, sg, f"诊断缺字段 {k}")
        self.assertGreater(sg["n"], 0, "没有采到任何 sigma 样本")
        self.assertGreaterEqual(sg["median"], 0.0)

    def test_sigma_mw_degenerate_flag_is_bool(self):
        _slips, d = _run(_series(noise=0.01))
        self.assertIsInstance(d["sigma_mw_degenerate"], bool)

    def test_diag_is_json_serialisable(self):
        import json
        _slips, d = _run(_series(noise=0.01))
        json.dumps(d, ensure_ascii=False, default=str)


class TestSlipSigmaDegeneracy(unittest.TestCase):
    """坑 2/3：sigma 退化为 0 时不再无条件成立、也不再退化成魔数阈值。"""

    def test_flat_history_does_not_flag_every_epoch(self):
        """平直历史（sigma->0）时，绝不能把整条弧段都判成周跳。

        修之前的 `... or sigma == 0` 会让任何 |r| > 0.5 TECU 的历元通过，
        200 个历元能报出上百个「周跳」。
        """
        slips, d = _run(_series(n=200, flat=True))
        self.assertLessEqual(
            len(slips), 5,
            f"平直历史报出 {len(slips)} 个周跳，显然是 sigma==0 旁路复发")

    def test_flat_history_still_detects_real_jump(self):
        """sigma 退化时**真实**的大阶跃仍必须能检出（地板不能过严）。"""
        slips, _d = _run(_series(n=200, flat=True, adr_jump_at=100))
        self.assertIn(100, slips,
                      f"平直历史里的真周跳(历元100)漏检了，实际检出 {sorted(slips)}")

    def test_real_jump_detected_with_noise(self):
        slips, _d = _run(_series(n=400, noise=0.01, adr_jump_at=200))
        self.assertIn(200, slips, f"真周跳漏检，检出 {sorted(slips)}")

    def test_no_jump_means_no_slips(self):
        slips, _d = _run(_series(n=400, noise=0.01))
        self.assertEqual(slips, set(), f"无周跳却检出 {sorted(slips)}")

    def test_floor_is_configurable_and_used(self):
        _slips, d = _run(_series(n=200, flat=True), slip_sigma_floor_tecu=3.0)
        self.assertEqual(d["sigma_gf_window"]["floor_used"], 3.0)

    def test_floor_actually_raises_detection_bar(self):
        """地板必须真的抬高门槛，而不是只写进诊断。

        用同一份合成数据（100 周期的 L1 阶跃 -> IL 跳变 181.15 TECU）：
          地板 1.0   -> GF 检出（判据 4*1.0 = 4 TECU  <  181）
          地板 100.0 -> GF 被地板挡住（判据 4*100 = 400 TECU > 181）
        只看 union 会混淆两条路径，所以分方法断言。
        """
        from fieldstation.rules import qc as QC
        ser = _series(n=200, flat=True, adr_jump_at=100)
        counts = {}
        for floor in (1.0, 100.0):
            cfg = QC.default_qc_config(_cfg(slip_sigma_floor_tecu=floor))
            _s, d = QC.detect_slips(ser, "GPS", "L1", "L2", -1.0, cfg)
            counts[floor] = d["n_slip_gf"]
        self.assertGreater(counts[1.0], 0,
                           "地板 1.0 时 GF 应当检出这个 181 TECU 的阶跃")
        self.assertEqual(counts[100.0], 0,
                         f"地板 100.0 时 GF 仍检出 {counts[100.0]} 次，"
                         f"说明地板没真正参与判据")

    def test_sigma_zero_counted(self):
        _slips, d = _run(_series(n=200, flat=True))
        self.assertGreaterEqual(
            d["sigma_gf_window"]["n_zero"], 0, "缺 n_zero 统计")


class TestQcConfig(unittest.TestCase):
    def test_sigma_floor_default(self):
        c = QC.default_qc_config({"algo": {}})
        self.assertGreater(c.slip_sigma_floor_tecu, 0.0)

    def test_sigma_floor_from_config(self):
        c = QC.default_qc_config({"algo": {"slip_sigma_floor_tecu": 2.5}})
        self.assertAlmostEqual(c.slip_sigma_floor_tecu, 2.5, places=6)

    def test_sigma_floor_is_physical(self):
        """地板应落在 1 ns(0.55 TECU) 与典型周跳(>2 TECU) 之间。"""
        c = QC.default_qc_config({"algo": {}})
        self.assertGreaterEqual(c.slip_sigma_floor_tecu, 0.55,
                                "地板低于 1 ns 等效噪声，会被逐点噪声触发")
        self.assertLessEqual(c.slip_sigma_floor_tecu, 2.0,
                             "地板高于 2 TECU 会漏掉真实周跳")


if __name__ == "__main__":
    unittest.main(verbosity=2)
