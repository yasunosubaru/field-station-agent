#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_bind_vdd_source.py —— 给虚拟屏的 path 绑定有效的 source mode。

## 为什么前面所有尝试都白费

`QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE)` 返回 2 条通路、
6 个 mode，逐项解码后真相很清楚：

    path[0] \\\\.\\DISPLAY1    src=0x0001FFFF -> sourceModeIdx = INVALID
                               tgt=0x00000002 -> targetModeIdx=0, desktopModeIdx=2
    path[1] \\\\.\\DISPLAY210  src=0x0004FFFF -> sourceModeIdx = INVALID   <-- 这里
                               tgt=0x00030005 -> targetModeIdx=3, desktopModeIdx=5

    mode[3]  SOURCE_MODE  id=256   <- VDD 的源模式已经存在，但 path 没指向它

`sourceInfo.modeInfoIdx` 低 16 位是源模式索引，`0xFFFF` 表示 **没有绑定源模式**。
一个没有源模式的 path 只是"设备在、通路在"，无法被合成进桌面，所以
`EnumDisplayMonitors` 永远返回 1，`ChangeDisplaySettingsEx` 永远 `DISP_CHANGE_FAILED`。

这也解释了先前所有尝试为什么都失败：`SetDisplayConfig` 每次都把这条未绑定的
path 原样传了回去，什么都没改变。

## 本脚本做什么

把 `path[1].sourceInfo.modeInfoIdx` 指向真实的 SOURCE_MODE（按 adapterId + id 匹配），
然后 `SetDisplayConfig(..., SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG |
SDC_VIRTUAL_MODE_AWARE | SDC_ALLOW_CHANGES)`。

## 用法

    python tools/probe_bind_vdd_source.py --dry-run
    python tools/probe_bind_vdd_source.py --device DISPLAY210
