#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""opencode_smoke.py —— 冒烟检查本地 OpenCode 运行时（E1 的 A 侧）。

这个脚本只做三件事，每件都要有可观察的结果，不做「看起来像跑通了」的推断：

1. ``--version``：执行 ``opencode.exe --version``，从输出里解析版本号并打印，
   与 ``OPENCODE_VERSION`` 比对（不一致只提示，不判失败 —— 升级过但没改常量时
   需要看到这一点，而不是被一条假失败挡住）。
2. ``--serve --port 4096``：起 ``opencode serve``，轮询 ``/app`` 与 ``/config``
   最多 ``--timeout`` 秒，打印响应码，然后**一定**停掉子进程，再确认端口已释放。
3. 找不到 ``opencode.exe`` 时给出明确错误并退出 2（不猜、不去 PATH 里捡一个
   别的版本来冒充）。

运行时装在哪、怎么装、升级时改哪个常量，见 ``docs/operations/opencode.md``。

它与 ``tools/anthropic_shim.py`` 是两个互不依赖的运行时：shim 把 Anthropic
Messages 翻给本地 OpenAI 兼容服务（给 Claude SDK 用）；OpenCode 自己是完整的
agent 运行时，走它自己的 provider 配置，**不经过** shim，也不 import 它。

用法：

    python tools/opencode_smoke.py --version
    python tools/opencode_smoke.py --serve --port 4096
    python tools/opencode_smoke.py --version --exe <别的 opencode.exe>

退出码：0 成功；1 exe 报错或版本号/响应无法解析；2 找不到 exe、用法错误或端口
已被占用；3 serve 在超时内没有就绪；4 子进程没能停掉。
"""
from __future__ import annotations

import argparse
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

ROOT = Path(__file__).resolve().parents[1]

# ── 升级 OpenCode 时改这里 ───────────────────────────────────────────────
# 版本与平台包必须一一对应：OpenChamber 2.5.3 固定用 2.2.0。
OPENCODE_VERSION = "2.2.0"
OPENCODE_NPM_PACKAGE = "@opencode/cli-windows-x64"
DEFAULT_EXE = ROOT / ".deps" / "opencode" / "bin" / "opencode.exe"
# ────────────────────────────────────────────────────────────────────────

ALT_EXE = ROOT / ".deps" / "opencode" / "opencode.exe"
ENV_EXE = "OPENCODE_EXE"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4096
READY_PATHS = ("/app", "/config")
READY_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 0.25

# 语义化版本：前后不允许紧邻数字或点，避免把 127.0.0.1、端口 4096 认成版本。
VERSION_RE = re.compile(r"(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?![\d.])")


# ── 纯函数 ──────────────────────────────────────────────────────────────
def parse_version(text: str) -> str | None:
    """从 ``opencode v2.2.0`` / ``2.2.0`` 这类输出里取出语义化版本号。

    逐行扫，只认第一处形如 ``X.Y.Z`` 的片段（可带预览后缀）；``127.0.0.1``
    与 ``4096`` 不会被误认。找不到返回 ``None``。
    """
    for line in text.splitlines():
        match = VERSION_RE.search(line)
        if match:
            return match.group(1)
    return None


@dataclass(frozen=True)
class PollResult:
    """端口轮询的结果：成功与否、拿到的状态码、命中的 URL、尝试次数与耗时。"""

    ok: bool
    status: int | None
    url: str
    attempts: int
    elapsed_s: float
    detail: str = ""


def http_status(url: str, timeout_s: float = 2.0) -> int:
    """GET 一个 URL，返回 HTTP 状态码。

    4xx/5xx 也是「服务答话了」，按状态码返回而不是当异常吞掉；连不上、超时、
    DNS 失败照常抛 ``OSError`` / ``URLError``，由调用方决定这算不算还没就绪。
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as response:
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def wait_for_http(urls: Sequence[str],
                  timeout_s: float = READY_TIMEOUT_S,
                  interval_s: float = POLL_INTERVAL_S,
                  probe: Callable[[str], int] = http_status,
                  clock: Callable[[], float] = time.monotonic,
                  sleep: Callable[[float], None] = time.sleep,
                  exited: Callable[[], bool] | None = None) -> PollResult:
    """轮询 ``urls`` 直到任一返回 2xx、进程退出或超时。

    每轮里按顺序试所有 URL；任一 2xx 立即成功。``probe`` / ``clock`` / ``sleep``
    都可注入，测试因此不需要真起服务、真等 30 秒。``exited`` 返回真时立刻收手：
    子进程已经死了还继续轮询，只会把「启动失败」拖成一次超时。
    """
    start = clock()
    attempts = 0
    last = ""
    while True:
        attempts += 1
        for url in urls:
            try:
                code = probe(url)
            except Exception as exc:  # 连不上、超时、协议错都算「还没就绪」
                last = f"{url}: {type(exc).__name__}"
                continue
            if 200 <= code < 300:
                return PollResult(True, code, url, attempts, clock() - start)
            last = f"{url}: HTTP {code}"

        if exited is not None and exited():
            return PollResult(False, None, urls[0], attempts, clock() - start,
                              "子进程已退出，服务没起来")

        elapsed = clock() - start
        if elapsed >= timeout_s:
            return PollResult(False, None, urls[0], attempts, elapsed,
                              last or "没有任何响应")
        sleep(interval_s)


