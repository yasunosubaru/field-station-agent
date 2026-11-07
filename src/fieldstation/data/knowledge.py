"""E6 语义层的离线可验证部分：元数据卡 + 手册索引 + Text-to-SQL。

**为什么答案必须带三样**：``docs/contracts/eval-30.md`` 的 EV-17/EV-21 判分口径是
「``partition_paths`` 长度、``row_count`` 精确、附 SQL」。这三样本模块一律强制产出，
不是可选项——少一个就没法回源（S1）也没法证明「扫描不全天」（S3）。

**为什么 Text-to-SQL 不调模型**：真模型要网络与额度，一跑测试就抖。这里的做法是
把"自然语言 → 查询"拆成**可注入的规划器**：

- :class:`SqlPlanner` 协议：``plan(question, card) -> Plan``，真实实现由上层接运行时；
- :class:`RuleBasedPlanner`：确定性关键词规则，离线可复现，覆盖 EV-17/EV-21 那类问法。

规则规划器**不是**通用 NL2SQL，它只认自己会的句式；认不出来就抛
:class:`UnsupportedQuestion` 并把已知字段、台站、时段带出来，让上层决定是追问还是
换模型。宁可明确说不会，也不猜一条 SQL 然后给错数。

**为什么分区裁剪走清单**：``manifest.py`` 已经有每个分区的站/日/小时/行数/时间范围，
重扫全盘是浪费；而且清单是「数从哪来」的溯源依据。清单缺失时才提示先 ``scan()``。

**为什么复用已有引擎**：``query.py`` 的内置引擎与 ``engines.py`` 的 DuckDB 适配器都已
存在且各有测试。本模块只做「规划 + 执行 + 记账」：DuckDB 可用走 SQL（``engine='duckdb'``），
不可用且规划器给得出等价的 ``QuerySpec`` 时回落内置引擎（``engine='builtin'``）并明示；
两者都不行就抛 ``REQUIRES_SQL_ENGINE``，绝不给一个看起来成功的空结果。

**手册索引默认不建**：建索引要写盘、要 embedding 模型。``HandbookIndex`` 必须显式
``build()``；``embed_model`` 也必须显式给。本模块内置的 ``"hashing"`` 只是一个
**字符二元组哈希**向量化器，用来在离线环境把「建索引 → 落盘 → 重载 → 检索」这条
管线跑通并可断言；它的排序质量是词面重叠级别，**不是**语义检索，别拿它当 E6 的
最终质量结论（详见 ``docs/operations/deps.md`` 对 llama-index 缺失时的降级口径）。

**依赖延迟导入**：顶层不 import pyarrow / llama_index（``tools/env_snapshot.py`` 会按
AST 统计 ``src/`` 的第三方 import）。缺包时 ``available()`` 返回假、相关入口抛明确异常。
"""
from __future__ import annotations

import hashlib
import importlib
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any, Iterable, Mapping, Protocol, Sequence, runtime_checkable

from .engines import (
    REQUIRES_SQL_ENGINE,
    DuckDBEngine,
    EngineError,
    EngineUnavailable,
)
from .manifest import PartitionManifest, coerce_datetime
from .query import (
    Aggregate,
    QueryResult,
    QuerySpec,
    execute as execute_spec,
)

__all__ = [
    "DEFAULT_LLAMA_MODULE",
    "DEFAULT_TIME_FIELD",
    "EmbeddingUnavailable",
    "HandbookError",
    "HandbookHit",
    "HandbookIndex",
    "HandbookResult",
    "HandbookUnavailable",
    "KnowledgeError",
    "METRIC_ALIASES",
    "MetadataCard",
    "OBS_VIEW",
    "Plan",
    "PlannerError",
    "QueryAnswer",
    "ReadOnlyError",
    "RuleBasedPlanner",
    "SUPPORTED_SQL_FUNCTIONS",
    "SqlPlanner",
    "StationSummary",
    "UnsupportedQuestion",
    "UnsupportedSqlError",
    "answer_question",
    "ensure_read_only",
    "ensure_supported_sql",
    "handbook_available",
    "search_handbook",
    "where_clause",
]

#: 逻辑视图名。与 ``engines.DuckDBEngine`` 的默认 ``view`` 和
#: ``docs/contracts/bench-sql.md`` 的 ``obs`` 一致。
OBS_VIEW = "obs"

#: 时间字段优先级。与 ``manifest.TIME_FIELDS`` 同源，这里只取最常用的那个当默认。
DEFAULT_TIME_FIELD = "epoch_utc"

#: 手册索引的 llama_index 模块名；留成参数以便确定性测试「缺包」分支。
DEFAULT_LLAMA_MODULE = "llama_index.core"

#: 数值指标的中文/英文别名 → 字段名。只收 ``model.Observation.to_row()`` 里真有的列。
METRIC_ALIASES: dict[str, tuple[str, ...]] = {
    "cn0_dbhz": ("cn0", "cn0_dbhz", "载噪比", "信噪比", "信号强度"),
    "elev_deg": ("elev", "elev_deg", "仰角", "高度角"),
    "azim_deg": ("azim", "azim_deg", "方位角"),
    "psr_m": ("psr", "psr_m", "伪距"),
    "adr_cycles": ("adr", "adr_cycles", "相位"),
    "doppler_hz": ("doppler", "doppler_hz", "多普勒"),
    "freq_hz": ("freq", "freq_hz", "频率"),
    "gps_tow_s": ("gps_tow", "gps_tow_s", "周内秒"),
    "quality_flag": ("quality", "quality_flag", "质控", "质量旗标"),
}

#: 分组维度别名。
GROUP_ALIASES: dict[str, tuple[str, ...]] = {
    "station": ("station", "台站", "站点", "测站"),
    "system": ("system", "系统", "星座"),
    "sv": ("sv", "卫星"),
    "signal": ("signal", "信号"),
}

#: 本模块生成的 SQL 允许出现的函数调用。全部在 ``dialects._HANDLERS`` 里有明确
#: 对应关系（``time_bucket``/``date_trunc`` 会被翻译成 ClickHouse 的
#: ``toStartOfHour`` 等），所以「支持」不是一句空话。
SUPPORTED_SQL_FUNCTIONS = frozenset(
    {
        "count",
        "avg",
        "min",
        "max",
        "sum",
        "time_bucket",
        "date_trunc",
    }
)

#: 只读语句的合法首词。
_READ_ONLY_HEADS = ("select", "with")

#: 出现即拒绝的写/管理关键字（作为独立词出现时）。
_FORBIDDEN_WORDS = frozenset(
    {
        "insert",
        "update",
        "delete",
        "drop",
        "create",
        "alter",
        "truncate",
        "attach",
        "detach",
        "copy",
        "export",
        "import",
        "install",
        "load",
        "pragma",
        "vacuum",
        "call",
        "grant",
        "revoke",
    }
)


