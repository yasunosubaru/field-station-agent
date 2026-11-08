"""E2 bot 编队骨架（``botd``）。

组成：

* :mod:`fieldstation.botd.store`   —— SQLite schema v3 + 迁移（含契约 §2 的
  ``thread`` / ``agent`` / ``work_order`` 与 ``run_link.kind``）
* :mod:`fieldstation.botd.queue`   —— 持久队列（租约 / 退避 / 回收）
* :mod:`fieldstation.botd.cron`    —— 5 段 cron 与下一跳
* :mod:`fieldstation.botd.supervisor` —— 拆步、入队、汇总
* :mod:`fieldstation.botd.memory`  —— 本地记忆 + Chroma/Letta 适配器接口
* :mod:`fieldstation.botd.sandbox` —— ``workspace/<bot_id>/`` 受限访问
* :mod:`fieldstation.botd.daemon`  —— 一次 tick：回收→领取→执行→记账
* :mod:`fieldstation.botd.executors` —— 记忆工具执行器（`memory.recall` / `memory.remember`）
* :mod:`fieldstation.botd.interaction` —— 任务树 / 事件流 / 受控干预（编队台后端）

外部框架（DBOS / Letta / Chroma）只保留接口与 import 探测：缺包时降级，
不把"没装依赖"变成启动失败。
"""
from __future__ import annotations

from .cron import CronError, CronExpr, next_after, parse
from .daemon import BotDaemon, default_handler
from .executors import MemoryExecutor
from .interaction import (
    INTERVENTION_KINDS,
    InteractionBoard,
    InterventionError,
    summarize_kinds,
)
from .memory import (
    BotMemory,
    ChromaBackend,
    ExternalMemoryBackend,
    LettaBackend,
    MemoryBackend,
    probe_external,
)
from .queue import TaskQueue
from .sandbox import SandboxViolation, WorkspaceSandbox
from .store import (
    SCHEMA_VERSION,
    BotStore,
    PreconditionError,
    from_iso,
    to_iso,
    utcnow,
)
from .supervisor import (
    DEFAULT_PLANS,
    Planner,
    RulePlanner,
    RunResult,
    StepSpec,
    Supervisor,
    SupervisorError,
)

__all__ = [
    "SCHEMA_VERSION",
    "BotStore",
    "PreconditionError",
    "to_iso",
    "from_iso",
    "utcnow",
    "TaskQueue",
    "CronExpr",
    "CronError",
    "parse",
    "next_after",
    "StepSpec",
    "Planner",
    "RulePlanner",
    "DEFAULT_PLANS",
    "Supervisor",
    "SupervisorError",
    "RunResult",
    "BotMemory",
    "MemoryBackend",
    "ExternalMemoryBackend",
    "ChromaBackend",
    "LettaBackend",
    "probe_external",
    "WorkspaceSandbox",
    "SandboxViolation",
    "BotDaemon",
    "default_handler",
    "MemoryExecutor",
    "InteractionBoard",
    "InterventionError",
    "INTERVENTION_KINDS",
    "summarize_kinds",
]
