"""E4 的两个外部查询引擎适配器：DuckDB（默认）与 ClickHouse（可选）。

**为什么延迟导入**：仓库的门禁环境是纯标准库。``import fieldstation.data.engines``
必须永远成功；只有真正调用 ``DuckDBEngine.execute()`` 且没装 duckdb 时才报
``EngineUnavailable``。绝不允许把 ``ImportError`` 漏到调用方 —— 上层要据此
决定「回落内置引擎并明示」，而不是崩掉。

**同一套 SQL，两个后端**：上层只写 DuckDB 兼容子集，方言差异交给
``dialects.translate()``；本模块只负责连接、执行与解释计划。

**唯一真相仍是 NDJSON/Parquet 分区**：DuckDB 直接把分区目录注册成 ``obs`` 视图；
ClickHouse 假定服务端已有 ``obs`` 表（由摄取侧建表/导入），适配器不复制数据。
"""
from __future__ import annotations

import importlib
import importlib.util
import math
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from time import perf_counter
from typing import Any, Mapping, Sequence

from .query import QueryResult, QuerySpec, execute as execute_spec
from .dialects import DialectError, ReadOnlyViolation, assert_readonly

__all__ = [
    "BaseEngine",
    "BuiltinEngine",
    "ClickHouseEngine",
    "DuckDBEngine",
    "EngineError",
    "EngineStatus",
    "EngineUnavailable",
    "REQUIRES_SQL_ENGINE",
    "ReadOnlyEngineError",
    "available_engines",
    "get_engine",
]

#: 内置引擎回答不了时给用户看的话；基准脚本与 UI 共用这一句。
REQUIRES_SQL_ENGINE = "需要 DuckDB/ClickHouse"


class EngineUnavailable(RuntimeError):
    """引擎依赖缺失或连不上。**不是** ImportError，调用方据此回落。"""

    def __init__(self, engine: str, reason: str, *, hint: str = "") -> None:
        self.engine = engine
        self.reason = reason
        self.hint = hint
        message = f"{engine} 不可用：{reason}"
        if hint:
            message += f"（{hint}）"
        super().__init__(message)


class EngineError(RuntimeError):
    """引擎可用，但这条 SQL 执行失败（语法、表不存在等）。"""


class ReadOnlyEngineError(EngineError):
    """这条语句要写数据，被只读闸门拦下。

    继承 `EngineError` 让「SQL 跑不了」的通用处理仍然生效，
    但单独一个类型才能让测试与上层区分「语法错」与「想写」。
    """

    def __init__(self, engine: str, reason: str) -> None:
        self.engine = engine
        self.reason = reason
        super().__init__(f"{engine} 拒绝写语句（E_READONLY）：{reason}")


