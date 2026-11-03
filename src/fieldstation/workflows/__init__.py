"""workflows —— 把「原版 GUI 能做、引擎还没有固定入口」的缺口做成可审计的固定流程。

设计边界（与 ``docs/operations/high-risk-actions.md`` 同一条约束）：

* **流程是数据，不是代码。** 每条流程是一份 ``workflows/<id>.yaml``；新增缺口只加
  YAML，不改执行器。执行器只认有限的步骤种类（见 :mod:`spec`），认不出的写法在
  加载时就报错，不会静默跳过。
* **零第三方依赖。** 本包只用标准库；YAML 由 :mod:`yaml_lite` 解析（严格子集）。
* **不伪造证据。** 没有 GUI 驱动时，``gui`` 步骤不会假装点过——它变成一条
  ``waiting_operator`` 的人工任务，等人做完再 ``resume``。一步失败就停，
  绝不自动重试不可逆动作。
* **状态机 + 锁 + 幂等键 + 审计。** 每次运行是一个 job 目录：``job.json`` 是状态，
  ``audit.jsonl`` 是只追加的流水，``artifacts/`` 是证据。

Agent 面向的入口全部在 :class:`service.WorkflowService`。
"""
from __future__ import annotations

from .engine import EngineClient, EngineError, EngineHttpError, EngineUnavailable
from .gui import AssistedDriver, GuiDriver, GuiUnavailable, ScriptedDriver
from .runner import StepFailure, WorkflowRunner
from .service import WorkflowService
from .spec import (
    FAILURE_CLASSES,
    Workflow,
    WorkflowSpecError,
    load_all,
    load_spec,
    validate_params,
)
from .store import Job, JobStore

__all__ = [
    "AssistedDriver",
    "EngineClient",
    "EngineError",
    "EngineHttpError",
    "EngineUnavailable",
    "FAILURE_CLASSES",
    "GuiDriver",
    "GuiUnavailable",
    "Job",
    "JobStore",
    "ScriptedDriver",
    "StepFailure",
    "Workflow",
    "WorkflowRunner",
    "WorkflowService",
    "WorkflowSpecError",
    "load_all",
    "load_spec",
    "validate_params",
]