class KnowledgeError(RuntimeError):
    """本模块的错误基类。**不继承 ImportError**，上层据此决定追问或降级。"""


class PlannerError(KnowledgeError):
    """规划器本身坏了（配置错、规则表写错）。"""


class UnsupportedQuestion(KnowledgeError):
    """规则规划器认不出这句问法。带上它认识的字段与台站，便于上层追问。"""


class ReadOnlyError(KnowledgeError):
    """只读闸门拒绝了这条语句。``code`` 与 ``docs/contracts/eval-30.md`` 的 EV-20 对齐。"""

    code = "E_READONLY"


class UnsupportedSqlError(KnowledgeError):
    """语句超出了 ``dialects.py`` 认识的子集（白名单外的函数、非 ``obs`` 视图）。"""

    code = "E_UNSUPPORTED_SQL"


# ---------------------------------------------------------------- 元数据卡
@dataclass(frozen=True)
class StationSummary:
    """一个台站在清单里占多少分区、多少行、覆盖到什么时候。"""

    station: str
    partitions: int
    rows: int
    first_time: str | None = None
    last_time: str | None = None
    dates: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "station": self.station,
            "partitions": self.partitions,
            "rows": self.rows,
            "first_time": self.first_time,
            "last_time": self.last_time,
            "dates": list(self.dates),
        }


@dataclass(frozen=True)
class MetadataCard:
    """「这个数据集有什么」的结构化描述，全部来自 ``_manifest.json``。

    **不重扫数据**：字段、行数、时段、分区路径都是清单里的既有信息。清单本身是
    ``writer.py`` 写盘时更新的，``manifest.verify()`` 负责校验它是否还准。
    """

    root: str
    partition_count: int
    total_rows: int
    total_bytes: int
    time_field: str
    stations: tuple[StationSummary, ...]
    fields: tuple[str, ...]
    min_time: str | None
    max_time: str | None
    dates: tuple[str, ...]
    paths: tuple[str, ...]
    note: str = ""

    # -- 构造 -----------------------------------------------------
    @classmethod
    def from_manifest(
        cls,
        manifest: PartitionManifest,
        *,
        root: str | Path | None = None,
    ) -> MetadataCard:
        root_path = Path(root) if root is not None else (manifest.root or Path("."))
        metas = manifest.sorted()
        note = "" if metas else "清单为空；先运行 PartitionManifest.scan() 或检查 _manifest.json"

        stations: dict[str, dict[str, Any]] = {}
        fields: set[str] = set()
        dates: set[str] = set()
        time_field = ""
        low: tuple[float, str] | None = None
        high: tuple[float, str] | None = None
        total_rows = 0
        total_bytes = 0

        for meta in metas:
            total_rows += meta.rows
            total_bytes += meta.bytes
            fields.update(meta.columns)
            dates.add(meta.date)
            entry = stations.setdefault(
                meta.station,
                {"partitions": 0, "rows": 0, "first": None, "last": None, "dates": set()},
            )
            entry["partitions"] += 1
            entry["rows"] += meta.rows
            entry["dates"].add(meta.date)
            if not time_field and meta.time_field:
                time_field = meta.time_field
            # 时间比较统一走 unix 秒：清单里可能混着 ``2026-10-01T07:05:00Z`` 与
            # ``2026-10-01T07:05:00+00:00`` 两种写法，字符串比较会排错。
            for key, value in (("first", meta.min_time), ("last", meta.max_time)):
                weight = _time_weight(value) if value else None
                if weight is None:
                    continue
                current = _time_weight(entry[key]) if entry[key] else None
                if current is None:
                    entry[key] = value
                elif key == "first" and weight < current:
                    entry[key] = value
                elif key == "last" and weight > current:
                    entry[key] = value
            for value, slot in ((meta.min_time, "low"), (meta.max_time, "high")):
                weight = _time_weight(value) if value else None
                if weight is None:
                    continue
                if slot == "low" and (low is None or weight < low[0]):
                    low = (weight, value)
                if slot == "high" and (high is None or weight > high[0]):
                    high = (weight, value)

        summaries = tuple(
            StationSummary(
                station=name,
                partitions=info["partitions"],
                rows=info["rows"],
                first_time=info["first"],
                last_time=info["last"],
                dates=tuple(sorted(info["dates"])),
            )
            for name, info in sorted(stations.items())
        )
        return cls(
            root=root_path.as_posix(),
            partition_count=len(metas),
            total_rows=total_rows,
            total_bytes=total_bytes,
            time_field=time_field or DEFAULT_TIME_FIELD,
            stations=summaries,
            fields=tuple(sorted(fields)),
            min_time=None if low is None else low[1],
            max_time=None if high is None else high[1],
            dates=tuple(sorted(dates)),
            paths=tuple(meta.path for meta in metas),
            note=note,
        )

    @classmethod
    def from_root(
        cls,
        root: str | Path,
        *,
        manifest: PartitionManifest | None = None,
        allow_scan: bool = False,
    ) -> MetadataCard:
        """从 ``<root>/_manifest.json`` 生成卡。

        ``allow_scan=False``（默认）时**绝不扫盘**：清单不存在或为空就返回一张
        ``note`` 说清楚的空卡。``allow_scan=True`` 才用 ``PartitionManifest.scan()``
        重建——那是显式的、代价可预期的一次全盘遍历。
        """
        root_path = Path(root)
        loaded = manifest if manifest is not None else PartitionManifest.load(root_path)
        # 只有显式 allow_scan=True 才扫盘：那是可预期的一次全盘遍历；默认绝不扫。
        if allow_scan and not loaded.partitions and root_path.is_dir():
            loaded = PartitionManifest.scan(root_path)
        return cls.from_manifest(loaded, root=root_path)

    # -- 查询辅助 -------------------------------------------------
    @property
    def station_names(self) -> tuple[str, ...]:
        return tuple(item.station for item in self.stations)

    def partition_paths(
        self,
        *,
        station: str | None = None,
        date: str | None = None,
        hour: str | int | None = None,
    ) -> tuple[str, ...]:
        """按清单做分区裁剪，返回命中的相对路径。

        裁剪规则与 ``manifest.iter_data_files()`` 一致：三个条件都是**精确匹配**，
        不做范围推断——列表里的 ``hour=07`` 就是 07 点那个分区。
        """
        wanted_hour = None if hour is None else f"{int(hour):02d}"
        hits: list[str] = []
        for path in self.paths:
            parts = path.split("/")
            if len(parts) != 4:
                continue
            try:
                item_station = parts[0].split("=", 1)[1]
                item_date = parts[1].split("=", 1)[1]
                item_hour = parts[2].split("=", 1)[1]
            except IndexError:  # pragma: no cover - 布局不对的路径
                continue
            if station is not None and item_station != station:
                continue
            if date is not None and item_date != date:
                continue
            if wanted_hour is not None and item_hour != wanted_hour:
                continue
            hits.append(path)
        return tuple(hits)

    def field_types_hint(self) -> dict[str, str]:
        """字段 → 「时间/数值/文本」的粗分类，给规划器与提示词用。"""
        from .manifest import TIME_FIELDS

        hints: dict[str, str] = {}
        numeric = {alias for names in METRIC_ALIASES.values() for alias in names}
        numeric |= set(METRIC_ALIASES)
        for name in self.fields:
            if name in TIME_FIELDS:
                hints[name] = "时间"
            elif name in numeric or name in METRIC_ALIASES:
                hints[name] = "数值"
            else:
                hints[name] = "文本"
        return hints

    def describe(self) -> str:
        """一段给人/给模型读的中文摘要。答案里带出处时可以直接附上。"""
        if self.partition_count == 0:
            return f"数据集 {self.root}：{self.note or '清单为空'}"
        lines = [
            f"数据集：{self.root}",
            f"分区：{self.partition_count} 个；行数：{self.total_rows}；"
            f"字节：{self.total_bytes}",
            f"时段：{self.min_time or '未知'} … {self.max_time or '未知'}（时间字段 {self.time_field}）",
            "台站：" + "、".join(
                f"{item.station}({item.partitions} 分区/{item.rows} 行)" for item in self.stations
            ),
            "字段：" + ("、".join(self.fields) if self.fields else "未知"),
        ]
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "fieldstation.metadata_card",
            "version": 1,
            "root": self.root,
            "partition_count": self.partition_count,
            "total_rows": self.total_rows,
            "total_bytes": self.total_bytes,
            "time_field": self.time_field,
            "min_time": self.min_time,
            "max_time": self.max_time,
            "dates": list(self.dates),
            "stations": [item.to_dict() for item in self.stations],
            "fields": list(self.fields),
            "paths": list(self.paths),
            "note": self.note,
        }


