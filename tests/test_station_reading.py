"""台站通用观测模型 StationReading 的测试（M2-1 的 TDD 落点）。

M1-a 的数据字典验收写着「每个字段都有单位与采样率」。这句话用眼睛核对等于没门禁，
所以 M2-1 的接口把「单位必须对上数据字典声明的单位集」做成了**可选参数**：

    validate_reading(r, units=frozenset({"V", "mV", "dB"}))

数据字典空的时候传 None，只查结构性问题（空站名、非有限值、空单位、空字段名）；
字典填完之后把单位集传进来，漏填的单位才会被拦下来。

这样设计而不是硬编码一份单位清单：**单位清单的权威在数据字典，不在代码里**。
代码里写死一份，等真实台站报上来一个清单里没有的单位，就得改代码 ——
而那个改动会同时改变「什么算合法」的判据。

只查结构、不做单位换算：换算由调用方按数据字典显式做。隐式换算是单位错乱的
经典来源（mV 与 V 混写不会报错，只会安静地给出一个离谱的数）。
"""
from __future__ import annotations

import math
import unittest
from datetime import datetime, timezone

from fieldstation.store.model import StationReading, validate_reading

NOW = datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc)


def _reading(**over):
    base = {
        "station_id": "WUH1",
        "sensor": "UPS-1200",
        "metric": "供电电压",
        "value": 23.4,
        "unit": "V",
        "observed_at": NOW,
        "quality_flag": "ok",
    }
    base.update(over)
    return StationReading(**base)


class TestValidateReading(unittest.TestCase):
    def test_valid_reading_passes(self):
        self.assertEqual(validate_reading(_reading()), [])

    def test_empty_station_id_is_a_problem(self):
        problems = validate_reading(_reading(station_id=""))
        self.assertTrue(any("station_id" in p for p in problems))

    def test_whitespace_station_id_is_a_problem(self):
        problems = validate_reading(_reading(station_id="   "))
        self.assertTrue(any("station_id" in p for p in problems))

    def test_non_finite_value_is_a_problem(self):
        for bad in (math.inf, -math.inf, math.nan):
            with self.subTest(value=bad):
                problems = validate_reading(_reading(value=bad))
                self.assertTrue(any("value" in p for p in problems),
                                f"{bad!r} 该被拦下：{problems}")

    def test_empty_unit_is_a_problem(self):
        problems = validate_reading(_reading(unit=""))
        self.assertTrue(any("unit" in p for p in problems))

    def test_empty_metric_is_a_problem(self):
        problems = validate_reading(_reading(metric=""))
        self.assertTrue(any("metric" in p for p in problems))

    def test_unit_not_in_declared_set_is_a_problem(self):
        """单位必须对上数据字典声明的单位集 —— 不在集里就是不一致。"""
        problems = validate_reading(_reading(unit="kV"),
                                    units=frozenset({"V", "mV"}))
        self.assertTrue(any("unit" in p for p in problems))

    def test_unit_in_declared_set_passes(self):
        self.assertEqual(
            validate_reading(_reading(unit="mV"), units=frozenset({"V", "mV"})),
            [])

    def test_empty_units_means_no_unit_check(self):
        """units 为空时不查单位 —— 数据字典还没填完时不该误报。"""
        self.assertEqual(validate_reading(_reading(unit="kV"), units=frozenset()), [])

    def test_multiple_problems_all_reported(self):
        problems = validate_reading(
            StationReading(station_id="", sensor="", metric="",
                           value=math.nan, unit="", observed_at=NOW,
                           quality_flag=""))
        self.assertGreaterEqual(len(problems), 4)

    def test_empty_quality_flag_is_allowed(self):
        """quality_flag 为空表示「还没判质」—— 那是正常中间态，不是错。"""
        self.assertEqual(validate_reading(_reading(quality_flag="")), [])


class TestRoundTrip(unittest.TestCase):
    def test_to_dict_from_dict_round_trip(self):
        from fieldstation.store.model import from_dict, to_dict
        r = _reading()
        back = from_dict(to_dict(r))
        self.assertEqual(back, r)

    def test_from_dict_missing_field_raises(self):
        """缺字段必须大声失败。

        不钉死异常类型（``KeyError`` 与 ``TypeError`` 都算）—— 钉死等于让
        实现去迁就测试，而这里真正要守的只有一条：**不许猜默认值**。
        猜出来的默认值会被当成真实观测混进数据里。
        """
        from fieldstation.store.model import from_dict
        with self.assertRaises((TypeError, KeyError)):
            from_dict({"station_id": "WUH1"})

    def test_to_dict_is_json_friendly(self):
        import json
        from fieldstation.store.model import to_dict
        json.dumps(to_dict(_reading()), sort_keys=True)


class TestUnitConversionNotImplicit(unittest.TestCase):
    """单位换算不在 validate_reading 里做 —— 这一条是显式守卫。

    隐式换算的经典事故：台站报 mV、字典写 V，校验通过，数字悄悄放大 1000 倍。
    """

    def test_validate_returns_problems_not_converted_values(self):
        problems = validate_reading(_reading(value=23.4, unit="V"),
                                    units=frozenset({"V"}))
        self.assertEqual(problems, [])
        self.assertEqual(_reading(value=23.4, unit="V").value, 23.4)


if __name__ == "__main__":
    unittest.main()