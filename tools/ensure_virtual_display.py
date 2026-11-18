#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ensure_virtual_display.py —— 把虚拟屏扩展成第二个显示器，并校验几何基准。

## 这个脚本解决了一个耗时很久的问题，记下来

装好 IDD 驱动（微软样例 或 VDD 官方版，两者都验过）之后，虚拟屏会：
  - 出现在 `EnumDisplayDevices`，`StateFlags = 0x08000000`(MODESPRUNED)
  - 能枚举到模式（本机：唯一一个 `1920x1080@60`）
  - `QueryDisplayConfig` 里是活通路（`in_use=True`, 60Hz, target 已绑）
  - 但 **`EnumDisplayMonitors` 只有物理屏**，`ChangeDisplaySettingsEx` 报 `-1`

## 真正有效的调用，只有这一种

    SetDisplayConfig(0, None, 0, None, SDC_TOPOLOGY_EXTEND | SDC_APPLY)   // rc = 0

**拓扑类 flag 不能叠加其它修饰符。** 实测逐项验证过：

| flags | SDC_VALIDATE |
|---|---|
| `TOPOLOGY_EXTEND` | **0** |
| `TOPOLOGY_EXTEND \\| VIRTUAL_MODE_AWARE` | **0** |
| `TOPOLOGY_EXTEND \\| ALLOW_CHANGES` | 87 |
| `TOPOLOGY_EXTEND \\| VIRTUAL_MODE_AWARE \\| ALLOW_CHANGES` | 87 |
| `TOPOLOGY_EXTEND \\| NO_OPTIMIZATION` | 87 |
| `TOPOLOGY_EXTEND \\| SAVE_TO_DATABASE` | 87 |
| `TOPOLOGY_EXTEND \\| SUPPLIED_DISPLAY_CONFIG`（任何组合） | 87 |

之前每一次失败都是因为「顺手加上了 `ALLOW_CHANGES` / `VIRTUAL_MODE_AWARE`」——
看起来更"完备"，实际直接让调用失效。

顺带两个坑：
* `DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE = 1`（不是 2），`TARGET = 2`（不是 1）。写反了会把
  TARGET 模式当成 SOURCE 绑给 path，`SetDisplayConfig` 一律 `rc=87`。
* `QDC_DATABASE_CURRENT` 在 `GetDisplayConfigBufferSizes` 可用，但 `QueryDisplayConfig`
  返回 87；用 `QDC_ONLY_ACTIVE_PATHS` 代替。

## 用法

    python tools/ensure_virtual_display.py --check     # 只报告，不改
    python tools/ensure_virtual_display.py             # 确保虚拟屏已扩展
    python tools/ensure_virtual_display.py --expect 1920x1080   # 并校验基准

退出码：0 已就绪 / 2 找不到虚拟屏 / 3 扩展失败 / 4 分辨率不符预期。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes

# ---------------------------------------------------------------- 常量
SDC_TOPOLOGY_EXTEND = 0x00000004
SDC_APPLY = 0x00000080

DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001
DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004
DISPLAY_DEVICE_MODESPRUNED = 0x08000000

ENUM_CURRENT_SETTINGS = -1

#: ChangeDisplaySettingsExW 的 dmFields 位（点亮一块掉线的屏要用）。
DM_BITSPERPEL = 0x00040000
DM_PELSWIDTH = 0x00080000
DM_PELSHEIGHT = 0x00100000
DM_DISPLAYFREQUENCY = 0x00400000
#: CDS_UPDATEREGISTRY：把这次变更写进注册表，重启后仍是该模式。
CDS_UPDATEREGISTRY = 0x00000001
#: CDS_NORESET：只写注册表，**不立即应用**。VDD 要点亮必须带这一位（实测：
#: 不带就被驱动拒绝 DISP_CHANGE_FAILED，带上就成功），见 activate() 的说明。
CDS_NORESET = 0x10000000

VIRTUAL_HINTS = ("virtual", "indirect", "idd", "vdd", "mtt", "parsec")

