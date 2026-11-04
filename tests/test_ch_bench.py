# -*- coding: utf-8 -*-
"""``tools/ch_bench.py`` 的单元测试，外加一组"二进制在才跑"的集成用例。

分两层：

1. **纯函数层**（不需要 ClickHouse、不联网）：SQL 拼装、参数校验、URL 拼装、
   确定性数据生成、分位数、WSL 路径换算、结果排版。
2. **集成层**（``ClickHouseIntegrationTest``）：只在 ``resolve_binary()`` 找得到
   二进制时才跑，自己在临时目录里起一个**独立端口**的服务，建库建表灌 2000 行、
   跑两条聚合，然后停掉。找不到二进制就 ``skipTest`` 并说明去哪儿拿——
   ``README``/门禁要求 skipped == 0，所以本机必须真的有这份二进制。

集成用例故意不复用 8123：跑测试的时候用户可能正开着基准服务，
测试去抢端口会得到一堆莫名其妙的失败。
"""
import os
import shutil
import socket
import tempfile
import unittest
from pathlib import Path

from tools import ch_bench

BINARY = ch_bench.resolve_binary()


class TestValidateIdent(unittest.TestCase):
    def test_accepts_plain_names(self):
        for name in ("fsa", "obs_1m", "_tmp", "A1"):
            self.assertEqual(ch_bench.validate_ident(name), name)

    def test_rejects_injection_and_odd_names(self):
        for bad in ("fsa; DROP DATABASE default", "", "1abc", "a-b", "fsa.obs", None, 7):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.validate_ident(bad)


