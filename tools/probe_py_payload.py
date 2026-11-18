#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_py_payload.py —— 盘点打包产物里的 Python 运行时，给出体积账。

## 要回答的问题

计划书 §13.5 说「现有产物 3.1 GB 中 1.3 GB 是重复打包」。这个探针把它变成可核对的数字：

    dist/py-runtime                    ← electron-builder 从 dist/ 打进去的那份
    dist/_stage/app/payload/runtime/python  ← build_payload 收进 payload.zip 的那份

两处是不是同一份？各自多大？哪个是死的（没人读）、哪个是活的？

## 判据

「同一份」不看大小相同就下结论 —— 那是猜。按 **相对路径 + 内容哈希** 全量比对。
「活的」看代码里谁在读它：`shell/electron/pyserver.js` 找 `payload/runtime/python`，
`electron-builder.yml` 找 `dist/py-runtime`。

## 用法

    python tools/probe_py_payload.py
    python tools/probe_py_payload.py --json
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

#: 候选位置 → 说明
CANDS = {
    "dist/py-runtime": "electron-builder 的 dist/ 目录（会被打进 asar 外）",
    "dist/_stage/app/payload/runtime/python": "payload.zip 解出来的位置",
    "dist/_stage/app/dist/py-runtime": "staging 里的 dist/（若存在，会被再打一份）",
    "dist/AllPoweredFSA-v5/AllPoweredFSA-dir/resources/app/payload/runtime/python": "现有产物解包后的实测位置",
}


def tree(root: Path) -> dict:
    """返回 {相对路径: sha256} 与总字节。"""
    files: dict[str, str] = {}
    total = 0
    if not root.is_dir():
        return {"files": files, "bytes": 0, "count": 0, "exists": False}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(root)).replace("\\", "/")
        try:
            data = p.read_bytes()
        except OSError:
            continue
        files[rel] = hashlib.sha256(data).hexdigest()
        total += len(data)
    return {"files": files, "bytes": total, "count": len(files), "exists": True}


def main(argv: list[str] | None = None) -> int:
    as_json = "--json" in (argv if argv is not None else sys.argv[1:])

    report = {}
    for rel, note in CANDS.items():
        info = tree(REPO / rel)
        info["note"] = note
        report[rel] = info

    present = {k: v for k, v in report.items() if v["exists"]}

    if as_json:
        print(json.dumps(
            {k: {kk: vv for kk, vv in v.items() if kk != "files"} for k, v in report.items()},
            ensure_ascii=False, indent=2))
        return 0

    print("=== 各候选位置 ===")
    for rel, info in report.items():
        if not info["exists"]:
            print(f"  (不存在) {rel}")
            continue
        print(f"  {rel}")
        print(f"      {info['count']} 文件, {info['bytes'] / 1048576:.1f} MB")
        print(f"      说明: {info['note']}")

    # 两两比对内容
    keys = list(present)
    if len(keys) >= 2:
        print()
        print("=== 内容比对（相对路径 + sha256 全量）===")
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                a, b = present[keys[i]], present[keys[j]]
                same_paths = set(a["files"]) == set(b["files"])
                same_hash = a["files"] == b["files"]
                tag = "完全相同" if (same_paths and same_hash) else (
                    "路径相同但内容不同" if same_paths else "路径集合不同")
                print(f"  {keys[i]}  vs  {keys[j]}")
                print(f"      {tag}")
                if not same_paths:
                    only_a = len(set(a["files"]) - set(b["files"]))
                    only_b = len(set(b["files"]) - set(a["files"]))
                    print(f"      仅前者有 {only_a} 个，仅后者有 {only_b} 个")

    print()
    total_mb = sum(v["bytes"] for v in present.values()) / 1048576
    print(f"合计 {total_mb:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
