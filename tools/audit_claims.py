#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""audit_claims.py —— 对交付文档里引用的每个数字逐条回源核对。

## 为什么需要这个

本项目（野外台站智能体）沿用「AI驱动电离层探测技术动态教材」项目的一条铁律：
**每个对外数字必须可由脚本回源复现**。结题材料里"凭记忆写数字"或"抄错来源"
的错法有一个共同特征——**各自内部完全自洽，没有任何一处会报错**，唯一能暴露
它们的是回源核对。

## 三条纪律（自源项目原样保留）

1. **期望值从交付文档取值**，不硬编码。硬编码必然过时——仓库仍在增长，
   真正要检查的是"文档里写的那个数，是否等于仓库实际的数"。
2. **总量由实测值相加**，不得由分类声明值相加（后者会让错误永久自洽）。
3. **取不到数就说取不到**，绝不静默输出一个看似正常的错数字。

## 移植说明

源脚本为三仓库（教材/仿真/反演）结构而写，靠内容特征定位三个仓库的共同祖先。
本仓库是单仓库，故目录定位**重写**为 `pathlib.Path(__file__).resolve().parents[1]`
（仓库根），核对目标**重写**为本仓库 `README.md` 的机维护块（由
`tools/sync_code_counts.py` 生成）。核对项覆盖一条真实可回源的量——用
`git ls-files` 统计的入库 `.py` 文件数（`src/` 与 `tests/` 下）。

## 用法

    python tools/audit_claims.py              # 核对 README.md 的机维护块
    python tools/audit_claims.py --doc PATH   # 核对任意交付文档
    python tools/audit_claims.py --help

## 退出码