def _time_weight(value: str) -> float | None:
    dt = coerce_datetime(value)
    return None if dt is None else dt.timestamp()


# ---------------------------------------------------------------- 只读与子集校验
def _strip_quoted(text: str) -> str:
    """把引号内的字符换成空格（保留长度），供关键字/函数名扫描。"""
    out: list[str] = []
    i = 0
    n = len(text)
    quote = ""
    while i < n:
        ch = text[i]
        if quote:
            if ch == quote:
                if i + 1 < n and text[i + 1] == quote:
                    out.append("  ")
                    i += 2
                    continue
                quote = ""
            out.append(" ")
            i += 1
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            out.append(" ")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def ensure_read_only(sql: str) -> str:
    """只放行单条 ``SELECT``/``WITH``。EV-20 的 ``E_READONLY`` 就在这里落地。

    拒绝时抛 :class:`ReadOnlyError`（``code='E_READONLY'``），消息里带首词，
    便于上层原样回给用户。
    """
    text = sql.strip()
    if not text:
        raise ReadOnlyError("SQL 为空")
    # 去掉结尾的一个分号；中间再有分号就是多条语句
    if text.endswith(";"):
        text = text[:-1].rstrip()
    if ";" in _strip_quoted(text):
        raise ReadOnlyError(f"只允许单条语句；检测到分号：{sql[:80]!r}")
    bare = _strip_quoted(text)
    head = re.match(r"\s*([A-Za-z_]+)", bare)
    if not head:
        raise ReadOnlyError(f"无法识别的语句：{sql[:80]!r}")
    if head.group(1).lower() not in _READ_ONLY_HEADS:
        raise ReadOnlyError(
            f"只读：拒绝执行以 {head.group(1).upper()} 开头的语句（E_READONLY）"
        )
    words = {word.lower() for word in re.findall(r"[A-Za-z_]+", bare)}
    forbidden = sorted(words & _FORBIDDEN_WORDS)
    if forbidden:
        raise ReadOnlyError(
            f"只读：语句里出现写/管理关键字 {forbidden}（E_READONLY）"
        )
    return text


def ensure_supported_sql(sql: str) -> str:
    """确认 SQL 只用 ``dialects.py`` 认识的构造与白名单聚合函数。

    「支持」的口径写实一点：**函数名白名单 + 只读 + 单语句**。不加这层，规则规划器
    某天多拼一个函数，就会在 DuckDB 上悄悄跑出另一种结果，而不是明确报错。
    """
    bare = _strip_quoted(ensure_read_only(sql))
    called = {name.lower() for name in re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", bare)}
    unknown = sorted(called - SUPPORTED_SQL_FUNCTIONS)
    if unknown:
        raise UnsupportedSqlError(
            f"SQL 用了白名单外的函数 {unknown}；支持：{sorted(SUPPORTED_SQL_FUNCTIONS)}"
        )
    if not re.search(r"\bFROM\s+" + OBS_VIEW + r"\b", bare, re.IGNORECASE):
        raise UnsupportedSqlError(f"SQL 必须从视图 {OBS_VIEW} 查询")
    return sql.strip()


# ---------------------------------------------------------------- 规划
@dataclass(frozen=True)
class Plan:
    """一次「问题 → 查询」的产物。

    ``sql`` 是给人看、给审计留痕的 DuckDB 兼容子集；``spec`` 是内置引擎能执行的等价
    描述（规划器给不出时为 ``None``，那就只能靠 SQL 引擎）。``note`` 记录**哪几条规则
    命中了**——不写这个，规则规划器就是个黑箱。
    """

    question: str
    sql: str
    planner: str
    spec: QuerySpec | None = None
    station: str | None = None
    date: str | None = None
    hour: str | None = None
    metric: str | None = None
    group_by: str | None = None
    bucket: str | None = None
    limit: int | None = None
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "sql": self.sql,
            "planner": self.planner,
            "station": self.station,
            "date": self.date,
            "hour": self.hour,
            "metric": self.metric,
            "group_by": self.group_by,
            "bucket": self.bucket,
            "limit": self.limit,
            "note": self.note,
            "has_builtin_spec": self.spec is not None,
        }


@runtime_checkable
class SqlPlanner(Protocol):
    """可注入的规划器协议。

    上层接真模型时实现这一个方法即可：把问题与元数据卡交给模型，拿回
    ``Plan(sql=..., spec=..., note=...)``。本模块**不关心**模型是本地 Ollama 还是
    远端 API，也不在这里发起任何网络请求。
    """

    name: str

    def plan(self, question: str, card: MetadataCard | None = None) -> Plan: ...


_DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_HOUR_PATTERNS = (
    re.compile(r"(\d{1,2})\s*点"),
    re.compile(r"\b(\d{1,2}):00\b"),
    re.compile(r"hour\s*=\s*(\d{1,2})", re.IGNORECASE),
    re.compile(r"(\d{1,2})\s*时"),
)
_LIMIT_PATTERNS = (
    re.compile(r"\btop\s*(\d+)\b", re.IGNORECASE),
    re.compile(r"前\s*(\d+)\s*[条个行]"),
    re.compile(r"限制\s*(\d+)"),
)
_STATION_TOKEN = re.compile(r"\b([A-Z]{4})\b")
_STATION_EQ = re.compile(r"station\s*=\s*'?([A-Za-z0-9_\-]+)'?", re.IGNORECASE)


def _lit(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _find_ci(text: str, needle: str) -> int | None:
    """大小写无关的 ``str.find``；找不到返回 ``None``（不是 ``-1``，避免被当最小下标）。"""
    if not needle:
        return None
    position = text.lower().find(needle.lower())
    return None if position < 0 else position


def where_clause(
    *,
    station: str | None = None,
    date: str | None = None,
    hour: str | None = None,
) -> str:
    """拼分区过滤条件（**不带** ``WHERE`` 前缀），空条件返回空串。

    用分区列而不是 ``epoch_utc`` 范围：DuckDB 读 NDJSON 时会把目录名推成
    ``station``/``date``/``hour`` 三列（已实测），按它们过滤才是真正的分区裁剪；
    写成时间范围反而要扫全部文件。``hour`` 是字符串列，比较用 ``'07'``。
    """
    parts: list[str] = []
    if station:
        parts.append(f"station = {_lit(station)}")
    if date:
        parts.append(f"date = DATE {_lit(date)}")
    if hour:
        parts.append(f"hour = {_lit(hour)}")
    return " AND ".join(parts)


class RuleBasedPlanner:
    """确定性关键词规则，离线可复现。

    只做**它认得的**几种问法；认不出就抛 :class:`UnsupportedQuestion`，并附上它
    认识的台站与字段。故意保守：一条猜出来的 SQL 比一句「不会」危险得多。
    """

    name = "rule"

    def plan(self, question: str, card: MetadataCard | None = None) -> Plan:
        text = str(question or "").strip()
        if not text:
            raise UnsupportedQuestion("问题为空")
        lowered = text.lower()

        station = self._station(text, card)
        date = self._date(text, card)
        hour = self._hour(text)
        limit = self._limit(text)
        metric = self._metric(text, card, default="cn0_dbhz")
        dimension = self._group_dimension(text)
        bucket = "1h" if self._wants_hourly(text) else None
        flags: list[str] = []

        if station:
            flags.append(f"台站={station}")
        if date:
            flags.append(f"日期={date}")
        if hour:
            flags.append(f"小时={hour}")
        if limit:
            flags.append(f"limit={limit}")

        where = self._where(station=station, date=date, hour=hour)

        # 1) 历元数（多一个 DISTINCT 维度，单独一支）
        if any(word in text for word in ("历元", "epoch")) or "distinct" in lowered:
            sql = f"SELECT count(DISTINCT {DEFAULT_TIME_FIELD}) AS epochs FROM {OBS_VIEW}{where}"
            spec = QuerySpec(
                aggregates=(Aggregate("count_distinct", DEFAULT_TIME_FIELD, "epochs"),),
                station=station,
                date=date,
                hour=hour,
            )
            flags.append("聚合=count(DISTINCT epoch)|命中『历元』")
            return self._plan(text, sql, spec, station, date, hour, None, None, None, limit, flags)

        # 2) 只有极端值（最大/最小/最高/最低 + 指标）
        extreme = self._extreme(text)
        if extreme and not self._wants_count(text):
            alias = f"{extreme}_{metric}"
            sql = (
                f"SELECT {extreme}({metric}) AS {alias} FROM {OBS_VIEW}{where}"
            )
            spec = QuerySpec(
                aggregates=(Aggregate(extreme, metric, alias),),
                station=station,
                date=date,
                hour=hour,
            )
            flags.append(f"聚合={extreme}({metric})|命中『最大/最小』")
            return self._plan(text, sql, spec, station, date, hour, metric, None, None, limit, flags)

        # 3) 均值
        if any(word in text for word in ("平均", "均值", "avg", "mean")):
            alias = f"avg_{metric}"
            sql = f"SELECT avg({metric}) AS {alias} FROM {OBS_VIEW}{where}"
            spec = QuerySpec(
                aggregates=(Aggregate("avg", metric, alias),),
                station=station,
                date=date,
                hour=hour,
            )
            flags.append(f"聚合=avg({metric})|命中『平均』")
            return self._plan(text, sql, spec, station, date, hour, metric, None, None, limit, flags)

        # 4) 按小时聚合。SQL 与 ``bench.py`` 的 B04 一字不差，这样同一句话在
        #    DuckDB / ClickHouse 两侧走的是同一条 ``dialects`` 翻译路径。
        if bucket:
            sql = (
                f"SELECT time_bucket('1 hour', {DEFAULT_TIME_FIELD}) AS bucket, "
                f"count(*) AS row_count FROM {OBS_VIEW}{where} GROUP BY 1 ORDER BY 1"
            )
            spec = QuerySpec(
                bucket=bucket,
                aggregates=(Aggregate("count", "*", "row_count"),),
                order_by=(("bucket", "asc"),),
                station=station,
                date=date,
                hour=hour,
            )
            flags.append("分组=时间桶 1h|命中『每小时』")
            return self._plan(text, sql, spec, station, date, hour, None, None, bucket, limit, flags)

        # 5) 按维度分组
        if dimension:
            direction = self._order_direction(text, limit is not None)
            if direction == "desc" or limit:
                sql = (
                    f"SELECT {dimension}, count(*) AS row_count FROM {OBS_VIEW}{where} "
                    f"GROUP BY {dimension} ORDER BY row_count {direction}"
                )
                order_by = (("row_count", direction),)
            else:
                sql = (
                    f"SELECT {dimension}, count(*) AS row_count FROM {OBS_VIEW}{where} "
                    f"GROUP BY {dimension} ORDER BY {dimension}"
                )
                order_by = ((dimension, "asc"),)
            if limit:
                sql += f" LIMIT {int(limit)}"
            spec = QuerySpec(
                group_by=(dimension,),
                aggregates=(Aggregate("count", "*", "row_count"),),
                order_by=order_by,
                limit=limit,
                station=station,
                date=date,
                hour=hour,
            )
            flags.append(f"分组={dimension}|命中维度别名")
            return self._plan(text, sql, spec, station, date, hour, None, dimension, None, limit, flags)

        # 6) 兜底：行数
        sql = f"SELECT count(*) AS row_count FROM {OBS_VIEW}{where}"
        spec = QuerySpec(
            aggregates=(Aggregate("count", "*", "row_count"),),
            station=station,
            date=date,
            hour=hour,
        )
        flags.append("聚合=count(*)|默认按行数回答")
        return self._plan(text, sql, spec, station, date, hour, None, None, None, limit, flags)

    # -- 规则细节 -------------------------------------------------
    def _plan(
        self,
        question: str,
        sql: str,
        spec: QuerySpec | None,
        station: str | None,
        date: str | None,
        hour: str | None,
        metric: str | None,
        dimension: str | None,
        bucket: str | None,
        limit: int | None,
        flags: Sequence[str],
    ) -> Plan:
        return Plan(
            question=question,
            sql=sql,
            planner=self.name,
            spec=spec,
            station=station,
            date=date,
            hour=hour,
            metric=metric,
            group_by=dimension,
            bucket=bucket,
            limit=limit,
            note="；".join(flags),
        )

    def _station(self, text: str, card: MetadataCard | None) -> str | None:
        match = _STATION_EQ.search(text)
        if match:
            return self._known_station(match.group(1), card)
        candidates = card.station_names if card is not None else ()
        for name in candidates:
            if name and name in text:
                return name
        # 没有清单（或清单里没有）时退化：四个大写字母当站名（WUHN/BJFS/SHAO 都是这形状）
        token = _STATION_TOKEN.search(text)
        if token and token.group(1).lower() not in {"null", "true"}:
            return self._known_station(token.group(1), card)
        return None

    def _known_station(self, name: str, card: MetadataCard | None) -> str:
        """清单在场时校验站名。**不认识的站名必须报错**，不能悄悄查成全站。

        这一条是防「问 WUHN 结果给了 BJFS 的数」：没有清单时无法校验，只能放行，
        并把这一点写进 ``Plan.note``（由调用方从 ``card.partition_count == 0`` 看出）。
        """
        if card is None or not card.station_names:
            return name
        if name not in card.station_names:
            raise UnsupportedQuestion(
                f"清单里没有台站 {name!r}；现有台站：{list(card.station_names)}"
            )
        return name

    def _date(self, text: str, card: MetadataCard | None) -> str | None:
        """只认**问题里显式写的**日期。

        刻意不从清单推「唯一日期」：那会让「只看 07 点这一小时」被悄悄加上一个
        ``date = ...`` 过滤，用户看到的 SQL 与他的问题不是一回事。日期范围该由
        上层在追问里确认。
        """
        match = _DATE_RE.search(text)
        if match:
            return match.group(1)
        return None

    def _hour(self, text: str) -> str | None:
        for pattern in _HOUR_PATTERNS:
            match = pattern.search(text)
            if match:
                value = int(match.group(1))
                if 0 <= value <= 23:
                    return f"{value:02d}"
        return None

    def _limit(self, text: str) -> int | None:
        for pattern in _LIMIT_PATTERNS:
            match = pattern.search(text)
            if match:
                value = int(match.group(1))
                if value > 0:
                    return value
        return None

    def _metric(
        self, text: str, card: MetadataCard | None, *, default: str
    ) -> str:
        """问题里点名的指标 → 字段名。**点名的列不存在时报错**，不许换成默认指标。

        这是防「问仰角、答载噪比」：指标一旦被问题显式点出，答错比答不出更糟。
        清单为空（无法校验）时只能放行——那时也没有别的东西可校验。
        """
        mentioned: list[tuple[int, str]] = []
        for field_name, aliases in METRIC_ALIASES.items():
            for alias in aliases:
                position = _find_ci(text, alias)
                if position is not None:
                    mentioned.append((position, field_name))
                    break
        if not mentioned:
            return default
        # 多个别名同时命中时取**出现位置最靠前**的那个：问句的主语通常在前面，
        # 后面的往往是补充说明。用大小写无关的位置，否则 "CN0" 会被算成 -1。
        mentioned.sort()
        field_name = mentioned[0][1]
        if card is not None and card.fields and field_name not in card.fields:
            available = sorted(set(METRIC_ALIASES) & set(card.fields))
            raise UnsupportedQuestion(
                f"数据集里没有字段 {field_name!r}；现有数值字段：{available}"
            )
        return field_name

    def _group_dimension(self, text: str) -> str | None:
        found: list[tuple[int, str]] = []
        for dimension, aliases in GROUP_ALIASES.items():
            for alias in aliases:
                position = _find_ci(text, alias)
                if position is not None:
                    found.append((position, dimension))
                    break
        if not found:
            return None
        found.sort()
        return found[0][1]

    def _wants_hourly(self, text: str) -> bool:
        return any(
            word in text
            for word in ("每小时", "按小时", "逐小时", "小时桶", "hourly", "每小时多少")
        )

    def _wants_count(self, text: str) -> bool:
        return any(word in text for word in ("多少行", "行数", "多少条", "计数", "几个", "多少个"))

    def _extreme(self, text: str) -> str | None:
        if any(word in text for word in ("最大", "最高", "峰值")):
            return "max"
        if any(word in text for word in ("最小", "最低")):
            return "min"
        return None

    def _order_direction(self, text: str, has_limit: bool) -> str:
        if any(word in text for word in ("最少", "最低", "最少")):
            return "asc"
        if any(word in text for word in ("最多", "最高", "最大", "降序")) or has_limit:
            return "desc"
        return "asc"

    def _where(
        self,
        *,
        station: str | None,
        date: str | None,
        hour: str | None,
    ) -> str:
        clause = where_clause(station=station, date=date, hour=hour)
        return "" if not clause else " WHERE " + clause


# ---------------------------------------------------------------- 答案
@dataclass(frozen=True)
class QueryAnswer:
    """一次问答的完整记账。**三样必须齐全**：``partition_paths`` / ``sql`` / ``row_count``。

    ``row_count`` 是**命中的源数据行数**（WHERE 之后、聚合之前的行数），与 EV-17/EV-21
    的口径一致；聚合产生的行数另记 ``result_rows``。两个数混淆会让「4,924,800 行」
    被读成「结果有四百多万行」。
    """

    question: str
    sql: str
    engine: str
    row_count: int
    result_rows: int
    columns: tuple[str, ...]
    rows: tuple[dict[str, Any], ...]
    partition_paths: tuple[str, ...]
    duration_ms: float
    planner: str
    note: str = ""
    truncated: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def partition_count(self) -> int:
        return len(self.partition_paths)

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "sql": self.sql,
            "engine": self.engine,
            "row_count": self.row_count,
            "result_rows": self.result_rows,
            "columns": list(self.columns),
            "rows": [dict(row) for row in self.rows],
            "partition_paths": list(self.partition_paths),
            "partition_count": self.partition_count,
            "duration_ms": round(self.duration_ms, 3),
            "planner": self.planner,
            "note": self.note,
            "truncated": self.truncated,
            "metadata": dict(self.metadata),
        }

    def describe(self) -> str:
        """一段可以直接回给用户的中文答复骨架（数字与出处都在里面）。"""
        lines = [f"问题：{self.question}", f"SQL：{self.sql}"]
        lines.append(
            f"命中 {self.partition_count} 个分区、{self.row_count} 行；"
            f"结果 {self.result_rows} 行"
        )
        if self.partition_paths:
            shown = list(self.partition_paths[:3])
            more = f" 等 {self.partition_count} 个" if self.partition_count > 3 else ""
            lines.append("分区：" + "、".join(shown) + more)
        if self.rows:
            lines.append("结果：" + json.dumps(self.rows[0], ensure_ascii=False, default=str))
        if self.truncated:
            lines.append("（结果已按 max_rows 截断）")
        return "\n".join(lines)


