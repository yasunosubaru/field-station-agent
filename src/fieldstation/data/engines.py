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
import shutil
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from time import perf_counter
from typing import Any, Mapping, Sequence

from .query import QueryResult, QuerySpec, execute as execute_spec

__all__ = [
    "BaseEngine",
    "BuiltinEngine",
    "ClickHouseEngine",
    "DuckDBEngine",
    "EngineError",
    "EngineStatus",
    "EngineUnavailable",
    "REQUIRES_SQL_ENGINE",
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
        view: str = "obs",
    ) -> None:
        super().__init__(root)
        self.database = database
        self.module_name = module_name
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
        except Exception as exc:  # ImportError 及其它导入期错误都转成 EngineUnavailable
            raise EngineUnavailable(self.name, self.unavailable_reason()) from exc

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
        return self._connection

    def _register_source(self, connection: Any) -> None:
        if self._source_ready or self.root is None:
            return
        if not self.root.exists():
            raise EngineError(f"数据目录不存在：{self.root}")
        pattern = str(self.root.resolve()).replace("\\", "/") + "/**/*.ndjson"
        literal = "'" + pattern.replace("'", "''") + "'"
        sql = (
            f"CREATE OR REPLACE VIEW {self.view} AS "
            f"SELECT * FROM read_json_auto({literal}, "
            "format='newline_delimited', union_by_name=true)"
        )
        try:
            connection.execute(sql)
        except Exception as exc:
            raise EngineError(f"注册 NDJSON 视图失败（{pattern}）：{exc}") from exc
        self._source_ready = True

    # -- 执行 -----------------------------------------------------
    def execute(self, sql: str, params: Sequence[Any] | None = None) -> QueryResult:
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
    ) -> None:
        super().__init__(root)
        env = os.environ if env is None else env
        self.host = host or env.get("CLICKHOUSE_HOST", "127.0.0.1")
        self.port = int(port or env.get("CLICKHOUSE_PORT", 8123))
        self.database = database
        self.module_name = module_name
        self.binary_names = tuple(binary_names)
        self._client: Any = None

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
            raise EngineUnavailable(self.name, self.unavailable_reason()) from exc

    def _connect(self) -> Any:
        if self._client is not None:
            return self._client
        module = self._module()
        try:
            self._client = module.get_client(
                host=self.host, port=self.port, database=self.database
            )
        except Exception as exc:
            raise EngineUnavailable(
                self.name, f"无法连接 {self.host}:{self.port}：{exc}"
            ) from exc
        return self._client

    # -- 执行 -----------------------------------------------------
    def execute(self, sql: str, params: Sequence[Any] | None = None) -> QueryResult:
        started = perf_counter()
        client = self._connect()
        try:
            result = client.query(sql, parameters=params) if params else client.query(sql)
            columns = tuple(result.column_names or ())
            raw_rows = result.result_rows or ()
        except Exception as exc:
            raise EngineError(f"{self.name} 执行失败：{exc}") from exc
        rows = _rows_as_dicts(columns, raw_rows)
        return QueryResult(columns=columns, rows=rows, elapsed_s=perf_counter() - started)

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
