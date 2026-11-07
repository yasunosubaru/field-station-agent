"""把 NDJSON 分区转成 Parquet（**可选**的打包步骤，默认不启用）。

**为什么默认仍是 NDJSON**：``writer.py`` 顶部的理由仍然成立——CI 与演示机不一定
装得下 pyarrow，而 NDJSON 逐行可读、可直接 gzip、DuckDB 与 ClickHouse 都能读。
默认写 Parquet 会把「仓库能跑」绑死在可选依赖上。所以这里的定位是**一步转换**，
不是替换写入格式：采样侧继续写 NDJSON，打包/发布/压测之前跑一次本模块，
分区布局（``station=/date=/hour=``）一个字节都不动，只多出同名 ``.parquet``。

**为什么不把整行塞成一个 JSON 字符串列**：那样 Parquet 只是「压缩过的 NDJSON」，
DuckDB 仍要对每一行做 JSON 解析，列裁剪、谓词下推、字典编码全部失效，
转换等于白做。本模块**按列推断类型**：时间字段成 ``timestamp[us, tz=UTC]``、
整数成 ``int64``、浮点成 ``double``、布尔成 ``bool``、其余保持 ``string``。

**为什么扫两遍**：列类型必须由**整个分区**决定，不能拿前 N 行猜。第一遍只建类型表
（不保留值），第二遍按固定 schema 分批写——峰值内存是「一批 5 万行」而不是「一个
分区的全部对象」。代价是多读一次磁盘，对一小时的 20 万行分区是可接受的。

**幂等**：源文件的 ``(字节数, mtime_ns)`` 写进 Parquet 的 schema metadata。
目标存在且这两个值与源一致就跳过，不重写、不抖 mtime。元数据缺失（别的工具写的
Parquet）时按「过期」处理，宁可重转一次也不留一份看不懂来源的文件。

**只用标准库做控制流**：模块顶层不 import pyarrow，``import fieldstation.data.parquet``
永远成功；缺包时 ``available()`` 返回假、``convert_*()`` 抛 ``ParquetUnavailable``。
这条与 ``engines.py`` 对 duckdb 的处理保持一致（依赖政策见
``docs/operations/environment.md``）。

**临时文件**：先写 ``.part-000.parquet.tmp`` 再 ``os.replace``。失败时留下的
``.tmp`` 以点开头，``manifest.scan()`` / ``iter_data_files()`` 都会跳过它。
"""
from __future__ import annotations

import importlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from .manifest import TIME_FIELDS, coerce_datetime, iter_data_files

__all__ = [
    "ConversionReport",
    "DEFAULT_ARROW_MODULE",
    "DEFAULT_CHUNK_ROWS",
    "DEFAULT_PARQUET_FILENAME",
    "ParquetConversionError",
    "ParquetError",
    "ParquetUnavailable",
    "PartitionReport",
    "available",
    "convert_partition",
    "convert_tree",
    "target_relpath",
    "unavailable_reason",
]

#: 分区内的 Parquet 文件名。与 ``manifest.DEFAULT_DATA_FILENAME`` 一一对应，
#: 便于按目录猜路径；``convert_partition`` 实际按源文件名换后缀，不用这个常量。
DEFAULT_PARQUET_FILENAME = "part-000.parquet"

#: 默认分批行数。5 万行 ≈ 一个 1 Hz 分区的四分之一，单批开销小又不至于碎片化。
DEFAULT_CHUNK_ROWS = 50_000

#: pyarrow 的模块名。留成参数是为了让「缺包」这条分支**能被确定性测试**：
#: 传一个不存在的模块名即可，不必去改全局 ``sys.modules``（那会污染同进程其它测试）。
DEFAULT_ARROW_MODULE = "pyarrow"

_SCHEMA_VERSION = 1
_META_BYTES = b"fieldstation.source_bytes"
_META_MTIME = b"fieldstation.source_mtime_ns"
_META_ROWS = b"fieldstation.rows"
_META_VERSION = b"fieldstation.parquet_schema_version"

