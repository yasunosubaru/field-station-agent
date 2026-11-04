"""内置查询引擎：直接读 NDJSON，做过滤、时间桶、分组与聚合。

**为什么需要它**：DuckDB / ClickHouse 在演示机、CI、离线包里不一定装得上。
内置引擎保证「同一份数据，哪怕只有标准库也能回答最基本的 20 条基准查询中的
一部分」；回答不了的要**明确说**需要 DuckDB/ClickHouse，而不是悄悄给错数。

**能力边界**（与 ``bench.py`` 的基准一一对应）：

- 过滤：``= != < <= > >= in / not in contains startswith endswith is null between``
- 分组：任意列 + 时间桶（``30s`` / ``15m`` / ``1h`` / ``1d`` / ``1w``）
- 聚合：``count`` / ``count_distinct`` / ``sum`` / ``avg`` / ``min`` / ``max``
- 排序与 ``limit``

不做 JOIN、窗口函数、百分位、正则——那些是 ``DuckDBEngine`` /
``ClickHouseEngine`` 的活。

**只用标准库**。
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any, Iterator, Mapping, Sequence

from .manifest import coerce_datetime, iter_data_files

__all__ = [
    "Aggregate",
    "Predicate",
    "QueryEngine",
    "QueryError",
    "QueryResult",
    "QuerySpec",
    "bucket_start",
    "count_rows",
    "execute",
    "iter_rows",
    "parse_bucket",
]


class QueryError(ValueError):
    """查询条件不合法，或数据文件读不了。"""


# ---------------------------------------------------------------- 过滤条件
_OP_ALIASES = {
    "=": "==",
    "eq": "==",
    "ne": "!=",
    "<>": "!=",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
    "not_in": "not in",
    "isnull": "is null",
    "is_null": "is null",
    "notnull": "is not null",
    "is_not_null": "is not null",
}
_OPS = {
    "==",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "in",
    "not in",
    "contains",
    "startswith",
    "endswith",
    "is null",
    "is not null",
    "between",
}


@dataclass(frozen=True)
class Predicate:
    """一行过滤条件：``field op value``。"""

    field: str
    op: str = "=="
    value: Any = None

    def __post_init__(self) -> None:
        op = str(self.op).strip().lower()
        op = _OP_ALIASES.get(op, op)
        if op not in _OPS:
            raise QueryError(f"不支持的过滤运算符 {self.op!r}；可用：{sorted(_OPS)}")
        object.__setattr__(self, "op", op)

    def matches(self, row: Mapping[str, Any]) -> bool:
        actual = row.get(self.field)
        op = self.op
        if op == "is null":
            return actual is None
        if op == "is not null":
            return actual is not None
        if op in ("in", "not in"):
            try:
                hit = actual in self.value
            except TypeError:
                hit = False
            return hit if op == "in" else not hit
        if op == "contains":
            if actual is None:
                return False
            try:
                return self.value in actual
            except TypeError:
                return str(self.value) in str(actual)
        if op == "startswith":
            return actual is not None and str(actual).startswith(str(self.value))
        if op == "endswith":
            return actual is not None and str(actual).endswith(str(self.value))
        if op == "between":
            try:
                low, high = self.value
            except (TypeError, ValueError) as exc:
                raise QueryError("between 需要 (low, high) 二元组") from exc
            return _le(low, actual) and _le(actual, high)

        if actual is None or self.value is None:
            return op == "==" and actual is None and self.value is None
        if op == "==":
            return actual == self.value
        if op == "!=":
            return actual != self.value
        if op == "<":
            return _lt(actual, self.value)
        if op == "<=":
            return _le(actual, self.value)
        if op == ">":
            return _lt(self.value, actual)
        if op == ">=":
            return _le(self.value, actual)
        return False  # pragma: no cover - _OPS 已穷举


def _lt(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return False
    try:
        return bool(a < b)
    except TypeError:
        return str(a) < str(b)


def _le(a: Any, b: Any) -> bool:
    return _lt(a, b) or a == b


# ---------------------------------------------------------------- 聚合
_AGG_FUNCS = {"count", "count_distinct", "sum", "avg", "min", "max"}


@dataclass(frozen=True)
class Aggregate:
    """一个聚合列。``field='*'`` 只对 ``count`` 有意义。"""

    func: str
    field: str = "*"
    alias: str = ""

    def __post_init__(self) -> None:
        func = str(self.func).strip().lower()
        if func not in _AGG_FUNCS:
            raise QueryError(f"不支持的聚合函数 {self.func!r}；可用：{sorted(_AGG_FUNCS)}")
        object.__setattr__(self, "func", func)
        object.__setattr__(self, "field", str(self.field))
        if not self.alias:
            safe = re.sub(r"[^0-9A-Za-z_]+", "_", self.field).strip("_") or "all"
            object.__setattr__(self, "alias", f"{func}_{safe}")

    @property
    def name(self) -> str:
        return self.alias


def _number(value: Any) -> float | None:
    """只接受真正的数值；字符串不隐式转数字（避免把站名当坐标算）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    return None


