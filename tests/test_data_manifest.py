# -*- coding: utf-8 -*-
"""分区清单的测试：写入 → 清单 → 扫描 → 查询的完整链，以及校验的负例。

这些用例不依赖 duckdb / clickhouse，也不依赖仓库里的 data/ 目录。
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.data.manifest import (
    MANIFEST_NAME,
    ManifestError,
    PartitionKey,
    PartitionManifest,
    inspect_file,
    parse_partition_relpath,
    partition_file,
)
from fieldstation.data.query import Aggregate, QuerySpec, execute
from fieldstation.data.writer import NdjsonWriter

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


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


class ManifestTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="fs-manifest-")
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()


class TestPartitionKey(ManifestTestCase):
    def test_hour_is_zero_padded_and_date_is_normalised(self):
        key = PartitionKey("WUHN", "2026-11-04", 7)
        self.assertEqual(key.as_tuple, ("WUHN", "2026-11-04", "07"))
        self.assertEqual(
            key.relpath(),
            "station=WUHN/date=2026-11-04/hour=07/part-000.ndjson",
        )

    def test_invalid_hour_and_station_rejected(self):
        with self.assertRaises(ValueError):
            PartitionKey("WUHN", "2026-11-04", 24)
        with self.assertRaises(ValueError):
            PartitionKey("A/B", "2026-11-04", 1)
        with self.assertRaises(ValueError):
            PartitionKey("WUHN", "2026/11/04", 1)

    def test_parse_round_trip(self):
        key = PartitionKey("BJFS", "2026-11-04", 9)
        self.assertEqual(parse_partition_relpath(key.relpath()), key)

    def test_parse_rejects_other_layouts(self):
        for bad in (
            "BJFS/2026-11-04/09/part.ndjson",
            "station=BJFS/date=2026-11-04/part-000.ndjson",
            "station=BJFS/date=2026-11-04/hour=09/part-000.csv",
        ):
            with self.subTest(bad=bad), self.assertRaises(ManifestError):
                parse_partition_relpath(bad)


class TestWriteManifestScanQuery(ManifestTestCase):
    def test_full_chain(self):
        writer = NdjsonWriter(self.root)
        writer.write(
            [
                record("A", "2026-11-04T07:10:00Z", cn0_dbhz=40.0),
                record("A", "2026-11-04T07:50:00Z", cn0_dbhz=44.0),
                record("B", "2026-11-04T08:05:00Z", cn0_dbhz=50.0),
            ]
        )

        manifest = PartitionManifest.load(self.root)
        self.assertEqual(len(manifest), 2)
        card_a = manifest.get("A", "2026-11-04", 7)
        self.assertIsNotNone(card_a)
        assert card_a is not None
        self.assertEqual(card_a.rows, 2)
        self.assertEqual(card_a.min_time, "2026-11-04T07:10:00Z")
        self.assertEqual(card_a.max_time, "2026-11-04T07:50:00Z")
        self.assertIn("cn0_dbhz", card_a.columns)
        self.assertEqual(card_a.sha256, hashlib.sha256(
            (self.root / card_a.path).read_bytes()
        ).hexdigest())

        scanned = PartitionManifest.scan(self.root)
        self.assertEqual(scanned, manifest)
        self.assertEqual(manifest.verify(self.root), [])

        result = execute(
            self.root,
            QuerySpec(
                aggregates=(Aggregate("count", "*", "n"),),
            ),
        )
        self.assertEqual(result.rows, [{"n": 3}])

        avg = execute(
            self.root,
            QuerySpec(
                filters=(),
                group_by=("station",),
                aggregates=(Aggregate("avg", "cn0_dbhz", "avg_cn0"),),
                order_by=(("station", "asc"),),
            ),
        )
        self.assertEqual(avg.rows[0]["station"], "A")
        self.assertAlmostEqual(avg.rows[0]["avg_cn0"], 42.0)


class TestMetaSerialization(ManifestTestCase):
    def setUp(self) -> None:
        super().setUp()
        NdjsonWriter(self.root).write([record("A", "2026-11-04T07:10:00Z")])
        self.manifest = PartitionManifest.load(self.root)
        self.card = self.manifest.partitions[0]

    def test_card_dict_round_trip(self):
        restored = type(self.card).from_dict(self.card.to_dict())
        self.assertEqual(restored, self.card)

    def test_manifest_json_round_trip(self):
        text = self.manifest.to_json()
        restored = PartitionManifest.from_json(text, root=self.root)
        self.assertEqual(restored, self.manifest)
        # 再序列化一次必须逐字节相同
        self.assertEqual(restored.to_json(), text)

    def test_save_is_idempotent(self):
        path = self.root / MANIFEST_NAME
        first = path.read_bytes()
        self.manifest.save(self.root)
        self.assertEqual(path.read_bytes(), first)

    def test_future_schema_version_rejected(self):
        data = json.loads(self.manifest.to_json())
        data["schema_version"] = 999
        with self.assertRaises(ManifestError):
            PartitionManifest.from_dict(data)


class TestVerify(ManifestTestCase):
    def setUp(self) -> None:
        super().setUp()
        NdjsonWriter(self.root).write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("A", "2026-11-04T07:20:00Z"),
            ]
        )
        self.manifest = PartitionManifest.load(self.root)
        self.card = self.manifest.partitions[0]

    def test_detects_appended_row(self):
        path = self.root / self.card.path
        with path.open("ab") as fh:
            fh.write(b'{"station":"A","epoch_utc":"2026-11-04T07:30:00Z"}\n')
        problems = self.manifest.verify(self.root)
        text = "\n".join(problems)
        self.assertIn("sha256", text)
        self.assertIn("rows", text)
        self.assertIn("bytes", text)

    def test_detects_missing_file(self):
        (self.root / self.card.path).unlink()
        problems = self.manifest.verify(self.root)
        self.assertTrue(any("文件不存在" in item for item in problems))

    def test_detects_unregistered_file(self):
        key = PartitionKey("C", "2026-11-04", 9)
        path = partition_file(self.root, key)
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(record("C", "2026-11-04T09:10:00Z"), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        problems = self.manifest.verify(self.root)
        self.assertTrue(any("未登记" in item for item in problems))

    def test_scan_ignores_tmp_and_manifest(self):
        (self.root / ".leftover.ndjson.tmp").write_text("junk", encoding="utf-8")
        scanned = PartitionManifest.scan(self.root)
        self.assertEqual(len(scanned), 1)


class TestEmptyPartition(ManifestTestCase):
    def test_empty_file_has_card_and_queryable(self):
        key = PartitionKey("EMPTY", "2026-11-04", 9)
        writer = NdjsonWriter(self.root)
        card = writer.write_partition([], key)

        self.assertEqual(card.rows, 0)
        self.assertIsNone(card.min_time)
        self.assertIsNone(card.max_time)
        self.assertEqual(card.columns, ())
        self.assertEqual(card.bytes, 0)
        self.assertEqual(card.sha256, EMPTY_SHA256)

        scanned = PartitionManifest.scan(self.root)
        self.assertEqual(scanned.partitions, [card])
        self.assertEqual(scanned.verify(self.root), [])

        result = execute(
            self.root,
            QuerySpec(aggregates=(Aggregate("count", "*", "n"),)),
        )
        self.assertEqual(result.rows, [{"n": 0}])

        grouped = execute(
            self.root,
            QuerySpec(
                group_by=("station",),
                aggregates=(Aggregate("count", "*", "n"),),
            ),
        )
        self.assertEqual(grouped.rows, [])

    def test_inspect_file_directly(self):
        key = PartitionKey("EMPTY", "2026-11-04", 10)
        path = partition_file(self.root, key)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"")
        card = inspect_file(path, root=self.root)
        self.assertEqual(card.rows, 0)
        self.assertEqual(card.sha256, EMPTY_SHA256)


if __name__ == "__main__":
    unittest.main()
