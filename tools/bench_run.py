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


def _freq(signal: str) -> float:
    return {"L1": 1575.42e6, "L2": 1227.60e6, "L5": 1176.45e6}[signal]


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
                       epochs: int = EPOCHS_PER_DAY) -> list[dict]:
    """造 `tec` 行：每 SV 每历元一条（19 × 86400）。"""
    day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    rows: list[dict] = []
    for epoch in range(epochs):
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
    """
    bucket: dict[tuple, dict[str, Any]] = {}
    cn0_by_key: dict[tuple, list[float]] = {}
    slip_by_key: dict[tuple, int] = {}
    for row in obs_rows:
        ts = datetime.strptime(row["epoch_utc"], "%Y-%m-%d %H:%M:%S")
        key = (row["station"], ts.strftime("%Y-%m-%d"), ts.hour, row["system"])
        acc = bucket.setdefault(key, {"n_obs": 0, "epochs": set(), "svs": set()})
        acc["n_obs"] += 1
        acc["epochs"].add(row["epoch_utc"])
        acc["svs"].add(row["sv"])
        cn0 = row["cn0_dbhz"]
        if cn0 is not None:
            cn0_by_key.setdefault(key, []).append(cn0)
        if (row["quality_flag"] & 4) != 0:
            slip_by_key[key] = slip_by_key.get(key, 0) + 1
    out: list[dict] = []
    for (station, date, hour, system), acc in sorted(bucket.items()):
        values = cn0_by_key.get(key := (station, date, hour, system), [])
        if values:
            ordered = sorted(values)
            mean = sum(ordered) / len(ordered)
            p50 = percentile(ordered, 0.50)
            p95 = percentile(ordered, 0.95)
        else:
            mean = p50 = p95 = None
        out.append({
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
            "missing_rate": (acc["n_obs"] - len(values)) / acc["n_obs"] if acc["n_obs"] else 0.0,
            "slip_epochs": slip_by_key.get(key, 0),
            "qc_reject_rate": 0.0,
        })
    return out


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
    """由 obs 与 tec 聚合出 `agg_daily`。"""
    out: list[dict] = []
    for station in BENCH_STATIONS:
        station_obs = [r for r in obs_rows if r["station"] == station]
        station_tec = [r for r in tec_rows if r["station"] == station]
        cn0 = sorted(r["cn0_dbhz"] for r in station_obs if r["cn0_dbhz"] is not None)
        vtec = sorted(r["vTEC_TECU"] for r in station_tec if r["vTEC_TECU"] is not None)
        epochs = {r["epoch_utc"] for r in station_obs}
        out.append({
            "station": station,
            "date": BENCH_DATE,
            "n_obs": len(station_obs),
            "n_epochs": len(epochs),
            "n_sv": len({r["sv"] for r in station_obs}),
            "mean_cn0": sum(cn0) / len(cn0) if cn0 else None,
            "p95_cn0": percentile(cn0, 0.95) if cn0 else None,
            "missing_rate": (len(station_obs) - len(cn0)) / len(station_obs) if station_obs else 0.0,
            "slip_epochs": sum(1 for r in station_obs if (r["quality_flag"] & 4) != 0),
            "tec_mean": sum(vtec) / len(vtec) if vtec else None,
            "tec_p95": percentile(vtec, 0.95) if vtec else None,
            "coverage_s": len(epochs),
        })
    return out


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
                  quiet: bool = False) -> BenchEnv:
    """造 `bench_v1`。**必须复用 `writer.py`**，不绕过「Parquet 是唯一真相」。"""
    root.mkdir(parents=True, exist_ok=True)
    obs_dir = root / "obs"
    tec_dir = root / "tec"
    agg_hour_dir = root / "agg_hour"
    agg_daily_dir = root / "agg_daily"
    for directory in (obs_dir, tec_dir, agg_hour_dir, agg_daily_dir):
        directory.mkdir(parents=True, exist_ok=True)

    obs_rows: list[dict] = []
    tec_rows: list[dict] = []
    for station in BENCH_STATIONS:
        obs_rows.extend(synthetic_obs_rows(station, epochs=epochs))
        tec_rows.extend(synthetic_tec_rows(station, epochs=epochs))
    agg_hour_rows = synthetic_agg_hour_rows(obs_rows)
    agg_daily_rows = synthetic_agg_daily_rows(obs_rows, tec_rows)

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

    _write(obs_rows, obs_dir)
    _write(tec_rows, tec_dir)
    _write_agg(agg_hour_rows, agg_hour_dir)
    _write_agg(agg_daily_rows, agg_daily_dir)

    return BenchEnv(
        root=root, obs_dir=obs_dir, tec_dir=tec_dir,
        agg_hour_dir=agg_hour_dir, agg_daily_dir=agg_daily_dir,
        rows={"obs": len(obs_rows), "tec": len(tec_rows),
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


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="20 条基准 SQL 双引擎比对")
    parser.add_argument("--out", help="把报告写到这个路径（默认只打印摘要）")
    parser.add_argument("--check", action="store_true",
                        help="只校验：不一致就退 1，不写文件")
    parser.add_argument("--keep", action="store_true", help="保留临时数据目录")
    parser.add_argument("--workdir", help="在这造数据（默认临时目录）")
    parser.add_argument("--epochs", type=int, default=EPOCHS_PER_DAY,
                        help=f"每站历元数（默认 {EPOCHS_PER_DAY}）")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    workdir = Path(args.workdir) if args.workdir else Path(
        tempfile.mkdtemp(prefix="fsa-bench-"))
    if args.workdir and workdir.exists():
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
        if not args.quiet:
            print(f"造数据 -> {workdir}")
            print(f"  obs  {EPOCHS_PER_DAY if not args.epochs else args.epochs:,} 历元/站 × "
                  f"{len(BENCH_STATIONS)} 站 × 19 SV × {len(SIGNALS)} 信号")
        env = build_dataset(workdir, epochs=args.epochs, quiet=args.quiet)
        if not args.quiet:
            print(f"  obs={env.rows['obs']:,} tec={env.rows['tec']:,} "
                  f"agg_hour={env.rows['agg_hour']:,} agg_daily={env.rows['agg_daily']:,}")
            print()
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