def _hashable(value: Any) -> Any:
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return value


def _sort_key(value: Any) -> tuple[int, float, str]:
    if value is None:
        return (2, 0.0, "")
    if isinstance(value, bool):
        return (1, 0.0, str(value))
    if isinstance(value, (int, float)):
        return (0, float(value), "")
    return (1, 0.0, str(value))


class _Accumulator:
    __slots__ = ("agg", "count", "total", "best", "seen")

    def __init__(self, agg: Aggregate) -> None:
        self.agg = agg
        self.count = 0
        self.total = 0.0
        self.best: Any = None
        self.seen: set[Any] = set()

    def add(self, row: Mapping[str, Any]) -> None:
        value = row.get(self.agg.field) if self.agg.field != "*" else 1
        func = self.agg.func
        if func == "count":
            if self.agg.field == "*" or value is not None:
                self.count += 1
            return
        if func == "count_distinct":
            if value is not None:
                self.seen.add(_hashable(value))
            return
        number = _number(value)
        if func in ("sum", "avg"):
            if number is not None:
                self.total += number
                self.count += 1
            return
        # min / max：保持原值（字符串也允许），用统一键比较
        if value is None:
            return
        if self.best is None:
            self.best = value
            return
        candidate = _sort_key(value)
        current = _sort_key(self.best)
        better = candidate < current if func == "min" else candidate > current
        if better:
            self.best = value

    def result(self) -> Any:
        func = self.agg.func
        if func == "count":
            return self.count
        if func == "count_distinct":
            return len(self.seen)
        if func in ("sum", "avg"):
            if self.count == 0:
                return None
            return self.total if func == "sum" else self.total / self.count
        return self.best


# ---------------------------------------------------------------- 时间桶
_BUCKET_RE = re.compile(r"^\s*(\d+)\s*([A-Za-z]+)\s*$")
_BUCKET_UNITS = {
    "s": 1,
    "sec": 1,
    "secs": 1,
    "second": 1,
    "seconds": 1,
    "m": 60,
    "min": 60,
    "mins": 60,
    "minute": 60,
    "minutes": 60,
    "h": 3600,
    "hr": 3600,
    "hour": 3600,
    "hours": 3600,
    "d": 86400,
    "day": 86400,
    "days": 86400,
    "w": 604800,
    "week": 604800,
    "weeks": 604800,
}


def parse_bucket(bucket: str | int) -> int:
    """把 ``'15m'`` / ``'1 hour'`` 解析成秒数。"""
    if isinstance(bucket, int) and not isinstance(bucket, bool):
        if bucket <= 0:
            raise QueryError("时间桶必须大于 0")
        return bucket
    match = _BUCKET_RE.match(str(bucket))
    if not match:
        raise QueryError(f"无法解析时间桶 {bucket!r}；示例：30s / 15m / 1h / 1d")
    size = int(match.group(1))
    unit = match.group(2).lower()
    if unit not in _BUCKET_UNITS:
        raise QueryError(f"不认识的时间桶单位 {unit!r}；可用：s/m/h/d/w")
    if size <= 0:
        raise QueryError("时间桶必须大于 0")
    return size * _BUCKET_UNITS[unit]


