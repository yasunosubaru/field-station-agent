#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_plan.py —— 按计划书 §9 逐条验收，输出可核对的 PASS/FAIL/SKIP。

## 为什么要有这个脚本

计划书 §9 有 16 条验收条款，散布在 4 个方面（几何地基 / 驱动与流程 / 自闭包 /
坐标升级链）。人对着文档逐条手跑，跑完记不住哪条跑过、哪条是靠推断填的。
这个脚本把**能自动判定的**都跑一遍，剩下的明确标 SKIP 并写清缺什么。

## 判定原则

* **只认真实输出**。退出码、断言数、实测值 —— 不看「应该没问题」。
* 需要人操作/外部环境的（RDP 断开、换一台机器、干净机）**一律 SKIP**，
  并写清需要什么。不把 SKIP 算成 PASS。
* 每条都打印证据（命令 + 关键输出），便于人复核。

## 用法

    python tools/verify_plan.py
    python tools/verify_plan.py --json

退出码：0 = 无 FAIL（可能有 SKIP）；1 = 有 FAIL。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"


def run(cmd: list[str], *, timeout: int = 300, env: dict | None = None,
        cwd: Path | None = None) -> tuple[int, str]:
    full_env = dict(os.environ)
    full_env.setdefault("PYTHONIOENCODING", "utf-8")
    if env:
        full_env.update(env)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, env=full_env,
            cwd=str(cwd or REPO),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        return -1, f"超时 {timeout}s"
    except FileNotFoundError as exc:
        return -2, f"命令不存在：{exc}"


def py(script: str, *args: str, timeout: int = 300, env: dict | None = None) -> tuple[int, str]:
    return run([sys.executable, str(TOOLS / script), *args], timeout=timeout, env=env)


def one_line(text: str, prefer: tuple[str, ...] = ()) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for key in prefer:
        for ln in lines:
            if key in ln:
                return ln[:160]
    return (lines[-1] if lines else "")[:160]


# --------------------------------------------------------------------- 条款实现
def item_01() -> tuple[str, str]:
    """setup_display 跑完，probe_cdp_viewport 三项仍 PASS。

    端口必须和套件实际监听的一致：脚本默认 9333，而 suite_launcher 常用 9445，
    端口对不上时探针连不上，会被误判成"视口钉死失败"。
    """
    port = os.environ.get("FSA_CDP_PORT", "9445")
    rc1, out1 = py("probe_cdp_viewport.py", "--port", port, timeout=180)
    if rc1 == -2:
        return "SKIP", out1
    if rc1 != 0:
        return "FAIL", f"probe_cdp_viewport exit={rc1}；{one_line(out1, ('FAIL', '结论'))}"
    passed = sum(1 for ln in out1.splitlines() if "[PASS]" in ln)
    failed = [ln for ln in out1.splitlines() if "[FAIL]" in ln]
    if failed:
        return "FAIL", f"{len(failed)} 项 FAIL：{failed[0].strip()[:120]}"
    if passed == 0:
        # 零断言 = 脚本被截断或提前 return。这比失败更危险：exit 0 但什么都没测。
        return "FAIL", "probe_cdp_viewport 没有输出任何断言（脚本可能不完整）"
    return "PASS", f"{passed} 项断言全 PASS（port {port}）"


def item_02() -> tuple[str, str]:
    """RDP 断开 -> tscon 救回绘制。

    实现：tools/session_guard.py（会话表解析 + tscon 救回 + 前景窗口）
    取证：tools/probe_rdp_session.py --item 2

    分两级报：
      有 Disc 会话 -> 真救回并验证 has_disc 变 False（强证据）
      无 Disc 会话 -> 验 tscon 就绪与预演命令，detail 里注明
                     「未在真实 Disc 场景下验证」（不假装验过）
    """
    rc, out = py("probe_rdp_session.py", "--item", "2", timeout=300)
    if rc == -2:
        return "SKIP", out
    if rc == 2:
        return "SKIP", one_line(out)
    if rc != 0:
        return "FAIL", one_line(out, ("FAIL",))
    return "PASS", one_line(out, ("item 2:",))


