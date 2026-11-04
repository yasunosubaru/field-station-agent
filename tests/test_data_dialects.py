# -*- coding: utf-8 -*-
"""统一 SQL 子集 → DuckDB / ClickHouse 的方言翻译。

覆盖三类差异：时间桶、LIMIT、字符串函数。字符串字面量与标识符必须原样保留。
"""
from __future__ import annotations

import unittest

from fieldstation.data.dialects import (
    DialectError,
    to_clickhouse,
    to_duckdb,
    translate,
)


class TestTimeBucket(unittest.TestCase):
    def test_hour_bucket(self):
        sql = "SELECT time_bucket('1 hour', epoch_utc) AS bucket FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT toStartOfHour(epoch_utc) AS bucket FROM obs",
        )

    def test_minute_bucket_uses_interval(self):
        sql = "SELECT time_bucket('15 minutes', epoch_utc) AS bucket FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT toStartOfInterval(epoch_utc, INTERVAL 15 MINUTE) AS bucket FROM obs",
        )

    def test_day_bucket(self):
        sql = "SELECT time_bucket('1 day', epoch_utc) FROM obs"
        self.assertEqual(to_clickhouse(sql), "SELECT toStartOfDay(epoch_utc) FROM obs")

    def test_week_bucket_starts_monday(self):
        # DuckDB 的周起点是周一；ClickHouse toStartOfWeek 默认周日，显式给 mode=1
        sql = "SELECT date_trunc('week', epoch_utc) FROM obs"
        self.assertEqual(to_clickhouse(sql), "SELECT toStartOfWeek(epoch_utc, 1) FROM obs")

    def test_date_trunc_and_nested_call(self):
        sql = "SELECT round(date_trunc('day', epoch_utc), 1) FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT round(toStartOfDay(epoch_utc), 1) FROM obs",
        )


class TestLimit(unittest.TestCase):
    def test_offset_comma_form_normalised_for_clickhouse(self):
        sql = "SELECT * FROM obs LIMIT 10, 20"
        self.assertEqual(to_clickhouse(sql), "SELECT * FROM obs LIMIT 20 OFFSET 10")
        self.assertEqual(to_duckdb(sql), "SELECT * FROM obs LIMIT 20 OFFSET 10")

    def test_plain_limit_untouched(self):
        sql = "SELECT * FROM obs LIMIT 5"
        self.assertEqual(to_clickhouse(sql), sql)
        self.assertEqual(to_duckdb(sql), sql)


class TestStringFunctions(unittest.TestCase):
    def test_length_and_position(self):
        sql = "SELECT length(station), strpos(station, 'WU') FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT lengthUTF8(station), position(station, 'WU') FROM obs",
        )

    def test_replace_and_split_part(self):
        sql = "SELECT replace(station, 'W', 'X'), split_part(station, '-', 2) FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT replaceAll(station, 'W', 'X'), "
            "arrayElement(splitByChar('-', station), 2) FROM obs",
        )

    def test_starts_ends_and_contains(self):
        sql = "SELECT starts_with(s, 'a'), ends_with(s, 'z'), contains(s, 'm') FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT startsWith(s, 'a'), endsWith(s, 'z'), position(s, 'm') > 0 FROM obs",
        )

    def test_extract(self):
        sql = "SELECT extract(year FROM epoch_utc) AS y FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT toYear(epoch_utc) AS y FROM obs",
        )


class TestSafety(unittest.TestCase):
    def test_string_literals_untouched(self):
        sql = (
            "SELECT * FROM obs WHERE note = 'time_bucket(''1 hour'', x)' "
            "AND other = 'length(y)' LIMIT 1, 2"
        )
        translated = to_clickhouse(sql)
        self.assertIn("'time_bucket(''1 hour'', x)'", translated)
        self.assertIn("'length(y)'", translated)
        self.assertTrue(translated.endswith("LIMIT 2 OFFSET 1"))

    def test_identifier_with_parens_not_rewritten(self):
        sql = 'SELECT "length"(station) FROM obs'
        self.assertEqual(to_clickhouse(sql), sql)

    def test_unknown_function_is_preserved_but_args_rewritten(self):
        sql = "SELECT my_udf(time_bucket('1 hour', epoch_utc)) FROM obs"
        self.assertEqual(
            to_clickhouse(sql),
            "SELECT my_udf(toStartOfHour(epoch_utc)) FROM obs",
        )

    def test_duckdb_target_keeps_time_bucket(self):
        sql = "SELECT time_bucket('1 hour', epoch_utc) FROM obs LIMIT 1, 2"
        self.assertEqual(
            to_duckdb(sql),
            "SELECT time_bucket('1 hour', epoch_utc) FROM obs LIMIT 2 OFFSET 1",
        )

    def test_translate_dispatch_and_alias(self):
        sql = "SELECT length(s) FROM obs"
        self.assertEqual(translate(sql, "clickhouse"), "SELECT lengthUTF8(s) FROM obs")
        self.assertEqual(translate(sql, "ch"), "SELECT lengthUTF8(s) FROM obs")
        self.assertEqual(translate(sql, "duckdb"), sql)

    def test_unknown_dialect_rejected(self):
        with self.assertRaises(DialectError):
            translate("SELECT 1", "mysql")

    def test_translation_is_stable(self):
        sql = "SELECT time_bucket('1 hour', epoch_utc) FROM obs LIMIT 10, 20"
        once = to_clickhouse(sql)
        self.assertEqual(to_clickhouse(once), once)


if __name__ == "__main__":
    unittest.main()
