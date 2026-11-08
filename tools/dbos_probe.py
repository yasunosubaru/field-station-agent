#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dbos_probe.py —— DBOS 能不能用的半天实证。

## 为什么要有这个

v5 计划 Bot-1 的前置：不先验完这四件事就写编排层，等于拿 DBOS 的 API 形状
赌一把。DBOS 3.x 的小版本之间 API 变过（``configure()`` 拆成 ``DBOS(...)``、
``launch()`` 变成实例方法等），押错的代价不是多写两行，是整层设计返工。

四件：

1. **能起、能出结果** —— ``DBOS(...).launch()`` + ``@workflow`` +
   ``start_workflow`` + ``get_result`` 走通。
2. **已完成的步骤不重跑** —— 进程被**强杀**（``os._exit``，不是异常退出）之后
   重启，工作流从断点续跑，**已经记完的那一步不重跑**。

   注意：崩溃瞬间**正在执行**的那一步会重跑一次（它还没被记为完成）。所以这里
   的判据是"已完成的不重跑"，不是"每步只跑一次"——后者永远不可能成立，见
   ``docs/operations/dbos.md`` §1.1。这条对本项目最贵：重跑一次工具调用就是
   重复扣 token、重复写文件，所以带副作用的动作必须能承受重跑。
3. **睡觉不占进程** —— ``DBOS.sleep()`` 等待期间进程可以退出，醒来后接着跑。
4. **能收发信号** —— ``DBOS.send`` / ``DBOS.recv``，人批准之后唤醒工作流。

## 怎么用

    python tools/dbos_probe.py            # 跑全部四项
    python tools/dbos_probe.py --item 2   # 只跑第 2 项

第 2、4 项要**跨进程**，脚本会 ``exec`` 自己（``--child``）来当那个"被杀掉再
重启"的进程。子进程只做一件事，父进程负责判分。

退出码：0 全过；1 有项没通过；2 用法错误。

只依赖 ``dbos`` 与标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable

#: 每个用例一个自己的目录，互不干扰；进程被杀之后目录还要留着给下一次读。
WORKDIR = Path(tempfile.gettempdir()) / "fsa-dbos-probe"


# --------------------------------------------------------------- 公共小工具 --
def _fresh(name: str) -> Path:
    """给一个用例准备干净目录。"""
    path = WORKDIR / name
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config(db_path: Path, *, name: str):
    from dbos import DBOSConfig

    return DBOSConfig(
        name=name,
        system_database_url=f"sqlite:///{db_path.as_posix()}",
    )


def _mark(path: Path, line: str) -> None:
    """追加一行执行痕迹。**必须立刻落盘**，否则进程被强杀会丢掉缓冲。"""
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _lines(path: Path) -> list[str]:
    if not path.is_file():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


def _report(ok: bool, title: str, detail: str) -> bool:
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {title}")
    for line in detail.strip().splitlines():
        print(f"         {line}")
    return ok


# ------------------------------------------------------------------ 第 1 项 --
def item1_launch_and_result() -> bool:
    """起得来、跑得完、拿得到结果。"""
    from dbos import DBOS, SetWorkflowID

    work = _fresh("item1")
    db = work / "dbos.sqlite"
    calls: list[str] = []

    dbos = DBOS(config=_config(db, name="probe1"))

    @dbos.workflow()
    def add(a: int, b: int) -> int:
        return double(a) + b

    @dbos.step()
    def double(value: int) -> int:
        calls.append(f"double({value})")
        return value * 2

    dbos.launch()
    try:
        with SetWorkflowID("probe-item1") as _:
            handle = dbos.start_workflow(add, 3, 4)
        result = handle.get_result()
        again = DBOS.get_workflow_status("probe-item1")
        detail = (
            f"add(3, 4) -> {result}（期望 10）\n"
            f"step 调用次数 {len(calls)}（期望 1 次）\n"
            f"工作流状态 {getattr(again, 'status', '?')}"
        )
        ok = (result == 10) and len(calls) == 1
    finally:
        dbos.destroy(destroy_registry=True)

    return _report(ok, "工作流能起、能出结果", detail)


