# -*- coding: utf-8 -*-
"""ClickHouse 单机版（E4 高性能引擎）的起停、建表、灌数与 20 条聚合基准。

只走 **HTTP 接口**（默认 ``127.0.0.1:8123``），只用标准库，不装
``clickhouse-driver``／``clickhouse-connect``——目标机器上只要能跑 Python 就能跑它。

四个动作，可单用也可一次串起来（按固定顺序执行）：

::

    python tools/ch_bench.py --start                 # 起服务（回环，前台守护进程）
    python tools/ch_bench.py --init                  # 建库 fsa + 观测表 + 1 分钟聚合表
    python tools/ch_bench.py --load 200000           # 确定性灌 N 行，再回填聚合表
    python tools/ch_bench.py --bench                 # 20 条聚合查询，每条 p50/p95
    python tools/ch_bench.py --stop                  # 优雅停止并确认端口已释放

为什么是这份二进制（实测，2026-11-05）：

- ClickHouse **没有官方 Windows 原生构建**。``builds.clickhouse.com/master/amd64/
  clickhouse.exe`` 返回 ``403 AccessDenied``（对象不存在），winget 里也没有服务端包，
  官方 KB 的 Windows 安装方式是 WSL 2。
- 所以本脚本把 Linux 单文件二进制放在 ``.deps/clickhouse/clickhouse``，
  通过 WSL2 跑起来；WSL 的 localhost 转发让 Windows 侧 ``127.0.0.1:8123`` 直接可用。
- 二进制不能直接从 ``/mnt/h`` 执行（``Unable to obtain inode for exe``，
  9p 上 ``/proc/self/exe`` 解析不到），因此另拷一份到 WSL 的 ext4 再跑；
  **被执行的必须是 ext4 上那份**，数据目录则留在仓库的 ``.deps/clickhouse/data``。

``--stop`` 一定要跑。门禁／CI 机器上留着一个 8123 监听，后面所有"端口被占"的
怪问题都会找上门。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional, Sequence

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BIN_DIR = ROOT / ".deps" / "clickhouse"
DEFAULT_BINARY = DEFAULT_BIN_DIR / "clickhouse"        # 下载下来的原件（ELF）
DEFAULT_DATA_DIR = DEFAULT_BIN_DIR / "data"
DEFAULT_RUN_DIR = DEFAULT_BIN_DIR / "run"
DEFAULT_DB = "fsa"
OBS_TABLE = "obs"
AGG_TABLE = "obs_1m"
DEFAULT_URL = "http://127.0.0.1:8123"
DEFAULT_HTTP_PORT = 8123
DEFAULT_TCP_PORT = 9000
DEFAULT_SEED = 20261105
DEFAULT_BATCH = 50_000
DEFAULT_REPS = 5
MAX_LOAD_ROWS = 20_000_000
ENV_BIN = "FSA_CLICKHOUSE_BIN"
ENV_EXEC = "FSA_CLICKHOUSE_EXEC"      # WSL 里那份可执行副本（默认 ext4 上的固定位置）
ENV_DISTRO = "FSA_CLICKHOUSE_DISTRO"
WSL_MOUNT = "/mnt"

STATIONS = tuple("FSA-%02d" % i for i in range(1, 9))
OBS_TYPES = ("air_temp", "soil_moist", "wind_speed", "par")

#: 每种观测的 (基线, 日周期振幅, 噪声标准差)。只用来说明合成数据"像观测"，
#: 不参与任何断言——真正要保证的是**确定性**。
OBS_PROFILE = {
    "air_temp": (12.0, 8.0, 0.35),
    "soil_moist": (0.28, 0.05, 0.004),
    "wind_speed": (3.2, 1.6, 0.50),
    "par": (420.0, 380.0, 25.0),
}
#: 日均起点：所有时间戳 = 这个时刻 + 分钟偏移，方便按天切片。
BASE_EPOCH = 1767225600          # 2026-01-01 00:00:00 UTC
#: 采样间隔（秒）。15 s → 每个 (站, 类型) 每分钟 4 条，
#: 1 分钟聚合表才有"多采样取 min/max/avg"的意义；200k 行约覆盖 26 小时。
SAMPLE_SECONDS = 15
#: 基准里"单站单日"用的切片窗口（2026-01-01 全天，200k 行必然覆盖到）。
DAY_START = "2026-01-01 00:00:00"
DAY_END = "2026-01-02 00:00:00"

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_DAY_TIME = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


class ChError(RuntimeError):
    """ClickHouse 侧失败（HTTP 非 200、连不上、二进制缺失）。"""


# ------------------------------------------------------------------ 校验
def validate_ident(name) -> str:
    """库名／表名只接受 ``[A-Za-z_][A-Za-z0-9_]*``，其余一律拒绝。

    SQL 是拼出来的（HTTP 接口没有参数绑定），所以标识符必须先过白名单，
    否则 ``--db 'fsa; DROP DATABASE default'`` 这种就真能执行。
    """
    if not isinstance(name, str) or not _IDENT.match(name):
        raise ValueError("非法标识符 %r（只允许字母/数字/下划线，且不以数字开头）" % (name,))
    return name


def validate_rows(n) -> int:
    """灌数行数：正整数，且不超过 :data:`MAX_LOAD_ROWS`（防手滑灌爆磁盘）。"""
    if isinstance(n, bool):
        raise ValueError("行数必须是整数，不是 bool：%r" % (n,))
    try:
        value = int(n)
    except (TypeError, ValueError):
        raise ValueError("行数必须是整数：%r" % (n,))
    if value < 1:
        raise ValueError("行数必须 ≥ 1：%r" % (n,))
    if value > MAX_LOAD_ROWS:
        raise ValueError("行数 %d 超过上限 %d（合成数据没必要灌这么多）"
                         % (value, MAX_LOAD_ROWS))
    return value


def validate_port(port) -> int:
    try:
        value = int(port)
    except (TypeError, ValueError):
        raise ValueError("端口必须是整数：%r" % (port,))
    if not 1 <= value <= 65535:
        raise ValueError("端口越界（1..65535）：%r" % (port,))
    return value


def validate_day_time(text) -> str:
    """``YYYY-MM-DD HH:MM:SS``（拼进 SQL 字面量前必须过这里）。"""
    if not isinstance(text, str) or not _DAY_TIME.match(text):
        raise ValueError("时间必须是 YYYY-MM-DD HH:MM:SS：%r" % (text,))
    return text


def validate_reps(n) -> int:
    try:
        value = int(n)
    except (TypeError, ValueError):
        raise ValueError("重复次数必须是整数：%r" % (n,))
    if value < 1:
        raise ValueError("重复次数必须 ≥ 1：%r" % (n,))
    return value


# ------------------------------------------------------------------ 统计
def percentile(values: Sequence[float], p: float) -> float:
    """线性插值分位数（p ∈ [0,100]）。样本为 1 时原样返回。

    用小样本（默认 5 次）就能算 p50/p95，不必为统计引第三方库。
    注意 **5 个样本的 p95 不等于最大值**：秩是 4×0.95=3.8，插值落在
    次大与最大之间（[1,2,3,4,10] → 8.8）。读 p95 时要记住这一点，
    别把它当成最差值。
    """
    if not values:
        raise ValueError("空样本没有分位数")
    if not 0 <= p <= 100:
        raise ValueError("分位数必须在 0..100：%r" % (p,))
    ordered = sorted(float(v) for v in values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * (p / 100.0)
    lo, hi = int(math.floor(rank)), int(math.ceil(rank))
    if lo == hi:
        return ordered[lo]
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo)


def summarize(samples: Sequence[float]) -> dict:
    """p50/p95/min/max 一次算齐。"""
    return {
        "p50": percentile(samples, 50),
        "p95": percentile(samples, 95),
        "min": min(samples),
        "max": max(samples),
        "n": len(samples),
    }


# ------------------------------------------------------------------ URL / HTTP
def build_url(base: str = DEFAULT_URL, database: Optional[str] = None,
              params: Optional[dict] = None) -> str:
    """拼 HTTP 接口地址：``base`` + ``?`` + 参数。

    ``database`` 走查询串（ClickHouse 认这个参数），其余参数原样 URL 编码。
    空参数表且没有库名时返回以 ``/`` 结尾的地址，避免把 ``/?`` 发出去。
    """
    if not base or "://" not in base:
        raise ValueError("base 必须是 http(s):// 形式的地址：%r" % (base,))
    url = base.rstrip("/") + "/"
    query = dict(params or {})
    if database is not None:
        query["database"] = validate_ident(database)
    if not query:
        return url
    return url + "?" + urllib.parse.urlencode(query)


class Client:
    """极简 ClickHouse HTTP 客户端：一条 SQL 一次 POST，正文即 SQL。"""

    def __init__(self, base: str = DEFAULT_URL, database: str = DEFAULT_DB,
                 timeout: float = 120.0):
        self.base = base
        self.database = validate_ident(database)
        self.timeout = float(timeout)

    # -- 单次查询 ------------------------------------------------------
    def query(self, sql: str, *, database: Optional[str] = None,
              timeout: Optional[float] = None) -> str:
        db = self.database if database is None else validate_ident(database)
        url = build_url(self.base, database=db)
        body = sql.encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "text/plain; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:800]
            raise ChError("HTTP %d：%s\nSQL: %s" % (exc.code, detail.strip(), sql.strip()[:300]))
        except urllib.error.URLError as exc:
            raise ChError("连不上 %s：%s（先 --start，或确认服务没被停掉）"
                          % (self.base, exc.reason))

    # -- 便利方法 ------------------------------------------------------
    def execute(self, sql: str) -> None:
        self.query(sql)

    def scalar(self, sql: str, **kwargs) -> str:
        return self.query(sql, **kwargs).strip()

    def rows(self, sql: str, **kwargs) -> list:
        text = self.query(sql, **kwargs)
        return [ln.split("\t") for ln in text.splitlines() if ln]

    def ping(self, timeout: float = 3.0) -> bool:
        """探活。**不带 database 参数** —— 服务刚起来时目标库还没建，
        带上库名连 ``SELECT 1`` 都会被判成 "Database ... doesn't exist"。"""
        try:
            body = "SELECT 1".encode("utf-8")
            req = urllib.request.Request(build_url(self.base), data=body, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "replace").strip() == "1"
        except (urllib.error.URLError, OSError):
            return False

    def version(self) -> str:
        return self.scalar("SELECT version()", database="default")


def port_open(host: str = "127.0.0.1", port: int = DEFAULT_HTTP_PORT,
              timeout: float = 0.5) -> bool:
    """端口是否有人监听（用来确认 --stop 真的停干净了）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, validate_port(port))) == 0


