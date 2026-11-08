#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设备通道层：串口 / USB / 网络三种「读字节」的实现。

## 这一层只做一件事：把字节读出来

**协议解析不许混进这里。** 通道层不知道 SBF、不知道 RINEX、不知道
`0xAA 0x44`。它只回答「现在有哪些字节可用」和「连接还活着吗」。

这样分的理由不是强迫症：

- SBF 与 RINEX 需要**跨读**组装（半帧要缓冲到下次，见 `sbf.SbfDeframer`），
  如果通道层也做缓冲，两层缓冲会互相打架；
- 同一个通道要能同时喂 SBF 和 ASCII 日志，两者切分规则不同
  （二进制看 CRC 长度，文本看换行）；
- 换设备只换通道，不动解析；加协议只加解析，不动通道。

## 三种实现

| 类 | 适用 | 依赖 |
|---|---|---|
| `SerialChannel` | COM 口 / USB 转串口 | `pyserial`（**可选**，缺了就明确报错，不静默降级） |
| `TcpChannel` / `UdpChannel` | 网络端口（套件里加设备时的「网络」类型） | 标准库 `socket` |
| `LoopbackChannel` | 测试与回放 | 标准库 |

`pyserial` 是**可选依赖**：仓库的依赖政策是「测试与门禁只用标准库」
（`docs/operations/environment.md`）。所以 `SerialChannel` 在导入时就检查，
缺包时抛 `ChannelUnavailable` 并给出安装命令 —— 而不是在读到一半时崩，
也不是假装能用。

## 断线与重连

设备会掉。三种通道的统一约定：

- `read()` 返回空 `bytes` 表示**这一轮没有数据**（超时），不是断线；
- 断线抛 `ChannelClosed`；
- `reconnect()` 重连，`max_retries` 次失败后抛 `ChannelClosed`。

