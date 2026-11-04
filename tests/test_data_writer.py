# -*- coding: utf-8 -*-
"""NDJSON 写入的分区路由与幂等性。

关键不变量：**同一个分区重写必须逐字节相同**。这里不只看 sha256，还直接比
``read_bytes()``；顺序打乱、JSON 键序变化、NaN 落盘都在覆盖范围内。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fieldstation.data.manifest import PartitionKey
from fieldstation.data.writer import NdjsonWriter, canonical_line, jsonable
from fieldstation.model import Observation
from fieldstation.store.model import StationReading


def record(station: str, epoch: str, **extra) -> dict:
    row = {
        "station": station,
        "epoch_utc": epoch,
        "system": "G",
        "sv": 1,
        "cn0_dbhz": 40.0,
        "quality_flag": 0,
    }
    row.update(extra)
    return row


class WriterTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="fs-writer-")
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()


class TestIdempotentWrite(WriterTestCase):
    def test_two_writes_are_byte_identical_after_shuffle(self):
        records = [
            record("A", "2026-11-04T07:10:00Z", sv=1, cn0_dbhz=40.0),
            record("A", "2026-11-04T07:50:00Z", sv=2, cn0_dbhz=44.0),
            record("A", "2026-11-04T07:30:00Z", sv=3, cn0_dbhz=42.0),
        ]
        writer = NdjsonWriter(self.root)
        first = writer.write(records)
        self.assertEqual(len(first), 1)
        path = self.root / first[0].path
        first_bytes = path.read_bytes()
        first_manifest = (self.root / "_manifest.json").read_bytes()

        # 打乱输入顺序再写：文件与清单都必须一字不差
        writer.write(list(reversed(records)))
        self.assertEqual(path.read_bytes(), first_bytes)
        self.assertEqual((self.root / "_manifest.json").read_bytes(), first_manifest)

        # 新 writer（重新从清单加载）再写一次，结果仍相同
        NdjsonWriter(self.root).write(records[1:] + records[:1])
        self.assertEqual(path.read_bytes(), first_bytes)

    def test_lines_are_canonical_json(self):
        writer = NdjsonWriter(self.root)
        meta = writer.write([record("A", "2026-11-04T07:10:00Z", note="中文")])[0]
        for line in (self.root / meta.path).read_text(encoding="utf-8").splitlines():
            parsed = json.loads(line)
            expected = json.dumps(
                parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            self.assertEqual(line, expected)

    def test_nan_and_inf_become_null(self):
        writer = NdjsonWriter(self.root)
        meta = writer.write(
            [
                record(
                    "A",
                    "2026-11-04T07:10:00Z",
                    cn0_dbhz=float("nan"),
                    elev_deg=float("inf"),
                )
            ]
        )[0]
        row = json.loads((self.root / meta.path).read_text(encoding="utf-8").strip())
        self.assertIsNone(row["cn0_dbhz"])
        self.assertIsNone(row["elev_deg"])
        # 严格 JSON：文件里不能出现 NaN / Infinity 字面量
        text = (self.root / meta.path).read_text(encoding="utf-8")
        self.assertNotIn("NaN", text)
        self.assertNotIn("Infinity", text)


class TestPartitionRouting(WriterTestCase):
    def test_routes_by_station_date_hour(self):
        writer = NdjsonWriter(self.root)
        metas = writer.write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("A", "2026-11-04T08:10:00Z"),
                record("B", "2026-11-04T07:20:00Z"),
                record("A", "2026-11-05T07:20:00Z"),
            ]
        )
        keys = {meta.key.as_tuple for meta in metas}
        self.assertEqual(
            keys,
            {
                ("A", "2026-11-04", "07"),
                ("A", "2026-11-04", "08"),
                ("B", "2026-11-04", "07"),
                ("A", "2026-11-05", "07"),
            },
        )
        for meta in metas:
            self.assertTrue((self.root / meta.path).is_file())
            self.assertEqual(meta.rows, 1)

    def test_explicit_partition_must_match(self):
        writer = NdjsonWriter(self.root)
        with self.assertRaises(ValueError):
            writer.write_partition(
                [record("A", "2026-11-04T07:10:00Z")],
                PartitionKey("B", "2026-11-04", 7),
            )
        with self.assertRaises(ValueError):
            writer.write_partition(
                [record("A", "2026-11-04T07:10:00Z")],
                PartitionKey("A", "2026-11-04", 8),
            )
        with self.assertRaises(ValueError):
            writer.write([record("A", "2026-11-04T07:10:00Z")], station="B")

    def test_empty_partition_creates_empty_file(self):
        writer = NdjsonWriter(self.root)
        meta = writer.write_partition([], PartitionKey("A", "2026-11-04", 7))
        path = self.root / meta.path
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes(), b"")
        self.assertEqual(meta.rows, 0)


class TestRecordAdapters(WriterTestCase):
    def test_observation_is_partitioned_and_nan_is_null(self):
        observation = Observation(
            station="WUHN",
            receiver_id="R1",
            gps_week=2400,
            gps_tow_s=100.0,
            system="G",
            sv=1,
            signal="L1",
            freq_hz=1575.42e6,
            psr_m=2.1e7,
            adr_cycles=1.0,
            doppler_hz=0.0,
            cn0_dbhz=float("nan"),
            elev_deg=45.0,
            azim_deg=120.0,
        )
        meta = NdjsonWriter(self.root).write([observation])[0]
        self.assertEqual(meta.station, "WUHN")
        self.assertEqual(meta.rows, 1)
        row = json.loads((self.root / meta.path).read_text(encoding="utf-8").strip())
        self.assertIsNone(row["cn0_dbhz"])
        # gps_week/gps_tow_s 推出的时间必须写回 epoch_utc，供查询做时间桶
        self.assertTrue(row["epoch_utc"].endswith("Z"))
        self.assertEqual(row["epoch_utc"], meta.min_time)

    def test_station_reading_uses_observed_at(self):
        reading = StationReading(
            station_id="BJFS",
            sensor="power",
            metric="voltage",
            value=12.3,
            unit="V",
            observed_at=datetime(2026, 11, 4, 7, 5, tzinfo=timezone.utc),
        )
        meta = NdjsonWriter(self.root).write([reading])[0]
        self.assertEqual(meta.key.as_tuple, ("BJFS", "2026-11-04", "07"))
        row = json.loads((self.root / meta.path).read_text(encoding="utf-8").strip())
        self.assertEqual(row["station_id"], "BJFS")
        self.assertIn("+00:00", row["observed_at"])

    def test_missing_time_is_rejected(self):
        with self.assertRaises(ValueError):
            NdjsonWriter(self.root).write([{"station": "A", "cn0_dbhz": 1.0}])

    def test_canonical_line_stable(self):
        a = {"b": 1, "a": 2.0}
        b = {"a": 2.0, "b": 1}
        self.assertEqual(canonical_line(a), canonical_line(b))
        self.assertEqual(canonical_line(a), '{"a":2.0,"b":1}')

    def test_jsonable_nested_values(self):
        value = {
            "when": datetime(2026, 11, 4, 7, 5, tzinfo=timezone.utc),
            "values": [1, float("nan"), {"x": float("inf")}],
        }
        cleaned = jsonable(value)
        self.assertEqual(cleaned["values"], [1, None, {"x": None}])
        self.assertEqual(cleaned["when"], "2026-11-04T07:05:00+00:00")


if __name__ == "__main__":
    unittest.main()
