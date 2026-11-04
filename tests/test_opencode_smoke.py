#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``tools/opencode_smoke.py`` 的用例：版本解析与端口轮询的纯函数，不依赖 exe。

分三层：

* **纯函数**：``parse_version`` 能从真实输出格式里取出版本，又不把 ``127.0.0.1``
  这种地址当成版本；``wait_for_http`` 的成功 / 多 URL 回退 / 超时 / 进程早退四条
  分支都用注入的假时钟跑完，所以测试里没有 30 秒的 ``sleep``。
* **进程与套接字**：``stop_process`` 拿一个真的短命子进程验证「先 terminate 再
  kill」确实收干净；``is_port_open`` 用自己绑的临时端口验证，不碰 4096。
* **exe 集成**：本机没装运行时（``.deps/opencode/bin/opencode.exe`` 不存在）就
  skip —— 缺件是环境问题，不该让整条用例红掉。

跑的是一份真 exe 时才有的断言只有一条：``--version`` 解析出来要与
``OPENCODE_VERSION`` 一致。缺 exe 时其余用例照样能跑，因为它们测的是脚本自己的
逻辑，不是二进制。
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import opencode_smoke as smoke  # noqa: E402


class FakeClock:
    """假时钟：``sleep`` 推进时间，不真的等。"""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept = 0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept += 1
        self.now += seconds


class VersionParseTest(unittest.TestCase):
    def test_real_output_shape(self):
        self.assertEqual(smoke.parse_version("opencode v2.2.0\n"), "2.2.0")

    def test_plain_semver(self):
        self.assertEqual(smoke.parse_version("2.2.0"), "2.2.0")

    def test_crlf_and_surrounding_noise(self):
        self.assertEqual(smoke.parse_version("opencode v2.2.0\r\n"), "2.2.0")
        self.assertEqual(smoke.parse_version("  opencode   v2.2.0  \n\n"),
                         "2.2.0")

    def test_prerelease_suffix_kept(self):
        self.assertEqual(smoke.parse_version("opencode 2.2.0-beta.1"),
                         "2.2.0-beta.1")

    def test_first_version_wins(self):
        self.assertEqual(smoke.parse_version("opencode v2.2.0\nplugin 1.0.0"),
                         "2.2.0")

    def test_loopback_address_is_not_a_version(self):
        """serve 日志里满是 127.0.0.1:4096 —— 不能被当成版本号。"""
        log = ("server listening on http://127.0.0.1:4096\n"
               "server password s3cret\n")
        self.assertIsNone(smoke.parse_version(log))

    def test_ports_and_numbers_are_not_versions(self):
        self.assertIsNone(smoke.parse_version("port 4096"))
        self.assertIsNone(smoke.parse_version("2.2"))
        self.assertIsNone(smoke.parse_version(""))

    def test_unknown_output_returns_none(self):
        self.assertIsNone(smoke.parse_version("command not found\n"))


class WaitForHttpTest(unittest.TestCase):
    URLS = ("http://127.0.0.1:4096/app", "http://127.0.0.1:4096/config")

    def test_immediate_success(self):
        clock = FakeClock()
        result = smoke.wait_for_http(self.URLS, timeout_s=30,
                                     probe=lambda url: 200,
                                     clock=clock, sleep=clock.sleep)
        self.assertTrue(result.ok)
        self.assertEqual(result.status, 200)
        self.assertEqual(result.attempts, 1)
        self.assertEqual(result.url, self.URLS[0])
        self.assertEqual(clock.slept, 0)

    def test_retries_until_ready(self):
        clock = FakeClock()
        calls = []

        def probe(url):
            calls.append(url)
            if len(calls) < 5:
                raise ConnectionRefusedError("还没起来")
            return 200

        result = smoke.wait_for_http(self.URLS, timeout_s=30, interval_s=0.5,
                                     probe=probe, clock=clock,
                                     sleep=clock.sleep)
        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 3)
        self.assertAlmostEqual(result.elapsed_s, 1.0)
        self.assertEqual(clock.slept, 2)

    def test_second_url_can_answer(self):
        """``/app`` 404 时立刻试 ``/config``：同一轮内就要成功，不等下一轮。"""
        clock = FakeClock()
        clock.slept = 0
        codes = {self.URLS[0]: 404, self.URLS[1]: 200}
        result = smoke.wait_for_http(self.URLS, timeout_s=30,
                                     probe=codes.__getitem__,
                                     clock=clock, sleep=clock.sleep)
        self.assertTrue(result.ok)
        self.assertEqual(result.status, 200)
        self.assertEqual(result.url, self.URLS[1])
        self.assertEqual(result.attempts, 1)
        self.assertEqual(clock.slept, 0)

    def test_timeout_does_not_loop_forever(self):
        clock = FakeClock()

        def probe(url):
            raise TimeoutError("连不上")

        result = smoke.wait_for_http(self.URLS, timeout_s=2.0, interval_s=0.5,
                                     probe=probe, clock=clock,
                                     sleep=clock.sleep)
        self.assertFalse(result.ok)
        self.assertIsNone(result.status)
        self.assertGreaterEqual(result.elapsed_s, 2.0)
        self.assertIn("TimeoutError", result.detail)
        # 2s / 0.5s → 4 次 sleep 之后到点，第 5 轮就放弃，不会无限转。
        self.assertEqual(result.attempts, 5)
        self.assertEqual(clock.slept, 4)

    def test_exited_process_stops_polling(self):
        """进程已经死了就别再等到超时：立刻返回，并把原因说清楚。"""
        clock = FakeClock()

        def probe(url):
            raise ConnectionRefusedError("没人监听")

        result = smoke.wait_for_http(self.URLS, timeout_s=30,
                                     probe=probe, clock=clock,
                                     sleep=clock.sleep, exited=lambda: True)
        self.assertFalse(result.ok)
        self.assertIn("退出", result.detail)
        self.assertEqual(result.attempts, 1)
        self.assertEqual(clock.slept, 0)

    def test_error_status_is_reported(self):
        clock = FakeClock()
        result = smoke.wait_for_http(self.URLS, timeout_s=0.6, interval_s=0.5,
                                     probe=lambda url: 500,
                                     clock=clock, sleep=clock.sleep)
        self.assertFalse(result.ok)
        self.assertIn("500", result.detail)


