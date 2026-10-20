"""共享黑板：台站 / 告警 / 工单上下文的受控读写（spec §4「上下文管理」）。

M5-1 把「agent 之间的数据通道」钉成消息总线；本模块补上另一半 —— **跨阶段的
上下文**：台站健康度、告警、工单这类「多个人要看、按需更新」的状态。spec §4 对
它的要求是两条：读写受控、并发访问语义明确。这里把它们变成可测的代码，语义说明
另见 ``docs/operations/blackboard.md``。

## 数据形状

* 键：``<命名空间>/<路径...>``。命名空间固定三类 —— ``station``（台站）、
  ``alert``（告警）、``order``（工单），与 spec §4 的括号逐字对应；路径段非空。
  例：``station/BADG``、``station/BADG/health``、``alert/A-0001``、``order/WO-0001``。
* 值：**dict**，且必须可 JSON 序列化（非 JSON 类型与 NaN/Inf 一律拒收 —— 与总线的
  序列化纪律同一条）。**整值替换，不提供就地修改**：想改就给一个新 dict。没有
  「就地改一半」这个口子，读者就不会看到写者改到一半的半个状态。
* 每个键带只增不减的版本号（创建从 1 开始，每次写 +1；**删除后重建也不回退**，
  从上一版本继续加，防止删除前拿到的 CAS token 在重建后命中新条目）与最近写入者
  ``by``。

## 并发语义（tests/test_m5_blackboard.py 用真线程钉死）

* **进程内、线程安全**：所有操作在一把 ``threading.RLock`` 下原子完成；值进出都
  深拷贝 —— 读到的对象与黑板内部不共享引用。
* **写分三种，默认路径是 CAS**：

  - ``create(key, value)``：键必须不存在，否则 ``BoardConflict``；
  - ``update(key, value, expect_version=n)``：版本不符 ``BoardConflict``；
  - ``upsert(key, value)``：无条件整值替换（显式 last-writer-wins），版本仍自增；
  - ``delete(key, expect_version=n)``：版本校验同 ``update``。

  静默覆盖会丢更新：两个写者各按 ``version=3`` 做决定、后写的赢，前一个的判断
  连同依据一起消失且没有痕迹。所以默认路径要带 ``expect_version``；无条件路径
  必须显式写 ``upsert``。
* **单键原子、多键不原子**：跨键一致性不在这里保证 —— 要喂给下游的走消息，
  要在黑板里保持一致的聚合成一个键。
* **变更事件**（``on_event``，可选）在锁内按**提交顺序**同步回调；**读不发事件**
  （读的留痕由工具层的 ``tool_call`` 覆盖）。回调要轻量：它挡着所有写者；
  同线程回调可重入（RLock）。
* 锁内不跑用户代码之外的东西：没有后台线程、没有定时器、没有中间件。

## 受控访问

``board.scope(reads=..., writes=..., actor=...)`` 生成 ``BoardView``。范围是一组
**前缀模式**：``"station"``（该命名空间全部）、``"station/BADG"``（含其子键）、
``"*"``（全部）。键等于模式、或以 ``模式 + "/"`` 开头才算命中 —— 所以
``station/BADG`` 不会命中 ``station/BADGX``。越权访问抛 ``BoardPermissionError``；
工具层（``tools/board_tools.py``）再把它翻成 ``ToolResult(ok=False, ...)`` ——
库层用异常、agent 层用失败结果，两侧的既有约定各自成立。

``pipeline.Pipeline`` 按每个阶段的 ``board_reads`` / ``board_writes`` 声明构造视图
并注入黑板工具：**声明是唯一的能力与范围来源**，阶段不声明，一个方向也碰不到。

本模块只用标准库。
"""
from __future__ import annotations

import copy
import json
import threading
from dataclasses import dataclass
from typing import Callable, Iterable

#: spec §4「台站 / 告警 / 工单上下文」对应的三个命名空间。
NAMESPACES = ("station", "alert", "order")


class BoardError(Exception):
    """黑板相关错误的基类。"""


class BoardConflict(BoardError):
    """版本或存在性与期望不符（CAS 失败）。调用方重读当前版本后重试。"""

    def __init__(self, key: str, expected: object, actual: object) -> None:
        super().__init__(
            f"黑板键 {key!r} 的期望 {expected!r} 与实际 {actual!r} 不符")
        self.key = key
        self.expected = expected
        self.actual = actual


class BoardPermissionError(BoardError):
    """访问超出视图范围。``allowed`` 是视图声明的模式。"""

    def __init__(self, key: str, op: str, allowed: tuple[str, ...]) -> None:
        super().__init__(f"对 {key!r} 的 {op} 超出视图范围：{list(allowed)}")
        self.key = key
        self.op = op
        self.allowed = allowed


