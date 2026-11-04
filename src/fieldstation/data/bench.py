"""E4 查询基准：20 条固定 SQL，内置 / DuckDB / ClickHouse 都能跑（能跑的）。

用法::

    python -m fieldstation.data.bench --engine builtin
    python -m fieldstation.data.bench --engine duckdb --root data/obs --iterations 10
    python -m fieldstation.data.bench --engine clickhouse --json

**为什么内置引擎只跑一部分**：DuckDB / ClickHouse 才有的窗口、百分位、JOIN、
正则与 GROUPING SETS，内置引擎**明确跳过并说明原因**（不静默、不伪造结果）。
20 条里至少 10 条内置可跑，其余报「需要 DuckDB/ClickHouse」。

**计时**：``time.perf_counter()``，先预热一轮再计时；输出 p50/p95（最近秩法）。
没给 ``--root`` 时在临时目录生成固定 seed 的合成数据，保证命令开箱即用，
且不会往仓库里写任何东西。

只用标准库；duckdb / clickhouse 仍是延迟导入。
"""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter
from typing import Any, Sequence

from .dialects import to_clickhouse, to_duckdb
from .engines import (
    BaseEngine,
    BuiltinEngine,
    EngineUnavailable,
    REQUIRES_SQL_ENGINE,
    get_engine,
)
from .query import Aggregate, Predicate, QueryResult, QuerySpec
from .writer import NdjsonWriter

__all__ = [
    "BENCHMARKS",
    "BenchCase",
    "CaseResult",
    "main",
    "run_case",
    "synthetic_records",
]


# ---------------------------------------------------------------- 基准目录
@dataclass(frozen=True)
class BenchCase:
    """一条基准查询：统一 SQL + 内置实现（None 表示内置跑不了）。"""

    id: str
    title: str
    sql: str
    builtin: QuerySpec | None = None
    requires: str = ""

    @property
    def builtin_ok(self) -> bool:
        return self.builtin is not None


def _pred(field: str, op: str = "==", value: Any = None) -> Predicate:
    return Predicate(field, op, value)


def _agg(func: str, field: str = "*", alias: str = "") -> Aggregate:
    return Aggregate(func, field, alias)


