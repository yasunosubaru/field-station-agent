#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_activate_display.py —— 把「已枚举到模式、但没接桌面」的虚拟屏真正接上去。

## 这个脚本解决什么

装好 IDD 驱动后，虚拟屏会出现在 `EnumDisplayDevices` 里，也能枚举出模式：

    \\.\DISPLAY149  IddSampleDriver Device  virtual   1 mode: 1920x1080@60
    current=                                        <- 但没接桌面（StateFlags 无 0x1）

此时 `GetSystemMetrics` / `QueryDisplayConfig` 都看不到它，DXGI 更看不到。
`ChangeDisplaySettingsEx` 对未接桌面的设备**可以**把它接上，但必须同时给出：

    dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY

**关键是 `DM_POSITION`。** 只给宽高时调用会返回成功，却不会把设备挂到桌面上。

解法来源（不是我自己推的，是查到的实测代码）：
StephenLovino/BetterCast 提交 a1fe251，`activateVirtualDisplay()`：
  1. `EnumDisplayDevices` 找 `isVirtual && !(StateFlags & 0x1)` 的设备
  2. `dm.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT`
  3. `dm.dmPosition.x = 主屏宽度`（放到右侧，避免与主屏重叠）
  4. `ChangeDisplaySettingsEx(dev, &dm, NULL, CDS_UPDATEREGISTRY | CDS_NORESET, NULL)`
  5. `ChangeDisplaySettingsEx(NULL, NULL, NULL, 0, NULL)` 全局应用

## 用法

    python tools/probe_activate_display.py --list         # 只列出候选，不动系统
    python tools/probe_activate_display.py --dry-run      # 说明会怎么做
    python tools/probe_activate_display.py                # 真的接上（可回滚）

退出码：0 成功或无需动作；2 找不到候选；3 调用失败。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes

# ------------------------------------------------------------------ Win32 常量与结构
DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001
DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004
DISPLAY_DEVICE_MIRRORING_DRIVER = 0x00000008

DM_POSITION = 0x00000020
DM_PELSWIDTH = 0x00080000
DM_PELSHEIGHT = 0x00100000
DM_DISPLAYFREQUENCY = 0x00400000

CDS_UPDATEREGISTRY = 0x00000001
CDS_NORESET = 0x10000000

DISP_CHANGE_SUCCESSFUL = 0
ENUM_CURRENT_SETTINGS = -1
ENUM_REGISTRY_SETTINGS = -2


class DISPLAY_DEVICEW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("DeviceName", wintypes.WCHAR * 32),
        ("DeviceString", wintypes.WCHAR * 128),
        ("StateFlags", wintypes.DWORD),
        ("DeviceID", wintypes.WCHAR * 128),
        ("DeviceKey", wintypes.WCHAR * 128),
    ]


class DEVMODEW(ctypes.Structure):
    _fields_ = [
        ("dmDeviceName", wintypes.WCHAR * 32),
        ("dmSpecVersion", wintypes.WORD),
        ("dmDriverVersion", wintypes.WORD),
        ("dmSize", wintypes.WORD),
        ("dmDriverExtra", wintypes.WORD),
        ("dmFields", wintypes.DWORD),
        ("dmPositionX", ctypes.c_long),
        ("dmPositionY", ctypes.c_long),
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

    @property
    def pos(self) -> tuple[int, int]:
        return (self.dmPositionX, self.dmPositionY)


VIRTUAL_HINTS = ("virtual", "indirect", "idd", "vdd", "mtt")


def _user32():
    return ctypes.windll.user32


def list_devices() -> list[dict]:
    """枚举全部显示适配器。返回 dict 列表，含是否已接桌面、是否虚拟、当前模式。"""
    u = _user32()
    out: list[dict] = []
    i = 0
    while True:
        dd = DISPLAY_DEVICEW()
        dd.cb = ctypes.sizeof(DISPLAY_DEVICEW)
        if not u.EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):
            break
        i += 1
        name = str(dd.DeviceName)
        desc = str(dd.DeviceString)
        lower = desc.lower()
        attached = bool(dd.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)
        primary = bool(dd.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE)

        dm = DEVMODEW()
        dm.dmSize = ctypes.sizeof(DEVMODEW)
        modes: list[str] = []
        cur = None
        if u.EnumDisplaySettingsW(name, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
            cur = (int(dm.dmPelsWidth), int(dm.dmPelsHeight), int(dm.dmDisplayFrequency))
        # 收集全部模式（未接桌面的设备也能枚举）
        m = DEVMODEW()
        for idx in range(200):
            m.dmSize = ctypes.sizeof(DEVMODEW)
            if not u.EnumDisplaySettingsW(name, idx, ctypes.byref(m)):
                break
            modes.append(f"{int(m.dmPelsWidth)}x{int(m.dmPelsHeight)}@{int(m.dmDisplayFrequency)}")

        out.append({
            "device": name,
            "description": desc,
            "attached": attached,
            "primary": primary,
            "state_flags": f"0x{dd.StateFlags:08X}",
            "looks_virtual": any(h in lower for h in VIRTUAL_HINTS),
            "current": cur,
            "modes": sorted(set(modes)),
            "mode_count": len(set(modes)),
        })
    return out


def primary_rect() -> tuple[int, int, int, int]:
    """主屏的 (x, y, width, height)。用 DPI-aware 视角读，避免 150% 缩放下的假数字。"""
    u = _user32()
    try:
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    except Exception:  # noqa: BLE001
        pass
    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    if u.EnumDisplaySettingsW(r"\\.\DISPLAY1", ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
        return (int(dm.dmPositionX), int(dm.dmPositionY),
                int(dm.dmPelsWidth), int(dm.dmPelsHeight))
    return (0, 0, int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1)))


