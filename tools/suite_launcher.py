#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""suite_launcher.py —— 找到并启动原版 NovAtel Application Suite。

RPA 流程（``workflows/gui.*.yaml``）要在原版套件里点控件，先得有套件在跑；而
「怎么把套件拉起来」这件事本身不该散落在每个流程里。本模块只做三件事：

1. **定位**（:func:`find_suite`）——环境变量 → 仓库/整包里的便携副本 → 默认安装目录；
2. **启动**（:func:`launch`）——固定带 ``--force-renderer-accessibility``，否则
   Chromium 不把网页内容暴露给 UIA，``tools/uia_driver.py`` 只会看到一层
   ``Intermediate D3D Window``；
3. **收尾**（:func:`status` / :func:`stop`）——先请求关窗，等 5 秒还在就强杀。

## 为什么固定那个开关

原版套件是 Electron。没有 ``--force-renderer-accessibility`` 时，UIA 树里根本没有
``Add Device``、``Process`` 这些控件，驱动会（正确地）报「control not found」。
把开关写进启动命令，是为了让「装了套件却驱不动」这个故障**不可能**由启动方式引起。

## 便携副本

整包里可以把原版套件放在 ``<root>/payload/original/NovAtel Application Suite``
（或 ``build_payload.py`` 平铺出来的 ``<root>/original/``），插上就能用，不依赖
``C:\\Program Files``。``portable`` 表示「真的在用这一份随包副本」，用来在证据里
区分「跑的是随包副本」还是「跑的是本机装的」。

## 用法

    python tools/suite_launcher.py --check
    python tools/suite_launcher.py --launch
    python tools/suite_launcher.py --launch --wait-ready --timeout 90
    python tools/suite_launcher.py --stop 12345

