#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_enable_vdd.py —— 用 SetDisplayConfig 把虚拟屏接上桌面。

## 为什么不用 ChangeDisplaySettingsEx

实测：`ChangeDisplaySettingsEx(device, DEVMODE{DM_POSITION|PELSWIDTH|PELSHEIGHT})`
对虚拟屏（自己的 IDD 与 VDD 官方驱动都一样）返回 `DISP_CHANGE_FAILED (-1)`，
`StateFlags` 停在 `0x08000000`（MODESPRUNED，无 ATTACHED_TO_DESKTOP）。

这说明「设置模式」这一步被驱动层拒绝了：虚拟屏没有物理 render target，
它需要的不是"设一个模式"，而是**在显示拓扑里建立 source->target 通路**。
`ChangeDisplaySettingsEx` 走的是旧的 GDI 路径，对未接通的 target 无能为力。

## 正确 API：SetDisplayConfig

来源：Microsoft sdk-api 文档 + CCD example code
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setdisplayconfig
  https://learn.microsoft.com/en-us/windows-hardware/drivers/display/ccd-example-code

流程：
  1. `GetDisplayConfigBufferSizes(QDC_ALL_PATHS)` 拿缓冲区大小
  2. `QueryDisplayConfig(QDC_ALL_PATHS)` 取**全部**通路（含未激活的）
  3. 找到以目标虚拟屏为 source 的通路
  4. `SetDisplayConfig(paths, modes, SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG |
                       SDC_ALLOW_CHANGES | SDC_VIRTUAL_MODE_AWARE)`

`SDC_VIRTUAL_MODE_AWARE` 是关键：只对虚拟显示有意义，允许用虚拟模式建通路。

## 用法

    python tools/probe_enable_vdd.py --list        # 列出通路，不动系统
    python tools/probe_enable_vdd.py --dry-run     # 说明计划
    python tools/probe_enable_vdd.py --device DISPLAY210

退出码：0 成功；2 找不到目标；3 调用失败。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes

# ---------------------------------------------------------------- 常量
QDC_ONLY_ACTIVE_PATHS = 0x00000002
QDC_ALL_PATHS = 0x00000001
QDC_DATABASE_CURRENT = 0x00000004
QDC_VIRTUAL_MODE_AWARE = 0x00000010
QDC_INCLUDE_HMD = 0x00000020
QDC_VIRTUAL_PATH_AWARE = 0x00000400

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
SDC_FORCE_MODE_ENUMERATION = 0x00001000
SDC_ALLOW_PATH_ORDER_CHANGES = 0x00002000
SDC_VIRTUAL_MODE_AWARE = 0x00008000
SDC_VIRTUAL_REFRESH_RATE_AWARE = 0x00020000

GET_SOURCE_NAME = 1
GET_TARGET_NAME = 2

DISPLAYCONFIG_TARGET_IN_USE = 0x00000001
DISPLAYCONFIG_TARGET_FORCIBLE = 0x00000002
DISPLAYCONFIG_TARGET_IS_HMD = 0x00000020


class LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", ctypes.c_long)]


class DISPLAYCONFIG_PATH_SOURCE_INFO(ctypes.Structure):
    _fields_ = [
        ("adapterId", LUID),
        ("id", wintypes.UINT),
        ("modeInfoIdx", wintypes.UINT),
        ("statusFlags", wintypes.UINT),
    ]


class DISPLAYCONFIG_RATIONAL(ctypes.Structure):
    _fields_ = [("Numerator", wintypes.UINT), ("Denominator", wintypes.UINT)]


class DISPLAYCONFIG_PATH_TARGET_INFO(ctypes.Structure):
    _fields_ = [
        ("adapterId", LUID),
        ("id", wintypes.UINT),
        ("modeInfoIdx", wintypes.UINT),
        ("outputTechnology", wintypes.UINT),
        ("rotation", wintypes.UINT),
        ("scaling", wintypes.UINT),
        ("refreshRate", DISPLAYCONFIG_RATIONAL),
        ("scanLineOrdering", wintypes.UINT),
        ("targetAvailable", wintypes.BOOL),
        ("statusFlags", wintypes.UINT),
    ]


