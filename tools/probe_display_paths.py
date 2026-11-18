#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_display_paths.py —— 只读查询 Windows 显示拓扑（QueryDisplayConfig）。

## 要回答的问题

`setup_display.ps1` 的设计前提是「选一块虚拟屏 → `ChangeDisplaySettingsEx` 切模式」。
本机实测发现：

    \\\\.\\DISPLAY1   Intel 物理内屏      102 种模式   attached,primary
    \\\\.\\DISPLAY9   OrayIddDriver        0 种模式    （未接桌面）
    \\\\.\\DISPLAY19  GameViewer 虚拟屏     0 种模式    （未接桌面）

未接桌面的适配器**枚举不到任何模式**，`ChangeDisplaySettingsEx` 对它也就无从谈起。
真正的问题因此变成：这些虚拟屏是「驱动存在但通路未启用」（可以用
`SetDisplayConfig` 启用），还是「驱动根本没创建源/目标」（只能靠厂商软件或新装驱动）？

`QueryDisplayConfig` 是只读的，能直接回答：它列出当前**活动和可用**的
source/target 通路。若虚拟屏出现在 target 列表里（带 `DISPLAYCONFIG_TARGET_IN_USE`
以外的标志），说明它已在系统拓扑中、只是没启用。

## 用法

    python tools/probe_display_paths.py
    python tools/probe_display_paths.py --json

退出码：0 读到了；2 读不到。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes

# DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME / GET_TARGET_NAME
QDC_ONLY_ACTIVE_PATHS = 0x00000002
QDC_ALL_PATHS = 0x00000001

# target info flags
SDC_TOPOLOGY_SUPPLIED = 0x10
DISPLAYCONFIG_TARGET_IN_USE = 0x00000001
DISPLAYCONFIG_TARGET_FORCIBLE = 0x00000002


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
    """Union of source/target/desktop mode info; we never read the union body,
    only pass a block of the right size so QueryDisplayConfig is happy."""

    _fields_ = [("infoType", wintypes.UINT), ("id", wintypes.UINT),
                ("adapterId", LUID), ("_pad", ctypes.c_byte * 64)]


class DISPLAYCONFIG_DEVICE_INFO_HEADER(ctypes.Structure):
    _fields_ = [
        ("type", wintypes.UINT),
        ("size", wintypes.UINT),
        ("adapterId", LUID),
        ("id", wintypes.UINT),
    ]


class DISPLAYCONFIG_SOURCE_DEVICE_NAME(ctypes.Structure):
    _fields_ = [
        ("header", DISPLAYCONFIG_DEVICE_INFO_HEADER),
        ("viewGdiDeviceName", wintypes.WCHAR * 32),
    ]


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


GET_SOURCE_NAME = 1
GET_TARGET_NAME = 2


