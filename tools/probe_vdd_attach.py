#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_vdd_attach.py —— 用 SDC_VALIDATE 穷举 SetDisplayConfig 组合，找能挂上桌面的那个。

## 为什么先 VALIDATE

`SetDisplayConfig` 的第 5 个参数里加 `SDC_VALIDATE` 时，函数**只校验、不应用**。
前面 7 次尝试每次都是直接 `SDC_APPLY`，屏幕闪一下、失败、再猜下一个 —— 又慢又危险。
这里先用 VALIDATE 把几十种 flag/path/mode 组合筛一遍，只把校验通过的那个真正应用。

## 关键假设（来自查到的资料）

RustDesk #16422 给的方案是：

    SetDisplayConfig(supplied, virtual-mode-aware config
                     that gives the new target its own source rectangle,
                     SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE
                     | SDC_ALLOW_CHANGES | SDC_APPLY)

**"gives the new target its own source rectangle"** 是重点：光把现有配置原样回传
不够，必须让虚拟屏那条 path 指向一个真实的 SOURCE_MODE（宽高 + 桌面位置）。

## 本脚本的候选策略

  S1 原样回传（已试过，rc=0 但无变化），作为基线
  S2 给虚拟 path 绑定**现有**的 SOURCE_MODE（低 16 位写下标，保留高位 clone group）
  S3 同 S2，但低 16 位写纯下标（不保留 clone group）
  S4 **构造**一个新的 SOURCE_MODE（1920x1080 @ 主屏右侧），追加进 mode 数组后绑定
  S5 构造新 SOURCE_MODE + 同时构造 DESKTOP_IMAGE_INFO
  S6 SDC_TOPOLOGY_EXTEND（带/不带 VIRTUAL_MODE_AWARE）

每个候选先用 SDC_VALIDATE 试，只应用第一个校验通过的。

## 用法

    python tools/probe_vdd_attach.py --diagnose        # 只打印现状
    python tools/probe_vdd_attach.py --validate-all    # 穷举校验，不动屏幕
    python tools/probe_vdd_attach.py --apply           # 校验后应用第一个通过的