#: 20 条。前 10 条内置可跑；后 10 条内置明确报「需要 DuckDB/ClickHouse」。
BENCHMARKS: tuple[BenchCase, ...] = (
    BenchCase(
        "B01",
        "总行数",
        "SELECT count(*) AS n FROM obs",
        QuerySpec(aggregates=(_agg("count", "*", "n"),)),
    ),
    BenchCase(
        "B02",
        "按站计数（降序）",
        "SELECT station, count(*) AS n FROM obs GROUP BY station ORDER BY n DESC",
        QuerySpec(
            group_by=("station",),
            aggregates=(_agg("count", "*", "n"),),
            order_by=(("n", "desc"),),
        ),
    ),
    BenchCase(
        "B03",
        "按站 × 系统平均载噪比",
        "SELECT station, system, avg(cn0_dbhz) AS avg_cn0 "
        "FROM obs GROUP BY station, system ORDER BY station, system",
        QuerySpec(
            group_by=("station", "system"),
            aggregates=(_agg("avg", "cn0_dbhz", "avg_cn0"),),
            order_by=(("station", "asc"), ("system", "asc")),
        ),
    ),
    BenchCase(
        "B04",
        "小时桶计数",
        "SELECT time_bucket('1 hour', epoch_utc) AS bucket, count(*) AS n "
        "FROM obs GROUP BY 1 ORDER BY 1",
        QuerySpec(
            bucket="1h",
            aggregates=(_agg("count", "*", "n"),),
            order_by=(("bucket", "asc"),),
        ),
    ),
    BenchCase(
        "B05",
        "小时桶平均载噪比",
        "SELECT time_bucket('1 hour', epoch_utc) AS bucket, "
        "avg(cn0_dbhz) AS avg_cn0 FROM obs GROUP BY 1 ORDER BY 1",
        QuerySpec(
            bucket="1h",
            aggregates=(_agg("avg", "cn0_dbhz", "avg_cn0"),),
            order_by=(("bucket", "asc"),),
        ),
    ),
    BenchCase(
        "B06",
        "质控异常 Top 10（站 × 卫星）",
        "SELECT station, sv, count(*) AS bad FROM obs "
        "WHERE quality_flag <> 0 GROUP BY station, sv ORDER BY bad DESC LIMIT 10",
        QuerySpec(
            filters=(_pred("quality_flag", "!=", 0),),
            group_by=("station", "sv"),
            aggregates=(_agg("count", "*", "bad"),),
            order_by=(("bad", "desc"),),
            limit=10,
        ),
    ),
    BenchCase(
        "B07",
        "按站 min/max 载噪比",
        "SELECT station, min(cn0_dbhz) AS lo, max(cn0_dbhz) AS hi "
        "FROM obs GROUP BY station ORDER BY station",
        QuerySpec(
            group_by=("station",),
            aggregates=(
                _agg("min", "cn0_dbhz", "lo"),
                _agg("max", "cn0_dbhz", "hi"),
            ),
            order_by=(("station", "asc"),),
        ),
    ),
    BenchCase(
        "B08",
        "单站 15 分钟桶平均载噪比",
        "SELECT time_bucket('15 minutes', epoch_utc) AS bucket, "
        "avg(cn0_dbhz) AS avg_cn0 FROM obs WHERE station = 'WUHN' "
        "GROUP BY 1 ORDER BY 1",
        QuerySpec(
            filters=(_pred("station", "==", "WUHN"),),
            bucket="15m",
            aggregates=(_agg("avg", "cn0_dbhz", "avg_cn0"),),
            order_by=(("bucket", "asc"),),
        ),
    ),
    BenchCase(
        "B09",
        "按站去重卫星数",
        "SELECT station, count(DISTINCT sv) AS sv_count FROM obs "
        "GROUP BY station ORDER BY station",
        QuerySpec(
            group_by=("station",),
            aggregates=(_agg("count_distinct", "sv", "sv_count"),),
            order_by=(("station", "asc"),),
        ),
    ),
    BenchCase(
        "B10",
        "高仰角（>=30°）各系统平均载噪比",
        "SELECT system, avg(cn0_dbhz) AS avg_cn0 FROM obs "
        "WHERE elev_deg >= 30 GROUP BY system ORDER BY avg_cn0 DESC",
        QuerySpec(
            filters=(_pred("elev_deg", ">=", 30.0),),
            group_by=("system",),
            aggregates=(_agg("avg", "cn0_dbhz", "avg_cn0"),),
            order_by=(("avg_cn0", "desc"),),
        ),
    ),
    BenchCase(
        "B11",
        "质控异常总数（CASE WHEN）",
        "SELECT sum(CASE WHEN quality_flag <> 0 THEN 1 ELSE 0 END) AS bad FROM obs",
        None,
        "需要 DuckDB/ClickHouse（内置引擎不做 CASE 表达式）",
    ),
    BenchCase(
        "B12",
        "载噪比 3 点滑动平均（窗口）",
        "SELECT station, epoch_utc, avg(cn0_dbhz) OVER ("
        "PARTITION BY station ORDER BY epoch_utc ROWS BETWEEN 2 PRECEDING AND CURRENT ROW"
        ") AS ma3 FROM obs",
        None,
        "需要 DuckDB/ClickHouse（窗口函数）",
    ),
    BenchCase(
        "B13",
        "载噪比 P95（分位数）",
        "SELECT station, quantile_cont(cn0_dbhz, 0.95) AS p95 "
        "FROM obs GROUP BY station ORDER BY station",
        None,
        "需要 DuckDB/ClickHouse（分位数函数）",
    ),
    BenchCase(
        "B14",
        "每站最高载噪比对应的卫星（arg_max）",
        "SELECT station, arg_max(sv, cn0_dbhz) AS best_sv FROM obs "
        "GROUP BY station ORDER BY station",
        None,
        "需要 DuckDB/ClickHouse（arg_max/argMax）",
    ),
    BenchCase(
        "B15",
        "相邻历元间隔（窗口 LAG）",
        "SELECT station, epoch_utc, "
        "epoch_utc - lag(epoch_utc) OVER (PARTITION BY station ORDER BY epoch_utc) AS gap "
        "FROM obs",
        None,
        "需要 DuckDB/ClickHouse（窗口 LAG 与时间减法）",
    ),
    BenchCase(
        "B16",
        "站名正则筛选",
        "SELECT station, count(*) AS n FROM obs "
        "WHERE regexp_matches(station, '^WU') GROUP BY station",
        None,
        "需要 DuckDB/ClickHouse（正则函数名不同）",
    ),
    BenchCase(
        "B17",
        "覆盖时段（分钟）",
        "SELECT station, date_diff('minute', min(epoch_utc), max(epoch_utc)) AS minutes "
        "FROM obs GROUP BY station ORDER BY station",
        None,
        "需要 DuckDB/ClickHouse（日期差函数）",
    ),
    BenchCase(
        "B18",
        "数组展开（每站一行展开为多行）",
        "SELECT station, unnest([1, 2, 3]) AS slot FROM obs GROUP BY station",
        None,
        "需要 DuckDB/ClickHouse（数组展开语法不同）",
    ),
    BenchCase(
        "B19",
        "载噪比中位数",
        "SELECT station, median(cn0_dbhz) AS med FROM obs "
        "GROUP BY station ORDER BY station",
        None,
        "需要 DuckDB/ClickHouse（中位数函数）",
    ),
    BenchCase(
        "B20",
        "分组小计（GROUPING SETS）",
        "SELECT station, system, count(*) AS n FROM obs "
        "GROUP BY GROUPING SETS ((station), (system), ())",
        None,
        "需要 DuckDB/ClickHouse（GROUPING SETS / WITH TOTALS）",
    ),
)