# ------------------------------------------------------------------ SQL
def sql_create_database(db: str = DEFAULT_DB) -> str:
    return "CREATE DATABASE IF NOT EXISTS %s" % validate_ident(db)


def sql_create_obs_table(db: str = DEFAULT_DB, table: str = OBS_TABLE) -> str:
    return (
        "CREATE TABLE IF NOT EXISTS {db}.{t} (\n"
        "  station   LowCardinality(String),\n"
        "  ts        DateTime,\n"
        "  obs_type  LowCardinality(String),\n"
        "  value     Float64\n"
        ")\n"
        "ENGINE = MergeTree\n"
        "ORDER BY (station, ts)"
    ).format(db=validate_ident(db), t=validate_ident(table))


def sql_create_agg_table(db: str = DEFAULT_DB, table: str = AGG_TABLE) -> str:
    """1 分钟聚合表：按 (station, bucket, obs_type) 一行，预聚合八个字段。"""
    return (
        "CREATE TABLE IF NOT EXISTS {db}.{t} (\n"
        "  station   LowCardinality(String),\n"
        "  bucket    DateTime,\n"
        "  obs_type  LowCardinality(String),\n"
        "  samples   UInt64,\n"
        "  v_min     Float64,\n"
        "  v_max     Float64,\n"
        "  v_avg     Float64,\n"
        "  v_sum     Float64\n"
        ")\n"
        "ENGINE = MergeTree\n"
        "ORDER BY (station, bucket)"
    ).format(db=validate_ident(db), t=validate_ident(table))


def sql_truncate(db: str, table: str) -> str:
    return "TRUNCATE TABLE IF EXISTS %s.%s" % (validate_ident(db), validate_ident(table))


def sql_count(db: str, table: str) -> str:
    return "SELECT count() FROM %s.%s" % (validate_ident(db), validate_ident(table))


