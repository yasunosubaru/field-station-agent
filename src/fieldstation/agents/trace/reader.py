"""trace 读取器：把 TraceWriter 写出的 JSONL 读回 list[dict]。

每行是一个完整的 JSON 对象（``{"kind": ..., **payload}``），读回后
不拆 kind，直接返回整行 dict 的列表。文件不存在时返回空列表。

本模块只用标准库。
"""
from __future__ import annotations

import json
from pathlib import Path


def read_trace(path: str | Path) -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    out: list[dict] = []
    with p.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out