def activate(device: str, width: int, height: int, refresh: int,
             x: int, y: int, *, commit: bool = True) -> dict:
    """把 device 挂到桌面（放在 (x, y)，尺寸 width×height）。"""
    u = _user32()
    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    dm.dmPelsWidth = width
    dm.dmPelsHeight = height
    dm.dmDisplayFrequency = refresh
    dm.dmPositionX = x
    dm.dmPositionY = y
    # DM_POSITION 是关键：少了它，调用成功但设备不挂到桌面。
    dm.dmFields = (DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY)

    rc1 = u.ChangeDisplaySettingsExW(
        device, ctypes.byref(dm), None,
        CDS_UPDATEREGISTRY | CDS_NORESET, None)

    result = {"device": device, "rc_per_device": int(rc1),
              "fields_used": f"0x{dm.dmFields:X}",
              "position": (x, y), "size": (width, height), "refresh": refresh}

    if rc1 != DISP_CHANGE_SUCCESSFUL:
        result["ok"] = False
        result["why"] = f"ChangeDisplaySettingsEx(device) rc={rc1}"
        return result

    if not commit:
        result["ok"] = True
        result["committed"] = False
        return result

    # 第二条：全局应用（NULL 参数），把 NORESET 的改动真正生效。
    rc2 = u.ChangeDisplaySettingsExW(None, None, None, 0, None)
    result["rc_commit"] = int(rc2)
    result["committed"] = True
    result["ok"] = (rc2 == DISP_CHANGE_SUCCESSFUL)
    if not result["ok"]:
        result["why"] = f"ChangeDisplaySettingsEx(NULL) rc={rc2}"
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="只列出适配器，不动系统")
    ap.add_argument("--dry-run", action="store_true", help="说明会怎么做，不调用")
    ap.add_argument("--device", help="指定设备名（默认自动选第一个未接桌面的虚拟屏）")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--refresh", type=int, default=60)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if os.name != "nt":
        print("not windows")
        return 2

    devices = list_devices()

    if args.list or args.json:
        if args.json:
            print(json.dumps(devices, ensure_ascii=False, indent=2))
        else:
            for d in devices:
                tags = []
                if d["attached"]:
                    tags.append("attached")
                if d["primary"]:
                    tags.append("primary")
                if d["looks_virtual"]:
                    tags.append("virtual")
                cur = d["current"]
                cur_text = f"{cur[0]}x{cur[1]}@{cur[2]}" if cur else "(no current mode)"
                print(f"  {d['device']:<16} {d['description'][:34]:<34} "
                      f"{cur_text:<16} {','.join(tags)}")
                if d["looks_virtual"] and not d["attached"]:
                    print(f"      modes={d['mode_count']}  {d['modes'][:3]}")
        return 0

    # 选目标：显式指定，或第一个「虚拟且未接桌面」的
    target = None
    if args.device:
        target = next((d for d in devices if d["device"].lower() == args.device.lower()), None)
        if not target:
            print(f"ERROR 找不到设备 {args.device}")
            return 2
    else:
        cands = [d for d in devices if d["looks_virtual"] and not d["attached"]]
        if not cands:
            print("没有「未接桌面的虚拟屏」可激活。")
            print("若这是第一次装驱动，可能设备还没枚举出来；或已经接上了。")
            return 2
        # Prefer candidates that actually enumerate a mode. A driver whose device node
        # exists but reports 0 modes cannot be placed anywhere -- this machine has both
        # kinds (Oray/GameViewer report 0, our IDD reports 1), and picking blindly by
        # enumeration order selected the unusable one.
        with_modes = [d for d in cands if d["mode_count"] > 0]
        target = (with_modes or cands)[0]
        if not with_modes:
            print("WARNING : 所有候选都枚举不到模式，接上去大概率失败。")

    px, py, pw, ph = primary_rect()
    want = f"{args.width}x{args.height}@{args.refresh}"
    print(f"target      : {target['device']} ({target['description']})")
    print(f"  current   : {target['current']}")
    print(f"  modes     : {target['mode_count']} -> {target['modes'][:3]}")
    print(f"primary     : {pw}x{ph} at ({px},{py})")
    print(f"plan        : place at ({px + pw}, {py}), size {want}, "
          f"dmFields=DM_POSITION|DM_PELSWIDTH|DM_PELSHEIGHT|DM_DISPLAYFREQUENCY")

    if want not in target["modes"]:
        print(f"WARNING     : 该设备枚举不到 {want}。真正接上后可能被驱动改成最接近的模式。")

    if args.dry_run:
        print("result      : dry-run, 未调用 ChangeDisplaySettingsEx")
        return 0

    res = activate(target["device"], args.width, args.height, args.refresh,
                   px + pw, py)
    print(f"result      : {json.dumps(res, ensure_ascii=False)}")

    # 读回验证：接通后 StateFlags 应出现 0x1（ATTACHED_TO_DESKTOP）
    print()
    print("=== 读回验证 ===")
    after = list_devices()
    hit = next((d for d in after if d["device"].lower() == target["device"].lower()), None)
    if hit:
        print(f"  {hit['device']}  attached={hit['attached']}  "
              f"state_flags={hit['state_flags']}  current={hit['current']}")
        if hit["attached"]:
            print("  PASS：已接桌面")
            return 0
        print("  FAIL：仍是未接桌面（StateFlags 无 0x1）")
        return 3
    print("  读回时找不到该设备了")
    return 3


if __name__ == "__main__":
    sys.exit(main())
