#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_py_diff.py —— 逐个说明两份 Python 运行时差哪些文件。

`probe_py_payload.py` 给的是总量与「完全相同/不同」的判定；这个探针回答
**差异在哪**：少了哪些、是否可解释（字节码缓存、测试目录、pip 元数据等）。
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PAIRS = {
    "stage": REPO / "dist/_stage/app/payload/runtime/python",
    "prod": REPO / "dist/AllPoweredFSA-v5/AllPoweredFSA-dir/resources/app/payload/runtime/python",
}


def relset(root: Path) -> set[str]:
    return {str(p.relative_to(root)).replace("\\", "/") for p in root.rglob("*") if p.is_file()}


def bucket(rel: str) -> str:
    parts = rel.split("/")
    if "__pycache__" in parts:
        return "__pycache__（字节码缓存，可弃）"
    if parts[0] == "Lib" and len(parts) > 1:
        if parts[1] == "site-packages":
            return "Lib/site-packages（第三方包）"
        return f"Lib/{parts[1]}"
    if parts[0] in ("Scripts", "bin"):
        return "Scripts（可执行入口）"
    return parts[0]


def main() -> int:
    have = {k: v for k, v in PAIRS.items() if v.is_dir()}
    if len(have) < 2:
        print("至少要有两份才能比对：存在的是", list(have))
        return 2

    sets = {k: relset(v) for k, v in have.items()}
    keys = list(sets)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            only_a = sorted(sets[a] - sets[b])
            only_b = sorted(sets[b] - sets[a])
            print(f"=== {a} 独有 {len(only_a)} 个 / {b} 独有 {len(only_b)} 个 ===")
            for label, items in ((f"{a} 独有", only_a), (f"{b} 独有", only_b)):
                if not items:
                    continue
                print(f"  {label}:")
                for name, count in Counter(bucket(x) for x in items).most_common(15):
                    print(f"    {count:6d}  {name}")
            shared = sets[a] & sets[b]
            print(f"  共有 {len(shared)} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