def answer_question(
    root: str | Path,
    question: str,
    *,
    planner: SqlPlanner | None = None,
    card: MetadataCard | None = None,
    engine: str = "auto",
    max_rows: int = 1000,
    duckdb: DuckDBEngine | None = None,
) -> QueryAnswer:
    """把一句自然语言问题变成「SQL + 分区 + 行数」的答案。

    ``engine``：``auto``（默认，优先 DuckDB）/ ``duckdb`` / ``builtin``。
    规划器给不出等价 ``QuerySpec`` 且 DuckDB 不可用时抛
    :class:`EngineUnavailable` 并带 ``REQUIRES_SQL_ENGINE``，不返回空答案。
    """
    started = perf_counter()
    root_path = Path(root)
    active_card = card if card is not None else MetadataCard.from_root(root_path)
    active_planner = planner if planner is not None else RuleBasedPlanner()
    plan = active_planner.plan(question, active_card)
    sql = ensure_supported_sql(plan.sql)

    # 分区裁剪：清单里有就精确报出，没有清单就诚实报空并说明。
    partition_paths = active_card.partition_paths(
        station=plan.station, date=plan.date, hour=plan.hour
    )
    provenance: dict[str, Any] = {
        "plan": plan.to_dict(),
        "card": {
            "partition_count": active_card.partition_count,
            "total_rows": active_card.total_rows,
            "min_time": active_card.min_time,
            "max_time": active_card.max_time,
            "stations": list(active_card.station_names),
        },
    }
    if active_card.partition_count == 0:
        provenance["warning"] = (
            active_card.note or "清单为空，partition_paths 无法给出来源"
        )

    chosen = str(engine).strip().lower()
    if chosen not in ("auto", "duckdb", "builtin"):
        raise KnowledgeError(f"未知引擎 {engine!r}；可选 auto / duckdb / builtin")

    duck = duckdb if duckdb is not None else DuckDBEngine(root_path)
    fallback_note = ""

    if chosen in ("auto", "duckdb") and duck.available():
        where = where_clause(station=plan.station, date=plan.date, hour=plan.hour)
        try:
            result = duck.execute(sql)
            row_count = _duckdb_scan_count(duck, where)
        except EngineError as exc:
            # DuckDB 装了但跑不动（典型：时间类型的 Python 解码依赖 pytz 而环境没装）。
            # auto 模式**回落内置引擎并明示**——这是 docs/operations/environment.md
            # 的硬约束「不许静默」；显式 engine='duckdb' 时把错误原样抛出。
            if chosen == "duckdb":
                raise
            fallback_note = f"DuckDB 执行失败已回落内置引擎：{exc}"
        else:
            engine_used = "duckdb"
            engine_note = ["engine=duckdb（SQL 直跑）"] if chosen == "auto" else []
            return _build_answer(
                question=question,
                sql=sql,
                plan=plan,
                result=result,
                row_count=row_count,
                engine_used=engine_used,
                partition_paths=partition_paths,
                provenance=provenance,
                engine_note=engine_note,
                max_rows=max_rows,
                started=started,
            )
    elif chosen == "duckdb":
        raise EngineUnavailable("duckdb", duck.unavailable_reason())

    # 走到这里说明：选了 builtin，或 auto/duckdb 的 DuckDB 跑不动了。
    if plan.spec is None:
        raise EngineUnavailable(
            "builtin",
            f"这条问题只有 SQL 能表达，而 SQL 引擎不可用：{duck.unavailable_reason()}"
            + (f"（{fallback_note}）" if fallback_note else ""),
            hint=REQUIRES_SQL_ENGINE,
        )
    result = execute_spec(root_path, plan.spec)
    row_count = _builtin_scan_count(root_path, plan.spec)
    engine_note = [
        fallback_note
        or (
            "engine=builtin：DuckDB 不可用，按等价 QuerySpec 执行；SQL 仅作为可审计的"
            f"口径记录（{REQUIRES_SQL_ENGINE} 时可换回 SQL 直跑）"
        )
    ]
    return _build_answer(
        question=question,
        sql=sql,
        plan=plan,
        result=result,
        row_count=row_count,
        engine_used="builtin",
        partition_paths=partition_paths,
        provenance=provenance,
        engine_note=engine_note,
        max_rows=max_rows,
        started=started,
    )