class StopProcessTest(unittest.TestCase):
    def test_stops_live_child(self):
        proc = subprocess.Popen([sys.executable, "-c",
                                 "import time; time.sleep(60)"])
        try:
            self.assertIsNone(proc.poll())
            self.assertTrue(smoke.stop_process(proc, grace_s=10))
            self.assertIsNotNone(proc.poll())
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)

    def test_already_dead_child_is_fine(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait(timeout=30)
        self.assertTrue(smoke.stop_process(proc))


class LogTailTest(unittest.TestCase):
    def test_server_password_is_redacted(self):
        """serve 每次启动都会打一行一次性口令 —— 失败日志尾巴里必须抹掉。"""
        import io

        buf = io.BytesIO(b"server listening on http://127.0.0.1:4096\n"
                         b"server password s3cr3t-token\n")
        tail = smoke._tail(buf)
        self.assertIn("server listening", tail)
        self.assertIn("<redacted>", tail)
        self.assertNotIn("s3cr3t-token", tail)


class PortProbeTest(unittest.TestCase):
    def test_detects_listener_on_loopback(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            self.assertTrue(smoke.is_port_open("127.0.0.1", port))
        self.assertFalse(smoke.is_port_open("127.0.0.1", port))


class ResolveExeTest(unittest.TestCase):
    def test_explicit_missing_path_is_not_silently_ignored(self):
        """指定的路径不存在时返回 None —— 不偷偷退回仓库里那份。"""
        missing = str(Path(tempfile.gettempdir()) / "no-such-opencode.exe")
        with mock.patch.dict(os.environ, {smoke.ENV_EXE: ""}):
            self.assertIsNone(smoke.resolve_exe(missing))

    def test_explicit_existing_path_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "opencode.exe"
            fake.write_bytes(b"")
            self.assertEqual(smoke.resolve_exe(str(fake)), fake)

    def test_env_var_missing_path_is_not_silently_ignored(self):
        missing = str(Path(tempfile.gettempdir()) / "no-such-opencode.exe")
        with mock.patch.dict(os.environ, {smoke.ENV_EXE: missing}):
            self.assertIsNone(smoke.resolve_exe())

    def test_env_var_existing_path_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "opencode.exe"
            fake.write_bytes(b"")
            with mock.patch.dict(os.environ, {smoke.ENV_EXE: str(fake)}):
                self.assertEqual(smoke.resolve_exe(), fake)

    def test_directory_is_not_an_exe(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(smoke.resolve_exe(tmp))


EXE = smoke.resolve_exe()


@unittest.skipUnless(EXE is not None, "本机没有 .deps/opencode/bin/opencode.exe")
class ExeIntegrationTest(unittest.TestCase):
    def test_version_matches_pinned_constant(self):
        version, raw = smoke.read_version(EXE)
        self.assertEqual(version, smoke.OPENCODE_VERSION,
                         f"--version 原始输出：{raw!r}")
        self.assertEqual(smoke.main(["--version", "--exe", str(EXE)]), 0)


if __name__ == "__main__":
    unittest.main()
