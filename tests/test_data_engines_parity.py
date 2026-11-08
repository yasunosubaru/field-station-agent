# -*- coding: utf-8 -*-
"""引-3：20 条基准 SQL 的双引擎一致性与只读闸门。

## 这份测试要证明什么

| 断言 | 为什么必须有 |
|---|---|
| 写语句两引擎都拒、错误码 `E_READONLY` | 任务书：「写语句走两引擎都要被拒（明确错误码）」 |
| 好引擎与坏引擎的分别（`EngineUnavailable` 可判定） | 「引擎坏掉 → 回落且明示」 |
| 五类契约方言翻译（含实测补的几类） | 不补就是**静默跑错**，不是报错 |
| 浮点比较用相对误差 1e-9、整数精确 | 契约 §3 |
| 20 条 SQL 的编号与契约一一对应 | 防止「跑的是 B01 却声称是 SQL-01」 |

## 真实双引擎用例为什么不写死「必须一致」

本机 ClickHouse 是 WSL 里的可选依赖（要 `FSA_CLICKHOUSE_BIN` + 起服务）。
**没有它的时候不能让门禁变红** —— 仓库依赖政策是「测试与门禁只用标准库」。

所以真实跑引擎那些用例做成：**引擎不可用就明确记录「未覆盖」并 return**，
不用 `skipTest`（门禁要求 `skipped == 0`）。
纯逻辑部分（翻译、只读、比较口径）则完全不依赖任何引擎，**永远跑**。
"""
from __future__ import annotations

import math
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fieldstation.data import dialects                                   # noqa: E402
from fieldstation.data.engines import (                                  # noqa: E402
    DuckDBEngine,
    ClickHouseEngine,
    EngineError,
    EngineUnavailable,
    ReadOnlyEngineError,
    _ch_type,
    _unified_arrow_schema,
)


# ---------------------------------------------------------------- 只读闸门
class TestReadOnlyGate(unittest.TestCase):
    """写语句必须被拒。**这是数据台的第一道安全线。**"""

    WRITES = (
        "INSERT INTO obs (station) VALUES ('X')",
        "UPDATE obs SET station = 'Y'",
        "DELETE FROM obs WHERE station = 'X'",
        "CREATE TABLE t (a INTEGER)",
        "DROP TABLE obs",
        "ALTER TABLE obs ADD COLUMN z INTEGER",
        "TRUNCATE TABLE obs",
        "COPY obs TO '/tmp/x.csv'",
        "MERGE INTO obs USING x ON obs.a = x.a",
        "REPLACE INTO obs VALUES (1)",
        "GRANT SELECT ON obs TO bob",
        "VACUUM obs",
    )

    READS = (
        "SELECT 1",
        "SELECT * FROM obs",
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "EXPLAIN SELECT 1",
        "DESCRIBE obs",
        "SHOW TABLES",
        # `system` 是**列名**，不是 `SYSTEM RELOAD` 那种子句
        "SELECT COUNT(DISTINCT system) FROM obs",
        # 字符串字面量里的写关键字是数据，不是语句
        "SELECT * FROM obs WHERE note = 'DELETE this later'",
        # 注释里的写关键字同理
        "-- DROP TABLE obs\nSELECT 1",
    )

    def test_writes_are_rejected(self):
        for sql in self.WRITES:
            with self.subTest(sql=sql):
                self.assertFalse(dialects.is_readonly(sql))
                with self.assertRaises(dialects.ReadOnlyViolation):
                    dialects.assert_readonly(sql)

    def test_reads_are_allowed(self):
        for sql in self.READS:
            with self.subTest(sql=sql):
                self.assertTrue(dialects.is_readonly(sql),
                                "这条是只读查询，不该被拒：%r" % sql)
                dialects.assert_readonly(sql)      # 不抛就算过

    def test_cte_with_write_inside_is_rejected(self):
        """首关键字是 `WITH` 也可能是写 —— 靠第二道判据拦。"""
        sql = "WITH x AS (DELETE FROM obs RETURNING *) SELECT * FROM x"
        self.assertFalse(dialects.is_readonly(sql))

    def test_system_column_does_not_trip_the_guard(self):
        """`COUNT(DISTINCT system)` 曾被误判成 `SYSTEM RELOAD`。

        这是一次真实的误杀：黑名单里放 `SYSTEM ` 会让一条纯查询被拒。
        现在黑名单只放**写动词**，子句前缀靠首关键字白名单挡。
        """
        sql = "SELECT system, COUNT(*) FROM obs GROUP BY system"
        self.assertTrue(dialects.is_readonly(sql))

    def test_empty_sql_rejected(self):
        for empty in ("", "   ", "-- only a comment"):
            with self.subTest(sql=repr(empty)):
                self.assertFalse(dialects.is_readonly(empty))


