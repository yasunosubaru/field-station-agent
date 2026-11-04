"""节点级检查点：把每次节点执行写成 JSONL，支持按 ``thread_id`` 恢复。

## 记录形状

每行一个 JSON object，字段与 trace 的 JSONL 风格一致（紧凑分隔符、UTF-8、
强制 LF、``kind`` 标明事件类型）::

    {"kind":"graph_checkpoint","thread_id":"run-1","node":"qc",
     "input_digest":"…16 位…","output_digest":"…16 位…",
     "ts":"2026-11-05T09:00:00+00:00"}

``input_digest`` / ``output_digest`` 是**状态快照**与**节点增量**的 canonical
JSON sha256 前缀（见 ``state_graph.digest_of``）。检查点**只存摘要，不存产物
本体** —— 与 ``agents/runtime.py`` 只落 ``result_digest`` 的口径一致：日志用于
判断「同一输入是否得到同一输出」，不用于重放数据。

``ts`` 是唯一的非确定性字段（trace 之所以不放时间戳，是为了逐字节比对；检查点
的用途不同）。测试可以注入 ``clock`` 固定它。

## 恢复语义

``resume(thread_id)`` 返回该线程里**已完成**的节点名集合。``StateGraph.invoke``
拿到后跳过这些节点的执行；被跳过节点的产物必须已经在传入的 ``state`` 里 ——
检查点本身不保存产物。这是有意的：摘要不能还原状态，假装能还原只会让恢复
看起来成功、实际数据是空的。

同一 ``(thread_id, node)`` 出现多行时以**最后一行**为准（重跑覆盖旧结论）。

本模块只用标准库。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

CHECKPOINT_KIND = "graph_checkpoint"
RECORD_FIELDS = ("thread_id", "node", "input_digest", "output_digest", "ts")


class CheckpointError(ValueError):
    """检查点文件损坏或记录不合法。"""


def _default_clock() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class CheckpointStore:
    """一个 JSONL 检查点文件；每次 ``record`` 追加一行，``resume`` 读回。"""

    def __init__(
        self,
        path: str | Path,
        *,
        clock: Callable[[], str] | None = None,
    ) -> None:
        self.path = Path(path)
        self._clock = clock or _default_clock

    # ----------------------------------------------------------------- 写入
    def record(
        self,
        thread_id: str,
        node: str,
        *,
        input_digest: str,
        output_digest: str,
    ) -> dict:
        """追加一条节点执行记录，返回写入的那一行（便于测试断言）。"""
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise CheckpointError("thread_id 必须是非空字符串")
        if not isinstance(node, str) or not node.strip():
            raise CheckpointError("node 必须是非空字符串")
        for name, value in (("input_digest", input_digest),
                            ("output_digest", output_digest)):
            if not isinstance(value, str) or not value.strip():
                raise CheckpointError(f"{name} 必须是非空字符串")
        line = {
            "kind": CHECKPOINT_KIND,
            "thread_id": thread_id,
            "node": node,
            "input_digest": input_digest,
            "output_digest": output_digest,
            "ts": self._clock(),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(line, ensure_ascii=False,
                                separators=(",", ":")) + "\n")
        return line

    # ----------------------------------------------------------------- 读取
    def read(self) -> list[dict]:
        """读回全部有效记录；空行跳过，坏行报出行号。"""
        if not self.path.exists():
            return []
        records: list[dict] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for number, raw in enumerate(fh, start=1):
                text = raw.strip()
                if not text:
                    continue
                try:
                    record = json.loads(text)
                except ValueError as exc:
                    raise CheckpointError(
                        f"{self.path} 第 {number} 行不是合法 JSON：{exc}") from exc
                if not isinstance(record, dict):
                    raise CheckpointError(
                        f"{self.path} 第 {number} 行不是 JSON object")
                missing = [key for key in RECORD_FIELDS if not record.get(key)]
                if missing:
                    raise CheckpointError(
                        f"{self.path} 第 {number} 行缺字段 {missing}")
                records.append(record)
        return records

    def completed(self, thread_id: str) -> dict[str, dict]:
        """该线程已完成的节点 → 最后一条记录（同一节点以最后一行为准）。"""
        done: dict[str, dict] = {}
        for record in self.read():
            if record["thread_id"] == thread_id:
                done[record["node"]] = record
        return done

    def resume(self, thread_id: str) -> frozenset[str]:
        """``StateGraph.invoke`` 需要的「跳过集合」。"""
        return frozenset(self.completed(thread_id))

    def threads(self) -> list[str]:
        """文件里出现过的 thread_id（按首次出现顺序去重）。"""
        seen: list[str] = []
        for record in self.read():
            if record["thread_id"] not in seen:
                seen.append(record["thread_id"])
        return seen
