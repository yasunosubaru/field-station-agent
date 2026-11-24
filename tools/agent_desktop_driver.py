# -*- coding: utf-8 -*-
"""agent-desktop 驱动：用 accessibility ref + --headed 物理输入操作原生对话框。

## 为什么需要它（实测证据，2026-11-24）

原版 Graph 的 Project Folder Select 按钮走 Electron IPC，对话框是主进程的
原生窗口。半个月实测证明：
  - JS click / CDP dispatchMouseEvent 都不弹原生对话框（手势 + 模态父窗口问题）
  - 真鼠标 SetCursorPos 因 window.screenX=0,0 点错窗口
  - 主进程 stub dialog 需要 Playwright launch，但 Graph 的 fuse 拒绝 --inspect

agent-desktop 解决了：
  - 它的 Windows accessibility 适配器**能看到 Electron 网页内容**
    （button Select @ref，推翻"UIA 看不到 Electron"的旧判断）
  - `--headed click` 发物理输入，提供真实用户手势 → 原生对话框弹出
  - 按 ref 操作，不靠屏幕坐标，避开 screenX=0,0

## 关键前提：Windows 前台锁定

OpenChamber（我们自己的对话应用）霸占前台时，SetForegroundWindow(Graph)
返回 False，导致 --headed 失败（"Target window did not become foreground"）。
必须先 AttachThreadInput 绕过前台锁定，把 Graph 提到前台。

## 依赖

agent-desktop（npm 包，需 npm install）。本驱动只调它的 CLI，不改它的代码。
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

# agent-desktop 原生 CLI：优先用仓库自带的那一份（自包含包也带它），
# 再次用环境变量指定的路径。可直接运行，不需要 Node / npm launcher。
# 实测（2026-11-24）单个 exe 隔离运行成功，仅依赖系统 DLL。
_HERE = Path(__file__).resolve().parent
_BUNDLED = _HERE / "agent-desktop" / "agent-desktop.exe"
_CLI = Path(os.environ.get("AGENT_DESKTOP_EXE", str(_BUNDLED)))


def _ad(argv: list[str], timeout: float = 120) -> dict:
    if not _CLI.is_file():
        raise RuntimeError(
            "agent-desktop 不存在：%s（仓库应自带 tools/agent-desktop/agent-desktop.exe，"
            "或设 AGENT_DESKTOP_EXE 指向它）" % _CLI)
    p = subprocess.run([str(_CLI)] + argv, cwd=str(_CLI.parent),
                       capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    out = (p.stdout or "").strip()
    try:
        return json.loads(out)
    except Exception:  # noqa: BLE001
        return {"ok": False, "raw": out[:300], "err": (p.stderr or "")[:300]}


def _force_foreground(hwnd: int) -> bool:
    """AttachThreadInput 绕过 Windows 前台锁定，把窗口提到前台。"""
    import ctypes
    from ctypes import wintypes as wt

    u = ctypes.windll.user32
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    u.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
    u.AttachThreadInput.restype = wt.BOOL
    u.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    u.GetWindowThreadProcessId.restype = wt.DWORD
    u.GetForegroundWindow.restype = wt.HWND
    u.SetForegroundWindow.argtypes = [wt.HWND]
    u.SetForegroundWindow.restype = wt.BOOL
    u.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
    u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                               ctypes.c_int, ctypes.c_int, wt.UINT]

    fg = u.GetForegroundWindow()
    t_fg = u.GetWindowThreadProcessId(fg, None)
    t_me = ctypes.windll.kernel32.GetCurrentThreadId()
    t_tgt = u.GetWindowThreadProcessId(hwnd, None)
    attached = []
    for a, b in ((t_me, t_fg), (t_me, t_tgt)):
        if a and b and a != b and u.AttachThreadInput(a, b, True):
            attached.append((a, b))
    u.ShowWindow(hwnd, 9)  # SW_RESTORE
    # HWND_TOPMOST = -1, NOSIZE|NOMOVE
    u.SetWindowPos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0, 0x0001 | 0x0002)
    u.SetForegroundWindow(hwnd)
    import time
    time.sleep(0.4)
    ok = u.GetForegroundWindow() == hwnd
    for a, b in attached:
        u.AttachThreadInput(a, b, False)
    return ok


def find_window(title: str, app: str | None = None) -> tuple[str | None, int | None]:
    """返回 (window_id, hwnd)。"""
    out = _ad(["list-windows"])
    for w in out.get("data") or []:
        app_name = (w.get("app_name") or "")
        win_title = w.get("title") or ""
        name_match = (app and (app_name.lower() == app.lower()
                               or app_name.lower() == (app + ".exe").lower()))
        title_match = (title and title in win_title)
        if name_match or title_match:
            wid = w.get("id")
            hwnd = int(wid.lstrip("w-"), 16) if wid and wid.startswith("w-") else None
            return wid, hwnd
    return None, None


def snapshot(wid: str | None = None, app: str | None = None) -> dict:
    argv = ["snapshot", "-i"]
    if wid:
        argv += ["--window-id", wid]
    elif app:
        argv += ["--app", app]
    return _ad(argv)


def find_ref(tree: dict, role: str, name: str) -> str | None:
    """在 accessibility 树里按 role + 精确 name 找 ref（ref 绑定 snapshot，必须现取现用）。"""
    found: list[str] = []

    def walk(n: dict) -> None:
        if not isinstance(n, dict):
            return
        if n.get("role") == role and (n.get("name") or "").strip() == name:
            rid = n.get("ref_id")
            if rid:
                found.append(rid)
        for c in n.get("children") or []:
            walk(c)

    walk(tree)
    return found[0] if found else None


def click_ref(ref: str, *, headed: bool = False, hwnd: int | None = None) -> dict:
    """按 ref 点击；headed=True 发物理输入（原生对话框必需）。"""
    if headed and hwnd is not None:
        _force_foreground(hwnd)
    argv = (["--headed"] if headed else []) + ["click", ref]
    return _ad(argv)


def set_value(ref: str, value: str) -> dict:
    """设置控件值（VALUE 是位置参数）。"""
    return _ad(["set-value", ref, value])


def select_folder(project_dir: str, *, app: str = "Graph",
                  select_name: str = "Select",
                  dialog_title: str = "选择文件夹",
                  folder_field: str = "文件夹:",
                  confirm_name: str = "选择文件夹",
                  timeout_s: float = 20.0) -> dict:
    """完整流程：把 Graph 提前台 -> 点 Select -> 在原生对话框填路径并确认。

    返回 {"ok", "steps", "error"}。这是 choose_folder 步骤的直接入口。
    """
    import time

    steps: list[dict] = []

    # 1. 找 Graph 窗口并提前台
    wid, hwnd = find_window("", app=app)
    if not wid or hwnd is None:
        return {"ok": False, "steps": steps, "error": "找不到 %s 窗口" % app}
    steps.append({"step": "front", "ok": _force_foreground(hwnd)})

    # 2. 点 Select（headless 语义先试，不弹就 headed）
    snap = snapshot(app=app)
    tree = (snap.get("data") or {}).get("tree") or {}
    ref = find_ref(tree, "button", select_name)
    if not ref:
        return {"ok": False, "steps": steps, "error": "找不到 Select 按钮"}
    r = click_ref(ref, headed=False)
    steps.append({"step": "click_headless", "ok": bool(r.get("ok"))})

    # 3. 等原生对话框
    did, _dhwnd = None, None
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        did, _dhwnd = find_window(dialog_title)
        if did:
            break
        time.sleep(0.5)
    if not did:
        # headless 没弹 -> 用 headed 物理输入（真实用户手势）
        snap2 = snapshot(app=app)
        ref2 = find_ref((snap2.get("data") or {}).get("tree") or {}, "button", select_name)
        if not ref2:
            return {"ok": False, "steps": steps, "error": "Select ref 过期且找不到新的"}
        r2 = click_ref(ref2, headed=True, hwnd=hwnd)
        steps.append({"step": "click_headed", "ok": bool(r2.get("ok")),
                      "err": r2.get("error")})
        if not r2.get("ok"):
            return {"ok": False, "steps": steps, "error": "headed 点击失败"}
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            did, _dhwnd = find_window(dialog_title)
            if did:
                break
            time.sleep(0.5)
    if not did:
        return {"ok": False, "steps": steps, "error": "原生对话框未出现"}
    steps.append({"step": "dialog", "ok": True, "window_id": did})

    # 4. 填路径
    snap3 = snapshot(wid=did)
    tree3 = (snap3.get("data") or {}).get("tree") or {}
    ff = find_ref(tree3, "textfield", folder_field)
    if not ff:
        # 中文系统标题可能是「文件夹:」带空格，模糊找
        ff = find_ref(tree3, "textfield", folder_field.strip())
    if not ff:
        return {"ok": False, "steps": steps, "error": "找不到文件夹输入框"}
    rv = set_value(ff, project_dir)
    steps.append({"step": "set_value", "ok": bool(rv.get("ok"))})
    if not rv.get("ok"):
        return {"ok": False, "steps": steps, "error": "填路径失败"}

    # 5. 点确认
    snap4 = snapshot(wid=did)
    tree4 = (snap4.get("data") or {}).get("tree") or {}
    cb = find_ref(tree4, "button", confirm_name)
    if not cb:
        return {"ok": False, "steps": steps, "error": "找不到确认按钮"}
    rc = click_ref(cb)
    steps.append({"step": "confirm", "ok": bool(rc.get("ok"))})
    time.sleep(1.0)
    return {"ok": bool(rc.get("ok")), "steps": steps,
            "project_dir": project_dir}


def select_file(file_path: str, *, app: str = "Graph",
                select_name: str = "Select",
                dialog_title: str = "打开",
                filename_field: str = "文件名(N):",
                confirm_name: str = "打开(O):",
                timeout_s: float = 20.0) -> dict:
    """完整流程：把 Graph 提前台 -> 点 Select -> 在原生 Open 对话框填文件路径并确认。

    与 select_folder 同构，只是对话框标题/输入框/确认按钮不同。
    """
    import time

    steps: list[dict] = []

    wid, hwnd = find_window("", app=app)
    if not wid or hwnd is None:
        return {"ok": False, "steps": steps, "error": "找不到 %s 窗口" % app}
    steps.append({"step": "front", "ok": _force_foreground(hwnd)})

    snap = snapshot(app=app)
    ref = find_ref((snap.get("data") or {}).get("tree") or {}, "button", select_name)
    if not ref:
        return {"ok": False, "steps": steps, "error": "找不到 Select 按钮"}
    r = click_ref(ref, headed=False)
    steps.append({"step": "click_headless", "ok": bool(r.get("ok"))})

    # 等对话框：只认 Graph 进程的窗口，或标题精确的对话框；
    # 绝不能用 "Open" 模糊匹配——会命中 OpenChamber（标题含 Openchamber）！
    did = None
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for t in (dialog_title, "选择文件"):
            wid_tmp, _ = find_window(t)
            if wid_tmp:
                # 校验：标题必须精确是对话框（不是 "Openchamber..."）
                snap_tmp = _ad(["snapshot", "--window-id", wid_tmp])
                wt_title = ((snap_tmp.get("data") or {}).get("window") or {}).get("title", "")
                if wt_title.strip() in ("打开", "选择文件", "Open"):
                    did = wid_tmp
                    break
        if did:
            break
        time.sleep(0.5)
    if not did:
        snap2 = snapshot(app=app)
        ref2 = find_ref((snap2.get("data") or {}).get("tree") or {}, "button", select_name)
        if not ref2:
            return {"ok": False, "steps": steps, "error": "Select ref 过期"}
        r2 = click_ref(ref2, headed=True, hwnd=hwnd)
        steps.append({"step": "click_headed", "ok": bool(r2.get("ok"))})
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            for t in (dialog_title, "选择文件"):
                wid_tmp, _ = find_window(t)
                if wid_tmp:
                    snap_tmp = _ad(["snapshot", "--window-id", wid_tmp])
                    wt_title = ((snap_tmp.get("data") or {}).get("window") or {}).get("title", "")
                    if wt_title.strip() in ("打开", "选择文件", "Open"):
                        did = wid_tmp
                        break
            if did:
                break
            time.sleep(0.5)
    if not did:
        return {"ok": False, "steps": steps, "error": "原生 Open 对话框未出现"}
    steps.append({"step": "dialog", "ok": True, "window_id": did})

    snap3 = snapshot(wid=did)
    tree3 = (snap3.get("data") or {}).get("tree") or {}
    ff = find_ref(tree3, "textfield", filename_field)
    if not ff:
        # 实际标题带快捷键后缀：「文件名(N):」，用模糊收集再挑 role=textfield
        candidates = []
        def collect_fields(n):
            if not isinstance(n, dict): return
            if n.get("role") == "textfield" and "文件名" in str(n.get("name") or ""):
                candidates.append(n.get("ref_id"))
            for c in n.get("children") or []: collect_fields(c)
        collect_fields(tree3)
        ff = candidates[0] if candidates else None
    if not ff:
        # 诊断：把对话框里所有 textfield 的 role/name/ref 列出来，
        # 免得像这轮一样只知道"找不到"却看不到实际结构。
        diag = []
        def collect(n):
            if not isinstance(n, dict): return
            if n.get("role") in ("textfield", "edit", "combobox"):
                diag.append({"role": n.get("role"), "name": n.get("name"),
                             "ref": n.get("ref_id"), "value": n.get("value")})
            for c in n.get("children") or []: collect(c)
        collect(tree3)
        return {"ok": False, "steps": steps,
                "error": "找不到文件名输入框；对话框里的输入控件: %s" % diag}
    rv = set_value(ff, file_path)
    steps.append({"step": "set_value", "ok": bool(rv.get("ok"))})
    if not rv.get("ok"):
        return {"ok": False, "steps": steps, "error": "填文件路径失败"}

    # 关键：确认按钮名在中文系统里带快捷键后缀（打开(O)）且可能有多个同名按钮。
    snap4 = snapshot(wid=did)
    tree4 = (snap4.get("data") or {}).get("tree") or {}
    # 用 role+name 前缀收集全部候选，逐个试 click，成功即停。每次都重新
    # snapshot 拿新 ref（旧 ref 会因 UI 变化变 STALE_REF / AMBIGUOUS_TARGET）。
    confirm_candidates = []
    def collect_btns(n):
        if not isinstance(n, dict): return
        nm = str(n.get("name") or "").strip()
        if n.get("role") == "button" and (nm.startswith("打开") or nm.startswith("Select")
                                          or nm in ("OK", "确定")):
            confirm_candidates.append(nm)
        for c in n.get("children") or []: collect_btns(c)
    collect_btns(tree4)
    tried = []
    rc = {"ok": False}
    for nm in dict.fromkeys(confirm_candidates):  # 去重保序
        snap_now = snapshot(wid=did)
        cb = find_ref((snap_now.get("data") or {}).get("tree") or {}, "button", nm)
        if not cb:
            tried.append({"name": nm, "result": "ref 不唯一/未找到"})
            continue
        rc = click_ref(cb)
        tried.append({"name": nm, "ok": bool(rc.get("ok")),
                      "err": rc.get("error", {}).get("code") if isinstance(rc.get("error"), dict) else None})
        if rc.get("ok"):
            break
    steps.append({"step": "confirm_candidates", "names": confirm_candidates,
                  "tried": tried})
    if not rc.get("ok"):
        return {"ok": False, "steps": steps,
                "error": "确认按钮点击全失败: %s" % tried}
    time.sleep(1.0)
    return {"ok": True, "steps": steps, "file": file_path}