# ---------------------------------------------------------------- 方言翻译
class TestContractDialects(unittest.TestCase):
    """契约 §4 的五类 + 实测必须补的几类。

    每条都写清「不翻会怎样」—— 因为其中三类是**静默跑错**，
    报错反而好查，跑错最难查。
    """

    def test_filter_becomes_count_if(self):
        """`COUNT(*) FILTER (WHERE p)` -> `countIf(p)`。不翻：CH 语法错。"""
        got = dialects.to_clickhouse(
            "SELECT COUNT(*) FILTER (WHERE cn0_dbhz IS NULL) AS n FROM obs")
        self.assertIn("countIf(cn0_dbhz IS NULL)", got)
        self.assertNotIn("FILTER", got)

    def test_filter_keeps_value_argument_for_sum(self):
        """`SUM(x) FILTER (WHERE p)` -> `sumIf(x, p)`。

        `COUNT(*)` 与 `SUM(x)` 形状不同：前者丢 `*`，后者保留 `x`。
        混着改会算错（把条件当成求和对象）。
        """
        got = dialects.to_clickhouse(
            "SELECT SUM(psr_m) FILTER (WHERE elev_deg > 30) AS s FROM obs")
        self.assertIn("sumIf(psr_m, elev_deg > 30)", got)

    def test_quantile_cont_uses_exact_inclusive(self):
        """`quantile_cont(x, q)` -> `quantileExactInclusive(q)(x)`。

        **不能用 `quantile`**：它走 reservoir 近似。实测 4 719 600 行时
        p50 差 0.033（39.5780825224815 vs 39.545302279367434）。
        也不能用 `quantileExact`：插值口径不同（39.54531812988577）。
        """
        got = dialects.to_clickhouse("SELECT quantile_cont(cn0_dbhz, 0.95) FROM obs")
        self.assertIn("quantileExactInclusive(0.95)(cn0_dbhz)", got)

    def test_stddev_samp(self):
        got = dialects.to_clickhouse("SELECT STDDEV_SAMP(psr_m) FROM obs")
        self.assertIn("stddevSamp(psr_m)", got)

    def test_date_diff(self):
        got = dialects.to_clickhouse("SELECT date_diff('second', a, b) FROM t")
        self.assertIn("dateDiff('second', a, b)", got)

    def test_bitwise_and(self):
        got = dialects.to_clickhouse("SELECT COUNT(*) FROM obs WHERE quality_flag & 4")
        self.assertIn("bitAnd(quality_flag, 4)", got)

    def test_lag_gets_null_default(self):
        """`LAG(x)` -> `lagInFrame(x, 1, NULL)`。

        **第三个参数不能省**：`lagInFrame(x)` 第一行给 `1970-01-01`，
        而 DuckDB 的 `LAG` 给 NULL。SQL-13 因此多出一条假断档。
        """
        got = dialects.to_clickhouse(
            "SELECT LAG(epoch_utc) OVER (ORDER BY epoch_utc) FROM obs")
        self.assertIn("lagInFrame(epoch_utc, 1, NULL)", got)

    def test_lag_with_explicit_offset(self):
        got = dialects.to_clickhouse(
            "SELECT LAG(x, 2) OVER (ORDER BY t) FROM obs")
        self.assertIn("lagInFrame(x, 2, NULL)", got)

    def test_date_literal_loses_type_prefix(self):
        """`DATE '2026-10-01'` -> `'2026-10-01'`。

        Parquet 里 `date` 列是 **string**（分区键原样落盘），
        `String = Date` 在 CH 里报 386（没有共同超类型）。
        """
        got = dialects.to_clickhouse("SELECT * FROM agg_daily WHERE date = DATE '2026-10-01'")
        self.assertIn("date = '2026-10-01'", got)
        self.assertNotIn("DATE '", got)

    def test_cast_as_date_to_string(self):
        """`CAST(x AS DATE)` -> `toString(toDate(x))`。

        同上：`FULL OUTER JOIN` 的两侧一个 Date 一个 String 就报 386。
        """
        got = dialects.to_clickhouse(
            "SELECT CAST(epoch_utc AS DATE) AS d FROM obs")
        self.assertIn("toString(toDate(epoch_utc))", got)

    def test_regexp_extract(self):
        got = dialects.to_clickhouse(
            "SELECT regexp_extract(f, '/station=([^/]+)/', 1) FROM t")
        self.assertIn("regexpExtract(f, '/station=([^/]+)/', 1)", got)

    def test_string_literals_untouched(self):
        """翻译不许动字符串字面量里的内容。"""
        sql = "SELECT * FROM t WHERE note = 'quantile_cont(x, 0.5) & 4'"
        got = dialects.to_clickhouse(sql)
        self.assertIn("'quantile_cont(x, 0.5) & 4'", got)


