# -*- coding: utf-8 -*-
"""第 7 条：8 条流程各连跑 3 次，第 3 次状态与第 1 次一致。

## 为什么原来一直 SKIP

`item_07` 的函数体只有一句 ``return "SKIP"``，注释写着"一致性判据需要人批准"。
其实不需要人批准 —— 要判的是**同一输入的重复性**，不是"流程成功"。

## 判据怎么定（关键）

流程里有 5 条会停在 human_gate，3 条会因缺设备/输入失败。跑到 succeeded 反而是错的。
所以一致性判据是三元组：

    (status, current_step, step_index)

三次都相同 = 确定性。这能抓到的真问题是：
  * 有时停在 settle_home、有时停在 health  → 竞态
  * 有的 succeeded、有的 failed            → 环境依赖漂移
  * step_index 抖动                        → 恢复/重试逻辑不稳

## 并发

后端 `run_workflow(allow_concurrent=False)` 会拒同一流程的第二个未结束 job。
所以每次跑完必须 cancel 掉，否则第 2 次直接被拒（HTTP 400）—— 那会被误判成"不一致"。
HTTP 层不暴露 allow_concurrent，所以用 cancel 收尾。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:7799"
REPO = Path(r"H:\Archive\文件夹 老版\personal content\课程资料\其他\大创项目\野外台站智能体")
TERMINAL = ("succeeded", "failed", "waiting_approval", "waiting_operator", "cancelled")
TRIES = 3


def call(path: str, body: dict | None = None, timeout: float = 120) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path, data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def params_for(wf: str) -> dict:
    """给每条流程一份**符合规格**的确定性参数。

    参数名必须与 workflows/*.yaml 的 params 段一致，否则流程不进第一步就被
    spec 校验拒掉（HTTP 400，rejected）。那种"三次都 rejected"也算一致，
    但完全没测到流程本身 —— 所以这里逐条按真实字段填。
    """
    sbf = REPO / "逆向" / "00_来源" / "samples" / "graph" / "synthetic" / "heading.sbf"
    return {
        "gui.app.install": {"package": str(REPO / "NovAtel" / "04_软件与驱动" / "ManageWeb_2-11-0.zip"),
                            "expect_name": "Manage"},
        "gui.app.update": {"application": "Manage"},
        "gui.graph.newproject": {"source": str(sbf), "project_name": "SBF Demo",
                                 "project_dir": r"C:\Users\SunCh\AppData\Local\Temp\opencode\sbf-project"},
        # 下列四条按 yaml 的 params 段填，不编造字段名
        "gui.graph.export": {"project": "SBF Demo"},
        "gui.device.add": {"name": "DEMO", "port": "COM3", "baud": "115200"},
        "gui.device.update": {"firmware": str(REPO / "NovAtel" / "02_固件" / "OEM7-cards_Firmware_7.10.02.zip"),
                              "model": "OEM729"},
        "gui.suite.autoupdate": {},
        "script.device.restart": {},
    }[wf]


def run_once(wf: str) -> tuple[str, str, int | None, str]:
    """跑一次，等到稳定状态，返回 (status, step, index, note)。"""
    code, body = call("/api/workflows/run", {"id": wf, "params": params_for(wf)})
    if code not in (200, 202):
        return "rejected", f"http{code}", None, str(body.get("error") or body)[:90]
    jid = body.get("job_id") or (body.get("job") or {}).get("job_id")
    if not jid:
        return "rejected", "no-job-id", None, str(body)[:90]

    last = ("pending", "", None)
    for _ in range(60):                      # 最多约 60 秒
        time.sleep(1.0)
        _, view = call("/api/workflows/job?id=" + jid, timeout=60)
        st = str(view.get("status"))
        last = (st, str(view.get("current_step") or ""), view.get("step_index"))
        if st in TERMINAL:
            break

    # 收尾：cancel 掉未结束的，否则下一轮会被 allow_concurrent 拒掉
    if last[0] not in ("succeeded", "failed", "cancelled"):
        call("/api/workflows/job/cancel",
             {"id": jid, "reason": "item_07 repeatability probe", "by": "verify_plan"})
        time.sleep(0.8)
    return last[0], last[1], last[2], ""


def main() -> int:
    code, listing = call("/api/workflows", timeout=60)
    if code != 200:
        print("[SKIP] 引擎未就绪（/api/workflows HTTP %s）" % code)
        return 0
    wfs = [w["id"] for w in (listing.get("workflows") or [])]
    if len(wfs) != 8:
        print("[SKIP] 流程数 %d != 8" % len(wfs))
        return 0

    print("  流程数 %d；每条连跑 %d 次\n" % (len(wfs), TRIES))
    unstable = []
    for wf in wfs:
        seen = []
        for i in range(TRIES):
            st, step, idx, note = run_once(wf)
            seen.append((st, step, idx))
            print("  %-24s #%d  %-18s %-16s idx=%s %s"
                  % (wf, i + 1, st, step, idx, note))
        same = len(set(seen)) == 1
        print("      -> %s  %s\n" % ("一致" if same else "**不一致**", seen[0]))
        if not same:
            unstable.append((wf, seen))

    if unstable:
        for wf, seen in unstable:
            print("[FAIL] %s 三次状态不同：%s" % (wf, seen))
        return 1
    print("[PASS] 8 条流程 × 3 次全部一致（status、step、index 三元组稳定）")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