退出码：``0`` 成功 / ``1`` 检查到「没装」、等不到就绪、或没停掉 / ``2`` 用法错误或套件不在。
"""
from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

__all__ = [
    "ACCESSIBILITY_FLAG",
    "EXE_NAME",
    "PROCESS_NAME",
    "SuiteInfo",
    "SuiteUnavailable",
    "check",
    "find_suite",
    "launch",
    "main",
    "status",
    "stop",
]

#: 原版套件的入口 exe。与 ``tools/uia_selectors.json`` 的 ``suite.exe`` 保持一致。
EXE_NAME = "NovAtelApplicationSuite.exe"
#: 进程名（不带 .exe），UIA 驱动按它找窗口。
PROCESS_NAME = "NovAtelApplicationSuite"
#: 不带这个开关，Electron 不会把网页内容暴露给 UIA。
ACCESSIBILITY_FLAG = "--force-renderer-accessibility"
#: 覆盖安装目录的环境变量（优先级最高）。
ENV_VAR = "FSA_SUITE_DIR"
#: 本机默认安装位置。
DEFAULT_SUITE = Path(r"C:\Program Files\NovAtel Inc\NovAtel Application Suite")
#: 仓库根（本文件上一级）。
ROOT = Path(__file__).resolve().parents[1]
#: 便携副本相对仓库根的路径。
PAYLOAD_RELATIVE = Path("payload") / "original" / "NovAtel Application Suite"

DEFAULT_WAIT_S = 60.0
DEFAULT_READY_INTERVAL_S = 0.5
DEFAULT_STOP_TIMEOUT_S = 5.0
DEFAULT_KILL_WAIT_S = 2.0

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2

_STILL_ACTIVE = 259
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_TERMINATE = 0x0001
_WM_CLOSE = 0x0010
_ERROR_ACCESS_DENIED = 5


class SuiteUnavailable(RuntimeError):
    """套件不在、启动失败，或这个平台做不了这些事。"""


class SuiteInfo:
    """一份套件的位置。``exists`` 只看 exe 在不在，不跑任何东西。

    刻意不用 ``@dataclass``：本文件会被 ``importlib`` 按路径加载（payload 里
    ``tools/`` 不在 ``sys.path``），而带 ``from __future__ import annotations``
    的 dataclass 在模块未登记进 ``sys.modules`` 时会崩——一个位置对象不值得承担
    这种加载方式差异。
    """

    __slots__ = ("dir", "exe", "portable", "exists", "source")

    def __init__(self, dir: Path, exe: Path, portable: bool, exists: bool,
                 source: str = "") -> None:
        self.dir = Path(dir)
        self.exe = Path(exe)
        self.portable = bool(portable)
        self.exists = bool(exists)
        self.source = str(source)

    def __repr__(self) -> str:
        return (f"SuiteInfo(dir={self.dir!s}, exe={self.exe!s}, "
                f"portable={self.portable!r}, exists={self.exists!r}, "
                f"source={self.source!r})")

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, SuiteInfo):
            return NotImplemented
        return (self.dir, self.exe, self.portable, self.exists, self.source) == (
            other.dir, other.exe, other.portable, other.exists, other.source)

    def to_dict(self) -> dict:
        return {
            "dir": str(self.dir),
            "exe": str(self.exe),
            "portable": bool(self.portable),
            "exists": bool(self.exists),
            "source": self.source,
        }


# --------------------------------------------------------------------- 定位
def _under(child: Path, parent: Path) -> bool:
    """``child`` 是否在 ``parent`` 下面（不要求存在；跨盘返回 False）。"""
    left = os.path.normcase(os.path.abspath(str(child)))
    right = os.path.normcase(os.path.abspath(str(parent)))
    try:
        return os.path.commonpath([left, right]) == right
    except ValueError:  # 不同盘符
        return False


def _info(source: str, directory: Path, root: Path) -> SuiteInfo:
    directory = Path(directory)
    exe = directory / EXE_NAME
    exists = exe.is_file()
    bundle = (Path(root) / "payload", Path(root) / "original")
    portable = exists and any(_under(directory, p) for p in bundle)
    return SuiteInfo(dir=directory, exe=exe, portable=portable,
                     exists=exists, source=source)


def _env_dir(raw: str) -> Path:
    """``FSA_SUITE_DIR`` 可以给安装目录，也可以直接给 exe 的路径。"""
    path = Path(os.path.expandvars(raw)).expanduser()
    if path.suffix.lower() == ".exe" or path.is_file():
        return path.parent
    return path


def find_suite(root: str | Path | None = None) -> SuiteInfo:
    """按固定优先级找套件。

    顺序：``FSA_SUITE_DIR`` → 随包副本 → ``C:\\Program Files\\NovAtel Inc\\
    NovAtel Application Suite``。

    随包副本有三种摆法，都算同一档（``tools/build_payload.py`` 把套件平铺进
    ``original/``，解包后顶层就是它；仓库里的暂存目录则可能是 ``payload/original``
    或带套件名的一层子目录）：::

        <root>/payload/original/NovAtel Application Suite/   （契约路径）
        <root>/payload/original/
        <root>/original/NovAtel Application Suite/
        <root>/original/

    返回**第一个存在 exe 的候选**；都不存在时返回优先级最高的那个（``exists=False``），
    这样 ``--check`` 能说清「找的是哪里、为什么没找到」。反过来，如果机械地按优先级
    返回「第一个候选」而不看它存不存在，一个过期的环境变量就会盖住真实的便携副本。
    """
    base = Path(root).expanduser() if root else ROOT
    base = Path(os.path.abspath(str(base)))
    env = (os.environ.get(ENV_VAR) or "").strip()

    candidates: list[tuple[str, Path]] = []
    if env:
        candidates.append(("env", _env_dir(env)))
    candidates.extend([
        ("payload", base / PAYLOAD_RELATIVE),
        ("payload", base / "payload" / "original"),
        ("bundle", base / "original" / "NovAtel Application Suite"),
        ("bundle", base / "original"),
        ("program-files", DEFAULT_SUITE),
    ])

    first: SuiteInfo | None = None
    for source, directory in candidates:
        info = _info(source, directory, base)
        if info.exists:
            return info
        if first is None:
            first = info
    if first is None:  # 只有 root 为空时才会发生，保留一个可解释的返回值
        first = _info("payload", base / PAYLOAD_RELATIVE, base)
    return first


def _as_suite(value: SuiteInfo | str | Path) -> SuiteInfo:
    if isinstance(value, SuiteInfo):
        return value
    path = Path(value).expanduser()
    if path.suffix.lower() == ".exe":
        directory, exe = path.parent, path
    else:
        directory, exe = path, path / EXE_NAME
    directory = Path(os.path.abspath(str(directory)))
    return SuiteInfo(dir=directory, exe=exe, portable=False,
                     exists=exe.is_file(), source="explicit")


# --------------------------------------------------------------------- 启动
def _extra_args(extra_args) -> list[str]:
    if extra_args is None:
        return []
    if isinstance(extra_args, (str, bytes)):
        raise ValueError("extra_args 必须是字符串序列，不能是一整条命令行（我们不经过 shell）")
    args: list[str] = []
    for item in extra_args:
        text = item if isinstance(item, str) else str(item)
        if text == ACCESSIBILITY_FLAG:
            continue  # 开关只出现一次，且固定在 exe 后面
        args.append(text)
    return args


#: 原版 ``main.js`` 的 CLI 判定：只要 argv 多于一个且 argv[0] 含
#: ``NovAtelApplicationSuite``，它就把这轮当成 Convert CLI，Chromium 开关会被
#: 当成非法参数。用一个不同名的硬链接（失败再复制）启动，开关才能真正到达 Chromium。
RUNNER_NAME = "NASRunner.exe"


def _accessibility_runner(info: SuiteInfo) -> Path | None:
    """返回可带 Chromium 开关启动的副本/硬链接；目录不可写时返回 None。"""
    target = info.dir / RUNNER_NAME
    if target.is_file():
        return target
    try:
        os.link(info.exe, target)
        return target
    except OSError:
        try:
            shutil.copy2(info.exe, target)
            return target
        except OSError:
            return None


def launch(suite: SuiteInfo | str | Path, extra_args=None, *,
           wait_ready: bool = False, timeout: float = DEFAULT_WAIT_S,
           interval: float = DEFAULT_READY_INTERVAL_S,
           driver: object = None, cdp_port: int | None = None) -> dict:
    """启动套件，返回 ``{pid, cmd, portable, accessibility}``。

    原版对任意多余参数会进 Convert CLI 并退出；因此优先用 ``NASRunner.exe``
    硬链接（同名判定不成立）把 ``--force-renderer-accessibility`` 传给 Chromium。
    安装目录不可写时退回「不带开关正常启动」，``accessibility=False``，GUI 流程
    走 assisted 人工任务，不假装 UIA 可用。
    """
    info = _as_suite(suite)
    if not info.exe.is_file():
        raise SuiteUnavailable(
            f"没找到原版套件：{info.exe}（装套件，或把 {ENV_VAR} 指向安装目录）")

    runner = _accessibility_runner(info)
    exe = runner or info.exe
    args = [ACCESSIBILITY_FLAG, *_extra_args(extra_args)] if runner else _extra_args(extra_args)
    if cdp_port:
        args.append(f"--remote-debugging-port={int(cdp_port)}")
    cmd = [str(exe), *args]
    env = dict(os.environ)
    if runner:
        env["NOVATEL_SUITE_PROCESS"] = runner.stem
    try:
        proc = subprocess.Popen(cmd, shell=False, cwd=str(info.dir), env=env)
    except OSError as exc:
        raise SuiteUnavailable(f"启动原版套件失败：{exc}") from exc

    result: dict = {
        "pid": int(proc.pid), "cmd": cmd, "portable": bool(info.portable),
        "accessibility": bool(runner), "process": runner.stem if runner else info.exe.stem,
    }
    if cdp_port:
        result["cdp_port"] = int(cdp_port)
    if wait_ready:
        ready, reason = _wait_for_driver(driver, timeout, interval)
        result["ready"] = ready
        result["state"] = "ready" if ready else "not_ready"
        if reason:
            result["reason"] = reason
    return result


def _available(driver: object) -> bool:
    value = getattr(driver, "available", False)
    return bool(value() if callable(value) else value)


def _wait_for_driver(driver: object, timeout: float, interval: float) -> tuple[bool, str]:
    """轮询 ``uia_driver.create().available``；任何异常都变成「没就绪 + 原因」。"""
    try:
        drv = driver if driver is not None else _uia_module().create()
    except Exception as exc:  # noqa: BLE001 —— 驱动缺席是运行时事实，不是崩溃
        return False, f"UIA 驱动不可用：{exc}"

    deadline = time.monotonic() + max(0.0, float(timeout))
    step = float(interval) if float(interval) > 0 else 0.05
    while True:
        try:
            if _available(drv):
                return True, ""
        except Exception as exc:  # noqa: BLE001
            return False, f"UIA 驱动报错：{exc}"
        if time.monotonic() >= deadline:
            return False, f"{float(timeout):g}s 内套件未就绪（UIA 驱动仍不可用）"
        time.sleep(step)


def _uia_module():
    """按文件加载同目录的 ``uia_driver.py``（tools/ 不在 sys.path 里）。"""
    global _UIA_MODULE
    if _UIA_MODULE is None:
        path = Path(__file__).resolve().parent / "uia_driver.py"
        if not path.is_file():
            raise SuiteUnavailable(f"缺少 UIA 驱动：{path}")
        spec = importlib.util.spec_from_file_location("fsa_uia_driver", path)
        if spec is None or spec.loader is None:
            raise SuiteUnavailable(f"加载 UIA 驱动失败：{path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _UIA_MODULE = module
    return _UIA_MODULE


_UIA_MODULE = None


# --------------------------------------------------------------------- 状态
def _validate_pid(pid: object) -> int:
    if isinstance(pid, bool) or not isinstance(pid, int):
        raise ValueError(f"pid 必须是正整数，收到 {pid!r}")
    if pid <= 0:
        raise ValueError(f"pid 必须是正整数，收到 {pid!r}")
    return pid


_WINAPI = None


def _winapi() -> dict:
    """惰性声明 Win32 签名。不写 ``restype`` 时 HANDLE 会被截成 32 位。"""
    global _WINAPI
    if _WINAPI is not None:
        return _WINAPI
    import ctypes.wintypes as wt  # 只有 Windows 才有

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    kernel32.OpenProcess.restype = wt.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
    kernel32.GetExitCodeProcess.restype = wt.BOOL
    kernel32.CloseHandle.argtypes = [wt.HANDLE]
    kernel32.CloseHandle.restype = wt.BOOL
    kernel32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
    kernel32.TerminateProcess.restype = wt.BOOL
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
    kernel32.QueryFullProcessImageNameW.restype = wt.BOOL

    wndenumproc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    user32.EnumWindows.argtypes = [wndenumproc, wt.LPARAM]
    user32.EnumWindows.restype = wt.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    user32.GetWindowThreadProcessId.restype = wt.DWORD
    user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.PostMessageW.restype = wt.BOOL

    _WINAPI = {"kernel32": kernel32, "user32": user32, "wndenumproc": wndenumproc}
    return _WINAPI


def _is_running(pid: int) -> bool:
    """进程还在吗。打不开句柄且错误是「拒绝访问」时，进程其实在。"""
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False
        return True

    kernel32 = _winapi()["kernel32"]
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
    try:
        code = ctypes.c_ulong(0)
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == _STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _process_exe(pid: int) -> str:
    if sys.platform != "win32":
        return ""
    kernel32 = _winapi()["kernel32"]
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return ""
    try:
        size = ctypes.c_ulong(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return str(buf.value or "")
        return ""
    finally:
        kernel32.CloseHandle(handle)


def status(pid: int) -> dict:
    """一个 pid 的存活状态。``exe`` 拿不到时是空串，不猜。"""
    pid = _validate_pid(pid)
    return {"pid": pid, "running": bool(_is_running(pid)), "exe": _process_exe(pid)}


# --------------------------------------------------------------------- 收尾
def _request_close(pid: int) -> bool:
    """给该进程的所有顶层窗口发 ``WM_CLOSE``。没有窗口时返回 False。"""
    if sys.platform != "win32":
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return False
        return True

    api = _winapi()
    user32 = api["user32"]
    handles: list[int] = []

    def _collect(hwnd, _lparam):  # noqa: ANN001 —— Win32 回调
        owner = ctypes.c_ulong(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == int(pid):
            handles.append(hwnd)
        return True

    user32.EnumWindows(api["wndenumproc"](_collect), 0)
    if not handles:
        return False
    posted = False
    for hwnd in handles:
        if user32.PostMessageW(hwnd, _WM_CLOSE, 0, 0):
            posted = True
    return posted


def _force_kill(pid: int) -> bool:
    if sys.platform != "win32":
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            return False
        return True

    kernel32 = _winapi()["kernel32"]
    handle = kernel32.OpenProcess(_PROCESS_TERMINATE, False, int(pid))
    if not handle:
        return False
    try:
        return bool(kernel32.TerminateProcess(handle, 1))
    finally:
        kernel32.CloseHandle(handle)


def stop(pid: int, *, timeout: float = DEFAULT_STOP_TIMEOUT_S,
         interval: float = 0.1, kill_wait: float = DEFAULT_KILL_WAIT_S) -> dict:
    """先请求关窗 → 等 ``timeout`` 秒 → 还在就强杀。

    Windows 上 ``Popen.terminate()`` 本身就是 ``TerminateProcess``，所以这里的
    「terminate」是发 ``WM_CLOSE``：让套件自己保存状态、断开串口，和用户点 × 一样。
    """
    pid = _validate_pid(pid)
    result = {
        "pid": pid,
        "stopped": False,
        "forced": False,
        "already_exited": False,
        "close_requested": False,
    }
    if not _is_running(pid):
        result.update(stopped=True, already_exited=True)
        return result

    result["close_requested"] = bool(_request_close(pid))
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        if not _is_running(pid):
            result["stopped"] = True
            return result
        if time.monotonic() >= deadline:
            break
        time.sleep(max(0.0, float(interval)))

    result["forced"] = bool(_force_kill(pid))
    grace = time.monotonic() + max(0.0, float(kill_wait))
    while True:
        if not _is_running(pid):
            break
        if time.monotonic() >= grace:
            break
        time.sleep(max(0.0, float(interval)))
    result["stopped"] = not _is_running(pid)
    return result


# --------------------------------------------------------------------- 汇总
def check(root: str | Path | None = None) -> dict:
    """``installed`` 看 exe 在不在；``available`` 看 UIA 驱动认不认这份安装。

    两者按契约定义（驱动 ``available`` 就是 exe 存在）会一致；分开列是为了让
    「套件装了但驱动没加载」这种将来可能出现的状态有地方落。
    """
    info = find_suite(root)
    report = info.to_dict()
    report["installed"] = bool(info.exists)
    report["process"] = PROCESS_NAME
    report["available"] = False
    report["driver"] = ""
    try:
        module = _uia_module()
        driver = module.UiaDriver(suite_dir=info.dir)
        report["available"] = bool(driver.available)
        report["driver"] = str(Path(module.__file__).name)
    except Exception as exc:  # noqa: BLE001 —— 驱动坏了要报，不要吞成「没装」
        report["driver_error"] = str(exc)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="suite", description="定位、启动、停止原版 NovAtel Application Suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="退出码：0 成功 / 1 未安装、未就绪或未停掉 / 2 用法错误或套件不在")
    ap.add_argument("--check", action="store_true", help="报告安装/可驱动状态（JSON）")
    ap.add_argument("--launch", action="store_true", help="启动套件")
    ap.add_argument("--stop", type=int, metavar="PID", help="停止该 pid（先关窗，5 秒后强杀）")
    ap.add_argument("--root", default=None, help="仓库根（默认脚本上一级）")
    ap.add_argument("--wait-ready", action="store_true",
                    help="启动后轮询 UIA 驱动可用（最多 --timeout 秒）")
    ap.add_argument("--timeout", type=float, default=DEFAULT_WAIT_S,
                    help=f"--wait-ready 的超时秒数（默认 {DEFAULT_WAIT_S:g}）")
    ap.add_argument("--cdp-port", type=int, default=None,
                    help="以 --remote-debugging-port 启动，供 cdp_driver 使用（如 9223）")
    args = ap.parse_args(argv)

    if not (args.check or args.launch or args.stop is not None):
        ap.print_help()
        return EXIT_USAGE

    try:
        if args.check:
            report = check(args.root)
            print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
            return EXIT_OK if report["installed"] else EXIT_FAILED

        if args.stop is not None:
            result = stop(args.stop)
            print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
            return EXIT_OK if result["stopped"] else EXIT_FAILED

        suite = find_suite(args.root)
        result = launch(suite, wait_ready=args.wait_ready, timeout=args.timeout,
                        cdp_port=args.cdp_port)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        if args.wait_ready and not result.get("ready", False):
            return EXIT_FAILED
        return EXIT_OK
    except (SuiteUnavailable, ValueError) as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