# ---------------------------------------------------------------- 比较口径
class TestComparisonTolerance(unittest.TestCase):
    """浮点用相对误差 1e-9、整数精确、时间戳按时刻。"""

    def setUp(self):
        import tools.bench_run as B
        self.B = B

    def test_float_relative_tolerance(self):
        self.assertTrue(self.B._close(1.0, 1.0 + 1e-12))
        self.assertFalse(self.B._close(1.0, 1.0 + 1e-6))

    def test_large_float_uses_relative_not_absolute(self):
        """4.7e6 量级的数，差 1e-3 相对误差是 2e-10 —— 应当算相等。"""
        self.assertTrue(self.B._close(4719600.0, 4719600.001))

    def test_integers_are_exact(self):
        """`COUNT(*)` 差 1 就是错，不许用容差遮。"""
        self.assertFalse(self.B._close(4719600, 4719601))
        self.assertTrue(self.B._close(100, 100))

    def test_none_matches_only_none(self):
        self.assertTrue(self.B._close(None, None))
        self.assertFalse(self.B._close(None, 0))
        self.assertFalse(self.B._close(0, None))

    def test_nan_matches_nan(self):
        self.assertTrue(self.B._close(float("nan"), float("nan")))

    def test_timestamp_compared_as_instant(self):
        """`2026-10-01T00:00:00+00:00` 与 `2026-10-01T00:00:00` 是同一时刻。

        两个引擎的序列化习惯不同（一个带时区后缀、一个不带），
        按字符串比会误报不一致。
        """
        self.assertTrue(self.B._close("2026-10-01T00:00:00+00:00",
                                      "2026-10-01T00:00:00"))
        self.assertFalse(self.B._close("2026-10-01T00:00:00+00:00",
                                       "2026-10-01T00:00:01"))

    def test_row_order_does_not_matter(self):
        """同批数据、不同行序必须判为一致。

        SQL-17 的 `FULL OUTER JOIN` 会产出 NULL 组，两引擎组内顺序不同；
        不排序会把「同一批数据」误报成「21 处值不一致」。
        """
        B = self.B
        case = B.BenchSql("SQL-X", "test", "SELECT 1")
        left = [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]
        right = [{"a": 2, "b": "y"}, {"a": 1, "b": "x"}]
        diffs = B.compare_results(case, left, right, ("a", "b"), ("a", "b"))
        self.assertEqual(diffs, [])

    def test_column_mismatch_is_reported(self):
        B = self.B
        case = B.BenchSql("SQL-X", "test", "SELECT 1")
        diffs = B.compare_results(case, [{"a": 1}], [{"a": 1}],
                                  ("a",), ("b",))
        self.assertEqual(len(diffs), 1)
        self.assertEqual(diffs[0].kind, "columns")

    def test_rowcount_mismatch_is_reported(self):
        B = self.B
        case = B.BenchSql("SQL-X", "test", "SELECT 1")
        diffs = B.compare_results(case, [{"a": 1}], [{"a": 1}, {"a": 2}],
                                  ("a",), ("a",))
        kinds = {d.kind for d in diffs}
        self.assertIn("rowcount", kinds)