class DISPLAYCONFIG_PATH_INFO(ctypes.Structure):
    _fields_ = [
        ("sourceInfo", DISPLAYCONFIG_PATH_SOURCE_INFO),
        ("targetInfo", DISPLAYCONFIG_PATH_TARGET_INFO),
        ("flags", wintypes.UINT),
    ]


class DISPLAYCONFIG_MODE_INFO(ctypes.Structure):
    """Opaque union placeholder: only its size matters for the API."""

    _fields_ = [("infoType", wintypes.UINT), ("id", wintypes.UINT),
                ("adapterId", LUID), ("_pad", ctypes.c_byte * 64)]


class DISPLAYCONFIG_DEVICE_INFO_HEADER(ctypes.Structure):
    _fields_ = [
        ("type", wintypes.UINT), ("size", wintypes.UINT),
        ("adapterId", LUID), ("id", wintypes.UINT),
    ]


class DISPLAYCONFIG_SOURCE_DEVICE_NAME(ctypes.Structure):
    _fields_ = [("header", DISPLAYCONFIG_DEVICE_INFO_HEADER),
                ("viewGdiDeviceName", wintypes.WCHAR * 32)]


class DISPLAYCONFIG_TARGET_DEVICE_NAME(ctypes.Structure):
    _fields_ = [
        ("header", DISPLAYCONFIG_DEVICE_INFO_HEADER),
        ("flags", wintypes.UINT),
        ("outputTechnology", wintypes.UINT),
        ("edidManufactureId", wintypes.USHORT),
        ("edidProductCodeId", wintypes.USHORT),
        ("connectorInstance", wintypes.UINT),
        ("monitorFriendlyDeviceName", wintypes.WCHAR * 64),
        ("monitorDevicePath", wintypes.WCHAR * 128),
    ]


def query(flags: int) -> dict:
    u = ctypes.windll.user32
    np = wintypes.UINT(0)
    nm = wintypes.UINT(0)
    rc = u.GetDisplayConfigBufferSizes(flags, ctypes.byref(np), ctypes.byref(nm))
    if rc != 0:
        return {"error": f"GetDisplayConfigBufferSizes rc={rc}"}
    paths = (DISPLAYCONFIG_PATH_INFO * max(np.value, 1))()
    modes = (DISPLAYCONFIG_MODE_INFO * max(nm.value, 1))()
    rc = u.QueryDisplayConfig(flags, ctypes.byref(np), paths,
                              ctypes.byref(nm), modes, None)
    if rc != 0:
        return {"error": f"QueryDisplayConfig rc={rc}"}
    return {"paths": paths, "n_paths": np.value, "modes": modes, "n_modes": nm.value}


def names(path: DISPLAYCONFIG_PATH_INFO) -> tuple[str, str]:
    u = ctypes.windll.user32
    s = DISPLAYCONFIG_SOURCE_DEVICE_NAME()
    s.header.type = GET_SOURCE_NAME
    s.header.size = ctypes.sizeof(DISPLAYCONFIG_SOURCE_DEVICE_NAME)
    s.header.adapterId = path.sourceInfo.adapterId
    s.header.id = path.sourceInfo.id
    src = ""
    if u.DisplayConfigGetDeviceInfo(ctypes.byref(s)) == 0:
        src = str(s.viewGdiDeviceName)

    t = DISPLAYCONFIG_TARGET_DEVICE_NAME()
    t.header.type = GET_TARGET_NAME
    t.header.size = ctypes.sizeof(DISPLAYCONFIG_TARGET_DEVICE_NAME)
    t.header.adapterId = path.targetInfo.adapterId
    t.header.id = path.targetInfo.id
    tgt = ""
    if u.DisplayConfigGetDeviceInfo(ctypes.byref(t)) == 0:
        tgt = str(t.monitorFriendlyDeviceName)
    return src, tgt