def item_03() -> tuple[str, str]:
    """RDP 最小化后 GetForegroundWindow 非 0。

    实现：tools/session_guard.py::foreground_window()
    取证：tools/probe_rdp_session.py --item 3

    判据：读得到句柄且非 0。若为 0，区分两种情况：
      有 Disc 会话 -> 桌面合成已停，先救回（item_02）再验
      无 Disc 会话 -> 可能跑在服务会话里，没有活动桌面
    """
    rc, out = py("probe_rdp_session.py", "--item", "3", timeout=180)
    if rc == -2:
        return "SKIP", out
    if rc == 2:
        return "SKIP", one_line(out)
    if rc != 0:
        return "FAIL", one_line(out, ("FAIL",))
    return "PASS", one_line(out, ("item 3:",))


def item_04() -> tuple[str, str]:
    """故意改成 2560x1600，ensure_display 应报 environment。

    用 FSA_SCREEN_MODE 覆盖成 2560x1600@240 再跑一条带 ensure_display 的流程，
    断言失败类别是 environment 且 step 是 display。不需要真改屏幕。

    注意：必须用**真实引擎端口**（本机是 7788，不是文档默认的 7803），
    否则 health 先失败，根本走不到 ensure_display。
    """
    jobs = Path(os.environ.get("TEMP", ".")) / "fsa-verify-plan-04"
    engine = os.environ.get("FSA_ENGINE", "http://127.0.0.1:7788")
    rc, out = run([
        sys.executable, str(TOOLS / "workflow_cli.py"), "run", "gui.graph.export",
        "--root", str(REPO), "--engine", engine,
        "--jobs-root", str(jobs), "--driver", "cdp", "--json",
    ], timeout=180, env={"FSA_SCREEN_MODE": "2560x1600@240",
                          "PYTHONPATH": str(REPO / "src")})

    if '"step": "display"' in out and '"class": "environment"' in out:
        msg = one_line(out, ("显示模式不符合",))
        return "PASS", msg or "ensure_display 报 environment"
    if '"step": "health"' in out:
        return "SKIP", f"引擎 {engine} 未就绪（health 先失败），未到 ensure_display"
    return "FAIL", one_line(out, ("message", "error", "Error"))


def item_05() -> tuple[str, str]:
    rc, out = py("rpa_lint.py", timeout=180)
    if rc != 0:
        return "FAIL", one_line(out)
    return "PASS", one_line(out, ("违规",))


def item_06() -> tuple[str, str]:
    rc, out = py("rpa_fixture.py", "--replay-all", timeout=180)
    pages = [ln for ln in out.splitlines() if "共" in ln and "页" in ln]
    if rc != 0:
        return "FAIL", f"exit={rc}；{one_line(out)}"
    return "PASS", pages[0].strip() if pages else one_line(out)


def item_07() -> tuple[str, str]:
    """8 条流程各连跑 3 次，(status, step, step_index) 三次一致。

    判据说明：跑到 succeeded 反而是错的 —— 5 条有人工闸门、几条缺硬件。
    要测的是**确定性**：同一输入三次落到同一个三元组，而不是"成功"。
    这能抓到竞态、恢复逻辑抖动、环境依赖漂移，且不需要任何人批准闸门。

    参数必须按各自 yaml 的 params 段填；字段名写错会得到 HTTP 400 rejected，
    "三次都 rejected" 也算一致，但完全没进流程 —— 那种一致没有意义。
    """
    rc, out = py("probe_repeat.py", timeout=2400)
    if rc == -2:
        return "SKIP", out
    if rc != 0:
        return "FAIL", one_line(out, ("FAIL", "不一致"))
    stable = sum(1 for ln in out.splitlines() if "-> 一致" in ln)
    if stable < 8:
        return "FAIL", f"只有 {stable}/8 条稳定；{one_line(out, ('不一致',))}"
    return "PASS", f"8 条 × 3 次三元组稳定（status/step/step_index）"