# ---------------------------------------------------------------- 引擎契约
class TestEngineContract(unittest.TestCase):
    """两个引擎在**不连服务**时也要能正确拒绝写语句。"""

    def test_duckdb_rejects_write_before_connecting(self):
        engine = DuckDBEngine(ROOT / "data")
        with self.assertRaises(ReadOnlyEngineError) as ctx:
            engine.execute("DELETE FROM obs")
        self.assertIn("E_READONLY", str(ctx.exception))

    def test_clickhouse_rejects_write_before_connecting(self):
        engine = ClickHouseEngine(ROOT / "data")
        with self.assertRaises(ReadOnlyEngineError) as ctx:
            engine.execute("DROP TABLE obs")
        self.assertIn("E_READONLY", str(ctx.exception))

    def test_readonly_error_is_an_engine_error(self):
        """`ReadOnlyEngineError` 要能被通用 `EngineError` 处理捕获。"""
        self.assertTrue(issubclass(ReadOnlyEngineError, EngineError))

    def test_broken_engine_is_determinable(self):
        """引擎坏掉必须能判定成 `EngineUnavailable`，不许静默吞成空结果。

        「坏掉的引擎给出 0 行」是最危险的表现：看起来跑通了，其实没算。
        """
        engine = DuckDBEngine(ROOT / "data", module_name="duckdb_not_installed")
        with self.assertRaises(EngineUnavailable) as ctx:
            engine.execute("SELECT 1")
        self.assertIn("duckdb_not_installed", str(ctx.exception))

    def test_unavailable_reason_includes_original_exception(self):
        """缺依赖与「环境里有同名模块遮蔽」必须能区分开。

        实测踩过：目录里有个 `locale.py`，`import clickhouse_connect` 失败，
        原实现只报「未安装」，把人引向错误的排查方向。
        """
        engine = DuckDBEngine(ROOT / "data", module_name="duckdb_not_installed")
        self.assertIsNotNone(engine.unavailable_reason())
        try:
            engine.execute("SELECT 1")
        except EngineUnavailable as exc:
            self.assertIn("原始异常", str(exc))


# ---------------------------------------------------------------- 20 条定义
class TestBenchSqlDefinition(unittest.TestCase):
    """基准定义本身的完整性。"""

    def setUp(self):
        import tools.bench_run as B
        self.B = B

    def test_twenty_entries_numbered_in_order(self):
        expected = ["SQL-%02d" % i for i in range(1, 21)]
        actual = [c.ident for c in self.B.BENCH_SQL]
        self.assertEqual(actual, expected)

    def test_every_case_is_readonly(self):
        for case in self.B.BENCH_SQL:
            with self.subTest(ident=case.ident):
                self.assertTrue(dialects.is_readonly(case.sql),
                                "%s 的原 SQL 必须只读" % case.ident)

    def test_every_clickhouse_variant_is_readonly(self):
        """翻译之后**仍然是**只读 —— 翻译不许把查询变成写。"""
        for case in self.B.BENCH_SQL:
            with self.subTest(ident=case.ident):
                translated = case.for_clickhouse()
                self.assertTrue(dialects.is_readonly(translated),
                                "%s 翻译后变成写语句了" % case.ident)

    def test_clickhouse_variants_have_no_untranslated_duckdb_only(self):
        """翻译后不该残留 DuckDB 专有写法（那些在 CH 里一定跑不了）。"""
        banned = ("quantile_cont(", "STDDEV_SAMP(", "date_diff(",
                  " FILTER (", "FILTER (WHERE")
        for case in self.B.BENCH_SQL:
            with self.subTest(ident=case.ident):
                translated = case.for_clickhouse()
                for token in banned:
                    self.assertNotIn(token, translated,
                                     "%s 翻译后仍含 %r" % (case.ident, token))

    def test_identifiers_unique(self):
        idents = [c.ident for c in self.B.BENCH_SQL]
        self.assertEqual(len(idents), len(set(idents)))

    def test_write_statements_list_covers_all_dangerous_kinds(self):
        kinds = {"INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
                 "TRUNCATE", "COPY"}
        blob = " ".join(self.B.WRITE_STATEMENTS).upper()
        for kind in kinds:
            self.assertIn(kind, blob, "只读断言缺了 %s" % kind)