def _build_answer(
    *,
    question: str,
    sql: str,
    plan: Plan,
    result: QueryResult,
    row_count: int,
    engine_used: str,
    partition_paths: Sequence[str],
    provenance: dict[str, Any],
    engine_note: Sequence[str],
    max_rows: int | None,
    started: float,
) -> QueryAnswer:
    all_rows = result.rows
    truncated = max_rows is not None and len(all_rows) > max_rows
    shown = all_rows if not truncated else all_rows[:max_rows]
    note = "；".join(filter(None, [plan.note, *engine_note]))
    return QueryAnswer(
        question=str(question),
        sql=sql,
        engine=engine_used,
        row_count=row_count,
        result_rows=len(all_rows),
        columns=tuple(result.columns),
        rows=tuple(dict(row) for row in shown),
        partition_paths=tuple(partition_paths),
        duration_ms=(perf_counter() - started) * 1000.0,
        planner=plan.planner,
        note=note,
        truncated=truncated,
        metadata=provenance,
    )


def _duckdb_scan_count(engine: DuckDBEngine, where: str) -> int:
    """命中的源行数。DuckDB 上再跑一次 count，比从结果反推可靠。"""
    sql = f"SELECT count(*) AS n FROM {OBS_VIEW}"
    if where:
        sql += f" WHERE {where}"
    result = engine.execute(sql)
    value = result.rows[0].get("n") if result.rows else 0
    return int(value or 0)