# ---------------------------------------------------------------- 合成数据
DEFAULT_STATIONS = ("WUHN", "BJFS", "SHAO", "URUM")
DEFAULT_SYSTEMS = ("G", "C", "R", "E")
DEFAULT_SIGNALS = ("L1", "L2")


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def synthetic_records(
    *,
    stations: Sequence[str] = DEFAULT_STATIONS,
    hours: int = 6,
    rows_per_hour: int = 40,
    seed: int = 7,
    start: datetime | None = None,
) -> list[dict[str, Any]]:
    """固定 seed 的合成观测；字段与 ``model.Observation.to_row()`` 对齐。"""
    base = start or datetime(2026, 11, 4, tzinfo=timezone.utc)
    rng = random.Random(seed)
    records: list[dict[str, Any]] = []
    step = 3600.0 / max(1, rows_per_hour)
    for station in stations:
        for hour in range(hours):
            for index in range(rows_per_hour):
                when = base + timedelta(hours=hour, seconds=index * step)
                system = rng.choice(DEFAULT_SYSTEMS)
                elev = round(rng.uniform(5.0, 85.0), 3)
                cn0 = round(rng.gauss(42.0, 8.0), 3)
                quality = 0 if rng.random() > 0.05 else rng.choice((1, 2, 4))
                records.append(
                    {
                        "station": station,
                        "receiver_id": f"RX-{station}",
                        "epoch_utc": _iso_z(when),
                        "gps_week": 0,
                        "gps_tow_s": round(hour * 3600.0 + index * step, 3),
                        "system": system,
                        "sv": rng.randint(1, 32),
                        "signal": rng.choice(DEFAULT_SIGNALS),
                        "freq_hz": 1575420000.0,
                        "psr_m": round(21000000.0 + rng.uniform(-500.0, 500.0), 3),
                        "adr_cycles": round(rng.uniform(0.0, 1.0e8), 3),
                        "doppler_hz": round(rng.uniform(-5000.0, 5000.0), 3),
                        "cn0_dbhz": cn0,
                        "elev_deg": elev,
                        "azim_deg": round(rng.uniform(0.0, 359.999), 3),
                        "quality_flag": quality,
                    }
                )
    return records


