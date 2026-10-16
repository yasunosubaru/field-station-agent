# -*- coding: utf-8 -*-
"""`field_width_for` 的回归测试。

背景（issue #14 / KI-10）：环境变量 `GNSS_TEC_FIELD_WIDTH` 里如果出现
**空值项**（形如 `KEY=`，运维手写配置时极易出这种半截写法），函数会
在 `registry.py` 直接抛未捕获的 `ValueError: int('')`，整个数据接入链崩掉。

这里只钉住**这一条崩溃**及其修法。更广的枚举/优先级覆盖另有安排。
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from fieldstation.ingest import registry

ENV_KEY = "GNSS_TEC_FIELD_WIDTH"


class TestFieldWidthEmptyEnvValue(unittest.TestCase):
    """env 里带空值项 / 无等号 / 多余分隔符：一律不能崩。"""

    def setUp(self):
        self._orig = os.environ.get(ENV_KEY)
        self._p = mock.patch.dict(os.environ)
        self._p.start()

    def tearDown(self):
        self._p.stop()
        if self._orig is None:
            os.environ.pop(ENV_KEY, None)
        else:
            os.environ[ENV_KEY] = self._orig

    def test_empty_value_item_is_skipped_not_crash(self):
        """`DAEJ=` —— 键在、值为空。修复前抛 ValueError: invalid literal for int()。"""
        os.environ[ENV_KEY] = "DAEJ="
        try:
            w = registry.field_width_for("DAEJ")
        except ValueError:
            self.fail("空值环境变量项不应抛 ValueError（应跳过该条继续查）")
        # 空值项本身不提供宽度 -> 落到登记表；DAEJ 在登记表里是 16
        self.assertEqual(w, 16)

    def test_empty_value_item_does_not_shadow_later_valid_item(self):
        """同一 env 里空值项之后的合法项仍须生效。"""
        os.environ[ENV_KEY] = "HKWS=;HKWS=15"
        self.assertEqual(registry.field_width_for("HKWS"), 15)

    def test_dirty_separators_and_junk_items_are_tolerated(self):
        os.environ[ENV_KEY] = "garbage;;HKWS=15,,DAEJ="
        self.assertEqual(registry.field_width_for("HKWS"), 15)
        self.assertEqual(registry.field_width_for("DAEJ"), 16)

    def test_all_items_invalid_falls_through_to_registry(self):
        os.environ[ENV_KEY] = "=;garbage;DAEJ="
        self.assertEqual(registry.field_width_for("HKWS"), 15)

    def test_empty_env_string_is_fine(self):
        os.environ[ENV_KEY] = ""
        self.assertEqual(registry.field_width_for("HKWS"), 15)


class _EnvClean(unittest.TestCase):
    """先把这个环境变量摘掉再测，测完还原。

    下面几条期望的是**登记表**里的值（如 `HKWS` = 15）。若这台机器的环境里恰好
    设了 `GNSS_TEC_FIELD_WIDTH`，不摘掉就会得到别的数 —— 那种失败与代码无关。
    """

    def setUp(self):
        p = mock.patch.dict(os.environ)
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop(ENV_KEY, None)


class TestStationTableLookup(_EnvClean):
    """站名登记表：大小写与首尾空白都要能吃。"""

    def test_lookup_is_case_and_space_insensitive(self):
        for raw in ("HKWS", "hkws", "Hkws", "hkws ", "  HKWS", "\tHKWS\n", " hKwS "):
            with self.subTest(station=raw):
                self.assertEqual(registry.field_width_for(raw), 15)

    def test_every_registered_station_is_reachable_by_lookup(self):
        """登记表里每个站都要查得到，大写小写都行。

        这条钉的是历史上真踩过的坑（见 `registry.py` 的注释）：表里写小写、查的
        时候 `.upper()`，于是永远查不到、整张登记表形同虚设（daej / kmnm 曾 0 记录）。
        """
        self.assertTrue(registry.RINEX2_FIELD_WIDTH, "登记表不该是空的")
        for station, width in registry.RINEX2_FIELD_WIDTH.items():
            with self.subTest(station=station):
                self.assertEqual(registry.field_width_for(station), width)
                self.assertEqual(registry.field_width_for(station.lower()), width)

    def test_unregistered_station_returns_none(self):
        self.assertIsNone(registry.field_width_for("TESTSTN"))

    def test_blank_station_returns_none(self):
        self.assertIsNone(registry.field_width_for(""))
        self.assertIsNone(registry.field_width_for("   "))


class TestProgramFallback(_EnvClean):
    """登记表缺项时按生产程序兜底（`PROGRAM_FIELD_WIDTH`）。"""

    #: 左列是真实文件头里出现过的写法（含版本号），右列是期望宽度。
    CASES = (
        ("Spider v7.5", 15),
        ("spider 7.5", 15),
        ("teqc 2020Oct7", 16),
        ("JPS2RIN v.2.0.178", 16),
        ("CCRINEXO", 16),
        ("gfzrnx 1.10", 16),
        ("RTKLIB 2.4.3", 16),
    )

    def test_fallback_for_unregistered_station(self):
        for program, width in self.CASES:
            with self.subTest(program=program):
                self.assertEqual(
                    registry.field_width_for("TESTSTN", program), width)

    def test_only_first_token_of_program_is_used(self):
        """程序串常带版本号；判前缀只看第一个词。"""
        self.assertEqual(registry.field_width_for("TESTSTN", "teqc 2020Oct7"), 16)
        self.assertEqual(registry.field_width_for("TESTSTN", "Spider v7.5"), 15)

    def test_unknown_program_returns_none(self):
        self.assertIsNone(registry.field_width_for("TESTSTN", "convbin 3.0"))

    def test_blank_or_none_program_returns_none(self):
        for program in ("", "   ", "\t", None):
            with self.subTest(program=program):
                self.assertIsNone(registry.field_width_for("TESTSTN", program))

    def test_registered_station_wins_over_program(self):
        """优先级：站名登记表 > 生产程序。HKWS 登记为 15，而 teqc 兜底是 16。"""
        self.assertEqual(registry.field_width_for("HKWS", "teqc 2020Oct7"), 15)


class TestEnvOverridesAll(_EnvClean):
    """优先级：环境变量 > 站名登记表 > 生产程序。"""

    def test_env_overrides_station_table(self):
        os.environ[ENV_KEY] = "HKWS=99"
        self.assertEqual(registry.field_width_for("HKWS"), 99)

    def test_env_overrides_program_fallback(self):
        os.environ[ENV_KEY] = "TESTSTN=17"
        self.assertEqual(registry.field_width_for("TESTSTN", "teqc 2020Oct7"), 17)

    def test_env_key_is_case_insensitive_both_ways(self):
        os.environ[ENV_KEY] = "hkws=99"
        self.assertEqual(registry.field_width_for("HKWS"), 99)
        self.assertEqual(registry.field_width_for("hkws"), 99)

    def test_env_key_and_station_whitespace_are_trimmed(self):
        os.environ[ENV_KEY] = "  HKWS  =  99  "
        self.assertEqual(registry.field_width_for(" HKWS "), 99)

    def test_non_matching_env_falls_through(self):
        os.environ[ENV_KEY] = "OTHERN=99"
        self.assertEqual(registry.field_width_for("HKWS"), 15)
        self.assertEqual(registry.field_width_for("TESTSTN", "Spider v7.5"), 15)
        self.assertIsNone(registry.field_width_for("TESTSTN"))


if __name__ == "__main__":
    unittest.main()