@dataclass(frozen=True)
class BoardEntry:
    """一个上下文条目。``value`` 始终是调用方独享的深拷贝。"""

    key: str
    value: dict
    version: int
    by: str

    def to_dict(self) -> dict:
        return {"key": self.key, "value": self.value,
                "version": self.version, "by": self.by}


def check_key(key: object) -> str:
    """校验**条目键**的形状（命名空间 + 非空路径段），返回键本身。"""
    if not isinstance(key, str) or not key.strip():
        raise ValueError("黑板键必须是非空字符串")
    parts = key.split("/")
    if any(not part.strip() for part in parts):
        raise ValueError(f"黑板键 {key!r} 含空路径段")
    if parts[0] not in NAMESPACES:
        raise ValueError(
            f"黑板键 {key!r} 的命名空间必须在 {list(NAMESPACES)} 内")
    if len(parts) < 2:
        raise ValueError(
            f"黑板键 {key!r} 缺少路径段（命名空间下要有一个条目名，如 station/BADG）")
    return key


def check_prefix(prefix: object) -> str:
    """校验**前缀**（命名空间或条目键）：``snapshot`` 的子树过滤与范围模式用。"""
    if not isinstance(prefix, str) or not prefix.strip():
        raise ValueError("黑板前缀必须是非空字符串")
    parts = prefix.split("/")
    if any(not part.strip() for part in parts):
        raise ValueError(f"黑板前缀 {prefix!r} 含空路径段")
    if parts[0] not in NAMESPACES:
        raise ValueError(
            f"黑板前缀 {prefix!r} 的命名空间必须在 {list(NAMESPACES)} 内")
    return prefix


def check_value(value: object) -> None:
    """校验值的形状：必须是可 JSON 序列化的 dict（拒 NaN/Inf）。"""
    if not isinstance(value, dict):
        raise ValueError("黑板值必须是 dict（整值替换，不做就地修改）")
    try:
        json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"黑板值必须可 JSON 序列化（拒 NaN/Inf）：{exc}") from exc


def check_patterns(patterns: Iterable[str]) -> tuple[str, ...]:
    """校验范围模式（``*``、命名空间或条目键前缀），去重且保持顺序。"""
    out: list[str] = []
    for pattern in patterns:
        if not isinstance(pattern, str):
            raise ValueError(f"范围模式必须是字符串：{pattern!r}")
        if pattern != "*":
            check_prefix(pattern)
        if pattern not in out:
            out.append(pattern)
    return tuple(out)


def _matches(key: str, patterns: tuple[str, ...]) -> bool:
    for pattern in patterns:
        if pattern == "*" or key == pattern or key.startswith(pattern + "/"):
            return True
    return False


def _copy_entry(entry: BoardEntry) -> BoardEntry:
    return BoardEntry(key=entry.key, value=copy.deepcopy(entry.value),
                      version=entry.version, by=entry.by)


