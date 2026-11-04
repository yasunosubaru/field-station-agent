"""领域编排的状态图层（E3）。

本包把 M5 的五阶段链路（intake → qc / device_monitor → fault_diagnosis →
operations_dispatch → archive）表达成一张状态图，并提供：

* ``state_graph`` —— 只用标准库的最小状态图引擎（顺序 / 条件 / 并行汇合 /
  增量合并），口径对齐 LangGraph 的基本语义；
* ``checkpoint`` —— 节点级 JSONL 检查点，支持按 ``thread_id`` 恢复；
* ``five_stage`` —— 复用 ``agents.pipeline`` 的既有阶段实现搭出五阶段图，
  产出与 ``pipeline.PipelineResult`` 同形的结果；
* ``adapter_langgraph`` —— 可选适配层：装了 langgraph 才可用，否则抛
  ``EngineUnavailable``，由自带 runner 接管；
* ``parity`` —— 逐字段比对 ``pipeline`` 与图两条路径的阶段结论。

本包不修改 ``agents/`` 与 ``config/`` —— 只读并复用它们。除可选适配层外
只用标准库。
"""
from __future__ import annotations

from .checkpoint import CheckpointStore
from .state_graph import (
    ConditionalEdge,
    GraphDefinitionError,
    GraphExecutionError,
    GraphSpec,
    StateGraph,
    digest_of,
)

__all__ = [
    "CheckpointStore",
    "ConditionalEdge",
    "GraphDefinitionError",
    "GraphExecutionError",
    "GraphSpec",
    "StateGraph",
    "digest_of",
]