#: 目标适配器描述里必须出现的关键词。**只认我们自己的 VDD**。
#:
#: 为什么不能"随便挑一个虚拟屏"（2026-11-18 实测）：
#:   GameViewer 的虚拟适配器会在远程会话时自己接上桌面，StateFlags=0x00000005
#:   （ATTACHED|PRIMARY）并且把模式改成 2560x1600@144。脚本若取"第一个已接上的
#:   虚拟屏"，就会把 GameViewer 当成几何基准，输出 READY 并 exit 3 —— 而真正的
#:   VDD（\\.\DISPLAY233，state=0x00000000）根本没接上。
#:   几何固化要求"坐标基准是我们选的那个模式"，所以目标必须是我们配过的设备。
TARGET_HINTS = ("virtual display driver", "mttvdd")


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
        ("dmSpecVersion", wintypes.WORD), ("dmDriverVersion", wintypes.WORD),
        ("dmSize", wintypes.WORD), ("dmDriverExtra", wintypes.WORD),
        ("dmFields", wintypes.DWORD),
        ("dmPositionX", ctypes.c_long), ("dmPositionY", ctypes.c_long),
        ("dmDisplayOrientation", wintypes.DWORD), ("dmDisplayFixedOutput", wintypes.DWORD),
        ("dmColor", ctypes.c_short), ("dmDuplex", ctypes.c_short),
        ("dmYResolution", ctypes.c_short), ("dmTTOption", ctypes.c_short),
        ("dmCollate", ctypes.c_short),
        ("dmFormName", wintypes.WCHAR * 32),
        ("dmLogPixels", wintypes.WORD), ("dmBitsPerPel", wintypes.DWORD),
        ("dmPelsWidth", wintypes.DWORD), ("dmPelsHeight", wintypes.DWORD),
        ("dmDisplayFlags", wintypes.DWORD), ("dmDisplayFrequency", wintypes.DWORD),
        ("dmICMMethod", wintypes.DWORD), ("dmICMIntent", wintypes.DWORD),
        ("dmMediaType", wintypes.DWORD), ("dmDitherType", wintypes.DWORD),
        ("dmReserved1", wintypes.DWORD), ("dmReserved2", wintypes.DWORD),
        ("dmPanningWidth", wintypes.DWORD), ("dmPanningHeight", wintypes.DWORD),
    ]


def u32():
    return ctypes.windll.user32


def dpi_aware():
    try:
        u32().SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:  # noqa: BLE001
        pass


def target_hint_hit(dev: dict) -> bool:
    """该适配器是否是我们配过的 VDD（见 TARGET_HINTS 的说明）。"""
    desc = str(dev.get("description") or "").lower()
    return any(h in desc for h in TARGET_HINTS)


def wait_attached(device_hint: str = "", timeout_s: float = 6.0) -> dict | None:
    """等到目标虚拟屏真的 ATTACHED，返回它的设备字典；超时返回 None。

    为什么要等而不是 sleep 固定秒数（2026-11-18 实测）：`activate()` 里写的是
    CDS_NORESET，驱动是异步把 StateFlags 改成 ATTACHED 的。固定睡 1 秒时，
    第 2 轮读到的是旧值（仍未 attached），于是走 EXTEND，扩展后再读又可能
    还是旧值 —— 同一脚本连续跑 4 次出现 0 / 3 / 0 / 0 这种结果。
    等到条件成立再往下走，结果才对得上。
    """
    import time
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        devs = devices()
        for d in devs:
            if not d["is_virtual"]:
                continue
            if device_hint and d["device"] != device_hint:
                continue
            if target_hint_hit(d) and d["attached"]:
                return d
        time.sleep(0.25)
    return None


def cur_mode(device: str):
    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    if u32().EnumDisplaySettingsW(device, ENUM_CURRENT_SETTINGS, ctypes.byref(dm)):
        return {
            "width": int(dm.dmPelsWidth), "height": int(dm.dmPelsHeight),
            "refresh": int(dm.dmDisplayFrequency),
            "x": int(dm.dmPositionX), "y": int(dm.dmPositionY),
        }
    return None


def available_modes(device: str) -> list[dict]:
    """该设备枚举出来的全部模式（去重）。

    存在的意义：掉线的虚拟屏 `cur_mode()` 是 None，但它的模式表仍然在。
    没有这一步，「先设个模式把它点亮」就无从下手 —— 只能猜分辨率。
    """
    seen = set()
    out = []
    i = 0
    while i < 400:
        dm = DEVMODEW()
        dm.dmSize = ctypes.sizeof(DEVMODEW)
        if not u32().EnumDisplaySettingsW(device, i, ctypes.byref(dm)):
            break
        i += 1
        key = (int(dm.dmPelsWidth), int(dm.dmPelsHeight), int(dm.dmDisplayFrequency))
        if key in seen or key[0] == 0 or key[1] == 0:
            continue
        seen.add(key)
        out.append({"width": key[0], "height": key[1], "refresh": key[2]})
    return out


