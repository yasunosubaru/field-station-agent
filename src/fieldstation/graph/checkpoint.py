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

## 与 trace / LangGraph 的关系（v5 Bot-4）

这里有两件事要同时说清，否则会以为两套记录并存是冗余：

1. **自建检查点与 trace 是两件事，不能合并成一份文件。** trace 要逐字节可复现
   （所以不放时间戳），检查点要能跨进程找快照（所以有 ``ts``）。往 trace 里塞
   时间戳会让回放基线失效；把摘要写真快照又还原不了状态。**两份文件、同一个
   序号口径**才是对的。
2. **原生闸门用的是 LangGraph 自己的 checkpointer**（:mod:`graph.gate` 的
   ``make_checkpointer``，落在 ``<业务库目录>/graph-checkpoint.sqlite``）。
   本模块这份 JSONL 仍然有用：它是**给人看、给 `thread.last_event_seq` 对齐**
   的序号源，而 LangGraph 的那份是给框架恢复用的。两者的 ``thread_id`` 必须
   相同 —— :class:`TraceLedger` 就是干这个的。

本模块只用标准库。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

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


class TraceLedger:
    """把 trace 文件的**行号**与 ``thread.last_event_seq`` 绑在一起。

    ## 它解决什么问题

    续跑时要知道"从哪一行往后接"。如果这个序号和 trace 行号对不上，续跑会
    **重复发消息** —— 而且不会报错，只是消息多了一条。

    所以序号必须有唯一来源。这里的选择是：**trace 文件的行号就是序号**，
    ``thread.last_event_seq`` 只是它的缓存。

    ## 为什么不让 LangGraph 回调直接写序号

    回调也能写，但那样有两个写者（回调和业务层），迟早不一致。这里保留
    "谁写 trace 谁负责报行号"的单写者规则：:meth:`record` 是唯一入口。

    ## 与原生 checkpointer 的分工

    * 原生 checkpointer（sqlite）：给**框架**恢复用，存的是完整状态快照。
    * 本类：给人看、给界面跳转用，存的是"第几行了"。两者 ``thread_id`` 相同。
    """

    def __init__(self, store, trace_path: str | Path) -> None:
        """``store`` 是 ``BotStore``；用来写 ``thread.last_event_seq``。"""
        self.store = store
        self.path = Path(trace_path)

    def line_count(self) -> int:
        """trace 现在有多少行（= 序号最大值）。"""
        if not self.path.is_file():
            return 0
        with self.path.open("r", encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())

    def sync(self, thread_id: str) -> int:
        """把 ``thread.last_event_seq`` 对齐到 trace 当前行号，返回该值。"""
        seq = self.line_count()
        self.store.update_thread(str(thread_id), last_event_seq=seq)
        return seq

    def append(self, thread_id: str, kind: str, payload: dict) -> int:
        """往 trace 追加一行并把序号推进到它的行号，返回新序号。

        **这是唯一推荐的写入方式。** 直接调 ``TraceWriter.write`` 也能写，
        但序号就不会跟着走 —— 那正是"对不上"的来源。
        """
        from ..agents.trace.writer import TraceWriter

        writer = TraceWriter(self.path)
        writer.write(kind, payload)
        return self.sync(thread_id)

    def resume_after(self, thread_id: str) -> int:
        """续跑应该从哪一行往后接。

        返回 ``last_event_seq``（不是 +1）：调用方自己决定"从下一条开始"的
        语义，这里不替它猜。若库里的值比文件行数大（文件被截断过），
        **以文件为准**并顺手纠正缓存 —— 静默沿用旧值会让续跑跳过真实事件。
        """
        actual = self.line_count()
        stored = int(self.store.get_thread(str(thread_id)).get("last_event_seq") or 0)
        if stored > actual:
            self.store.update_thread(str(thread_id), last_event_seq=actual)
            return actual
        return stored