# ------------------------------------------------------------------ 第 2 项 --
# 这一段在子进程里跑：写三个 step，每个 step 记一行，第 2 个 step 之后强杀。
_CHILD2 = r"""
import os, sys
from pathlib import Path
sys.path.insert(0, {root!r})
from dbos import DBOS, SetWorkflowID

work = Path({work!r})
db = work / "dbos.sqlite"
marker = work / "marker.txt"

dbos = DBOS(config={{'name': 'probe2', 'system_database_url': f'sqlite:///' + db.as_posix()}})

def _mark(line):
    with marker.open('a', encoding='utf-8') as f:
        f.write(line + '\n'); f.flush(); os.fsync(f.fileno())

@dbos.step()
def step_one():
    _mark('step1')
    return 1

@dbos.step()
def step_two():
    _mark('step2')
    return 2

@dbos.step()
def step_three():
    _mark('step3')
    return 3

@dbos.workflow()
def three_steps():
    a = step_one()
    b = step_two()
    if {kill_after_second}:
        # 强杀：模拟断电/被 Stop-Process。不走异常路径，不给清理机会。
        os._exit(9)
    c = step_three()
    return a + b + c

dbos.launch()
try:
    with SetWorkflowID('probe-item2'):
        dbos.start_workflow(three_steps)
    # 等到第 2 步写完就动手；正常情况根本走不到这里
    for _ in range(200):
        if 'step2' in marker.read_text(encoding='utf-8') if marker.exists() else False:
            break
        import time as _t; _t.sleep(0.05)
    _t.sleep(0.2)
    os._exit(9)
finally:
    dbos.destroy(destroy_registry=True)
"""

_CHILD2_RESUME = r"""
import os, sys
from pathlib import Path
sys.path.insert(0, {root!r})
from dbos import DBOS

work = Path({work!r})
db = work / "dbos.sqlite"
marker = work / "marker.txt"

dbos = DBOS(config={{'name': 'probe2', 'system_database_url': f'sqlite:///' + db.as_posix()}})

def _mark(line):
    with marker.open('a', encoding='utf-8') as f:
        f.write(line + '\n'); f.flush(); os.fsync(f.fileno())

@dbos.step()
def step_one():
    _mark('step1-replay')
    return 1

@dbos.step()
def step_two():
    _mark('step2-replay')
    return 2

@dbos.step()
def step_three():
    _mark('step3')
    return 3

@dbos.workflow()
def three_steps():
    a = step_one()
    b = step_two()
    c = step_three()
    return a + b + c

dbos.launch()
try:
    # launch() 会自动恢复未完成的工作流
    for _ in range(300):
        status = DBOS.get_workflow_status('probe-item2')
        if getattr(status, 'status', None) in ('SUCCESS', 'ERROR'):
            break
        import time as _t; _t.sleep(0.1)
    status = DBOS.get_workflow_status('probe-item2')
    result = None
    if getattr(status, 'status', None) == 'SUCCESS':
        result = DBOS.get_result('probe-item2')
    print('RESULT=' + repr(result))
    print('STATUS=' + str(getattr(status, 'status', '?')))
finally:
    dbos.destroy(destroy_registry=True)
"""


def item2_crash_resume() -> bool:
    """在一个 step **记完之后**强杀，重启后从断点续、已完成的那一步不重跑。

    杀点故意选在两步**之间**（``step_two`` 已返回、``step_three`` 还没开始），
    这样验的是"已提交的步骤不重跑"。如果杀点在某个步骤**当中**，那一步本来就
    必然重跑，是另一回事（见 ``docs/operations/dbos.md`` §1.1）。
    """
    work = _fresh("item2")
    marker = work / "marker.txt"

    first = subprocess.run(
        [PYTHON, "-c", _CHILD2.format(root=str(ROOT), work=str(work),
                                     kill_after_second="True")],
        capture_output=True, text=True, timeout=180)
    killed = [ln for ln in _lines(marker)]
    if first.returncode != 9:
        return _report(
            False, "已完成的步骤不重跑", 
            "子进程没有按预期被强杀（退出码 "
            f"{first.returncode}），无法验证续跑。\n"
            f"stderr: {first.stderr.strip()[:500]}")

    second = subprocess.run(
        [PYTHON, "-c", _CHILD2_RESUME.format(root=str(ROOT), work=str(work))],
        capture_output=True, text=True, timeout=180)
    after = _lines(marker)

    # 判据：step1 / step2 只出现过一次（续跑时不许再执行），step3 出现一次
    counts = {key: after.count(key) for key in
              ("step1", "step2", "step3", "step1-replay", "step2-replay")}
    status = "?"
    result = "?"
    for line in second.stdout.splitlines():
        if line.startswith("STATUS="):
            status = line.split("=", 1)[1]
        elif line.startswith("RESULT="):
            result = line.split("=", 1)[1]

    ok = (counts["step1"] == 1 and counts["step2"] == 1
          and counts["step1-replay"] == 0 and counts["step2-replay"] == 0
          and counts["step3"] == 1 and status == "SUCCESS")
    detail = (
        f"杀之前写了：{killed}\n"
        f"续跑之后总共：{after}\n"
        f"重放的 step1/step2 次数：{counts['step1-replay']}/{counts['step2-replay']}"
        "（必须都是 0）\n"
        f"续跑结果 {result}（期望 6），状态 {status}"
    )
    if second.returncode != 0:
        detail += f"\nstderr: {second.stderr.strip()[:500]}"
    return _report(ok, "已完成的步骤不重跑（杀进程后续跑）", detail)


