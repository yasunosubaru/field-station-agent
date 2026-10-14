# -*- coding: utf-8 -*-
"""`store/station.py`（台站台账数据模型）的测试。

写这个文件的原因：在此之前仓库里**没有任何地方记录一座台站长什么样** ——
智能体要判断"这个站是不是坏了"，得先知道"这个站长什么样"。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.store.station import (
    LINK_MODES,
    POWER_MODES,
    Station,
    from_dict,
    load_registry,
    save_registry,
    to_dict,
    validate,
)

FULL = {
    "code": "ABCS",
    "receiver": "TRIG",
    "antenna": "TRM59800.99",
    "power": "mains",
    "link": "fiber",
    "manned": False,
    "lat_deg": 30.5,
    "lon_deg": 114.1,
    "alt_m": 40.0,
    "sensors": ["gnss", "meteo"],
    "notes": "测试用",
}


class TestValidate(unittest.TestCase):
    def test_valid_station_has_no_problems(self):
        self.assertEqual(validate(Station(**FULL)), [])

    def test_missing_code_is_reported(self):
        s = Station(code="")
        self.assertIn("code", validate(s)[0])

    def test_code_too_long_is_reported(self):
        s = Station(code="ABCDE")
        self.assertTrue(any("code" in p for p in validate(s)))

    def test_bad_power_and_link_are_both_reported(self):
        """一次报出**所有**问题，而不是撞到第一个就停。"""
        s = Station(code="ABCS", power="nuclear", link="smoke")
        problems = validate(s)
        self.assertGreaterEqual(len(problems), 2)
        joined = " ".join(problems)
        self.assertIn("power", joined)
        self.assertIn("link", joined)

    def test_power_and_link_whitelists_cover_documented_values(self):
        self.assertEqual(POWER_MODES, ("mains", "solar", "hybrid"))
        self.assertEqual(LINK_MODES, ("fiber", "4g", "satellite"))

    def test_empty_power_and_link_are_legal(self):
        # 空串 = 台账没填，不等于填错了
        s = Station(code="ABCS", power="", link="")
        self.assertEqual(validate(s), [])

    def test_out_of_range_coordinates_are_reported(self):
        s = Station(code="ABCS", lat_deg=91.0, lon_deg=181.0)
        joined = " ".join(validate(s))
        self.assertIn("lat_deg", joined)
        self.assertIn("lon_deg", joined)

    def test_altitude_below_floor_is_reported(self):
        # 死海约 -430m，低于 -500m 基本是笔误
        s = Station(code="ABCS", alt_m=-600.0)
        self.assertTrue(any("alt_m" in p for p in validate(s)))

    def test_boundary_coordinates_are_accepted(self):
        s = Station(code="S", lat_deg=-90.0, lon_deg=180.0, alt_m=-500.0)
        self.assertEqual(validate(s), [])

    def test_duplicate_sensors_are_reported(self):
        s = Station(code="ABCS", sensors=["gnss", "gnss"])
        self.assertTrue(any("sensors" in p for p in validate(s)))


class TestFromDict(unittest.TestCase):
    def test_full_dict_roundtrips_exactly(self):
        self.assertEqual(to_dict(from_dict(FULL)), FULL)

    def test_missing_code_raises_value_error_mentioning_code(self):
        with self.assertRaises(ValueError) as cm:
            from_dict({"receiver": "TRIG"})
        self.assertIn("code", str(cm.exception))

    def test_empty_code_raises(self):
        with self.assertRaises(ValueError):
            from_dict({"code": ""})

    def test_unknown_key_is_rejected(self):
        """字段名拼错必须炸 —— 缺字段会报缺，多一个拼错的名字不会。"""
        with self.assertRaises(ValueError) as cm:
            from_dict({"code": "ABCS", "reciver": "typo"})
        self.assertIn("reciver", str(cm.exception))

    def test_sensors_defaults_to_empty_list(self):
        s = from_dict({"code": "ABCS"})
        self.assertEqual(s.sensors, [])

    def test_sensors_are_copied_not_aliased(self):
        src = ["gnss"]
        s = from_dict({"code": "ABCS", "sensors": src})
        src.append("meteo")
        self.assertEqual(s.sensors, ["gnss"])

    def test_non_dict_raises(self):
        with self.assertRaises(ValueError):
            from_dict(["ABCS"])


class TestToDict(unittest.TestCase):
    def test_roundtrip_is_key_stable(self):
        d1 = to_dict(from_dict(FULL))
        d2 = to_dict(from_dict(d1))
        self.assertEqual(d1, d2)
        self.assertEqual(list(d1), list(d2))


class TestLoadRegistry(unittest.TestCase):
    def write(self, tmp, payload):
        p = Path(tmp) / "stations.json"
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return p

    def test_load_good_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self.write(tmp, [FULL, dict(FULL, code="XYZS", power="solar",
                                            link="4g", lat_deg=-33.7, lon_deg=150.1,
                                            alt_m=210.0, sensors=["gnss", "seismo"])])
            reg = load_registry(p)
            self.assertEqual(set(reg), {"ABCS", "XYZS"})
            self.assertEqual(reg["ABCS"].receiver, "TRIG")

    def test_duplicate_code_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self.write(tmp, [FULL, dict(FULL)])
            with self.assertRaises(ValueError) as cm:
                load_registry(p)
            self.assertIn("重复", str(cm.exception))

    def test_all_problems_are_reported_together(self):
        """多个站、多个错，一次性全报出来。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = self.write(tmp, [
                FULL,
                dict(FULL, code="XYZS", power="bad"),
                dict(FULL, code="ZZZZZ"),   # 5 字符 -> code 超长
            ])
            with self.assertRaises(ValueError) as cm:
                load_registry(p)
            msg = str(cm.exception)
            self.assertIn("XYZS", msg)     # power 错
            self.assertIn("ZZZZZ", msg)    # code 超长

    def test_missing_file_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError) as cm:
                load_registry(Path(tmp) / "nope.json")
            self.assertIn("不存在", str(cm.exception))

    def test_bad_json_raises_value_error_not_jsondecodeerror(self):
        """调用方只该捕获 ValueError 一种异常。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "bad.json"
            p.write_text("{ not json", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_registry(p)

    def test_top_level_not_list_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "obj.json"
            p.write_text('{"code": "ABCS"}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_registry(p)

    def test_save_then_load_is_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self.write(tmp, [FULL, dict(FULL, code="XYZS")])
            reg = load_registry(p)
            out = Path(tmp) / "roundtrip.json"
            save_registry(reg, out)
            self.assertEqual(load_registry(out), reg)


class TestExampleRegistry(unittest.TestCase):
    """examples/stations.example.json 必须是合法台账。"""

    def test_example_registry_loads(self):
        p = Path(__file__).resolve().parents[1] / "examples" / "stations.example.json"
        self.assertTrue(p.is_file(), f"样例台账不存在: {p}")
        reg = load_registry(p)
        self.assertGreaterEqual(len(reg), 2)

    def test_example_stations_are_all_valid(self):
        p = Path(__file__).resolve().parents[1] / "examples" / "stations.example.json"
        reg = load_registry(p)
        for code, st in reg.items():
            self.assertEqual(validate(st), [], f"{code} 不合法: {validate(st)}")


if __name__ == "__main__":
    unittest.main()