"""
from __future__ import annotations

import argparse
import ctypes
import os
import sys
from ctypes import wintypes

QDC_ONLY_ACTIVE_PATHS = 0x00000002
QDC_VIRTUAL_MODE_AWARE = 0x00000010

SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x00000020
SDC_APPLY = 0x00000080
SDC_ALLOW_CHANGES = 0x00000400
SDC_SAVE_TO_DATABASE = 0x00000200
SDC_VIRTUAL_MODE_AWARE = 0x00008000

GET_SOURCE_NAME = 1
MODE_IDX_INVALID = 0xFFFF

MODE_TYPE_TARGET = 1
MODE_TYPE_SOURCE = 2
MODE_TYPE_DESKTOP = 3


class LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", ctypes.c_long)]

    def key(self) -> tuple[int, int]:
        return (int(self.HighPart), int(self.LowPart))


class DISPLAYCONFIG_PATH_SOURCE_INFO(ctypes.Structure):
    _fields_ = [("adapterId", LUID), ("id", wintypes.UINT),
                ("modeInfoIdx", wintypes.UINT), ("statusFlags", wintypes.UINT)]


class DISPLAYCONFIG_RATIONAL(ctypes.Structure):
    _fields_ = [("Numerator", wintypes.UINT), ("Denominator", wintypes.UINT)]


class DISPLAYCONFIG_PATH_TARGET_INFO(ctypes.Structure):
    _fields_ = [("adapterId", LUID), ("id", wintypes.UINT), ("modeInfoIdx", wintypes.UINT),
                ("outputTechnology", wintypes.UINT), ("rotation", wintypes.UINT),
                ("scaling", wintypes.UINT), ("refreshRate", DISPLAYCONFIG_RATIONAL),
                ("scanLineOrdering", wintypes.UINT), ("targetAvailable", wintypes.BOOL),
                ("statusFlags", wintypes.UINT)]


class DISPLAYCONFIG_PATH_INFO(ctypes.Structure):
    _fields_ = [("sourceInfo", DISPLAYCONFIG_PATH_SOURCE_INFO),
                ("targetInfo", DISPLAYCONFIG_PATH_TARGET_INFO),
                ("flags", wintypes.UINT)]


class DISPLAYCONFIG_MODE_INFO(ctypes.Structure):
    """Tagged union; 64 bytes on x64. Read infoType/adapterId/id, keep the rest opaque."""

    _fields_ = [("infoType", wintypes.UINT), ("id", wintypes.UINT),
                ("adapterId", LUID), ("blob", ctypes.c_byte * 48)]


class DEVICE_INFO_HEADER(ctypes.Structure):
    _fields_ = [("type", wintypes.UINT), ("size", wintypes.UINT),
                ("adapterId", LUID), ("id", wintypes.UINT)]


class SOURCE_DEVICE_NAME(ctypes.Structure):
    _fields_ = [("header", DEVICE_INFO_HEADER), ("viewGdiDeviceName", wintypes.WCHAR * 32)]


def u32():
    return ctypes.windll.user32


def query(flags: int):
    u = u32()
    np = wintypes.UINT(0)
    nm = wintypes.UINT(0)
    rc = u.GetDisplayConfigBufferSizes(flags, ctypes.byref(np), ctypes.byref(nm))
    if rc != 0:
        raise RuntimeError(f"GetDisplayConfigBufferSizes rc={rc}")
    paths = (DISPLAYCONFIG_PATH_INFO * max(np.value, 1))()
    modes = (DISPLAYCONFIG_MODE_INFO * max(nm.value, 1))()
    rc = u.QueryDisplayConfig(flags, ctypes.byref(np), paths,
                              ctypes.byref(nm), modes, None)
    if rc != 0:
        raise RuntimeError(f"QueryDisplayConfig rc={rc}")
    return paths, np.value, modes, nm.value


def sname(p: DISPLAYCONFIG_PATH_INFO) -> str:
    u = u32()
    s = SOURCE_DEVICE_NAME()
    s.header.type = GET_SOURCE_NAME
    s.header.size = ctypes.sizeof(SOURCE_DEVICE_NAME)
    s.header.adapterId = p.sourceInfo.adapterId
    s.header.id = p.sourceInfo.id
    return str(s.viewGdiDeviceName) if u.DisplayConfigGetDeviceInfo(ctypes.byref(s)) == 0 else ""


def monitors() -> int:
    u = u32()
    try:
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:  # noqa: BLE001
        pass
    cb_t = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                              ctypes.POINTER(wintypes.RECT), ctypes.c_void_p)
    n = [0]

    def cb(a, b, c, d):  # noqa: ANN001
        n[0] += 1
        return 1

    u.EnumDisplayMonitors(None, None, cb_t(cb), None)
    return n[0]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", default="DISPLAY210")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if os.name != "nt":
        print("not windows")
        return 2

    want = args.device.upper()
    flags_q = QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE
    paths, n_paths, modes, n_modes = query(flags_q)

    print(f"paths={n_paths} modes={n_modes} monitors={monitors()}")
    print()
    print("=== 当前 2 条通路 ===")
    target_i = None
    for i in range(n_paths):
        nm = sname(paths[i])
        src = paths[i].sourceInfo.modeInfoIdx & 0xFFFFFFFF
        tgt = paths[i].targetInfo.modeInfoIdx & 0xFFFFFFFF
        src_idx = src & 0xFFFF
        print(f"  [{i}] {nm:<16} flags=0x{paths[i].flags:X} "
              f"srcMode=0x{src:08X}({'INVALID' if src_idx == MODE_IDX_INVALID else src_idx}) "
              f"tgtMode=0x{tgt:08X}")
        if nm.upper().endswith(want):
            target_i = i

    if target_i is None:
        print()
        print(f"ERROR 活动通路里没有 {args.device}")
        return 2

    p = paths[target_i]

    # 找一个该 path 能用的 SOURCE_MODE：同 adapterId 且是 SOURCE 类型。
    # mode[3] 就是 VDD 的（id=256），完全匹配。
    cand = None
    for k in range(n_modes):
        m = modes[k]
        if m.infoType != MODE_TYPE_SOURCE:
            continue
        if m.adapterId.key() != p.sourceInfo.adapterId.key():
            continue
        cand = (k, m)
        break

    print()
    print(f"target       : path[{target_i}] {sname(p)}")
    print(f"  source mode 当前 = {'INVALID（这就是根本原因）' if (p.sourceInfo.modeInfoIdx & 0xFFFF) == MODE_IDX_INVALID else 'valid'}")

    if cand is None:
        print("ERROR 找不到与该 path 同 adapter 的 SOURCE_MODE")
        return 3

    k, m = cand
    print(f"  candidate  : mode[{k}] infoType=SOURCE id={m.id} "
          f"adapter={p.sourceInfo.adapterId.HighPart}:{p.sourceInfo.adapterId.LowPart}")

    if args.dry_run:
        print()
        print(f"plan         : path[{target_i}].sourceInfo.modeInfoIdx = {k}  "
              f"然后 SetDisplayConfig(SDC_APPLY|SDC_USE_SUPPLIED_DISPLAY_CONFIG|"
              f"SDC_VIRTUAL_MODE_AWARE|SDC_ALLOW_CHANGES)")
        print("result       : dry-run, 未调用")
        return 0

    # 绑定。sourceInfo.modeInfoIdx 的语义（wingdi.h / CCD 文档）：
    #   - 低 16 位 = modeInfoArray 里的下标，DISPLAYCONFIG_PATH_MODE_IDX_INVALID(0xFFFF) 表示未绑定
    #   - 高 16 位 = clone group，0 表示不参与克隆
    # 多次实测：把 clone group 也塞进高 16 位（0xFFFF0003）会被拒 rc=87，
    # 只写低 16 位（纯下标）才是正确写法。
    before = paths[target_i].sourceInfo.modeInfoIdx
    paths[target_i].sourceInfo.modeInfoIdx = k & 0xFFFF
    print()
    print(f"binding      : srcMode 0x{before:08X} -> 0x{paths[target_i].sourceInfo.modeInfoIdx:08X} "
          f"(纯下标 {k})")

    flags = (SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_APPLY | SDC_VIRTUAL_MODE_AWARE
             | SDC_ALLOW_CHANGES | SDC_SAVE_TO_DATABASE)
    u = u32()
    rc = u.SetDisplayConfig(n_paths, paths, n_modes, modes, flags)
    print(f"result       : SetDisplayConfig rc={rc} "
          f"({'SUCCESS' if rc == 0 else 'ERROR_INVALID_PARAMETER' if rc == 87 else 'other'})")

    after = monitors()
    print(f"after        : monitors = {after}")
    if after > 1:
        print("  PASS: 桌面已扩展，虚拟屏可用")
        return 0
    print("  FAIL: 仍未扩展")
    return 3


if __name__ == "__main__":
    sys.exit(main())