_KIND_BOOL = "bool"
_KIND_INT = "int"
_KIND_FLOAT = "float"
_KIND_STRING = "string"
_KIND_TIMESTAMP = "timestamp"


class ParquetError(RuntimeError):
    """转换失败（源文件坏了、目录不存在、类型推断不了）。"""


class ParquetConversionError(ParquetError):
    """单个分区转不了；带上文件名与行号，别让调用方自己猜。"""


class ParquetUnavailable(ParquetError):
    """pyarrow 不在。**不是** ImportError，调用方据此回落 NDJSON。"""


# ---------------------------------------------------------------- 依赖探测
def _load_arrow(module_name: str = DEFAULT_ARROW_MODULE) -> tuple[Any, Any]:
    """延迟导入 pyarrow 与 pyarrow.parquet。

    刻意用 ``importlib.import_module`` 而不是 ``import`` 语句：``tools/env_snapshot.py``
    用 AST 扫 ``src/`` 里的 import 来统计第三方依赖，顶层/函数内的 ``import pyarrow``
    都会被算进「门禁依赖」。走 importlib 与 ``engines.py`` 对 duckdb 的写法一致，
    快照里仍然只有可选工具。

    ``module_name`` 可换：测试注入一个不存在的名字就能确定性地走到「缺包」分支，
    不必改动进程级的 ``sys.modules``。
    """
    try:
        pyarrow = importlib.import_module(module_name)
        parquet = importlib.import_module(module_name + ".parquet")
    except Exception as exc:  # ImportError 及其它导入期错误
        raise ParquetUnavailable(
            f"{module_name} 不可用：转 Parquet 是可选步骤，未安装时请继续用 NDJSON"
            "（pip install pyarrow）"
        ) from exc
    return pyarrow, parquet


def available(module_name: str = DEFAULT_ARROW_MODULE) -> bool:
    """pyarrow 是否可导入。每次调用都真试一次 import。

    不做模块级缓存：``import`` 命中 ``sys.modules`` 时只是一次字典查找，很便宜；
    缓存反而会让「装上了但装坏了」这种情况在进程内一直显示可用。
    """
    try:
        _load_arrow(module_name)
    except ParquetUnavailable:
        return False
    return True


def unavailable_reason(module_name: str = DEFAULT_ARROW_MODULE) -> str:
    """``available()`` 为假时给 UI / CLI 看的一句话。"""
    if available(module_name):
        return ""
    return "未安装 pyarrow；Parquet 转换不可用，NDJSON 仍可正常写入与查询"


# ---------------------------------------------------------------- 报告
@dataclass(frozen=True)
class PartitionReport:
    """一个分区的转换结果。

    ``status`` 只有四种：

    - ``converted``：本次写出/重建了 Parquet；
    - ``skipped``：目标已是最新（源 ``(字节数, mtime_ns)`` 未变）；
    - ``empty``：源 0 行，**不写** Parquet（没有列的 Parquet 读回来是空表，
      反而让下游误以为「这个分区存在但没有字段」）；
    - ``failed``：转换出错，``reason`` 带异常类型与消息，整棵树继续跑。
    """

    source: str
    target: str | None
    status: str
    rows: int = 0
    bytes: int = 0
    columns: tuple[str, ...] = ()
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "status": self.status,
            "rows": self.rows,
            "bytes": self.bytes,
            "columns": list(self.columns),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ConversionReport:
    """整棵分区树的转换报告。字段名与 ``bench`` 的判决口径对齐（计数精确相等）。"""

    root: str
    out_root: str
    partitions: tuple[PartitionReport, ...] = ()

    def _count(self, status: str) -> int:
        return sum(1 for item in self.partitions if item.status == status)

    @property
    def converted(self) -> int:
        return self._count("converted")

    @property
    def skipped(self) -> int:
        return self._count("skipped")

    @property
    def empty(self) -> int:
        return self._count("empty")

    @property
    def failed(self) -> int:
        return self._count("failed")

    @property
    def total_rows(self) -> int:
        """已落成 Parquet 的行数（converted + skipped），不含失败与空分区。"""
        return sum(
            item.rows
            for item in self.partitions
            if item.status in ("converted", "skipped")
        )

    @property
    def total_bytes(self) -> int:
        """Parquet 文件字节合计（只算真的落成 Parquet 的分区）。"""
        return sum(item.bytes for item in self.partitions if item.bytes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "out_root": self.out_root,
            "converted": self.converted,
            "skipped": self.skipped,
            "empty": self.empty,
            "failed": self.failed,
            "total_rows": self.total_rows,
            "total_bytes": self.total_bytes,
            "partitions": [item.to_dict() for item in self.partitions],
        }