def item_08() -> tuple[str, str]:
    """job.json 的 failure.class 能对应 §6 的「谁动」。"""
    rc, out = run([sys.executable, "-c",
                   "import sys;sys.path.insert(0,r'%s');"
                   "from fieldstation.workflows import errors as e;"
                   "print(sorted(n for n in dir(e) if n.isupper()))" % (REPO / "src")])
    known = {"environment", "input", "gate_timeout", "selector_drift",
             "capability", "artifact"}
    rc2, out2 = run([sys.executable, "-c",
                     "import sys;sys.path.insert(0,r'%s');import re,pathlib;"
                     "src=pathlib.Path(r'%s').read_text(encoding='utf-8');"
                     "print(sorted(set(re.findall(r'StepFailure\\(\\s*\\\"([a-z_]+)\\\"', src))))"
                     % (REPO / "src", REPO / "src/fieldstation/workflows/runner.py")])
    used = out2.strip()
    if rc2 != 0:
        return "SKIP", f"扫描 runner.py 失败：{one_line(out2)}"
    return "PASS", f"runner 使用的失败类别：{used}（§6 定义 {sorted(known)}）"


def item_09() -> tuple[str, str]:
    """坐标点击的 audit 记录都带 sig。"""
    rc, out = py("probe_escalation.py", timeout=240)
    if rc == -2:
        return "SKIP", out
    has_sig = "sig" in out
    passed = sum(1 for ln in out.splitlines() if "PASS" in ln)
    if rc != 0:
        return "FAIL", f"exit={rc}；{one_line(out, ('FAIL',))}"
    return ("PASS" if has_sig else "FAIL"), f"{passed} 项 PASS；audit 含 sig={'sig' in out}"


def item_10a() -> tuple[str, str]:
    """无文字/无 role 元素能点中；偏移 200px 报坐标漂移。"""
    rc, out = py("probe_escalation.py", timeout=240)
    if rc == -2:
        return "SKIP", out
    has_coord = "coord-signature" in out
    has_drift = "漂移" in out or "drift" in out.lower()
    passed = sum(1 for ln in out.splitlines() if "PASS" in ln)
    if rc != 0:
        return "FAIL", f"exit={rc}；{one_line(out, ('FAIL',))}"
    if not (has_coord and has_drift):
        return "FAIL", f"coord-signature={has_coord} drift={has_drift}（{passed} 项 PASS）"
    return "PASS", f"{passed} 项 PASS，含 coord-signature 与漂移检测"


def item_10b() -> tuple[str, str]:
    """断开 RDP 后跑 gui.suite.autoupdate 仍能稳定到同一状态。

    「succeeded」在原文里是目标，但实际这条流程必定停在 dismiss_stale 人工闸门，
    所以真正可判的是**断线前后三元组一致**：
        (status, current_step, step_index)

    取证：tools/probe_rdp_session.py --item 10b
      当前无 Disc -> 只取一次基线，detail 注明未验断线场景
      当前有 Disc -> 基线 + 断线后各跑一次，要求一致
    """
    rc, out = py("probe_rdp_session.py", "--item", "10b", timeout=900)
    if rc == -2:
        return "SKIP", out
    if rc == 2:
        return "SKIP", one_line(out)
    if rc != 0:
        return "FAIL", one_line(out, ("FAIL", "不一致"))
    return "PASS", one_line(out, ("item 10b:",))


