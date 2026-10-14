#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cli.py —— 仓库统一入口（spec §2 目录树的「统一入口」叶子）。

## 这是什么

把 M0 已有的五个纪律命令收进一个门：**只转发，不重实现**。

    $env:PYTHONPATH="src"; python -m fieldstation.cli --help
    $env:PYTHONPATH="src"; python -m fieldstation.cli selftest
    $env:PYTHONPATH="src"; python -m fieldstation.cli selftest --item 1,3
    $env:PYTHONPATH="src"; python -m fieldstation.cli replay --fixture harness/fixtures/replay_20261013.json
    $env:PYTHONPATH="src"; python -m fieldstation.cli audit
    $env:PYTHONPATH="src"; python -m fieldstation.cli sync
    $env:PYTHONPATH="src"; python -m fieldstation.cli figures --command "python tools/audit_claims.py"

子命令名后的参数经 `argparse.REMAINDER` **原样透传**给目标脚本
（含目标自己的 `--help`），退出码也原样回传 —— 本文件不做任何解释、
包装或吞错。目标脚本各自的用法见 `harness/REPRODUCE.md`。

## 边界（M0 裁定，登记于 docs/known-issues.md KI-08）

M0 的 cli 只做**工具分发**（上表五条）。智能体编排入口 —— 真模型通道、
角色配置、多轮任务 —— 属 M3，不在本文件预铺：没有真 provider 与真数据时
写那层是投机骨架。两者的分界线是**有没有转发目标**：M0 五个子命令后面
站着五个已实测的脚本；M3 要加的子命令等它背后的实现落地再加。

## 退出码

- ``0``：转发目标退出码 0（``--help`` 亦为 0）；
- ``2``：用法错误（未知子命令 / 缺子命令），由 argparse 判定；
- 其余非 0：**原样透传**转发目标的退出码。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent          # src/fieldstation/
ROOT = _HERE.parents[1]                          # 仓库根
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

#: 子命令 -> 转发目标（相对仓库根）。**用子进程转发**而不是 import 后调
#: ``main()``：harness/ 与 tools/ 的脚本都不是包成员，各有自己的 sys.path
#: 注入与输出编码处理，二次包装只会让两边口径分叉；子进程则参数、stdout、
#: 退出码天然逐字透传。
COMMANDS = {
    "selftest": "harness/selftest.py",
    "replay": "harness/replay.py",
    "audit": "tools/audit_claims.py",
    "sync": "tools/sync_code_counts.py",
    "figures": "tools/make_cli_figures.py",
}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m fieldstation.cli",
        description="仓库统一入口：转发到 harness/ 与 tools/ 的纪律命令（只转发，不重实现）。",
        epilog="子命令对照表：\n"
               + "\n".join(f"  {name:<9} -> {tgt}" for name, tgt in COMMANDS.items())
               + "\n各命令自己的参数原样透传，用 <子命令> --help 查看。",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", choices=sorted(COMMANDS),
                    help="要跑的子命令")
    ap.add_argument("args", nargs=argparse.REMAINDER,
                    help="原样转发给目标脚本的参数")
    ns = ap.parse_args(argv)

    if not ns.command:                 # 缺子命令：给用法，按用法错误退 2
        ap.print_help(sys.stderr)
        return 2

    target = ROOT / COMMANDS[ns.command]
    if not target.is_file():            # 布局被改坏时明确报错，不默跑
        print(f"[阻断] 转发目标不存在：{target}")
        return 2

    # REMAINDER 会把紧跟子命令的前导 "--" 一并带过来；转发前剥掉一层，
    # 否则 `cli selftest -- --item 2` 与 `cli selftest --item 2` 行为不同，
    # 而目标脚本自己根本不需要这层分隔（argparse 的 REMAINDER 语义残留）。
    rest = list(ns.args)
    while rest and rest[0] == "--":
        rest.pop(0)

    proc = subprocess.run(
        [sys.executable, str(target), *rest], cwd=str(ROOT))
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