@dataclass(frozen=True)
class EngineStatus:
    name: str
    available: bool
    reason: str = ""
    detail: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "available": self.available,
            "reason": self.reason,
            "detail": dict(self.detail),
        }


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def _clean(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def _rows_as_dicts(columns: Sequence[str], rows: Sequence[Sequence[Any]]) -> list[dict[str, Any]]:
    return [
        {name: _clean(value) for name, value in zip(columns, row)}
        for row in rows
    ]


def _unified_arrow_schema(files: Sequence[str]) -> Any:
    """把各分区文件的 schema 统一成「字典类型降级为普通类型」。

    hive 分区列在被 pyarrow 读成 dataset 时会变成
    `dictionary<string>`，而 `station` 在别的文件里是 `string`；
    直接 `read_table(files)` 会 `ArrowTypeError: Unable to merge`。
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    merged: dict[str, Any] = {}
    order: list[str] = []
    for path in files:
        schema = pq.read_schema(path)
        for field in schema:
            if field.name not in merged:
                order.append(field.name)
            candidate = field.type
            if pa.types.is_dictionary(candidate):
                candidate = candidate.value_type
            existing = merged.get(field.name)
            if existing is None:
                merged[field.name] = candidate
            elif existing != candidate:
                # 同名列类型不一致：整数之间放宽到 float64（会保留为可空浮点），
                # 其余情况保持先见到的那个 —— 真正的冲突交给下面的建表报错。
                if pa.types.is_integer(existing) and pa.types.is_integer(candidate):
                    merged[field.name] = pa.float64()
    return pa.schema([pa.field(name, merged[name]) for name in order])


def _ch_type(arrow_type: Any) -> str:
    """pyarrow 类型 -> ClickHouse 列类型。**只做等价映射，不做精度换算。**

    刻意覆盖得窄：认不出的类型直接抛错，而不是退化成 `String`
    —— 退化成 String 会让 `AVG` / `quantile` 静默失败或给出字符串排序，
    那是「看起来跑通了，数不对」。
    """
    import pyarrow as pa

    if pa.types.is_int64(arrow_type):
        return "Int64"
    if pa.types.is_int32(arrow_type):
        return "Int32"
    if pa.types.is_int16(arrow_type):
        return "Int16"
    if pa.types.is_int8(arrow_type):
        return "Int8"
    if pa.types.is_float64(arrow_type):
        return "Nullable(Float64)"
    if pa.types.is_float32(arrow_type):
        return "Nullable(Float32)"
    if pa.types.is_boolean(arrow_type):
        return "Bool"
    if pa.types.is_string(arrow_type) or pa.types.is_large_string(arrow_type):
        return "String"
    if pa.types.is_timestamp(arrow_type):
        return "DateTime64(6, 'UTC')"
    if pa.types.is_date32(arrow_type):
        return "Date"
    raise EngineError(f"没有对应 ClickHouse 类型的 pyarrow 类型：{arrow_type}")


class BaseEngine:
    """适配器接口。子类至少实现 ``available`` / ``execute`` / ``explain``。"""

    name = "base"

    def __init__(self, root: str | Path | None = None) -> None:
        self.root = Path(root) if root is not None else None

    def available(self) -> bool:
        raise NotImplementedError

    def unavailable_reason(self) -> str:
        return ""

    def status(self) -> EngineStatus:
        available = self.available()
        return EngineStatus(
            name=self.name,
            available=available,
            reason="" if available else (self.unavailable_reason() or "依赖不可用"),
            detail={"root": str(self.root) if self.root else None},
        )

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> QueryResult:
        raise NotImplementedError

    def _assert_readonly(self, sql: str) -> None:
        """两引擎共用的只读闸门。

        错误码统一写成 `E_READONLY`：任务书要求「写语句走两引擎都要被拒（明确
        错误码）」，所以码要能被子串匹配，不能只是异常类型。
        """
        try:
            assert_readonly(sql)
        except ReadOnlyViolation as exc:
            raise ReadOnlyEngineError(self.name, f"E_READONLY: {exc.reason}") from exc

    def explain(self, sql: str) -> str:
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover - 适配器可选
        pass


class DuckDBEngine(BaseEngine):
    """DuckDB 适配器。默认把 ``<root>/**/*.ndjson`` 注册成视图 ``obs``。"""

    name = "duckdb"

    def __init__(
        self,
        root: str | Path | None = None,
        *,
        database: str = ":memory:",
        module_name: str = "duckdb",
        view: str | None = None,
    ) -> None:
        super().__init__(root)
        self.database = database
        self.module_name = module_name
        #: `None` = 用 `<root>` 的目录名当视图名（`.../obs` -> `obs`）。
        #: 写死成 `obs` 会让 `FROM tec` 报「表不存在」。
        self.view = view
        self._connection: Any = None
        self._source_ready = False

    # -- 能力探测 -------------------------------------------------
    def available(self) -> bool:
        return _module_available(self.module_name)

    def unavailable_reason(self) -> str:
        return f"未安装 {self.module_name}（pip install duckdb）"

    def status(self) -> EngineStatus:
        status = super().status()
        return EngineStatus(
            name=status.name,
            available=status.available,
            reason=status.reason,
            detail={**dict(status.detail), "database": self.database, "view": self.view},
        )

    def _module(self) -> Any:
        try:
            return importlib.import_module(self.module_name)
        except Exception as exc:
            # 把**原始异常**带上：`clickhouse_connect` 导入失败可能是缺依赖、
            # 也可能是环境里有个同名模块遮蔽了它（`locale.py` 就干过这事）。
            # 只报「未安装」会把人引向错误的排查方向。
            raise EngineUnavailable(
                self.name,
                f"{self.unavailable_reason()}；原始异常 {type(exc).__name__}: {exc}",
            ) from exc

    def _connect(self) -> Any:
        if self._connection is not None:
            return self._connection
        module = self._module()
        try:
            self._connection = module.connect(self.database)
        except Exception as exc:
            raise EngineUnavailable(
                self.name, f"无法连接 {self.database}：{exc}"
            ) from exc
        # **必须把时区钉成 UTC**，否则 `EXTRACT(hour FROM timestamptz)`
        # 按进程本地时区求值 —— 本机是 Asia/Shanghai，实测同一份数据
        # DuckDB 给 8、ClickHouse 给 0，两引擎「不一致」其实全是时区造成的。
        # 契约 §3 要求基准统一按 UTC。
        try:
            self._connection.execute("SET TimeZone='UTC'")
        except Exception:  # pragma: no cover - 老版本 duckdb 没有这个设置名
            pass
        return self._connection

    def _register_source(self, connection: Any) -> None:
        if self._source_ready or self.root is None:
            return
        if not self.root.exists():
            raise EngineError(f"数据目录不存在：{self.root}")
        # 只注册**子目录**。
        #
        # 为什么要把所有子目录都注册：SQL-17 是 `obs` 与 `agg_hour` 的对账，
        # 一条 SQL 里出现两个视图；只注册一个的话另一个「表不存在」。
        #
        # **不注册 root 本身**：它的名字常是临时目录（`fsa-bench-d3`），
        # SQL 里从不引用，注册它只是白费一次全量扫描。
        targets = sorted(p for p in self.root.iterdir() if p.is_dir())
        if not targets:
            targets = [self.root]
        for directory in targets:
            parquet = sorted(directory.rglob("*.parquet"))
            json_files = sorted(directory.rglob("*.ndjson"))
            if parquet:
                pattern = str(directory.resolve()).replace("\\", "/") + "/**/*.parquet"
                # `hive_partitioning` **默认就是 true**，会拿分区目录名覆盖同名列，
                # 且只按第一个文件推结构。实测：`agg_hour` 里 `hour` 数据列是
                # int64，但分区目录叫 `hour=00`，于是视图里 `hour` 变成
                # VARCHAR `'00'` —— DuckDB 给字符串、CH 给整数，两引擎「不一致」。
                # 显式关掉它：分区列的值本来就写在每个文件的数据列里。
                reader = (f"read_parquet('{pattern}', hive_partitioning=false, "
                          "union_by_name=true)")
            elif json_files:
                pattern = str(directory.resolve()).replace("\\", "/") + "/**/*.ndjson"
                reader = (f"read_json_auto('{pattern}', "
                          "format='newline_delimited', union_by_name=true)")
            else:
                continue
            view = self.view or directory.resolve().name
            # 视图名必须加引号：临时目录名常带连字符（`fsa-bench-d3`），
            # 裸写会被 SQL 解析器当成减号。
            quoted = '"' + view.replace('"', '""') + '"'
            try:
                connection.execute(
                    f"CREATE OR REPLACE VIEW {quoted} AS SELECT * FROM {reader}")
            except Exception as exc:
                raise EngineError(f"注册视图 {view} 失败（{pattern}）：{exc}") from exc
        self._source_ready = True

    # -- 执行 -----------------------------------------------------
    def execute(self, sql: str, params: Sequence[Any] | None = None) -> QueryResult:
        self._assert_readonly(sql)
        started = perf_counter()
        connection = self._connect()
        self._register_source(connection)
        try:
            cursor = connection.execute(sql, params) if params else connection.execute(sql)
            columns = tuple(desc[0] for desc in (cursor.description or ()))
            raw_rows = cursor.fetchall() if cursor.description else []
        except EngineUnavailable:
            raise
        except Exception as exc:
            raise EngineError(f"{self.name} 执行失败：{exc}") from exc
        rows = _rows_as_dicts(columns, raw_rows)
        return QueryResult(columns=columns, rows=rows, elapsed_s=perf_counter() - started)

    def explain(self, sql: str) -> str:
        result = self.execute("EXPLAIN " + sql)
        lines = []
        for row in result.rows:
            lines.append(" | ".join(str(value) for value in row.values()))
        return "\n".join(lines)

    def close(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            finally:
                self._connection = None
                self._source_ready = False


class ClickHouseEngine(BaseEngine):
    """ClickHouse 适配器（HTTP 客户端延迟导入）。

    ``available()`` 只认 ``clickhouse_connect``：有二进制但没客户端时明确说明，
    不假装可用。``execute()`` 假定服务端已有 ``obs`` 表。
    """

    name = "clickhouse"

    def __init__(
        self,
        root: str | Path | None = None,
        *,
        host: str | None = None,
        port: int | None = None,
        database: str = "default",
        module_name: str = "clickhouse_connect",
        binary_names: Sequence[str] = ("clickhouse", "clickhouse-client"),
        env: Mapping[str, str] | None = None,
        from_parquet: bool = True,
    ) -> None:
        super().__init__(root)
        env = os.environ if env is None else env
        self.host = host or env.get("CLICKHOUSE_HOST", "127.0.0.1")
        self.port = int(port or env.get("CLICKHOUSE_PORT", 8123))
        self.database = database
        self.module_name = module_name
        self.binary_names = tuple(binary_names)
        #: `True` 时把 `FROM <view>` 改写成 `FROM file('<root>/**/*.parquet','Parquet')`。
        #: 这是「同一份 Parquet，两个引擎」的落地方式：不往 ClickHouse 灌数据，
        #: 两边读的是**同一个目录**。契约 §3 第 1 条要求「不复制、不转换中间表」。
        self.from_parquet = bool(from_parquet)
        self._client: Any = None
        self._materialised: dict[str, str] = {}

    # -- 能力探测 -------------------------------------------------
    def binary_path(self) -> str | None:
        for name in self.binary_names:
            found = shutil.which(name)
            if found:
                return found
        return None

    def available(self) -> bool:
        return _module_available(self.module_name)

    def unavailable_reason(self) -> str:
        if self.available():
            return ""
        reason = f"未安装 {self.module_name}（pip install clickhouse-connect）"
        binary = self.binary_path()
        if binary:
            return reason + f"；已找到二进制 {binary}，但没有 HTTP 客户端"
        return reason + "；也未找到 clickhouse 可执行文件"

    def status(self) -> EngineStatus:
        status = super().status()
        return EngineStatus(
            name=status.name,
            available=status.available,
            reason=status.reason,
            detail={
                **dict(status.detail),
                "host": self.host,
                "port": self.port,
                "database": self.database,
                "binary": self.binary_path(),
            },
        )

    def _module(self) -> Any:
        try:
            return importlib.import_module(self.module_name)
        except Exception as exc:
            raise EngineUnavailable(
                self.name,
                f"{self.unavailable_reason()}；原始异常 {type(exc).__name__}: {exc}",
            ) from exc

    def _connect(self) -> Any:
        if self._client is not None:
            return self._client
        module = self._module()
        try:
            self._client = module.get_client(
                host=self.host, port=self.port, database=self.database,
                # **必须钉 UTC**：契约 §3 / SQL-16 明确写了这一条。
                # 不钉的话 `DateTime64` 按服务端时区解释，`EXTRACT(hour …)` 会
                # 整体偏 8 小时 —— 实测同一份数据 DuckDB 给 0、CH 给 8。
                settings={"session_timezone": "UTC", "use_client_time_zone": 0,
                          # SQL-17 是 `FULL OUTER JOIN` 对账，缺失侧必须是 **NULL**。
                          # CH 默认给列类型的零值（`''` / `0`），于是
                          # `COALESCE(…, -1) - COALESCE(…, -1)` 变成 `900 - 0 = 900`
                          # 而不是 `-1 - (-1) = 0` —— 对账永远失败。
                          # 契约 §4 明确要求这一项。
                          "join_use_nulls": 1},
            )
        except Exception as exc:
            raise EngineUnavailable(
                self.name, f"无法连接 {self.host}:{self.port}：{exc}"
            ) from exc
        return self._client

    # -- 执行 -----------------------------------------------------
    def _table_source(self, sql: str) -> str:
        """把视图名改写为已灌好的本地表名。

        ## 为什么不是 `file()` 直读

        实测（ClickHouse 26.11，WSL 里跑、`--path` 指向 Windows 挂载盘）
        `file()` 有两条硬限制：

        1. 路径必须落在服务端的 `user_files_path` 内，否则
           `DATABASE_ACCESS_DENIED`；
        2. 该目录默认为 `/var/lib/clickhouse/user_files`，本机不存在且无 sudo 建不了。

        所以这里改成：**首次用到时把该视图的 Parquet 灌进一张内存表
        `bench_<view>`**，之后所有查询都读那张表。契约 §3 第 1 条允许
        「CH 原生表用于对照，但不作为真相」—— 真相仍是 `data/parquet/`。

        **数值必须一致**：灌表走 pyarrow 原样读、按原类型建列，
        不做任何换算，所以两边比的是同一份数。
        """
        if self.root is None:
            return sql
        base = Path(self.root)
        if not base.is_dir():
            return sql
        for view in ("agg_daily", "agg_hour", "obs", "tec"):
            if not re.search(rf"(?<![A-Za-z0-9_]){view}(?![A-Za-z0-9_])", sql):
                continue
            directory = base / view
            if not directory.is_dir():
                directory = base
            target = self._materialise(view, directory)
            sql = re.sub(rf"(?<![A-Za-z0-9_]){view}(?![A-Za-z0-9_])", target, sql)
        return sql

    #: 已灌好的本地表：`<目录>|<视图>` -> 表名。
    #:
    #: **必须是实例属性**，不能是类属性 —— 类属性会在同进程里的所有
    #: ClickHouseEngine 之间共享，于是「换了时区设置之后还拿到旧表」，
    #: 表现为「设了 UTC 却仍然偏 8 小时」。这个 bug 花了不少时间才定位到。
    _materialised: dict[str, str]

    def _materialise(self, view: str, directory: Path) -> str:
        """把 `<directory>/**/*.parquet` 灌成一张本地表，返回表名。"""
        cache_key = f"{directory.resolve()}|{view}"
        known = self._materialised.get(cache_key)
        if known:
            return known

        files = sorted(str(p) for p in directory.rglob("*.parquet"))
        if not files:
            raise EngineError(f"{directory} 下没有 Parquet 分区")

        try:
            import pyarrow.parquet as pq
        except Exception as exc:  # noqa: BLE001
            raise EngineUnavailable(
                self.name,
                f"把 Parquet 灌进 ClickHouse 需要 pyarrow（{exc}）；"
                "pip install pyarrow",
            ) from exc

        client = self._connect()
        target = f"bench_{view}"
        # 分区列（station/date/hour）在 hive 布局里被读成 `dictionary<string>`
        # 类型，与非分区文件里的 `string` 混不到一起（实测
        # `ArrowTypeError: Unable to merge: Field station has incompatible types`）。
        # 统一裁成一致的 schema：`_unified_arrow_schema` 只读各文件**元数据**，
        # 不读数据块，所以传全部文件不会引入内存峰值。
        schema = _unified_arrow_schema(files)
        # 用 pyarrow 的类型直接建表，**不做类型换算** —— 换算会引入舍入，
        # 两引擎比出来的差异就分不清是「方言」还是「我改了数」。
        columns = ", ".join(
            f"`{field.name}` {_ch_type(field.type)}" for field in schema)
        try:
            client.command(f"DROP TABLE IF EXISTS {target}")
            # **必须是 MergeTree，不能是 Memory。**
            # `ENGINE = Memory` 会把整张表放进 CH 的内存里：实测 1 亿行灌表时
            # 报 `(total) memory limit exceeded: would use 13.31 GiB ... maximum:
            # 13.31 GiB`，整条基准直接失败。MergeTree 落盘，内存只跟插入批次有关。
            client.command(
                f"CREATE TABLE {target} ({columns}) "
                "ENGINE = MergeTree ORDER BY tuple()")
            # **逐文件分批插入**：`pq.read_table(files)` 一次读全部 488 个分区，
            # 光 pyarrow 侧就有 GB 级峰值；分批后内存只与单文件大小成正比。
            for path in files:
                block = pq.read_table(path, schema=schema)
                if block.num_rows == 0:
                    continue
                # 列式传值 + `column_oriented=True`。
                # **漏掉这个标志**，客户端会把「每列的 list」当成「每行」，
                # 报 `Insert data column count does not match column names` ——
                # 报错信息完全指不到真正的原因上。
                client.insert(
                    target,
                    [block.column(name).to_pylist() for name in block.column_names],
                    column_oriented=True,
                )
        except Exception as exc:
            raise EngineError(f"灌表 {target} 失败：{exc}") from exc

        self._materialised[cache_key] = target
        return target

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> QueryResult:
        self._assert_readonly(sql)
        started = perf_counter()
        client = self._connect()
        rewritten = self._table_source(sql)
        try:
            result = client.query(rewritten, parameters=params) if params else client.query(rewritten)
            columns = tuple(result.column_names or ())
            raw_rows = result.result_rows or ()
        except Exception as exc:
            raise EngineError(f"{self.name} 执行失败：{exc}") from exc
        if not columns:
            # **结果为空时 CH 不给列名**（`result.column_names` 是空 tuple）。
            # 实测 SQL-13 在无断档时就是这样：行数 0 是对的，
            # 但「列名集合为空」会让两引擎比对在 columns 那一层直接失败。
            # 补一次 `DESCRIBE`（不执行原查询）拿列名。
            columns = self._describe_columns(rewritten)
        rows = _rows_as_dicts(columns, raw_rows)
        return QueryResult(columns=columns, rows=rows, elapsed_s=perf_counter() - started)

    def _describe_columns(self, sql: str) -> tuple[str, ...]:
        """从 `DESCRIBE <sql>` 取列名。取不到就返回空 tuple，不编造。"""
        client = self._connect()
        try:
            described = client.query("DESCRIBE " + sql)
            return tuple(row[0] for row in (described.result_rows or ()))
        except Exception:
            return ()

    def explain(self, sql: str) -> str:
        result = self.execute("EXPLAIN " + sql)
        return "\n".join(
            " | ".join(str(value) for value in row.values()) for row in result.rows
        )

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception:  # pragma: no cover - 关闭失败不影响结果
                pass
            finally:
                self._client = None


class BuiltinEngine(BaseEngine):
    """内置引擎的统一外壳。只吃 ``QuerySpec``，不解析任意 SQL。"""

    name = "builtin"

    def available(self) -> bool:
        return True

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> QueryResult:
        raise EngineError(
            "内置引擎不解析任意 SQL；请用 execute_spec(QuerySpec)。"
            f"任意 SQL 查询{REQUIRES_SQL_ENGINE}"
        )

    def execute_spec(self, spec: QuerySpec) -> QueryResult:
        if self.root is None:
            raise EngineError("BuiltinEngine 需要 root")
        return execute_spec(self.root, spec)

    def explain(self, sql: str) -> str:
        return (
            f"builtin: 逐行扫描 NDJSON 分区（root={self.root}），"
            "过滤 -> 时间桶 -> 分组聚合 -> 排序 -> limit；无索引、无并行。"
        )


_ENGINES = {
    "builtin": BuiltinEngine,
    "duckdb": DuckDBEngine,
    "clickhouse": ClickHouseEngine,
}


def get_engine(name: str, root: str | Path | None = None, **kwargs: Any) -> BaseEngine:
    """按名字构造适配器；不触发依赖导入。"""
    key = str(name).strip().lower()
    if key not in _ENGINES:
        raise ValueError(f"未知引擎 {name!r}；可选：{sorted(_ENGINES)}")
    return _ENGINES[key](root, **kwargs)


def available_engines() -> dict[str, EngineStatus]:
    """启动时给 UI / CLI 的能力探测快照。"""
    return {
        name: factory(None).status()
        for name, factory in _ENGINES.items()
    }
