#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NovAtel SBF 二进制日志解析器（纯标准库）。

## 为什么要有这个文件

`reader.sniff` 原来对厂商原始格式只回一句「请先导出 RINEX」。实测拿到的采集
（`逆向/00_来源/samples/live-20261031/b*.sbf`）就是原始 SBF，用户手上也只会是
这一份东西 —— 要求先装厂商工具转一遍，等于把可用数据挡在门外。

## 依据（全部是 tracked 文件，不是凭记忆）

| 内容 | 依据文件 |
|---|---|
| CRC-32 的初值/终值/方向 | `逆向/04_重实现/packages/protocol/src/crc.ts` |
| 长头 28B / 短头 12B、同步字 | 同上 `header.ts` |
| 六种记录起点的有状态解帧 | 同上 `framing.ts` |
| 字段偏移与类型 | 同上 `data/edie-layouts.json` |

**CRC 与标准 CRC-32 有三处不同**（`crc.ts` 顶部注释原文）：反射多项式
`0xEDB88320`、**初值 0**、**无最终异或**。写成 `zlib.crc32` 的等价物会全帧对不上。

## 解帧的三条实测事实

1. **记录不只一种。** 一份真实采集里同时有二进制帧、`#XXXA,` 完整 ASCII 行、
   `<XXX ` 多行 abbreviated ASCII 块。`Convert` 的 `Source #` 统计的是三者的合计：
   b1 的 RANGE = 530 帧 + 26 个 `<RANGE` 块 = 556，与
   `golden-b1-*.ABBREV_Summary.txt` 的 `556` 一致。只看二进制帧会少算 5%。

2. **坏帧跳过但计数。** 静默丢的表现是「解析出 1000 条、实际 1200 条」而没人知道。
   本模块把每一次丢弃都记进 `SbfStats.dropped`，`total_bytes_dropped` 可交叉核对。

3. **末尾半个帧不算坏帧。** 采集中断在帧中间是正常结束，记 `truncated_tail` 即可，
   不记 `dropped`。

## 长度字段的两个坑

- **`payload_len < 8` 判坏帧**，且前进只跳过 sync（`i += 3`），**不是** `i += total`。
  否则 `payload_len = 0` 时 `total = 32`，看着合理却把后面 32 字节吞掉；若连
  `header_len` 也可疑就会 `i += 0` 死循环。
- **`block_id & 0x1FFF`**：高 3 位是别的标志，直接拿原值查表会查不到。

## 输出