# ------------------------------------------------------------------ 第 3 项 --
# 真正要验的是「睡觉期间进程可以死掉，醒来还能接着跑」——那是"等人批三天"
# 与 W7「杀进程重启继续」的共同前提。所以这里也是跨进程：睡着时强杀，重启后
# 看它是否补完，并且睡之前那步不重跑。
_CHILD3_START = r"""
import os, sys, threading, time
from pathlib import Path
sys.path.insert(0, {root!r})
from dbos import DBOS, SetWorkflowID

work = Path({work!r})
db = work / "dbos.sqlite"
marker = work / "marker.txt"

def _mark(line):
    with marker.open('a', encoding='utf-8') as f:
        f.write(line + '\n'); f.flush(); os.fsync(f.fileno())

dbos = DBOS(config={{'name': 'probe3', 'system_database_url': f'sqlite:///' + db.as_posix()}})

@dbos.step()
def before_sleep():
    _mark('before')
    return 1

@dbos.step()
def after_sleep():
    _mark('after')
    return 2

@dbos.workflow()
def wait_long():
    a = before_sleep()
    dbos.sleep(15)           # 十五秒：父进程在它睡着时下手，续跑只等剩下的十几秒
    b = after_sleep()
    return a + b

dbos.launch()

def _run():
    with SetWorkflowID('probe-item3'):
        dbos.start_workflow(wait_long)     # 立刻返回，工作流在后台跑

# 同步工作流里 sleep 会阻塞执行线程，用后台线程跑，主线程才能作证
threading.Thread(target=_run, daemon=True).start()

for _ in range(600):
    if marker.exists() and 'before' in marker.read_text(encoding='utf-8'):
        break
    time.sleep(0.05)
_mark('in-sleep')
time.sleep(180)              # 父进程若没杀掉，这里兜底
"""

_CHILD3_RESUME = r"""
import os, sys
from pathlib import Path
sys.path.insert(0, {root!r})
from dbos import DBOS

work = Path({work!r})
db = work / "dbos.sqlite"
marker = work / "marker.txt"

def _mark(line):
    with marker.open('a', encoding='utf-8') as f:
        f.write(line + '\n'); f.flush(); os.fsync(f.fileno())

dbos = DBOS(config={{'name': 'probe3', 'system_database_url': f'sqlite:///' + db.as_posix()}})

@dbos.step()
def before_sleep():
    _mark('before-replay')
    return 1

@dbos.step()
def after_sleep():
    _mark('after')
    return 2

@dbos.workflow()
def wait_long():
    a = before_sleep()
    dbos.sleep(15)
    b = after_sleep()
    return a + b

dbos.launch()
try:
    import time as _t
    for _ in range(1200):
        status = DBOS.get_workflow_status('probe-item3')
        if getattr(status, 'status', None) in ('SUCCESS', 'ERROR'):
            break
        _t.sleep(0.1)
    status = DBOS.get_workflow_status('probe-item3')
    result = DBOS.get_result('probe-item3') if getattr(status, 'status', None) == 'SUCCESS' else None
    print('RESULT=' + repr(result))
    print('STATUS=' + str(getattr(status, 'status', '?')))
finally:
    dbos.destroy(destroy_registry=True)
"""


