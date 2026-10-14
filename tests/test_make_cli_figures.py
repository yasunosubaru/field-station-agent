#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`tools/make_cli_figures.py` 的前置判断测试（KI-05 补覆盖；依赖背景见 KI-09）。

三条断言：

1. `--help` 退出码 0 —— 帮助路径不触发渲染，因而**不依赖 matplotlib**；
2. **关键**：matplotlib 缺席时优雅中止 —— 打印明确的 `[阻断]` 说明、
   退出码 2、**不崩在 ImportError**（无 Traceback）、不创建输出目录、
   更不产假图。这正是 KI-09 豁免的可选依赖应有的降级方式：缺它只影响出图，
   不该把整条命令变成一次堆栈倾倒；
3. 按环境分支的渲染实测：matplotlib 在位 → 真渲染一张 PNG 到临时目录；
   缺席 → 必须走第 2 条同款优雅路径。**不用 `skip`**（本仓库 skip==0 是
   门禁，`harness/selftest.py` 第 1 项把任何 skip 判 FAIL）。

## matplotlib 缺席怎么模拟

在 `PYTHONPATH` 头部垫一个目录，里面放一个 import 时就 `raise ImportError`
的 `matplotlib.py` —— 与未安装时 `import matplotlib` 的效果逐字一致，
且**在装了与没装 matplotlib 的机器上都能复现**（垫片永远排在
site-packages 前面）。曾在无 matplotlib 的子进程里实测：退出码 2、
`[阻断]` 文案、零 Traceback（见 issue #5 报告）。

输出目录一律指向临时目录：`figures/` 整棵入库（见 `.gitignore` 注释），
测试往仓库里写 PNG 会污染 `git status`。
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "make_cli_figures.py"


def _run(args, extra_pythonpath=None):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    if extra_pythonpath:
        env["PYTHONPATH"] = (extra_pythonpath + os.pathsep
                             + env.get("PYTHONPATH", ""))
    r = subprocess.run([sys.executable, str(TOOL), *args],
                       cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=env,
                       timeout=300)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def _matplotlib_importable() -> bool:
    """当前环境能否 import matplotlib（子进程判定，不在测试进程里加载它）。"""
    return subprocess.run([sys.executable, "-c", "import matplotlib"],
                          capture_output=True).returncode == 0


def _make_shim(shim_dir: Path) -> str:
    """造一个「无 matplotlib」环境：import 即 ImportError，等价于未安装。"""
    shim_dir.mkdir(parents=True, exist_ok=True)
    (shim_dir / "matplotlib.py").write_text(
        'raise ImportError("matplotlib 缺席（测试垫片，模拟未安装）")\n',
        encoding="utf-8")
    return str(shim_dir)


class TestMakeCliFigures(unittest.TestCase):
    def test_help_exits_zero_without_touching_render(self):
        rc, out = _run(["--help"])
        self.assertEqual(rc, 0, out)
        self.assertIn("usage", out)
        self.assertIn("--command", out)

    def test_missing_matplotlib_aborts_gracefully(self):
        with tempfile.TemporaryDirectory() as td:
            shim = _make_shim(Path(td) / "shim")
            out_dir = Path(td) / "figures"
            rc, out = _run(["--out", str(out_dir)], extra_pythonpath=shim)
            # 优雅中止的四要件：
            self.assertEqual(rc, 2, out)                       # 明确的失败码
            self.assertIn("[阻断]", out)                        # 人能读懂的原因
            self.assertIn("matplotlib", out)
            self.assertNotIn("Traceback (most recent call last)", out)  # 不崩堆栈
            self.assertFalse(out_dir.exists(),                 # 不留半成品目录
                             f"matplotlib 缺席时不该创建输出目录: {out_dir}")

    def test_render_or_graceful_by_environment(self):
        # 环境分支而非 skip：两个环境都要断言工具行为正确，而不是跳过了事。
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td) / "figures"
            rc, out = _run(["--out", str(out_dir)])
            if _matplotlib_importable():
                self.assertEqual(rc, 0, out)
                self.assertTrue(list(out_dir.glob("*.png")),
                                f"在位却没渲染出 PNG: {out}\n{out_dir}")
                self.assertTrue(list((out_dir / "_raw").glob("*.txt")),
                                "原始输出没落盘（图里的字必须来自真实运行输出）")
            else:
                self.assertEqual(rc, 2, out)
                self.assertNotIn("Traceback (most recent call last)", out)


if __name__ == "__main__":
    unittest.main()