- 0：全部核对项通过
- 1：存在不符（FAIL）或无法回源（UNVERIFIED）的声明项
"""

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

# --- 目录定位：本仓库根（单仓库，直接上溯两级的可靠推导） --------------------
# 源脚本为三仓库结构写了内容特征扫描；本仓库只有一个仓库，`tools/` 恰在根下
# 一层，`parents[1]` 即仓库根。这与仓库里其他脚本（tests/test_layout.py）的
# 定位方式一致。
ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"

# 可回源核对的声明项标签。值由 `git ls-files` 现测，不在脚本里硬编码——
# 硬编码必然过时（仓库仍在增长），真正要查的是"文档写的 == 仓库实际的"。
CHECKABLE = ("入库 Python 文件数", "入库 Python 行数", "入库测试文件数")

# 声明行形如「标签：数字」或「标签：**数字** 单位」。标签不含冒号/竖线/星号，
# 数字允许千分位逗号。只认「冒号紧跟数字」这一种形状，避免把正文里的
# 「表 | 0 件」这类无冒号写法误当声明。
_CLAIM_RE = re.compile(
    r"(?P<label>[^\u3000：:\n|*]{1,60})[：:]\s*\*{0,2}\s*(?P<num>[0-9][0-9,]*)"
)


def _int(s):
    """把捕获到的数字串转成整数；转不了返回 None（不猜）。"""
    if s is None:
        return None
    v = re.sub(r"[^0-9]", "", str(s))
    return int(v) if v else None


def _tracked_py():
    """git 权威口径：返回 `src/` 与 `tests/` 下入库的 `.py` 相对路径列表。

    源脚本在本机踩过「`git ls-files '*.py'` 间歇性返回空」的坑，故带空结果重试。
    """
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


def _line_count(files):
    """读每个入库文件并累加行数；任一读不到即整体返回 None（拒绝被缩小的数字）。"""
    for _ in range(6):
        total = 0
        failed = []
        for rel in files:
            try:
                total += len((ROOT / rel).read_text("utf-8", errors="replace").splitlines())
            except OSError:
                failed.append(rel)
        if not failed:
            return total
        time.sleep(0.5)
    return None


def _measure(label, files):
    if label == "入库 Python 文件数":
        return len(files)
    if label == "入库测试文件数":
        return len([f for f in files if f.startswith("tests/")])
    if label == "入库 Python 行数":
        return _line_count(files)
    return None


def _claims_from(text):
    """从文档正文抽出所有「标签：数字」声明，返回 [(标签, 数值 int), ...]。"""
    out = []
    for line in text.split("\n"):
        for m in _CLAIM_RE.finditer(line):
            label = m.group("label").strip().lstrip("-*•·> \t").strip().strip("`").strip()
            n = _int(m.group("num"))
            if label and n is not None:
                out.append((label, n))
    return out


def audit(doc_text, files):
    """逐条核对，返回 [(标签, 文档值, 实测值, 结论, 说明), ...]。

    结论四档：PASS（相符）/ FAIL（不符）/ SKIP（可核对但取不到数）/
    UNVERIFIED（无法回源核对）。
    """
    rows = []
    for label, stated in _claims_from(doc_text):
        if label in CHECKABLE:
            actual = _measure(label, files)
            if actual is None:
                rows.append((label, stated, None, "SKIP", "取数失败，非通过"))
            elif stated == actual:
                rows.append((label, stated, actual, "PASS", "git ls-files 权威口径"))
            else:
                rows.append((label, stated, actual, "FAIL", "文档写 %s，实测 %s" % (stated, actual)))
        else:
            rows.append((label, stated, None, "UNVERIFIED",
                         "无法回源核对：该标签不在可核对清单内"))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="对交付文档里引用的每个数字逐条回源核对（git 权威口径）。")
    ap.add_argument("--doc", default=None,
                    help="要核对的文档路径；缺省核对 README.md 的机维护块")
    args = ap.parse_args(argv)

    doc_path = Path(args.doc).resolve() if args.doc else README
    if not doc_path.exists():
        print(f"[阻断] 找不到要核对的文档：{doc_path}")
        return 2
    doc_text = doc_path.read_text("utf-8", errors="replace")

    files = _tracked_py()
    if not files:
        print("[阻断] git ls-files 未返回任何 src/ 或 tests/ 下的 .py 文件，"
              "本次核对作废（拒绝在空数字上核对）。")
        return 2

    rows = audit(doc_text, files)
    if not rows:
        print("未发现任何「标签：数字」形式的可核对声明（0 项）。")
        return 0

    w = max(len(r[0]) for r in rows)
    print(f"{'声明项':<{w}}  {'文档中':<10} {'实测':<10} 结论")
    print("-" * (w + 38))
    nf = ns = nu = 0
    for label, stated, actual, verdict, why in rows:
        nf += verdict == "FAIL"
        ns += verdict == "SKIP"
        nu += verdict == "UNVERIFIED"
        print(f"{label:<{w}}  {str(stated):<10} {str(actual if actual is not None else '—'):<10} {verdict}")

    print()
    print(f"核对 {len(rows)} 项：PASS {len(rows)-nf-ns-nu}，FAIL {nf}，"
          f"SKIP {ns}，UNVERIFIED {nu}")
    if nf:
        print("\nFAIL 逐项：")
        for label, stated, actual, verdict, why in rows:
            if verdict == "FAIL":
                print(f"  {label}: 文档写 {stated}，实测 {actual}")
    if nu:
        print("\nUNVERIFIED 逐项（无法回源核对）：")
        for label, stated, actual, verdict, why in rows:
            if verdict == "UNVERIFIED":
                print(f"  {label}: 文档写 {stated}，{why}")
    if ns:
        print("\nSKIP 逐项（取数失败，非通过）：")
        for label, stated, actual, verdict, why in rows:
            if verdict == "SKIP":
                print(f"  {label}: {why}")

    print("\n注：本脚本只判断『文档写的数字是否等于仓库实际状态』，"
          "不判断数字背后的业务内容。")
    return 1 if (nf or nu) else 0


if __name__ == "__main__":
    sys.exit(main())
