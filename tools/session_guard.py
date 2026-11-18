# -*- coding: utf-8 -*-
"""会话状态检测与 RDP 断开后的绘制救回。

## 要解决的问题（原问题是真实存在的，不是凭空加的）

远程桌面（RDP）连入再断开后，Windows 会把那个会话切成 **Disc**（disconnected）
状态。此时：

  * 会话还在、进程还活着、`GetSystemMetrics` 还读得到数；
  * 但 **画面不再更新**（桌面合成停了），截图会是一帧冻结的旧画面；
  * `GetForegroundWindow()` 可能返回 0（没有前台窗口）。

RPA 在这之后点按钮，坐标看着是对的、点击也发出去了，但**界面不响应**——
表现成「点不中 / 选择器漂移」，排查方向完全错。

## 救回办法

`tscon <会话ID> /dest:console` 把会话接回物理控制台，绘制恢复。

## 为什么之前只写了注释

`verify_plan.py` 第 2 条的原话是「RDP 断开 → tscon 救回绘制」，但仓库里
**没有任何实现**（`grep -r tscon tools src` 只命中 verify_plan 自己的注释）。
这个模块把那段描述变成可执行的东西。

## 边界

  * 只读为主：`session_state()` 只查不改；
  * `reclaim()` 才动会话，且**默认 dry_run**，必须显式确认；
  * 非 Windows / 读不到时返回明确状态，不抛异常伪装成功。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

# query session 的输出里，状态列这几个值有明确含义
STATE_ACTIVE = "Active"
STATE_DISCONNECTED = "Disc"
STATE_LISTEN = "Listen"
STATE_CONSOLE = "Conn"


def _run(argv: list[str], timeout: float = 20.0) -> tuple[int, str]:
    """跑一条命令，合并 stdout+stderr。

    不用 shell=True：`query session` 与 `tscon` 都是原生程序，
    路径里也不该出现需要 shell 解析的东西。

    **编码**：Windows 原生工具输出走控制台代码页（本机 936/GBK），
    按 utf-8 解码会把中文状态列变成乱码，于是状态判断全部失效。
    实测（2026-11-18）：`query session` 用 utf-8 读出来是
    '\\ufffd\\ufffd\\ufffd\\ufffd'，中文「已断开」根本认不出来。
    所以先按 utf-8 试，失败再按本地代码页（cp936 等）。
    """
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout)
        raw = (p.stdout or b"") + (p.stderr or b"")
        text = ""
        for enc in ("utf-8", "cp936", "mbcs", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        return p.returncode, text.strip()
    except FileNotFoundError:
        return 127, "%s 不存在" % argv[0]
    except subprocess.TimeoutExpired:
        return -2, "TIMEOUT"
    except Exception as exc:  # noqa: BLE001
        return -1, "%s: %s" % (type(exc).__name__, exc)


def session_state() -> dict:
    """读当前会话表。

    返回::

        {
          "ok": True,
          "sessions": [{"name","user","id","state","device"}...],
          "console": {...} | None,
          "disconnected": [...],     # 状态为 Disc 的会话
          "has_disc": bool,
          "source": "query session"
        }

    `query session` 的输出是本地化的（中文系统里表头是「会话名 / 用户名 /
    ID / 状态」），所以只按**列位置**解析，不按表头文字匹配。
    """
    if os.name != "nt":
        return {"ok": False, "reason": "非 Windows", "sessions": [],
                "console": None, "disconnected": [], "has_disc": False}

    rc, out = _run(["query", "session"])
    # exit=1 在这里是**正常**的：只要存在 rdp-tcp 侦听但当前没有活动 RDP 会话，
    # query session 就返回 1（实测 2026-11-18）。所以判据是「有没有数据行」，
    # 不是退出码。
    data_lines = [ln for ln in out.splitlines()
                  if ln.strip() and not re.match(r"^\s*[-=]{3,}", ln)
                  and not re.search(r"(会话名|SESSIONNAME)", ln, re.I)]
    if not data_lines:
        return {"ok": False, "reason": out or ("query session 无数据行，退出码 %s" % rc),
                "sessions": [], "console": None, "disconnected": [],
                "has_disc": False, "source": "query session"}

    sessions = []
    for line in data_lines:
        text = line.rstrip()
        marker = ""
        body = text
        if body.lstrip().startswith(">"):
            marker = ">"
            body = body.lstrip()[1:]
        parts = re.split(r"\s{2,}", body.strip())
        if len(parts) < 3:
            continue
        name = parts[0]
        # 用户名可能为空（services 那行），此时下一段就是数字 ID
        user = ""
        rest = parts[1:]
        if rest and not re.fullmatch(r"\d+", rest[0]):
            user = rest[0]
            rest = rest[1:]
        if not rest or not re.fullmatch(r"\d+", rest[0]):
            continue
        sid = int(rest[0])
        state = rest[1] if len(rest) > 1 else ""
        device = rest[2] if len(rest) > 2 else ""
        sessions.append({"name": name, "user": user, "id": sid,
                         "state": state, "marker": marker, "device": device,
                         "raw": text})

    def is_state(s: dict, *cands: str) -> bool:
        """状态列在中文/英文系统里不同，所以两边都认。"""
        st = (s.get("state") or "").strip()
        low = st.lower()
        return any(c.lower() == low or c.lower() in low for c in cands)

    console = next((s for s in sessions
                    if s["name"].lower() == "console"), None)

    # 只把**用户会话**算进 Disc：
    #   services (id=0) 是系统服务会话，状态列永远是「断开」，它不是可救回的目标；
    #   rdp-tcp 是侦听器，不是会话。
    # 实测踩过：不过滤的话 has_disc 恒为 True，第 2 条的判据会被这个假阳性带偏。
    def is_user_session(s: dict) -> bool:
        name = (s.get("name") or "").lower()
        if name in ("services", "rdp-tcp", "console"):
            return False
        if name.startswith("rdp-tcp#"):
            return True
        return bool(s.get("user"))

    disc = [s for s in sessions
            if is_user_session(s) and is_state(s, STATE_DISCONNECTED, "断开")]
    active_rdp = [s for s in sessions
                  if s["name"].lower().startswith("rdp-tcp#")
                  and is_state(s, STATE_ACTIVE, "运行中", "活动")]

    return {
        "ok": True,
        "sessions": sessions,
        "console": console,
        "disconnected": disc,
        "active_rdp": active_rdp,
        "has_disc": bool(disc),
        "source": "query session",
    }


def foreground_window() -> dict:
    """`GetForegroundWindow()` 的句柄。0 表示没有前台窗口。

    为什么单独拿出来：RDP 会话被最小化 / 断开后，前台窗口会变成 0，
    而有些点击逻辑依赖前台窗口存在（SetForegroundWindow 的前提）。
    """
    if os.name != "nt":
        return {"ok": False, "reason": "非 Windows", "handle": 0}
    try:
        import ctypes
        user32 = ctypes.windll.user32
        # 不设 DPI awareness 也能读句柄，但保持与 _screen_mode 一致更稳
        try:
            user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            pass
        h = int(user32.GetForegroundWindow())
        return {"ok": True, "handle": h, "present": h != 0}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "%s: %s" % (type(exc).__name__, exc),
                "handle": 0}


def reclaim(session_id: int | None = None, *, dry_run: bool = True,
            to_console: bool = True, timeout: float = 30.0) -> dict:
    """把 Disc 会话接回控制台，恢复画面更新。

    ``dry_run=True``（默认）只打印将要执行的命令，不真跑 —— 这条会改变
    会话归属，必须显式确认。

    典型用法::

        st = session_state()
        if st["has_disc"]:
            reclaim(st["disconnected"][0]["id"], dry_run=False)
    """
    st = session_state()
    if not st.get("ok"):
        return {"ok": False, "reason": st.get("reason"), "steps": []}

    target = session_id
    if target is None:
        if not st["disconnected"]:
            # 没有可救回的会话时，仍然给出一条「假如有」的预演命令，
            # 让调用方能证明救回路径本身是通的（而不是靠猜）。
            probe_id = (st.get("console") or {}).get("id", 1)
            argv = ["tscon", str(probe_id)]
            if to_console:
                argv = ["tscon", str(probe_id), "/dest:console"]
            return {"ok": True, "noop": True, "dry_run": True,
                    "reason": "没有 Disc 会话，不需要救回",
                    "steps": [{"argv": argv, "dry_run": True}],
                    "before": st, "target": None,
                    "would_run": " ".join(argv),
                    "note": "上面是预演命令；实际目标会是 Disc 会话的 id"}
        target = st["disconnected"][0]["id"]

    argv = ["tscon", str(target)]
    if to_console:
        # /dest:console 把会话接回物理控制台
        argv = ["tscon", str(target), "/dest:console"]

    steps = [{"argv": argv, "dry_run": dry_run}]
    if dry_run:
        return {"ok": True, "dry_run": True, "before": st, "target": target,
                "steps": steps, "would_run": " ".join(argv)}

    rc, out = _run(argv, timeout=timeout)
    after = session_state()
    return {
        "ok": rc == 0,
        "dry_run": False,
        "before": st,
        "after": after,
        "target": target,
        "exit_code": rc,
        "output": out,
        "reclaimed": (not after.get("has_disc", True)) if after.get("ok") else None,
        "steps": steps,
    }


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="会话状态与 RDP 断开后的绘制救回")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--reclaim", action="store_true", help="真的执行 tscon（默认只看）")
    ap.add_argument("--session", type=int, default=None)
    ap.add_argument("--no-console", action="store_true", help="不加 /dest:console")
    args = ap.parse_args(argv)

    st = session_state()
    fg = foreground_window()

    if args.reclaim:
        res = reclaim(args.session, dry_run=False,
                      to_console=not args.no_console)
        if args.json:
            print(json.dumps({"session": st, "foreground": fg, "reclaim": res},
                             ensure_ascii=False, indent=1))
        else:
            print("救回: exit=%s  %s" % (res.get("exit_code"), res.get("output")))
            print("救回后还有 Disc: %s" % (res.get("after") or {}).get("has_disc"))
        return 0 if res.get("ok") else 1

    if args.json:
        print(json.dumps({"session": st, "foreground": fg}, ensure_ascii=False, indent=1))
    else:
        print("  会话表:")
        for s in st.get("sessions", []):
            print("    %-12s user=%-10s id=%-3s state=%s"
                  % (s["name"], s["user"] or "-", s["id"], s["state"]))
        print("  console  : %s" % (st.get("console") or "无"))
        print("  Disc 会话: %d 个  %s"
              % (len(st.get("disconnected", [])),
                 [s["id"] for s in st.get("disconnected", [])]))
        print("  ActiveRDP: %d 个" % len(st.get("active_rdp", [])))
        print("  前景窗口 : handle=%s present=%s"
              % (fg.get("handle"), fg.get("present")))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(main())