`with channel.open() as ch:` 的上下文管理会在退出时关闭底层句柄。
"""
from __future__ import annotations

import socket
import time
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

# ---------------------------------------------------------------- 异常
class ChannelError(RuntimeError):
    """通道层错误的基类。"""


class ChannelUnavailable(ChannelError):
    """这个通道在这台机器上用不了（缺依赖、缺设备、端口被占）。"""


class ChannelClosed(ChannelError):
    """连接已断开，且（重连次数用尽后）不再可用。"""


class ChannelTimeout(ChannelError):
    """等待超时。**注意**：单次 `read()` 返回空字节**不算**超时错误，见模块注释。"""


# ---------------------------------------------------------------- 协议
@runtime_checkable
class Channel(Protocol):
    """通道只要两个能力：读字节、报告是否还连着。

    **故意不提供 `write()`**：本项目对设备只读（采集），命令下发不在这一层。
    需要下发时另开一条接口，不要把写混进来 —— 一混就会有人在这里拼 SBF 命令。
    """

    name: str

    def read(self, n: int = 4096) -> bytes:
        """最多读 `n` 字节。没数据返回 `b""`；断线抛 `ChannelClosed`。"""
        ...

    def close(self) -> None:
        ...

    @property
    def closed(self) -> bool:
        ...


@dataclass
class ChannelStats:
    """通道的读写计数。用来回答「到底读进来多少字节」。"""

    bytes_read: int = 0
    reads: int = 0
    empty_reads: int = 0
    reconnects: int = 0
    errors: int = 0
    by_error: dict[str, int] = field(default_factory=dict)

    def record_error(self, exc: BaseException) -> None:
        self.errors += 1
        key = type(exc).__name__
        self.by_error[key] = self.by_error.get(key, 0) + 1

    def as_dict(self) -> dict:
        return {
            "bytes_read": self.bytes_read,
            "reads": self.reads,
            "empty_reads": self.empty_reads,
            "reconnects": self.reconnects,
            "errors": self.errors,
            "by_error": dict(sorted(self.by_error.items())),
        }


# ---------------------------------------------------------------- 串口
class SerialChannel:
    """串口 / USB 转串口。

    `pyserial` 是可选依赖。**缺包时不静默降级成「读不到数据」** ——
    「设备没插」和「库没装」必须能区分开，否则运维会去查线。
    """

    #: 装 pyserial 的命令。报错时原样给出，省得用户去搜。
    INSTALL_HINT = "pip install pyserial"

    def __init__(self, port: str, baudrate: int = 115200, *,
                 timeout_s: float = 0.5,
                 bytesize: int = 8, parity: str = "N", stopbits: int = 1,
                 max_retries: int = 3, retry_delay_s: float = 0.5):
        self.port = port
        self.baudrate = baudrate
        self.timeout_s = timeout_s
        self.bytesize = bytesize
        self.parity = parity
        self.stopbits = stopbits
        self.max_retries = max_retries
        self.retry_delay_s = retry_delay_s
        self._serial = None
        self._closed = False
        self.stats = ChannelStats()
        self._check_dependency()

    def _check_dependency(self) -> None:
        try:
            import serial  # noqa: F401
        except ImportError as exc:
            raise ChannelUnavailable(
                "串口通道需要 pyserial，但本机没装（%s）。"
                "安装：%s。"
                "没有 pyserial 时网络通道（TcpChannel）仍然可用。"
                % (exc, self.INSTALL_HINT)) from exc

    @property
    def name(self) -> str:
        return "serial:%s@%d" % (self.port, self.baudrate)

    @property
    def closed(self) -> bool:
        return self._closed or self._serial is None

    def open(self) -> "SerialChannel":
        import serial

        parity = {"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN,
                  "O": serial.PARITY_ODD}.get(self.parity.upper())
        if parity is None:
            raise ChannelUnavailable("不支持的校验位 %r（只有 N/E/O）" % self.parity)
        stops = {1: serial.STOPBITS_ONE,
                 2: serial.STOPBITS_TWO}.get(self.stopbits)
        if stops is None:
            raise ChannelUnavailable("不支持的停止位 %r（只有 1/2）" % self.stopbits)
        try:
            self._serial = serial.Serial(
                port=self.port, baudrate=self.baudrate,
                timeout=self.timeout_s, bytesize=self.bytesize,
                parity=parity, stopbits=stops)
        except Exception as exc:                     # pyserial 的异常类型较杂
            raise ChannelUnavailable(
                "打不开串口 %s：%s。"
                "常见原因：口被别的程序占着、名字写错、驱动没装。"
                % (self.port, exc)) from exc
        self._closed = False
        return self

    def read(self, n: int = 4096) -> bytes:
        if self._serial is None or self._closed:
            raise ChannelClosed("%s 未打开或已关闭" % self.name)
        return self._read_once(n)

    def _read_once(self, n: int) -> bytes:
        try:
            data = self._serial.read(n)
        except Exception as exc:
            self.stats.record_error(exc)
            raise ChannelClosed("%s 读失败：%s" % (self.name, exc)) from exc
        if not data:
            self.stats.empty_reads += 1
            return b""
        self.stats.reads += 1
        self.stats.bytes_read += len(data)
        return data

    def reconnect(self) -> "SerialChannel":
        """关掉旧的、重开。`max_retries` 次都失败就抛 `ChannelClosed`。"""
        last = None
        for attempt in range(max(1, self.max_retries)):
            for closer in ("close",):
                try:
                    getattr(self, closer)()
                except Exception:
                    pass
            try:
                self.open()
                self.stats.reconnects += 1
                return self
            except ChannelUnavailable as exc:
                last = exc
                self.stats.record_error(exc)
                if attempt + 1 < self.max_retries:
                    time.sleep(self.retry_delay_s)
        raise ChannelClosed(
            "%s 重连 %d 次都失败：%s" % (self.name, self.max_retries, last))

    def close(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:
                pass
            self._serial = None
        self._closed = True

    def __enter__(self) -> "SerialChannel":
        return self.open()

    def __exit__(self, *exc_info) -> None:
        self.close()


def list_serial_ports() -> list[dict]:
    """枚举串口。`pyserial` 缺失时返回空列表并**说明原因**，不抛异常。

    返回空不等于「没有设备」——调用方要看返回值里的 `available` 判断。
    """
    try:
        from serial.tools import list_ports
    except ImportError as exc:
        return [{"available": False, "reason": str(exc),
                 "install": SerialChannel.INSTALL_HINT}]
    out = []
    for p in list_ports.comports():
        out.append({
            "available": True,
            "device": p.device,
            "description": p.description,
            "hwid": p.hwid,
            "vid": p.vid,
            "pid": p.pid,
            "serial_number": p.serial_number,
        })
    return out


def match_port(*, vid: int | None = None, pid: int | None = None,
               description_contains: str | None = None,
               serial_number: str | None = None) -> str | None:
    """按 USB VID/PID 或描述片段找端口。找不到返回 None（**不猜一个**）。

    为什么需要这个：Windows 上同一个 USB 转串口换一个物理口就变成 COM7/COM9，
    按名字写死的脚本每次插拔都要改。VID/PID 是设备自报的，稳定。
    """
    want_desc = (description_contains or "").lower()
    for p in list_serial_ports():
        if not p.get("available"):
            continue
        if vid is not None and p.get("vid") != vid:
            continue
        if pid is not None and p.get("pid") != pid:
            continue
        if serial_number is not None and p.get("serial_number") != serial_number:
            continue
        if want_desc and want_desc not in (p.get("description") or "").lower():
            continue
        return p["device"]
    return None


# ---------------------------------------------------------------- 网络
class TcpChannel:
    """TCP 客户端通道。设备侧做 server（套件加设备时的「网络」类型就是这种）。"""

    def __init__(self, host: str, port: int, *, timeout_s: float = 0.5,
                 recv_buffer: int = 65536,
                 max_retries: int = 3, retry_delay_s: float = 0.5):
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self.recv_buffer = recv_buffer
        self.max_retries = max_retries
        self.retry_delay_s = retry_delay_s
        self._sock: socket.socket | None = None
        self._closed = False
        self.stats = ChannelStats()

    @property
    def name(self) -> str:
        return "tcp:%s:%d" % (self.host, self.port)

    @property
    def closed(self) -> bool:
        return self._closed or self._sock is None

    def open(self) -> "TcpChannel":
        try:
            sock = socket.create_connection((self.host, self.port),
                                            timeout=self.timeout_s)
            sock.settimeout(self.timeout_s)
        except OSError as exc:
            raise ChannelUnavailable(
                "连不上 %s:%d：%s" % (self.host, self.port, exc)) from exc
        self._sock = sock
        self._closed = False
        return self

    def read(self, n: int = 4096) -> bytes:
        if self._sock is None or self._closed:
            raise ChannelClosed("%s 未打开或已关闭" % self.name)
        return self._read_once(n)

    def _read_once(self, n: int) -> bytes:
        try:
            data = self._sock.recv(min(n, self.recv_buffer))
        except socket.timeout:
            self.stats.empty_reads += 1
            return b""                              # 超时＝这一轮没数据，不是断线
        except OSError as exc:
            self.stats.record_error(exc)
            raise ChannelClosed("%s 读失败：%s" % (self.name, exc)) from exc
        if not data:
            # recv 返回 b"" 在 TCP 里意味着对端**正常**关了连接
            self.stats.record_error(ConnectionResetError("对端关闭"))
            raise ChannelClosed("%s 对端关闭了连接" % self.name)
        self.stats.reads += 1
        self.stats.bytes_read += len(data)
        return data

    def reconnect(self) -> "TcpChannel":
        last = None
        for attempt in range(max(1, self.max_retries)):
            self.close()
            try:
                self.open()
                self.stats.reconnects += 1
                return self
            except ChannelUnavailable as exc:
                last = exc
                self.stats.record_error(exc)
                if attempt + 1 < self.max_retries:
                    time.sleep(self.retry_delay_s)
        raise ChannelClosed(
            "%s 重连 %d 次都失败：%s" % (self.name, self.max_retries, last))

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        self._closed = True

    def __enter__(self) -> "TcpChannel":
        return self.open()

    def __exit__(self, *exc_info) -> None:
        self.close()


class UdpChannel:
    """UDP 通道。设备侧广播/单播数据报，这里收。

    UDP **没有连接概念**，所以 `read()` 超时返回 `b""` 是常态，
    `closed` 只在显式 `close()` 后为真。
    """

    def __init__(self, host: str, port: int, *, timeout_s: float = 0.5,
                 bind: tuple[str, int] | None = None,
                 recv_buffer: int = 65536):
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self.bind = bind
        self.recv_buffer = recv_buffer
        self._sock: socket.socket | None = None
        self._closed = False
        self.stats = ChannelStats()

    @property
    def name(self) -> str:
        return "udp:%s:%d" % (self.host, self.port)

    @property
    def closed(self) -> bool:
        return self._closed or self._sock is None

    def open(self) -> "UdpChannel":
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(self.timeout_s)
            if self.bind:
                sock.bind(self.bind)
            else:
                sock.connect((self.host, self.port))
        except OSError as exc:
            raise ChannelUnavailable(
                "UDP 打不开 %s:%d：%s" % (self.host, self.port, exc)) from exc
        self._sock = sock
        self._closed = False
        return self

    def read(self, n: int = 4096) -> bytes:
        if self._sock is None or self._closed:
            raise ChannelClosed("%s 未打开或已关闭" % self.name)
        try:
            data = self._sock.recv(min(n, self.recv_buffer))
        except socket.timeout:
            self.stats.empty_reads += 1
            return b""
        except OSError as exc:
            self.stats.record_error(exc)
            raise ChannelClosed("%s 读失败：%s" % (self.name, exc)) from exc
        if not data:
            self.stats.empty_reads += 1
            return b""
        self.stats.reads += 1
        self.stats.bytes_read += len(data)
        return data

    def reconnect(self) -> "UdpChannel":
        # UDP 无连接：重开一次 socket 即可，没有「连不上」这回事
        self.close()
        self.open()
        self.stats.reconnects += 1
        return self

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        self._closed = True

    def __enter__(self) -> "UdpChannel":
        return self.open()

    def __exit__(self, *exc_info) -> None:
        self.close()


# ---------------------------------------------------------------- 回环
class LoopbackChannel:
    """内存回环通道：测试与回放用。

    行为刻意做成与真通道一致：读空返回 `b""`、`close()` 后再读抛
    `ChannelClosed`。`feed()` 追加字节，`drop()` 模拟断线。
    """

    def __init__(self, *, name: str = "loopback"):
        self._name = name
        self._buf = bytearray()
        self._closed = False
        self._broken = False
        self.stats = ChannelStats()

    @property
    def name(self) -> str:
        return "loopback:%s" % self._name

    @property
    def closed(self) -> bool:
        return self._closed

    def open(self) -> "LoopbackChannel":
        self._closed = False
        self._broken = False
        return self

    def feed(self, data: bytes) -> None:
        self._buf += data

    def drop(self) -> None:
        """模拟设备掉线：之后的 `read()` 抛 `ChannelClosed`。"""
        self._broken = True

    def read(self, n: int = 4096) -> bytes:
        if self._closed:
            raise ChannelClosed("%s 已关闭" % self.name)
        if self._broken:
            self.stats.record_error(ConnectionResetError("模拟断线"))
            raise ChannelClosed("%s 模拟断线" % self.name)
        if not self._buf:
            self.stats.empty_reads += 1
            return b""
        take = bytes(self._buf[:n])
        del self._buf[:n]
        self.stats.reads += 1
        self.stats.bytes_read += len(take)
        return take

    def reconnect(self) -> "LoopbackChannel":
        self._broken = False
        self._closed = False
        self.stats.reconnects += 1
        return self

    def close(self) -> None:
        self._closed = True

    def __enter__(self) -> "LoopbackChannel":
        return self.open()

    def __exit__(self, *exc_info) -> None:
        self.close()


# ---------------------------------------------------------------- 工厂
#: `open_channel()` 认的 scheme。写在这里而不是散在 if 里：
#: 「支持哪些通道」要能一眼查到。
CHANNEL_SCHEMES = {
    "serial": SerialChannel,
    "tcp": TcpChannel,
    "udp": UdpChannel,
    "loopback": LoopbackChannel,
}


def open_channel(spec: str, **kwargs) -> Channel:
    """按 `scheme:...` 开一条通道。

    写法：

    - `serial:COM3@115200` 或 `serial:COM3`（默认 115200）
    - `tcp:192.168.1.10:5000`
    - `udp:192.168.1.10:5000`
    - `loopback`

    **不认识的 scheme 直接报错并列出支持的**，不回落到任何默认值 ——
    猜一个通道比报错危险得多。
    """
    scheme, _, rest = spec.partition(":")
    scheme = scheme.strip().lower()
    if scheme not in CHANNEL_SCHEMES:
        raise ChannelUnavailable(
            "不认识的通道类型 %r。支持：%s。写法见模块注释（例：`tcp:10.0.0.5:5000`、"
            "`serial:COM3@115200`、`loopback`）"
            % (scheme, " / ".join(sorted(CHANNEL_SCHEMES))))

    if scheme == "loopback":
        ch = LoopbackChannel(**kwargs)
        return ch.open()

    if scheme == "serial":
        port, _, baud = rest.partition("@")
        if not port:
            raise ChannelUnavailable("serial 通道缺端口名，例：serial:COM3@115200")
        ch = SerialChannel(port, int(baud) if baud else 115200, **kwargs)
        return ch.open()

    # tcp / udp
    host, _, port_s = rest.rpartition(":")
    if not host or not port_s.isdigit():
        raise ChannelUnavailable(
            "%s 通道要写 host:port，你给的是 %r" % (scheme, rest))
    cls = CHANNEL_SCHEMES[scheme]
    ch = cls(host, int(port_s), **kwargs)
    return ch.open()


# ---------------------------------------------------------------- 收字节
def read_until_timeout(channel: Channel, *, idle_polls: int = 3,
                       max_bytes: int | None = None,
                       chunk: int = 4096,
                       max_polls: int | None = None) -> bytes:
    """一直读到「连续 `idle_polls` 次空读」为止。

    这是**通道层的辅助函数，仍然只搬字节**：它不知道帧边界，也不该知道。
    给「把一段采集存成文件」这类场景用；要解析就交给 `sbf` / `reader`。

    空闲判据用**轮询次数**而不是墙钟秒数：`Channel.read()` 的超时由通道自己
    的 `timeout_s` 决定，通道层不该再维护一个第二计时器（两个计时器必然打架）。
    想看「大约等多久」，用 `idle_polls × channel.timeout_s` 换算。
    """
    collected = bytearray()
    streak = 0
    polls = 0
    while True:
        data = channel.read(chunk)
        polls += 1
        if data:
            streak = 0
            collected += data
            if max_bytes is not None and len(collected) >= max_bytes:
                return bytes(collected[:max_bytes])
        else:
            streak += 1
            if streak >= idle_polls:
                break
        if max_polls is not None and polls >= max_polls:
            break
    return bytes(collected)


__all__ = [
    "Channel", "ChannelError", "ChannelUnavailable", "ChannelClosed",
    "ChannelTimeout", "ChannelStats",
    "SerialChannel", "TcpChannel", "UdpChannel", "LoopbackChannel",
    "list_serial_ports", "match_port", "open_channel", "read_until_timeout",
    "CHANNEL_SCHEMES",
]