# ── 进程与文件系统 ──────────────────────────────────────────────────────
def resolve_exe(explicit: str | None = None) -> Path | None:
    """定位 opencode.exe：显式参数 → ``OPENCODE_EXE`` → 仓库内两处默认位置。

    前两者一旦给了就是**唯一**答案：指错路径时直接报找不到，而不是悄悄退回
    默认位置 —— 否则「我明明指定了另一个 exe」会表现成「指定没生效」。
    刻意不查 PATH：机器上另装了一份别的版本时，PATH 会悄悄换掉被测对象，
    这种「跑通了但不是这套」比失败更难查。
    """
    if explicit:
        given = Path(explicit)
        return given if given.is_file() else None
    from_env = os.environ.get(ENV_EXE)
    if from_env:
        given = Path(from_env)
        return given if given.is_file() else None
    for candidate in (DEFAULT_EXE, ALT_EXE):
        if candidate.is_file():
            return candidate
    return None


def is_port_open(host: str, port: int, timeout_s: float = 0.5) -> bool:
    """本地端口上有没有人在监听（只连回环，不发任何数据）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout_s)
        return sock.connect_ex((host, port)) == 0


def stop_process(proc: subprocess.Popen, grace_s: float = 5.0) -> bool:
    """先 ``terminate`` 再 ``kill``；返回进程是否确实已结束。"""
    if proc.poll() is not None:
        return True
    try:
        proc.terminate()
    except OSError:
        return True
    try:
        proc.wait(timeout=grace_s)
        return True
    except subprocess.TimeoutExpired:
        pass
    try:
        proc.kill()
    except OSError:
        return True
    try:
        proc.wait(timeout=grace_s)
        return True
    except subprocess.TimeoutExpired:
        return False


def _decode(raw: bytes) -> str:
    """子进程输出按 UTF-8 解，坏字节替换 —— 不让一个乱码字节把冒烟检查变成异常。"""
    return raw.decode("utf-8", "replace")


def _tail(handle, limit: int = 20) -> str:
    """取日志文件的最后若干行（用于失败时给出原因，而不是只报超时）。

    serve 启动时会往 stdout 打一行 ``server password <token>``。那是一次性的本地
    口令，不该出现在终端/日志/工单里，所以这里按行抹掉，只留证据不留秘密。
    """
    try:
        handle.flush()
        handle.seek(0)
        lines = _decode(handle.read()).splitlines()
    except (OSError, ValueError):
        return ""
    safe = ["server password <redacted>" if line.strip().lower()
            .startswith("server password") else line for line in lines]
    return "\n".join(safe[-limit:])


# ── 两个子命令 ──────────────────────────────────────────────────────────
def read_version(exe: Path, timeout_s: float = 60.0) -> tuple[str | None, str]:
    """跑 ``--version``，返回 (解析到的版本, 原始输出)。版本解析失败时版本为 None。"""
    completed = subprocess.run([str(exe), "--version"],
                               capture_output=True, timeout=timeout_s)
    raw = _decode(completed.stdout) + _decode(completed.stderr)
    if completed.returncode != 0:
        raise RuntimeError(f"`{exe.name} --version` 退出码 {completed.returncode}："
                           f"{raw.strip()[:400]}")
    return parse_version(raw), raw


def cmd_version(exe: Path) -> int:
    try:
        version, raw = read_version(exe)
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        print(f"[阻断] 跑不起来：{exc}", file=sys.stderr)
        return 1
    if version is None:
        print(f"[阻断] 输出里没找到版本号：{raw.strip()[:400]!r}", file=sys.stderr)
        return 1

    print(f"opencode {version}")
    print(f"  exe    : {exe}")
    if version != OPENCODE_VERSION:
        print(f"[提示] 与本文件记录的期望版本 {OPENCODE_VERSION} 不一致："
              f"升级过就把 OPENCODE_VERSION / OPENCODE_NPM_PACKAGE 一起改掉"
              f"（见 docs/operations/opencode.md）", file=sys.stderr)
    return 0


def cmd_serve(exe: Path, host: str, port: int, timeout_s: float) -> int:
    if is_port_open(host, port):
        print(f"[阻断] {host}:{port} 已被占用：先停掉占用它的进程，"
              f"或换 --port", file=sys.stderr)
        return 2

    base = f"http://{host}:{port}"
    urls = [base + path for path in READY_PATHS]
    log = tempfile.TemporaryFile()
    proc = subprocess.Popen([str(exe), "serve", "--port", str(port)],
                            stdout=log, stderr=subprocess.STDOUT,
                            cwd=str(ROOT))
    stopped = True
    try:
        result = wait_for_http(urls, timeout_s=timeout_s,
                               exited=lambda: proc.poll() is not None)
        if result.ok:
            print(f"[OK] {result.url} → {result.status} "
                  f"（{result.attempts} 次轮询，{result.elapsed_s:.2f}s 就绪）")
        else:
            print(f"[阻断] {timeout_s:.0f}s 内没有就绪：{result.detail}",
                  file=sys.stderr)
            tail = _tail(log)
            if tail:
                print("--- serve 日志尾部 ---", file=sys.stderr)
                print(tail, file=sys.stderr)
    finally:
        stopped = stop_process(proc)
        if stopped and is_port_open(host, port):
            # 进程没了但端口还在：多半是另一个实例仍占着，报出来而不是当成清干净了。
            print(f"[提示] 进程已退出，但 {host}:{port} 仍有监听", file=sys.stderr)
        try:
            log.close()
        except OSError:
            pass

    if not stopped:
        print(f"[阻断] 子进程 pid={proc.pid} 没能停掉，请手动结束它",
              file=sys.stderr)
        return 4
    if not result.ok:
        return 3
    print(f"[OK] 已停止 serve（pid={proc.pid}），{host}:{port} 已释放")
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="OpenCode 运行时冒烟检查（E1 的 A 侧）")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--version", action="store_true",
                        help="跑 opencode.exe --version 并打印解析到的版本")
    action.add_argument("--serve", action="store_true",
                        help="起 opencode serve、轮询就绪，然后停掉")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"serve 端口（默认 {DEFAULT_PORT}）")
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help=f"监听地址（默认 {DEFAULT_HOST}，只走回环）")
    parser.add_argument("--timeout", type=float, default=READY_TIMEOUT_S,
                        help=f"就绪等待上限，秒（默认 {READY_TIMEOUT_S:.0f}）")
    parser.add_argument("--exe", default=None,
                        help=f"opencode.exe 路径（默认 {DEFAULT_EXE}）")
    args = parser.parse_args(argv)

    exe = resolve_exe(args.exe)
    if exe is None:
        print("[阻断] 找不到 opencode.exe。找过：", file=sys.stderr)
        if args.exe:
            print(f"  --exe      {args.exe}", file=sys.stderr)
        print(f"  ${ENV_EXE}  {os.environ.get(ENV_EXE) or '(未设置)'}",
              file=sys.stderr)
        print(f"  默认位置    {DEFAULT_EXE}", file=sys.stderr)
        print(f"  备用位置    {ALT_EXE}", file=sys.stderr)
        print(f"安装方法：npm pack {OPENCODE_NPM_PACKAGE}@{OPENCODE_VERSION} "
              f"--registry=https://registry.npmmirror.com，"
              f"解压到 {DEFAULT_EXE.parents[1]}"
              f"（见 docs/operations/opencode.md）", file=sys.stderr)
        return 2

    if args.version:
        return cmd_version(exe)
    return cmd_serve(exe, args.host, args.port, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