def query(flags: int) -> dict:
    """返回 {'paths': [...], 'modes': n, 'error': str|None}。"""
    user32 = ctypes.windll.user32
    try:
        get_sizes = user32.GetDisplayConfigBufferSizes
        query_cfg = user32.QueryDisplayConfig
    except AttributeError:
        return {"error": "GetDisplayConfigBufferSizes 不存在"}

    num_paths = wintypes.UINT(0)
    num_modes = wintypes.UINT(0)
    rc = get_sizes(flags, ctypes.byref(num_paths), ctypes.byref(num_modes))
    if rc != 0:
        return {"error": f"GetDisplayConfigBufferSizes rc={rc}"}

    paths = (DISPLAYCONFIG_PATH_INFO * max(num_paths.value, 1))()
    modes = (DISPLAYCONFIG_MODE_INFO * max(num_modes.value, 1))()
    rc = query_cfg(flags, ctypes.byref(num_paths), paths,
                    ctypes.byref(num_modes), modes, None)
    if rc != 0:
        return {"error": f"QueryDisplayConfig rc={rc}"}

    out = []
    for i in range(num_paths.value):
        p = paths[i]
        src = p.sourceInfo
        tgt = p.targetInfo

        sname = DISPLAYCONFIG_SOURCE_DEVICE_NAME()
        sname.header.type = GET_SOURCE_NAME
        sname.header.size = ctypes.sizeof(DISPLAYCONFIG_SOURCE_DEVICE_NAME)
        sname.header.adapterId = src.adapterId
        sname.header.id = src.id
        src_name = ""
        if user32.DisplayConfigGetDeviceInfo(ctypes.byref(sname)) == 0:
            src_name = sname.viewGdiDeviceName

        tname = DISPLAYCONFIG_TARGET_DEVICE_NAME()
        tname.header.type = GET_TARGET_NAME
        tname.header.size = ctypes.sizeof(DISPLAYCONFIG_TARGET_DEVICE_NAME)
        tname.header.adapterId = tgt.adapterId
        tname.header.id = tgt.id
        tgt_name = ""
        if user32.DisplayConfigGetDeviceInfo(ctypes.byref(tname)) == 0:
            tgt_name = tname.monitorFriendlyDeviceName

        out.append({
            "source": src_name,
            "target": tgt_name,
            "output_technology": tgt.outputTechnology,
            "available": bool(tgt.targetAvailable),
            "in_use": bool(tgt.statusFlags & DISPLAYCONFIG_TARGET_IN_USE),
            "forcible": bool(tgt.statusFlags & DISPLAYCONFIG_TARGET_FORCIBLE),
            "refresh": (f"{tgt.refreshRate.Numerator}/{tgt.refreshRate.Denominator}"
                        if tgt.refreshRate.Denominator else "?"),
            "path_flags": p.flags,
        })
    return {"paths": out, "modes": num_modes.value, "count": num_paths.value}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    ns = parser.parse_args(argv)
    if os.name != "nt":
        print("not windows")
        return 2

    active = query(QDC_ONLY_ACTIVE_PATHS)
    allp = query(QDC_ALL_PATHS)

    if ns.json:
        print(json.dumps({"active": active, "all": allp}, ensure_ascii=False, indent=2))
        return 0 if "error" not in active else 2

    for label, block in [("active paths (QDC_ONLY_ACTIVE_PATHS)", active),
                         ("all paths (QDC_ALL_PATHS)", allp)]:
        print(f"=== {label} ===")
        if "error" in block:
            print(f"  unreadable: {block['error']}")
            continue
        # Collapse: QDC_ALL_PATHS returns one entry per (source,target,tech) combination,
        # so the raw list repeats sources many times. Group per source.
        per_source: dict[str, dict] = {}
        for p in block["paths"]:
            key = p["source"] or "?"
            slot = per_source.setdefault(key, {
                "path_entries": 0, "in_use": 0, "available": 0,
                "technologies": set(), "refreshes": set(), "targets": set(),
            })
            slot["path_entries"] += 1
            slot["in_use"] += 1 if p["in_use"] else 0
            slot["available"] += 1 if p["available"] else 0
            slot["technologies"].add(p["output_technology"])
            if p["refresh"] != "?":
                slot["refreshes"].add(p["refresh"])
            if p["target"]:
                slot["targets"].add(p["target"])
        print(f"  sources: {len(per_source)}, raw path entries: {block['count']}, "
              f"modes: {block['modes']}")
        for src in sorted(per_source, key=_sort_key):
            s = per_source[src]
            tags = []
            if s["in_use"]:
                tags.append(f"in_use×{s['in_use']}")
            if s["available"]:
                tags.append(f"available×{s['available']}")
            if not tags:
                tags.append("NOT connected")
            tech = sorted(s["technologies"])
            print(f"  {src:<16} entries={s['path_entries']:<4} {', '.join(tags)}"
                  f"  tech={tech}")
            if s["refreshes"]:
                print(f"                   rates={sorted(s['refreshes'])}")
            if s["targets"]:
                print(f"                   targets={sorted(s['targets'])}")
        print()
    return 0 if "error" not in active else 2


def _sort_key(name: str) -> tuple[int, str]:
    digits = "".join(ch for ch in name if ch.isdigit())
    return (int(digits) if digits else 0, name)


if __name__ == "__main__":
    sys.exit(main())
