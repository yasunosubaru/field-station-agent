# -*- coding: utf-8 -*-
"""内置查询引擎：过滤、时间桶、分组聚合、空分区与 limit。

数据集（5 行）::

    A 07:05 G sv1 40 q0
    A 07:35 G sv2 44 q1
    A 07:55 C sv3 50 q0
    B 08:05 G sv1 60 q0
    B 08:35 G sv2 70 q1
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.data.engines import (
    BuiltinEngine,
    ClickHouseEngine,
    DuckDBEngine,
    EngineError,
    EngineUnavailable,
    available_engines,
    get_engine,
)
from fieldstation.data.manifest import PartitionKey
from fieldstation.data.query import (
    Aggregate,
    Predicate,
    QueryError,
    QuerySpec,
    bucket_start,
    count_rows,
    execute,
    parse_bucket,
)
from fieldstation.data.writer import NdjsonWriter


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


class QueryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="fs-query-")
        self.root = Path(self._tmp.name)
        NdjsonWriter(self.root).write(
            [
                record("A", "2026-11-04T07:05:00Z", sv=1, cn0_dbhz=40.0, quality_flag=0),
                record("A", "2026-11-04T07:35:00Z", sv=2, cn0_dbhz=44.0, system="G", quality_flag=1),
                record("A", "2026-11-04T07:55:00Z", sv=3, cn0_dbhz=50.0, system="C", quality_flag=0),
                record("B", "2026-11-04T08:05:00Z", sv=1, cn0_dbhz=60.0, quality_flag=0),
                record("B", "2026-11-04T08:35:00Z", sv=2, cn0_dbhz=70.0, quality_flag=1),
            ]
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()


class TestFiltersAndAggregates(QueryTestCase):
    def test_filter_then_count_avg_min_max(self):
        result = execute(
            self.root,
            QuerySpec(
                filters=(Predicate("station", "==", "A"),),
                aggregates=(
                    Aggregate("count", "*", "n"),
                    Aggregate("avg", "cn0_dbhz", "avg_cn0"),
                    Aggregate("min", "cn0_dbhz", "lo"),
                    Aggregate("max", "cn0_dbhz", "hi"),
                ),
            ),
        )
        self.assertEqual(result.columns, ("n", "avg_cn0", "lo", "hi"))
        self.assertEqual(len(result.rows), 1)
        row = result.rows[0]
        self.assertEqual(row["n"], 3)
        self.assertAlmostEqual(row["avg_cn0"], (40 + 44 + 50) / 3)
        self.assertEqual(row["lo"], 40.0)
        self.assertEqual(row["hi"], 50.0)

    def test_multiple_filters_are_anded(self):
        result = execute(
            self.root,
            QuerySpec(
                filters=(
                    Predicate("station", "==", "A"),
                    Predicate("quality_flag", "==", 0),
                ),
                aggregates=(Aggregate("count", "*", "n"),),
            ),
        )
        self.assertEqual(result.scalar(), 2)

    def test_count_distinct(self):
        result = execute(
            self.root,
            QuerySpec(
                group_by=("station",),
                aggregates=(Aggregate("count_distinct", "sv", "sv_count"),),
                order_by=(("station", "asc"),),
            ),
        )
        self.assertEqual(
            result.rows,
            [{"station": "A", "sv_count": 3}, {"station": "B", "sv_count": 2}],
        )

    def test_group_by_limit_order(self):
        result = execute(
            self.root,
            QuerySpec(
                group_by=("station",),
                aggregates=(Aggregate("count", "*", "n"),),
                order_by=(("n", "desc"), ("station", "asc")),
                limit=1,
            ),
        )
        self.assertEqual(result.rows, [{"station": "A", "n": 3}])

    def test_limit_zero_returns_no_rows(self):
        result = execute(self.root, QuerySpec(limit=0))
        self.assertEqual(result.rows, [])
        self.assertEqual(len(result.columns), 6)

    def test_predicate_variants(self):
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("station", "in", ["A"]),)), 3
        )
        self.assertEqual(
            count_rows(
                self.root,
                filters=(Predicate("cn0_dbhz", "between", (40.0, 50.0)),),
            ),
            3,
        )
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("station", "startswith", "A"),)),
            3,
        )
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("station", "contains", "UH"),)),
            0,
        )
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("station", "contains", "B"),)),
            2,
        )
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("missing_field", "is null"),)),
            5,
        )
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("station", "not in", ["A"]),)),
            2,
        )


class TestBuckets(QueryTestCase):
    def test_parse_bucket(self):
        self.assertEqual(parse_bucket("30s"), 30)
        self.assertEqual(parse_bucket("15m"), 900)
        self.assertEqual(parse_bucket("1 hour"), 3600)
        self.assertEqual(parse_bucket("1d"), 86400)
        with self.assertRaises(QueryError):
            parse_bucket("1 month")
        with self.assertRaises(QueryError):
            parse_bucket("0h")

    def test_bucket_start_aligns_utc(self):
        self.assertEqual(bucket_start("2026-11-04T07:35:12Z", 3600), "2026-11-04T07:00:00Z")
        self.assertEqual(bucket_start("2026-11-04T07:35:12Z", 900), "2026-11-04T07:30:00Z")
        self.assertEqual(bucket_start("2026-11-04T07:35:12Z", 86400), "2026-11-04T00:00:00Z")

    def test_hourly_counts(self):
        result = execute(
            self.root,
            QuerySpec(
                bucket="1h",
                aggregates=(Aggregate("count", "*", "n"),),
                order_by=(("bucket", "asc"),),
            ),
        )
        self.assertEqual(
            result.rows,
            [
                {"bucket": "2026-11-04T07:00:00Z", "n": 3},
                {"bucket": "2026-11-04T08:00:00Z", "n": 2},
            ],
        )

    def test_fifteen_minute_buckets_for_one_station(self):
        result = execute(
            self.root,
            QuerySpec(
                filters=(Predicate("station", "==", "A"),),
                bucket="15m",
                aggregates=(Aggregate("count", "*", "n"),),
                order_by=(("bucket", "asc"),),
            ),
        )
        self.assertEqual(len(result.rows), 3)
        self.assertEqual([row["n"] for row in result.rows], [1, 1, 1])
        self.assertEqual(result.rows[0]["bucket"], "2026-11-04T07:00:00Z")

    def test_bucket_plus_second_group_field(self):
        result = execute(
            self.root,
            QuerySpec(
                bucket="1h",
                group_by=("station",),
                aggregates=(Aggregate("count", "*", "n"),),
                order_by=(("bucket", "asc"), ("station", "asc")),
            ),
        )
        self.assertEqual(
            [(row["bucket"], row["station"], row["n"]) for row in result.rows],
            [
                ("2026-11-04T07:00:00Z", "A", 3),
                ("2026-11-04T08:00:00Z", "B", 2),
            ],
        )


class TestEmptyAndErrors(QueryTestCase):
    def test_empty_partition_does_not_break_count(self):
        NdjsonWriter(self.root).write_partition(
            [], PartitionKey("EMPTY", "2026-11-04", 9)
        )
        self.assertEqual(count_rows(self.root), 5)
        self.assertEqual(
            count_rows(self.root, filters=(Predicate("station", "==", "EMPTY"),)), 0
        )
        grouped = execute(
            self.root,
            QuerySpec(
                group_by=("station",),
                aggregates=(Aggregate("count", "*", "n"),),
                order_by=(("station", "asc"),),
            ),
        )
        self.assertEqual([row["station"] for row in grouped.rows], ["A", "B"])

    def test_missing_root_raises(self):
        with self.assertRaises(QueryError):
            count_rows(self.root / "nope")

    def test_bad_bucket_raises(self):
        with self.assertRaises(QueryError):
            QuerySpec(bucket="1 fortnight")

    def test_order_by_unknown_column_raises(self):
        with self.assertRaises(QueryError):
            execute(
                self.root,
                QuerySpec(
                    group_by=("station",),
                    aggregates=(Aggregate("count", "*", "n"),),
                    order_by=(("no_such_column", "asc"),),
                ),
            )

    def test_bad_json_line_reports_file_and_line(self):
        bad_root = self.root / "bad_root"
        key = PartitionKey("BAD", "2026-11-04", 9)
        path = bad_root / key.relpath()
        path.parent.mkdir(parents=True)
        path.write_text("{not json}\n", encoding="utf-8")
        with self.assertRaises(QueryError) as ctx:
            count_rows(bad_root)
        self.assertIn(":1", str(ctx.exception))


class TestEngines(QueryTestCase):
    def test_duckdb_unavailable_raises_engine_unavailable_not_import_error(self):
        engine = DuckDBEngine(
            self.root, module_name="__fieldstation_absent_duckdb__"
        )
        self.assertFalse(engine.available())
        with self.assertRaises(EngineUnavailable) as ctx:
            engine.execute("SELECT 1")
        self.assertNotIsInstance(ctx.exception, ImportError)
        self.assertIn("duckdb", str(ctx.exception))
        with self.assertRaises(EngineUnavailable):
            engine.explain("SELECT 1")

    def test_clickhouse_unavailable_raises_engine_unavailable(self):
        engine = ClickHouseEngine(
            self.root,
            module_name="__fieldstation_absent_clickhouse__",
            binary_names=("__fieldstation_absent_ch_binary__",),
        )
        self.assertFalse(engine.available())
        with self.assertRaises(EngineUnavailable) as ctx:
            engine.execute("SELECT 1")
        self.assertNotIsInstance(ctx.exception, ImportError)
        self.assertIn("clickhouse", str(ctx.exception).lower())

    def test_status_snapshot_has_all_engines(self):
        statuses = available_engines()
        self.assertEqual(set(statuses), {"builtin", "duckdb", "clickhouse"})
        self.assertTrue(statuses["builtin"].available)
        self.assertEqual(statuses["builtin"].to_dict()["name"], "builtin")

    def test_get_engine_factory_and_builtin_spec(self):
        engine = get_engine("builtin", self.root)
        self.assertIsInstance(engine, BuiltinEngine)
        result = engine.execute_spec(
            QuerySpec(aggregates=(Aggregate("count", "*", "n"),))
        )
        self.assertEqual(result.scalar(), 5)
        with self.assertRaises(EngineError):
            engine.execute("SELECT 1")
        with self.assertRaises(ValueError):
            get_engine("nope")


if __name__ == "__main__":
    unittest.main()