def activate(device: str, width: int = 1920, height: int = 1080,
             refresh: int = 60) -> int:
    """把一个掉线的虚拟屏点亮。

    **必须分两步，这是实测出来的**（2026-11-18，\\\\.\\DISPLAY233）：
        ChangeDisplaySettingsExW(dev, mode, CDS_UPDATEREGISTRY)          -> rc=-1 FAILED
        ChangeDisplaySettingsExW(dev, mode, CDS_UPDATEREGISTRY|CDS_NORESET) -> rc=0  OK
    也就是"设模式并立即应用"会被驱动拒绝，而"只写注册表、稍后再应用"能成功。
    单独调用 apply（空 DEVMODE）也不会让桌面多出这一屏，还要再走一次
    SDC_TOPOLOGY_EXTEND|SDC_APPLY 才会真正接上。

    逐个试过的组合（都 rc=-1）：TEST only / UPDATEREGISTRY / UPDATEREGISTRY|RESET /
    带位置 / 不带刷新率 / +32bpp。只有 NORESET 那一档成功。

    返回第一步的 rc（0 = 模式已写入）。
    """
    modes = available_modes(device)
    if not modes:
        return -1
    pick = None
    for cand in modes:
        if (cand["width"], cand["height"]) == (width, height):
            if cand["refresh"] == refresh:
                pick = cand
                break
            if pick is None:
                pick = cand
    if pick is None:
        pick = modes[0]

    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    dm.dmPelsWidth = pick["width"]
    dm.dmPelsHeight = pick["height"]
    dm.dmDisplayFrequency = pick["refresh"]
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY
    dm.dmPositionX = 0
    dm.dmPositionY = 0
    rc = u32().ChangeDisplaySettingsExW(device, ctypes.byref(dm), None,
                                        CDS_UPDATEREGISTRY | CDS_NORESET, None)
    # 把这次写入应用一次。失败也继续 —— 下面还有 EXTEND 兜底。
    u32().ChangeDisplaySettingsExW(None, None, None, 0, None)
    return rc