def item3_sleep_releases_process() -> bool:
    """睡着的时候把进程杀掉，重启后接着跑完，且睡之前那步不重跑。"""
    work = _fresh("item3")
    marker = work / "marker.txt"

    child = subprocess.Popen(
        [PYTHON, "-c", _CHILD3_START.format(root=str(ROOT), work=str(work))],
        stdout=subprocess.DEVNULL, stderr=(work / "child.log").open("w", encoding="utf-8"))
    # 等到它真的进了 sleep
    for _ in range(600):
        if marker.exists() and "in-sleep" in marker.read_text(encoding="utf-8"):
            break
        if child.poll() is not None:
            break
        time.sleep(0.05)
    if child.poll() is not None:
        log = (work / "child.log").read_text(encoding="utf-8", errors="replace")
        return _report(False, "睡觉不占进程（可被杀）",
                       f"子进程提前退出了（{child.returncode}）\n{log[-600:]}")

    # 强杀：这是"等人批三天，进程不可能一直挂着"的那一下
    child.kill()
    child.wait(timeout=30)
    at_sleep = _lines(marker)

    second = subprocess.run(
        [PYTHON, "-c", _CHILD3_RESUME.format(root=str(ROOT), work=str(work))],
        capture_output=True, text=True, timeout=240)
    after = _lines(marker)

    status = "?"
    result = "?"
    for line in second.stdout.splitlines():
        if line.startswith("STATUS="):
            status = line.split("=", 1)[1]
        elif line.startswith("RESULT="):
            result = line.split("=", 1)[1]

    ok = (at_sleep.count("before") == 1
          and after.count("before-replay") == 0
          and after.count("after") == 1
          and status == "SUCCESS")
    detail = (
        f"睡着被杀时已写：{at_sleep}\n"
        f"重启之后总共：{after}\n"
        f"睡之前那步重跑次数：{after.count('before-replay')}（必须是 0）\n"
        f"续跑结果 {result}（期望 3），状态 {status}\n"
        "说明 sleep 是持久化的等待点：进程死了不丢，醒来从那儿接着跑"
    )
    if second.returncode != 0:
        detail += f"\nstderr: {second.stderr.strip()[:400]}"
    return _report(ok, "睡觉不占进程（被杀后续跑）", detail)


# ------------------------------------------------------------------ 第 4 项 --
def item4_send_recv() -> bool:
    """工作流停下等人，另一端 send 一条消息把它唤醒。"""
    from dbos import DBOS, SetWorkflowID

    work = _fresh("item4")
    db = work / "dbos.sqlite"
    dbos = DBOS(config=_config(db, name="probe4"))

    @dbos.workflow()
    def wait_for_approval() -> str:
        decision = dbos.recv("approval", timeout_seconds=30)
        return f"got:{decision}"

    dbos.launch()
    try:
        with SetWorkflowID("probe4-wait"):
            handle = dbos.start_workflow(wait_for_approval)
        time.sleep(1.0)
        dbos.send("probe4-wait", "approved", topic="approval")
        result = handle.get_result()
        ok = result == "got:approved"
        detail = f"recv 收到 {result!r}（期望 'got:approved'）"
    finally:
        dbos.destroy(destroy_registry=True)
    return _report(ok, "能收发信号（人批准后唤醒）", detail)


# ------------------------------------------------------------------- 驱动 --
ITEMS = {
    1: ("工作流能起、能出结果", item1_launch_and_result),
    2: ("已完成步骤不重跑", item2_crash_resume),
    3: ("睡觉不占进程", item3_sleep_releases_process),
    4: ("能收发信号", item4_send_recv),
}


def main(argv=None) -> int:
    global WORKDIR

    parser = argparse.ArgumentParser(description="DBOS 四件事实证")
    parser.add_argument("--item", type=int, choices=sorted(ITEMS),
                        help="只跑某一项")
    parser.add_argument("--workdir", default=str(WORKDIR),
                        help="临时目录（默认系统 temp）")
    args = parser.parse_args(argv)

    WORKDIR = Path(args.workdir)
    WORKDIR.mkdir(parents=True, exist_ok=True)

    selected = [args.item] if args.item else sorted(ITEMS)
    print(f"DBOS 实证：{len(selected)} 项")
    print(f"临时目录：{WORKDIR}")
    print()

    outcomes = {}
    for index in selected:
        title, fn = ITEMS[index]
        print(f"[{index}] {title}")
        try:
            outcomes[index] = fn()
        except Exception as exc:  # noqa: BLE001 - 实证脚本要报出任何炸法
            outcomes[index] = _report(
                False, title, f"{type(exc).__name__}: {exc}")
        print()

    passed = sum(1 for value in outcomes.values() if value)
    total = len(outcomes)
    print("=" * 68)
    print(f"  合计 {passed}/{total} 通过")
    print("=" * 68)

    verdict = {
        "passed": passed, "total": total,
        "items": {str(k): bool(v) for k, v in outcomes.items()},
    }
    (WORKDIR / "verdict.json").write_text(
        json.dumps(verdict, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
