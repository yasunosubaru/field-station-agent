#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`src/fieldstation/cli.py`（spec §2「统一入口」叶子）的行为测试。

四条断言钉住最小可用面（issue #5 / KI-08）：

1. `--help` 退出码 0 且输出里列得出全部子命令 —— 一个不输出帮助的入口
   会让人以为命令名记错了，转头去翻源码；
2. **未知子命令退出码必须非 0**（实为 argparse 的用法错误码 2）——
   静默忽略打错的命令名，等于把 `selftset` 这种手误也「跑成功了」；
3. 缺子命令同样非 0 并给出用法；
4. 子命令真的转发：以 `selftest --item 2` 实测，参数透传、退出码与
   目标脚本自己的输出一字不差（转发不重实现，见 cli.py 模块 docstring）。

子进程编码口径沿用 `tests/test_audit_claims.py::_run` 的成对约定：
子进程 `PYTHONIOENCODING=utf-8` + 父进程 `encoding="utf-8"`，缺一即在
默认 locale（本机 GBK）环境踩线。
"""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _run(*args):
    """以 README 记载的用法（`python -m fieldstation.cli`）跑一次入口。"""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    r = subprocess.run(
        [sys.executable, "-m", "fieldstation.cli", *args],
        cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
        errors="replace", env=env, timeout=300)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


class TestCli(unittest.TestCase):
    def test_help_exits_zero_and_lists_every_subcommand(self):
        rc, out = _run("--help")
        self.assertEqual(rc, 0, out)
        self.assertIn("usage", out)
        for name in ("selftest", "replay", "audit", "sync", "figures"):
            with self.subTest(subcommand=name):
                self.assertIn(name, out)
        # 入口名要出现在 usage 行里，否则报错时无从定位是哪个程序在说话。
        self.assertIn("fieldstation.cli", out)

    def test_unknown_subcommand_exits_2(self):
        # 2 是 argparse 的用法错误码。断言具体值而非"非 0"：RED 阶段
        # （cli.py 还不存在）子进程退出码恰好是 1（ModuleNotFoundError），
        # 宽松的"非 0"会让这条用例在错误的前提下假绿。
        rc, out = _run("no-such-subcommand")
        self.assertEqual(rc, 2, out)
        self.assertIn("invalid choice", out)

    def test_no_subcommand_prints_usage_and_fails(self):
        rc, out = _run()
        self.assertEqual(rc, 2, out)
        self.assertIn("usage", out)

    def test_subcommand_forwards_to_harness(self):
        # 用 selftest 第 2 项做转发实测：只扫 .py 文件，秒级且与仓库状态解耦
        # （第 1 项会嵌跑整套测试，在测试里再跑测试，慢且互相纠缠）。
        rc, out = _run("selftest", "--item", "2")
        self.assertEqual(rc, 0, out)
        self.assertIn("[2]", out)      # 目标脚本自己的分项标题
        self.assertIn("PASS", out)     # 目标脚本自己的结论行


if __name__ == "__main__":
    unittest.main()
