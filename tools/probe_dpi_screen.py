#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_dpi_screen.py —— 分清「物理屏真的变了」和「只是 DPI 虚拟化」。

## 为什么必须查这件事

计划书 §3.2 用一条实测当论据：

    之前  DISPLAY19 = GameViewer 虚拟屏   2560×1600
    现在  DISPLAY1  = Intel 物理内屏      1707×1067

由此得出「物理屏不是常量，所以必须用虚拟屏」。这个结论**可能站不住**：

    2560 / 1.5 = 1706.67 ≈ 1707
    1600 / 1.5 = 1066.67 ≈ 1067

本机 `LogPixels = 144`，正是 150%。`GetSystemMetrics(SM_CXSCREEN)` 对
**DPI-unaware 进程**返回的是「虚拟化后」的像素，对 DPI-aware 进程返回物理像素。
同一个 2560×1600 的屏幕，两个进程读出来的数字能差 1.5 倍——这不是屏幕变了，
是读取方变了。

如果真是这样，计划书里「物理屏会变」的论据就得换成别的（RDP 连入/断开、
外接屏插拔这些**确实**会改物理分辨率的事件），而不是拿一条 DPI 假象当理由。

## 怎么查

同一次运行里分别：

1. **不调**任何 DPI API，直接 `GetSystemMetrics`（＝虚拟化后，模拟旧结论）；
2. `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` 之后再读（＝物理像素）；
3. `EnumDisplaySettingsW("\\\\.\\DISPLAY1", ENUM_CURRENT_SETTINGS)`（＝驱动报告的物理模式）。

三者的关系就是答案：若 3 == 2 且 1 == 2/1.5，那 1707×1067 就是 DPI 假象。

## 用法

    python tools/probe_dpi_screen.py
    python tools/probe_dpi_screen.py --json

退出码：0 全部读完（不管结论如何）；2 读不到（非 Windows / 无桌面）。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes


def _sm() -> tuple[int, int]:
    """DPI-unaware 视角：`GetSystemMetrics` 原样返回。"""
    user32 = ctypes.windll.user32
    return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))


class DEVMODE(ctypes.Structure):
    _fields_ = [
        ("dmDeviceName", wintypes.WCHAR * 32),
        ("dmSpecVersion", wintypes.WORD),
        ("dmDriverVersion", wintypes.WORD),
        ("dmSize", wintypes.WORD),
        ("dmDriverExtra", wintypes.WORD),
        ("dmFields", wintypes.DWORD),
        ("dmPositionX", ctypes.c_int),
        ("dmPositionY", ctypes.c_int),
        ("dmDisplayOrientation", wintypes.DWORD),
        ("dmDisplayFixedOutput", wintypes.DWORD),
        ("dmColor", ctypes.c_short),
        ("dmDuplex", ctypes.c_short),
        ("dmYResolution", ctypes.c_short),
        ("dmTTOption", ctypes.c_short),
        ("dmCollate", ctypes.c_short),
        ("dmFormName", wintypes.WCHAR * 32),
        ("dmLogPixels", wintypes.WORD),
        ("dmBitsPerPel", wintypes.DWORD),
        ("dmPelsWidth", wintypes.DWORD),
        ("dmPelsHeight", wintypes.DWORD),
        ("dmDisplayFlags", wintypes.DWORD),
        ("dmDisplayFrequency", wintypes.DWORD),
        ("dmICMMethod", wintypes.DWORD),
        ("dmICMIntent", wintypes.DWORD),
        ("dmMediaType", wintypes.DWORD),
        ("dmDitherType", wintypes.DWORD),
        ("dmReserved1", wintypes.DWORD),
        ("dmReserved2", wintypes.DWORD),
        ("dmPanningWidth", wintypes.DWORD),
        ("dmPanningHeight", wintypes.DWORD),
    ]


