"""把观测记录写成 NDJSON 分区文件（标准库）。

**为什么是 NDJSON 而不是 Parquet**：CI 与演示机不一定装得下 pyarrow。NDJSON
逐行可读、可直接 ``gzip``、DuckDB 的 ``read_ndjson_auto`` 与 ClickHouse 的
``JSONEachRow`` 都能读。等打包阶段再转 Parquet，分区布局不变。

因此**默认永远是 NDJSON**。想让写入顺手带出 Parquet，只有两条显式路径：

- ``NdjsonWriter(..., parquet=True)``（本模块，见下），只转**本次刚写的分区**；
- ``fieldstation.data.parquet.convert_tree(root, out_root=...)``（独立一步，
  可以整树批量转、可以幂等跳过）。

两者都依赖可选包 pyarrow；没装时抛 ``parquet.ParquetUnavailable``，而不是
把 NDJSON 也一起搞失败（NDJSON 已经写好了，转换失败只影响 Parquet 那份）。

**幂等是硬要求**：同一个分区重写必须产生**逐字节相同**的文件。做法：

1. 每行 ``json.dumps(sort_keys=True, separators=(",", ":"))`` —— 键序固定；
2. 记录按 ``(时间, 整行文本)`` 排序后落盘 —— 与输入顺序无关；
3. 内容没变就不覆盖 —— mtime 也不抖；
4. 先写同目录临时文件再 ``os.replace`` —— 不会留下半截分区。

**NaN/Inf 写成 ``null``**：``NaN`` 不是合法 JSON，DuckDB / ClickHouse 的
NDJSON 读端会整行报错。缺测的语义在 ``model.MISSING`` 里，落盘时统一成
``null``，查询侧按 SQL 的 NULL 处理（聚合跳过）。

**不支持追加**：追加会破坏「重写逐字节相同」。要改分区就整分区重写。
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import fields, is_dataclass
from datetime import date as _date
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping

from .manifest import (
    DEFAULT_DATA_FILENAME,
    MANIFEST_NAME,
    TIME_FIELDS,
    PartitionKey,
    PartitionManifest,
    PartitionMeta,
    coerce_datetime,
    inspect_file,
    partition_file,
)

__all__ = [
    "NdjsonWriter",
    "canonical_line",
    "jsonable",
    "record_to_dict",
    "write_ndjson",
]


def jsonable(value: Any) -> Any:
    """转成可被严格 JSON 序列化的值。

    ``datetime`` 保留 ISO 8601 与原始时区；``float`` 的 NaN/Inf 变 ``None``。
    未知对象退回 ``str``，而不是让整批写入失败。
    """
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, _date):
        return value.isoformat()
    if isinstance(value, Enum):
        return jsonable(value.value)
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    item = getattr(value, "item", None)
    if callable(item):  # numpy 标量
        try:
            return jsonable(item())
        except Exception:  # pragma: no cover - 不该发生
            pass
    return str(value)


def record_to_dict(record: Any) -> dict[str, Any]:
    """把 ``Observation`` / ``StationReading`` / dict 统一成字典。"""
    if isinstance(record, Mapping):
        return dict(record)
    to_row = getattr(record, "to_row", None)
    if callable(to_row):
        row = to_row()
        if not isinstance(row, Mapping):
            raise TypeError(f"{type(record).__name__}.to_row() 必须返回 dict")
        return dict(row)
    to_dict = getattr(record, "to_dict", None)
    if callable(to_dict):
        row = to_dict()
        if not isinstance(row, Mapping):
            raise TypeError(f"{type(record).__name__}.to_dict() 必须返回 dict")
        return dict(row)
    if is_dataclass(record) and not isinstance(record, type):
        return {f.name: getattr(record, f.name) for f in fields(record)}
    raise TypeError(
        f"不支持写入的记录类型 {type(record).__name__}；"
        "需要 dict / dataclass / 带 to_row() 的对象"
    )


def canonical_line(record: Any) -> str:
    """一条记录的规范 JSON 行（无换行）。同一条记录永远得到同一串字节。"""
    return json.dumps(
        jsonable(record_to_dict(record)),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _gps_time(row: Mapping[str, Any]) -> datetime | None:
    """``Observation`` 没填 epoch_utc 时，用 GPS 周 + 周内秒推出来。"""
    week = row.get("gps_week")
    tow = row.get("gps_tow_s")
    if week is None or tow is None:
        return None
    try:
        from ..model import gps_to_utc
    except Exception:  # pragma: no cover - 父包异常时不阻断写入
        return None
    try:
        return gps_to_utc(int(week), float(tow))
    except (TypeError, ValueError):
        return None


def _record_time(row: Mapping[str, Any], time_field: str | None = None) -> tuple[str, datetime]:
    """取记录的时间字段与对应 UTC 时间。"""
    names = (time_field,) if time_field else TIME_FIELDS
    for name in names:
        value = row.get(name)
        if value in (None, ""):
            continue
        dt = coerce_datetime(value)
        if dt is not None:
            return name, dt
        raise ValueError(f"时间字段 {name}={value!r} 无法解析成 ISO 8601")
    dt = _gps_time(row)
    if dt is not None:
        return "epoch_utc", dt
    raise ValueError(
        f"记录缺少时间字段（{'/'.join(TIME_FIELDS)}）或 gps_week+gps_tow_s"
    )


def _record_station(row: Mapping[str, Any]) -> str | None:
    for name in ("station", "station_id"):
        value = row.get(name)
        if value not in (None, ""):
            return str(value)
    return None


def _iso_utc(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    if dt.microsecond:
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class NdjsonWriter:
    """按 station/date/hour 写分区，并同步维护 ``_manifest.json``。

    ``parquet=True`` 时，**每次写完一个分区**都会顺手用
    :mod:`fieldstation.data.parquet` 转一份同名 ``.parquet``（幂等：源没变就跳过）。
    默认 ``False``——NDJSON 是默认写入格式，Parquet 是打包/发布阶段的产物，不该
    把「仓库能跑」绑在 pyarrow 上。转换失败只影响 Parquet 那份，NDJSON 已经落盘。
    """

    def __init__(
        self,
        root: str | Path,
        *,
        time_field: str | None = None,
        filename: str = DEFAULT_DATA_FILENAME,
        parquet: bool = False,
    ) -> None:
        self.root = Path(root)
        self.time_field = time_field
        self.filename = filename
        self.parquet = bool(parquet)
        self.manifest = PartitionManifest.load(self.root)
        # 清单丢了但数据还在时，先认领盘上的分区；否则下一次写会把旧分区
        # 从清单里「挤掉」，看起来像数据消失了。
        if (
            not (self.root / MANIFEST_NAME).exists()
            and self.root.exists()
            and any(self.root.rglob("*.ndjson"))
        ):
            self.manifest = PartitionManifest.scan(self.root)

    # -- 分区推导 -------------------------------------------------
    def partition_key(
        self,
        record: Any,
        *,
        station: str | None = None,
        date: str | None = None,
        hour: str | int | None = None,
    ) -> PartitionKey:
        row = record_to_dict(record)
        _, dt = _record_time(row, self.time_field)
        derived_station = _record_station(row)
        if station is not None and derived_station not in (None, station):
            raise ValueError(
                f"记录 station={derived_station!r} 与显式 station={station!r} 不一致"
            )
        final_station = station if station is not None else derived_station
        if final_station is None:
            raise ValueError("记录缺少 station/station_id")
        if date is not None and date != dt.date().isoformat():
            raise ValueError(f"记录日期 {dt.date()} 与显式 date={date!r} 不一致")
        if hour is not None and f"{int(hour):02d}" != f"{dt.hour:02d}":
            raise ValueError(f"记录小时 {dt.hour} 与显式 hour={hour!r} 不一致")
        return PartitionKey(
            station=final_station,
            date=dt.date().isoformat(),
            hour=f"{dt.hour:02d}",
        )

    # -- 写入 -----------------------------------------------------
    def write(
        self,
        records: Iterable[Any],
        *,
        station: str | None = None,
        date: str | None = None,
        hour: str | int | None = None,
    ) -> list[PartitionMeta]:
        """按记录自带的站/时间分组写入，返回涉及分区的元数据卡。

        显式传入的 ``station`` / ``date`` / ``hour`` 是**断言 + 缺省补齐**：
        记录里有值就必须对得上，没有值才用它补。
        """
        groups: dict[tuple[str, str, str], list[Any]] = {}
        for record in records:
            key = self.partition_key(record, station=station, date=date, hour=hour)
            groups.setdefault(key.as_tuple, []).append(record)

        metas: list[PartitionMeta] = []
        for tuple_key in sorted(groups):
            key = PartitionKey(*tuple_key)
            metas.append(self._write_group(groups[tuple_key], key, save_manifest=False))
        if metas:
            self.manifest.root = self.root
            self.manifest.save(self.root)
        return metas

    def write_one(
        self,
        record: Any,
        *,
        station: str | None = None,
        date: str | None = None,
        hour: str | int | None = None,
    ) -> PartitionMeta:
        return self.write([record], station=station, date=date, hour=hour)[0]

    def write_partition(
        self,
        records: Iterable[Any],
        key: PartitionKey | tuple[str, str, str],
        *,
        allow_empty: bool = True,
    ) -> PartitionMeta:
        """把一组记录写进**指定**分区；记录若属于别的分区就报错。

        ``allow_empty=True`` 时允许写空分区（0 行），用于占位和空分区测试。
        """
        if not isinstance(key, PartitionKey):
            key = PartitionKey(*key)
        rows = [record_to_dict(r) for r in records]
        if not rows and not allow_empty:
            raise ValueError(f"分区 {key.as_tuple} 没有记录")
        for row in rows:
            _, dt = _record_time(row, self.time_field)
            actual_station = _record_station(row)
            if actual_station is not None and actual_station != key.station:
                raise ValueError(
                    f"记录 station={actual_station!r} 不属于分区 {key.as_tuple}"
                )
            if dt.date().isoformat() != key.date or f"{dt.hour:02d}" != key.hour:
                raise ValueError(
                    f"记录时间 {dt.isoformat()} 不属于分区 {key.as_tuple}"
                )
        return self._write_group(rows, key, save_manifest=True)

    def _write_group(
        self,
        records: Iterable[Any],
        key: PartitionKey,
        *,
        save_manifest: bool,
    ) -> PartitionMeta:
        # 先规范化、排序，再拼字节：同一组记录无论传入顺序如何都得到同一份文件。
        lines: list[tuple[str, str]] = []
        for record in records:
            row = record_to_dict(record)
            time_name, dt = _record_time(row, self.time_field)
            # 只由 gps_week/gps_tow_s 推出来的时间要补回记录，否则查询侧
            # 按 epoch_utc 做时间桶时会看到空字符串。
            if row.get(time_name) in (None, ""):
                row[time_name] = _iso_utc(dt)
            line = canonical_line(row)
            lines.append((dt.astimezone(timezone.utc).isoformat(), line))
        lines.sort(key=lambda pair: (pair[0], pair[1]))

        payload = "".join(line + "\n" for _, line in lines).encode("utf-8")
        path = partition_file(self.root, key, self.filename)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or path.read_bytes() != payload:
            tmp = path.with_name("." + path.name + ".tmp")
            tmp.write_bytes(payload)
            os.replace(tmp, path)

        meta = inspect_file(
            path, root=self.root, relpath=path.relative_to(self.root).as_posix()
        )
        if self.parquet:
            self._write_parquet(path)
        self.manifest.upsert(meta)
        self.manifest.root = self.root
        if save_manifest:
            self.manifest.save(self.root)
        return meta

    def _write_parquet(self, path: Path) -> None:
        """可选：把刚写的分区同步转成 Parquet。

        延迟 import——默认路径（``parquet=False``）连 ``fieldstation.data.parquet``
        都不加载。缺 pyarrow 时抛 ``ParquetUnavailable``（明确异常，不是 ImportError），
        此时 NDJSON 已经写好了，调用方可以选择忽略并把报告标成「仅 NDJSON」。
        """
        from .parquet import convert_partition

        convert_partition(path, path.with_name(path.stem + ".parquet"))


def write_ndjson(
    root: str | Path,
    records: Iterable[Any],
    *,
    time_field: str | None = None,
    parquet: bool = False,
    **write_kwargs: Any,
) -> list[PartitionMeta]:
    """一次写完一组记录（不保留 writer 实例）的便捷函数。

    ``parquet=True`` 时顺带写出同名 ``.parquet``；默认仍是纯 NDJSON。
    """
    return NdjsonWriter(root, time_field=time_field, parquet=parquet).write(
        records, **write_kwargs
    )