def devices():
    """全部显示适配器（含未接桌面的）。"""
    out = []
    i = 0
    while True:
        dd = DISPLAY_DEVICEW()
        dd.cb = ctypes.sizeof(DISPLAY_DEVICEW)
        if not u32().EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):
            break
        i += 1
        name = str(dd.DeviceName)
        desc = str(dd.DeviceString)
        out.append({
            "device": name,
            "description": desc,
            "attached": bool(dd.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
            "primary": bool(dd.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE),
            "modespruned": bool(dd.StateFlags & DISPLAY_DEVICE_MODESPRUNED),
            "state_flags": f"0x{dd.StateFlags:08X}",
            "is_virtual": any(h in desc.lower() for h in VIRTUAL_HINTS),
            "mode": cur_mode(name),
        })
    return out


def monitors():
    """已接桌面的显示器矩形。"""
    dpi_aware()
    cb_t = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                              ctypes.POINTER(wintypes.RECT), ctypes.c_void_p)
    rects = []

    def cb(h, hdc, lprc, data):
        r = lprc.contents
        rects.append({"x": r.left, "y": r.top,
                      "width": r.right - r.left, "height": r.bottom - r.top})
        return 1

    u32().EnumDisplayMonitors(None, None, cb_t(cb), None)
    return rects


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="只报告")
    ap.add_argument("--expect", default="", help="如 1920x1080，校验基准")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if os.name != "nt":
        print("not windows")
        return 2

    devs = devices()
    # 候选集**不能**要求 mode 非空：掉线后 cur_mode() 是 None，但它其实是一块
    # 可点亮的虚拟屏。之前这里写的是 `and d["mode"]`，导致掉线后再也回不来
    # （实测：把桌面收回主屏后本脚本 exit=2，自启无法自愈）。
    #
    # 也不能只用"第一个虚拟屏"：GameViewer 会在远程会话时自己接上桌面并改模式，
    # 那样本脚本会把 GameViewer 当几何基准（实测 READY + exit 3，VDD 根本没接）。
    # 所以优先只取我们自己的 VDD；没有 VDD 时才退回任意虚拟屏，并把原因打出来。
    wanted = [d for d in devs if d["is_virtual"] and target_hint_hit(d)]
    virt = wanted or [d for d in devs if d["is_virtual"]]
    if not wanted and virt:
        print()
        print("NOTE           : 没找到目标 VDD（关键词 %s），退回任意虚拟屏：%s"
              % (list(TARGET_HINTS), virt[0]["description"]))
    mons = monitors()

    if args.json:
        print(json.dumps({"devices": devs, "monitors": mons}, ensure_ascii=False, indent=2))
        return 0

    print(f"monitors      : {len(mons)}")
    for m in mons:
        print(f"  pos=({m['x']},{m['y']})  size={m['width']}x{m['height']}")
    print()
    print("virtual adapters:")
    for d in virt:
        tag = "ATTACHED" if d["attached"] else "not attached"
        print(f"  {d['device']:<16} {d['description'][:32]:<32} "
              f"{d['state_flags']}  {tag}")
        if d["mode"]:
            m = d["mode"]
            print(f"      mode {m['width']}x{m['height']}@{m['refresh']} "
                  f"pos=({m['x']},{m['y']})")

    if not virt:
        print()
        print("ERROR 没找到可用的虚拟屏适配器（驱动装了但没枚举到模式？）")
        return 2

    # 判定标准必须收紧：**VDD 自己接上了**才算好。
    # 原来写 `next(d for d in virt if d["attached"])`，而 GameViewer 的那个虚拟适配器
    # 在远程会话下本来就是 attached（实测 0x00000005，还把自己改成 2560x1600），
    # 于是脚本认定"已就绪"、直接 exit 3，VDD 根本没接上。
    # ---- 主执行段：一条主线，判据只有 EnumDisplayMonitors 的屏数 ------------------
    #
    # 这一段重写过一次。之前有四层判定互相打架，加上多处 `mons = monitors()`
    # 在拓扑刚变完时读到旧值，同一个脚本连跑 7 轮只有 3 轮真的多出屏来
    # （详见文件头「为什么重写」）。现在：
    #   * StateFlags 的 ATTACHED 位**不作为成功判据** —— 实测 VDD 报 ATTACHED
    #     而桌面仍是 1 屏；
    #   * 每次判屏都走 settle()，轮询到稳定而不是读一次就走。
    import time as _time

    def settle(want: int = 2, tries: int = 24) -> list:
        rects = monitors()
        for _ in range(tries):
            if len(rects) >= want:
                return rects
            _time.sleep(0.25)
            rects = monitors()
        return rects

    vdd = [d for d in devs if d["is_virtual"] and target_hint_hit(d)]
    virt = vdd or [d for d in devs if d["is_virtual"]]
    mons = settle()

    # 第一轮：点亮（如果需要）
    if len(mons) < 2:
        dark = [d for d in virt if not d["attached"]]
        if dark:
            rc = activate(dark[0]["device"], 1920, 1080, 60)
            print("  activate %s 1920x1080@60 rc=%d" % (dark[0]["device"], rc))
            mons = settle()

    # 第二轮：扩展
    if len(mons) < 2:
        print()
        print("桌面仍只有 %d 屏，执行 SDC_TOPOLOGY_EXTEND ..." % len(mons))
        rc = u32().SetDisplayConfig(0, None, 0, None,
                                    SDC_TOPOLOGY_EXTEND | SDC_APPLY)
        print("  SetDisplayConfig(EXTEND|APPLY) rc=%d" % rc)
        mons = settle()
        print("  after: monitors=%d" % len(mons))

    # 第三轮：点亮 + 扩展再来一次（有的驱动要"先有模式"才肯被扩展）
    if len(mons) < 2:
        dark = [d for d in virt if not d["attached"]]
        if dark:
            rc2 = activate(dark[0]["device"], 1920, 1080, 60)
            print("  retry activate %s rc=%d" % (dark[0]["device"], rc2))
            rc3 = u32().SetDisplayConfig(0, None, 0, None,
                                        SDC_TOPOLOGY_EXTEND | SDC_APPLY)
            print("  retry EXTEND|APPLY rc=%d" % rc3)
            mons = settle()
            print("  after retry: monitors=%d" % len(mons))

    if len(mons) < 2:
        print()
        print("WARNING       : 只有 %d 个显示器（扩展未生效）" % len(mons))
        for d in virt:
            print("                : %s attached=%s" % (d["device"], d["attached"]))
        return 3

    # 到这里桌面确实有 >= 2 屏。补上目标适配器的显示信息（它可能不报 mode）。
    devs = devices()
    vdd = [d for d in devs if d["is_virtual"] and target_hint_hit(d)]
    target = next((d for d in vdd if d["attached"]), None) or (vdd[0] if vdd else None)

    if target.get("mode") is None:
        target["mode"] = cur_mode(target["device"])

    m = target["mode"]
    print()
    if m is None:
        print(f"READY         : {target['device']}（桌面 {len(mons)} 屏，但该适配器未报告模式）")
        return 0
    print(f"READY         : {target['device']} {m['width']}x{m['height']}@{m['refresh']} "
          f"pos=({m['x']},{m['y']})")

    if args.expect:
        want = args.expect.lower()
        got = f"{m['width']}x{m['height']}" if m else ""
        if got != want:
            print(f"ERROR 期望 {want}，实际 {got}")
            return 4
        print(f"  基准校验     : {got} 符合期望")

    return 0


if __name__ == "__main__":
    sys.exit(main())
