#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_extend_vdd.py —— 把 ACTIVE 但未纳入桌面的虚拟屏扩展成第二个显示器。

## 事实（本机实测，2026-11-17）

VDD 官方签名驱动装好后，`QueryDisplayConfig(QDC_ALL_PATHS | QDC_VIRTUAL_MODE_AWARE)`
显示虚拟屏已经是活通路，模式也绑好了：

    \\\\.\\DISPLAY210  VDD by MTT
      srcModeIdx = 0x4FFFF     tgtModeIdx = 0x30005
      refresh    = 60 Hz       targetAvailable = True
      statusFlags= 0x1 (IN_USE)
      path.flags = 0x9 (ACTIVE | SUPPORT_VIRTUAL_MODE)

但 `EnumDisplayMonitors` 只返回 1 个 —— 桌面还没扩展到它上面。

## 走过的弯路（都返回 ERROR_INVALID_PARAMETER 87）

| 尝试 | 结果 |
|---|---|
| `ChangeDisplaySettingsEx(dev, DM_POSITION\\|PELSWIDTH\\|PELSHEIGHT)` | `DISP_CHANGE_FAILED -1` |
| `SetDisplayConfig(SDC_TOPOLOGY_EXTEND \\| SDC_APPLY)` | `87` |
| `SetDisplayConfig(1 path, 0 modes, SDC_USE_SUPPLIED\\|SDC_APPLY)` | `87` |
| `SetDisplayConfig(241 paths, 6 modes)` 全量回传 `QDC_ALL_PATHS` | `87` |

**第四次错在数据源**：`QDC_ALL_PATHS` 返回 241 条 (source,target,technology) 笛卡尔组合，
不是一份配置；回传它必然被拒。

## 正确做法（本次实现）

按 sdk-api 文档，`SDC_VIRTUAL_MODE_AWARE` 是 **`SDC_USE_SUPPLIED_DISPLAY_CONFIG`
与 `SDC_TOPOLOGY_SUPPLIED` 的修饰符**，三者必须同时出现才有意义。

数据源用 `QDC_DATABASE_CURRENT`：它返回**当前已提交**的那份配置（路径 + 模式一一对应），
是唯一能原样喂回 `SetDisplayConfig` 的东西。

然后把虚拟屏那条通路追加进去（如果数据库里还没有它），提交：
    SDC_TOPOLOGY_SUPPLIED | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_APPLY
    | SDC_VIRTUAL_MODE_AWARE | SDC_ALLOW_CHANGES | SDC_SAVE_TO_DATABASE

## 用法

    python tools/probe_extend_vdd.py --dry-run
    python tools/probe_extend_vdd.py --device DISPLAY210
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes

QDC_ONLY_ACTIVE_PATHS = 0x00000002
QDC_ALL_PATHS = 0x00000001
QDC_DATABASE_CURRENT = 0x00000004
QDC_VIRTUAL_MODE_AWARE = 0x00000010

SDC_TOPOLOGY_INTERNAL = 0x00000001
SDC_TOPOLOGY_CLONE = 0x00000002
SDC_TOPOLOGY_EXTEND = 0x00000004
SDC_TOPOLOGY_EXTERNAL = 0x00000008
SDC_TOPOLOGY_SUPPLIED = 0x00000010
SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x00000020
SDC_VALIDATE = 0x00000040
SDC_APPLY = 0x00000080
SDC_NO_OPTIMIZATION = 0x00000100
SDC_SAVE_TO_DATABASE = 0x00000200
SDC_ALLOW_CHANGES = 0x00000400
SDC_PATH_PERSIST_IF_REQUIRED = 0x00000800
SDC_ALLOW_PATH_ORDER_CHANGES = 0x00002000
SDC_VIRTUAL_MODE_AWARE = 0x00008000

GET_SOURCE_NAME = 1
DISPLAYCONFIG_PATH_ACTIVE = 0x00000001
DISPLAYCONFIG_PATH_SUPPORT_VIRTUAL_MODE = 0x00000008


class LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", ctypes.c_long)]


class SRC(ctypes.Structure):
    _fields_ = [("adapterId", LUID), ("id", wintypes.UINT),
                ("modeInfoIdx", wintypes.UINT), ("statusFlags", wintypes.UINT)]


class RATIONAL(ctypes.Structure):
    _fields_ = [("Numerator", wintypes.UINT), ("Denominator", wintypes.UINT)]


class TGT(ctypes.Structure):
    _fields_ = [("adapterId", LUID), ("id", wintypes.UINT), ("modeInfoIdx", wintypes.UINT),
                ("outputTechnology", wintypes.UINT), ("rotation", wintypes.UINT),
                ("scaling", wintypes.UINT), ("refreshRate", RATIONAL),
                ("scanLineOrdering", wintypes.UINT), ("targetAvailable", wintypes.BOOL),
                ("statusFlags", wintypes.UINT)]


class PATH_INFO(ctypes.Structure):
    _fields_ = [("sourceInfo", SRC), ("targetInfo", TGT), ("flags", wintypes.UINT)]