# ---------------------------------------------------------------- 统计
def percentile(values: Sequence[float], percent: float) -> float | None:
    """最近秩法分位数；空序列返回 None。"""
    if not values:
        return None
    ordered = sorted(values)
    if percent <= 0:
        return ordered[0]
    if percent >= 100:
        return ordered[-1]
    index = math.ceil(percent / 100.0 * len(ordered)) - 1
    return ordered[min(max(index, 0), len(ordered) - 1)]


@dataclass
class CaseResult:
    id: str
    title: str
    status: str  # ok / skipped / failed
    rows: int = 0
    p50_ms: float | None = None
    p95_ms: float | None = None
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "rows": self.rows,
            "p50_ms": None if self.p50_ms is None else round(self.p50_ms, 3),
            "p95_ms": None if self.p95_ms is None else round(self.p95_ms, 3),
            "reason": self.reason,
        }


# ---------------------------------------------------------------- 执行
def _engine_sql(engine: BaseEngine, case: BenchCase) -> str:
    if engine.name == "clickhouse":
        return to_clickhouse(case.sql)
    return to_duckdb(case.sql)


def _run_once(engine: BaseEngine, case: BenchCase) -> QueryResult:
    if isinstance(engine, BuiltinEngine):
        if case.builtin is None:
            raise EngineUnavailable(
                "builtin", f"{case.id} {case.requires or REQUIRES_SQL_ENGINE}"
            )
        return engine.execute_spec(case.builtin)
    return engine.execute(_engine_sql(engine, case))


def run_case(
    engine: BaseEngine,
    case: BenchCase,
    *,
    iterations: int = 5,
    warmup: int = 1,
) -> CaseResult:
    """跑一条基准：预热 + 计时 + p50/p95。不可用/跑不了都返回 skipped。"""
    if not engine.available():
        return CaseResult(
            case.id,
            case.title,
            "skipped",
            reason=engine.unavailable_reason() or f"{engine.name} 不可用",
        )
    if isinstance(engine, BuiltinEngine) and case.builtin is None:
        return CaseResult(
            case.id,
            case.title,
            "skipped",
            reason=case.requires or REQUIRES_SQL_ENGINE,
        )

    try:
        for _ in range(max(0, warmup)):
            _run_once(engine, case)
        samples: list[float] = []
        rows = 0
        for _ in range(max(1, iterations)):
            started = perf_counter()
            result = _run_once(engine, case)
            samples.append((perf_counter() - started) * 1000.0)
            rows = len(result.rows)
    except EngineUnavailable as exc:
        return CaseResult(case.id, case.title, "skipped", reason=str(exc))
    except Exception as exc:  # 一条失败不拖垮整轮
        return CaseResult(
            case.id, case.title, "failed", reason=f"{type(exc).__name__}: {exc}"
        )

    return CaseResult(
        case.id,
        case.title,
        "ok",
        rows=rows,
        p50_ms=percentile(samples, 50),
        p95_ms=percentile(samples, 95),
    )


# ---------------------------------------------------------------- 输出
def _format_table(results: Sequence[CaseResult]) -> str:
    header = f"{'id':<5} {'status':<8} {'rows':>7} {'p50(ms)':>10} {'p95(ms)':>10}  title"
    lines = [header, "-" * len(header)]
    for item in results:
        p50 = "-" if item.p50_ms is None else f"{item.p50_ms:.3f}"
        p95 = "-" if item.p95_ms is None else f"{item.p95_ms:.3f}"
        lines.append(
            f"{item.id:<5} {item.status:<8} {item.rows:>7} {p50:>10} {p95:>10}  {item.title}"
        )
    return "\n".join(lines)