def _builtin_scan_count(root: Path, spec: QuerySpec) -> int:
    """内置引擎口径的命中行数：同样的 WHERE 条件下逐行匹配。"""
    if not spec.filters and spec.station is None and spec.date is None and spec.hour is None:
        from .query import count_rows

        return int(count_rows(root))
    result = execute_spec(
        root,
        QuerySpec(
            filters=spec.filters,
            aggregates=(Aggregate("count", "*", "n"),),
            station=spec.station,
            date=spec.date,
            hour=spec.hour,
        ),
    )
    return int(result.scalar() or 0)


# ---------------------------------------------------------------- 手册索引
class HandbookUnavailable(KnowledgeError):
    """llama_index 不在，或索引还没建。消息里带「该怎么做」。"""


class EmbeddingUnavailable(HandbookUnavailable):
    """没有可用的 embedding 模型。**不是** ImportError。"""


class HandbookError(KnowledgeError):
    """建索引/检索过程中出错。"""


@dataclass(frozen=True)
class HandbookHit:
    """一条检索命中。**出处必须能回到文档**：``doc_id`` 与 ``source`` 原样带出。"""

    text: str
    score: float | None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def doc_id(self) -> str | None:
        value = self.metadata.get("doc_id")
        return None if value is None else str(value)

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "score": self.score, "metadata": dict(self.metadata)}


@dataclass(frozen=True)
class HandbookResult:
    """不会抛异常的检索结果：``reason`` 非空时 ``hits`` 为空，且不得假装查到了。"""

    hits: tuple[HandbookHit, ...] = ()
    reason: str = ""
    indexed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "hits": [item.to_dict() for item in self.hits],
            "reason": self.reason,
            "indexed": self.indexed,
        }

    def describe(self) -> str:
        if self.reason:
            return f"手册检索不可用：{self.reason}"
        if not self.hits:
            return "手册检索：没有命中（不是「没有这条规程」，而是相似度都不够）"
        return "；".join(
            f"{item.doc_id or '?'}({item.score if item.score is None else round(item.score, 4)})"
            for item in self.hits
        )


def handbook_available(module_name: str = DEFAULT_LLAMA_MODULE) -> bool:
    """``llama_index.core`` 是否可导入。延迟探测，不抛异常。"""
    try:
        importlib.import_module(module_name)
        importlib.import_module(module_name + ".embeddings.mock_embed_model")
        importlib.import_module(module_name + ".node_parser")
    except Exception:
        return False
    return True


def _load_llama(module_name: str) -> tuple[Any, Any, Any, Any]:
    try:
        core = importlib.import_module(module_name)
        storage = importlib.import_module(module_name + ".storage")
        splitter_module = importlib.import_module(module_name + ".node_parser")
        base_embed = importlib.import_module(
            module_name + ".base.embeddings.base"
        )
    except Exception as exc:
        raise HandbookUnavailable(
            f"{module_name} 不可用：手册向量检索是可选能力，缺包时请退 KB 全文检索"
            "（pip install llama-index-core）"
        ) from exc
    return core, storage, splitter_module, base_embed


def _make_hashing_embedding(module_name: str, dim: int) -> Any:
    """字符二元组哈希向量化器（确定性、零网络）。

    **它只保证词面重叠**：同一段文本永远同一向量，与文本共享字面片段的查询排在前面。
    用来在离线环境验证「建索引 → 落盘 → 重载 → 检索」这条管线的接线与出处传递，
    **不**用来证明语义检索质量。真语义需要上层注入真 embedding 模型（``embed_model=``）。
    """
    core, _storage, _splitter, base = _load_llama(module_name)
    BaseEmbedding = base.BaseEmbedding

    def _vector(text: str) -> list[float]:
        cleaned = "".join(ch for ch in str(text).lower() if not ch.isspace())
        grams = [cleaned[i : i + 2] for i in range(max(1, len(cleaned) - 1))] or [cleaned]
        vector = [0.0] * dim
        for gram in grams:
            digest = hashlib.sha1(gram.encode("utf-8")).digest()
            vector[int.from_bytes(digest[:8], "big") % dim] += 1.0
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    class _HashingEmbedding(BaseEmbedding):  # type: ignore[misc, valid-type]
        embed_dim: int = 256

        def _get_text_embedding(self, text: str) -> list[float]:
            return _vector(text)

        def _get_query_embedding(self, query: str) -> list[float]:
            return _vector(query)

        async def _aget_text_embedding(self, text: str) -> list[float]:
            return _vector(text)

        async def _aget_query_embedding(self, query: str) -> list[float]:
            return _vector(query)

    return _HashingEmbedding(embed_dim=dim)