def sql_insert_header(db: str = DEFAULT_DB, table: str = OBS_TABLE) -> str:
    """``INSERT ... FORMAT TSV`` 的头部；正文按行追加。"""
    return "INSERT INTO %s.%s FORMAT TSV\n" % (validate_ident(db), validate_ident(table))


def sql_backfill_agg(db: str = DEFAULT_DB, obs: str = OBS_TABLE,
                     agg: str = AGG_TABLE) -> str:
    """把观测表按分钟聚合进聚合表（一次 INSERT SELECT，不逐行写）。"""
    return (
        "INSERT INTO {db}.{agg}\n"
        "SELECT station,\n"
        "       toStartOfMinute(ts) AS bucket,\n"
        "       obs_type,\n"
        "       count()             AS samples,\n"
        "       min(value)          AS v_min,\n"
        "       max(value)          AS v_max,\n"
        "       avg(value)          AS v_avg,\n"
        "       sum(value)          AS v_sum\n"
        "FROM {db}.{obs}\n"
        "GROUP BY station, bucket, obs_type"
    ).format(db=validate_ident(db), agg=validate_ident(agg), obs=validate_ident(obs))


def sql_tables(db: str = DEFAULT_DB) -> str:
    return ("SELECT name, total_rows FROM system.tables WHERE database = '%s' "
            "ORDER BY name" % validate_ident(db))