def _summary(results: Sequence[CaseResult]) -> str:
    ok = [item for item in results if item.status == "ok"]
    skipped = [item for item in results if item.status == "skipped"]
    failed = [item for item in results if item.status == "failed"]
    p50s = [item.p50_ms for item in ok if item.p50_ms is not None]
    overall = statistics.median(p50s) if p50s else None
    overall_text = "n/a" if overall is None else f"{overall:.3f} ms"
    return (
        f"汇总：{len(ok)} 通过，{len(skipped)} 跳过，{len(failed)} 失败；"
        f"通过项 p50 中位数 = {overall_text}"
    )


def _prepare_root(args: argparse.Namespace) -> tuple[Path, tempfile.TemporaryDirectory[str] | None, int]:
    if args.root:
        return Path(args.root), None, 0
    temp = tempfile.TemporaryDirectory(prefix="fieldstation-bench-")
    root = Path(temp.name)
    records = synthetic_records(
        hours=args.hours, rows_per_hour=args.rows_per_hour, seed=args.seed
    )
    NdjsonWriter(root).write(records)
    return root, temp, len(records)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m fieldstation.data.bench",
        description="E4 数据引擎基准（20 条固定查询，输出 p50/p95）",
    )
    parser.add_argument(
        "--engine",
        default="builtin",
        choices=("builtin", "duckdb", "clickhouse"),
        help="查询引擎；不可用时跳过并说明（默认 builtin）",
    )
    parser.add_argument(
        "--root",
        default=None,
        help="NDJSON 分区根目录；省略时用固定 seed 的临时合成数据",
    )
    parser.add_argument("--iterations", type=int, default=5, help="每条查询计时轮数（默认 5）")
    parser.add_argument("--warmup", type=int, default=1, help="预热轮数（默认 1）")
    parser.add_argument("--hours", type=int, default=6, help="合成数据小时数（默认 6）")
    parser.add_argument("--rows-per-hour", type=int, default=40, help="每站每小时行数（默认 40）")
    parser.add_argument("--seed", type=int, default=7, help="合成数据随机种子（默认 7）")
    parser.add_argument("--json", action="store_true", help="只输出 JSON（给机器读）")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    temp: tempfile.TemporaryDirectory[str] | None = None
    try:
        root, temp, synthetic_rows = _prepare_root(args)
        engine = get_engine(args.engine, root)
        if not args.json:
            source = (
                f"临时合成数据 {synthetic_rows} 行"
                if temp is not None
                else f"root={root}"
            )
            print(f"E4 数据引擎基准 · engine={args.engine} · iterations={args.iterations} · {source}")
            if not engine.available():
                print(f"引擎不可用：{engine.unavailable_reason()}")
                print("本轮全部跳过；未安装依赖不影响内置引擎：--engine builtin")
                return 0
            if engine.name == "clickhouse":
                print("注意：ClickHouse 适配器假定服务端已有 obs 表；--root 不会自动导入。")

        results = [
            run_case(engine, case, iterations=args.iterations, warmup=args.warmup)
            for case in BENCHMARKS
        ]

        if args.json:
            print(
                json.dumps(
                    {
                        "engine": args.engine,
                        "root": str(root),
                        "synthetic": temp is not None,
                        "iterations": args.iterations,
                        "results": [item.to_dict() for item in results],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(_format_table(results))
            skipped = [item for item in results if item.status == "skipped"]
            for item in skipped:
                print(f"跳过 {item.id}（{item.title}）：{item.reason}")
            failed = [item for item in results if item.status == "failed"]
            for item in failed:
                print(f"失败 {item.id}（{item.title}）：{item.reason}")
            print(_summary(results))
        return 0
    finally:
        if temp is not None:
            temp.cleanup()


if __name__ == "__main__":  # pragma: no cover - CLI 入口
    raise SystemExit(main())
