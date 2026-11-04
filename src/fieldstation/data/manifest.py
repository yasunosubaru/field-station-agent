"""E4 数据引擎的分区清单（元数据卡）。

**为什么存在**：查询引擎不该靠「把目录全扫一遍」来知道数据是什么。每个分区
（station/date/hour）有一张卡：路径、行数、时间范围、列名、sha256、字节数。
上层据此做分区裁剪、完整性校验和「这个数从哪来」的溯源。

**布局**（Hive 风格，DuckDB / ClickHouse 都能直接按目录裁剪）::

    <root>/station=<站名>/date=<YYYY-MM-DD>/hour=<HH>/part-000.ndjson
    <root>/_manifest.json

清单只存元数据，不存数据本身；数据文件才是唯一真相。清单丢了可以 ``scan()``
重建，所以它不是第二份数据。

**只用标准库**。``duckdb`` / ``clickhouse`` 都不得成为 import 时依赖。
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import date as _date
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 1
MANIFEST_NAME = "_manifest.json"
DEFAULT_DATA_FILENAME = "part-000.ndjson"
DATA_SUFFIXES = (".ndjson", ".jsonl")

#: 记录里可能承载时间的字段，按优先级排列。``epoch_utc`` 是 GNSS 中间 schema 的
#: 写法，``observed_at`` 是台站通用模型（store.model.StationReading）的写法。
TIME_FIELDS = ("epoch_utc", "observed_at", "time", "timestamp", "ts")


class ManifestError(ValueError):
    """清单本身坏了（JSON 解析失败、路径不合布局、schema 版本不认识）。"""


# ---------------------------------------------------------------- 分区键
@dataclass(frozen=True)
class PartitionKey:
    """一个分区的身份：站、日、小时。小时统一成两位字符串。"""

    station: str
    date: str
    hour: str

    def __post_init__(self) -> None:
        station = str(self.station).strip()
        if not station:
            raise ValueError("station 不能为空")
        if "/" in station or "\\" in station or "=" in station:
            raise ValueError(f"station 不能含 / \\ = ：{station!r}")
        try:
            day = _date.fromisoformat(str(self.date))
        except ValueError as exc:
            raise ValueError(f"date 必须是 YYYY-MM-DD：{self.date!r}") from exc
        try:
            hour = int(str(self.hour))
        except ValueError as exc:
            raise ValueError(f"hour 必须是 0-23：{self.hour!r}") from exc
        if not 0 <= hour <= 23:
            raise ValueError(f"hour 必须是 0-23：{self.hour!r}")
        object.__setattr__(self, "station", station)
        object.__setattr__(self, "date", day.isoformat())
        object.__setattr__(self, "hour", f"{hour:02d}")

    @property
    def as_tuple(self) -> tuple[str, str, str]:
        return (self.station, self.date, self.hour)

    def relpath(self, filename: str = DEFAULT_DATA_FILENAME) -> str:
        """相对 root 的 POSIX 路径。"""
        return (
            f"station={self.station}/date={self.date}/hour={self.hour}/{filename}"
        )


def parse_partition_relpath(relpath: str | PurePosixPath) -> PartitionKey:
    """从数据文件的相对路径解析分区键。

    只接受 ``station=.../date=.../hour=.../<file>.ndjson`` 这一种布局。
    不认识的布局直接报错——静默跳过会让「清单少了一个分区」查不出来。
    """
    parts = PurePosixPath(str(relpath).replace("\\", "/")).parts
    if len(parts) != 4:
        raise ManifestError(
            f"分区路径必须是 station=/date=/hour=/<file> 四段：{relpath!r}"
        )
    station_part, date_part, hour_part, filename = parts
    for prefix, part in (
        ("station=", station_part),
        ("date=", date_part),
        ("hour=", hour_part),
    ):
        if not part.startswith(prefix) or part == prefix:
            raise ManifestError(f"分区路径缺少 {prefix!r} 前缀：{relpath!r}")
    if not filename.lower().endswith(DATA_SUFFIXES):
        raise ManifestError(f"分区文件后缀必须是 {DATA_SUFFIXES}：{relpath!r}")
    return PartitionKey(
        station=station_part[len("station="):],
        date=date_part[len("date="):],
        hour=hour_part[len("hour="):],
    )


def partition_dir(root: str | Path, key: PartitionKey) -> Path:
    root = Path(root)
    return root / f"station={key.station}" / f"date={key.date}" / f"hour={key.hour}"


def partition_file(
    root: str | Path, key: PartitionKey, filename: str = DEFAULT_DATA_FILENAME
) -> Path:
    return partition_dir(root, key) / filename


# ---------------------------------------------------------------- 元数据卡
@dataclass(frozen=True)
class PartitionMeta:
    """一个 NDJSON 分区的元数据卡。"""

    station: str
    date: str
    hour: str
    path: str  # 相对 root 的 POSIX 路径
    rows: int
    min_time: str | None
    max_time: str | None
    columns: tuple[str, ...]
    sha256: str
    bytes: int
    time_field: str = ""
    schema_version: int = SCHEMA_VERSION

    @property
    def key(self) -> PartitionKey:
        return PartitionKey(self.station, self.date, self.hour)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "station": self.station,
            "date": self.date,
            "hour": self.hour,
            "path": self.path,
            "rows": self.rows,
            "min_time": self.min_time,
            "max_time": self.max_time,
            "columns": list(self.columns),
            "sha256": self.sha256,
            "bytes": self.bytes,
            "time_field": self.time_field,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PartitionMeta:
        try:
            key = PartitionKey(str(d["station"]), str(d["date"]), str(d["hour"]))
            return cls(
                station=key.station,
                date=key.date,
                hour=key.hour,
                path=str(d["path"]),
                rows=int(d["rows"]),
                min_time=None if d.get("min_time") is None else str(d["min_time"]),
                max_time=None if d.get("max_time") is None else str(d["max_time"]),
                columns=tuple(str(c) for c in d.get("columns", ())),
                sha256=str(d["sha256"]),
                bytes=int(d["bytes"]),
                time_field=str(d.get("time_field", "")),
                schema_version=int(d.get("schema_version", SCHEMA_VERSION)),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ManifestError(f"元数据卡缺字段或类型不对：{d!r}") from exc


@dataclass
class PartitionManifest:
    """一组元数据卡。``root`` 不参与序列化，只用于定位数据文件。"""

    partitions: list[PartitionMeta] = field(default_factory=list)
    root: Path | None = None

    # -- 容器协议 -------------------------------------------------
    def __len__(self) -> int:
        return len(self.partitions)

    def __iter__(self) -> Iterator[PartitionMeta]:
        return iter(self.partitions)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, PartitionManifest):
            return NotImplemented
        return self.sorted() == other.sorted()

    def sorted(self) -> list[PartitionMeta]:
        return sorted(self.partitions, key=lambda m: (m.station, m.date, m.hour, m.path))

    def get(self, station: str, date: str, hour: str | int) -> PartitionMeta | None:
        key = PartitionKey(station, date, hour)
        for meta in self.partitions:
            if meta.key.as_tuple == key.as_tuple:
                return meta
        return None

    def upsert(self, meta: PartitionMeta) -> None:
        """同 (station,date,hour) 只留一张卡；路径变了旧卡也撤掉。"""
        ident = meta.key.as_tuple
        self.partitions = [m for m in self.partitions if m.key.as_tuple != ident]
        self.partitions.append(meta)

    # -- 序列化 ---------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "layout": "hive",
            "partitions": [m.to_dict() for m in self.sorted()],
        }

    def to_json(self) -> str:
        # sort_keys + 固定缩进 + 结尾换行 -> 同一份清单重复写逐字节相同
        return json.dumps(
            self.to_dict(), ensure_ascii=False, sort_keys=True, indent=2
        ) + "\n"

    @classmethod
    def from_dict(cls, d: dict[str, Any], *, root: str | Path | None = None) -> PartitionManifest:
        version = int(d.get("schema_version", SCHEMA_VERSION))
        if version > SCHEMA_VERSION:
            raise ManifestError(
                f"清单 schema_version={version} 比本程序认识的 {SCHEMA_VERSION} 新"
            )
        return cls(
            partitions=[PartitionMeta.from_dict(item) for item in d.get("partitions", ())],
            root=Path(root) if root is not None else None,
        )

    @classmethod
    def from_json(cls, text: str, *, root: str | Path | None = None) -> PartitionManifest:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ManifestError(f"清单不是合法 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise ManifestError("清单根节点必须是对象")
        return cls.from_dict(data, root=root)

    # -- 落盘 -----------------------------------------------------
    @classmethod
    def load(cls, root: str | Path) -> PartitionManifest:
        """读 ``<root>/_manifest.json``；不存在时返回空清单（不是错误）。"""
        root = Path(root)
        path = root / MANIFEST_NAME
        if not path.exists():
            return cls(partitions=[], root=root)
        return cls.from_json(path.read_text(encoding="utf-8"), root=root)

    def save(self, root: str | Path | None = None) -> Path:
        """原子写清单：先写同目录临时文件，再 ``os.replace``。"""
        target_root = Path(root) if root is not None else self.root
        if target_root is None:
            raise ValueError("save() 需要 root")
        target_root.mkdir(parents=True, exist_ok=True)
        target = target_root / MANIFEST_NAME
        payload = self.to_json().encode("utf-8")
        if target.exists() and target.read_bytes() == payload:
            self.root = target_root
            return target
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_bytes(payload)
        os.replace(tmp, target)
        self.root = target_root
        return target

    # -- 扫描与校验 -----------------------------------------------
    @classmethod
    def scan(cls, root: str | Path) -> PartitionManifest:
        """遍历目录，为每个 NDJSON 文件重建一张卡。"""
        root = Path(root)
        if not root.exists():
            raise ManifestError(f"数据目录不存在：{root}")
        metas: list[PartitionMeta] = []
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in DATA_SUFFIXES:
                continue
            if path.name.startswith((".", "_")):
                continue
            rel = path.relative_to(root).as_posix()
            metas.append(inspect_file(path, root=root, relpath=rel))
        return cls(partitions=metas, root=root)

    def verify(self, root: str | Path | None = None, *, check_extra: bool = True) -> list[str]:
        """逐张卡重算文件指纹，返回问题列表（空列表 = 通过）。

        校验**不相信清单里的任何数字**：行数、sha256、字节数、列名、时间范围
        全部从文件重算。``check_extra=True`` 时还会报「盘上有、清单里没有」的文件。
        """
        target_root = Path(root) if root is not None else self.root
        if target_root is None:
            raise ValueError("verify() 需要 root")
        problems: list[str] = []
        for meta in self.sorted():
            path = target_root / meta.path
            if not path.is_file():
                problems.append(f"{meta.path}: 文件不存在")
                continue
            try:
                fresh = inspect_file(path, root=target_root, relpath=meta.path)
            except ManifestError as exc:
                problems.append(f"{meta.path}: 无法解析（{exc}）")
                continue
            for name in ("rows", "sha256", "bytes", "columns", "min_time", "max_time"):
                old, new = getattr(meta, name), getattr(fresh, name)
                if old != new:
                    problems.append(f"{meta.path}: {name} 清单={old!r} 实际={new!r}")
        if check_extra:
            on_disk = {
                p.relative_to(target_root).as_posix()
                for p in target_root.rglob("*")
                if p.is_file()
                and p.suffix.lower() in DATA_SUFFIXES
                and not p.name.startswith((".", "_"))
            }
            known = {m.path for m in self.partitions}
            for rel in sorted(on_disk - known):
                problems.append(f"{rel}: 盘上有文件但清单未登记")
        return problems


# ---------------------------------------------------------------- 单文件检查
def coerce_datetime(value: Any) -> datetime | None:
    """把 ISO 字符串 / datetime / epoch 秒统一成 UTC datetime；失败返回 None。"""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, _date):
        dt = datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        dt = datetime.fromtimestamp(float(value), timezone.utc)
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _time_sort_key(value: Any) -> tuple[int, Any] | None:
    """可比较的时间键；解析不了就退回字符串，避免整张卡扫不出来。"""
    if value is None or value == "":
        return None
    dt = coerce_datetime(value)
    if dt is not None:
        return (0, dt.timestamp())
    return (1, str(value))


def _time_text(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def inspect_file(path: str | Path, *, root: str | Path, relpath: str | None = None) -> PartitionMeta:
    """读一个分区文件，算出它的元数据卡。

    逐行流式读取，不整体载入内存；sha256 覆盖文件的**原始字节**（含换行符），
    所以换行符从 LF 变成 CRLF 也会被发现。
    """
    path = Path(path)
    root = Path(root)
    rel = relpath or path.relative_to(root).as_posix()
    key = parse_partition_relpath(rel)

    digest = hashlib.sha256()
    rows = 0
    size = 0
    columns: set[str] = set()
    time_field = ""
    low_key: tuple[int, Any] | None = None
    high_key: tuple[int, Any] | None = None
    low_text: str | None = None
    high_text: str | None = None

    with path.open("rb") as fh:
        for lineno, raw in enumerate(fh, start=1):
            size += len(raw)
            digest.update(raw)
            line = raw.strip()
            if not line:
                continue
            rows += 1
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ManifestError(f"{rel}:{lineno} 不是合法 JSON：{exc}") from exc
            if not isinstance(obj, dict):
                raise ManifestError(f"{rel}:{lineno} 不是 JSON 对象")
            columns.update(obj.keys())

            if not time_field:
                for name in TIME_FIELDS:
                    if obj.get(name) not in (None, ""):
                        time_field = name
                        break
            if not time_field:
                continue
            value = obj.get(time_field)
            sort_key = _time_sort_key(value)
            if sort_key is None:
                continue
            if low_key is None or sort_key < low_key:
                low_key, low_text = sort_key, _time_text(value)
            if high_key is None or sort_key > high_key:
                high_key, high_text = sort_key, _time_text(value)

    return PartitionMeta(
        station=key.station,
        date=key.date,
        hour=key.hour,
        path=rel,
        rows=rows,
        min_time=low_text,
        max_time=high_text,
        columns=tuple(sorted(columns)),
        sha256=digest.hexdigest(),
        bytes=size,
        time_field=time_field,
    )


def verify_manifest(root: str | Path, *, check_extra: bool = True) -> list[str]:
    """便捷函数：读清单并校验。没有清单时先 ``scan()`` 再比。"""
    root = Path(root)
    if not (root / MANIFEST_NAME).exists():
        return [f"缺少 {MANIFEST_NAME}"]
    return PartitionManifest.load(root).verify(root, check_extra=check_extra)


def scan(root: str | Path) -> PartitionManifest:
    """``PartitionManifest.scan`` 的模块级便捷写法。"""
    return PartitionManifest.scan(root)


def load(root: str | Path) -> PartitionManifest:
    """``PartitionManifest.load`` 的模块级便捷写法。"""
    return PartitionManifest.load(root)


def iter_data_files(
    root: str | Path,
    *,
    station: str | None = None,
    date: str | None = None,
    hour: str | int | None = None,
) -> Iterable[Path]:
    """按分区条件列出数据文件；有清单时用清单裁剪，没有就按目录名裁剪。"""
    root = Path(root)
    manifests = PartitionManifest.load(root)
    if manifests.partitions:
        for meta in manifests.sorted():
            if station is not None and meta.station != station:
                continue
            if date is not None and meta.date != _date.fromisoformat(str(date)).isoformat():
                continue
            if hour is not None and meta.hour != f"{int(hour):02d}":
                continue
            path = root / meta.path
            if path.is_file():
                yield path
        return

    if station is not None:
        candidates = [root / f"station={station}"]
    else:
        candidates = sorted(root.glob("station=*"))
    for sdir in candidates:
        if not sdir.is_dir():
            continue
        for ddir in sorted(sdir.glob("date=*")):
            if date is not None and ddir.name != f"date={_date.fromisoformat(str(date)).isoformat()}":
                continue
            for hdir in sorted(ddir.glob("hour=*")):
                if hour is not None and hdir.name != f"hour={int(hour):02d}":
                    continue
                for path in sorted(hdir.iterdir()):
                    if (
                        path.is_file()
                        and path.suffix.lower() in DATA_SUFFIXES
                        and not path.name.startswith((".", "_"))
                    ):
                        yield path