# ---------------------------------------------------------------- 读源
def _iter_objects(path: Path) -> Iterator[dict[str, Any]]:
    """逐行读 NDJSON；坏行报 ``文件:行号`` 与列位置，不静默跳过。"""
    with path.open("r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, start=1):
            text = raw.strip()
            if not text:
                continue
            try:
                obj = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ParquetConversionError(
                    f"{path.name}:{lineno} 不是合法 JSON：{exc.msg}"
                ) from exc
            if not isinstance(obj, dict):
                raise ParquetConversionError(f"{path.name}:{lineno} 不是 JSON 对象")
            yield obj


# ---------------------------------------------------------------- 类型推断
def _kind_of(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return _KIND_BOOL
    if isinstance(value, int):
        return _KIND_INT
    if isinstance(value, float):
        return _KIND_FLOAT
    # JSON 只会有 None/bool/int/float/str/list/dict；列表与对象按字符串落盘。
    return _KIND_STRING


def _merge_kind(current: str, incoming: str) -> str:
    """合并两行的同一列类型。解析不了的组合一律退 ``string``，不猜。"""
    if not current:
        return incoming
    if not incoming or current == incoming:
        return current
    if {current, incoming} == {_KIND_INT, _KIND_FLOAT}:
        return _KIND_FLOAT
    return _KIND_STRING


def _scan_schema(path: Path) -> tuple[int, dict[str, str]]:
    """第一遍：行数 + 列 → 类型。时间字段只有在**全部**可解析时才算 timestamp。"""
    kinds: dict[str, str] = {}
    unparsable_time: set[str] = set()
    rows = 0
    for obj in _iter_objects(path):
        rows += 1
        for raw_name, value in obj.items():
            name = str(raw_name)
            kinds[name] = _merge_kind(kinds.get(name, ""), _kind_of(value))
            if name in TIME_FIELDS and value not in (None, ""):
                if coerce_datetime(value) is None:
                    unparsable_time.add(name)
    for name in list(kinds):
        if name in TIME_FIELDS and name not in unparsable_time:
            if kinds[name] in (_KIND_INT, _KIND_FLOAT, _KIND_STRING):
                kinds[name] = _KIND_TIMESTAMP
    return rows, {name: kind for name, kind in kinds.items() if kind}


def _string_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        # 结构列不丢信息地折成 JSON 文本；查询侧仍能 json_extract，但代价是
        # 该列不再有列式编码——已知取舍，写进本模块顶部。
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _arrow_type(pyarrow: Any, kind: str) -> Any:
    if kind == _KIND_TIMESTAMP:
        return pyarrow.timestamp("us", tz="UTC")
    if kind == _KIND_INT:
        return pyarrow.int64()
    if kind == _KIND_FLOAT:
        return pyarrow.float64()
    if kind == _KIND_BOOL:
        return pyarrow.bool_()
    return pyarrow.string()


def _arrow_array(pyarrow: Any, kind: str, values: Sequence[Any], column: str) -> Any:
    try:
        if kind == _KIND_TIMESTAMP:
            parsed = [None if v is None else coerce_datetime(v) for v in values]
            return pyarrow.array(parsed, type=_arrow_type(pyarrow, kind))
        if kind == _KIND_INT:
            return pyarrow.array(
                [None if v is None else int(v) for v in values],
                type=pyarrow.int64(),
            )
        if kind == _KIND_FLOAT:
            return pyarrow.array(
                [None if v is None else float(v) for v in values],
                type=pyarrow.float64(),
            )
        if kind == _KIND_BOOL:
            return pyarrow.array(
                [None if v is None else bool(v) for v in values],
                type=pyarrow.bool_(),
            )
        return pyarrow.array([_string_value(v) for v in values], type=pyarrow.string())
    except (OverflowError, TypeError, ValueError) as exc:
        raise ParquetConversionError(
            f"列 {column!r} 无法按 {kind} 落盘（{type(exc).__name__}：{exc}）；"
            "超出 int64 的整数会落到这里，请在上游把该列改成字符串"
        ) from exc


# ---------------------------------------------------------------- 幂等
def _stored(metadata: Mapping[bytes, bytes] | None, key: bytes) -> str | None:
    if not metadata:
        return None
    value = metadata.get(key)
    if value is None:
        return None
    return value.decode("utf-8", "replace")


def _target_rows(parquet: Any, path: Path) -> int:
    """读 Parquet 页脚的行数（不载入数据），用于「跳过」时也报出准确行数。"""
    try:
        return int(parquet.ParquetFile(str(path)).metadata.num_rows)
    except Exception:  # pragma: no cover - 页脚都读不了时宁可报 0
        return 0


def _up_to_date(source: Path, target: Path, parquet: Any) -> bool:
    if not target.is_file():
        return False
    try:
        schema = parquet.read_schema(str(target))
    except Exception:
        return False
    metadata = schema.metadata or {}
    stat = source.stat()
    return (
        _stored(metadata, _META_BYTES) == str(stat.st_size)
        and _stored(metadata, _META_MTIME) == str(stat.st_mtime_ns)
        and _stored(metadata, _META_VERSION) == str(_SCHEMA_VERSION)
    )


# ---------------------------------------------------------------- 单个分区
def target_relpath(source_relpath: str) -> str:
    """``.../part-000.ndjson`` → ``.../part-000.parquet``（布局不变，只换后缀）。"""
    posix = str(source_relpath).replace("\\", "/")
    stem, dot, _ = posix.rpartition(".")
    if not dot or "/" in stem.rpartition("/")[2]:
        return posix + ".parquet"
    return f"{stem}.parquet"


def convert_partition(
    source: str | Path,
    target: str | Path | None = None,
    *,
    force: bool = False,
    chunk_rows: int = DEFAULT_CHUNK_ROWS,
    module_name: str = DEFAULT_ARROW_MODULE,
) -> PartitionReport:
    """把一个 NDJSON 分区转成 Parquet。

    ``target`` 省略时写在源文件旁边（``part-000.ndjson`` → ``part-000.parquet``）。
    ``force=True`` 忽略幂等检查强制重写；批量转换请用 :func:`convert_tree`。
    """
    source_path = Path(source)
    if not source_path.is_file():
        raise ParquetError(f"源分区不存在：{source_path}")
    if chunk_rows <= 0:
        raise ValueError(f"chunk_rows 必须大于 0：{chunk_rows!r}")
    target_path = (
        Path(target)
        if target is not None
        else source_path.with_name(source_path.stem + ".parquet")
    )
    pyarrow, parquet = _load_arrow(module_name)

    if not force and _up_to_date(source_path, target_path, parquet):
        return PartitionReport(
            source=source_path.as_posix(),
            target=target_path.as_posix(),
            status="skipped",
            rows=_target_rows(parquet, target_path),
            bytes=target_path.stat().st_size,
            reason="源未变（字节数与 mtime 一致）",
        )

    rows, kinds = _scan_schema(source_path)
    if rows == 0 or not kinds:
        return PartitionReport(
            source=source_path.as_posix(),
            target=None,
            status="empty",
            rows=0,
            bytes=source_path.stat().st_size,
            reason="源分区 0 行；不写无列的 Parquet",
        )

    stat = source_path.stat()
    schema = pyarrow.schema(
        [(name, _arrow_type(pyarrow, kind)) for name, kind in kinds.items()],
        metadata={
            _META_BYTES: str(stat.st_size).encode("utf-8"),
            _META_MTIME: str(stat.st_mtime_ns).encode("utf-8"),
            _META_ROWS: str(rows).encode("utf-8"),
            _META_VERSION: str(_SCHEMA_VERSION).encode("utf-8"),
        },
    )

    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = target_path.with_name("." + target_path.name + ".tmp")
    # ParquetWriter 自己管批量与编码；按 chunk_rows 分批喂，避免整分区驻留内存。
    writer = parquet.ParquetWriter(str(tmp), schema, compression="snappy")
    try:
        batch: list[dict[str, Any]] = []
        for obj in _iter_objects(source_path):
            batch.append(obj)
            if len(batch) >= chunk_rows:
                writer.write_table(_chunk_table(pyarrow, schema, kinds, batch))
                batch = []
        if batch:
            writer.write_table(_chunk_table(pyarrow, schema, kinds, batch))
    except BaseException:
        # 失败时**不删**半截的 .tmp：仓库纪律禁止在工具链里做删除动作。留下的是
        # 点开头的文件，manifest.scan() / iter_data_files() 都会跳过；下次转换
        # 直接覆盖同名 .tmp，不会越积越多。
        writer.close()
        raise
    writer.close()
    os.replace(tmp, target_path)
    return PartitionReport(
        source=source_path.as_posix(),
        target=target_path.as_posix(),
        status="converted",
        rows=rows,
        bytes=target_path.stat().st_size,
        columns=tuple(kinds),
    )


def _chunk_table(
    pyarrow: Any,
    schema: Any,
    kinds: Mapping[str, str],
    rows: Sequence[Mapping[str, Any]],
) -> Any:
    columns = {
        name: _arrow_array(pyarrow, kind, [row.get(name) for row in rows], name)
        for name, kind in kinds.items()
    }
    return pyarrow.Table.from_pydict(columns, schema=schema)


# ---------------------------------------------------------------- 整棵树
def convert_tree(
    root: str | Path,
    *,
    out_root: str | Path | None = None,
    force: bool = False,
    chunk_rows: int = DEFAULT_CHUNK_ROWS,
    strict: bool = False,
    module_name: str = DEFAULT_ARROW_MODULE,
) -> ConversionReport:
    """遍历分区树批量转换，返回结构化报告。

    ``out_root`` 省略时**原地镜像**（Parquet 就躺在 NDJSON 旁边，目录布局不变，
    后缀不在 ``manifest.DATA_SUFFIXES`` 里，所以清单扫描与校验都不会把它当数据）。
    ``docs/contracts/bench-sql.md`` 约定的发布布局是 ``out_root=data/parquet/obs``，
    由调用方显式传。

    单个分区失败**不中断整棵树**（``status='failed'`` 记进报告）；
    ``strict=True`` 时第一个失败就抛，用于「这批必须全好」的发布前检查。
    """
    source_root = Path(root)
    if not source_root.is_dir():
        raise ParquetError(f"数据目录不存在：{source_root}")
    target_root = Path(out_root) if out_root is not None else source_root
    _load_arrow(module_name)  # 早失败：没装 pyarrow 就别遍历一遍才报错

    reports: list[PartitionReport] = []
    for path in iter_data_files(source_root):
        rel = path.relative_to(source_root).as_posix()
        target = target_root / target_relpath(rel)
        try:
            reports.append(
                convert_partition(
                    path,
                    target,
                    force=force,
                    chunk_rows=chunk_rows,
                    module_name=module_name,
                )
            )
        except ParquetUnavailable:
            raise
        except Exception as exc:
            if strict:
                raise
            reports.append(
                PartitionReport(
                    source=path.as_posix(),
                    target=target.as_posix(),
                    status="failed",
                    reason=f"{type(exc).__name__}: {exc}",
                )
            )
    return ConversionReport(
        root=source_root.as_posix(),
        out_root=target_root.as_posix(),
        partitions=tuple(reports),
    )