# ------------------------------------------------------------------ 合成数据
def row_values(index: int, rnd: random.Random) -> tuple:
    """第 ``index`` 行的 (station, ts, obs_type, value)。

    站与观测类型按固定步长轮转，时间戳由 ``index`` 直接算出，
    只有噪声取 ``rnd``——所以同 seed 同 N 的结果逐字节可复现。
    """
    station = STATIONS[index % len(STATIONS)]
    obs_type = OBS_TYPES[(index // len(STATIONS)) % len(OBS_TYPES)]
    slot = index // (len(STATIONS) * len(OBS_TYPES))
    second = slot * SAMPLE_SECONDS
    ts = BASE_EPOCH + second
    base, amp, sigma = OBS_PROFILE[obs_type]
    day_phase = (second % 86400) / 86400.0
    value = base + amp * math.sin(2.0 * math.pi * (day_phase - 0.25)) + rnd.gauss(0.0, sigma)
    if obs_type != "air_temp":
        value = max(value, 0.0)
    return station, ts, obs_type, round(value, 3)


def gen_rows(n: int, seed: int = DEFAULT_SEED) -> Iterator[str]:
    """产出 N 行 TSV（``station\\tts\\tobs_type\\tvalue``），确定性。"""
    count = validate_rows(n)
    rnd = random.Random(seed)
    for i in range(count):
        station, ts, obs_type, value = row_values(i, rnd)
        yield "%s\t%d\t%s\t%.3f\n" % (station, ts, obs_type, value)


def chunks(items: Iterable[str], size: int) -> Iterator[list]:
    """按固定行数切片；最后一块可以不满。"""
    if size < 1:
        raise ValueError("批大小必须 ≥ 1：%r" % (size,))
    batch: list = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


# ------------------------------------------------------------------ 20 条基准
@dataclass(frozen=True)
class BenchQuery:
    key: str
    title: str
    sql: str


def bench_queries(db: str = DEFAULT_DB, obs: str = OBS_TABLE,
                  agg: str = AGG_TABLE) -> tuple:
    """20 条聚合查询：单站单日、时间桶、多站对比、去重计数、分位数、窗口函数。

    覆盖了台站数据最常见的读法——"某站某天怎么样""按小时看趋势"
    ""哪个站偏高""不同类型各多少条"。
    """
    db, obs, agg = validate_ident(db), validate_ident(obs), validate_ident(agg)
    t = "%s.%s" % (db, obs)
    a = "%s.%s" % (db, agg)
    day = "toDateTime('%s')" % validate_day_time(DAY_START)
    next_day = "toDateTime('%s')" % validate_day_time(DAY_END)
    return (
        BenchQuery("count_all", "全表行数", "SELECT count() FROM %s" % t),
        BenchQuery(
            "one_station_day", "单站单日 均/极值",
            "SELECT count() AS n, round(avg(value), 4) AS v_avg,"
            " min(value) AS v_min, max(value) AS v_max FROM %s"
            " WHERE station = 'FSA-03' AND ts >= %s AND ts < %s" % (t, day, next_day)),
        BenchQuery(
            "minute_buckets", "单站 1 分钟时间桶",
            "SELECT toStartOfMinute(ts) AS bucket, count() AS n,"
            " round(avg(value), 4) AS v FROM %s WHERE station = 'FSA-03'"
            " GROUP BY bucket ORDER BY bucket LIMIT 500" % t),
        BenchQuery(
            "hour_quantiles", "单站 1 小时桶 p95",
            "SELECT toStartOfHour(ts) AS hour, round(quantile(0.95)(value), 4) AS p95"
            " FROM %s WHERE station = 'FSA-01' GROUP BY hour ORDER BY hour" % t),
        BenchQuery(
            "station_compare", "八站对比 均值",
            "SELECT station, count() AS n, round(avg(value), 4) AS v_avg"
            " FROM %s GROUP BY station ORDER BY station" % t),
        BenchQuery(
            "distinct_counts", "去重计数 站/类型",
            "SELECT uniqExact(station) AS stations, uniqExact(obs_type) AS types FROM %s" % t),
        BenchQuery(
            "station_days", "每站去重天数",
            "SELECT station, uniqExact(toDate(ts)) AS days FROM %s"
            " GROUP BY station ORDER BY station" % t),
        BenchQuery(
            "station_type_p50_p95", "站×类型 p50/p95",
            "SELECT station, obs_type, round(quantile(0.5)(value), 4) AS p50,"
            " round(quantile(0.95)(value), 4) AS p95 FROM %s"
            " GROUP BY station, obs_type ORDER BY station, obs_type" % t),
        BenchQuery(
            "top_days", "日均值 Top10",
            "SELECT station, toDate(ts) AS day, round(avg(value), 4) AS v FROM %s"
            " GROUP BY station, day ORDER BY v DESC LIMIT 10" % t),
        BenchQuery(
            "samples_per_day", "每站每天样本数",
            "SELECT station, toDate(ts) AS day, count() AS n FROM %s"
            " GROUP BY station, day ORDER BY n DESC LIMIT 10" % t),
        BenchQuery(
            "daily_peak", "单站日内峰值时刻 argMax",
            "SELECT toDate(ts) AS day, argMax(ts, value) AS peak_ts,"
            " max(value) AS peak FROM %s WHERE station = 'FSA-02'"
            " GROUP BY day ORDER BY day" % t),
        BenchQuery(
            "volatility", "波动 标准差",
            "SELECT station, obs_type, round(stddevPop(value), 4) AS sd FROM %s"
            " GROUP BY station, obs_type ORDER BY sd DESC" % t),
        BenchQuery(
            "neighbor_delta", "相邻观测差分 窗口函数",
            "SELECT station, ts, value - lagInFrame(value) OVER"
            " (PARTITION BY station ORDER BY ts) AS delta FROM %s"
            " WHERE station = 'FSA-01' ORDER BY ts LIMIT 500" % t),
        BenchQuery(
            "hour_amplitude", "每站每小时振幅 Top20",
            "SELECT station, toStartOfHour(ts) AS hour, max(value) - min(value) AS amp"
            " FROM %s GROUP BY station, hour ORDER BY amp DESC LIMIT 20" % t),
        BenchQuery(
            "prefix_filter", "前缀+类型过滤计数",
            "SELECT count() AS n, round(avg(value), 4) AS v FROM %s"
            " WHERE station LIKE 'FSA-0%%' AND obs_type = 'air_temp'" % t),
        BenchQuery(
            "aligned_instants", "同一时刻多站对齐 Top20",
            "SELECT ts, count() AS n, round(avg(value), 4) AS v FROM %s"
            " GROUP BY ts HAVING n >= 4 ORDER BY v DESC LIMIT 20" % t),
        BenchQuery(
            "cross_matrix", "站×类型 计数矩阵",
            "SELECT station, countIf(obs_type = 'air_temp') AS air_temp,"
            " countIf(obs_type = 'soil_moist') AS soil_moist,"
            " countIf(obs_type = 'wind_speed') AS wind_speed"
            " FROM %s GROUP BY station ORDER BY station" % t),
        BenchQuery(
            "agg_day", "聚合表单日回放",
            "SELECT station, round(avg(v_avg), 4) AS v_avg, sum(samples) AS n"
            " FROM %s WHERE bucket >= %s AND bucket < %s"
            " GROUP BY station ORDER BY station" % (a, day, next_day)),
        BenchQuery(
            "agg_hour", "聚合表按小时",
            "SELECT toStartOfHour(bucket) AS hour, round(avg(v_avg), 4) AS v,"
            " max(v_max) AS peak FROM %s GROUP BY hour ORDER BY hour LIMIT 100" % a),
        BenchQuery(
            "quantiles_all", "全表 p50/p90/p99",
            "SELECT quantiles(0.5, 0.9, 0.99)(value) FROM %s" % t),
    )


# ------------------------------------------------------------------ 建表 / 灌数
def init_schema(client: Client, db: str = DEFAULT_DB, *, verbose: bool = True) -> list:
    """建库 + 两张表，返回实际执行的 SQL 列表（幂等，重复跑无害）。"""
    statements = (
        sql_create_database(db),
        sql_create_obs_table(db, OBS_TABLE),
        sql_create_agg_table(db, AGG_TABLE),
    )
    for sql in statements:
        # 走 default 库执行：目标库可能还不存在，带着未建库名发请求会被直接拒。
        client.query(sql, database="default")
        if verbose:
            print("  [init] %s" % " ".join(sql.split())[:96])
    return list(statements)


def load(client: Client, rows: int, db: str = DEFAULT_DB, *,
         seed: int = DEFAULT_SEED, batch_size: int = DEFAULT_BATCH,
         truncate: bool = True, verbose: bool = True) -> dict:
    """灌 N 行确定性数据，再回填 1 分钟聚合表，返回统计。"""
    total = validate_rows(rows)
    if batch_size < 1:
        raise ValueError("批大小必须 ≥ 1：%r" % (batch_size,))
    if truncate:
        client.execute(sql_truncate(db, OBS_TABLE))
        client.execute(sql_truncate(db, AGG_TABLE))
    header = sql_insert_header(db, OBS_TABLE)
    started = time.perf_counter()
    written = 0
    for batch in chunks(gen_rows(total, seed=seed), batch_size):
        client.query(header + "".join(batch))
        written += len(batch)
        if verbose:
            print("  [load] %7d / %d 行" % (written, total), end="\r", flush=True)
    insert_sec = time.perf_counter() - started
    if verbose:
        print("  [load] %7d / %d 行，用时 %.2fs（%.0f 行/s）"
              % (written, total, insert_sec, written / max(insert_sec, 1e-9)))
    client.execute(sql_backfill_agg(db, OBS_TABLE, AGG_TABLE))
    stats = {
        "rows_requested": total,
        "rows_in_obs": int(client.scalar(sql_count(db, OBS_TABLE))),
        "rows_in_agg": int(client.scalar(sql_count(db, AGG_TABLE))),
        "insert_seconds": round(insert_sec, 3),
        "rows_per_second": round(written / max(insert_sec, 1e-9), 1),
        "seed": seed,
        "batch_size": batch_size,
    }
    if stats["rows_in_obs"] != total:
        raise ChError("灌数行数不一致：要 %d，表里 %d" % (total, stats["rows_in_obs"]))
    return stats


def run_bench(client: Client, db: str = DEFAULT_DB, *, reps: int = DEFAULT_REPS,
              queries: Optional[Sequence[BenchQuery]] = None) -> list:
    """逐条跑基准，返回每条的结果（p50/p95/行数/字节数）。

    返回字段用 ``idx``（不是 ``n``）——``summary`` 里已经有 ``n`` 表示样本数，
    两者同名过一次，结果表里每条都显示 "5"，排查了半天。
    """
    reps = validate_reps(reps)
    items = list(queries or bench_queries(db))
    results = []
    for idx, q in enumerate(items, 1):
        client.query(q.sql)                       # 预热：把首次解析/缓存抖动排除
        samples = []
        rows = 0
        size = 0
        for _ in range(reps):
            t0 = time.perf_counter()
            text = client.query(q.sql)
            samples.append((time.perf_counter() - t0) * 1000.0)
            rows = sum(1 for ln in text.splitlines() if ln)
            size = len(text.encode("utf-8"))
        entry = {"idx": idx, "key": q.key, "title": q.title,
                 "rows": rows, "bytes": size}
        entry.update(summarize(samples))
        results.append(entry)
    return results


def transport_baseline(client: Client, reps: int = 10) -> dict:
    """``SELECT 1`` 的往返时延：Windows→WSL 回环转发 + HTTP 框架的固定开销。

    最快的那些聚合查询（p50 个位数毫秒）里有一大半是这层开销。把它单独量出来，
    读数时才知道扣掉多少是引擎本身的。
    """
    samples = []
    for _ in range(max(1, int(reps))):
        t0 = time.perf_counter()
        client.query("SELECT 1", database="default")
        samples.append((time.perf_counter() - t0) * 1000.0)
    return summarize(samples)


def format_bench(results: Sequence[dict], dataset_rows: int, reps: int,
                 baseline: Optional[dict] = None) -> str:
    """把基准结果排版成一张表（前 5 条会被验收直接贴出来）。"""
    head = ("%3s  %-30s %10s %10s %9s %10s"
            % ("#", "查询", "p50(ms)", "p95(ms)", "行数", "返回字节"))
    lines = [head, "-" * 78]
    for r in results:
        title = r["title"]
        # 中文按两格算，才能对齐；窄终端也不至于撑爆
        pad = 30 - sum(2 if ord(ch) > 127 else 1 for ch in title)
        lines.append("%3d  %s%s %10.2f %10.2f %9d %10d"
                     % (r["idx"], title, " " * max(pad, 0),
                        r["p50"], r["p95"], r["rows"], r["bytes"]))
    lines.append("-" * 78)
    total_rows = sum(r["rows"] for r in results)
    slowest = max(results, key=lambda r: r["p50"]) if results else None
    if baseline:
        lines.append("往返基线 SELECT 1：p50 %.2f ms / p95 %.2f ms"
                     "（Windows→WSL 回环转发 + HTTP 固定开销，读数时先扣掉这部分）"
                     % (baseline["p50"], baseline["p95"]))
    lines.append("合计 %d 条查询 × %d 次；数据集 %d 行；返回行数合计 %d"
                 % (len(results), reps, dataset_rows, total_rows))
    if slowest:
        lines.append("最慢（p50）：#%d %s  %.2f ms"
                     % (slowest["idx"], slowest["title"], slowest["p50"]))
    return "\n".join(lines)


# ------------------------------------------------------------------ WSL / 进程
def parse_wsl_distros(raw) -> list:
    """解析 ``wsl.exe -l -q`` 的输出。

    WSL 在 Windows 上把这张表按 **UTF-16LE** 吐出来（每个字符后跟一个 NUL），
    直接按 UTF-8 解会得到一列夹杂 ``\\x00`` 的乱码名字。这里统一处理：
    收 bytes 或 str，两种来源都能还原出干净的发行版名。
    """
    if isinstance(raw, bytes):
        text = raw.decode("utf-16-le", errors="ignore")
        if "\x00" in text:
            text = text.replace("\x00", "")
        if not text.strip():
            text = raw.decode("utf-8", errors="replace")
    else:
        text = str(raw).replace("\x00", "")
    names = []
    for line in text.splitlines():
        name = line.replace("\ufeff", "").strip()
        if name:
            names.append(name)
    return names


def to_wsl_path(path) -> str:
    """``H:\\a\\b`` → ``/mnt/h/a/b``；已是 POSIX 路径的原样返回。

    WSL 的 ``/mnt/<盘符>`` 是固定约定，盘符小写。路径里有空格和中文都不用转义——
    真正拼命令行时由 :func:`shell_path` 负责加引号。相对路径先按当前目录求绝对。
    """
    text = str(path).replace("\\", "/")
    if not re.match(r"^([A-Za-z]):(/.*)?$", text) and not text.startswith("/"):
        text = str(Path(path).resolve()).replace("\\", "/")
    match = re.match(r"^([A-Za-z]):(/.*)?$", text)
    if match:
        rest = match.group(2) or "/"
        return "%s/%s%s" % (WSL_MOUNT, match.group(1).lower(), rest)
    if text.startswith("/"):
        return text
    raise ValueError("既不是 Windows 绝对路径也不是 POSIX 绝对路径：%r" % (path,))


def shquote(text) -> str:
    """POSIX 单引号转义（bash 里唯一安全的写法）。"""
    return "'" + str(text).replace("'", "'\\''") + "'"


def shell_path(path) -> str:
    """给 shell 用的路径写法：``~/x`` 交给 bash 展开，其余用单引号钉死。

    直接 ``shquote('~/a')`` 会让 ``~`` 变成字面量——写脚本时踩过一次。
    """
    text = str(path)
    if text == "~":
        return '"$HOME"'
    if text.startswith("~/"):
        return '"$HOME/%s"' % text[2:]
    return shquote(text)


def is_elf(path) -> bool:
    """文件头是不是 ``\\x7fELF``。Windows 上拿到 ELF 就只能借 WSL 跑。"""
    try:
        with open(path, "rb") as fh:
            return fh.read(4) == b"\x7fELF"
    except OSError:
        return False


def resolve_binary(explicit: Optional[str] = None, *,
                   env: Optional[dict] = None) -> Optional[Path]:
    """按 显式参数 → 环境变量 → ``.deps/clickhouse`` 下的默认名 找二进制。

    只认 ``clickhouse``（Linux 单文件）与 ``clickhouse.exe``（若将来有原生构建）。
    环境变量或参数**明确给了但不存在**时返回 ``None``，不偷偷退回默认那份。
    """
    env = os.environ if env is None else env
    for candidate in (explicit, env.get(ENV_BIN)):
        if candidate:
            p = Path(candidate)
            return p if p.is_file() else None
    for name in ("clickhouse.exe", "clickhouse"):
        p = DEFAULT_BIN_DIR / name
        if p.is_file():
            return p
    return None


def default_wsl_distro(env: Optional[dict] = None) -> str:
    """默认发行版：环境变量优先，否则取 ``wsl -l -q`` 的第一项。"""
    env = os.environ if env is None else env
    forced = env.get(ENV_DISTRO)
    if forced:
        return forced
    try:
        proc = subprocess.run(["wsl.exe", "-l", "-q"], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ChError("找不到 wsl.exe（%s）——本机没有 WSL 就跑不了这份 Linux 二进制"
                      % exc)
    names = parse_wsl_distros(proc.stdout or b"")
    if not names:
        raise ChError("wsl -l -q 没有列出任何发行版")
    return names[0]


def exec_copy_path(env: Optional[dict] = None) -> str:
    """WSL 里那份可执行副本（ext4 上，默认 ``~/.local/share/fsa-clickhouse/``）。"""
    env = os.environ if env is None else env
    return env.get(ENV_EXEC, "~/.local/share/fsa-clickhouse/clickhouse")


def expand_guest_path(distro: str, path) -> str:
    """把 ``~/x`` 展开成客户机里的绝对路径（``/home/<用户>/x``）。

    展开之后再存进 ``server.json``：``--stop`` 要靠"cmdline 含数据目录"认领进程，
    而 ``pgrep`` 看到的是展开后的路径，拿 ``~/`` 去匹配永远匹配不上。
    """
    text = str(path)
    if text.startswith("~/"):
        home = _run_wsl(distro, 'printf %s "$HOME"', timeout=30).strip()
        return home + text[1:]
    return text


def server_shell_command(exec_path: str, data_dir: str, *, http_port: int = DEFAULT_HTTP_PORT,
                         tcp_port: int = DEFAULT_TCP_PORT, pidfile: str, log: str,
                         errlog: str, listen_host: str = "0.0.0.0") -> str:
    """拼出 ``clickhouse server --daemon ...`` 的一整条 shell 命令。

    ``listen_host=0.0.0.0`` 是 WSL2 NAT 模式下的必要条件：只绑 ``127.0.0.1``
    的话 Windows 侧的 localhost 转发过不来。它仍然只暴露在 WSL 的内部网段 +
    宿主机回环上，局域网里的别的机器连不到。
    """
    validate_port(http_port)
    return " ".join([
        shell_path(exec_path), "server", "--daemon",
        "--pidfile=%s" % shquote(pidfile),
        "-L", shquote(log),
        "-E", shquote(errlog),
        "--",
        "--path=%s" % shquote(data_dir),
        "--http_port=%d" % validate_port(http_port),
        "--tcp_port=%d" % validate_port(tcp_port),
        # 本地基准只用 HTTP：mysql/postgres 协议端口一律关掉。
        # 它们默认是 9004/9005，起第二个实例时报 "Address already in use"，
        # 而且多两个监听端口对 "只用回环" 这个前提没有任何好处。
        "--mysql_port=0",
        "--postgresql_port=0",
        "--listen_host=%s" % shquote(listen_host),
    ])


def server_json_path(run_dir: Path = DEFAULT_RUN_DIR) -> Path:
    return Path(run_dir) / "server.json"


def _run_wsl(distro: str, script: str, *, timeout: float = 300) -> str:
    """在 WSL 里跑一段 bash 脚本。

    脚本**走 stdin**（``bash -s``），不拼进命令行：``wsl.exe`` 会把 argv 交给
    客户机里的 shell 再解析一遍，路径里的空格/中文/嵌套引号在那一层就会被拆坏
    （实测 ``"$(dirname "$HOME/…")"`` 直接报 "unexpected EOF"）。
    走 stdin 之后这里传什么 bash 就执行什么。
    """
    proc = subprocess.run(["wsl.exe", "-d", distro, "--", "bash", "-s"],
                          input=script.encode("utf-8"),
                          capture_output=True, timeout=timeout)
    out = (proc.stdout or b"").decode("utf-8", errors="replace")
    err = (proc.stderr or b"").decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise ChError("WSL 命令失败（rc=%d）：%s\n%s"
                      % (proc.returncode, script[:200], (err or out).strip()[:800]))
    return out


def ensure_exec_copy(binary: Path, distro: str, *, env: Optional[dict] = None,
                     verbose: bool = True) -> str:
    """把 Linux 二进制拷到 WSL 的 ext4 上（``/mnt/*`` 上直接 exec 会失败）。

    已有且**来源版本没变**就跳过，省掉每次 200+ MB 的复制。

    注意不能用目标文件大小判断："clickhouse" 首次运行会自解压（下载 218 MB →
    解压后 903 MB），所以比的是旁边那个 ``.srcsize`` 标记里的**下载件大小**。
    这也是踩出来的：拿解压后的大小去比，每次都会判成"不一样"，白拷 900 MB。
    """
    target = exec_copy_path(env)
    src = to_wsl_path(binary)
    size = binary.stat().st_size
    tgt = shell_path(target)
    marker = shell_path(str(target) + ".srcsize")
    script = (
        "set -e; mkdir -p \"$(dirname %s)\"; "
        "if [ -x %s ] && [ \"$(cat %s 2>/dev/null)\" = \"%d\" ]; then echo SAME; "
        "else cp %s %s && chmod +x %s && echo %d > %s && echo COPIED; fi"
        % (tgt, tgt, marker, size, shquote(src), tgt, tgt, size, marker))
    try:
        out = _run_wsl(distro, script, timeout=600).strip()
    except ChError as exc:
        if "busy" in str(exc) or "忙" in str(exc):
            raise ChError("可执行副本正在被运行中的服务占用（%s）：先 --stop 再 --start"
                          % target)
        raise
    if verbose:
        print("  [server] 可执行副本 %s：%s" % (target, out or "ok"))
    return target


def wait_ready(client: Client, *, timeout: float = 60.0, interval: float = 0.3) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if client.ping(timeout=2.0):
            return True
        time.sleep(interval)
    return False


def start_server(*, binary: Optional[Path] = None, data_dir: Path = DEFAULT_DATA_DIR,
                 run_dir: Path = DEFAULT_RUN_DIR, http_port: int = DEFAULT_HTTP_PORT,
                 tcp_port: int = DEFAULT_TCP_PORT, distro: Optional[str] = None,
                 wait: float = 90.0, verbose: bool = True) -> dict:
    """起服务并等它就绪；返回记录（同时写进 ``run/server.json`` 供 --stop 使用）。"""
    port = validate_port(http_port)
    exe = binary or resolve_binary()
    if exe is None:
        raise ChError("找不到 ClickHouse 二进制：请把单文件放到 %s"
                      "（下载方式见 docs/operations/clickhouse.md）" % DEFAULT_BINARY)
    data_dir = Path(data_dir)
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    # WSL 里的路径（/... 或 ~/...）不能从 Windows 侧 mkdir，交给 bash 建。
    # 注意不能用 str(Path(...))：WindowsPath 会把 "~/.local/x" 的斜杠换成反斜杠，
    # 之后再判 "~/"" 就永远不成立 —— 实测因此把数据写进了仓库里一个叫 "~" 的目录。
    raw_data = str(data_dir).replace("\\", "/")
    posix_data = raw_data.startswith("/") or raw_data.startswith("~/")
    if not posix_data:
        data_dir.mkdir(parents=True, exist_ok=True)
    pidfile = run_dir / "clickhouse.pid"
    log = run_dir / "server.log"
    errlog = run_dir / "server.err.log"

    client = Client("http://127.0.0.1:%d" % port, DEFAULT_DB)
    if client.ping():
        if verbose:
            print("  [server] 端口 %d 上已有服务在跑（先 --stop 再重启）" % port)
        return {"mode": "running", "http_port": port, "binary": str(exe)}

    data_str = str(data_dir)

    if is_elf(exe) and os.name == "nt":
        distro = distro or default_wsl_distro()
        exec_path = ensure_exec_copy(exe, distro, verbose=verbose)
        guest_data = (expand_guest_path(distro, raw_data) if posix_data
                      else to_wsl_path(data_dir))
        command = server_shell_command(
            exec_path, guest_data, http_port=port, tcp_port=validate_port(tcp_port),
            pidfile=to_wsl_path(pidfile), log=to_wsl_path(log),
            errlog=to_wsl_path(errlog))
        _run_wsl(distro, "set -e; mkdir -p %s; %s"
                 % (shquote(guest_data), command), timeout=180)
        data_dir = Path(guest_data)
        # 存原始 POSIX 字符串：Path 会把它变成 "\mnt\h\…"，看着像 Windows 路径，
        # 后面按 cmdline 认领进程时容易看走眼。
        data_str = guest_data
        mode, pid = "wsl", _read_pid(pidfile)
    else:
        command = [str(exe), "server", "--daemon",
                   "--pidfile=%s" % pidfile, "-L", str(log), "-E", str(errlog),
                   "--", "--path=%s" % data_dir, "--http_port=%d" % port,
                   "--tcp_port=%d" % validate_port(tcp_port),
                   "--listen_host=127.0.0.1"]
        subprocess.run(command, check=True, capture_output=True, timeout=120)
        mode, pid = "native", _read_pid(pidfile)

    handle = {"mode": mode, "distro": distro if mode == "wsl" else None,
              "pid": pid, "binary": str(exe), "data_dir": data_str,
              "http_port": port, "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
              "command": command if isinstance(command, str) else " ".join(command)}
    server_json_path(run_dir).write_text(
        json.dumps(handle, ensure_ascii=False, indent=2), encoding="utf-8")

    if not wait_ready(Client("http://127.0.0.1:%d" % port, DEFAULT_DB), timeout=wait):
        detail = _tail(errlog) or _tail(log)
        stop_server(run_dir=run_dir, verbose=False)
        raise ChError("服务在 %.0fs 内没起来（pid=%s）。日志尾部：\n%s"
                      % (wait, pid, detail))
    if verbose:
        print("  [server] 已就绪 http://127.0.0.1:%d（pid=%s，数据目录 %s）"
              % (port, pid, data_dir))
    return handle


def _read_pid(pidfile: Path) -> Optional[int]:
    for _ in range(50):
        try:
            text = Path(pidfile).read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            text = ""
        if text.isdigit():
            return int(text)
        time.sleep(0.1)
    return None


def _tail(path: Path, lines: int = 12) -> str:
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.splitlines()[-lines:])


def find_server_pids(distro: str, data_dir: Path) -> list:
    """列出 cmdline 里含本数据目录的 clickhouse server 进程（只认自己的那份）。"""
    pattern = to_wsl_path(data_dir)
    try:
        out = _run_wsl(distro, "pgrep -af 'clickhouse server' || true", timeout=30)
    except ChError:
        return []
    pids = []
    for line in out.splitlines():
        if pattern in line:
            head = line.strip().split(None, 1)[0]
            if head.isdigit():
                pids.append(int(head))
    return pids


def stop_server(*, run_dir: Path = DEFAULT_RUN_DIR, http_port: int = DEFAULT_HTTP_PORT,
                verbose: bool = True) -> bool:
    """优雅停止（SIGTERM，让它刷盘落盘），并确认监听端口已经释放。

    先按 ``run/server.json`` 里的 pid 发 SIGTERM；pid 已经不在时，退回到
    "cmdline 里含本数据目录的 clickhouse server"再杀一次——那条路能收拾
    pidfile 丢了的情况，同时不会误杀别人机器上的 ClickHouse。
    """
    run_dir = Path(run_dir)
    handle = {}
    try:
        handle = json.loads(server_json_path(run_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    mode = handle.get("mode") or ""
    if mode not in ("wsl", "native"):
        mode = "wsl" if os.name == "nt" else "native"
    distro = handle.get("distro") or (default_wsl_distro() if mode == "wsl" else None)
    data_dir = Path(handle.get("data_dir") or DEFAULT_DATA_DIR)
    pid = handle.get("pid") or _read_pid(run_dir / "clickhouse.pid")

    killed = []
    if mode == "wsl" and distro:
        targets = [pid] if pid else []
        targets += [p for p in find_server_pids(distro, data_dir) if p not in targets]
        for target in targets:
            _run_wsl(distro, "kill -TERM %d 2>/dev/null || true" % target, timeout=30)
            killed.append(target)
        deadline = time.time() + 45
        while time.time() < deadline:
            if not port_open(port=validate_port(http_port)):
                break
            time.sleep(0.3)
        leftover = find_server_pids(distro, data_dir)
        for target in leftover:
            _run_wsl(distro, "kill -KILL %d 2>/dev/null || true" % target, timeout=30)
            killed.append(target)
    elif pid:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=60)
        killed.append(pid)

    closed = not port_open(port=validate_port(http_port))
    if closed:
        try:
            server_json_path(run_dir).unlink()
        except OSError:
            pass
    if verbose:
        print("  [server] 停止 %s；端口 %d %s"
              % (killed or "（没有在跑的进程）", http_port,
                 "已释放" if closed else "仍在监听 —— 用 --stop 再试或看日志"))
    return closed


# ------------------------------------------------------------------ 命令行
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="ch_bench.py",
        description="ClickHouse 单机版：起停、建表、灌数、20 条聚合基准（只走 HTTP）")
    ap.add_argument("--start", action="store_true", help="起服务（回环）并等待就绪")
    ap.add_argument("--init", action="store_true", help="建库 %s + 观测表 + 1 分钟聚合表" % DEFAULT_DB)
    ap.add_argument("--load", type=int, metavar="N", help="灌 N 行确定性合成数据（覆盖写）")
    ap.add_argument("--bench", action="store_true", help="跑 20 条聚合查询并输出 p50/p95")
    ap.add_argument("--stop", action="store_true", help="优雅停止服务并确认端口释放")
    ap.add_argument("--status", action="store_true", help="打印版本/运行时长/表行数")
    ap.add_argument("--version", action="store_true", help="打印二进制版本（不起服务）")
    ap.add_argument("--url", default=DEFAULT_URL, help="HTTP 地址（默认 %s）" % DEFAULT_URL)
    ap.add_argument("--db", default=DEFAULT_DB, help="库名（默认 %s）" % DEFAULT_DB)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED, help="合成数据 seed（默认 %d）" % DEFAULT_SEED)
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH, help="每次 INSERT 的行数")
    ap.add_argument("--reps", type=int, default=DEFAULT_REPS, help="每条查询重复次数（默认 %d）" % DEFAULT_REPS)
    ap.add_argument("--no-truncate", action="store_true", help="--load 时追加而不是覆盖")
    ap.add_argument("--timeout", type=float, default=120.0, help="单条查询超时秒数")
    ap.add_argument("--binary", help="ClickHouse 二进制路径（默认 .deps/clickhouse/clickhouse）")
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="数据目录")
    ap.add_argument("--run-dir", default=str(DEFAULT_RUN_DIR), help="pid/日志目录")
    ap.add_argument("--http-port", type=int, default=DEFAULT_HTTP_PORT, help="HTTP 端口（默认 8123）")
    ap.add_argument("--tcp-port", type=int, default=DEFAULT_TCP_PORT,
                    help="native 端口（默认 9000；同机起第二个实例必须改）")
    ap.add_argument("--distro", help="WSL 发行版（默认取 wsl -l -q 第一项）")
    ap.add_argument("--wait", type=float, default=90.0, help="--start 等待就绪的秒数")
    ap.add_argument("--json", dest="json_path", help="把 --bench 结果写到这个 JSON")
    return ap