def _document_text(doc: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """把一条手册条目拆成「送进索引的文本」与「必须带出来的元数据」。"""
    body = doc.get("body") or doc.get("text") or doc.get("content")
    if not isinstance(body, str) or not body.strip():
        raise HandbookError(f"手册条目缺少 body/text：{sorted(doc)}")
    title = doc.get("title")
    text = f"{title}\n{body}" if isinstance(title, str) and title.strip() else body
    metadata = {
        key: str(doc[key])
        for key in ("doc_id", "title", "category", "source")
        if isinstance(doc.get(key), str) and doc[key].strip()
    }
    return text, metadata


class HandbookIndex:
    """手册向量索引的薄封装。**默认不建索引**，必须显式 ``build()``。

    ``embed_model`` 三选一：

    - ``None``（默认）：抛 :class:`EmbeddingUnavailable`——本模块不替你决定模型；
    - ``"hashing"``：用内置的字符二元组哈希向量化器，离线可跑但只保证词面重叠；
    - 任意 llama_index ``BaseEmbedding`` 实例：真实语义向量，由上层注入。
    """

    def __init__(
        self,
        *,
        module_name: str = DEFAULT_LLAMA_MODULE,
        embed_model: Any = None,
        embed_dim: int = 256,
        chunk_size: int = 512,
        chunk_overlap: int = 32,
        similarity_top_k: int = 3,
    ) -> None:
        self.module_name = module_name
        self.embed_dim = embed_dim
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.similarity_top_k = similarity_top_k
        self._embed_model_spec = embed_model
        self._embed_model: Any = None
        self._index: Any = None
        self._built = False

    # -- 能力 -----------------------------------------------------
    def available(self) -> bool:
        return handbook_available(self.module_name)

    @property
    def built(self) -> bool:
        """索引是否已建/已载入。给调用方判断「能不能查」，不必碰私有属性。"""
        return self._built

    def unavailable_reason(self) -> str:
        if self.available():
            return ""
        return f"未安装 {self.module_name}；手册向量检索不可用（KB 全文检索仍可用）"

    def embed_model(self) -> Any:
        """解析 ``embed_model`` 参数。默认拒绝：不替调用方决定模型。"""
        if self._embed_model is not None:
            return self._embed_model
        if self._embed_model_spec is None:
            raise EmbeddingUnavailable(
                "未指定 embed_model：本模块不内置语义模型。离线自检请显式传 "
                'embed_model="hashing"（词面相似，不是语义）；生产请注入真模型实例'
            )
        if self._embed_model_spec == "hashing":
            self._embed_model = _make_hashing_embedding(self.module_name, self.embed_dim)
            return self._embed_model
        self._embed_model = self._embed_model_spec
        return self._embed_model

    # -- 建索引 ---------------------------------------------------
    def build(
        self,
        documents: Iterable[Mapping[str, Any] | str],
        *,
        persist_dir: str | Path | None = None,
    ) -> int:
        """建索引并（可选）落盘，返回索引进去的文本块数。

        ``documents`` 里的 dict 会保留 ``doc_id/title/category/source`` 到元数据，
        检索命中时原样带回——这是「答案带出处」的地基。
        """
        core, _storage, splitter_module, _base = _load_llama(self.module_name)
        model = self.embed_model()

        docs = []
        for item in documents:
            if isinstance(item, str):
                text, metadata = item, {}
            elif isinstance(item, Mapping):
                text, metadata = _document_text(item)
            else:
                raise HandbookError(f"不支持的手册条目类型 {type(item).__name__}")
            docs.append(core.Document(text=text, metadata=metadata))
        if not docs:
            raise HandbookError("手册条目为空；不建空索引（会让检索假装有内容）")

        splitter = splitter_module.SentenceSplitter(
            chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap
        )
        try:
            self._index = core.VectorStoreIndex.from_documents(
                docs,
                embed_model=model,
                transformations=[splitter],
            )
        except Exception as exc:
            raise HandbookError(f"建索引失败：{type(exc).__name__}: {exc}") from exc
        self._built = True

        if persist_dir is not None:
            target = Path(persist_dir)
            target.mkdir(parents=True, exist_ok=True)
            self._index.storage_context.persist(persist_dir=str(target))

        return len(docs)

    @classmethod
    def load(
        cls,
        persist_dir: str | Path,
        *,
        module_name: str = DEFAULT_LLAMA_MODULE,
        embed_model: Any = None,
        embed_dim: int = 256,
        similarity_top_k: int = 3,
    ) -> HandbookIndex:
        """从落盘目录重载索引。**必须给同一个 embedding 模型**，否则向量空间不匹配。"""
        core, storage, _splitter, _base = _load_llama(module_name)
        instance = cls(
            module_name=module_name,
            embed_model=embed_model,
            embed_dim=embed_dim,
            similarity_top_k=similarity_top_k,
        )
        model = instance.embed_model()
        directory = Path(persist_dir)
        if not directory.is_dir():
            raise HandbookUnavailable(f"索引目录不存在：{directory}")
        try:
            context = storage.StorageContext.from_defaults(persist_dir=str(directory))
            instance._index = core.load_index_from_storage(
                context, embed_model=model
            )
        except Exception as exc:
            raise HandbookError(f"重载索引失败：{type(exc).__name__}: {exc}") from exc
        instance._built = True
        return instance

    # -- 检索 -----------------------------------------------------
    def query(self, text: str, *, top_k: int | None = None) -> tuple[HandbookHit, ...]:
        """检索。索引没建、依赖缺失都抛明确异常；返回空元组表示「没有足够相似的」。"""
        if self._index is None:
            raise HandbookUnavailable(
                "索引未建立：先 build() 或 load()；默认不建索引是有意为之（要写盘、要模型）"
            )
        limit = self.similarity_top_k if top_k is None else max(1, int(top_k))
        try:
            nodes = self._index.as_retriever(similarity_top_k=limit).retrieve(text)
        except Exception as exc:
            raise HandbookError(f"检索失败：{type(exc).__name__}: {exc}") from exc
        hits: list[HandbookHit] = []
        for node in nodes:
            metadata = dict(getattr(node.node, "metadata", {}) or {})
            hits.append(
                HandbookHit(
                    text=node.node.get_content(),
                    score=None if node.score is None else float(node.score),
                    metadata=metadata,
                )
            )
        return tuple(hits)

    def status(self) -> dict[str, Any]:
        return {
            "module": self.module_name,
            "available": self.available(),
            "reason": self.unavailable_reason(),
            "built": self._built,
            "uses_model": (
                "none"
                if self._embed_model_spec is None
                else ("hashing" if self._embed_model_spec == "hashing" else "injected")
            ),
        }

def search_handbook(
    text: str,
    *,
    index: HandbookIndex | None = None,
    documents: Iterable[Mapping[str, Any] | str] | None = None,
    top_k: int = 3,
    module_name: str = DEFAULT_LLAMA_MODULE,
) -> HandbookResult:
    """不抛异常的检索入口，给「拿不到就当没有」的调用方用。

    三种降级都返回 ``hits=()`` + 说明，绝不返回假的命中：

    1. llama_index 缺失 → ``reason`` 说明缺包；
    2. 没有索引也没有 ``documents`` → ``reason`` 说明未建索引；
    3. 命中为空 → ``reason`` 为空但 ``hits`` 为空（调用方应说「没查到」）。
    """
    if not handbook_available(module_name):
        return HandbookResult(
            reason=f"未安装 {module_name}；手册向量检索不可用（KB 全文检索仍可用）",
            indexed=False,
        )
    active = index
    if active is None:
        if documents is None:
            return HandbookResult(reason="索引未建立，也没有提供手册条目", indexed=False)
        active = HandbookIndex(module_name=module_name, embed_model="hashing")
        try:
            active.build(documents)
        except EmbeddingUnavailable as exc:
            return HandbookResult(reason=str(exc), indexed=False)
        except HandbookError as exc:
            return HandbookResult(reason=str(exc), indexed=False)
    try:
        hits = active.query(text, top_k=top_k)
    except KnowledgeError as exc:
        return HandbookResult(reason=str(exc), indexed=active.built)
    return HandbookResult(hits=hits, indexed=active.built)
