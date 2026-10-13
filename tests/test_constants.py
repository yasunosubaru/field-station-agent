"""量纲自检 / 常量 / 输入校验 / 周翻转。

对应 T4：T-13 越界拦截、T-14 GPS 周翻转，另加两条量纲锚点。
原文件的 T-12 映射边界不迁移 —— 映射模块在本项目明确不搬运。
"""
from __future__ import annotations

import unittest

from fieldstation import constants as C
from fieldstation import model

from tests import t7_support as S


class TestDimensions(unittest.TestCase):
    def test_kp_coefficients(self):
        self.assertAlmostEqual(C.k_P("GPS"), 9.5196, delta=5e-4)
        self.assertAlmostEqual(C.k_P("BDS"), 8.9932, delta=5e-4)

    def test_tecu_delay_anchor(self):
        # 1 TECU @ L1 首阶群延迟 ~= 0.162 m
        self.assertAlmostEqual(C.first_order_delay_per_tecu("GPS", "L1"), 0.162, delta=1e-3)

    def test_dcb_anchor(self):
        # 1 ns 差分码偏差 ~= 2.85 TECU
        self.assertAlmostEqual(C.dcb_ns_to_tecu(1.0, "GPS"), 2.85, delta=0.01)

    def test_channel_numbers_are_frequencies(self):
        self.assertAlmostEqual(C.relative_channel(C.get_freq("GPS", "L1")), 154.0, places=6)
        self.assertAlmostEqual(C.relative_channel(C.get_freq("GPS", "L2")), 120.0, places=6)
        self.assertAlmostEqual(C.relative_channel(C.get_freq("BDS", "B1I")), 152.6, places=6)
        self.assertAlmostEqual(C.relative_channel(C.get_freq("BDS", "B2I")), 118.0, places=6)

    def test_constants_self_check(self):
        res = C.self_check(raise_on_fail=False)
        self.assertTrue(res["ok"], res)

    def test_meas_cycle_sign(self):
        self.assertEqual(C.meas_cycle_sign("adr"), -1.0)
        self.assertEqual(C.meas_cycle_sign("phase"), 1.0)
        with self.assertRaises(ValueError):
            C.meas_cycle_sign("bogus")

    def test_flags_to_list(self):
        flag = C.BIT_LOW_ELEV | C.BIT_PSR_BAD
        self.assertEqual(C.flags_to_list(flag), ["low_elev", "psr_bad"])
        self.assertEqual(C.flags_to_list(0), [])


class TestT13Validation(unittest.TestCase):
    def test_valid_passes(self):
        self.assertTrue(model.validate_observation(S.make_observation()))

    def test_elev_out_of_range_raises_strict(self):
        with self.assertRaises(model.ValidationError):
            model.validate_observation(S.make_observation(elev_deg=95.0))

    def test_azim_out_of_range_rejected_non_strict(self):
        self.assertFalse(model.validate_observation(S.make_observation(azim_deg=400.0), strict=False))
        self.assertFalse(model.validate_observation(S.make_observation(azim_deg=-1.0), strict=False))

    def test_non_finite_psr_rejected(self):
        self.assertFalse(model.validate_observation(S.make_observation(psr_m=float("nan")), strict=False))


class TestT14WeekRollover(unittest.TestCase):
    @staticmethod
    def _ep(week, tow):
        return model.EpochPair(station="S", system="GPS", sv=1,
                               gps_week=week, gps_tow_s=tow, epoch_utc="")

    def test_rollover_is_monotonic_and_positive(self):
        # 1023 周末 -> 0 周初；朴素相减会得到负的时间差
        series = [self._ep(1023, 604800.0), self._ep(0, 1.0), self._ep(0, 2.0)]
        t = model.continuous_epoch_time_s(series)
        self.assertEqual(t, [0.0, 1.0, 2.0])
        diffs = [t[i + 1] - t[i] for i in range(len(t) - 1)]
        self.assertTrue(all(d > 0 for d in diffs), diffs)
        self.assertTrue(all(abs(d - 1.0) < 1e-9 for d in diffs), diffs)


class TestTimeConversion(unittest.TestCase):
    def test_gps_utc_roundtrip(self):
        w, tow = 2300, 12345.678
        dt = model.gps_to_utc(w, tow)
        w2, tow2 = model.utc_to_gps(dt)
        self.assertEqual(w2, w)
        self.assertAlmostEqual(tow2, tow, places=3)


if __name__ == "__main__":
    unittest.main()
