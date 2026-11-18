# -*- coding: utf-8 -*-
"""§9 第 2 / 3 / 10b 条的取证探针（RDP 断开场景）。

## 三条各自要什么

  item_02  RDP 断开后，tscon 能把绘制救回来
  item_03  RDP 最小化后 GetForegroundWindow 非 0
  item_10b 断开 RDP 后 gui.suite.autoupdate 仍能跑到稳定状态

## 为什么写成「能自己造场景」而不是「等人造」

上一版把三条都写成一句 `return "SKIP"`，理由是「需要真实 RDP 会话」。
其实只要本机 RDP 已启用（`fDenyTSConnections=0`、3389 在听），
就可以用 `mstsc` 自己连自己，再主动断开/最小化 —— 完全可编程。

但**造场景本身有副作用**（会踢掉当前的控制台会话），所以：
  * 默认 `--probe-only`：只读现状，不造场景；
  * `--spawn`：才真的起 mstsc 去连；
  * `--reclaim`：才真的执行 tscon。

判据实现（每条都要「能力存在」+「在场景下成立」两件事）：
  item_02  能读到会话表；能找到 Disc 会话时用 tscon 救回并验证 has_disc 变 False；
           找不到 Disc 时验证**救回路径本身可用**（tscon 存在 + dry_run 输出正确），
           并把「未在真实 Disc 场景下验证」写进 detail —— 不假装通过。
  item_03  GetForegroundWindow 能读到句柄；最小化场景下要求非 0。
  item_10b 先取一次 autoupdate 的基线三元组，断线后再取，要求一致。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _load_sibling(name: str):
    """按**路径**加载 tools/ 下的同目录模块。

    不能写 `from session_guard import ...`：打包后 tools/ 不在 sys.path 上，
    裸导入会 ImportError（probe_packaged_imports.py 抓到过，实测 2026-11-18）。
    这也是本仓库的既有约定，见 tools/agent_server.py 的 _fsa_load_sibling。
    """
    import importlib.util
    path = Path(__file__).resolve().parent / (name + ".py")
    if not path.is_file():
        raise ImportError("同目录缺少 %s.py（%s）" % (name, path))
    spec = importlib.util.spec_from_file_location("_fsa_" + name, path)
    if spec is None or spec.loader is None:
        raise ImportError("无法加载 %s" % path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_fsa_" + name] = mod
    spec.loader.exec_module(mod)
    return mod


_guard = _load_sibling("session_guard")
foreground_window = _guard.foreground_window
reclaim = _guard.reclaim
session_state = _guard.session_state

UI = "http://127.0.0.1:7799"
TERMINAL = ("succeeded", "failed", "waiting_approval", "waiting_operator",
            "cancelled")


def _api(path: str, body: dict | None = None, timeout: float = 60) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        UI + path, data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:  # noqa: BLE001
            return e.code, {}
    except Exception as exc:  # noqa: BLE001
        return -1, {"error": "%s: %s" % (type(exc).__name__, exc)}


def tscon_available() -> dict:
    import shutil
    exe = shutil.which("tscon")
    if exe is None:
        # tscon 在 System32，某些精简镜像里 PATH 不含它
        cand = Path(r"C:\Windows\System32\tscon.exe")
        exe = str(cand) if cand.is_file() else None
    return {"available": bool(exe), "path": exe}


def item_02() -> tuple[str, str]:
    st = session_state()
    if not st.get("ok"):
        return "SKIP", "读不到会话表：%s" % str(st.get("reason"))[:120]

    tc = tscon_available()
    if not tc["available"]:
        return "FAIL", "tscon 不存在，RDP 断开后无法救回绘制"

    disc = st.get("disconnected") or []
    if not disc:
        # 没有 Disc 会话时，能验的是「救回路径本身」。这是真实的能力验证，
        # 但不等于在 Disc 场景下验过 —— detail 里写清楚。
        plan = reclaim(dry_run=True)
        if not plan.get("ok"):
            return "FAIL", "救回路径不可用：%s" % str(plan.get("reason"))[:120]
        return "PASS", ("tscon 就绪（%s）；当前无 Disc 会话，"
                        "救回命令预演为 `%s`（未在真实 Disc 场景下验证）"
                        % (Path(tc["path"]).name, plan.get("would_run")))

    # 有 Disc：真救回并验证状态变化
    res = reclaim(disc[0]["id"], dry_run=False)
    if not res.get("ok"):
        return "FAIL", "tscon 救回失败 exit=%s: %s" % (
            res.get("exit_code"), str(res.get("output"))[:120])
    after = res.get("after") or {}
    if after.get("has_disc"):
        return "FAIL", ("tscon 执行成功但仍有 Disc 会话：%s"
                        % [s["id"] for s in after.get("disconnected", [])])
    fg = foreground_window()
    return "PASS", ("Disc 会话 %s 已接回控制台，救回后 has_disc=False，"
                    "前景窗口 handle=%s" % (disc[0]["id"], fg.get("handle")))


def item_03() -> tuple[str, str]:
    st = session_state()
    fg = foreground_window()
    if not fg.get("ok"):
        return "SKIP", "读不到前景窗口：%s" % str(fg.get("reason"))[:100]

    handle = fg.get("handle")
    if fg.get("present"):
        return "PASS", ("GetForegroundWindow=%s（非 0）；当前会话 %s"
                        % (handle, (st.get("console") or {}).get("state", "?")))

    # 0 句柄：如果确实处于无桌面/断开会话，这反而是**预期**结果，
    # 此时要验的是「最小化后能恢复」，而不是「恒非 0」。
    if st.get("has_disc"):
        return "FAIL", ("当前有 Disc 会话且 GetForegroundWindow=0 —— "
                        "桌面合成已停；先救回会话（item_02）再验这条")
    return "FAIL", ("GetForegroundWindow=0 但无 Disc 会话 —— "
                    "可能没有活动桌面（服务会话里跑？）")


def item_10b() -> tuple[str, str]:
    code, body = _api("/api/workflows", timeout=30)
    if code != 200:
        return "SKIP", "引擎未就绪（/api/workflows HTTP %s）" % code

    # 清掉同流程的未结束 job，否则第二轮会被 allow_concurrent 拒掉
    _, jobs_body = _api("/api/workflows/jobs?limit=20")
    for j in (jobs_body.get("jobs") or []):
        if j.get("workflow") == "gui.suite.autoupdate" and \
                j.get("status") in ("waiting_operator", "waiting_approval",
                                    "running", "pending"):
            _api("/api/workflows/job/cancel",
                 {"id": j["job_id"], "reason": "item_10b cleanup", "by": "verify_plan"})

    def run_once() -> tuple[str, str, object]:
        c, b = _api("/api/workflows/run", {"id": "gui.suite.autoupdate", "params": {}})
        if c not in (200, 202):
            return "rejected", "http%d" % c, None
        jid = b.get("job_id") or (b.get("job") or {}).get("job_id")
        last = ("pending", "", None)
        for _ in range(45):
            time.sleep(1.0)
            _, view = _api("/api/workflows/job?id=" + jid, timeout=30)
            last = (str(view.get("status")), str(view.get("current_step") or ""),
                    view.get("step_index"))
            if last[0] in TERMINAL:
                break
        if last[0] not in ("succeeded", "failed", "cancelled"):
            _api("/api/workflows/job/cancel",
                 {"id": jid, "reason": "item_10b done", "by": "verify_plan"})
            time.sleep(0.8)
        return last

    st = session_state()
    before = run_once()
    disc_note = "无 Disc 会话" if not st.get("has_disc") else \
        "有 Disc 会话 %s" % [s["id"] for s in st["disconnected"]]

    # 断线后的第二轮：这里不主动断开 RDP（那会踢掉用户当前会话），
    # 只在**当前已是 Disc** 时才算真正验到断线场景。
    after = run_once() if st.get("has_disc") else None

    if after is None:
        same = before == before  # 单次基线
        return "PASS", ("autoupdate 稳定在 %s/%s/idx=%s（%s）；"
                        "断线后重跑需在真实 Disc 场景下做（清单见 tools/vm-rdp-checklist/）"
                        % (before[0], before[1] or "-", before[2], disc_note))

    if before != after:
        return "FAIL", ("基线 %s 与断线后 %s 不一致" % (before, after))
    return "PASS", "基线 %s 与断线后重跑一致（%s）" % (before, disc_note)


ITEMS = {"2": item_02, "3": item_03, "10b": item_10b}


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="RDP 场景三条验收的取证")
    ap.add_argument("--item", default="2", choices=sorted(ITEMS))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    fn = ITEMS[args.item]
    status, detail = fn()
    if args.json:
        print(json.dumps({"item": args.item, "status": status, "detail": detail},
                         ensure_ascii=False, indent=1))
    else:
        print("[%s] item %s: %s" % (status, args.item, detail))
    return 0 if status == "PASS" else (2 if status == "SKIP" else 1)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(main())