def list_paths(flags: int) -> list[dict]:
    q = query(flags)
    if "error" in q:
        return [{"error": q["error"]}]
    out = []
    for i in range(q["n_paths"]):
        p = q["paths"][i]
        src, tgt = names(p)
        out.append({
            "index": i,
            "source": src,
            "target": tgt,
            "output_technology": p.targetInfo.outputTechnology,
            "in_use": bool(p.targetInfo.statusFlags & DISPLAYCONFIG_TARGET_IN_USE),
            "available": bool(p.targetInfo.targetAvailable),
            "path_flags": p.flags,
            "source_id": p.sourceInfo.id,
            "target_id": p.targetInfo.id,
        })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--device", default="", help="如 DISPLAY210")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if os.name != "nt":
        print("not windows")
        return 2

    if args.list or args.json or not args.device:
        allp = list_paths(QDC_ALL_PATHS | QDC_VIRTUAL_MODE_AWARE)
        act = list_paths(QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE)
        if args.json:
            print(json.dumps({"all": allp, "active": act}, ensure_ascii=False, indent=2))
            return 0
        print("=== 活动通路 ===")
        for p in act:
            if "error" in p:
                print(f"  error: {p['error']}")
                continue
            print(f"  {p['source']:<16} {p['target'] or '(no name)':<24} "
                  f"in_use={p['in_use']} tech={p['output_technology']}")
        print()
        print("=== 全部通路 ===")
        for p in allp:
            if "error" in p:
                print(f"  error: {p['error']}")
                continue
            print(f"  [{p['index']}] {p['source']:<16} {p['target'] or '(no name)':<24} "
                  f"in_use={p['in_use']} avail={p['available']} tech={p['output_technology']}")
        return 0

    want = args.device
    q = query(QDC_ALL_PATHS | QDC_VIRTUAL_MODE_AWARE)
    if "error" in q:
        print(f"ERROR {q['error']}")
        return 3

    hit = None
    for i in range(q["n_paths"]):
        p = q["paths"][i]
        src, tgt = names(p)
        if src.lower() == want.lower():
            hit = (i, p, src, tgt)
            break

    if not hit:
        print(f"ERROR 在 QDC_ALL_PATHS 里找不到 source={want}")
        print("      该显示当前没有 source->target 通路，SetDisplayConfig 也无从建立。")
        return 2

    i, p, src, tgt = hit
    print(f"found       : path[{i}]  source={src}  target={tgt or '(no name)'}")
    print(f"  in_use    : {bool(p.targetInfo.statusFlags & DISPLAYCONFIG_TARGET_IN_USE)}")
    print(f"  available : {bool(p.targetInfo.targetAvailable)}")
    print(f"  tech      : {p.targetInfo.outputTechnology}")

    flags = (SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES
             | SDC_VIRTUAL_MODE_AWARE | SDC_SAVE_TO_DATABASE
             | SDC_PATH_PERSIST_IF_REQUIRED | SDC_ALLOW_PATH_ORDER_CHANGES)
    print(f"plan        : SetDisplayConfig(1 path, 0 modes, flags=0x{flags:08X})")

    if args.dry_run:
        print("result      : dry-run, 未调用 SetDisplayConfig")
        return 0

    # 只提交这一条通路；模式信息用 INVALID 让 OS 自己挑。
    one = (DISPLAYCONFIG_PATH_INFO * 1)()
    one[0] = p
    one[0].sourceInfo.modeInfoIdx = 0xFFFFFFFF  # DISPLAYCONFIG_PATH_MODE_IDX_INVALID
    one[0].targetInfo.modeInfoIdx = 0xFFFFFFFF

    u = ctypes.windll.user32
    rc = u.SetDisplayConfig(1, one, 0, None, flags)
    print(f"result      : SetDisplayConfig rc={rc}  (0=SUCCESS, 87=INVALID_PARAMETER)")

    # 读回
    act = list_paths(QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE)
    now = [x for x in act if x.get("source", "").lower() == want.lower()]
    if now:
        print(f"  PASS: {want} 现在在活动通路里")
        return 0
    print(f"  FAIL: {want} 仍不在活动通路里")
    return 3


if __name__ == "__main__":
    sys.exit(main())
