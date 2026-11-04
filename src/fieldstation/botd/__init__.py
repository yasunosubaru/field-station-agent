"""E2 bot 编队骨架（``botd``）。

组成：

* :mod:`fieldstation.botd.store`   —— SQLite schema v1 + 迁移
* :mod:`fieldstation.botd.queue`   —— 持久队列（租约 / 退避 / 回收）
* :mod:`fieldstation.botd.cron`    —— 5 段 cron 与下一跳
* :mod:`fieldstation.botd.supervisor` —— 拆步、入队、汇总
* :mod:`fieldstation.botd.memory`  —— 本地记忆 + Chroma/Letta 适配器接口
* :mod:`fieldstation.botd.sandbox` —— ``workspace/<bot_id>/`` 受限访问
* :mod:`fieldstation.botd.daemon`  —— 一次 tick：回收→领取→执行→记账

外部框架（DBOS / Letta / Chroma）只保留接口与 import 探测：缺包时降级，
不把"没装依赖"变成启动失败。
"""
from __future__ import annotations

from .cron import CronError, CronExpr, next_after, parse
from .daemon import BotDaemon, default_handler
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
from .store import SCHEMA_VERSION, BotStore, from_iso, to_iso, utcnow
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
]