"""
from __future__ import annotations

import argparse
import ctypes
import os
import sys
from ctypes import wintypes

# ------------------------------------------------------------------ CCD 常量
QDC_ONLY_ACTIVE_PATHS = 0x00000002
QDC_ALL_PATHS = 0x00000001
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
SDC_FORCE_MODE_ENUMERATION = 0x00001000
SDC_ALLOW_PATH_ORDER_CHANGES = 0x00002000
SDC_VIRTUAL_MODE_AWARE = 0x00008000
SDC_VIRTUAL_REFRESH_RATE_AWARE = 0x00020000

# winuser.h: DISPLAYCONFIG_MODE_INFO_TYPE
#   SOURCE = 1, TARGET = 2, DESKTOP_IMAGE = 3
# 一开始写反成 TARGET=1/SOURCE=2，于是把 TARGET 模式当成 SOURCE 绑给 path，
# 校验必然 rc=87。这正好说明先用 SDC_VALIDATE 穷举、最后才 APPLY 是对的：
# bug 在屏幕一次都没闪的情况下就被抓到了。
MODE_TYPE_SOURCE = 1
MODE_TYPE_TARGET = 2
MODE_TYPE_DESKTOP = 3
PIXELFORMAT_32BPP = 4
MODE_IDX_INVALID = 0xFFFF


# ------------------------------------------------------------------ 结构
class LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", ctypes.c_long)]

    def key(self):
        return (int(self.HighPart), int(self.LowPart))


class PATH_SOURCE(ctypes.Structure):
    _fields_ = [("adapterId", LUID), ("id", wintypes.UINT),
                ("modeInfoIdx", wintypes.UINT), ("statusFlags", wintypes.UINT)]


class RATIONAL(ctypes.Structure):
    _fields_ = [("Numerator", wintypes.UINT), ("Denominator", wintypes.UINT)]


class PATH_TARGET(ctypes.Structure):
    _fields_ = [("adapterId", LUID), ("id", wintypes.UINT), ("modeInfoIdx", wintypes.UINT),
                ("outputTechnology", wintypes.UINT), ("rotation", wintypes.UINT),
                ("scaling", wintypes.UINT), ("refreshRate", RATIONAL),
                ("scanLineOrdering", wintypes.UINT), ("targetAvailable", wintypes.BOOL),
                ("statusFlags", wintypes.UINT)]


class PATH_INFO(ctypes.Structure):
    _fields_ = [("sourceInfo", PATH_SOURCE), ("targetInfo", PATH_TARGET),
                ("flags", wintypes.UINT)]


class MODE_INFO(ctypes.Structure):
    """4(infoType) + 4(id) + 8(adapterId) + 48(union) = 64"""

    _fields_ = [("infoType", wintypes.UINT), ("id", wintypes.UINT),
                ("adapterId", LUID), ("blob", ctypes.c_byte * 48)]

    def source_mode(self):
        """按 DISPLAYCONFIG_SOURCE_MODE 解读 blob：width, height, pixelFormat, POINTL。"""
        b = bytes(self.blob)
        w = int.from_bytes(b[0:4], "little")
        h = int.from_bytes(b[4:8], "little")
        pf = int.from_bytes(b[8:12], "little")
        x = int.from_bytes(b[12:16], "little", signed=True)
        y = int.from_bytes(b[16:20], "little", signed=True)
        return w, h, pf, x, y

    def set_source_mode(self, w, h, pf, x, y):
        b = bytearray(48)
        b[0:4] = int(w).to_bytes(4, "little")
        b[4:8] = int(h).to_bytes(4, "little")
        b[8:12] = int(pf).to_bytes(4, "little")
        b[12:16] = int(x).to_bytes(4, "little", signed=True)
        b[16:20] = int(y).to_bytes(4, "little", signed=True)
        for i, v in enumerate(b):
            self.blob[i] = v - 256 if v > 127 else v


class DEVICE_INFO_HEADER(ctypes.Structure):
    _fields_ = [("type", wintypes.UINT), ("size", wintypes.UINT),
                ("adapterId", LUID), ("id", wintypes.UINT)]


class SOURCE_DEVICE_NAME(ctypes.Structure):
    _fields_ = [("header", DEVICE_INFO_HEADER), ("viewGdiDeviceName", wintypes.WCHAR * 32)]


def u32():
    return ctypes.windll.user32


def query(flags):
    u = u32()
    np = wintypes.UINT(0)
    nm = wintypes.UINT(0)
    rc = u.GetDisplayConfigBufferSizes(flags, ctypes.byref(np), ctypes.byref(nm))
    if rc != 0:
        raise RuntimeError(f"GetDisplayConfigBufferSizes(0x{flags:04X}) rc={rc}")
    paths = (PATH_INFO * max(np.value, 1))()
    modes = (MODE_INFO * max(nm.value, 1))()
    rc = u.QueryDisplayConfig(flags, ctypes.byref(np), paths, ctypes.byref(nm), modes, None)
    if rc != 0:
        raise RuntimeError(f"QueryDisplayConfig(0x{flags:04X}) rc={rc}")
    return paths, np.value, modes, nm.value


def src_name(p):
    u = u32()
    s = SOURCE_DEVICE_NAME()
    s.header.type = 1
    s.header.size = ctypes.sizeof(SOURCE_DEVICE_NAME)
    s.header.adapterId = p.sourceInfo.adapterId
    s.header.id = p.sourceInfo.id
    if u.DisplayConfigGetDeviceInfo(ctypes.byref(s)) == 0:
        return str(s.viewGdiDeviceName)
    return ""


def monitors():
    u = u32()
    try:
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:  # noqa: BLE001
        pass
    cb_t = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                              ctypes.POINTER(wintypes.RECT), ctypes.c_void_p)
    n = [0]

    def cb(a, b, c, d):
        n[0] += 1
        return 1

    u.EnumDisplayMonitors(None, None, cb_t(cb), None)
    return n[0]


def primary_size():
    u = u32()
    try:
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:  # noqa: BLE001
        pass
    return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))


# ------------------------------------------------------------------ 工具
def decode_src(idx):
    idx &= 0xFFFFFFFF
    return (idx >> 16) & 0xFFFF, idx & 0xFFFF


def diagnose():
    paths, n_paths, modes, n_modes = query(QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE)
    print(f"monitors={monitors()}  primary={primary_size()[0]}x{primary_size()[1]}")
    print(f"paths={n_paths} modes={n_modes}")
    print()
    print("=== paths ===")
    for i in range(n_paths):
        p = paths[i]
        cg, mi = decode_src(p.sourceInfo.modeInfoIdx)
        print(f"  [{i}] {src_name(p):<16} flags=0x{p.flags:X}")
        print(f"        source: adapter={p.sourceInfo.adapterId.key()} id={p.sourceInfo.id} "
              f"modeInfoIdx=0x{p.sourceInfo.modeInfoIdx & 0xFFFFFFFF:08X} "
              f"(cloneGroup={cg} modeIdx={mi}{' INVALID' if mi == MODE_IDX_INVALID else ''})")
        tcg, tmi = decode_src(p.targetInfo.modeInfoIdx)
        print(f"        target: adapter={p.targetInfo.adapterId.key()} id={p.targetInfo.id} "
              f"modeInfoIdx=0x{p.targetInfo.modeInfoIdx & 0xFFFFFFFF:08X} "
              f"(tgtIdx={tcg} desktopIdx={tmi})")
    print()
    print("=== modes ===")
    names = {1: "TARGET", 2: "SOURCE", 3: "DESKTOP"}
    for k in range(n_modes):
        m = modes[k]
        t = names.get(m.infoType, "?")
        extra = ""
        if m.infoType == MODE_TYPE_SOURCE:
            w, h, pf, x, y = m.source_mode()
            extra = f"  {w}x{h} fmt={pf} pos=({x},{y})"
        print(f"  [{k}] {t:<8} id={m.id:<6} adapter={m.adapterId.key()}{extra}")
    return paths, n_paths, modes, n_modes


def validate(n_paths, paths, n_modes, modes, flags, label):
    """SDC_VALIDATE：只校验不应用。返回 True/False。"""
    u = u32()
    rc = u.SetDisplayConfig(n_paths, paths, n_modes, modes, flags | SDC_VALIDATE)
    ok = (rc == 0)
    print(f"  {'PASS' if ok else 'fail'}  {label:<58} rc={rc}")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--diagnose", action="store_true")
    ap.add_argument("--validate-all", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--device", default="")
    args = ap.parse_args(argv)

    if os.name != "nt":
        print("not windows")
        return 2

    paths, n_paths, modes, n_modes = diagnose()
    if args.diagnose:
        return 0

    # 找虚拟屏那条 path
    virt_i = None
    for i in range(n_paths):
        nm = src_name(paths[i])
        if args.device and nm.upper().endswith(args.device.upper()):
            virt_i = i
            break
        if not args.device and ("Virtual" in nm or i == n_paths - 1):
            virt_i = i
    if virt_i is None:
        print("\nERROR 找不到虚拟屏 path")
        return 2

    vp = paths[virt_i]
    pw, ph = primary_size()
    vname = src_name(vp)
    print(f"\n虚拟屏 path[{virt_i}] = {vname}")

    # 找一个可以给这条 path 用的 SOURCE_MODE
    exist_src = None
    for k in range(n_modes):
        m = modes[k]
        if m.infoType == MODE_TYPE_SOURCE and m.adapterId.key() == vp.sourceInfo.adapterId.key():
            exist_src = k
            break
    print(f"可复用 SOURCE_MODE: {'mode[' + str(exist_src) + ']' if exist_src is not None else '无'}")

    import copy
    candidates = []

    # S1 原样回传
    candidates.append(("S1 原样回传（基线）",
                        n_paths, copy.deepcopy(paths), n_modes, copy.deepcopy(modes),
                        SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE))

    # S2 保留 clone group，低 16 位写现有 SOURCE 下标
    if exist_src is not None:
        p2 = copy.deepcopy(paths)
        cg, _ = decode_src(p2[virt_i].sourceInfo.modeInfoIdx)
        p2[virt_i].sourceInfo.modeInfoIdx = ((cg & 0xFFFF) << 16) | (exist_src & 0xFFFF)
        candidates.append((f"S2 cloneGroup={cg} modeIdx={exist_src}",
                           n_paths, p2, n_modes, copy.deepcopy(modes),
                           SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE
                           | SDC_ALLOW_CHANGES))

        # S3 纯下标
        p3 = copy.deepcopy(paths)
        p3[virt_i].sourceInfo.modeInfoIdx = exist_src & 0xFFFF
        candidates.append((f"S3 纯下标 modeIdx={exist_src}",
                           n_paths, p3, n_modes, copy.deepcopy(modes),
                           SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE
                           | SDC_ALLOW_CHANGES))

    # S4 构造新的 SOURCE_MODE（1920x1080 放主屏右侧），追加到 mode 数组
    m4 = copy.deepcopy(modes)
    new_mode = MODE_INFO()
    new_mode.infoType = MODE_TYPE_SOURCE
    new_mode.id = vp.sourceInfo.id
    new_mode.adapterId = vp.sourceInfo.adapterId
    new_mode.set_source_mode(1920, 1080, PIXELFORMAT_32BPP, pw, 0)
    arr4 = (MODE_INFO * (n_modes + 1))()
    for k in range(n_modes):
        arr4[k] = m4[k]
    arr4[n_modes] = new_mode
    p4 = copy.deepcopy(paths)
    cg4, _ = decode_src(p4[virt_i].sourceInfo.modeInfoIdx)
    p4[virt_i].sourceInfo.modeInfoIdx = ((cg4 & 0xFFFF) << 16) | (n_modes & 0xFFFF)
    candidates.append((f"S4 构造 SOURCE_MODE(idx={n_modes}) + cloneGroup={cg4}",
                       n_paths, p4, n_modes + 1, arr4,
                       SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE
                       | SDC_ALLOW_CHANGES))

    p5 = copy.deepcopy(paths)
    p5[virt_i].sourceInfo.modeInfoIdx = n_modes & 0xFFFF
    candidates.append((f"S5 构造 SOURCE_MODE(idx={n_modes}) 纯下标",
                       n_paths, p5, n_modes + 1, arr4,  # 同一个 arr4
                       SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE
                       | SDC_ALLOW_CHANGES))

    # 额外 flag 变体（作用于 S4 的数据）
    for extra, tag in ((SDC_SAVE_TO_DATABASE, "+SAVE_TO_DB"),
                       (SDC_NO_OPTIMIZATION, "+NO_OPT"),
                       (SDC_ALLOW_PATH_ORDER_CHANGES, "+ORDER"),
                       (SDC_FORCE_MODE_ENUMERATION, "+FORCE_ENUM")):
        candidates.append((f"S4 {tag}", n_paths, copy.deepcopy(p4), n_modes + 1, arr4,
                           SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_VIRTUAL_MODE_AWARE
                           | SDC_ALLOW_CHANGES | extra))

    print("\n=== SDC_VALIDATE 逐个校验（不改屏幕）===")
    winners = []
    for label, np_, pa, nm_, mo, fl in candidates:
        if validate(np_, pa, nm_, mo, fl, label):
            winners.append((label, np_, pa, nm_, mo, fl))

    # 拓扑类，不需要 paths
    print("\n  --- 拓扑类（paths 全空）---")
    for topo, tag in ((SDC_TOPOLOGY_EXTEND, "TOPOLOGY_EXTEND"),
                      (SDC_TOPOLOGY_EXTEND | SDC_VIRTUAL_MODE_AWARE, "TOPOLOGY_EXTEND|VMA"),
                      (SDC_TOPOLOGY_EXTERNAL, "TOPOLOGY_EXTERNAL"),
                      (SDC_TOPOLOGY_SUPPLIED | SDC_VIRTUAL_MODE_AWARE, "TOPOLOGY_SUPPLIED|VMA")):
        u = u32()
        rc = u.SetDisplayConfig(0, None, 0, None, topo | SDC_VALIDATE)
        ok = rc == 0
        print(f"  {'PASS' if ok else 'fail'}  {tag:<58} rc={rc}")
        if ok:
            winners.append((tag, 0, None, 0, None, topo))

    print()
    if not winners:
        print("所有组合校验都失败 —— 系统拒绝了任何把这些通路变成桌面的方案。")
        return 3

    print(f"校验通过 {len(winners)} 个：")
    for w in winners:
        print(f"   - {w[0]}")

    if not args.apply:
        print("\n（未应用。加 --apply 真正执行第一个通过的组合）")
        return 0

    label, np_, pa, nm_, mo, fl = winners[0]
    before = monitors()
    print(f"\n=== 应用 {label} ===")
    print(f"  应用前 monitors={before}")
    u = u32()
    rc = u.SetDisplayConfig(np_, pa, nm_, mo, fl | SDC_APPLY)
    print(f"  rc={rc}")
    import time
    time.sleep(2)
    after = monitors()
    print(f"  应用后 monitors={after}")
    if after > before:
        print("  PASS: 桌面已扩展")
        return 0
    print("  FAIL: 仍是 1 个显示器")
    return 3


if __name__ == "__main__":
    sys.exit(main())
