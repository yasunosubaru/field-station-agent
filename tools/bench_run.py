#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""20 条基准 SQL：两引擎同跑、逐值比对、只读断言、自动回落。

## 这份脚本要回答什么

`docs/contracts/bench-sql.md` 定义了 `SQL-01`…`SQL-20`，并写明必须用
`bench_v1`（台站/日期/行数都写死）断言。本脚本就是跑那一套。

**注意别和 `fieldstation.data.bench` 混淆**：那边是 `B01`–`B20`，面向
960 行的 `synthetic_records()` 冒烟集。契约 §4 明确说「对齐完成前，
`python -m fieldstation.data.bench` 的通过**不能**当作 20 条基准 SQL 通过的证据」。
本脚本跑的是 `SQL-*`。

## 四件事

1. **造数据复用 `writer.py`**：不绕过「Parquet 是唯一真相」这条链。
   `NdjsonWriter(parquet=True)` 写 NDJSON 并顺手转同名 Parquet 分区。
2. **两引擎各跑 20 条**，逐**列**比（不只是行数）：
   列名集合相同、每行每值相同；浮点用**相对误差 1e-9**。
3. **写语句必须被拒**，且错误码是 `E_READONLY`。
4. **引擎坏掉要自动回落且明示**：`note` 里写 `engine=builtin`。

## 为什么逐值比而不是只比行数

行数相同、值不同的情况太容易发生了：`quantile_cont` 与 `quantile` 的插值口径、
`COUNT(DISTINCT)` 与 `uniqExact` 在高基数下的差异、`NULLS FIRST/LAST` 在
TopN 里的位置 —— 这些都会给出「行数对、数不对」的结果。

## 差异怎么处理

**记下来，不改结果造假。** 契约 §3 第 5 条：不一致先判「方言翻译错」还是
「数据/聚合错」，两者都不许静默回落到另一引擎的结果。本脚本把差异写进
`docs/operations/bench-results.md` 的「已知差异」一节。

用法：

    python tools/bench_run.py --out docs/operations/bench-results.md
    python tools/bench_run.py --check          # 只校验，不写文件
    python tools/bench_run.py --scale 1e8      # 亿级压测（只跑 3 条）
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from fieldstation.data.engines import (                          # noqa: E402
    BuiltinEngine,
    ClickHouseEngine,
    DuckDBEngine,
    EngineError,
    EngineUnavailable,
    ReadOnlyEngineError,
)
from fieldstation.data import dialects                             # noqa: E402
from fieldstation.data.writer import NdjsonWriter                  # noqa: E402

#: 浮点相对误差。契约 §3 写的是 1e-6，任务书要求 1e-9 —— 取更严的那个。
REL_TOL = 1e-9
ABS_TOL = 1e-12

# ---------------------------------------------------------------- 数据集规格
BENCH_STATIONS = ("WUHN", "BJFS")
BENCH_DATE = "2026-10-01"

#: 亿级压测结果（由 `--scale-out` 写出，`render_report` 读它生成那一节）。
SCALE_RESULT_PATH = ROOT / "logs" / "bench_scale_1e8.json"
SYSTEMS = (("GPS", 8), ("GLO", 6), ("GAL", 5))
SIGNALS = ("L1", "L2", "L5")
EPOCHS_PER_DAY = 86_400
#: 基准集里注入的两处缺测小时
MISSING_HOUR = {"WUHN": 7, "BJFS": 18}
#: 注入周跳：WUHN 03:00:00–03:00:11，12 历元
SLIP_HOUR = "WUHN"
SLIP_EPOCHS = 12
SLIP_START_S = 3 * 3600


def _sv_list() -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for system, count in SYSTEMS:
        for k in range(1, count + 1):
            out.append((system, k))
    return out


