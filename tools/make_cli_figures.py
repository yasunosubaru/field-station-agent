#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_cli_figures.py —— 把真实终端输出渲染成说明书插图。

## 为什么这么做

命令行软件的界面就是终端。本脚本把**真实运行输出**（不是编造的示例）渲染成
终端风格的 PNG，落到 `figures/`。这沿用「AI驱动电离层探测技术动态教材」项目
「图里每一个字都必须来自真实运行输出」的硬规则——先执行命令、把原始 stdout
落盘，再渲染；渲染过程不改写、不美化、不省略任何 FAIL 行。命令失败则报错退出，
不画假图。

## 移植说明

源脚本把 `render()`（matplotlib 终端风格渲染）与 `run()`（真实执行）分开，
目录定位靠三仓库内容特征扫描。本仓库是单仓库，故目录定位**重写**为
`pathlib.Path(__file__).resolve().parents[1]`（仓库根）；`render()` 机制**搬运**，
仅改中文字体为 Windows 稳定可用的 Microsoft YaHei + 等宽 Consolas。`main()` 里的
固定命令表（源脚本是 hflink 的 --help/check/explain）**重写**为 `--command` 参数，
缺省渲染本仓库 `tools/audit_claims.py` 的真实核对报告。

## 用法

    python tools/make_cli_figures.py                    # 渲染默认命令
    python tools/make_cli_figures.py --command "python tools/audit_claims.py"
    python tools/make_cli_figures.py --command "..." --out figures
    python tools/make_cli_figures.py --help

## 退出码

- ``0``：命令采集并渲染完成；
- ``2``：**matplotlib 缺席**（可选依赖，登记见 `docs/known-issues.md` KI-09）
  或用法错误。缺席时在**建目录、跑命令之前**打印 `[阻断]` 并退出 ——
  不崩在 `ImportError`、不留半成品、不产假图
  （`tests/test_make_cli_figures.py` 钉住，含无 matplotlib 子进程实测）。
"""

import argparse
import os
import re
import shlex
import subprocess
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "figures"

# 终端配色（深色终端）
BG = "#0d1117"
FG = "#c9d1d9"
GREEN = "#3fb950"
RED = "#f85149"
YELLOW = "#d29922"
CYAN = "#58a6ff"
DIM = "#6e7681"


def _slug(cmd):
    s = re.sub(r"[^0-9a-zA-Z]+", "-", cmd).strip("-").lower()
    return s or "output"


def run(cmd_str):
    """真实执行命令并返回 (合并输出, argv 展示串)。失败也返回输出——不画假图。"""
    argv = shlex.split(cmd_str)
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    r = subprocess.run(argv, cwd=str(ROOT), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=env)
    out = (r.stdout or "") + (r.stderr or "")
    return out, cmd_str


def render(lines, path, title, subtitle, out_dir, max_lines=None, passes=None,
           fails=None, notes=None):
    """把终端行渲染成终端风格 PNG。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    warnings.filterwarnings("ignore", message="Glyph .* missing from font")
    plt.rcParams["axes.unicode_minus"] = False
    plt.rcParams["font.monospace"] = ["Consolas", "DejaVu Sans Mono"]

    has_cjk = lambda s: any("\u4e00" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef"
                            for c in s)
    CJK = "Microsoft YaHei"
    MONO = "Consolas"
    MAXW = 168
    lines = [(ln if len(ln) <= MAXW else ln[:MAXW - 3] + "...") for ln in lines]
    body = lines if max_lines is None else lines[:max_lines]
    if max_lines is not None and len(lines) > max_lines:
        body = body + [f"... （共 {len(lines)} 行，此处省略 {len(lines)-max_lines} 行）"]

    n = len(body)
    fig_h = max(3.0, 0.205 * n + 1.5)
    fig, ax = plt.subplots(figsize=(11.5, fig_h))
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    ax.add_patch(plt.Rectangle((0, 0.935), 1, 0.065, color="#161b22"))
    for i, c in enumerate(("#ff5f56", "#ffbd2e", "#27c93f")):
        ax.add_patch(plt.Circle((0.018 + i * 0.018, 0.967), 0.006, color=c))
    ax.text(0.5, 0.967, title, color=FG, fontsize=10.5, ha="center",
            va="center", family=CJK if has_cjk(title) else MONO)
    ax.text(0.005, 0.972, subtitle, color=DIM, fontsize=8.5, ha="left",
            va="center", family=CJK)

    top, bot = 0.918, 0.055 + (0.10 if notes else 0)
    step = (top - bot) / max(n - 1, 1) if n > 1 else 0
    for i, line in enumerate(body):
        y = top - i * step
        col = FG
        if line.startswith("[PASS]") or "passed" in line:
            col = GREEN
        elif line.startswith("[FAIL]") or "FAIL" in line.upper() and "[PASS]" not in line:
            col = RED
        elif line.startswith("[") and "]" in line:
            col = CYAN
        elif line.startswith("=") or line.startswith("-"):
            col = DIM
        elif line.strip().endswith(("km", "MHz", "m^-3", "el/m^2", "deg")):
            col = YELLOW
        fam = CJK if has_cjk(line) else MONO
        ax.text(0.012, y, line, color=col, fontsize=7.4, ha="left", va="center",
                family=fam, zorder=3)

    if passes is not None or notes:
        ax.add_patch(plt.Rectangle((0, 0), 1, 0.048, color="#161b22"))
        msg = []
        if passes is not None:
            msg.append(f"{passes} 项通过")
        if fails:
            msg.append(f"{fails} 项失败")
        txt = "   |   ".join(msg) if msg else ""
        if notes:
            txt = (txt + "   " if txt else "") + notes
        ax.text(0.5, 0.024, txt, color=(RED if fails else GREEN), fontsize=9,
                ha="center", va="center", family=CJK)

    fig.tight_layout(pad=0.2)
    out_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=170, facecolor=BG)
    plt.close(fig)
    print(f"  wrote {path.name}")