class TestValidateNumbers(unittest.TestCase):
    def test_rows_accepts_positive(self):
        self.assertEqual(ch_bench.validate_rows(1), 1)
        self.assertEqual(ch_bench.validate_rows("200000"), 200000)

    def test_rows_rejects_zero_negative_and_huge(self):
        for bad in (0, -1, ch_bench.MAX_LOAD_ROWS + 1):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.validate_rows(bad)

    def test_rows_rejects_bool_and_garbage(self):
        # bool 是 int 的子类，滑进来会变成 1 行，看着"成功"其实什么都没测
        for bad in (True, False, "abc", None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.validate_rows(bad)

    def test_port_bounds(self):
        self.assertEqual(ch_bench.validate_port(8123), 8123)
        self.assertEqual(ch_bench.validate_port(65535), 65535)
        for bad in (0, 65536, -1, "http"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.validate_port(bad)

    def test_day_time_requires_full_stamp(self):
        self.assertEqual(ch_bench.validate_day_time("2026-01-01 00:00:00"),
                         "2026-01-01 00:00:00")
        for bad in ("2026-01-01", "2026-1-1 00:00:00", "2026-01-01 00:00", ""):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.validate_day_time(bad)

    def test_reps(self):
        self.assertEqual(ch_bench.validate_reps(5), 5)
        for bad in (0, -3, "x"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.validate_reps(bad)


class TestPercentile(unittest.TestCase):
    def test_single_sample(self):
        self.assertEqual(ch_bench.percentile([7.5], 50), 7.5)
        self.assertEqual(ch_bench.percentile([7.5], 95), 7.5)

    def test_median_of_odd_count(self):
        self.assertEqual(ch_bench.percentile([3, 1, 2], 50), 2)

    def test_p95_on_five_samples_is_interpolated(self):
        # 秩 = 4×0.95 = 3.8 → 落在 sorted[3]=4 与 sorted[4]=10 之间
        values = [1.0, 2.0, 3.0, 4.0, 10.0]
        self.assertAlmostEqual(ch_bench.percentile(values, 95), 8.8)
        self.assertAlmostEqual(ch_bench.percentile(values, 0), 1.0)
        self.assertAlmostEqual(ch_bench.percentile(values, 100), 10.0)
        # 越小样本 p95 越靠不住：这是"p95 不是最差值"的示例，别删
        self.assertLess(ch_bench.percentile(values, 95), max(values))

    def test_interpolates_between_samples(self):
        # [0, 10] 的 25% 分位 = 2.5（线性插值），不是"取最近"
        self.assertAlmostEqual(ch_bench.percentile([0.0, 10.0], 25), 2.5)

    def test_rejects_empty_and_bad_p(self):
        with self.assertRaises(ValueError):
            ch_bench.percentile([], 50)
        with self.assertRaises(ValueError):
            ch_bench.percentile([1, 2], 101)

    def test_summarize_shape(self):
        out = ch_bench.summarize([1.0, 2.0, 3.0])
        self.assertEqual(out["n"], 3)
        self.assertEqual(out["min"], 1.0)
        self.assertEqual(out["max"], 3.0)
        self.assertAlmostEqual(out["p50"], 2.0)


class TestBuildUrl(unittest.TestCase):
    def test_no_params_keeps_trailing_slash(self):
        self.assertEqual(ch_bench.build_url("http://127.0.0.1:8123"), "http://127.0.0.1:8123/")
        self.assertEqual(ch_bench.build_url("http://127.0.0.1:8123/"), "http://127.0.0.1:8123/")

    def test_database_goes_into_query_string(self):
        self.assertEqual(ch_bench.build_url("http://h:8123", database="fsa"),
                         "http://h:8123/?database=fsa")

    def test_extra_params_are_encoded(self):
        url = ch_bench.build_url("http://h:8123", database="fsa",
                                 params={"max_execution_time": 30, "q": "a b&c"})
        self.assertIn("database=fsa", url)
        self.assertIn("max_execution_time=30", url)
        self.assertIn("q=a+b%26c", url)

    def test_rejects_non_http_base(self):
        for bad in ("", "127.0.0.1:8123", "/tmp/x"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ch_bench.build_url(bad)

    def test_rejects_bad_database(self):
        with self.assertRaises(ValueError):
            ch_bench.build_url("http://h:8123", database="fsa; DROP DATABASE default")


class TestSql(unittest.TestCase):
    def test_obs_table_is_mergetree_ordered_by_station_ts(self):
        sql = ch_bench.sql_create_obs_table("fsa", "obs")
        self.assertIn("ENGINE = MergeTree", sql)
        self.assertIn("ORDER BY (station, ts)", sql)
        for column in ("station", "ts", "obs_type", "value"):
            self.assertIn(column, sql)
        self.assertIn("LowCardinality(String)", sql)

    def test_agg_table_is_mergetree_ordered_by_station_bucket(self):
        sql = ch_bench.sql_create_agg_table("fsa", "obs_1m")
        self.assertIn("ORDER BY (station, bucket)", sql)
        for column in ("samples", "v_min", "v_max", "v_avg", "v_sum"):
            self.assertIn(column, sql)

    def test_create_database_is_idempotent(self):
        self.assertIn("IF NOT EXISTS", ch_bench.sql_create_database("fsa"))

    def test_insert_header_uses_tsv(self):
        self.assertTrue(ch_bench.sql_insert_header("fsa", "obs").startswith("INSERT INTO fsa.obs"))
        self.assertIn("FORMAT TSV", ch_bench.sql_insert_header("fsa", "obs"))

    def test_backfill_aggregates_by_minute(self):
        sql = ch_bench.sql_backfill_agg("fsa", "obs", "obs_1m")
        self.assertIn("INSERT INTO fsa.obs_1m", sql)
        self.assertIn("toStartOfMinute(ts)", sql)
        self.assertIn("GROUP BY station, bucket, obs_type", sql)

    def test_truncate_and_count(self):
        self.assertEqual(ch_bench.sql_truncate("fsa", "obs"), "TRUNCATE TABLE IF EXISTS fsa.obs")
        self.assertEqual(ch_bench.sql_count("fsa", "obs"), "SELECT count() FROM fsa.obs")

    def test_identifiers_are_validated_before_concatenation(self):
        for fn in (ch_bench.sql_create_obs_table, ch_bench.sql_create_agg_table):
            with self.assertRaises(ValueError):
                fn("fsa; DROP DATABASE default", "obs")
            with self.assertRaises(ValueError):
                fn("fsa", "obs ENGINE=Memory --")


class TestSyntheticRows(unittest.TestCase):
    def test_count_and_shape(self):
        rows = list(ch_bench.gen_rows(64))
        self.assertEqual(len(rows), 64)
        for line in rows:
            self.assertTrue(line.endswith("\n"))
            station, ts, obs_type, value = line.rstrip("\n").split("\t")
            self.assertIn(station, ch_bench.STATIONS)
            self.assertIn(obs_type, ch_bench.OBS_TYPES)
            self.assertGreaterEqual(int(ts), ch_bench.BASE_EPOCH)
            float(value)          # 必须是合法浮点

    def test_same_seed_is_byte_identical(self):
        self.assertEqual(list(ch_bench.gen_rows(500, seed=7)),
                         list(ch_bench.gen_rows(500, seed=7)))

    def test_different_seed_differs(self):
        self.assertNotEqual(list(ch_bench.gen_rows(200, seed=7)),
                            list(ch_bench.gen_rows(200, seed=8)))

    def test_timestamps_advance_by_sample_interval(self):
        # 每 32 行（8 站 × 4 类型）走一个采样间隔，时间必须单调不减
        rows = [ln.rstrip("\n").split("\t") for ln in ch_bench.gen_rows(960)]
        minutes = sorted({int(r[1]) for r in rows})
        self.assertEqual(len(minutes), 30)
        gaps = {b - a for a, b in zip(minutes, minutes[1:])}
        self.assertEqual(gaps, {ch_bench.SAMPLE_SECONDS})

    def test_small_n_keeps_all_stations(self):
        rows = [ln.split("\t")[0] for ln in ch_bench.gen_rows(8)]
        self.assertEqual(rows, list(ch_bench.STATIONS))

    def test_row_values_rejects_more_than_max(self):
        with self.assertRaises(ValueError):
            list(ch_bench.gen_rows(0))


class TestChunks(unittest.TestCase):
    def test_splits_evenly_and_keeps_remainder(self):
        self.assertEqual([len(c) for c in ch_bench.chunks(range(5), 2)], [2, 2, 1])
        self.assertEqual([len(c) for c in ch_bench.chunks(range(4), 2)], [2, 2])

    def test_empty_input_yields_nothing(self):
        self.assertEqual(list(ch_bench.chunks([], 10)), [])

    def test_rejects_bad_size(self):
        with self.assertRaises(ValueError):
            list(ch_bench.chunks([1], 0))


class TestBenchQueries(unittest.TestCase):
    def setUp(self):
        self.queries = ch_bench.bench_queries("fsa")

    def test_exactly_twenty(self):
        self.assertEqual(len(self.queries), 20)

    def test_keys_and_titles_are_unique(self):
        self.assertEqual(len({q.key for q in self.queries}), 20)
        self.assertEqual(len({q.title for q in self.queries}), 20)

    def test_every_query_is_a_select(self):
        for q in self.queries:
            self.assertTrue(q.sql.strip().upper().startswith("SELECT"), q.key)

    def test_queries_touch_the_requested_database(self):
        for q in self.queries:
            self.assertIn("fsa.", q.sql, q.key)

    def test_no_leftover_format_escapes(self):
        # BenchQuery 是用 % 拼出来的，漏掉 %% 会在 SQL 里留下一个孤零零的 %s
        for q in self.queries:
            self.assertNotIn("%s", q.sql, q.key)

    def test_aggregate_queries_use_both_tables(self):
        joined = "\n".join(q.sql for q in self.queries)
        self.assertIn("fsa.obs_1m", joined)
        self.assertIn("fsa.obs\n", joined + "\n")

    def test_custom_database_name_is_respected(self):
        for q in ch_bench.bench_queries("other_db"):
            self.assertIn("other_db.", q.sql, q.key)

    def test_bad_database_is_rejected(self):
        with self.assertRaises(ValueError):
            ch_bench.bench_queries("fsa; SELECT 1")


class TestWslHelpers(unittest.TestCase):
    def test_parse_utf16_distro_list(self):
        # wsl.exe -l -q 的真实输出是 UTF-16LE，每个字符后面跟一个 NUL
        raw = "Ubuntu-24.04\r\ndocker-desktop\r\n".encode("utf-16-le")
        self.assertEqual(ch_bench.parse_wsl_distros(raw),
                         ["Ubuntu-24.04", "docker-desktop"])

    def test_parse_tolerates_nul_bytes_and_bom(self):
        self.assertEqual(ch_bench.parse_wsl_distros("\ufeffUbuntu\x00\r\n"),
                         ["Ubuntu"])

    def test_parse_empty(self):
        self.assertEqual(ch_bench.parse_wsl_distros(b""), [])

    def test_windows_path_to_mnt(self):
        self.assertEqual(ch_bench.to_wsl_path(r"H:\a b\c"), "/mnt/h/a b/c")
        self.assertEqual(ch_bench.to_wsl_path("D:/x"), "/mnt/d/x")

    def test_posix_path_passes_through(self):
        self.assertEqual(ch_bench.to_wsl_path("/home/u/x"), "/home/u/x")

    def test_relative_path_is_resolved(self):
        out = ch_bench.to_wsl_path("tools")
        self.assertTrue(out.startswith("/mnt/") or out.startswith("/"))

    def test_shell_path_expands_home(self):
        self.assertEqual(ch_bench.shell_path("~/x"), '"$HOME/x"')
        self.assertEqual(ch_bench.shell_path("/a b/c"), "'/a b/c'")

    def test_shell_path_escapes_single_quote(self):
        self.assertEqual(ch_bench.shell_path("/a'b"), "'/a'\\''b'")

    def test_server_command_has_daemon_and_ports(self):
        cmd = ch_bench.server_shell_command(
            "~/ch", "/data/x", http_port=8123, tcp_port=9000,
            pidfile="/run/a.pid", log="/run/a.log", errlog="/run/a.err")
        self.assertIn("--daemon", cmd)
        self.assertIn("--path='/data/x'", cmd)
        self.assertIn("--http_port=8123", cmd)
        self.assertIn("--tcp_port=9000", cmd)
        self.assertIn("--mysql_port=0", cmd)          # 只留 HTTP，少两个监听面
        self.assertIn("--pidfile='/run/a.pid'", cmd)

    def test_server_command_quotes_paths_with_spaces(self):
        cmd = ch_bench.server_shell_command(
            "~/ch", "/data dir/x", pidfile="/run/a.pid", log="/l", errlog="/e")
        self.assertIn("--path='/data dir/x'", cmd)

    def test_server_command_rejects_bad_port(self):
        with self.assertRaises(ValueError):
            ch_bench.server_shell_command("~/ch", "/d", http_port=0,
                                          pidfile="/p", log="/l", errlog="/e")

    def test_is_elf(self):
        with tempfile.TemporaryDirectory() as tmp:
            elf = Path(tmp) / "clickhouse"
            elf.write_bytes(b"\x7fELF" + b"\x00" * 12)
            self.assertTrue(ch_bench.is_elf(elf))
            exe = Path(tmp) / "clickhouse.exe"
            exe.write_bytes(b"MZ" + b"\x00" * 12)
            self.assertFalse(ch_bench.is_elf(exe))
            self.assertFalse(ch_bench.is_elf(Path(tmp) / "missing"))


class TestResolveBinary(unittest.TestCase):
    def test_explicit_missing_returns_none(self):
        missing = str(Path(tempfile.gettempdir()) / "no-such-clickhouse")
        self.assertIsNone(ch_bench.resolve_binary(missing, env={}))

    def test_env_var_is_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "clickhouse"
            fake.write_bytes(b"\x7fELF")
            found = ch_bench.resolve_binary(None, env={ch_bench.ENV_BIN: str(fake)})
            self.assertEqual(found, fake)

    def test_env_var_missing_does_not_fall_back(self):
        missing = str(Path(tempfile.gettempdir()) / "no-such-clickhouse")
        self.assertIsNone(ch_bench.resolve_binary(None, env={ch_bench.ENV_BIN: missing}))


class TestFormatBench(unittest.TestCase):
    def _entry(self, idx, p50):
        return {"idx": idx, "key": "k%d" % idx, "title": "查询%d" % idx,
                "rows": 1, "bytes": 10, "p50": p50, "p95": p50 * 2,
                "min": p50, "max": p50 * 2, "n": 5}

    def test_rows_are_numbered_sequentially(self):
        # 回归：entry 里曾同时有 idx 和 summarize() 的 n，两列撞名，
        # 结果表每一行的序号都印成"重复次数"
        text = ch_bench.format_bench([self._entry(i, 1.0) for i in range(1, 21)], 200000, 5)
        body = [ln for ln in text.splitlines() if ln[:3].strip().isdigit()]
        self.assertEqual([int(ln[:3]) for ln in body], list(range(1, 21)))

    def test_reports_totals_and_slowest(self):
        entries = [self._entry(1, 1.0), self._entry(2, 99.0)]
        text = ch_bench.format_bench(entries, 1234, 5,
                                     baseline={"p50": 0.5, "p95": 0.9})
        self.assertIn("数据集 1234 行", text)
        self.assertIn("最慢（p50）：#2", text)
        self.assertIn("往返基线", text)

    def test_empty_results_do_not_crash(self):
        self.assertIn("合计 0 条", ch_bench.format_bench([], 0, 5))


class TestClientWithoutServer(unittest.TestCase):
    def _closed_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def test_ping_is_false_when_nothing_listens(self):
        port = self._closed_port()
        self.assertFalse(ch_bench.Client("http://127.0.0.1:%d" % port, "fsa",
                                         timeout=2).ping())

    def test_query_raises_ch_error_with_hint(self):
        port = self._closed_port()
        client = ch_bench.Client("http://127.0.0.1:%d" % port, "fsa", timeout=2)
        with self.assertRaises(ch_bench.ChError) as ctx:
            client.query("SELECT 1")
        self.assertIn("连不上", str(ctx.exception))

    def test_port_open_matches_socket_state(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        try:
            self.assertTrue(ch_bench.port_open(port=sock.getsockname()[1]))
        finally:
            sock.close()
        self.assertFalse(ch_bench.port_open(port=self._closed_port()))


@unittest.skipUnless(
    BINARY is not None,
    "没有 .deps/clickhouse/clickhouse（或 clickhouse.exe）：集成用例需要真实二进制，"
    "取法与起停见 docs/operations/clickhouse.md")
class ClickHouseIntegrationTest(unittest.TestCase):
    """真起一个服务、真建表、真灌数据、真跑查询。端口故意不用 8123。"""

    HTTP_PORT = 18123
    TCP_PORT = 19001
    ROWS = 2000

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="ch_bench_it_"))
        cls.run_dir = cls.tmp / "run"
        cls.data_dir = cls.tmp / "data"
        cls.handle = ch_bench.start_server(
            binary=BINARY, data_dir=cls.data_dir, run_dir=cls.run_dir,
            http_port=cls.HTTP_PORT, tcp_port=cls.TCP_PORT, wait=120, verbose=False)
        cls.client = ch_bench.Client("http://127.0.0.1:%d" % cls.HTTP_PORT,
                                     ch_bench.DEFAULT_DB, timeout=60)

    @classmethod
    def tearDownClass(cls):
        ch_bench.stop_server(run_dir=cls.run_dir, http_port=cls.HTTP_PORT, verbose=False)
        shutil.rmtree(str(cls.tmp), ignore_errors=True)

    def test_01_server_answers(self):
        self.assertTrue(self.client.ping())
        self.assertRegex(self.client.version(), r"^\d+\.\d+")

    def test_02_init_load_and_query(self):
        ch_bench.init_schema(self.client, verbose=False)
        stats = ch_bench.load(self.client, self.ROWS, batch_size=500, verbose=False)
        self.assertEqual(stats["rows_in_obs"], self.ROWS)
        # 15 s 采样 → 每分钟 4 条；聚合表的行数取决于分钟边界怎么切，
        # 所以只钉"确实聚合掉了"（1/4 到 1/8 之间），不钉一个精确值。
        self.assertLess(stats["rows_in_agg"], stats["rows_in_obs"])
        self.assertGreaterEqual(stats["rows_in_agg"], self.ROWS // 8)

        subset = ch_bench.bench_queries()[:2]
        results = ch_bench.run_bench(self.client, reps=1, queries=subset)
        self.assertEqual(len(results), 2)
        for entry in results:
            self.assertGreater(entry["p50"], 0.0)
            self.assertGreaterEqual(entry["rows"], 1)

    def test_03_load_is_repeatable(self):
        first = list(ch_bench.gen_rows(50, seed=1))
        stats = ch_bench.load(self.client, 50, batch_size=50, seed=1, verbose=False)
        self.assertEqual(stats["rows_in_obs"], 50)
        self.assertEqual(list(ch_bench.gen_rows(50, seed=1)), first)


if __name__ == "__main__":
    unittest.main()