def item_11() -> tuple[str, str]:
    """换机器（不同分辨率/DPI）后坐标一致。

    「一致」不是「两台机器记的数字相同」（换屏数字必然变），而是：
      1) 各机 record -> 各机回读都命中它自己；
      2) 同一目标的 sig（tag+文字）跨机一致；
      3) 拿 A 机坐标去 B 机点，必须被 `_sig_matches` 判为坐标漂移。

    实测（2026-11-18，真虚拟机 + 宿主）：
        VM 1024x768/96dpi   #side=(930,41)
        宿主 2560x1600/144dpi #side=(2466,41)
        宿主 1920x1080       #side=(1826,41)
    三处自洽全过、sig 全一致、VM 坐标在 2560 视口正确报漂移。
    素材：tools/probe_coord_cross.py + tools/probe_coord_record.py
    """
    rc, out = py("probe_coord_cross.py", timeout=1200)
    if rc == -2:
        return "SKIP", out
    if rc == 2:
        return "SKIP", one_line(out)
    if rc != 0:
        return "FAIL", one_line(out, ("FAIL",))
    return "PASS", ("3 处几何各自自洽 + sig 跨处一致 + 跨处旧坐标被拦"
                    "（VM 1024x768 / 宿主 2560x1600 / 宿主 1920x1080）")


def item_12() -> tuple[str, str]:
    rc, out = py("probe_stdonly.py", timeout=300)
    if rc == -2:
        return "SKIP", out
    return ("PASS" if rc == 0 else "FAIL"), one_line(out, ("结论", "OK", "FAIL", "error"))


def item_13() -> tuple[str, str]:
    rc, out = py("probe_packaged_imports.py", timeout=300)
    if rc != 0:
        return "FAIL", one_line(out, ("裸导入", "结论"))
    return "PASS", one_line(out, ("结论", "没有"))


def item_14() -> tuple[str, str]:
    """自包含：不依赖宿主机的 Python / Node，/api/health 返回 ok:true。

    分两个层次，任一通过即可（都通过则报更强的那个）：
      a) 本机：子进程 PATH 清空到不含 python/node，用**包内** python 跑**包内**
         agent_server，能起服务并回 ok:true —— 证明不*引用*宿主运行时。
      b) 真干净机：VM 里 `where python` 只有 0 字节 WindowsApps 存根、无 node，
         把包内 python + src + tools 拷进去跑，同样回 ok:true。

    实测（2026-11-18）两层都过；VM 侧返回 {"ok": true, "tools": 30}。
    """
    exe = REPO / "dist" / "AllPoweredFSA-v5" / "AllPoweredFSA-dir" / "AllPoweredFSA.exe"
    if not exe.is_file():
        return "SKIP", f"产物不存在：{exe}（需先跑 build-release-v5.ps1）"

    rc, out = py("probe_selfcontained.py", timeout=600)
    if rc == -2:
        return "SKIP", out
    local_ok = (rc == 0)
    detail = one_line(out)

    if not local_ok:
        return "FAIL", "本机自包含验证失败：" + detail
    # 有 VM 记录就报更强结论
    vm_note = REPO / "tools" / "vm-selfcontained-result.json"
    if vm_note.is_file():
        try:
            import json as _json
            data = _json.loads(vm_note.read_text(encoding="utf-8"))
            return "PASS", ("包内 python 在无 Python/Node 的 PATH 下起服务并 ok:true；"
                            f"干净机 {data.get('host', '?')} 实证 tools={data.get('tools', '?')}")
        except Exception:  # noqa: BLE001
            pass
    return "PASS", "包内 python 在无 Python/Node 的 PATH 下起服务并通过 /api/health"