def bucket_start(value: Any, size_s: int) -> str:
    """把时间戳对齐到桶起点，返回 ``YYYY-MM-DDTHH:MM:SSZ``（UTC）。

    对齐按 Unix 秒做整除，所以 ``1d`` 的边界是 UTC 零点，与 DuckDB
    ``time_bucket`` / ClickHouse ``toStartOfInterval`` 的语义一致。
    """
    dt = coerce_datetime(value)
    if dt is None:
        raise QueryError(f"时间值 {value!r} 无法解析，不能做时间桶")
    start = int(math.floor(dt.timestamp() / size_s)) * size_s
    return datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- 查询描述
@dataclass(frozen=True)
class QuerySpec:
    """一条可序列化的查询。基准查询的内置实现就是它。"""

    filters: tuple[Predicate, ...] = ()
    bucket: str | None = None
    time_field: str = "epoch_utc"
    bucket_alias: str = "bucket"
    group_by: tuple[str, ...] = ()
    aggregates: tuple[Aggregate, ...] = ()
    order_by: tuple[tuple[str, str], ...] = ()
    limit: int | None = None
    station: str | None = None
    date: str | None = None
    hour: str | int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "filters", tuple(self.filters))
        object.__setattr__(self, "group_by", tuple(str(g) for g in self.group_by))
        object.__setattr__(self, "aggregates", tuple(self.aggregates))
        normalised: list[tuple[str, str]] = []
        for item in self.order_by:
            if isinstance(item, str):
                normalised.append((item, "asc"))
            else:
                name, direction = item
                direction = str(direction).lower()
                if direction not in ("asc", "desc"):
                    raise QueryError(f"排序方向只能是 asc/desc：{direction!r}")
                normalised.append((str(name), direction))
        object.__setattr__(self, "order_by", tuple(normalised))
        if self.limit is not None:
            if isinstance(self.limit, bool) or int(self.limit) < 0:
                raise QueryError(f"limit 必须是非负整数：{self.limit!r}")
            object.__setattr__(self, "limit", int(self.limit))
        if self.bucket is not None:
            parse_bucket(self.bucket)  # 早失败，别等扫完数据

    @property
    def group_fields(self) -> tuple[str, ...]:
        fields = list(self.group_by)
        if self.bucket and self.bucket_alias not in fields:
            fields.append(self.bucket_alias)
        return tuple(fields)

    @property
    def is_grouped(self) -> bool:
        return bool(self.aggregates or self.group_fields)


@dataclass
class QueryResult:
    """查询结果。``elapsed_s`` 用 ``perf_counter`` 量，基准脚本直接读。"""

    columns: tuple[str, ...]
    rows: list[dict[str, Any]]
    elapsed_s: float = 0.0

    def __len__(self) -> int:
        return len(self.rows)

    def to_dicts(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.rows]

    def scalar(self) -> Any:
        if not self.rows or not self.columns:
            return None
        return self.rows[0].get(self.columns[0])


class QueryEngine:
    """绑定一个数据根目录的内置查询门面。

    与 :class:`fieldstation.data.engines.BuiltinEngine` 同源；这里少一层适配器，
    适合脚本和测试直接用。
    """

    name = "builtin"

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def available(self) -> bool:
        return True

    def execute(self, spec: QuerySpec | None = None, **kwargs: Any) -> QueryResult:
        return execute(self.root, spec, **kwargs)

    def count(self, **kwargs: Any) -> int:
        return count_rows(self.root, **kwargs)

    def explain(self, spec: QuerySpec | None = None, **kwargs: Any) -> str:
        return (
            f"builtin: 扫描 {self.root} 下的 NDJSON 分区，按过滤 -> 时间桶 -> "
            f"分组聚合 -> 排序 -> limit 执行；查询条件={spec or kwargs}"
        )


# ---------------------------------------------------------------- 读数据
def iter_rows(
    root: str | Path,
    *,
    station: str | None = None,
    date: str | None = None,
    hour: str | int | None = None,
) -> Iterator[dict[str, Any]]:
    """按分区条件逐行读 NDJSON。坏行报文件名与行号，不静默跳过。"""
    root = Path(root)
    if not root.exists():
        raise QueryError(f"数据目录不存在：{root}")
    for path in iter_data_files(root, station=station, date=date, hour=hour):
        with path.open("r", encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, start=1):
                text = line.strip()
                if not text:
                    continue
                try:
                    row = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise QueryError(f"{path.name}:{lineno} 不是合法 JSON：{exc}") from exc
                if not isinstance(row, dict):
                    raise QueryError(f"{path.name}:{lineno} 不是 JSON 对象")
                yield row


