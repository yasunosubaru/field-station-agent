"""确定性 JSONL trace 写入器。

契约（tests/test_runtime.py::TestTrace 钉死）：
  * ``write(kind, payload)`` 追加一行 JSONL，行内容为 ``{"kind": <kind>, **payload}``。
    ``kind`` 被合并进 payload，因此 reader 直接返回整行 dict，不再拆 kind。
  * 每行以 ``\\n`` 结尾；文件以 UTF-8 编码、强制 LF（``open(..., newline="\\n")``），
    避免 Windows 文本模式把 ``\\n`` 翻成 ``\\r\\n`` —— 跨平台逐字节比对的前提。

设计决定（非事实断言）：TraceWriter **不写入时间戳或随机量**。任何时间/随机
信息都是「环境指纹」而非「决策内容」，应放到旁路产物（如
store.product.env_fingerprint()），否则同输入两次运行的 trace 无法逐字节相同，
M0-4 回放式评测基线的「同输入同输出」断言（test_two_identical_runs_produce_identical_trace）
从一开始就不成立。

本模块只用标准库。
"""
from __future__ import annotations

import json
from pathlib import Path


class TraceWriter:
    """按契约追加写 JSONL 的 trace 写入器。"""

    def __init__(self, path: str | Path):
        self._path = Path(path)
        self._events: list[dict] = []

    @property
    def events(self) -> tuple[dict, ...]:
        """本次进程内已写事件的内存视图；读取文件仍是 ``read_trace``。"""
        return tuple(self._events)

    def write(self, kind: str, payload: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        line = {"kind": kind, **payload}
        self._events.append(line)
        with self._path.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