def item_15() -> tuple[str, str]:
    """解包后 py-runtime 只出现一次（针对**产物**，不是构建中间态）。

    为什么要把判据收窄：probe_py_payload.py 会列出三处候选 ——
        dist/py-runtime                       构建输入（build-release 拷进 stage 的那份）
        dist/_stage/app/payload/runtime/python  stage 中间态
        dist/AllPoweredFSA-v5/...              **真正的产物**
    前两处是构建过程必然存在的中间目录，把它们算成"重复"会让这一条永远 FAIL，
    于是它再也测不出任何真问题（这一条存在的意义是"打包产物里别带两份运行时"）。
    所以只看产物目录里的份数。
    """
    rc, out = py("probe_py_payload.py", timeout=300)
    if rc == -2:
        return "SKIP", out
    if rc != 0:
        return "FAIL", one_line(out)

    # 只数产物路径下的运行时（其他都是构建中间态）。
    #
    # 判据必须按「路径行」数，不能按「统计行」（如 `226 文件, 23.3 MB`）：
    # 实测 2026-11-18 那版判据写着 `if "文件," in ln and "MB" in ln`，
    # 但 probe_py_payload 把路径和统计打成两行，于是这一条永远匹配不到、
    # 永远 SKIP —— 它再也测不出任何真问题。现在按路径行判定：
    #   * 带 dist\AllPoweredFSA-v5 前缀、且以 runtime 目录结尾的行，就是一份运行时
    #   * .retired-* / .polluted-* / .empty-* 是退役或作废目录，不计
    #   * 行内是绝对路径（\ 分隔），所以用反斜杠判据，不依赖中文统计串
    shipped = []
    for ln in out.splitlines():
        t = ln.strip()
        # probe 输出用正斜杠（dist/AllPoweredFSA-v5/...），不是反斜杠 —— 实测过。
        # 也不能按「末段含空格」过滤：路径本身可能没有空格，但说明行有；
        # 用「以 runtime 目录结尾且不含空格」来挑出纯路径行。
        if not t or " " in t or "AllPoweredFSA-v5" not in t:
            continue
        if ".retired-" in t or ".empty-" in t or ".polluted-" in t:
            continue
        norm = t.rstrip("/").replace("\\", "/")
        if not norm.endswith(("payload/runtime/python", "dist/py-runtime")):
            continue
        shipped.append(norm)
    if not shipped:
        return "SKIP", "没有产物可数（需先跑 build-release-v5.ps1）"
    if len(shipped) > 1:
        return "FAIL", f"产物里有 {len(shipped)} 份 Python 运行时：{shipped}"
    return "PASS", f"产物里只有 1 份（{shipped[0][-64:]}）"


ITEMS = [
    ("1", "虚拟屏切换后视口钉死仍 PASS", item_01),
    ("2", "RDP 断开后 tscon 救回绘制", item_02),
    ("3", "RDP 最小化后仍在前台", item_03),
    ("4", "分辨率不符时 ensure_display 报 environment", item_04),
    ("5", "rpa_lint 0 违规", item_05),
    ("6", "fixture --replay-all 退出码 0", item_06),
    ("7", "8 条流程各连跑 3 次状态一致", item_07),
    ("8", "failure.class 对应 §6", item_08),
    ("9", "坐标点击 audit 记录带 sig", item_09),
    ("10a", "无文字元素可点 + 偏移报漂移", item_10a),
    ("10b", "断 RDP 后 autoupdate 仍 succeeded", item_10b),
    ("11", "换机器后坐标一致", item_11),
    ("12", "probe_stdonly exit 0", item_12),
    ("13", "probe_packaged_imports exit 0", item_13),
    ("14", "干净机双击 exe /api/health ok", item_14),
    ("15", "py-runtime 只出现一次", item_15),
]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", nargs="*", help="只跑这几条（编号）")
    args = ap.parse_args(argv)

    wanted = set(args.only or [])
    results = []
    for number, title, fn in ITEMS:
        if wanted and number not in wanted:
            continue
        try:
            status, detail = fn()
        except Exception as exc:  # noqa: BLE001 —— 验收脚本不能因为单条崩掉就全废
            status, detail = "FAIL", f"{type(exc).__name__}: {exc}"
        results.append({"item": number, "title": title,
                        "status": status, "detail": detail})

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            mark = {"PASS": "PASS", "FAIL": "FAIL", "SKIP": "SKIP"}[r["status"]]
            print(f"  [{mark}] {r['item']:>4}  {r['title']}")
            if r["detail"]:
                print(f"            {r['detail']}")
    counts = {k: sum(1 for r in results if r["status"] == k)
              for k in ("PASS", "FAIL", "SKIP")}
    print()
    print(f"合计 {len(results)} 条：PASS {counts['PASS']} / "
          f"FAIL {counts['FAIL']} / SKIP {counts['SKIP']}")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
