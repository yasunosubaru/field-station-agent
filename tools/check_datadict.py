#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_datadict.py —— M1 数据字典的完整性门禁。

## 为什么需要这个

M1-a 的交付物是 `docs/m1/数据字典.md`，验收标准写着「每个字段都有单位与采样率」。
用眼睛核对这句话，等于没有门禁 —— 提交者说填完了就当填完了。本项目的铁律是
**每个对外声明都要能由脚本回源核对**，数据字典的完整性也该受同一条铁律管。

判据因此变成机器说了算：状态写成「完成」，但必填列有空，退出码就非 0。

## 两种状态

| 状态 | 含义 | 门禁行为 |
|---|---|---|
| `草稿` | M1 进行中，表还没填完 | 只报状态与待补数，**不算失败** |
| `完成` | 声称填完了 | 必填列逐格核对，缺一即非 0 退出 |

分成两态是有意的：M1 开局的骨架表是空的，那不是缺陷。把草稿态也判成失败，
门禁就会在第一周天天红，红久了就没人看了。

## 「待补」怎么算

`待补：厂家没给采样率` —— 合法交付，计入待补数。
`待补`（后面没原因）—— 等于漏填，判失败。
理由是「暂时拿不到」有信息量，「不知道」没有。

## 用法

    python tools/check_datadict.py                    # 核对仓库里的数据字典
    python tools/check_datadict.py --doc PATH         # 核对任意一份

## 退出码

- ``0``：通过（草稿态，或完成态且必填列齐全）
- ``1``：完成态下有漏填，逐行逐列列出
- ``2``：阻断（文件不在 / 状态值非法 / 表头对不上 schema）
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DOC = ROOT / "docs" / "m1" / "数据字典.md"

#: 字段表的列序。**顺序与名字都是契约** —— 表头对不上即阻断，
#: 不当漏填处理：让人去改格式，而不是让脚本去猜他写了什么。
SCHEMA = ("字段", "单位", "采样率", "单位类型", "允许范围",
          "缺失标记", "质控判据", "来源设备", "备注")

#: 必须非空的列。允许范围与备注可以留空 —— 有些字段本就没有范围。
REQUIRED = ("字段", "单位", "采样率", "单位类型", "缺失标记", "质控判据", "来源设备")

#: 允许的状态取值
STATUSES = ("草稿", "完成")

_STATUS_RE = re.compile(r"^\s*状态[：:]\s*(\S+)\s*$", re.M)
_PENDING_RE = re.compile(r"^待补\s*[：:]\s*\S")
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)


def _cells(line: str):
    """把一行 Markdown 表格切成单元格；不是表格行则返回 None。"""
    s = line.strip()
    if not s.startswith("|"):
        return None
    if s.endswith("|"):
        s = s[1:-1]
    return [c.strip() for c in s.split("|")]


def _is_separator(cells) -> bool:
    return all(c and set(c) <= set("-: ") for c in cells)


def parse(text: str):
    """抽出状态与字段行。

    返回 ``(status, rows, err)``：``err`` 非 None 表示结构性问题
    （表头找不到 / 状态值非法），需要人改格式；草稿态下表头缺失不算错。
    """
    # 先整体摘掉 HTML 注释块再逐行处理。**必须先摘**：注释块里常有以 `|` 开头的
    # 表格示例（人就是这么写文档的），逐行判断只能挡住单行注释，
    # 跨行注释的中间行会被当成真数据行 —— 实测踩过，检查器把示例数成了字段行。
    text = _COMMENT_RE.sub("", text)

    m = _STATUS_RE.search(text)
    status = m.group(1) if m else None
    if status not in STATUSES:
        return None, None, f"状态值非法：{status!r}（只能是 {' / '.join(STATUSES)}）"

    lines = text.splitlines()
    for i, line in enumerate(lines):
        cells = _cells(line)
        if not cells or tuple(cells) != SCHEMA:
            continue
        rows = []
        for follow in lines[i + 1:]:
            # 摘掉注释块会在原处留下空行。**空行不终止表格**：否则注释块下方
            # 的真实数据行会被丢掉（实测踩过，单行注释与跨行注释都会踩）。
            if not follow.strip():
                continue
            fc = _cells(follow)
            if fc is None:
                break
            if _is_separator(fc):
                continue
            if len(fc) != len(SCHEMA):
                break
            rows.append(dict(zip(SCHEMA, fc)))
        return status, rows, None

    return status, [], "没找到符合 schema 的字段表（表头必须逐列等于：" + " | ".join(SCHEMA) + "）"


def _is_pending_filled(value: str) -> bool:
    """带原因的「待补」算填了；光秃秃的「待补」算没填。"""
    return bool(_PENDING_RE.match(value))


def check(status: str, rows):
    """返回 (漏填清单, 待补单元数)。"""
    problems = []
    pending = 0
    for idx, row in enumerate(rows, 1):
        for col in REQUIRED:
            val = (row.get(col) or "").strip()
            if not val:
                problems.append(f"  第 {idx} 行 [{row.get('字段') or '?'}] 的「{col}」为空")
                continue
            if val.startswith("待补"):
                if _is_pending_filled(val):
                    pending += 1
                else:
                    problems.append(f"  第 {idx} 行 [{row.get('字段')}] 的「{col}」写了待补但没给原因")
    return problems, pending


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="M1 数据字典完整性门禁")
    ap.add_argument("--doc", default=None, help="要核对的数据字典路径")
    args = ap.parse_args(argv)

    doc = Path(args.doc).resolve() if args.doc else DEFAULT_DOC
    if not doc.exists():
        print(f"[阻断] 找不到数据字典：{doc}")
        return 2

    status, rows, err = parse(doc.read_text(encoding="utf-8", errors="replace"))

    if status is None:
        print(f"[阻断] {err}")
        return 2

    problems, pending = check(status, rows or [])
    n = len(rows or [])

    print("=" * 68)
    print(f"数据字典完整性检查  ——  {doc.name}")
    print("=" * 68)
    print(f"状态      {status}")
    print(f"字段行数  {n}")
    print(f"待补单元格 {pending} 处")

    if status == "草稿":
        if err:
            print(f"结构      {err}")
        print()
        print("草稿态不判失败。填完把「状态」改成「完成」，必填列的漏填才会拦下来。")
        return 0

    if err:
        print(f"[阻断] {err}")
        return 2

    if not n:
        print()
        print("[阻断] 状态是「完成」但一行字段都没有。")
        return 2

    if problems:
        print()
        print(f"漏填 {len(problems)} 处：")
        for p in problems:
            print(p)
        print()
        print("必填列：" + "、".join(REQUIRED))
        print("暂时拿不到的写「待补：原因」——有原因的待补算填了，光写「待补」不算。")
        return 1

    print()
    print(f"[OK] {n} 个字段，必填列齐全。" + (f"其中 {pending} 处为带原因的待补。" if pending else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())