落成与 CSV/RINEX 相同的 `fieldstation.model.Observation`，下游不用改。
`ingest/reader.py` 的 `ObservationFile` 通过 `sbf.SbfFile` 接入。
"""
from __future__ import annotations

import datetime
import math
from dataclasses import dataclass, field
from typing import Iterator

MISSING = float("nan")

# ---------------------------------------------------------------- 协议常量
SYNC_1 = 0xAA
SYNC_2 = 0x44
SYNC_BINARY_FULL = 0x12
SYNC_BINARY_SHORT = 0x13

LONG_HEADER_LENGTH = 28
SHORT_HEADER_LENGTH = 12

#: `crc.ts`：反射多项式 0xEDB88320、初值 0、无终值异或。
CRC32_POLYNOMIAL = 0xEDB88320

#: 低于这个值的 `payload_len` 视为坏帧（见模块注释「长度字段的两个坑」）。
MIN_PAYLOAD_LEN = 8

#: 记录起点候选。`framing.ts:81` 原文，顺序即优先级（取最早出现的那个）。
_RECORD_STARTS = (
    SYNC_1,      # 二进制帧
    0x23,        # '#'
    0x25,        # '%'
    0x3C,        # '<'
    0x5B,        # '[' 端口文本
    0x24,        # '$' NMEA
)

#: 短头 `0xAA 0x44 0x13` 的 `payload_len` 只有 1 字节，上限 255。
_SHORT_MAX_PAYLOAD = 0xFF

_BYTE_AT = bytes(range(256))          # find(单字节) 用；比 bytes([b]) 少一次分配
_AA = b"\xaa"


def _build_crc_table() -> list[int]:
    """`crc.ts` 的 `TABLE` —— 反射多项式、8 次移位，**照抄，不换写法**。"""
    table = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ CRC32_POLYNOMIAL if (c & 1) else c >> 1
        table.append(c)
    return table


_CRC_TABLE = _build_crc_table()


def novatel_crc32(data: bytes | memoryview, crc: int = 0) -> int:
    """NovAtel CRC-32：初值 0、无终值异或。

    `crc.ts` 的 `novatelCrc32` 逐行对应。与 `zlib.crc32` **不等价** ——
    后者初值/终值都取反。这两个差异会让每一帧都校验失败。
    """
    table = _CRC_TABLE
    for b in data:
        crc = (table[(crc ^ b) & 0xFF] ^ (crc >> 8)) & 0xFFFFFFFF
    return crc


def crc_hex(crc: int) -> str:
    """八个十六进制小写、左补零 —— ASCII 日志/命令里的形式。"""
    return "%08x" % (crc & 0xFFFFFFFF)


# ---------------------------------------------------------------- 帧结构
@dataclass(frozen=True)
class SbfHeader:
    """SBF 消息头。长头 28B、短头 12B，字段偏移见 `header.ts:83-123`。"""

    kind: str                    # 'long' | 'short'
    header_length: int
    message_id: int

    # 长头独有（短头为 None / 0）
    message_type_byte: int = 0
    port_address: int = 0
    sequence: int = 0
    idle_time_raw: int = 0
    time_status: int = 0
    receiver_status: int = 0
    reserved: int = 0
    software_version: int = 0

    payload_length: int = 0
    week: int = 0
    milliseconds: int = 0

    @property
    def is_response(self) -> bool:
        return bool(self.message_type_byte & 0x80)

    @property
    def secondary_antenna(self) -> bool:
        return bool(self.message_type_byte & 0x01)

    @property
    def format(self) -> str:
        """`header.ts:66-77` 的 `formatOf`。"""
        return {0: "binary", 1: "ascii", 2: "abbreviated-ascii"}.get(
            (self.message_type_byte >> 5) & 0b11, "reserved")

    @property
    def frame_length(self) -> int:
        """头 + 载荷 + 4 字节 CRC。"""
        return self.header_length + self.payload_length + 4

    @property
    def gps_tow_s(self) -> float:
        return self.milliseconds / 1000.0


@dataclass
class SbfFrame:
    """一帧完整记录（头 + 载荷 + CRC 原样保留）。"""

    header: SbfHeader
    raw: bytes
    offset: int                 # 在流里的起始字节偏移
    crc_field: int
    crc_ok: bool

    @property
    def payload(self) -> bytes:
        h = self.header
        return self.raw[h.header_length:h.header_length + h.payload_length]

    @property
    def message_id(self) -> int:
        return self.header.message_id


@dataclass
class TextRecord:
    """ASCII / abbreviated ASCII 记录（不是二进制帧，但同样是「一条记录」）。"""

    prefix: str                 # '#' | '%' | '<' | '[' | '$'
    text: str
    offset: int
    name: str = ""              # '#' / '<' 形式能解析出日志名，其余为空

    @property
    def is_binary(self) -> bool:
        return False


@dataclass
class SbfStats:
    """解帧统计。**坏帧计数在这里，不许静默丢。**"""

    frames: int = 0
    text_records: int = 0
    by_message_id: dict[int, int] = field(default_factory=dict)
    by_name: dict[str, int] = field(default_factory=dict)
    #: 丢弃的字节数，键是原因
    dropped: dict[str, int] = field(default_factory=dict)
    #: 每种记录类型校验失败但被接受/拒绝的帧数
    crc_mismatch: int = 0
    zero_crc: int = 0
    #: 流末尾未完成的半帧字节数（**不算坏帧**）
    truncated_tail: int = 0
    resyncs: int = 0

    @property
    def total_bytes_dropped(self) -> int:
        return sum(self.dropped.values())

    @property
    def total_records(self) -> int:
        return self.frames + self.text_records

    def as_dict(self) -> dict:
        return {
            "frames": self.frames,
            "text_records": self.text_records,
            "total_records": self.total_records,
            "by_message_id": dict(sorted(self.by_message_id.items())),
            "by_name": dict(sorted(self.by_name.items())),
            "dropped": dict(sorted(self.dropped.items())),
            "total_bytes_dropped": self.total_bytes_dropped,
            "crc_mismatch": self.crc_mismatch,
            "zero_crc": self.zero_crc,
            "truncated_tail": self.truncated_tail,
            "resyncs": self.resyncs,
        }


# ---------------------------------------------------------------- 解帧
def parse_header(buf: bytes | memoryview, offset: int = 0) -> SbfHeader | None | str:
    """解析 `offset` 处的消息头。

    返回 `SbfHeader`；数据不够返回 `'need-more'`；同步字或长度自相矛盾返回 `None`。
    与 `header.ts:83-123` 的 `parseHeader` 同义。
    """
    n = len(buf)
    if offset + 2 >= n:
        return "need-more"
    if buf[offset] != SYNC_1 or buf[offset + 1] != SYNC_2:
        return None
    sync3 = buf[offset + 2]
    if sync3 == SYNC_BINARY_FULL:
        if n - offset < LONG_HEADER_LENGTH:
            return "need-more"
        o = offset
        msg_type = buf[o + 6]
        return SbfHeader(
            kind="long",
            header_length=LONG_HEADER_LENGTH,
            message_id=int.from_bytes(buf[o + 4:o + 6], "little"),
            message_type_byte=msg_type,
            port_address=buf[o + 7],
            payload_length=int.from_bytes(buf[o + 8:o + 10], "little"),
            sequence=int.from_bytes(buf[o + 10:o + 12], "little"),
            idle_time_raw=buf[o + 12],
            time_status=buf[o + 13],
            week=int.from_bytes(buf[o + 14:o + 16], "little"),
            milliseconds=int.from_bytes(buf[o + 16:o + 20], "little"),
            receiver_status=int.from_bytes(buf[o + 20:o + 24], "little"),
            reserved=int.from_bytes(buf[o + 24:o + 26], "little"),
            software_version=int.from_bytes(buf[o + 26:o + 28], "little"),
        )
    if sync3 == SYNC_BINARY_SHORT:
        if n - offset < SHORT_HEADER_LENGTH:
            return "need-more"
        o = offset
        return SbfHeader(
            kind="short",
            header_length=SHORT_HEADER_LENGTH,
            message_id=int.from_bytes(buf[o + 4:o + 6], "little"),
            payload_length=buf[o + 3],
            week=int.from_bytes(buf[o + 6:o + 8], "little"),
            milliseconds=int.from_bytes(buf[o + 8:o + 12], "little"),
        )
    return None


def _earliest_record_start(buf: bytes | memoryview, start: int) -> int:
    """`framing.ts:313` 的 `earliestCandidate`：六个候选里取最早。"""
    best = -1
    for byte in _RECORD_STARTS:
        at = buf.find(_BYTE_AT[byte:byte + 1], start)
        if at >= 0 and (best < 0 or at < best):
            best = at
        if best == start:
            break
    return best


def _complete_hash_line(buf: bytes | memoryview, start: int, limit: int) -> bool:
    """`framing.ts:294` 的 `completeHashLine`：`#NAME,...*<8 hex>` 自校验通过吗。

    RXCONFIG 会把另一条记录整段嵌在自己正文里
    （`#RXCONFIGA,<head>;#LOGA,<head>;<body>*<inner>*<outer>`）。这种**自己 CRC 就对**
    的行必须整条保留，不能当成「被截断的文本」去切。
    """
    if buf[start] != 0x23:
        return False
    end = limit
    while end > start and buf[end - 1] in (0x0D, 0x0A):
        end -= 1
    if end - start < 12 or buf[end - 9] != 0x2A:      # '*'
        return False
    crc = 0
    for i in range(end - 8, end):
        c = buf[i]
        if 0x30 <= c <= 0x39:
            d = c - 0x30
        elif 0x61 <= c <= 0x66:
            d = c - 0x57
        elif 0x41 <= c <= 0x46:
            d = c - 0x37
        else:
            return False
        crc = crc * 16 + d
    return novatel_crc32(buf[start + 1:end - 9]) == crc


def _text_boundary(buf: bytes | memoryview, start: int, limit: int) -> int:
    """`framing.ts:274` 的 `textBoundary`：文本记录里第一个「能开始新记录」的位置。

    只看二进制同步字与 `#`。实测：`$GPGGA,…` 后面没有 CRLF 直接跟二进制帧，
    NMEA 句子被丢弃、帧被保留；后面跟 `<BESTPOS` 则两边都拿不到（`<` 不是边界）。
    """
    if _complete_hash_line(buf, start, limit):
        return -1
    n = len(buf)
    for j in range(start + 1, limit):
        if buf[j] == 0x23:
            return j
        if buf[j] == SYNC_1 and j + 2 < n and buf[j + 2] in (SYNC_BINARY_FULL, SYNC_BINARY_SHORT):
            return j
    return -1


# ---------------------------------------------------------------- 消息名
#: 只有解析器真正用到的那几个 + 摘要里常见的那批。其余按 `ID_<n>` 呈现。
#: 完整表在 `逆向/04_重实现/packages/protocol/data/msgids.json`（608 条），
#: 这里**不整份复制**：解析不需要，复制过来只会变成第二份要维护的真相。
MESSAGE_NAMES: dict[int, str] = {
    37: "VERSION",
    41: "RAWEPHEM",
    42: "BESTPOS",
    43: "RANGE",
    47: "RAWDMI",
    72: "PORTSTATS",
    83: "TRACKSTAT",
    93: "RXSTATUS",
    94: "RXSTATUSEVENT",
    99: "BESTVEL",
    101: "TIME",
    128: "RXCONFIG",
    140: "RANGECMP",
    174: "PSRDOP",
    181: "MARKPOS",
    206: "VALIDMODELS",
    241: "BESTXYZ",
    243: "PSRPOS",
    317: "COMCONFIG",
    469: "PDPPOS",
    470: "PDPVEL",
    471: "PDPXYZ",
    631: "RANGEGPSL1",
    723: "GLOEPHEMERIS",
    963: "HWMONITOR",
    1043: "SATVIS2",
    1122: "GALEPHEMERIS",
    1126: "GALINAVRAWEPHEMERIS",
    1148: "CHANCONFIGLIST",
    1194: "BESTSATS",
    1234: "PDPSATS",
    1235: "SOFTLOADSTATUS",
    1246: "SERIALCONFIG",
    1273: "RANGECMP2",
    1329: "MODELFEATURES",
    1342: "PASSTHROUGH",
    1696: "BDSEPHEMERIS",
    1730: "VERIPOSSTATUS",
    1734: "RANGECMP3",
    1968: "ITPSDFINAL",
    2050: "RANGECMP4",
    2063: "ITPSDDETECT",
    2065: "ITDETECTSTATUS",
    2296: "GEODETICDATUMS",
    2298: "DATUMTRANSFORMATIONS",
    2300: "PSRDATUMINFO",
    2302: "BESTGNSSDATUMINFO",
    2305: "BESTDATUMINFO",
    2520: "BDSBCNAV3RAWMESSAGE2",
    2537: "RANGECMP5",
}

#: 已知日志名的集合，供 `_text_name` 判定「去掉版本字母后是不是真名字」。
_KNOWN_NAMES = frozenset(MESSAGE_NAMES.values())


def message_name(message_id: int) -> str:
    """`block_id & 0x1FFF` 才是消息号；高 3 位是别的标志。"""
    mid = message_id & 0x1FFF
    return MESSAGE_NAMES.get(mid, "ID_%d" % mid)


def _text_name(text: str) -> str:
    """从文本记录取日志名。`#RANGEA,SPECIAL,…` -> `RANGE`；`<RANGE USB2 …` -> `RANGE`。

    **纯数字开头的是 abbreviated ASCII 的续行**（`<     84`、`<  17 0 …`），
    它们不构成新记录，返回空串。名字取不到也返回空串 —— 这只是装饰信息，
    绝不能因为它让整份文件解析中断。
    """
    if not text:
        return ""
    prefix = text[0]
    body = text[1:] if prefix in "#<" else text
    parts = body.replace(",", " ").split()
    if not parts:
        return ""
    head = parts[0].strip().upper()
    if not head or head.isdigit():
        return ""                       # 续行 / 非日志行
    # `#` 形式的末尾单字母是**版本**，不属于名字：`RANGEA`/`BESTPOSA`/`RXCONFIGA`。
    # 只有「去掉后确实是已知日志名」才去 —— 不靠猜。
    if prefix == "#" and len(head) > 1 and head[-1].isalpha():
        trimmed = head[:-1]
        if trimmed in _KNOWN_NAMES:
            return trimmed
    return head


class SbfDeframer:
    """有状态字节流解帧器。

    `push()` 喂字节、拿记录；`end()` 收尾（把缓冲里的半帧记成 `truncated_tail`）。
    跨 `push()` 的部分帧留在内部缓冲，**不丢**。
    """

    #: `crc_mode`：
    #:   'validate' —— 要求 CRC 字段非零 **且** 校验通过（本模块默认，宁缺勿错）
    #:   'mirror'   —— 只丢 CRC 字段为 0 的（`framing.ts` 的默认，复刻原程序行为）
    def __init__(self, crc_mode: str = "validate"):
        if crc_mode not in ("validate", "mirror"):
            raise ValueError("crc_mode 只能是 'validate' 或 'mirror'")
        self.crc_mode = crc_mode
        self._pending = b""
        self._received = 0
        self._recovering = False
        self.stats = SbfStats()

    # -- 统计 --------------------------------------------------------
    def _drop(self, nbytes: int, reason: str) -> None:
        if nbytes <= 0:
            return
        self.stats.dropped[reason] = self.stats.dropped.get(reason, 0) + nbytes

    def _count(self, rec: SbfFrame | TextRecord) -> None:
        if isinstance(rec, SbfFrame):
            self.stats.frames += 1
            mid = rec.message_id
            self.stats.by_message_id[mid] = self.stats.by_message_id.get(mid, 0) + 1
            name = MESSAGE_NAMES.get(mid, "ID_%d" % mid)
            self.stats.by_name[name] = self.stats.by_name.get(name, 0) + 1
        else:
            self.stats.text_records += 1
            if rec.name:
                self.stats.by_name[rec.name] = self.stats.by_name.get(rec.name, 0) + 1

    # -- 主体 --------------------------------------------------------
    def push(self, chunk: bytes) -> list[SbfFrame | TextRecord]:
        if not chunk:
            return []
        base = self._received - len(self._pending)
        buf = self._pending + chunk if self._pending else chunk
        self._received += len(chunk)
        self._pending = b""

        out: list[SbfFrame | TextRecord] = []
        n = len(buf)
        i = 0

        while i < n:
            found = _earliest_record_start(buf, i)
            if found < 0:
                self._drop(n - i, "no-record-start")
                return out
            if found > i:
                self._drop(found - i, "garbage-before-record")
                i = found

            # 从被拒记录里恢复时只认二进制同步字：载荷里的 '<'/'#'/'$'
            # 会开出一条跑到下个换行的「文本记录」，把后面真正的帧吞掉。
            if self._recovering and buf[i] != SYNC_1:
                i += 1
                continue

            if buf[i] != SYNC_1:
                nxt = self._read_text(buf, i, n, base, out)
                if nxt < 0:                    # 文本记录还没读完，缓冲到下次
                    self._pending = bytes(buf[self._tail_from:])
                    return out
                i = nxt
                continue

            # 二进制：至少 3 字节才知是哪种头
            if n - i < 3:
                self._pending = bytes(buf[i:])
                return out
            if buf[i + 2] not in (SYNC_BINARY_FULL, SYNC_BINARY_SHORT):
                i += 1                          # 不是 NovAtel 同步字，逐字节重扫
                continue

            header = parse_header(buf, i)
            if header == "need-more":
                self._pending = bytes(buf[i:])
                return out
            if header is None:
                i += 1
                continue

            # 「长度字段的两个坑」之一：payload_len 过小必是坏帧，
            # 且只跳过 sync 三个字节，绝不按可疑的 total 前进。
            if header.payload_length < MIN_PAYLOAD_LEN:
                self._drop(1, "payload-too-short")
                self._recovering = True
                self.stats.resyncs += 1
                i += 3
                continue

            total = header.frame_length
            if n - i < total:
                self._pending = bytes(buf[i:])
                return out

            raw = bytes(buf[i:i + total])
            crc_field = int.from_bytes(raw[-4:], "little")
            crc_ok = novatel_crc32(raw[:-4]) == crc_field

            if crc_field == 0:
                self.stats.zero_crc += 1
                accept = False                      # 两种模式都丢
            elif crc_ok:
                accept = True
            else:
                self.stats.crc_mismatch += 1
                accept = self.crc_mode == "mirror"  # mirror 模式复刻原程序：不验值

            if accept:
                self._recovering = False
                frame = SbfFrame(header=header, raw=raw, offset=base + i,
                                 crc_field=crc_field, crc_ok=crc_ok)
                self._count(frame)
                out.append(frame)
                i += total
            else:
                self._drop(1, "zero-crc-field" if crc_field == 0 else "crc-mismatch")
                # 不信被拒记录的长度字段：按头部前进（`framing.ts:69` 实测选 header）
                self._recovering = True
                self.stats.resyncs += 1
                i += header.header_length

        return out

    # -- 文本记录 ----------------------------------------------------
    _tail_from = 0      # `_read_text` 回传「从这里到末尾要缓冲」的位置

    def _read_text(self, buf, i, n, base, out) -> int:
        is_port = buf[i] == 0x5B
        terminator = 0x5D if is_port else 0x0A
        end = buf.find(_BYTE_AT[terminator:terminator + 1], i)
        limit = n if end < 0 else end
        boundary = _text_boundary(buf, i, limit)
        if boundary >= 0:
            # 文本还没结束就被下一条记录截断：这块字节没有任何记录产出，算丢弃
            self._drop(boundary - i, "record-start-inside-text")
            return boundary
        if end < 0:
            self._tail_from = i
            return -i                      # 负数 = 需要更多数据
        chunk = bytes(buf[i:end + 1])
        text = chunk.decode("latin-1")
        rec = TextRecord(prefix=chr(0x5B if is_port else chunk[0]),
                         text=text, offset=base + i, name=_text_name(text))
        self._count(rec)
        out.append(rec)
        return end + 1

    def end(self) -> None:
        """流结束：缓冲里剩下的半帧记 `truncated_tail`，**不记坏帧**。"""
        rest = len(self._pending)
        self._pending = b""
        if rest:
            self.stats.truncated_tail = rest

    @property
    def buffered(self) -> int:
        return len(self._pending)


# ---------------------------------------------------------------- 字段解码
#: `edie-layouts.json` 的 `type` -> 读取方式。只覆盖 RANGE/BESTPOS/SATVIS2 用到的。
_SCALAR_READERS = {
    "u8": lambda b: b[0],
    "u16": lambda b: int.from_bytes(b[:2], "little"),
    "u32": lambda b: int.from_bytes(b[:4], "little"),
    "i32": lambda b: int.from_bytes(b[:4], "little", signed=True),
    "f32": lambda b: _unpack("f", b),
    "f64": lambda b: _unpack("d", b),
}

import struct as _struct


def _unpack(fmt: str, b: bytes) -> float:
    try:
        return _struct.unpack("<" + fmt, b[:(_struct.calcsize("<" + fmt))])[0]
    except _struct.error:
        return MISSING


# ---------------------------------------------------------------- RANGE 观测
@dataclass
class RangeObservation:
    """`RANGE`(#43) 数组里的一条 —— 与 `edie-layouts.json` 的 43 号布局一一对应。

    偏移：sv_prn 0(u16) / sv_freq 2(u16) / psr 4(f64) / sd_psr 12(f32) /
    adr 16(f64) / sd_adr 24(f32) / dop 28(f32) / C_No 32(f32) /
    lock_time 36(f32) / c_status 40(u32)。步长 44。
    """

    sv_prn: int
    sv_freq: int
    psr: float
    sd_psr: float
    adr: float
    sd_adr: float
    dop: float
    cn0: float
    lock_time: float
    c_status: int

    # -- c_status 里的三个字段（Table 182）--------------------------
    @property
    def system_code(self) -> int:
        """`c_status` bit 16-18：0 GPS / 1 GLO / 2 SBAS / 3 GAL / 4 BDS / 5 QZS / 6 NavIC。"""
        return (self.c_status >> 16) & 0x07

    @property
    def signal_type(self) -> int:
        """`c_status` bit 21-25：按系统各自编号的 5 位信号类型。"""
        return (self.c_status >> 21) & 0x1F

    @property
    def channel(self) -> int:
        return (self.c_status >> 5) & 0x1F


RANGE_STRIDE = 44
RANGE_COUNT_SIZE = 4


def decode_range(payload: bytes) -> list[RangeObservation]:
    """解 `RANGE`(#43) 载荷：前 4 字节是条数，之后每条 44 字节。

    `edie-layouts.json` 43 号：`obs` 数组，`arrayKind: field`、`stride: 44`、
    `countSize: 4`。条数**以实际可用字节裁一次**：头里写的条数比载荷大时
    不越界读，也不假装拿满。
    """
    if len(payload) < RANGE_COUNT_SIZE:
        return []
    declared = int.from_bytes(payload[:4], "little")
    usable = (len(payload) - RANGE_COUNT_SIZE) // RANGE_STRIDE
    count = min(declared, usable)
    out: list[RangeObservation] = []
    for k in range(count):
        at = RANGE_COUNT_SIZE + k * RANGE_STRIDE
        blk = payload[at:at + RANGE_STRIDE]
        out.append(RangeObservation(
            sv_prn=int.from_bytes(blk[0:2], "little"),
            sv_freq=int.from_bytes(blk[2:4], "little"),
            psr=_unpack("d", blk[4:12]),
            sd_psr=_unpack("f", blk[12:16]),
            adr=_unpack("d", blk[16:24]),
            sd_adr=_unpack("f", blk[24:28]),
            dop=_unpack("f", blk[28:32]),
            cn0=_unpack("f", blk[32:36]),
            lock_time=_unpack("f", blk[36:40]),
            c_status=int.from_bytes(blk[40:44], "little"),
        ))
    return out


# ---------------------------------------------------------------- BESTPOS
@dataclass
class BestPos:
    """`BESTPOS`(#42) 的定位解。只取本站真正会用的那几项。"""

    solution_status: int
    position_type: int
    latitude_deg: float
    longitude_deg: float
    height_m: float
    undulation_m: float
    num_svs: int
    num_soln_svs: int


def decode_bestpos(payload: bytes) -> BestPos | None:
    """解 `BESTPOS`(#42)。偏移见 `edie-layouts.json` 42 号。"""
    if len(payload) < 72:
        return None
    return BestPos(
        solution_status=int.from_bytes(payload[0:4], "little"),
        position_type=int.from_bytes(payload[4:8], "little"),
        latitude_deg=_unpack("d", payload[8:16]),
        longitude_deg=_unpack("d", payload[16:24]),
        height_m=_unpack("d", payload[24:32]),
        undulation_m=_unpack("f", payload[32:36]),
        num_svs=payload[64],
        num_soln_svs=payload[65],
    )


# ---------------------------------------------------------------- SATVIS2
@dataclass
class SatVis:
    """`SATVIS2`(#1043) 的一条卫星可见性记录。"""

    prn_id: int
    elevation_deg: float
    azimuth_deg: float


SATVIS_STRIDE = 40
SATVIS_HEADER = 12


def decode_satvis2(payload: bytes) -> list[SatVis]:
    """解 `SATVIS2`(#1043)：12 字节头 + N × 40 字节。

    每条：id 0(satid,u32) / health 4 / elevation 8(f64) / azimuth 16(f64) /
    doppler 24(f64) / apparent 32(f64)。
    """
    if len(payload) < SATVIS_HEADER:
        return []
    declared = int.from_bytes(payload[8:12], "little")
    usable = (len(payload) - SATVIS_HEADER) // SATVIS_STRIDE
    out = []
    for k in range(min(declared, usable)):
        at = SATVIS_HEADER + k * SATVIS_STRIDE
        blk = payload[at:at + SATVIS_STRIDE]
        out.append(SatVis(
            prn_id=int.from_bytes(blk[0:4], "little"),
            elevation_deg=_unpack("d", blk[8:16]),
            azimuth_deg=_unpack("d", blk[16:24]),
        ))
    return out


# ---------------------------------------------------------------- 系统/信号映射
#: `rangecmp.ts:135` 的 Table 145 / Table 182 对照。
SYSTEM_BY_CODE = {0: "GPS", 1: "GLO", 2: "SBAS", 3: "GAL", 4: "BDS", 5: "QZS", 6: "IRN"}

#: Table 182 的 signal type（**按系统各自编号**）-> (信号名, 频率 Hz)。
#: 只登记本项目下游真正用到的；查不到就返回 None，**不猜一个频率**。
#: 依据 `rangecmp.ts:175-227` 的 `SIGNALS`（status 即 Table 182 的 signal type）。
_SIGNAL_TABLE: dict[str, dict[int, tuple[str, float]]] = {
    "GPS": {
        0: ("L1", 1575.42e6),
        9: ("L2", 1227.60e6),
        17: ("L2", 1227.60e6),
        14: ("L5", 1176.45e6),
        16: ("L1", 1575.42e6),
    },
    "GLO": {
        0: ("L1", 1602.0e6),        # 频点号相关，见 glonass_freq
        1: ("L2", 1246.4375e6),
        5: ("L2", 1246.4375e6),
        6: ("L3", 1202.025e6),
    },
    "SBAS": {0: ("L1", 1575.42e6), 6: ("L5", 1176.45e6)},
    "GAL": {
        2: ("E1", 1575.42e6),
        12: ("E5a", 1176.45e6),
        17: ("E5b", 1207.14e6),
        20: ("E5", 1191.795e6),
        7: ("E6", 1278.75e6),
        6: ("E6", 1278.75e6),
    },
    "BDS": {
        0: ("B1I", 1561.098e6),
        4: ("B1I", 1561.098e6),
        1: ("B2I", 1207.14e6),
        5: ("B2I", 1207.14e6),
        2: ("B3I", 1268.52e6),
        6: ("B3I", 1268.52e6),
        7: ("B1C", 1575.42e6),
        9: ("B2a", 1176.45e6),
        11: ("B2b", 1207.14e6),
    },
    "QZS": {
        0: ("L1", 1575.42e6),
        24: ("L1", 1575.42e6),
        17: ("L2", 1227.60e6),
        14: ("L5", 1176.45e6),
        16: ("L1", 1575.42e6),
        28: ("L6", 1278.75e6),
        27: ("L6", 1278.75e6),
    },
    "IRN": {0: ("L5", 1176.45e6)},
}


def glonass_freq(sv_freq: int, band: str = "L1") -> float:
    """GLONASS 频分：`sv_freq` 是「频点号 + 7」。G1 步长 0.5625 MHz、G2 0.4375 MHz。"""
    ch = sv_freq - 7
    if band == "L2":
        return 1246.4375e6 + ch * 0.4375e6
    return 1602.0e6 + ch * 0.5625e6


def signal_of(system: str, signal_type: int) -> tuple[str, float] | None:
    """查 (信号名, 频率)。查不到返回 None —— 下游据此跳过，而不是拿假频率算。"""
    return _SIGNAL_TABLE.get(system, {}).get(signal_type)


# ---------------------------------------------------------------- 文件级入口
@dataclass
class SbfFile:
    """一份 SBF 采集的解析入口。

    用法与 `reader.ObservationFile` 对齐：`observations()` 逐条吐
    `fieldstation.model.Observation`，`capability_report()` 给「读到了什么」。
    """

    path: str
    crc_mode: str = "validate"
    _deframer: SbfDeframer | None = None
    _frames: list[SbfFrame] | None = None
    _texts: list[TextRecord] | None = None
    _bestpos: BestPos | None = None
    _satvis: dict[int, SatVis] = field(default_factory=dict)

    # -- 读 ----------------------------------------------------------
    def _load(self) -> None:
        if self._frames is not None:
            return
        deframer = SbfDeframer(crc_mode=self.crc_mode)
        frames: list[SbfFrame] = []
        texts: list[TextRecord] = []
        with open(self.path, "rb") as fh:
            while True:
                chunk = fh.read(1 << 20)
                if not chunk:
                    break
                for rec in deframer.push(chunk):
                    if isinstance(rec, SbfFrame):
                        frames.append(rec)
                    else:
                        texts.append(rec)
        deframer.end()
        self._deframer = deframer
        self._frames = frames
        self._texts = texts
        for f in frames:
            mid = f.message_id
            if mid == 42:
                bp = decode_bestpos(f.payload)
                if bp is not None:
                    self._bestpos = bp
            elif mid == 1043:
                for sv in decode_satvis2(f.payload):
                    self._satvis[sv.prn_id] = sv

    # -- 公开 --------------------------------------------------------
    @property
    def stats(self) -> SbfStats:
        self._load()
        assert self._deframer is not None
        return self._deframer.stats

    @property
    def header_week(self) -> int:
        self._load()
        assert self._frames is not None
        for f in self._frames:
            if f.header.kind == "long" and f.header.week:
                return f.header.week
        return 0

    @property
    def station(self) -> str:
        """SBF 报文里**没有**站名（那是 RINEX 头段的概念）。

        取 BESTPOS 的第 4 个字符串字段不现实（实测为空）；这里如实返回 `SBF`，
        而不是编一个看起来像站名的东西 —— 上报里带着它，用户一眼能看出
        「这份文件没告诉我们站在哪」。
        """
        return "SBF"

    @property
    def interval_s(self) -> float:
        """从相邻 RANGE 帧的 GPS 周内秒反推采样间隔。

        推不出来（只有一帧、或秒差非正）返回 0.0 表示**未知**，
        不拿 RINEX 的 30 s 兜底常量冒充 —— 那是另一套文件的约定。
        """
        self._load()
        assert self._frames is not None
        tows = []
        for f in self._frames:
            if f.message_id != 43 or f.header.kind != "long":
                continue
            tows.append((f.header.week, f.header.milliseconds))
            if len(tows) >= 2:
                break
        if len(tows) < 2:
            return 0.0
        (w0, ms0), (w1, ms1) = tows
        if w1 != w0:
            return 0.0
        delta = (ms1 - ms0) / 1000.0
        return delta if delta > 0 else 0.0

    @property
    def bestpos(self) -> BestPos | None:
        self._load()
        return self._bestpos

    def range_frames(self) -> Iterator[SbfFrame]:
        self._load()
        assert self._frames is not None
        for f in self._frames:
            if f.message_id == 43:
                yield f

    def observations(self, want_systems=("GPS",)) -> Iterator["object"]:
        """逐条产出 `fieldstation.model.Observation`。

        只发**双频齐全**的观测对，与 `reader._from_rinex2` 的口径一致：
        单频样本无法定平，留下来只会让下游多一堆无效样本。
        """
        from .. import model as S

        want = {s.upper() for s in want_systems}
        want |= {"GPS"} if "G" in want else set()

        for frame in self.range_frames():
            hdr = frame.header
            week = hdr.week
            tow = hdr.gps_tow_s
            epoch_utc = S.epoch_utc_str(S.gps_to_utc(week, tow))

            # 一个 RANGE 帧 = 一个历元：内部先把同颗星的多路信号聚起来
            per_sv: dict[tuple[str, int], dict[str, tuple[float, RangeObservation]]] = {}
            for ob in decode_range(frame.payload):
                system = SYSTEM_BY_CODE.get(ob.system_code)
                if system is None or system not in want:
                    continue
                got = signal_of(system, ob.signal_type)
                if got is None:
                    continue
                sig, freq = got
                if system == "GLO":
                    freq = glonass_freq(ob.sv_freq, "L2" if sig == "L2" else "L1")
                prn = ob.sv_prn
                if system == "QZS" and 193 <= prn <= 202:
                    prn -= 192
                per_sv.setdefault((system, prn), {})[sig] = (freq, ob)

            for (system, prn), sigmap in per_sv.items():
                pair = _phase_pair(sorted(sigmap))
                if pair is None:
                    continue
                sv = self._satvis.get(prn)
                base = dict(
                    station=self.station, receiver_id="", gps_week=week,
                    gps_tow_s=tow, system=system, sv=prn,
                    elev_deg=(sv.elevation_deg if sv else MISSING),
                    azim_deg=(sv.azimuth_deg if sv else MISSING),
                    epoch_utc=epoch_utc,
                )
                for sig in pair:
                    freq, ob = sigmap[sig]
                    yield S.Observation(
                        signal=sig, freq_hz=freq, psr_m=ob.psr,
                        adr_cycles=ob.adr, doppler_hz=ob.dop,
                        cn0_dbhz=ob.cn0, sys_code=ob.system_code,
                        sig_code=ob.signal_type, **base)

    def capability_report(self) -> dict:
        """「这是什么 / 读到什么 / 丢了什么」一次说清。"""
        st = self.stats
        rep = {
            "file": self.path.replace("\\", "/").rsplit("/", 1)[-1],
            "format": "SBF",
            "supported": True,
            "frames": st.frames,
            "text_records": st.text_records,
            "total_records": st.total_records,
            "by_message_id": dict(sorted(st.by_message_id.items())),
            "by_name": dict(sorted(st.by_name.items())),
            "dropped": dict(sorted(st.dropped.items())),
            "total_bytes_dropped": st.total_bytes_dropped,
            "crc_mismatch": st.crc_mismatch,
            "zero_crc": st.zero_crc,
            "truncated_tail": st.truncated_tail,
            "resyncs": st.resyncs,
            "gps_week": self.header_week,
        }
        bp = self.bestpos
        if bp is not None:
            rep["bestpos"] = {
                "latitude_deg": bp.latitude_deg,
                "longitude_deg": bp.longitude_deg,
                "height_m": bp.height_m,
                "num_svs": bp.num_svs,
            }
        return rep


def _phase_pair(signals: list[str]) -> tuple[str, str] | None:
    """从现成信号里挑一对高低频。口径同 `reader._from_rinex2` 的候选表。"""
    have = set(signals)
    for hi, lo in (("L1", "L2"), ("L1", "L5"), ("B1I", "B2I"), ("L5", "L7"),
                   ("B1I", "B3I"), ("E1", "E5b"), ("E1", "E5a")):
        if hi in have and lo in have:
            return hi, lo
    return None


def sniff_sbf(path: str) -> dict:
    """只看前若干字节判断是不是 SBF。**不整文件载入。**"""
    import os

    with open(path, "rb") as fh:
        head = fh.read(65536)
    info: dict = {
        "path": path,
        "basename": os.path.basename(path),
        "size_bytes": os.path.getsize(path),
    }
    at = head.find(_AA)
    if at < 0 or at + 2 >= len(head):
        info.update(format="UNKNOWN", supported=False,
                    reason="前 64 KB 里没有 0xAA 同步字，不是 SBF")
        return info
    if head[at + 1] != SYNC_2 or head[at + 2] not in (SYNC_BINARY_FULL, SYNC_BINARY_SHORT):
        info.update(format="UNKNOWN", supported=False,
                    reason="有 0xAA 但后面不是 0x44 0x12/0x13，不是 SBF")
        return info
    hdr = parse_header(head, at)
    if not isinstance(hdr, SbfHeader):
        info.update(format="UNKNOWN", supported=False, reason="同步字对但头部不完整")
        return info
    info.update(
        format="SBF",
        supported=True,
        version="%s-header" % hdr.kind,
        first_record_offset=at,
        first_message_id=hdr.message_id,
        first_message_name=message_name(hdr.message_id),
        gps_week=hdr.week,
        note="NovAtel 二进制日志（SBF）",
    )
    return info


__all__ = [
    "SYNC_1", "SYNC_2", "SYNC_BINARY_FULL", "SYNC_BINARY_SHORT",
    "LONG_HEADER_LENGTH", "SHORT_HEADER_LENGTH", "CRC32_POLYNOMIAL",
    "SbfHeader", "SbfFrame", "TextRecord", "SbfStats",
    "SbfDeframer", "SbfFile", "RangeObservation", "BestPos", "SatVis",
    "novatel_crc32", "crc_hex", "parse_header", "sniff_sbf", "message_name",
    "decode_range", "decode_bestpos", "decode_satvis2",
    "SYSTEM_BY_CODE", "signal_of", "glonass_freq", "MESSAGE_NAMES",
]