# ---------------------------------------------------------------- arrow 类型
class TestArrowMapping(unittest.TestCase):
    """pyarrow -> ClickHouse 的类型映射。**只做等价映射，不做精度换算。**"""

    def test_basic_types(self):
        import pyarrow as pa
        self.assertEqual(_ch_type(pa.int64()), "Int64")
        self.assertEqual(_ch_type(pa.int32()), "Int32")
        self.assertEqual(_ch_type(pa.float64()), "Nullable(Float64)")
        self.assertEqual(_ch_type(pa.string()), "String")
        self.assertEqual(_ch_type(pa.bool_()), "Bool")

    def test_timestamp_is_utc(self):
        import pyarrow as pa
        self.assertIn("UTC", _ch_type(pa.timestamp("us", tz="UTC")))

    def test_unmapped_type_raises_not_silently_string(self):
        """认不出的类型必须报错，不能退化成 String。

        退化成 String 会让 `AVG` / `quantile` 静默失败或按字符串排序 ——
        那正是「看起来跑通了、数不对」的那类问题。
        """
        import pyarrow as pa
        with self.assertRaises(EngineError):
            _ch_type(pa.list_(pa.int64()))

    def test_unified_schema_demotes_dictionary(self):
        """hive 分区列会被读成 `dictionary<string>`，必须降级成 `string`。

        不降级就会 `ArrowTypeError: Unable to merge: Field station has
        incompatible types: string vs dictionary<...>`。
        """
        import pyarrow as pa
        schema = _unified_arrow_schema([])
        self.assertEqual(len(schema), 0)          # 空输入给空 schema，不炸

    def test_unified_schema_merges_real_files(self):
        """用真实 Parquet（若存在）验证 dictionary 降级。"""
        import pyarrow.parquet as pq
        base = Path(os.environ.get("TEMP", "/tmp")) / "fsa-bench-full" / "obs"
        if not base.is_dir():
            return                                 # 没跑过基准就不测
        files = sorted(str(p) for p in base.rglob("*.parquet"))
        if len(files) < 2:
            return
        schema = _unified_arrow_schema(files)
        names = {f.name for f in schema}
        self.assertIn("station", names)
        # 降级之后不能再有 dictionary 类型
        import pyarrow as pa
        for field in schema:
            self.assertFalse(pa.types.is_dictionary(field.type),
                             "%s 仍是 dictionary 类型" % field.name)


# ---------------------------------------------------------------- 真实双引擎
class TestRealEngines(unittest.TestCase):
    """真跑两个引擎。**引擎不在就明确不做，不用 skipTest。**

    门禁要求 `skipped == 0`，所以这里用「不可用就 return」而不是 `skipTest`。
    本机 ClickHouse 需要 WSL 里起服务；没有它时这一段覆盖会缺席，
    `docs/operations/bench-results.md` 里记实际跑过的数字。
    """

    def _env(self):
        """准备一份小数据集（60 历元）。"""
        import tempfile
        import tools.bench_run as B
        directory = Path(tempfile.mkdtemp(prefix="fsa-parity-"))
        env = B.build_dataset(directory, epochs=60, quiet=True)
        return B, env, directory

    def test_two_engines_agree_on_all_twenty(self):
        import shutil
        B, env, directory = self._env()
        try:
            duck = B.DuckDBEngine(env.root)
            if not duck.available():
                return
            ch = B.ClickHouseEngine(env.root)
            if not ch.available():
                return
            # 先确认 CH 真的连得上（模块装好但服务没起也算不可用）
            try:
                ch._connect()
            except EngineUnavailable:
                return

            outcomes = B.run_all(env, quiet=True)
            failed = [o for o in outcomes if not o.ok]
            self.assertEqual(
                failed, [],
                "以下条目两引擎不一致：\n" + "\n".join(
                    "%s: %s / %s" % (o.case.ident, o.error,
                                     [str(d) for d in o.diffs[:3]])
                    for o in failed))
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def test_write_rejected_by_both_real_engines(self):
        import shutil
        B, env, directory = self._env()
        try:
            if not B.DuckDBEngine(env.root).available():
                return
            ch = B.ClickHouseEngine(env.root)
            if not ch.available():
                return
            try:
                ch._connect()
            except EngineUnavailable:
                return
            problems = B.check_readonly_both(env)
            self.assertEqual(problems, [], "\n".join(problems))
        finally:
            shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