def _driver_mode(device: str = r"\\.\DISPLAY1") -> dict | None:
    """驱动报告的物理模式。必须显式给设备名（`NULL` 返回 0 种，本机实测）。"""
    user32 = ctypes.windll.user32
    dm = DEVMODE()
    dm.dmSize = ctypes.sizeof(DEVMODE)
    if not user32.EnumDisplaySettingsW(device, -1, ctypes.byref(dm)):
        return None
    return {
        "device": device,
        "width": int(dm.dmPelsWidth),
        "height": int(dm.dmPelsHeight),
        "refresh": int(dm.dmDisplayFrequency),
        "bpp": int(dm.dmBitsPerPel),
        "log_pixels": int(dm.dmLogPixels),
    }


def _make_dpi_aware() -> tuple[bool, str]:
    """把本进程标成 per-monitor aware v2。已经是 aware 或 API 不存在时返回原因。"""
    user32 = ctypes.windll.user32
    # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == -4
    try:
        ok = user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        if ok:
            return True, "SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)"
    except Exception:  # noqa: BLE001 —— Win10 1703 之前没有这个符号
        pass
    try:
        # shcore.SetProcessDpiAwareness(2) == PROCESS_PER_MONITOR_DPI_AWARE
        hr = ctypes.windll.shcore.SetProcessDpiAwareness(2)
        if hr == 0:
            return True, "shcore.SetProcessDpiAwareness(2)"
    except Exception:  # noqa: BLE001
        pass
    return False, "unavailable"


def probe() -> dict:
    if os.name != "nt":
        return {"error": "not windows"}

    unaware = _sm()
    aware_ok, aware_how = _make_dpi_aware()
    aware = _sm()
    driver = _driver_mode()

    report: dict = {
        "unaware_get_system_metrics": {"width": unaware[0], "height": unaware[1]},
        "dpi_aware_ok": aware_ok,
        "dpi_aware_how": aware_how,
        "aware_get_system_metrics": {"width": aware[0], "height": aware[1]},
        "driver_mode": driver,
    }

    # 结论判定：只做「数字之间能不能对上」的判断，不下别的结论。
    verdict = []
    if driver:
        if aware[0] == driver["width"] and aware[1] == driver["height"]:
            verdict.append("dpi-aware 读数 == 驱动物理模式")
        else:
            verdict.append(
                f"dpi-aware 读数 {aware[0]}x{aware[1]} != 驱动 {driver['width']}x{driver['height']}")
        if unaware != aware:
            ratio = (aware[0] / unaware[0]) if unaware[0] else None
            verdict.append(
                "DPI-unaware 读数与 aware 不同，比值 "
                + (f"{ratio:.4f}" if ratio else "?"))
            if ratio:
                for name, cand in (("125%", 1.25), ("150%", 1.5), ("175%", 1.75), ("200%", 2.0)):
                    if abs(ratio - cand) < 0.01:
                        verdict.append(f"比值与 {name} 缩放一致")
        else:
            verdict.append("两种视角读数相同（本进程本来就 aware，或未缩放）")
    report["verdict"] = verdict
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="只输出 JSON")
    ns = parser.parse_args(argv)

    report = probe()
    if ns.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if "error" not in report else 2

    if "error" in report:
        print(f"读不到：{report['error']}")
        return 2

    u = report["unaware_get_system_metrics"]
    a = report["aware_get_system_metrics"]
    d = report["driver_mode"]
    print(f"DPI-unaware  GetSystemMetrics : {u['width']}x{u['height']}")
    print(f"DPI-aware    ({report['dpi_aware_how']})")
    print(f"DPI-aware    GetSystemMetrics : {a['width']}x{a['height']}")
    if d:
        print(f"驱动现状     EnumDisplaySettings: {d['width']}x{d['height']}@{d['refresh']} "
              f"({d['bpp']}bpp, LogPixels={d['log_pixels']})")
    else:
        print("驱动现状     EnumDisplaySettings: 读不到")
    print()
    for line in report["verdict"]:
        print(f"  · {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