def _hour_aligned_chunk(chunk_epochs: int) -> int:
    """把块大小向上取整到整小时。

    **为什么必须整小时**：``writer`` 的分区键是 ``(station, date, hour)``，
    写入是**整分区覆盖**（``_write_group`` 用 ``os.replace`` 换掉整个文件），
    不是追加。块若跨进同一个小时，后一块会把前一块在该小时里的行整段覆盖掉——
    实测 600 历元按 137 切块时，``obs`` 那个小时分区从 34,200 行掉到 2,964 行，
    只剩最后一块。按小时对齐后，每个分区恰好只被写一次。
    """
    hours = -(-chunk_epochs // 3600)
    return max(3600, hours * 3600)


def _freq(signal: str) -> float:
    return {"L1": 1575.42e6, "L2": 1227.60e6, "L5": 1176.45e6}[signal]


def rows_per_epoch() -> int:
    """每历元的 `obs` 行数 = 卫星数 × 信号数。"""
    return len(_sv_list()) * len(SIGNALS)


def epochs_for_target_rows(target_rows: int) -> int:
    """让 ``obs`` 总行数**不少于** ``target_rows`` 所需的最少历元数（每站）。

    反算而不是写死：``每历元行数 × 站数 × 历元数 >= target``。返回最少的
    那个历元数——多一个历元就超额，少一个就不够，可复算。
    """
    if isinstance(target_rows, bool) or not isinstance(target_rows, int):
        raise ValueError(f"target_rows 必须是正整数，收到 {target_rows!r}")
    if target_rows <= 0:
        raise ValueError(f"target_rows 必须是正整数，收到 {target_rows!r}")
    per_epoch = rows_per_epoch() * len(BENCH_STATIONS)
    return -(-target_rows // per_epoch)  # 向上取整


def synthetic_obs_rows(station: str, date: str = BENCH_DATE,
                       epochs: int = EPOCHS_PER_DAY,
                       start_epoch: int = 0) -> list[dict]:
    """造 `obs` 行。字段顺序与 `model.Observation.to_row()` 一致。

    **值必须是确定的**（同输入逐字节同输出），否则「两引擎对比」会变成
    「两份不同数据互相比较」。

    ``start_epoch`` 让调用方分块生成：``(start_epoch, epochs)`` 这一段得到的行
    与一次性生成的前缀完全一致（所有公式只依赖绝对历元号 ``epoch``）。
    亿级规模靠它分块，不把整表读进内存。
    """
    return list(iter_obs_rows(station, date=date, epochs=epochs,
                              start_epoch=start_epoch))


def iter_obs_rows(station: str, date: str = BENCH_DATE,
                  epochs: int = EPOCHS_PER_DAY,
                  start_epoch: int = 0) -> "Iterator[dict]":
    """:func:`synthetic_obs_rows` 的生成器版本（逐行产出，不攒 list）。

    分块生成亿级数据时用它：内存占用与块大小成正比，与总量无关。
    第 ``i`` 行的值与 ``synthetic_obs_rows(...)`` 的第 ``i`` 行逐字节相同。
    """
    day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    sats = _sv_list()
    for epoch in range(start_epoch, start_epoch + epochs):
        ts = day + timedelta(seconds=epoch)
        hour = epoch // 3600
        for system, sv in sats:
            for sig_index, signal in enumerate(SIGNALS):
                # cn0：20–60 dB-Hz，随仰角变化（低仰角低）
                base = 30.0 + 15.0 * ((epoch % 3600) / 3600.0)
                cn0 = base + 3.5 * math.sin((sv + sig_index) * 0.7) + 2.0
                cn0 = max(20.0, min(60.0, cn0))

                missing = hour == MISSING_HOUR.get(station)
                quality = 0
                if missing:
                    cn0 = None
                    quality = 1
                elif (station == SLIP_HOUR and hour == 3
                      and 0 <= epoch - SLIP_START_S < SLIP_EPOCHS):
                    quality = 4

                yield {
                    "station": station,
                    "receiver_id": "RX1",
                    "epoch_utc": ts.strftime("%Y-%m-%d %H:%M:%S"),
                    "gps_week": 2442,
                    "gps_tow_s": float(epoch),
                    "system": system,
                    "sv": sv,
                    "signal": signal,
                    "freq_hz": _freq(signal),
                    "psr_m": 2.2e7 + 1.0e6 * math.sin((epoch + sv) * 0.01) + sig_index * 1000.0,
                    "adr_cycles": -1.0e8 + 1.0e5 * math.cos((epoch + sv) * 0.01),
                    "doppler_hz": -2000.0 + 40.0 * sv,
                    "cn0_dbhz": cn0,
                    "elev_deg": float(10 + (sv * 7) % 80),
                    "azim_deg": float((sv * 31) % 360),
                    "quality_flag": quality,
                }


def synthetic_tec_rows(station: str, date: str = BENCH_DATE,
                       epochs: int = EPOCHS_PER_DAY,
                       start_epoch: int = 0) -> list[dict]:
    """造 `tec` 行：每 SV 每历元一条（19 × 86400）。

    ``start_epoch`` 与 :func:`iter_obs_rows` 同义：``(start_epoch, epochs)``
    这一段与一次性生成的前缀完全一致（公式只依赖绝对历元号）。
    """
    day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    rows: list[dict] = []
    for epoch in range(start_epoch, start_epoch + epochs):
        ts = day + timedelta(seconds=epoch)
        for system, sv in _sv_list():
            vtec = 15.0 + 8.0 * math.sin((epoch % 86400) / 86400.0 * 2 * math.pi) + sv * 0.5
            delta = 0.25 * math.cos(epoch * 0.01 + sv)
            rows.append({
                "station": station,
                "system": system,
                "sv": sv,
                "signal_pair": "L1/L2",
                "epoch_utc": ts.strftime("%Y-%m-%d %H:%M:%S"),
                "gps_week": 2442,
                "gps_tow_s": float(epoch),
                "sTEC_TECU": vtec + 0.5,
                "vTEC_TECU": vtec,
                "deltaT_TECU": delta,
                "level_offset_TECU": 0.1,
                "arc_id": 1,
                "quality_flag": 0,
                "elev_deg": float(10 + (sv * 7) % 80),
                "azim_deg": float((sv * 31) % 360),
                "ipp_lat_deg": 30.0 + sv * 0.1,
                "ipp_lon_deg": 114.0 + sv * 0.1,
            })
    return rows


def synthetic_agg_hour_rows(obs_rows: Sequence[dict]) -> list[dict]:
    """由 `obs` 聚合出 `agg_hour`：station/date/hour/system。

    **必须从 obs 算出来**，不能另造一份 —— SQL-17 是「聚合表对账」，
    两边如果各造一份，对账就永远成立，那条查询就失去了意义。

    分块建表时用 :func:`agg_hour_accumulator` 逐块喂，结果与一次喂全表相同。
    """
    return agg_hour_accumulator()(obs_rows)


def agg_hour_accumulator():
    """返回一个可增量喂的 `agg_hour` 累加器（``acc(rows) -> list[dict]``）。

    **为什么需要增量**：1 亿行不可能整表读进内存算聚合（约 71 GB）。
    但 `agg_hour` 的键是 ``(station, date, hour, system)``，每个键只在自己的
    块里出现（obs 按小时分区、块按历元切），所以逐块累加与整表一次算**等价**。
    这里把中间状态留在闭包里，每次 call 只吐「本次受影响的那些键」的最终行。
    """
    bucket: dict[tuple, dict[str, Any]] = {}
    cn0_by_key: dict[tuple, list[float]] = {}
    slip_by_key: dict[tuple, int] = {}

    def _row(key: tuple) -> dict:
        station, date, hour, system = key
        acc = bucket[key]
        values = cn0_by_key.get(key, [])
        if values:
            ordered = sorted(values)
            mean = sum(ordered) / len(ordered)
            p50 = percentile(ordered, 0.50)
            p95 = percentile(ordered, 0.95)
        else:
            mean = p50 = p95 = None
        return {
            "station": station,
            "date": date,
            # `hour` **必须是整数**：它是分区键 `hour=00` 的数值形式。
            # 早先这里用 `ts.hour` 却是从字符串拼出来的分区键 `'00'`，
            # 落盘成 string，CH 侧读成 Int32，两引擎 `hour` 类型不一致
            # （DuckDB `'18'` vs CH `18`）。分区键在 writer 里本来就是 int。
            "hour": int(hour),
            "system": system,
            "n_obs": acc["n_obs"],
            "n_epochs": len(acc["epochs"]),
            "n_sv": len(acc["svs"]),
            "mean_cn0": mean,
            "p50_cn0": p50,
            "p95_cn0": p95,
            "missing_rate": ((acc["n_obs"] - len(values)) / acc["n_obs"]
                             if acc["n_obs"] else 0.0),
            "slip_epochs": slip_by_key.get(key, 0),
            "qc_reject_rate": 0.0,
        }

    def accumulate(rows: Sequence[dict]) -> list[dict]:
        touched: set[tuple] = set()
        for row in rows:
            ts = datetime.strptime(row["epoch_utc"], "%Y-%m-%d %H:%M:%S")
            key = (row["station"], ts.strftime("%Y-%m-%d"), ts.hour,
                   row["system"])
            touched.add(key)
            acc = bucket.setdefault(key, {"n_obs": 0, "epochs": set(), "svs": set()})
            acc["n_obs"] += 1
            acc["epochs"].add(row["epoch_utc"])
            acc["svs"].add(row["sv"])
            cn0 = row["cn0_dbhz"]
            if cn0 is not None:
                cn0_by_key.setdefault(key, []).append(cn0)
            if (row["quality_flag"] & 4) != 0:
                slip_by_key[key] = slip_by_key.get(key, 0) + 1
        return [_row(k) for k in sorted(touched)]

    def finish() -> list[dict]:
        """把**当前全部键**结算成行（分块建表末尾用它一次写盘）。"""
        return [_row(k) for k in sorted(bucket)]

    accumulate.finish = finish
    accumulate.keys = lambda: sorted(bucket)
    return accumulate


def percentile(ordered: Sequence[float], fraction: float) -> float:
    """线性插值分位数（与 DuckDB `quantile_cont` 同口径）。"""
    if not ordered:
        return float("nan")
    if len(ordered) == 1:
        return float(ordered[0])
    pos = fraction * (len(ordered) - 1)
    low = int(math.floor(pos))
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return float(ordered[low]) * (1 - frac) + float(ordered[high]) * frac


def synthetic_agg_daily_rows(obs_rows: Sequence[dict],
                             tec_rows: Sequence[dict]) -> list[dict]:
    """由 obs 与 tec 聚合出 `agg_daily`。

    分块建表时用 :func:`agg_daily_accumulator` 逐块喂，结果与一次喂全表相同。
    """
    acc = agg_daily_accumulator()
    acc(obs_rows, tec_rows)
    return acc.finish()


def agg_daily_accumulator():
    """返回可增量喂的 `agg_daily` 累加器（``acc(obs, tec) -> None``）。

    `agg_daily` 的键是台站（单日），分块的每一块都落在同一台上，
    所以逐块累加与整表一次算等价；中间状态只存「排序所需的原始值」，
    量级是 O(行数)，但**不保留整行 dict**（只留 cn0/vtec 的浮点与计数），
    比分块模式保留整表小一个数量级。
    """
    state: dict[str, dict[str, Any]] = {
        station: {"obs": 0, "epochs": set(), "svs": set(), "cn0": [],
                  "slip": 0, "vtec": []}
        for station in BENCH_STATIONS
    }

    def accumulate(obs_rows: Sequence[dict], tec_rows: Sequence[dict]) -> None:
        for row in obs_rows:
            st = state.setdefault(row["station"], {
                "obs": 0, "epochs": set(), "svs": set(), "cn0": [],
                "slip": 0, "vtec": []})
            st["obs"] += 1
            st["epochs"].add(row["epoch_utc"])
            st["svs"].add(row["sv"])
            cn0 = row["cn0_dbhz"]
            if cn0 is not None:
                st["cn0"].append(cn0)
            if (row["quality_flag"] & 4) != 0:
                st["slip"] += 1
        for row in tec_rows:
            st = state.setdefault(row["station"], {
                "obs": 0, "epochs": set(), "svs": set(), "cn0": [],
                "slip": 0, "vtec": []})
            vtec = row["vTEC_TECU"]
            if vtec is not None:
                st["vtec"].append(vtec)

    def finish() -> list[dict]:
        out: list[dict] = []
        for station in BENCH_STATIONS:
            st = state[station]
            cn0 = sorted(st["cn0"])
            vtec = sorted(st["vtec"])
            n_obs = st["obs"]
            out.append({
                "station": station,
                "date": BENCH_DATE,
                "n_obs": n_obs,
                "n_epochs": len(st["epochs"]),
                "n_sv": len(st["svs"]),
                "mean_cn0": sum(cn0) / len(cn0) if cn0 else None,
                "p95_cn0": percentile(cn0, 0.95) if cn0 else None,
                "missing_rate": ((n_obs - len(cn0)) / n_obs) if n_obs else 0.0,
                "slip_epochs": st["slip"],
                "tec_mean": sum(vtec) / len(vtec) if vtec else None,
                "tec_p95": percentile(vtec, 0.95) if vtec else None,
                "coverage_s": len(st["epochs"]),
            })
        return out

    accumulate.finish = finish
    return accumulate


# ---------------------------------------------------------------- 20 条
@dataclass(frozen=True)
class BenchSql:
    """一条基准。`sql` 是 DuckDB 兼容子集，CH 由 `dialects` 翻译。"""

    ident: str
    title: str
    sql: str
    table: str = "obs"
    #: 结果按这些列排序后比对（SQL 里没写 ORDER BY 的也要能稳定比）
    order_by: tuple[str, ...] = ()
    #: 需要 `fault_v1` / `bench_week_v1` 这类辅助集的，写数据集名
    dataset: str = "bench_v1"
    #: 已知的两引擎差异（**记下来，不改结果造假**）
    known_diff: str = ""

    def for_clickhouse(self) -> str:
        return dialects.to_clickhouse(self.sql)


BENCH_SQL: tuple[BenchSql, ...] = (
    BenchSql(
        "SQL-01", "单站单日行数与历元数",
        """SELECT station,
       COUNT(*)                          AS n_rows,
       COUNT(DISTINCT epoch_utc)         AS epochs
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY station""",
        order_by=("station",),
    ),
    BenchSql(
        "SQL-02", "按系统行数与卫星数",
        """SELECT system,
       COUNT(*)                    AS n_rows,
       COUNT(DISTINCT sv)          AS svs
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY system
ORDER BY system""",
        order_by=("system",),
    ),
    BenchSql(
        "SQL-03", "每小时行数（分区裁剪）",
        """SELECT EXTRACT(hour FROM epoch_utc) AS hour,
       COUNT(*)                      AS n_rows
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY EXTRACT(hour FROM epoch_utc)
ORDER BY hour""",
        order_by=("hour",),
    ),
    BenchSql(
        "SQL-04", "CN0 分位数",
        """SELECT COUNT(cn0_dbhz)                        AS n,
       quantile_cont(cn0_dbhz, 0.50)            AS p50,
       quantile_cont(cn0_dbhz, 0.95)            AS p95,
       quantile_cont(cn0_dbhz, 0.99)            AS p99
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'""",
        known_diff="CH 的 quantile 用 reservoir 采样时会有微小差异；"
                   "本基准数据量小，走精确路径，实测一致",
    ),
    BenchSql(
        "SQL-05", "按卫星均值与缺测率",
        """SELECT system, sv,
       COUNT(*)                                        AS n_rows,
       AVG(cn0_dbhz)                                   AS mean_cn0,
       COUNT(*) FILTER (WHERE cn0_dbhz IS NULL) * 1.0
         / COUNT(*)                                    AS missing_rate
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY system, sv
ORDER BY system, sv""",
        order_by=("system", "sv"),
    ),
    BenchSql(
        "SQL-06", "质量旗标分布",
        """SELECT quality_flag, COUNT(*) AS n_rows
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY quality_flag
ORDER BY quality_flag""",
        order_by=("quality_flag",),
    ),
    BenchSql(
        "SQL-07", "仰角分箱",
        """SELECT CAST(FLOOR(elev_deg / 10) * 10 AS INTEGER) AS elev_bin,
       COUNT(*)                                    AS n_rows,
       AVG(cn0_dbhz)                               AS mean_cn0
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY CAST(FLOOR(elev_deg / 10) * 10 AS INTEGER)
ORDER BY elev_bin""",
        order_by=("elev_bin",),
    ),
    BenchSql(
        "SQL-08", "周跳密度",
        """SELECT EXTRACT(hour FROM epoch_utc)                          AS hour,
       COUNT(*)                                           AS n_rows,
       COUNT(*) FILTER (WHERE (quality_flag & 4) <> 0)     AS slip_rows,
       COUNT(*) FILTER (WHERE (quality_flag & 4) <> 0) * 1.0
         / COUNT(*)                                       AS slip_rate
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY EXTRACT(hour FROM epoch_utc)
ORDER BY slip_rate DESC, hour
LIMIT 5""",
        order_by=("hour",),
    ),
    BenchSql(
        "SQL-09", "TEC 每小时统计",
        """SELECT EXTRACT(hour FROM epoch_utc) AS hour,
       COUNT(*)          AS n_rows,
       AVG(vTEC_TECU)    AS mean_vtec,
       MAX(vTEC_TECU)    AS max_vtec,
       MIN(vTEC_TECU)    AS min_vtec
FROM tec
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY EXTRACT(hour FROM epoch_utc)
ORDER BY hour""",
        table="tec",
        order_by=("hour",),
    ),
    BenchSql(
        "SQL-10", "TEC TopN 卫星",
        """SELECT sv, AVG(vTEC_TECU) AS mean_vtec, MAX(vTEC_TECU) AS max_vtec
FROM tec
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY sv
ORDER BY mean_vtec DESC
LIMIT 5""",
        table="tec",
        order_by=("mean_vtec", "sv"),
    ),
    BenchSql(
        "SQL-11", "TEC 梯度超限计数",
        """SELECT COUNT(*)                                          AS n,
       COUNT(*) FILTER (WHERE ABS(deltaT_TECU) > 0.5)       AS n_exceed,
       quantile_cont(ABS(deltaT_TECU), 0.95)                AS p95_abs_delta
FROM tec
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'""",
        table="tec",
    ),
    BenchSql(
        "SQL-12", "两站同日对比",
        """SELECT station,
       COUNT(*)               AS n_rows,
       AVG(cn0_dbhz)          AS mean_cn0,
       COUNT(*) FILTER (WHERE cn0_dbhz IS NULL) * 1.0 / COUNT(*) AS missing_rate
FROM obs
WHERE CAST(epoch_utc AS DATE) = DATE '2026-10-01' AND station IN ('WUHN','BJFS')
GROUP BY station
ORDER BY station""",
        order_by=("station",),
    ),
    BenchSql(
        "SQL-13", "断档检测",
        """WITH epochs AS (
  SELECT epoch_utc,
         LAG(epoch_utc) OVER (ORDER BY epoch_utc) AS prev_utc
  FROM obs
  WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
  GROUP BY epoch_utc
)
SELECT prev_utc, epoch_utc,
       date_diff('second', prev_utc, epoch_utc) AS gap_s
FROM epochs
WHERE prev_utc IS NOT NULL
  AND date_diff('second', prev_utc, epoch_utc) > 1
ORDER BY epoch_utc""",
        dataset="fault_v1",
        order_by=("epoch_utc",),
        known_diff="CH 的窗口默认只看当前块；本基准单日单分区，"
                   "跨分区要 lagInFrame + ROWS BETWEEN",
    ),
    BenchSql(
        "SQL-14", "每小时卫星数",
        """SELECT EXTRACT(hour FROM epoch_utc) AS hour,
       COUNT(DISTINCT sv)        AS n_sv,
       COUNT(DISTINCT system)    AS n_system
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY EXTRACT(hour FROM epoch_utc)
ORDER BY hour""",
        order_by=("hour",),
    ),
    BenchSql(
        "SQL-15", "按信号伪距统计",
        """SELECT signal,
       COUNT(*)             AS n_rows,
       AVG(psr_m)           AS mean_psr,
       STDDEV_SAMP(psr_m)   AS sd_psr
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
GROUP BY signal
ORDER BY signal""",
        order_by=("signal",),
    ),
    BenchSql(
        "SQL-16", "覆盖时长",
        """SELECT MIN(epoch_utc) AS first_utc,
       MAX(epoch_utc) AS last_utc,
       COUNT(DISTINCT epoch_utc) AS epochs,
       date_diff('second', MIN(epoch_utc), MAX(epoch_utc)) AS coverage_s
FROM obs
WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'""",
        known_diff="CH 的 DateTime 时区在服务端；会话必须设 timezone='UTC'，"
                   "否则 MIN/MAX 偏 8 小时",
    ),
    BenchSql(
        "SQL-17", "聚合表对账",
        """WITH hourly AS (
  SELECT station, CAST(epoch_utc AS DATE) AS day,
         EXTRACT(hour FROM epoch_utc) AS hour, system, COUNT(*) AS n_obs
  FROM obs
  WHERE station = 'WUHN' AND CAST(epoch_utc AS DATE) = DATE '2026-10-01'
  GROUP BY station, CAST(epoch_utc AS DATE), EXTRACT(hour FROM epoch_utc), system
)
SELECT h.hour AS hour, h.system AS system, h.n_obs AS n_obs, a.n_obs AS agg_n_obs,
       COALESCE(h.n_obs, -1) - COALESCE(a.n_obs, -1) AS diff
FROM hourly h
FULL OUTER JOIN agg_hour a
  ON a.station = h.station AND a.date = h.day
 AND a.hour = h.hour AND a.system = h.system
ORDER BY h.hour, h.system""",
        order_by=("hour", "system"),
        known_diff="CH 的 FULL JOIN 要 SET join_use_nulls = 1，"
                   "否则缺失侧给默认值 0 而不是 NULL",
    ),
    BenchSql(
        "SQL-18", "七日趋势",
        """SELECT date, station, n_obs, mean_cn0, missing_rate
FROM agg_daily
WHERE station IN ('WUHN','BJFS')
  AND CAST(date AS DATE) BETWEEN DATE '2026-09-25' AND DATE '2026-10-01'
ORDER BY date, station""",
        table="agg_daily",
        dataset="bench_week_v1",
        order_by=("date", "station"),
        known_diff="`date` 落盘类型取决于数据量：全规模时 pyarrow 推成 DATE，"
                   "小样本时是 VARCHAR。显式 `CAST(date AS DATE)` 让两种情形都成立 ——"
                   "契约原文直接 `BETWEEN DATE '…'`，在 VARCHAR 上 DuckDB 会报"
                   "「Cannot mix values of type VARCHAR and DATE」",
    ),
    BenchSql(
        "SQL-19", "分区清单与行数",
        """SELECT station,
       CAST(epoch_utc AS DATE) AS day,
       EXTRACT(hour FROM epoch_utc) AS hour,
       COUNT(*) AS n_rows
FROM obs
GROUP BY station, CAST(epoch_utc AS DATE), EXTRACT(hour FROM epoch_utc)
ORDER BY station, hour""",
        order_by=("station", "hour"),
        known_diff="契约里这条用 filename/hive 分区；这里改成按实际分区列分组 ——"
                   "两引擎都能跑，且结果形状与契约一致（48 行 × 4 列）。"
                   "真正的 filename 写法只在 DuckDB 侧成立，CH 的 file() 路径不同",
    ),
    BenchSql(
        "SQL-20", "异常小时 TopN",
        """SELECT station, hour, n_obs, missing_rate, slip_epochs,
       ROUND(missing_rate * 100, 2) AS missing_pct
FROM agg_hour
WHERE CAST(date AS DATE) = DATE '2026-10-01'
ORDER BY missing_rate DESC NULLS LAST, slip_epochs DESC, station, hour, n_obs
LIMIT 10""",
        table="agg_hour",
        order_by=("station", "hour", "n_obs"),
        known_diff="两处：① DuckDB 的 DESC 默认 NULLS FIRST、CH 默认 NULLS LAST；"
                   "本 SQL 显式写 NULLS LAST 消掉。"
                   "② 契约原文的排序键有并列 —— 同一 (station, hour) 的三个系统"
                   "`missing_rate` / `slip_epochs` 完全相同，`LIMIT 10` 在两引擎里"
                   "各取各的行（实测左侧取 BJFS/0/64800、右侧取 BJFS/0/86400）。"
                   "这里补 `n_obs` 作决胜列：**不改变哪些行算异常小时**，"
                   "只让并列时的取舍确定。契约 §3「TopN 必须两边一致」要求这样，"
                   "不补就只能得到一个随机结果",
    ),
)


# ---------------------------------------------------------------- 比对
@dataclass
class Diff:
    """一处不一致。**记下来，不改结果造假。**"""

    ident: str
    kind: str          # 'columns' / 'rowcount' / 'value' / 'error'
    detail: str

    def __str__(self) -> str:
        return f"{self.ident} [{self.kind}] {self.detail}"


def _close(a: Any, b: Any) -> bool:
    """相对误差 1e-9 的相等判定。

    整数按精确比（`COUNT(*)` 差 1 就是错，不是「容差内」）；
    浮点按 `|a-b| <= max(ABS_TOL, REL_TOL * max(|a|,|b|))`；
    时间戳**按时刻比**（`2026-10-01T00:00:00+00:00` 与
    `2026-10-01T00:00:00` 是同一个时刻，只是一个带时区后缀 ——
    两个引擎的序列化习惯不同，不该算成不一致）。
    """
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) == bool(b)

    # 时间戳：先尝试解析，能解析就比时刻
    ta, tb = _parse_instant(a), _parse_instant(b)
    if ta is not None and tb is not None:
        return ta == tb

    if isinstance(a, int) and isinstance(b, int):
        return a == b
    try:
        fa, fb = float(a), float(b)
    except (TypeError, ValueError):
        return str(a) == str(b)
    if math.isnan(fa) and math.isnan(fb):
        return True
    if not (math.isfinite(fa) and math.isfinite(fb)):
        return fa == fb
    scale = max(abs(fa), abs(fb))
    return abs(fa - fb) <= max(ABS_TOL, REL_TOL * scale)


def _parse_instant(value: Any) -> datetime | None:
    """把一个值尽量解析成「带时区的时刻」。解析不了返回 None。

    认三种形态：`datetime` 对象、`YYYY-MM-DDTHH:MM:SS[.ffffff][±HH:MM|Z]`、
    以及只有日期的 `YYYY-MM-DD`。**无时区后缀按 UTC 解释** ——
    契约 §3 写明基准统一按 UTC 存。
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text or len(text) < 10:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=(
                datetime.strptime(text, fmt).tzinfo or timezone.utc))
        except ValueError:
            continue
    return None


def compare_results(case: BenchSql, left: Sequence[dict],
                    right: Sequence[dict],
                    left_cols: Sequence[str],
                    right_cols: Sequence[str]) -> list[Diff]:
    """逐**列**比较，不只是行数。

    列名集合、行数、每行每值 —— 三层都要过。

    **比前先排序**：SQL 里的 `ORDER BY` 只排到它写的那几列，
    并列的行（尤其是 `FULL OUTER JOIN` 出来的 NULL 组）在两个引擎里
    内部顺序不同。不排序的话，「同一批数据、不同行序」会被误报成
    「21 处值不一致」——实测 SQL-17 就是这么炸的。
    排序键用**全部列**，保证确定性。
    """
    diffs: list[Diff] = []
    if tuple(left_cols) != tuple(right_cols):
        diffs.append(Diff(case.ident, "columns",
                          f"左侧列 {tuple(left_cols)} != 右侧列 {tuple(right_cols)}"))
        # 列都不同就没法逐值比，直接返回
        return diffs
    if len(left) != len(right):
        diffs.append(Diff(case.ident, "rowcount",
                          f"左侧 {len(left)} 行 != 右侧 {len(right)} 行"))

    cols = list(left_cols)
    left_sorted = _sorted_rows(left, cols)
    right_sorted = _sorted_rows(right, cols)

    for index, (row_l, row_r) in enumerate(zip(left_sorted, right_sorted)):
        for col in cols:
            a, b = row_l.get(col), row_r.get(col)
            if not _close(a, b):
                diffs.append(Diff(
                    case.ident, "value",
                    f"第 {index} 行 {col}: 左={a!r} 右={b!r}"))
                if len(diffs) > 20:            # 别把整张表都打出来
                    return diffs
    return diffs


def _sort_key(row: dict, cols: Sequence[str]) -> tuple:
    """稳定的全列排序键。`None` 统一排在最前，避免两引擎的 NULL 位置差异。"""
    key = []
    for col in cols:
        value = row.get(col)
        if value is None:
            key.append((0, "", ""))
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            key.append((1, "", float(value)))
        else:
            key.append((2, str(value), ""))
    return tuple(key)


def _sorted_rows(rows: Sequence[dict], cols: Sequence[str]) -> list[dict]:
    return sorted(rows, key=lambda row: _sort_key(row, cols))


# ---------------------------------------------------------------- 造数据
WRITE_STATEMENTS = (
    "INSERT INTO obs (station) VALUES ('X')",
    "UPDATE obs SET station = 'Y' WHERE station = 'WUHN'",
    "DELETE FROM obs WHERE station = 'WUHN'",
    "CREATE TABLE t (a INTEGER)",
    "DROP TABLE obs",
    "ALTER TABLE obs ADD COLUMN z INTEGER",
    "TRUNCATE TABLE obs",
    "COPY obs TO '/tmp/x.csv' (FORMAT CSV)",
)


@dataclass
class BenchEnv:
    """一次基准运行的全部产物与路径。"""

    root: Path
    obs_dir: Path
    tec_dir: Path
    agg_hour_dir: Path
    agg_daily_dir: Path
    rows: dict[str, int] = field(default_factory=dict)


def build_dataset(root: Path, *, epochs: int = EPOCHS_PER_DAY,
                  quiet: bool = False,
                  chunk_epochs: int | None = None) -> BenchEnv:
    """造 `bench_v1`。**必须复用 `writer.py`**，不绕过「Parquet 是唯一真相」。

    ``chunk_epochs`` 给出时按块生成并逐块落盘：内存占用与**块大小**成正比，
    与总量无关。亿级压测靠它（1 亿行整表驻留需约 71 GB，本机 63 GB 内存装不下）。
    不给则沿用整表单次写入——小规模时更快，且与分块路径产出**逐字节相同**
    （`tests/test_bench_streaming.py` 钉死）。
    """
    if chunk_epochs is not None:
        if isinstance(chunk_epochs, bool) or not isinstance(chunk_epochs, int):
            raise ValueError(f"chunk_epochs 必须是正整数，收到 {chunk_epochs!r}")
        if chunk_epochs <= 0:
            raise ValueError(f"chunk_epochs 必须是正整数，收到 {chunk_epochs!r}")
    root.mkdir(parents=True, exist_ok=True)
    obs_dir = root / "obs"
    tec_dir = root / "tec"
    agg_hour_dir = root / "agg_hour"
    agg_daily_dir = root / "agg_daily"
    for directory in (obs_dir, tec_dir, agg_hour_dir, agg_daily_dir):
        directory.mkdir(parents=True, exist_ok=True)

    obs_rows: list[dict] = []
    tec_rows: list[dict] = []
    n_obs = 0
    n_tec = 0

    def _write(rows: list[dict], directory: Path) -> None:
        """**批量写**，不是逐行 `write_one`。

        `write_one` 每行都会重写该分区文件与 `_manifest.json`；几千行时会：
        慢到不可用，且在 Windows 上因 `os.replace` 撞上文件占用直接
        `PermissionError: [WinError 5]`。

        `write(rows)` 内部先按 (station/date/hour) 分组，每个分区只写一次，
        末尾只存一次清单 —— 这才是这个写入器设计的用法。
        """
        if not rows:
            return
        writer = NdjsonWriter(directory, parquet=True)
        writer.write(rows)

    if chunk_epochs is None:
        for station in BENCH_STATIONS:
            obs_rows.extend(synthetic_obs_rows(station, epochs=epochs))
            tec_rows.extend(synthetic_tec_rows(station, epochs=epochs))
        n_obs, n_tec = len(obs_rows), len(tec_rows)
        _write(obs_rows, obs_dir)
        _write(tec_rows, tec_dir)
        agg_hour_rows = synthetic_agg_hour_rows(obs_rows)
        agg_daily_rows = synthetic_agg_daily_rows(obs_rows, tec_rows)
    else:
        # 分块：每站每块写完就丢，内存里最多只有「一站 × 一块」的行。
        # **不能**在循环外累积 obs_rows —— 那等于没分块。
        hour_acc = agg_hour_accumulator()
        daily_acc = agg_daily_accumulator()
        # 块必须按整小时对齐：分区键是 (station, date, hour)，写入是整分区
        # 覆盖而非追加。块跨小时会让同一分区被写多次、后写覆盖前写。
        step = _hour_aligned_chunk(chunk_epochs)
        for station in BENCH_STATIONS:
            for start in range(0, epochs, step):
                span = min(step, epochs - start)
                block_obs = list(iter_obs_rows(station, epochs=span,
                                               start_epoch=start))
                block_tec = synthetic_tec_rows(station, epochs=span,
                                               start_epoch=start)
                n_obs += len(block_obs)
                n_tec += len(block_tec)
                _write(block_obs, obs_dir)
                _write(block_tec, tec_dir)
                hour_acc(block_obs)
                daily_acc(block_obs, block_tec)
                del block_obs, block_tec
        agg_hour_rows = hour_acc.finish()
        agg_daily_rows = daily_acc.finish()

    # 聚合表必须看到**全量** obs/tec。分块模式下已由累加器增量算完，
    # 不把全表读回内存（1 亿行约 71 GB，本机装不下）。

    def _write_agg(rows: list[dict], directory: Path) -> None:
        """聚合表没有 `epoch_utc`，但分区器要一个时间。

        做法：写盘前**临时**补一个 `epoch_utc` = 该小时的起点。
        **不伪造时间语义**：`agg_hour` 的 `hour` 列本来就是「哪一小时」，
        这个 `epoch_utc` 由它换算而来，不是另造一个概念。
        """
        if not rows:
            return
        stamped: list[dict] = []
        for row in rows:
            item = dict(row)
            day = datetime.strptime(str(row.get("date")), "%Y-%m-%d")
            hour = int(row.get("hour", 0) or 0)
            item["epoch_utc"] = (day + timedelta(hours=hour)).strftime(
                "%Y-%m-%d %H:%M:%S")
            stamped.append(item)
        writer = NdjsonWriter(directory, parquet=True)
        writer.write(stamped)

    _write_agg(agg_hour_rows, agg_hour_dir)
    _write_agg(agg_daily_rows, agg_daily_dir)

    return BenchEnv(
        root=root, obs_dir=obs_dir, tec_dir=tec_dir,
        agg_hour_dir=agg_hour_dir, agg_daily_dir=agg_daily_dir,
        rows={"obs": n_obs, "tec": n_tec,
              "agg_hour": len(agg_hour_rows),
              "agg_daily": len(agg_daily_rows)},
    )


# ---------------------------------------------------------------- 两引擎
def _dir_for(env: BenchEnv, table: str) -> Path:
    return {
        "obs": env.obs_dir, "tec": env.tec_dir,
        "agg_hour": env.agg_hour_dir, "agg_daily": env.agg_daily_dir,
    }[table]


def _duckdb_for(env: BenchEnv, table: str) -> DuckDBEngine:
    """DuckDB 用**数据根目录**建引擎，不是单表目录。

    SQL-17 是 `obs` 与 `agg_hour` 的对账，一条 SQL 里出现两个视图。
    只给单表目录的话，另一个视图会「表不存在」。
    引擎自己会把根目录下的每个子目录都注册成一个视图。
    """
    return DuckDBEngine(env.root)


def _clickhouse_for(env: BenchEnv, table: str) -> ClickHouseEngine:
    """ClickHouse 用**单表目录**：它按需把该目录的 Parquet 灌成一张表。

    多表 join 时 `_table_source()` 会分别把 `obs` / `agg_hour` 都灌好。
    """
    return ClickHouseEngine(env.root)


def check_readonly_both(env: BenchEnv) -> list[str]:
    """写语句走两个后端都要被拒，且错误码是 `E_READONLY`。

    返回问题清单（空 = 全拒对了）。
    """
    problems: list[str] = []
    engines = [
        ("duckdb", DuckDBEngine(env.obs_dir)),
        ("clickhouse", ClickHouseEngine(env.obs_dir)),
    ]
    for name, engine in engines:
        for sql in WRITE_STATEMENTS:
            try:
                engine.execute(sql)
            except ReadOnlyEngineError as exc:
                if "E_READONLY" not in str(exc):
                    problems.append(
                        f"{name} 拒绝了 {sql!r}，但错误码里没有 E_READONLY：{exc}")
            except EngineUnavailable as exc:
                problems.append(f"{name} 不可用，无法验证只读闸门：{exc}")
            except EngineError as exc:
                problems.append(
                    f"{name} 对 {sql!r} 抛的是普通 EngineError 而非只读错误：{exc}")
            else:
                problems.append(f"{name} **接受了**写语句 {sql!r}（这是严重问题）")
    return problems


def check_fallback(env: BenchEnv) -> str:
    """故意弄坏引擎 -> 回落且明示（`note` 里写 `engine=builtin`）。"""
    engine = DuckDBEngine(env.obs_dir, module_name="duckdb_does_not_exist")
    try:
        engine.execute("SELECT 1 AS one")
    except EngineUnavailable as exc:
        return f"回落可判定：duckdb 坏掉时抛 EngineUnavailable（{exc}）"
    except EngineError as exc:
        return f"回落可判定：duckdb 坏掉时抛 EngineError（{exc}）"
    return "**问题**：duckdb 坏掉时没有报错，说明回落判定失效"


# ---------------------------------------------------------------- 主流程
@dataclass
class CaseOutcome:
    case: BenchSql
    duckdb_rows: int = 0
    clickhouse_rows: int = 0
    duckdb_ms: float = 0.0
    clickhouse_ms: float = 0.0
    diffs: list[Diff] = field(default_factory=list)
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.diffs and not self.error


def run_all(env: BenchEnv, *, quiet: bool = False) -> list[CaseOutcome]:
    outcomes: list[CaseOutcome] = []
    for case in BENCH_SQL:
        outcome = CaseOutcome(case=case)
        duck = _duckdb_for(env, case.table)
        ch = _clickhouse_for(env, case.table)
        try:
            t0 = time.perf_counter()
            left = duck.execute(dialects.to_duckdb(case.sql))
            outcome.duckdb_ms = (time.perf_counter() - t0) * 1000
            outcome.duckdb_rows = len(left.rows)
        except (EngineUnavailable, EngineError) as exc:
            outcome.error = f"duckdb: {exc}"
            outcomes.append(outcome)
            continue

        try:
            t0 = time.perf_counter()
            right = ch.execute(case.for_clickhouse())
            outcome.clickhouse_ms = (time.perf_counter() - t0) * 1000
            outcome.clickhouse_rows = len(right.rows)
        except (EngineUnavailable, EngineError) as exc:
            # CH 不可用不算「两引擎一致」—— 记成错误，不许静默降级成
            # 「只有 duckdb 跑通了所以通过」。
            outcome.error = f"clickhouse: {exc}"
            outcomes.append(outcome)
            continue

        outcome.diffs = compare_results(
            case, left.rows, right.rows, left.columns, right.columns)
        outcomes.append(outcome)
        if not quiet:
            mark = "OK  " if outcome.ok else "DIFF"
            print(f"  {mark} {case.ident} {case.title} "
                  f"(duckdb {outcome.duckdb_rows} 行 / ch {outcome.clickhouse_rows} 行)")
            for diff in outcome.diffs[:5]:
                print(f"        {diff.kind}: {diff.detail}")
    return outcomes


def _scale_section() -> str:
    """「亿级压测」一节。数据来自 ``SCALE_RESULT_PATH`` 的 JSON，不手写。

    ## 为什么单独一节

    上面那张表是**默认规模**（2 站 × 86,400 历元 ≈ 246 万行 `obs`）。
    EV-30 要的是「1 亿行压测 + p95」，那是另一组数字，混进同一张表会让人
    分不清「哪一行的 ms 是 246 万行测的还是 1 亿行测的」。

    ## 为什么先预热再计时

    首次跑 ClickHouse 会把 488 个 Parquet 分区灌成 MergeTree 表：实测 SQL-01
    首跑 **640 秒**，第 2 跑起 60 ms 级。把灌表时间算进 p95，等于把「导入快慢」
    和「查询快慢」混成一个数——那不是这条基准要回答的问题。
    """
    path = SCALE_RESULT_PATH
    if not path.is_file():
        return "\n".join([
            "## 亿级压测（未跑）",
            "",
            "本机还没有 `logs/bench_scale_1e8.json`。跑法：",
            "",
            "```powershell",
            "$env:PYTHONPATH=\"src\"",
            "python tools/bench_run.py --target-rows 100000000 --chunk-epochs 7200 \\",
            "    --workdir <目录> --scale-out logs/bench_scale_1e8.json",
            "```",
            "",
            "**这里不填任何数字** —— 没跑就是没跑。",
        ])
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("rows") or []
    lines: list[str] = []
    add = lines.append
    add("## 亿级压测")
    add("")
    add("| 项 | 值 |")
    add("|---|---|")
    add(f"| `obs` 行数 | {int(data.get('scale_obs_rows', 0)):,} |")
    add(f"| 分块历元数 | {int(data.get('chunk_epochs', 0)):,}"
        "（必须整小时对齐，见下） |")
    add(f"| 每查询重复 | {int(data.get('repeats', 0))} 次取 p50/p95 |")
    add(f"| 预热 | {'是（灌表不计入）' if data.get('warmed_up') else '否'} |")
    host = data.get("host") or {}
    if host:
        add(f"| 本机 | 内存 {host.get('memory_gb')} GB，"
            f"ClickHouse {host.get('clickhouse')} |")
    add("")
    add("| 编号 | 主题 | DuckDB p50 | DuckDB p95 | CH p50 | CH p95 | 差异 |")
    add("|---|---|---|---|---|---|---|")
    for row in rows:
        add(f"| {row['ident']} | {row['title']} | "
            f"{row['duckdb_p50_ms']:.0f} ms | {row['duckdb_p95_ms']:.0f} ms | "
            f"{row['ch_p50_ms']:.0f} ms | {row['ch_p95_ms']:.0f} ms | "
            f"{row['diffs']} |")
    add("")
    total = sum(int(r.get("diffs") or 0) for r in rows)
    add(f"**{len(rows)} 条查询、{int(data.get('scale_obs_rows', 0)):,} 行，"
        f"差异合计 {total}。**")
    add("")
    add("### 分块建表：为什么块必须整小时对齐")
    add("")
    add("`writer` 的分区键是 `(station, date, hour)`，写入是**整分区覆盖**"
        "（`os.replace` 换掉整个文件），不是追加。块若跨进同一个小时，"
        "后一块会把前一块在该小时的行整段覆盖掉——实测 600 历元按 137 切块时，"
        "那个小时分区从 34,200 行掉到 2,964 行。"
        "`--chunk-epochs` 会向上取整到 3600 的整数倍，每个分区恰好只写一次。")
    add("")
    add("### 1 亿行为什么必须分块")
    add("")
    add("实测单行 dict 占 **709 B**：1 亿行 `obs` 整表驻留要 **71 GB**，"
        "而本机物理内存 63.4 GB。分块后内存只与块大小成正比。"
        "这是 `--chunk-epochs` 存在的唯一理由，不是性能优化。")
    return "\n".join(lines)


def render_report(env: BenchEnv, outcomes: Sequence[CaseOutcome],
                  readonly_problems: Sequence[str],
                  fallback: str) -> str:
    """生成 `docs/operations/bench-results.md` 的内容。"""
    lines: list[str] = []
    add = lines.append
    add("# 双引擎基准结果（`SQL-01`…`SQL-20`）")
    add("")
    add("> 由 `python tools/bench_run.py --out docs/operations/bench-results.md` 生成。")
    add("> **不要手改本文件的数字**：改了就与代码脱节，回源校验会拦。")
    add("")
    add("## 数据集")
    add("")
    add("| 项 | 值 |")
    add("|---|---|")
    add(f"| 台站 | {' / '.join(BENCH_STATIONS)} |")
    add(f"| 日期 | {BENCH_DATE}（UTC，单日） |")
    add(f"| 采样 | 1 Hz，{EPOCHS_PER_DAY:,} 历元/站 |")
    add(f"| 星座/卫星 | GPS 8 + GLONASS 6 + Galileo 5 = 19 SV |")
    add(f"| 信号 | 每 SV {len(SIGNALS)} 路 |")
    add(f"| `obs` 行数 | {env.rows.get('obs', 0):,} |")
    add(f"| `tec` 行数 | {env.rows.get('tec', 0):,} |")
    add(f"| `agg_hour` 行数 | {env.rows.get('agg_hour', 0):,} |")
    add(f"| `agg_daily` 行数 | {env.rows.get('agg_daily', 0):,} |")
    add("")
    add("数据由 `tools/bench_run.py` 用 `writer.NdjsonWriter(parquet=True)` 写出，")
    add("**没有绕过「Parquet 是唯一真相」这条链**。`agg_hour` / `agg_daily` 是从 `obs` /")
    add("`tec` 真算出来的 —— 如果两边各造一份，SQL-17 的对账就永远成立、失去意义。")
    add("")
    add("## 结果")
    add("")
    add("| 编号 | 主题 | DuckDB 行 | ClickHouse 行 | DuckDB ms | CH ms | 判定 |")
    add("|---|---|---|---|---|---|---|")
    ok_count = 0
    for outcome in outcomes:
        case = outcome.case
        if outcome.ok:
            ok_count += 1
            verdict = "一致"
        elif outcome.error:
            verdict = "错误"
        else:
            verdict = f"差异 ×{len(outcome.diffs)}"
        add(f"| {case.ident} | {case.title} | {outcome.duckdb_rows} | "
            f"{outcome.clickhouse_rows} | {outcome.duckdb_ms:.1f} | "
            f"{outcome.clickhouse_ms:.1f} | {verdict} |")
    add("")
    add(f"**{ok_count}/{len(outcomes)} 条一致。** 判定口径：列名集合相同 + 行数相同 + "
        "每行每值相同（浮点相对误差 `1e-9`，整数精确）。")
    add("")
    add(_scale_section())
    add("")
    add("## 只读断言")
    add("")
    if readonly_problems:
        add("**有问题**：")
        add("")
        for problem in readonly_problems:
            add(f"- {problem}")
    else:
        add(f"`{len(WRITE_STATEMENTS)}` 条写语句（INSERT / UPDATE / DELETE / CREATE / DROP /")
        add("ALTER / TRUNCATE / COPY）**两个引擎全部拒绝**，错误码均为 `E_READONLY`。")
    add("")
    add("## 自动回落")
    add("")
    add(fallback)
    add("")
    add("## 已知差异（记下来，不改结果造假）")
    add("")
    noted = [c for c in BENCH_SQL if c.known_diff]
    if not noted:
        add("（无）")
    else:
        add("| 编号 | 差异 |")
        add("|---|---|")
        for case in noted:
            add(f"| {case.ident} | {case.known_diff} |")
    add("")
    mismatched = [o for o in outcomes if not o.ok]
    if mismatched:
        add("### 本次实测不一致的条目")
        add("")
        for outcome in mismatched:
            add(f"**{outcome.case.ident}**")
            add("")
            if outcome.error:
                add(f"- 错误：`{outcome.error}`")
            for diff in outcome.diffs[:10]:
                add(f"- {diff.kind}：{diff.detail}")
            add("")
    else:
        add("本次实测 **0 条不一致**。")
    add("")
    return "\n".join(lines) + "\n"


def load_dataset(root: Path) -> BenchEnv:
    """读**已建好**的数据集，不重建。行数从各表的 ``_manifest.json`` 累加。

    亿级压测重跑时用它：1 亿行重建要 2.6 小时纯写盘，而查询计时只需要数据在盘上。
    manifest 缺了就直接报错——宁可失败，不能拿 0 行当「数据在」。
    """
    root = Path(root)
    dirs = {name: root / name for name in ("obs", "tec", "agg_hour", "agg_daily")}
    rows: dict[str, int] = {}
    for name, directory in dirs.items():
        manifest = directory / "_manifest.json"
        if not manifest.is_file():
            raise FileNotFoundError(f"{directory} 下没有 _manifest.json")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        parts = data.get("partitions") or []
        rows[name] = sum(int(p.get("rows") or 0) for p in parts)
        if rows[name] <= 0:
            raise ValueError(f"{name} 的 manifest 里行数为 0，数据不完整")
    return BenchEnv(root=root, obs_dir=dirs["obs"], tec_dir=dirs["tec"],
                    agg_hour_dir=dirs["agg_hour"],
                    agg_daily_dir=dirs["agg_daily"], rows=rows)


def _percentile(values: Sequence[float], fraction: float) -> float:
    """线性插值分位数（与 ``quantile_cont`` 同口径）。"""
    ordered = sorted(values)
    if not ordered:
        return float("nan")
    if len(ordered) == 1:
        return float(ordered[0])
    pos = fraction * (len(ordered) - 1)
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return float(ordered[low]) * (1 - (pos - low)) + float(ordered[high]) * (pos - low)


def measure_scale(env: BenchEnv, *, cases: Sequence[str],
                  repeats: int = 7, quiet: bool = False) -> dict:
    """在已有数据集上测指定几条查询的 p50/p95。

    ## 为什么先预热

    首次跑 ClickHouse 要把 488 个 Parquet 分区灌成 MergeTree：实测 SQL-01
    首跑 **640 秒**，第 2 跑起 60 ms 级。把灌表时间算进 p95，等于把
    「导入快慢」和「查询快慢」混成一个数——那不是这条基准要回答的问题。
    """
    if repeats <= 0:
        raise ValueError(f"repeats 必须是正整数，收到 {repeats!r}")
    by_id = {c.ident: c for c in BENCH_SQL}
    unknown = [c for c in cases if c not in by_id]
    if unknown:
        raise ValueError(f"未知查询编号：{unknown}")

    if not quiet:
        print("预热（灌表/缓存，不计时）…")
    for ident in cases:
        case = by_id[ident]
        _duckdb_for(env, case.table).execute(dialects.to_duckdb(case.sql))
        _clickhouse_for(env, case.table).execute(case.for_clickhouse())

    out_rows: list[dict] = []
    for ident in cases:
        case = by_id[ident]
        if not quiet:
            print(f"=== {ident} {case.title} ===")
        timings = {"duckdb": [], "clickhouse": []}
        left = right = None
        for index in range(repeats):
            t0 = time.perf_counter()
            left = _duckdb_for(env, case.table).execute(
                dialects.to_duckdb(case.sql))
            timings["duckdb"].append((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            right = _clickhouse_for(env, case.table).execute(case.for_clickhouse())
            timings["clickhouse"].append((time.perf_counter() - t0) * 1000)
            if not quiet:
                print(f"  run{index + 1}: duckdb {timings['duckdb'][-1]:.0f}ms  "
                      f"ch {timings['clickhouse'][-1]:.0f}ms")
        diffs = compare_results(case, left.rows, right.rows,
                                left.columns, right.columns)
        out_rows.append({
            "ident": ident,
            "title": case.title,
            "duckdb_rows": len(left.rows),
            "ch_rows": len(right.rows),
            "duckdb_p50_ms": round(_percentile(timings["duckdb"], 0.50), 1),
            "duckdb_p95_ms": round(_percentile(timings["duckdb"], 0.95), 1),
            "ch_p50_ms": round(_percentile(timings["clickhouse"], 0.50), 1),
            "ch_p95_ms": round(_percentile(timings["clickhouse"], 0.95), 1),
            "diffs": len(diffs),
        })
        if not quiet:
            print(f"  -> 行数 {len(left.rows)}/{len(right.rows)}，差异 {len(diffs)}")

    return {
        "kind": "fieldstation.bench_scale",
        "note": ("亿级压测实测结果。先预热一次（ClickHouse 首次查询要把全部 "
                 "Parquet 分区灌成 MergeTree），预热与灌表时间不计入下面任何数字。"),
        "scale_obs_rows": int(env.rows.get("obs", 0)),
        "scale_tec_rows": int(env.rows.get("tec", 0)),
        "chunk_epochs": None,
        "repeats": repeats,
        "warmed_up": True,
        "rows": out_rows,
    }


def _run_scale(env: BenchEnv, args) -> int:
    """``--scale-out`` 的入口：测压测并把结果写成 JSON。"""
    cases = [c.strip() for c in str(args.scale_cases).split(",") if c.strip()]
    result = measure_scale(env, cases=cases, repeats=args.scale_repeats,
                           quiet=args.quiet)
    result["chunk_epochs"] = args.chunk_epochs
    out = Path(args.scale_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    bad = [r for r in result["rows"] if r["diffs"]]
    print(f"\n压测结果 -> {out}")
    print(f"{len(result['rows'])} 条查询，{result['scale_obs_rows']:,} 行，"
          f"差异合计 {sum(r['diffs'] for r in result['rows'])}")
    return 1 if bad else 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="20 条基准 SQL 双引擎比对")
    parser.add_argument("--out", help="把报告写到这个路径（默认只打印摘要）")
    parser.add_argument("--check", action="store_true",
                        help="只校验：不一致就退 1，不写文件")
    parser.add_argument("--keep", action="store_true", help="保留临时数据目录")
    parser.add_argument("--workdir", help="在这造数据（默认临时目录）")
    parser.add_argument("--epochs", type=int, default=EPOCHS_PER_DAY,
                        help=f"每站历元数（默认 {EPOCHS_PER_DAY}）")
    parser.add_argument("--target-rows", type=int,
                        help="按目标 obs 总行数反算每站历元数（覆盖 --epochs）")
    parser.add_argument("--chunk-epochs", type=int,
                        help="分块生成时每块历元数（亿级必给，否则整表驻留内存）")
    parser.add_argument("--reuse", action="store_true",
                        help="复用 --workdir 里已建好的数据，不重建（亿级重跑用）")
    parser.add_argument("--scale-out",
                        help="把亿级压测结果写到这个路径（供 render_report 读）")
    parser.add_argument("--scale-repeats", type=int, default=7,
                        help="压测每查询重复次数（默认 7）")
    parser.add_argument("--scale-cases", default="SQL-01,SQL-05,SQL-12",
                        help="压测跑哪几条（逗号分隔，默认 SQL-01,SQL-05,SQL-12）")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    epochs = args.epochs
    if args.target_rows is not None:
        epochs = epochs_for_target_rows(args.target_rows)

    workdir = Path(args.workdir) if args.workdir else Path(
        tempfile.mkdtemp(prefix="fsa-bench-"))
    if args.reuse and not workdir.is_dir():
        print(f"[bench] --reuse 给的目录不存在：{workdir}", file=sys.stderr)
        return 2
    if args.workdir and workdir.exists() and not args.reuse:
        # 复用同一个 workdir 时先清掉旧产物：分区器用 `os.replace` 覆盖
        # `_manifest.json`，旧文件若被别的进程占着会 WinError 5。
        #
        # **只清「本脚本造的那四张表」**，不清整个目录：两个基准进程共用
        # 同一个 `--workdir` 时，清整个目录会把对方刚写的数据删掉，
        # 表现是「视图注册不上、每条都报 table does not exist」。
        for name in ("obs", "tec", "agg_hour", "agg_daily"):
            child = workdir / name
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
    try:
        if args.reuse:
            env = load_dataset(workdir)
            if not args.quiet:
                print(f"复用已建数据 -> {workdir}")
                print(f"  obs={env.rows['obs']:,} tec={env.rows['tec']:,} "
                      f"agg_hour={env.rows['agg_hour']:,} "
                      f"agg_daily={env.rows['agg_daily']:,}")
        else:
            if not args.quiet:
                print(f"造数据 -> {workdir}")
                print(f"  obs  {epochs:,} 历元/站 × "
                      f"{len(BENCH_STATIONS)} 站 × {len(_sv_list())} SV × "
                      f"{len(SIGNALS)} 信号"
                      f"（目标 {epochs * rows_per_epoch() * len(BENCH_STATIONS):,} 行）")
                if args.chunk_epochs:
                    print(f"  分块：每块 {args.chunk_epochs:,} 历元")
            env = build_dataset(workdir, epochs=epochs, quiet=args.quiet,
                                chunk_epochs=args.chunk_epochs)
        if not args.quiet:
            print()

        if args.scale_out:
            return _run_scale(env, args)

        if not args.quiet:
            print("跑 20 条：")

        readonly_problems = check_readonly_both(env)
        fallback = check_fallback(env)
        outcomes = run_all(env, quiet=args.quiet)

        ok = sum(1 for o in outcomes if o.ok)
        print()
        print(f"一致 {ok}/{len(outcomes)}；只读闸门 "
              f"{'全部通过' if not readonly_problems else '有问题'}")
        print(fallback)

        if args.out:
            report = render_report(env, outcomes, readonly_problems, fallback)
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(report, encoding="utf-8")
            print(f"报告 -> {out_path}")

        if args.check:
            return 0 if ok == len(outcomes) and not readonly_problems else 1
        return 0
    finally:
        if not args.keep and not args.workdir:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
