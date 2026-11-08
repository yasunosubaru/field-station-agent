#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`fieldstation.ingest.channels` 的行为测试。

## 这一层要证明的三件事

1. **只读字节**：通道层不认识 SBF / RINEX / 帧边界。断言用「喂什么读到什么」，
   不出现任何协议常量。
2. **断线看得见**：`read()` 返回 `b""` 是「这一轮没数据」，`ChannelClosed` 才是
   「断了」。这两者混掉，运维就会拿着完好的线去查设备。
3. **能重连**：`reconnect()` 之后能继续读。

## 无真机怎么测

`LoopbackChannel` 模拟字节与断线；`TcpChannel`/`UdpChannel` 用**本机回环
socket 起一个真 server**（不是 mock）—— 端口冲突与半包行为只有真 socket 才暴露。
`SerialChannel` 只测「缺 pyserial 时的报错路径」，因为本机没装 pyserial，
而且没有硬件；有真机时按 `docs/operations/rpa-checklist.md` 跑。
"""
from __future__ import annotations

import socket
import threading
import time
import unittest

from fieldstation.ingest import channels


# ---------------------------------------------------------------- 回环
class TestLoopbackChannel(unittest.TestCase):
    def test_feeds_then_reads(self):
        with channels.LoopbackChannel() as ch:
            ch.feed(b"hello")
            self.assertEqual(ch.read(3), b"hel")
            self.assertEqual(ch.read(99), b"lo")
            self.assertEqual(ch.read(99), b"")

    def test_empty_read_is_not_closed(self):
        """空读 ≠ 断线。这条区分错了运维就会误判。"""
        with channels.LoopbackChannel() as ch:
            self.assertEqual(ch.read(), b"")
            self.assertFalse(ch.closed)

    def test_drop_raises_channel_closed(self):
        ch = channels.LoopbackChannel().open()
        ch.drop()
        with self.assertRaises(channels.ChannelClosed):
            ch.read()
        self.assertEqual(ch.stats.by_error.get("ConnectionResetError"), 1)

    def test_reconnect_restores_reading(self):
        ch = channels.LoopbackChannel().open()
        ch.feed(b"aa")
        self.assertEqual(ch.read(2), b"aa")
        ch.drop()
        with self.assertRaises(channels.ChannelClosed):
            ch.read()
        ch.reconnect()
        ch.feed(b"bb")
        self.assertEqual(ch.read(2), b"bb")
        self.assertEqual(ch.stats.reconnects, 1)

    def test_close_then_read_raises(self):
        ch = channels.LoopbackChannel().open()
        ch.close()
        self.assertTrue(ch.closed)
        with self.assertRaises(channels.ChannelClosed):
            ch.read()

    def test_stats_count_bytes(self):
        with channels.LoopbackChannel() as ch:
            ch.feed(b"x" * 100)
            ch.read(40)
            ch.read(60)
        self.assertEqual(ch.stats.bytes_read, 100)
        self.assertEqual(ch.stats.reads, 2)


# ---------------------------------------------------------------- TCP
class _OneShotServer:
    """本机回环 TCP server：连上来就发 `chunks`，然后按 `hold_s` 保持再关。"""

    def __init__(self, chunks: list[bytes], hold_s: float = 0.0,
                 close_after: bool = True):
        self._chunks = chunks
        self._hold_s = hold_s
        self._close_after = close_after
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(4)
        self.port = self._sock.getsockname()[1]
        self._stop = threading.Event()
        self._held: list[socket.socket] = []
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        try:
            self._sock.settimeout(0.2)
            while not self._stop.is_set():
                try:
                    conn, _ = self._sock.accept()
                except (socket.timeout, OSError):
                    continue
                if self._stop.is_set():
                    try:
                        conn.close()
                    except OSError:
                        pass
                    return
                try:
                    for c in self._chunks:
                        conn.sendall(c)
                        time.sleep(0.01)
                    if self._hold_s:
                        time.sleep(self._hold_s)
                finally:
                    if self._close_after:
                        try:
                            conn.close()
                        except OSError:
                            pass
                    else:
                        # `close_after=False` 要保持连接（测「连着但不发数据」），
                        # 交给 shutdown() 统一收尾。
                        self._held.append(conn)
        finally:
            try:
                self._sock.close()
            except OSError:
                pass

    def shutdown(self):
        self._stop.set()
        # 先 join 再关：线程还在 `accept()` 里时不关，避免它拿到一个已关闭的
        # socket 再抛一次，也避免监听套接字在 join 之后才被 GC（ResourceWarning）。
        self._thread.join(timeout=3)
        for conn in list(self._held):
            try:
                conn.close()
            except OSError:
                pass
        self._held.clear()
        try:
            self._sock.close()
        except OSError:
            pass


class TestTcpChannel(unittest.TestCase):
    def test_reads_from_real_server(self):
        srv = _OneShotServer([b"\xaa\x44\x12", b"payload"], hold_s=0.3)
        ch = None
        try:
            ch = channels.TcpChannel("127.0.0.1", srv.port, timeout_s=0.5).open()
            got = bytearray()
            deadline = time.time() + 3
            while time.time() < deadline and len(got) < 10:
                got += ch.read(64)
            self.assertEqual(bytes(got), b"\xaa\x44\x12payload")
            self.assertGreater(ch.stats.bytes_read, 0)
        finally:
            if ch is not None:
                ch.close()
            srv.shutdown()

    def test_timeout_returns_empty_not_closed(self):
        """对端连着但不发数据 -> 空读；不是断线。"""
        srv = _OneShotServer([], hold_s=0.6, close_after=False)
        ch = None
        try:
            ch = channels.TcpChannel("127.0.0.1", srv.port, timeout_s=0.15).open()
            self.assertEqual(ch.read(16), b"")
            self.assertFalse(ch.closed)
        finally:
            if ch is not None:
                ch.close()
            srv.shutdown()

    def test_peer_close_raises_channel_closed(self):
        srv = _OneShotServer([b"bye"], hold_s=0.0, close_after=True)
        ch = None
        try:
            ch = channels.TcpChannel("127.0.0.1", srv.port, timeout_s=0.5).open()
            got = bytearray()
            with self.assertRaises(channels.ChannelClosed):
                deadline = time.time() + 3
                while time.time() < deadline:
                    got += ch.read(64)
                    time.sleep(0.02)
            self.assertEqual(bytes(got), b"bye")
        finally:
            if ch is not None:
                ch.close()
            srv.shutdown()

    def test_connect_failure_is_unavailable(self):
        """端口没开 -> `ChannelUnavailable`（**不是** `ChannelClosed`）。

        两者混掉，「服务没起」会被当成「设备掉线」，排查方向就错了。
        """
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()                                   # 立刻关掉，端口空出来
        with self.assertRaises(channels.ChannelUnavailable):
            channels.TcpChannel("127.0.0.1", port, timeout_s=0.2).open()

    def test_reconnect_after_peer_close(self):
        srv = _OneShotServer([b"one"], hold_s=0.0, close_after=True)
        ch = None
        try:
            ch = channels.TcpChannel("127.0.0.1", srv.port, timeout_s=0.5,
                                     max_retries=5, retry_delay_s=0.05).open()
            first = bytearray()
            deadline = time.time() + 3
            while time.time() < deadline and not first:
                first += ch.read(64)
            self.assertEqual(bytes(first), b"one")
            time.sleep(0.2)
            ch.reconnect()                          # server 还在 listen
            self.assertFalse(ch.closed)
            self.assertEqual(ch.stats.reconnects, 1)
        finally:
            if ch is not None:
                ch.close()
            srv.shutdown()


# ---------------------------------------------------------------- UDP
class TestUdpChannel(unittest.TestCase):
    def test_reads_datagram(self):
        """UDP 绑在随机端口上，往**那个端口**发数据报，必须收到。

        这里故意不用 `tx.sendto(..., port)` 里的 `port`（那是构造参数、
        与 bind 无关）—— 要读 `ch` 实际绑到的端口，否则测试自己就写错了。
        """
        with channels.UdpChannel("127.0.0.1", 0, timeout_s=0.5,
                                 bind=("127.0.0.1", 0)) as ch:
            real_port = ch._sock.getsockname()[1]
            tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                tx.sendto(b"udp-payload", ("127.0.0.1", real_port))
                got = b""
                deadline = time.time() + 3
                while time.time() < deadline and not got:
                    got = ch.read(64)
                self.assertEqual(got, b"udp-payload")
            finally:
                tx.close()

    def test_timeout_is_empty_not_error(self):
        with channels.UdpChannel("127.0.0.1", 9, timeout_s=0.1,
                                 bind=("127.0.0.1", 0)) as ch:
            self.assertEqual(ch.read(16), b"")
            self.assertEqual(ch.stats.errors, 0)


# ---------------------------------------------------------------- 串口
class TestSerialChannel(unittest.TestCase):
    def test_missing_pyserial_is_explicit(self):
        """缺 pyserial 必须**明确报错并给安装命令**，不能静默变成「读不到数据」。

        「设备没插」和「库没装」分不开，运维就会去查线。
        """
        try:
            import serial  # noqa: F401
        except ImportError:
            with self.assertRaises(channels.ChannelUnavailable) as ctx:
                channels.SerialChannel("COM_不存在", 115200)
            msg = str(ctx.exception)
            self.assertIn("pyserial", msg)
            self.assertIn("pip install pyserial", msg)
        else:
            # 装了 pyserial 的机器：构造没问题，打开不存在的口要报 Unavailable
            ch = channels.SerialChannel("COM_不存在", 115200)
            with self.assertRaises(channels.ChannelUnavailable):
                ch.open()

    def test_list_ports_reports_availability(self):
        ports = channels.list_serial_ports()
        self.assertIsInstance(ports, list)
        if ports and not ports[0].get("available"):
            self.assertIn("install", ports[0])

    def test_match_port_returns_none_when_nothing_matches(self):
        self.assertIsNone(channels.match_port(description_contains="绝对不存在的描述"))


# ---------------------------------------------------------------- 工厂
class TestOpenChannel(unittest.TestCase):
    def test_unknown_scheme_lists_supported(self):
        with self.assertRaises(channels.ChannelUnavailable) as ctx:
            channels.open_channel("carrier-pigeon:abc")
        msg = str(ctx.exception)
        for name in ("serial", "tcp", "udp", "loopback"):
            self.assertIn(name, msg)

    def test_missing_scheme_is_rejected(self):
        """没有 scheme 的裸字符串既不是合法通道，也不该被猜成某个默认通道。"""
        with self.assertRaises(channels.ChannelUnavailable) as ctx:
            channels.open_channel("COM3")
        self.assertIn("COM3", str(ctx.exception))

    def test_loopback_spec(self):
        ch = channels.open_channel("loopback")
        try:
            ch.feed(b"abc")
            self.assertEqual(ch.read(3), b"abc")
        finally:
            ch.close()

    def test_tcp_spec_parses_host_port(self):
        srv = _OneShotServer([b"hi"], hold_s=0.2)
        ch = None
        try:
            ch = channels.open_channel("tcp:127.0.0.1:%d" % srv.port, timeout_s=0.5)
            got = b""
            deadline = time.time() + 3
            while time.time() < deadline and not got:
                got = ch.read(16)
            self.assertEqual(got, b"hi")
        finally:
            if ch is not None:
                ch.close()
            srv.shutdown()

    def test_bad_tcp_spec_is_rejected(self):
        with self.assertRaises(channels.ChannelUnavailable):
            channels.open_channel("tcp:nonsense")


# ---------------------------------------------------------------- 只搬字节
class TestChannelLayerKnowsNoProtocol(unittest.TestCase):
    """**这一层的核心约束**：不认识任何协议。

    做法：把 SBF 同步字当普通字节喂进去，断言通道原样吐出，
    且通道模块里**不出现**这些协议常量。
    """

    def test_bytes_pass_through_untouched(self):
        blob = b"\xaa\x44\x12" + b"\x00" * 30 + b"\r\n#RANGEA,x,y\r\n"
        with channels.LoopbackChannel() as ch:
            ch.feed(blob)
            got = bytearray()
            while len(got) < len(blob):
                chunk = ch.read(7)
                if not chunk:
                    break
                got += chunk
        self.assertEqual(bytes(got), blob, "通道不许改动任何一个字节")

    def test_module_has_no_protocol_parsing(self):
        """通道源码里不该出现 SBF/RINEX 的**解析代码**。

        这条不是洁癖：一旦有人在通道层加缓冲或切帧，`sbf.SbfDeframer`
        的跨读缓冲就会和它打架，半帧问题会以「随机丢包」的形式出现。

        检查的是 **AST 里的真实标识符与 import**，不扫注释与文档字符串 ——
        模块 docstring 正需要提到 `sbf.SbfDeframer` 来解释「为什么不放在这里」，
        把文档也算违规会让这条测试逼人删掉最有价值的那段说明。
        """
        import ast

        with open(channels.__file__, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=channels.__file__)

        used: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                used.add(node.id)
            elif isinstance(node, ast.Attribute):
                used.add(node.attr)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                mod = getattr(node, "module", None)
                if mod:
                    used.add(mod)
                for alias in node.names:
                    used.add(alias.name)
                    if alias.asname:
                        used.add(alias.asname)

        for banned in ("novatel_crc32", "decode_range", "decode_bestpos",
                       "SbfDeframer", "SbfFile", "SbfHeader",
                       "parse_header", "sniff_sbf", "rinex2", "rinex3", "sbf"):
            self.assertNotIn(banned, used,
                             "通道层的**代码**里出现了协议解析符号：%s" % banned)

    def test_protocol_read_only(self):
        """`Channel` 协议只要求 read/close/closed —— 故意不提供 write。

        本项目对设备只读；写混进来就会有人在通道层拼 SBF 命令。
        """
        members = {n for n in dir(channels.Channel) if not n.startswith("_")}
        members |= set(getattr(channels.Channel, "__annotations__", {}))
        self.assertEqual(members, {"name", "read", "close", "closed"})
        self.assertNotIn("write", members)


# ---------------------------------------------------------------- 收字节
class TestReadUntilTimeout(unittest.TestCase):
    def test_stops_after_idle_polls(self):
        with channels.LoopbackChannel() as ch:
            ch.feed(b"abcdef")
            data = channels.read_until_timeout(ch, idle_polls=2, chunk=4)
        self.assertEqual(data, b"abcdef")

    def test_respects_max_bytes(self):
        with channels.LoopbackChannel() as ch:
            ch.feed(b"x" * 1000)
            data = channels.read_until_timeout(ch, max_bytes=50, chunk=16)
        self.assertEqual(len(data), 50)

    def test_respects_max_polls(self):
        """通道一直有数据时也要能停 —— 直播流没有 EOF。"""
        with channels.LoopbackChannel() as ch:
            ch.feed(b"x" * 10000)
            data = channels.read_until_timeout(ch, chunk=10, max_polls=5)
        self.assertEqual(len(data), 50)


if __name__ == "__main__":
    unittest.main()
