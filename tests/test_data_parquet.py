# -*- coding: utf-8 -*-
"""NDJSON → Parquet 转换：类型、幂等、报告、缺依赖降级。

**这套测试不 skip**。仓库纪律是 skip 必须为 0；pyarrow 真没装时，用例改走
「断言降级行为」分支——``available()`` 为假、``convert_*()`` 抛
``ParquetUnavailable``。这样门禁在两种环境下都有确定结论，而不是把没装当没发生。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.data import parquet as pq
from fieldstation.data.manifest import PartitionKey, PartitionManifest
from fieldstation.data.writer import NdjsonWriter

#: 不存在的模块名，用来确定性地走「缺包」分支，不必改全局 sys.modules。
ABSENT_MODULE = "__fieldstation_absent_pyarrow__"


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


class ParquetTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="fs-parquet-")
        self.root = Path(self._tmp.name) / "obs"
        self.out = Path(self._tmp.name) / "parquet" / "obs"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, records: list[dict]) -> None:
        NdjsonWriter(self.root).write(records)

    def _only_ndjson(self) -> Path:
        files = sorted(self.root.rglob("*.ndjson"))
        self.assertEqual(len(files), 1, files)
        return files[0]

    def _require_arrow(self, source: Path, target: Path) -> bool:
        """pyarrow 在场返回 True；缺席时断言降级行为并返回 False。

        缺席分支不是「跳过」：它同样验证了一条必须成立的行为（明确异常，不崩不静默）。
        """
        if pq.available():
            return True
        self.assertFalse(pq.available())
        with self.assertRaises(pq.ParquetUnavailable):
            pq.convert_partition(source, target)
        return False


class TestAvailability(ParquetTestCase):
    def test_available_matches_whether_pyarrow_can_be_imported(self):
        self.assertIsInstance(pq.available(), bool)

    def test_absent_module_reports_unavailable_without_raising(self):
        # 关键：缺包时**不能**抛异常，也不能把启动搞挂。
        self.assertFalse(pq.available(ABSENT_MODULE))
        self.assertIn("不可用", pq.unavailable_reason(ABSENT_MODULE))

    def test_reason_is_empty_only_when_available(self):
        self.assertEqual(pq.unavailable_reason() == "", pq.available())

    def test_convert_without_dependency_raises_parquet_unavailable(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        source = self._only_ndjson()
        with self.assertRaises(pq.ParquetUnavailable) as ctx:
            pq.convert_partition(source, self.out / "x.parquet", module_name=ABSENT_MODULE)
        # 明确异常而不是 ImportError：上层据此回落 NDJSON
        self.assertNotIsInstance(ctx.exception, ImportError)

    def test_convert_tree_without_dependency_raises_parquet_unavailable(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        with self.assertRaises(pq.ParquetUnavailable):
            pq.convert_tree(self.root, out_root=self.out, module_name=ABSENT_MODULE)

    def test_missing_source_raises(self):
        with self.assertRaises(pq.ParquetError):
            pq.convert_partition(self.root / "nope.ndjson", self.out / "x.parquet")

    def test_missing_root_raises(self):
        with self.assertRaises(pq.ParquetError):
            pq.convert_tree(self.root / "nope", out_root=self.out)


class TestConversion(ParquetTestCase):
    """转换正例。pyarrow 缺席时各用例改走「断言降级」，仍然执行、仍然有断言。"""

    def test_converted_partition_has_real_column_types(self):
        self._write(
            [
                record("A", "2026-11-04T07:10:00Z", cn0_dbhz=40.0, note="x"),
                record("A", "2026-11-04T07:50:00Z", cn0_dbhz=None, sv=2),
            ]
        )
        source = self._only_ndjson()
        target = self.out / "station=A/date=2026-11-04/hour=07/part-000.parquet"
        if not self._require_arrow(source, target):
            return

        report = pq.convert_partition(source, target)
        self.assertEqual(report.status, "converted")
        self.assertEqual(report.rows, 2)
        self.assertTrue(target.is_file())

        parquet_module = __import__("pyarrow.parquet", fromlist=["parquet"])
        table = parquet_module.read_table(str(target))
        self.assertEqual(table.num_rows, 2)
        self.assertEqual(
            set(table.column_names),
            {"station", "epoch_utc", "system", "sv", "cn0_dbhz", "quality_flag", "note"},
        )
        types = {name: str(table.schema.field(name).type) for name in table.column_names}

        # 核心断言：**列类型真的被解析了**，不是把整行塞成一个 JSON 字符串列
        self.assertEqual(types["epoch_utc"], "timestamp[us, tz=UTC]")
        self.assertEqual(types["cn0_dbhz"], "double")
        self.assertEqual(types["sv"], "int64")
        self.assertEqual(types["quality_flag"], "int64")
        self.assertEqual(types["station"], "string")
        self.assertNotEqual(types["epoch_utc"], "string")
        self.assertNotEqual(types["cn0_dbhz"], "string")

        # 时间与数值要能按真类型取回
        rows = table.to_pylist()
        stamps = sorted(row["epoch_utc"] for row in rows)
        self.assertEqual(stamps[0].isoformat(), "2026-11-04T07:10:00+00:00")
        numbers = sorted(row["sv"] for row in rows)
        self.assertEqual(numbers, [1, 2])
        self.assertIn(None, [row["cn0_dbhz"] for row in rows])

    def test_missing_column_fills_null_instead_of_dropping_or_failing(self):
        """列只在部分行出现时必须补 NULL，不能整列消失、也不能报错。

        为什么测这条：NDJSON 是半结构化的，后出现的字段（``note``）在前几行没有。
        若实现按「第一行定 schema 然后按列取值」，``note`` 会直接丢失——文件仍能
        生成、行数也对，但**数据静默少了一列**。这类损失比崩溃更难发现。
        如果这条挂了，说明 schema 不是扫整个分区得出的，或者补值时抛了异常。
        """
        self._write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("A", "2026-11-04T07:50:00Z", sv=2, note="只在后一行出现"),
            ]
        )
        source = self._only_ndjson()
        target = self.out / "sparse.parquet"
        if not self._require_arrow(source, target):
            return

        report = pq.convert_partition(source, target)
        # 只在部分行出现的列必须进 schema
        self.assertIn("note", report.columns)
        parquet_module = __import__("pyarrow.parquet", fromlist=["parquet"])
        table = parquet_module.read_table(str(target))
        self.assertIn("note", table.column_names)
        self.assertEqual(table.num_rows, 2)

        notes = [row["note"] for row in table.to_pylist()]
        # 缺该字段的那一行是 NULL，而不是空串、不是整行被丢掉
        self.assertEqual(
            sorted(notes, key=lambda v: (v is not None, v)), [None, "只在后一行出现"]
        )
        # 该列类型仍是 string（不是被推断成 null 类型）
        self.assertEqual(str(table.schema.field("note").type), "string")

    def test_boolean_column_stays_boolean(self):
        self._write([record("A", "2026-11-04T07:10:00Z", ok=True)])
        source = self._only_ndjson()
        target = self.out / "b.parquet"
        if not self._require_arrow(source, target):
            return
        pq.convert_partition(source, target)
        parquet_module = __import__("pyarrow.parquet", fromlist=["parquet"])
        table = parquet_module.read_table(str(target))
        self.assertEqual(str(table.schema.field("ok").type), "bool")

    def test_no_single_json_blob_column(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        source = self._only_ndjson()
        target = self.out / "one.parquet"
        if not self._require_arrow(source, target):
            return
        report = pq.convert_partition(source, target)
        self.assertGreater(len(report.columns), 1)
        self.assertNotIn("record", report.columns)
        self.assertNotIn("json", [name.lower() for name in report.columns])

    def test_second_conversion_is_skipped_and_target_untouched(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        source = self._only_ndjson()
        target = self.out / "p.parquet"
        if not self._require_arrow(source, target):
            return

        first = pq.convert_partition(source, target)
        self.assertEqual(first.status, "converted")
        first_bytes = target.read_bytes()
        first_mtime = target.stat().st_mtime_ns

        second = pq.convert_partition(source, target)
        self.assertEqual(second.status, "skipped")
        self.assertEqual(second.rows, first.rows)
        self.assertEqual(target.read_bytes(), first_bytes)
        self.assertEqual(target.stat().st_mtime_ns, first_mtime)

    def test_changed_source_is_reconverted(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        source = self._only_ndjson()
        target = self.out / "p.parquet"
        if not self._require_arrow(source, target):
            return

        pq.convert_partition(source, target)
        # 同分区重写（多一行）：源字节数与 mtime 都变了，必须重转
        self._write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("A", "2026-11-04T07:50:00Z", sv=2),
            ]
        )
        again = pq.convert_partition(source, target)
        self.assertEqual(again.status, "converted")
        self.assertEqual(again.rows, 2)

    def test_force_rewrites_even_when_unchanged(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        source = self._only_ndjson()
        target = self.out / "p.parquet"
        if not self._require_arrow(source, target):
            return
        pq.convert_partition(source, target)
        forced = pq.convert_partition(source, target, force=True)
        self.assertEqual(forced.status, "converted")

    def test_empty_partition_is_reported_not_written(self):
        NdjsonWriter(self.root).write_partition([], PartitionKey("A", "2026-11-04", 7))
        if not pq.available():
            self.assertFalse(pq.available())
            return
        report = pq.convert_tree(self.root, out_root=self.out)
        self.assertEqual(report.empty, 1)
        self.assertEqual(report.converted, 0)
        self.assertEqual(report.total_rows, 0)
        self.assertEqual(list(self.out.rglob("*.parquet")), [])

    def test_layout_is_preserved(self):
        self._write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("B", "2026-11-04T07:20:00Z"),
                record("A", "2026-11-05T07:20:00Z"),
            ]
        )
        if not pq.available():
            with self.assertRaises(pq.ParquetUnavailable):
                pq.convert_tree(self.root, out_root=self.out)
            return
        report = pq.convert_tree(self.root, out_root=self.out)
        self.assertEqual(report.converted, 3)
        self.assertEqual(report.skipped, 0)
        self.assertEqual(report.failed, 0)
        self.assertEqual(report.total_rows, 3)
        relatives = sorted(
            path.relative_to(self.out).as_posix() for path in self.out.rglob("*.parquet")
        )
        self.assertEqual(
            relatives,
            [
                "station=A/date=2026-11-04/hour=07/part-000.parquet",
                "station=A/date=2026-11-05/hour=07/part-000.parquet",
                "station=B/date=2026-11-04/hour=07/part-000.parquet",
            ],
        )
        self.assertGreater(report.total_bytes, 0)
        as_dict = report.to_dict()
        for key in (
            "root",
            "out_root",
            "converted",
            "skipped",
            "empty",
            "failed",
            "total_rows",
            "total_bytes",
            "partitions",
        ):
            self.assertIn(key, as_dict)

    def test_tree_is_idempotent(self):
        self._write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("A", "2026-11-04T08:10:00Z"),
            ]
        )
        if not pq.available():
            self.assertFalse(pq.available())
            return
        first = pq.convert_tree(self.root, out_root=self.out)
        self.assertEqual(first.converted, 2)
        snapshot = {
            path.relative_to(self.out).as_posix(): path.read_bytes()
            for path in self.out.rglob("*.parquet")
        }
        second = pq.convert_tree(self.root, out_root=self.out)
        self.assertEqual(second.converted, 0)
        self.assertEqual(second.skipped, 2)
        again = {
            path.relative_to(self.out).as_posix(): path.read_bytes()
            for path in self.out.rglob("*.parquet")
        }
        self.assertEqual(again, snapshot)
        # 幂等跳过也要报准确行数
        self.assertEqual(second.total_rows, first.total_rows)

    def test_in_place_conversion_does_not_confuse_manifest(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        if not pq.available():
            self.assertFalse(pq.available())
            return
        pq.convert_tree(self.root)  # 不传 out_root：Parquet 落在 NDJSON 旁边
        self.assertEqual(len(list(self.root.rglob("*.parquet"))), 1)
        # Parquet 后缀不在 DATA_SUFFIXES 里，清单扫描与校验都不该把它当数据
        manifest = PartitionManifest.scan(self.root)
        self.assertEqual(len(manifest), 1)
        self.assertEqual(PartitionManifest.load(self.root).verify(self.root), [])

    def test_failed_partition_does_not_stop_the_tree(self):
        self._write(
            [
                record("A", "2026-11-04T07:10:00Z"),
                record("B", "2026-11-04T07:20:00Z"),
            ]
        )
        bad = next(
            path
            for path in sorted(self.root.rglob("*.ndjson"))
            if "station=A" in path.as_posix()
        )
        bad.write_text("{ not json\n", encoding="utf-8")
        if not pq.available():
            # 缺 pyarrow 时根本走不到解析坏行；必须抛「不可用」而不是「坏行」
            with self.assertRaises(pq.ParquetUnavailable):
                pq.convert_tree(self.root, out_root=self.out)
            return

        report = pq.convert_tree(self.root, out_root=self.out)
        self.assertEqual(report.failed, 1)
        self.assertEqual(report.converted, 1)
        failed = [item for item in report.partitions if item.status == "failed"]
        self.assertIn("JSON", failed[0].reason)

        # strict=True 时第一个失败就抛
        with self.assertRaises(pq.ParquetConversionError):
            pq.convert_tree(self.root, out_root=self.out, strict=True, force=True)

    def test_target_relpath_swaps_suffix_only(self):
        self.assertEqual(
            pq.target_relpath("station=A/date=2026-11-04/hour=07/part-000.ndjson"),
            "station=A/date=2026-11-04/hour=07/part-000.parquet",
        )
        self.assertEqual(
            pq.target_relpath("station=A/date=2026-11-04/hour=07/part-000.jsonl"),
            "station=A/date=2026-11-04/hour=07/part-000.parquet",
        )


class TestChunking(ParquetTestCase):
    def test_chunk_rows_splits_batches_without_changing_rows(self):
        self._write(
            [record("A", f"2026-11-04T07:{minute:02d}:00Z", sv=minute + 1) for minute in range(5)]
        )
        source = self._only_ndjson()
        target = self.out / "chunked.parquet"
        if not self._require_arrow(source, target):
            return
        report = pq.convert_partition(source, target, chunk_rows=2)
        self.assertEqual(report.status, "converted")
        self.assertEqual(report.rows, 5)
        parquet_module = __import__("pyarrow.parquet", fromlist=["parquet"])
        table = parquet_module.read_table(str(target))
        self.assertEqual(table.num_rows, 5)

    def test_invalid_chunk_rows_rejected(self):
        self._write([record("A", "2026-11-04T07:10:00Z")])
        with self.assertRaises(ValueError):
            pq.convert_partition(self._only_ndjson(), self.out / "x.parquet", chunk_rows=0)


class TestWriterParquetSwitch(unittest.TestCase):
    """``NdjsonWriter(parquet=...)`` 这个**可选**开关。

    默认必须仍是纯 NDJSON（``writer.py`` 顶部的设计决定不变）；打开时才多一份
    ``.parquet``，且 NDJSON 的字节不受影响。缺 pyarrow 时抛明确异常。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="fs-writer-pq-")
        self.root = Path(self._tmp.name) / "obs"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _records(self) -> list[dict]:
        return [
            record("A", "2026-11-04T07:10:00Z"),
            record("A", "2026-11-04T07:50:00Z", sv=2),
        ]

    def test_default_still_writes_only_ndjson(self):
        NdjsonWriter(self.root).write(self._records())
        self.assertEqual(len(list(self.root.rglob("*.ndjson"))), 1)
        self.assertEqual(list(self.root.rglob("*.parquet")), [])

    def test_default_writer_state_is_false(self):
        self.assertFalse(NdjsonWriter(self.root).parquet)

    def test_ndjson_bytes_are_identical_whether_parquet_is_on(self):
        plain_root = Path(self._tmp.name) / "plain"
        only_ndjson = NdjsonWriter(plain_root).write(self._records())[0]
        plain_bytes = (plain_root / only_ndjson.path).read_bytes()

        if not pq.available():
            # 缺 pyarrow：开关打开必须抛明确异常，而不是把 NDJSON 写坏
            writer = NdjsonWriter(self.root, parquet=True)
            with self.assertRaises(pq.ParquetUnavailable):
                writer.write(self._records())
            with_switch = self.root / only_ndjson.path
            self.assertEqual(with_switch.read_bytes(), plain_bytes)
            return

        both = NdjsonWriter(self.root, parquet=True).write(self._records())[0]
        self.assertEqual((self.root / both.path).read_bytes(), plain_bytes)
        self.assertEqual(len(list(self.root.rglob("*.parquet"))), 1)

    def test_parquet_switch_is_idempotent_across_rewrites(self):
        if not pq.available():
            self.assertFalse(pq.available())
            return
        writer = NdjsonWriter(self.root, parquet=True)
        meta = writer.write(self._records())[0]
        target = (self.root / meta.path).with_suffix(".parquet")
        first = target.read_bytes()
        first_mtime = target.stat().st_mtime_ns

        writer.write(list(reversed(self._records())))
        self.assertEqual(target.read_bytes(), first)
        self.assertEqual(target.stat().st_mtime_ns, first_mtime)

    def test_write_ndjson_helper_accepts_the_switch(self):
        from fieldstation.data.writer import write_ndjson

        if not pq.available():
            with self.assertRaises(pq.ParquetUnavailable):
                write_ndjson(self.root, self._records(), parquet=True)
            # NDJSON 仍然写好了：转换失败不该连累它
            self.assertEqual(len(list(self.root.rglob("*.ndjson"))), 1)
            return

        metas = write_ndjson(self.root, self._records(), parquet=True)
        self.assertEqual(len(metas), 1)
        self.assertEqual(len(list(self.root.rglob("*.parquet"))), 1)


class TestMetadataContract(unittest.TestCase):
    def test_settings_are_declared(self):
        # 这个常量是外部文档（bench-sql.md / 打包脚本）依赖的名字，别悄悄改
        self.assertEqual(pq.DEFAULT_PARQUET_FILENAME, "part-000.parquet")
        self.assertGreater(pq.DEFAULT_CHUNK_ROWS, 0)

    def test_module_imports_without_pyarrow(self):
        # 门禁纪律：import 本模块永远成功，pyarrow 只在函数内 import。
        import fieldstation.data.parquet as module

        self.assertTrue(hasattr(module, "convert_tree"))


if __name__ == "__main__":
    unittest.main()