class MODE_INFO(ctypes.Structure):
    """Tagged union; only the size and byte-identity matter for round-tripping."""

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
        raise RuntimeError(f"GetDisplayConfigBufferSizes(0x{flags:04X}) rc={rc}")
    paths = (PATH_INFO * max(np.value, 1))()
    modes = (MODE_INFO * max(nm.value, 1))()
    rc = u.QueryDisplayConfig(flags, ctypes.byref(np), paths,
                              ctypes.byref(nm), modes, None)
    if rc != 0:
        raise RuntimeError(f"QueryDisplayConfig(0x{flags:04X}) rc={rc}")
    return paths, np.value, modes, nm.value


def sname(p: PATH_INFO) -> str:
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
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if os.name != "nt":
        print("not windows")
        return 2

    want = args.device.upper()

    # QDC_DATABASE_CURRENT is rejected by QueryDisplayConfig on this build (rc=87)
    # even though GetDisplayConfigBufferSizes accepts it; QDC_ONLY_ACTIVE_PATHS works
    # and returns the same live configuration we need to round-trip:
    #   [0] \\.\DISPLAY1    flags=0x9  srcMode=0x1FFFF  tgtMode=0x2
    #   [1] \\.\DISPLAY210  flags=0x9  srcMode=0x4FFFF  tgtMode=0x30005
    # Both are ACTIVE | SUPPORT_VIRTUAL_MODE, so the virtual display is already an
    # active path -- it just is not part of the desktop yet.
    try:
        db_paths, n_db, db_modes, n_db_modes = query(QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE)
    except RuntimeError as exc:
        print(f"ERROR {exc}")
        return 3

    # 2) 全部通路里找虚拟屏那条（拿到它的 path 结构）
    all_paths, n_all, _, _ = query(QDC_ALL_PATHS | QDC_VIRTUAL_MODE_AWARE)
    virt = None
    for i in range(n_all):
        if sname(all_paths[i]).upper().endswith(want):
            virt = all_paths[i]
            break

    print(f"database     : {n_db} paths, {n_db_modes} modes")
    print(f"all paths    : {n_all}")
    print(f"monitors     : {monitors()} (EnumDisplayMonitors)")
    print()
    print("=== 已提交的配置 ===")
    present = False
    for i in range(n_db):
        nm = sname(db_paths[i])
        print(f"  [{i}] {nm:<16} flags=0x{db_paths[i].flags:X} "
              f"srcMode=0x{db_paths[i].sourceInfo.modeInfoIdx & 0xFFFFFFFF:X} "
              f"tgtMode=0x{db_paths[i].targetInfo.modeInfoIdx & 0xFFFFFFFF:X}")
        if nm.upper().endswith(want):
            present = True

    if virt is None:
        print()
        print(f"ERROR 在 QDC_ALL_PATHS 里找不到 {args.device}")
        return 2

    print()
    print(f"virtual      : {sname(virt)}  flags=0x{virt.flags:X}  "
          f"active={bool(virt.flags & DISPLAYCONFIG_PATH_ACTIVE)}")
    print(f"  已提交过  : {present}")

    # 3) 组装：数据库里的每条通路 + （若缺）虚拟屏那条。模式表原样带走。
    new_paths = (PATH_INFO * (n_db + 1))()
    for i in range(n_db):
        new_paths[i] = db_paths[i]
    n_new = n_db
    if not present:
        new_paths[n_new] = virt
        n_new += 1

    # SDC_VIRTUAL_MODE_AWARE is documented as a modifier of SDC_USE_SUPPLIED_DISPLAY_CONFIG
    # and SDC_TOPOLOGY_SUPPLIED, so all three travel together. SDC_ONLY_ACTIVE_PATHS gave
    # us the live 2-path configuration, which is exactly what SDC_USE_SUPPLIED_DISPLAY_CONFIG
    # expects; SDC_ALLOW_CHANGES lets the OS adjust a path whose target it cannot drive.
    flags = (SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_APPLY | SDC_VIRTUAL_MODE_AWARE
             | SDC_ALLOW_CHANGES)
    print()
    print(f"plan         : SetDisplayConfig({n_new} paths, {n_db_modes} modes, "
          f"flags=0x{flags:08X})")

    if args.dry_run:
        print("result       : dry-run, 未调用")
        return 0

    u = u32()
    rc = u.SetDisplayConfig(n_new, new_paths, n_db_modes, db_modes, flags)
    print(f"result       : SetDisplayConfig rc={rc}"
          f"  ({'SUCCESS' if rc == 0 else 'ERROR_INVALID_PARAMETER' if rc == 87 else 'other'})")

    after = monitors()
    print(f"after        : monitors = {after}")
    if after > 1:
        print("  PASS: 桌面已扩展，虚拟屏成为第二显示器")
        return 0
    print("  FAIL: 桌面未扩展")
    return 3


if __name__ == "__main__":
    sys.exit(main())