class Blackboard:
    """进程内共享上下文：受控读写、CAS 写、真线程安全。

    ``on_event`` 收到的是变更事件（``op`` ∈ create/update/upsert/delete，
    带 ``key`` / ``version`` / ``by``），锁内按提交顺序同步调用。
    """

    def __init__(self, *, on_event: Callable[[dict], None] | None = None) -> None:
        self._lock = threading.RLock()
        self._entries: dict[str, BoardEntry] = {}
        #: 每个键见过的最大版本。删除不清理 —— 删除后重建的版本继续往上加，
        #: 否则删除前拿到的 CAS token 会在重建后命中新条目（ABA）。
        self._versions: dict[str, int] = {}
        self._on_event = on_event

    # ------------------------------------------------------------------ 读
    def read(self, key: str) -> BoardEntry | None:
        """读一个键；不存在返回 ``None``，返回值是深拷贝。"""
        key = check_key(key)
        with self._lock:
            entry = self._entries.get(key)
            return None if entry is None else _copy_entry(entry)

    def snapshot(self, prefix: str | None = None) -> dict[str, BoardEntry]:
        """一致性快照（锁内一次性深拷贝）。``prefix`` 给命名空间或键前缀即只取该子树。"""
        if prefix is not None:
            prefix = check_prefix(prefix)
        with self._lock:
            return {
                key: _copy_entry(entry)
                for key, entry in sorted(self._entries.items())
                if prefix is None or key == prefix or key.startswith(prefix + "/")
            }

    def keys(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(sorted(self._entries))

    # ------------------------------------------------------------------ 写
    def create(self, key: str, value: dict, *, by: str = "") -> BoardEntry:
        """新建：键必须不存在（否则 ``BoardConflict``）。"""
        key = check_key(key)
        check_value(value)
        with self._lock:
            current = self._entries.get(key)
            if current is not None:
                raise BoardConflict(key, "键不存在", f"已存在（version={current.version}）")
            version = self._versions.get(key, 0) + 1
            entry = BoardEntry(key, copy.deepcopy(value), version, by)
            self._entries[key] = entry
            self._versions[key] = version
            self._notify("create", entry)
            return _copy_entry(entry)

    def update(self, key: str, value: dict, *, expect_version: int,
               by: str = "") -> BoardEntry:
        """CAS 更新：版本不符（或键不存在）抛 ``BoardConflict``。"""
        key = check_key(key)
        check_value(value)
        with self._lock:
            current = self._entries.get(key)
            if current is None:
                raise BoardConflict(key, expect_version, "键不存在")
            if current.version != expect_version:
                raise BoardConflict(key, expect_version, current.version)
            entry = BoardEntry(key, copy.deepcopy(value), current.version + 1, by)
            self._entries[key] = entry
            self._versions[key] = entry.version
            self._notify("update", entry)
            return _copy_entry(entry)

    def upsert(self, key: str, value: dict, *, by: str = "") -> BoardEntry:
        """无条件整值替换（显式 last-writer-wins），版本仍自增。"""
        key = check_key(key)
        check_value(value)
        with self._lock:
            version = self._versions.get(key, 0) + 1
            entry = BoardEntry(key, copy.deepcopy(value), version, by)
            self._entries[key] = entry
            self._versions[key] = version
            self._notify("upsert", entry)
            return _copy_entry(entry)

    def delete(self, key: str, *, expect_version: int, by: str = "") -> BoardEntry:
        """CAS 删除：返回被删条目。版本不符或键不存在抛 ``BoardConflict``。"""
        key = check_key(key)
        with self._lock:
            current = self._entries.get(key)
            if current is None:
                raise BoardConflict(key, expect_version, "键不存在")
            if current.version != expect_version:
                raise BoardConflict(key, expect_version, current.version)
            del self._entries[key]
            self._notify("delete", current, by=by)
            return _copy_entry(current)

    def _notify(self, op: str, entry: BoardEntry, *, by: str | None = None) -> None:
        """锁内按提交顺序回调；读不发事件。``by`` 缺省取条目上的写入者。"""
        if self._on_event is None:
            return
        self._on_event({"op": op, "key": entry.key,
                        "version": entry.version,
                        "by": entry.by if by is None else by})

    # ------------------------------------------------------------ 受控视图
    def scope(self, reads: Iterable[str] = (), writes: Iterable[str] = (),
              *, actor: str = "") -> "BoardView":
        """造一个受控视图。``actor`` 会写进该视图所有写入的 ``by``。"""
        return BoardView(self, check_patterns(reads), check_patterns(writes),
                         actor=actor)


class BoardView:
    """黑板的一个受控视图：只能碰 ``reads`` / ``writes`` 范围内的键。

    范围语义与 ``Blackboard.scope`` 一致（前缀模式，``*`` 全通）。
    越权一律抛 ``BoardPermissionError``，不静默返回空。
    """

    def __init__(self, board: Blackboard, reads: tuple[str, ...],
                 writes: tuple[str, ...], *, actor: str = "") -> None:
        self._board = board
        self.reads = reads
        self.writes = writes
        self.actor = actor

    def _ensure(self, key: object, patterns: tuple[str, ...], op: str) -> str:
        key = check_key(key)
        if not _matches(key, patterns):
            raise BoardPermissionError(key, op, patterns)
        return key

    def scope_dict(self) -> dict:
        """范围的可序列化描述（进工具描述/trace 用）。"""
        return {"reads": list(self.reads), "writes": list(self.writes),
                "actor": self.actor}

    # 读
    def read(self, key: str) -> BoardEntry | None:
        key = self._ensure(key, self.reads, "read")
        return self._board.read(key)

    def snapshot(self, prefix: str | None = None) -> dict[str, BoardEntry]:
        """只含读范围内的键；``prefix`` 另按前缀过滤（可落在范围外，则得空）。"""
        entries = self._board.snapshot(prefix)
        return {key: entry for key, entry in entries.items()
                if _matches(key, self.reads)}

    def keys(self) -> tuple[str, ...]:
        return tuple(key for key in self._board.keys()
                     if _matches(key, self.reads))

    # 写
    def create(self, key: str, value: dict) -> BoardEntry:
        key = self._ensure(key, self.writes, "create")
        return self._board.create(key, value, by=self.actor)

    def update(self, key: str, value: dict, *, expect_version: int) -> BoardEntry:
        key = self._ensure(key, self.writes, "update")
        return self._board.update(key, value, expect_version=expect_version,
                                  by=self.actor)

    def upsert(self, key: str, value: dict) -> BoardEntry:
        key = self._ensure(key, self.writes, "upsert")
        return self._board.upsert(key, value, by=self.actor)

    def delete(self, key: str, *, expect_version: int) -> BoardEntry:
        key = self._ensure(key, self.writes, "delete")
        return self._board.delete(key, expect_version=expect_version,
                                  by=self.actor)