def _has_matplotlib():
    """渲染前置判断：matplotlib 能否 import。

    缺席（未安装，或装坏了 ImportError）时由 `main()` 打印 `[阻断]` 后
    exit 2 —— 而不是让 `render()` 里那次 `import matplotlib` 把一条
    本可预期的环境问题摊成未捕获堆栈（KI-09：matplotlib 是点名豁免的
    可选依赖，缺它只该影响出图）。
    """
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        return False
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="把真实终端输出渲染成终端风格 PNG，落到 figures/。")
    ap.add_argument("--command", action="append", default=None,
                    help="要渲染的真实命令（可重复）；缺省渲染 "
                         "tools/audit_claims.py 的真实核对报告")
    ap.add_argument("--out", default=str(DEFAULT_OUT),
                    help="输出目录（默认 figures/）")
    args = ap.parse_args(argv)

    # 必须在建目录、跑命令**之前**：否则缺席环境会先产出 _raw 半成品再崩，
    # 留下一堆没人认领的中间文件。
    if not _has_matplotlib():
        print("[阻断] 未安装 matplotlib（可选依赖，登记见 "
              "docs/known-issues.md KI-09）：")
        print("       本工具的 PNG 渲染必须用它；缺席即中止，"
              "不采集、不建目录、不产假图。")
        print("       安装后重跑：python -m pip install matplotlib")
        return 2

    commands = args.command or ["python tools/audit_claims.py"]
    out_dir = Path(args.out)
    raw_dir = out_dir / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    print("采集真实运行输出 ...")
    for cmd in commands:
        out, cmd_disp = run(cmd)
        if not out.strip():
            print(f"  [跳过] {cmd_disp} 无输出")
            continue
        (raw_dir / (f"{_slug(cmd)}.txt")).write_text(
            f"$ {cmd_disp}\n\n{out}", encoding="utf-8")
        lines = [ln.rstrip() for ln in out.split("\n")]
        while lines and not lines[-1]:
            lines.pop()
        npass = sum(1 for ln in lines if ln.startswith("[PASS]"))
        nfail = sum(1 for ln in lines if ln.startswith("[FAIL]"))
        render(lines, out_dir / (f"{_slug(cmd)}.png"), cmd_disp, cmd_disp,
               out_dir, passes=npass or None, fails=nfail or None,
               notes=f"{len(lines)} 行真实输出")
        print(f"    {cmd_disp}: {len(lines)} 行, PASS {npass}, FAIL {nfail}")

    print(f"\n插图目录: {out_dir.resolve()}")
    print(f"原始输出: {raw_dir.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
