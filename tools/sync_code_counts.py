#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_code_counts.py —— 把 README 里的代码量表与仓库实际状态同步。

## 为什么需要它

结题材料里的代码量数字若由人手写，几小时就会过时（仓库仍在增长）。
本项目沿用「AI驱动电离层探测技术动态教材」项目的铁律：**权威口径用
`git ls-files`**，不用目录遍历——前者返回版本控制所记录的内容，确定、
可复现；后者随其他进程写入而漂移。本脚本据此把 README 的机维护块改写
成仓库的实际状态，**不手写**。

## 移植说明

源脚本为三仓库结构写的内容特征定位与三张表，本仓库是单仓库，故**重写**为
`pathlib.Path(__file__).resolve().parents[1]`（仓库根），只维护一张表（本仓库
自身 `src/` 与 `tests/` 下的入库 `.py`）。读文件失败整轮重试、绝不输出被缩小的
数字——这条纪律原样保留。

## 用法

    python tools/sync_code_counts.py
    python tools/sync_code_counts.py --help
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"

MARK_B = "<!-- CODE_COUNTS:BEGIN -->"
MARK_E = "<!-- CODE_COUNTS:END -->"
# 「现状」表里那行占位符。脚本把它改成指向下方机维护块，兑现
# spec §6 DoD 第 6 条「README『现状』一节由 sync_code_counts.py 同步更新」。
STATUS_ROW_ANCHOR = "| 代码量表 |"


def _tracked_py():
    """返回 src/ 与 tests/ 下入库的 .py 相对路径列表（带空结果重试）。"""
    for _ in range(6):
        r = subprocess.run(
            ["git", "ls-files"], cwd=str(ROOT),
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        files = [l for l in r.stdout.splitlines()
                 if l.endswith(".py") and (l.startswith("src/") or l.startswith("tests/"))]
        if files:
            return files
        time.sleep(0.2)
    return []


def _measure(files):
    """返回 (文件数, 行数, 测试文件数)。行数读不到即整轮重试，最终仍失败则抛错。"""
    for _ in range(6):
        total = 0
        failed = []
        for rel in files:
            try:
                total += len((ROOT / rel).read_text("utf-8", errors="replace").splitlines())
            except OSError:
                failed.append(rel)
        if not failed:
            break
        time.sleep(0.5)
    if failed:
        raise SystemExit(
            f"{len(failed)}/{len(files)} 个入库文件读不到，拒绝输出被缩小的数字："
            f"{', '.join(failed[:3])}")
    n_tests = len([f for f in files if f.startswith("tests/")])
    return len(files), total, n_tests


def _block(n_files, n_lines, n_tests):
    return "\n".join([
        MARK_B,
        "## 代码量（机维护，请勿手改）",
        "",
        f"- 入库 Python 文件数：**{n_files}** 个",
        f"- 入库 Python 行数：**{n_lines:,}** 行",
        f"- 入库测试文件数：**{n_tests}** 个",
        "",
        "> 口径：`git ls-files` 下 `src/` 与 `tests/` 内的 `.py` 文件；未入库文件不计。",
        "> 本块由 `tools/sync_code_counts.py` 生成，由 `tools/audit_claims.py` 回源核对，",
        "> 共用同一口径。",
        MARK_E,
    ])


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="把 README.md 的代码量机维护块与仓库实际状态同步（git 权威口径）。")
    ap.parse_args(argv)

    files = _tracked_py()
    if not files:
        print("[阻断] git ls-files 未返回任何 src/ 或 tests/ 下的 .py 文件。")
        return 2
    n_files, n_lines, n_tests = _measure(files)
    print(f"  src/+tests/ 入库 .py：{n_files} 文件，{n_lines:,} 行，"
          f"其中测试 {n_tests} 个")

    text = README.read_text("utf-8", errors="replace")
    new_block = _block(n_files, n_lines, n_tests)

    a, b = text.find(MARK_B), text.find(MARK_E)
    if a >= 0 and b > a:
        text = text[:a] + new_block + text[b + len(MARK_E):]
    else:
        # 尚未有标记块：插到「## 设计文档」之前（README 结构固定锚点）。
        anchor = "## 设计文档"
        k = text.find(anchor)
        if k < 0:
            print("[阻断] 未在 README.md 中找到「## 设计文档」锚点。")
            return 2
        text = text[:k] + new_block + "\n\n" + text[k:]

    # 兑现「现状」表那行占位符：改成指向机维护块。
    lines = text.split("\n")
    out = []
    for ln in lines:
        if ln.startswith(STATUS_ROW_ANCHOR):
            out.append("| 代码量表 | 见下方「代码量（机维护）」节 |")
        else:
            out.append(ln)
    text = "\n".join(out)

    README.write_text(text, encoding="utf-8", newline="")
    print(f"[OK] 已同步 {README.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
