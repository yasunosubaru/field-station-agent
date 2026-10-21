#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成软件著作权材料的「源程序文档」（前 30 页 + 后 30 页，每页 50 行）。

## 只收本仓原创代码

软著材料要避开「搬运件」的展示争议（issue #68）。本生成器只收：

* ``src/fieldstation/agents/`` —— 运行时、总线、链路、黑板、工具、provider、trace；
* ``tools/`` —— 仓库自己的工具（回放、看板、台账、脱敏守卫、环境快照…）；
* ``harness/`` —— 回放与演示 harness。

**不收**：

* 派生自作者前序项目（GNSS接收机TEC反演）的模块 —— ``src/fieldstation/ingest/``、
  ``rules/``、``model.py``、``constants.py``、``synthetic.py``、``store/product.py``；
* 从作者其他项目**移植**的工具 —— ``tools/audit_claims.py``、
  ``tools/sync_code_counts.py``、``tools/make_cli_figures.py``、``harness/selftest.py``。

它们由 ``PROVENANCE.md`` 与各文件头部的「移植说明」登记。说明书里会写明这一点，
口径与 PROVENANCE 一致。

## 页格式

每页 50 行：第一行是页眉（软件名 + 版本 + 第 N 页 / 共 M 页），随后 50 行源码；
文件切换处有一行 ``# ===== 文件：<路径> =====``。超过 100 字符的行硬折行（续行缩进 4 格），
保证一页 50 行在 A4 上放得下。

## 输出

- ``docs/m7/软著-源程序.txt``：前 30 页 + 后 30 页（若总页数 ≤ 60 则全收）；
- ``logs/copyright_source_summary.json``：文件数 / 行数 / 总页数 / 展示页 / sha256。

确定性：文件按路径排序、无时间戳，两次生成逐字节相同。

用法：
    python tools/make_copyright_source.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SOFTWARE_NAME = "野外台站智能体运行与评估系统"
SOFTWARE_VERSION = "V1.0"
LINES_PER_PAGE = 50
HEAD_LINES = 30
TAIL_LINES = 30
WRAP_AT = 100
#: 只收本仓原创代码（派生件见 PROVENANCE.md）
INCLUDE_DIRS = ("src/fieldstation/agents", "tools", "harness")
#: 从作者其他项目移植的文件（各文件头有「移植说明」），不进软著源程序
EXCLUDE_FILES = (
    "tools/audit_claims.py",
    "tools/sync_code_counts.py",
    "tools/make_cli_figures.py",
    "harness/selftest.py",
)
DEFAULT_OUT = ROOT / "docs" / "m7" / "软著-源程序.txt"
DEFAULT_SUMMARY = ROOT / "logs" / "copyright_source_summary.json"


def source_files() -> list[Path]:
    """原创源码文件（按 INCLUDE_DIRS 顺序，目录内按路径排序；排除移植件）。

    顺序即软著源程序文档的展示顺序：核心运行时（agents）在前，harness 居中，
    tools 在后 —— 前 30 页展示的必须是软件本体，而不是周边工具。
    """
    files: list[Path] = []
    for rel in INCLUDE_DIRS:
        base = ROOT / rel
        if not base.is_dir():
            continue
        group: list[Path] = []
        for path in base.rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            if path.relative_to(ROOT).as_posix() in EXCLUDE_FILES:
                continue
            group.append(path)
        files.extend(sorted(group, key=lambda p: p.relative_to(ROOT).as_posix()))
    return files


def _wrapped(lines: list[str]) -> list[str]:
    out: list[str] = []
    for line in lines:
        text = line.rstrip("\n")
        if len(text) <= WRAP_AT:
            out.append(text)
            continue
        out.append(text[:WRAP_AT])
        rest = text[WRAP_AT:]
        while rest:
            out.append("    " + rest[:WRAP_AT - 4])
            rest = rest[WRAP_AT - 4:]
    return out


def collect_lines() -> tuple[list[str], int]:
    """拼出完整源码行序列；返回 (行, 文件数)。"""
    lines: list[str] = []
    files = source_files()
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        lines.append(f"# ===== 文件：{rel} =====")
        lines.extend(_wrapped(path.read_text(encoding="utf-8").splitlines()))
        lines.append("")
    return lines, len(files)


def paginate(lines: list[str], *, per_page: int = LINES_PER_PAGE) -> list[list[str]]:
    return [lines[i:i + per_page] for i in range(0, len(lines), per_page)]


def render(lines: list[str], *, per_page: int = LINES_PER_PAGE) -> str:
    pages = paginate(lines, per_page=per_page)
    total = len(pages)
    if total <= HEAD_LINES + TAIL_LINES:
        shown = list(range(total))
    else:
        shown = list(range(HEAD_LINES)) + list(range(total - TAIL_LINES, total))
    out: list[str] = [
        f"{SOFTWARE_NAME} {SOFTWARE_VERSION} —— 源程序文档",
        f"共 {total} 页（每页 {per_page} 行）；本文件展示前 {HEAD_LINES} 页与后 {TAIL_LINES} 页。",
        "只含本仓原创代码；派生自作者前序项目的模块见 PROVENANCE.md，不在本文件中展示。",
        "",
    ]
    for index in shown:
        number = index + 1
        header = (f"{SOFTWARE_NAME} {SOFTWARE_VERSION}"
                  f"{' ' * max(1, 60 - len(SOFTWARE_NAME) - len(SOFTWARE_VERSION))}"
                  f"第 {number} 页 / 共 {total} 页")
        out.append(header)
        out.extend(pages[index])
        out.append("")
        out.append("-" * 78)
    return "\n".join(out) + "\n"


def build(out_path: Path, summary_path: Path) -> dict:
    lines, n_files = collect_lines()
    text = render(lines)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    total_pages = len(paginate(lines))
    try:
        shown = out_path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        shown = out_path.name
    summary = {
        "kind": "fieldstation.copyright_source.summary",
        "version": 1,
        "software": {"name": SOFTWARE_NAME, "version": SOFTWARE_VERSION},
        "include_dirs": list(INCLUDE_DIRS),
        "files": n_files,
        "lines": len(lines),
        "lines_per_page": LINES_PER_PAGE,
        "pages_total": total_pages,
        "pages_shown": min(total_pages, HEAD_LINES + TAIL_LINES),
        "document": shown,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    with summary_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(summary, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    return summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="生成软著源程序文档（前 30 + 后 30 页）")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--summary", default=str(DEFAULT_SUMMARY))
    args = parser.parse_args(argv)
    summary = build(Path(args.out), Path(args.summary))
    print(f"[OK] {summary['document']}：{summary['files']} 文件 / {summary['lines']} 行 / "
          f"共 {summary['pages_total']} 页，展示 {summary['pages_shown']} 页")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