def main(argv=None) -> int:
    # Windows 控制台默认 GBK，任何非 GBK 字符都会抛 UnicodeEncodeError 把脚本打断
    # （仓库里 selftest.py 已经踩过一次）。降级成替换符，绝不崩在打印上。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass

    args = build_parser().parse_args(argv)
    db = args.db
    try:
        validate_ident(db)
        port = validate_port(args.http_port)
    except ValueError as exc:
        print("[用法错误] %s" % exc)
        return 2

    client = Client(args.url, db, timeout=args.timeout)

    if args.version:
        try:
            exe = resolve_binary(args.binary)
            if exe is None:
                print("[缺失] 找不到 ClickHouse 二进制（见 docs/operations/clickhouse.md）")
                return 1
            if is_elf(exe) and os.name == "nt":
                distro = args.distro or default_wsl_distro()
                out = _run_wsl(distro, "%s --version" % shell_path(exec_copy_path()))
                print(out.strip())
            else:
                proc = subprocess.run([str(exe), "--version"], capture_output=True)
                print((proc.stdout or b"").decode("utf-8", "replace").strip())
        except (ChError, OSError) as exc:
            print("[失败] %s" % exc, file=sys.stderr)
            return 1
        return 0

    try:
        if args.start:
            print("== 起服务")
            start_server(binary=Path(args.binary) if args.binary else None,
                         data_dir=Path(args.data_dir), run_dir=Path(args.run_dir),
                         http_port=port, tcp_port=args.tcp_port,
                         distro=args.distro, wait=args.wait)
        if args.init:
            print("== 建库建表")
            init_schema(client, db)
        if args.load is not None:
            print("== 灌数 %d 行（seed=%d，批 %d）" % (args.load, args.seed, args.batch_size))
            stats = load(client, args.load, db, seed=args.seed,
                         batch_size=args.batch_size, truncate=not args.no_truncate)
            print("  [load] obs=%d 行，obs_1m=%d 行，%.2fs（%.0f 行/s）"
                  % (stats["rows_in_obs"], stats["rows_in_agg"],
                     stats["insert_seconds"], stats["rows_per_second"]))
        if args.bench:
            print("== 基准（20 条 × %d 次）" % args.reps)
            dataset = int(client.scalar(sql_count(db, OBS_TABLE)))
            baseline = transport_baseline(client)
            results = run_bench(client, db, reps=args.reps)
            print(format_bench(results, dataset, args.reps, baseline))
            if args.json_path:
                Path(args.json_path).write_text(
                    json.dumps({"dataset_rows": dataset, "reps": args.reps,
                                "transport_baseline": baseline,
                                "results": results}, ensure_ascii=False, indent=2),
                    encoding="utf-8")
                print("  结果已写入 %s" % args.json_path)
        if args.status:
            print("== 状态")
            print("  版本 %s，已运行 %ss"
                  % (client.version(), client.scalar("SELECT uptime()", database="default")))
            try:
                tables = client.rows(sql_tables(db))
            except ChError:
                tables = []
                print("  库 %s 还没建（先跑 --init）" % db)
            for name, total in tables:
                print("  %s.%s  %s 行" % (db, name, total or 0))
        if args.stop:
            print("== 停服务")
            stop_server(run_dir=Path(args.run_dir), http_port=port)
    except (ChError, ValueError) as exc:
        print("[失败] %s" % exc, file=sys.stderr)
        return 1
    except subprocess.SubprocessError as exc:
        print("[失败] 子进程出错：%s" % exc, file=sys.stderr)
        return 1

    if not any((args.start, args.init, args.load is not None, args.bench,
                args.stop, args.status)):
        build_parser().print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