# ---------------------------------------------------------------- 执行
def execute(
    root: str | Path,
    spec: QuerySpec | None = None,
    **kwargs: Any,
) -> QueryResult:
    """执行一条 ``QuerySpec``。

    也可以 ``execute(root, filters=[...], aggregates=[...])``，关键字参数会
    转成 ``QuerySpec``。
    """
    started = perf_counter()
    if spec is None:
        spec = QuerySpec(**kwargs)
    elif kwargs:
        raise TypeError("execute() 不能同时传 spec 和关键字条件")

    if spec.is_grouped:
        return _execute_grouped(root, spec, started)
    return _execute_raw(root, spec, started)


def _execute_raw(root: str | Path, spec: QuerySpec, started: float) -> QueryResult:
    rows: list[dict[str, Any]] = []
    columns: list[str] = []
    seen_columns: set[str] = set()
    for row in iter_rows(root, station=spec.station, date=spec.date, hour=spec.hour):
        if not all(pred.matches(row) for pred in spec.filters):
            continue
        rows.append(row)
        for name in row:
            if name not in seen_columns:
                seen_columns.add(name)
                columns.append(name)
    rows = _order(rows, spec.order_by, columns)
    if spec.limit is not None:
        rows = rows[: spec.limit]
    return QueryResult(columns=tuple(columns), rows=rows, elapsed_s=perf_counter() - started)


def _execute_grouped(root: str | Path, spec: QuerySpec, started: float) -> QueryResult:
    group_fields = list(spec.group_fields)
    aggregates = list(spec.aggregates)
    bucket_size = parse_bucket(spec.bucket) if spec.bucket else None
    groups: dict[Any, tuple[list[Any], list[_Accumulator]]] = {}

    for row in iter_rows(root, station=spec.station, date=spec.date, hour=spec.hour):
        if not all(pred.matches(row) for pred in spec.filters):
            continue
        values: list[Any] = []
        for name in group_fields:
            if bucket_size is not None and name == spec.bucket_alias:
                values.append(bucket_start(row.get(spec.time_field), bucket_size))
            else:
                values.append(row.get(name))
        key = tuple(_hashable(value) for value in values)
        entry = groups.get(key)
        if entry is None:
            entry = (values, [_Accumulator(agg) for agg in aggregates])
            groups[key] = entry
        for acc in entry[1]:
            acc.add(row)

    # 无分组、无数据时，SQL 的聚合仍返回一行（count=0，其余 NULL）
    if not group_fields and not groups and aggregates:
        groups[()] = ([], [_Accumulator(agg) for agg in aggregates])

    columns = tuple(group_fields + [agg.alias for agg in aggregates])
    out: list[dict[str, Any]] = []
    for values, accumulators in groups.values():
        item: dict[str, Any] = dict(zip(group_fields, values))
        for acc in accumulators:
            item[acc.agg.alias] = acc.result()
        out.append(item)

    out = _order(out, spec.order_by, list(columns))
    if spec.limit is not None:
        out = out[: spec.limit]
    return QueryResult(columns=columns, rows=out, elapsed_s=perf_counter() - started)


def _order(
    rows: list[dict[str, Any]],
    order_by: Sequence[tuple[str, str]],
    columns: Sequence[str],
) -> list[dict[str, Any]]:
    for name, _ in order_by:
        if name not in columns:
            raise QueryError(f"排序字段 {name!r} 不在结果列 {tuple(columns)} 中")
    ordered = list(rows)
    # 反向排序实现多列排序：稳定排序从最后一列往前排
    for name, direction in reversed(list(order_by)):
        ordered.sort(key=lambda row: _sort_key(row.get(name)), reverse=direction == "desc")
    return ordered


def count_rows(root: str | Path, **kwargs: Any) -> int:
    """``count(*)`` 的便捷写法。"""
    result = execute(root, QuerySpec(aggregates=(Aggregate("count"),), **kwargs))
    return int(result.scalar() or 0)
