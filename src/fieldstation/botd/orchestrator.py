# -*- coding: utf-8 -*-
"""DBOS 编排层：一个任务 = 一个工作流。

## 这一层解决什么问题

`queue.py` 管的是「这一秒谁在跑这一行」——租约、退避、回收，回答"谁占着"。
DBOS 管的是「这件事跑到哪了、崩了要不要接着跑」——回答"做完了没"。

两条不冲突：工作流内部**调**队列。所以这一层不替换 `TaskQueue`，只在它上面
加一层"跨重启还记得自己做到哪"的壳。

## 三条设计决定（都有实测依据，见 ``docs/operations/dbos.md``）

1. **`SetWorkflowID(task_id)`** —— 工作流 id 直接用业务主键。于是"同一任务重复
   投递只跑一次"由 DBOS 保证，不需要应用层再去重；两本账也用同一个键对。
2. **闸门用 ``DBOS.sleep`` + ``DBOS.recv``** —— 实测睡觉期间进程可以死，重启后
   从 sleep 接着跑（睡之前那步不重跑）。自建轮询做不到这一条。
3. **带副作用的调用一律包 ``@step``** —— 判据是"重放一次会出问题吗"。漏包一个
   写动作，崩溃续跑就会再执行一次：重复扣 token、重复写文件。

## 与业务表的关系

``task`` / ``step`` 是**业务镜像**，DBOS 系统库是**执行真相**。两者不同库
（``botd.sqlite`` / ``dbos.sqlite``），因为 DBOS 自己会跑 120+ 条 schema 迁移，
混进业务库会和我们的 ``PRAGMA user_version`` 抢同一格。

## 只导一次的那个坑

DBOS 是**进程级单例**：同一时刻只能有一个 ``DBOS`` 实活。所以本模块把实例藏在
:class:`Orchestrator` 里，并提供一个 :func:`active` 查询；重复 ``configure``
会抛错而不是悄悄替换掉前一个（那会让先前注册的工作流永远不再恢复）。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence

from .store import BotStore, to_iso, utcnow

#: DBOS 系统库的文件名。**故意与业务库分开**，理由见模块 docstring。
DBOS_DB_NAME = "dbos.sqlite"
#: DBOS 应用名。同一个 name 才能恢复同一个 name 下写的工作流。
DEFAULT_APP_NAME = "fieldstation-botd"


class OrchestratorError(RuntimeError):
    """编排层用法错误（重复配置、未配置就启动等）。"""


class Executor(Protocol):
    """一步的执行器：拿到任务 dict，返回可 JSON 化的结果。

    与 :class:`fieldstation.botd.supervisor.Supervisor` 用的是同一个形状，
    这样把它直接传进来就能跑。
    """

    def __call__(self, task: dict) -> Any:  # pragma: no cover - 协议
        ...


@dataclass
class GateDecision:
    """闸门结论。``approved=False`` 表示人拒绝了。"""

    approved: bool
    by: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        return {"approved": bool(self.approved), "by": self.by, "note": self.note}


@dataclass
class TaskOutcome:
    """一次工作流的产出。"""

    task_id: str
    status: str
    result: Any = None
    steps_done: list[str] = field(default_factory=list)
    gate: Optional[GateDecision] = None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "status": self.status,
            "result": self.result,
            "steps_done": list(self.steps_done),
            "gate": self.gate.to_dict() if self.gate else None,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TaskOutcome":
        """从工作流返回值重建。

        必须在过程边界上重建：DBOS 把工作流结果**序列化成 JSON 再交回来**，
        所以 ``gate`` 到手是一个 dict，不是 :class:`GateDecision`。不重建就会
        出现 ``outcome.gate.approved`` 报 ``'dict' has no attribute``。
        """
        raw_gate = data.get("gate")
        gate = None
        if isinstance(raw_gate, Mapping):
            gate = GateDecision(
                approved=bool(raw_gate.get("approved")),
                by=str(raw_gate.get("by") or ""),
                note=str(raw_gate.get("note") or ""),
            )
        return cls(
            task_id=str(data.get("task_id") or ""),
            status=str(data.get("status") or ""),
            result=data.get("result"),
            steps_done=list(data.get("steps_done") or []),
            gate=gate,
        )


class Orchestrator:
    """把 :class:`BotStore` 的任务跑成 DBOS 工作流。

    用法::

        orch = Orchestrator(store, executor=my_executor)
        orch.launch()
        outcome = orch.run_task(task_id)      # 阻塞到出结果
        orch.shutdown()
    """

    def __init__(
        self,
        store: BotStore,
        *,
        executor: Optional[Executor] = None,
        app_name: str = DEFAULT_APP_NAME,
        dbos_db_path: Optional[Path] = None,
        start_paused: bool = False,
    ) -> None:
        if not isinstance(store, BotStore):
            raise TypeError("Orchestrator 需要 BotStore")
        self.store = store
        self.executor = executor
        self.app_name = app_name
        self.dbos_db_path = Path(dbos_db_path) if dbos_db_path else (
            store.path.parent / DBOS_DB_NAME)
        self._dbos: Any = None
        self._started = False
        #: 步骤名的注册表：``DBOS.workflow``/``step`` 是装饰器，必须在启动前
        #: 注册好；运行期新增的步骤名不允许（否则恢复时找不到函数）。
        self._step_fns: dict[str, Callable[[dict], Any]] = {}
        self._gate_fn: Optional[Callable[[str], Any]] = None
        self._paused = bool(start_paused)

    # ---------------------------------------------------------------- 配置 --
    @property
    def started(self) -> bool:
        return self._started

    def configure(self) -> Any:
        """建 DBOS 实例并注册工作流。**幂等**：重复调用返回同一个实例。"""
        if self._dbos is not None:
            return self._dbos
        global _ACTIVE
        if _ACTIVE is not None:
            raise OrchestratorError(
                "本进程已经有一个 DBOS 实例在跑。DBOS 是进程级单例；"
                "要换配置请先 shutdown() 旧实例。")

        from dbos import DBOS

        self.dbos_db_path.parent.mkdir(parents=True, exist_ok=True)
        # DBOS 的 config 收 dict；用 sqlite 就够（不需要 Postgres）。
        self._dbos = DBOS(config={
            "name": self.app_name,
            "system_database_url":
                f"sqlite:///{self.dbos_db_path.as_posix()}",
        })
        self._register()
        _ACTIVE = self
        return self._dbos

    def _register(self) -> None:
        """把工作流与它调用的步骤注册到 DBOS。

        工作流本体只做编排，真正的活都在 ``@step`` 里。注册是显式的：
        不用装饰器在导入期自动注册，因为那样同一进程里两个 Orchestrator
        会抢同一个函数名。
        """
        dbos = self._dbos

        @dbos.step(name="botd.step.execute")
        def _run_step(payload: dict) -> dict:
            return self._execute_step(payload)

        @dbos.workflow(name="botd.task.run")
        def _task_run(task_id: str) -> dict:
            return self._task_body(task_id)

        self._run_step = _run_step           # type: ignore[attr-defined]
        self._task_run = _task_run           # type: ignore[attr-defined]

    # ---------------------------------------------------------------- 生命周期 --
    def launch(self) -> None:
        """起 DBOS。会**自动恢复**本应用名下所有未完成的工作流。"""
        if self._dbos is None:
            self.configure()
        if self._started:
            return
        self._dbos.launch()
        self._started = True

    def shutdown(self) -> None:
        """停 DBOS 并释放单例。测试之间必须调，否则下一个用例起不来。"""
        global _ACTIVE
        if self._dbos is not None:
            try:
                self._dbos.destroy(destroy_registry=True)
            finally:
                self._dbos = None
                self._started = False
        if _ACTIVE is self:
            _ACTIVE = None

    # ---------------------------------------------------------------- 运行 --
    def run_task(
        self,
        task_id: str,
        *,
        wait: bool = True,
    ) -> Optional[TaskOutcome]:
        """跑一个任务。``wait=False`` 时立刻返回 ``None``（工作流在后台跑）。

        工作流 id 就是 ``task_id``：同一任务重复调用只会有一个实例，
        后到的调用直接拿到同一个句柄。
        """
        if not self._started:
            raise OrchestratorError("还没 launch()；DBOS 必须先起")
        from dbos import SetWorkflowID

        with SetWorkflowID(task_id) as _:
            handle = self._dbos.start_workflow(self._task_run, task_id)
        if not wait:
            return None
        raw = handle.get_result()
        return TaskOutcome.from_dict(raw) if isinstance(raw, Mapping) else None

    def workflow_status(self, task_id: str) -> str:
        """看这条任务的工作流现在什么状态（``PENDING`` 就包含"睡在闸门上"）。"""
        if self._dbos is None:
            return "unconfigured"
        status = self._dbos.get_workflow_status(task_id)
        return str(getattr(status, "status", "?"))

    # ---------------------------------------------------------------- 工作流本体 --
    def _task_body(self, task_id: str) -> dict:
        """一个任务：逐步执行 → 遇到闸门就睡 → 人批了再醒 → 收尾。

        **这个函数的每一步都必须可重放。** 所以它只在 ``@step`` 里碰外部世界。
        """
        steps_done: list[str] = []
        gate: Optional[GateDecision] = None

        task = self.store.get_task(task_id)
        plan = self._plan(task)

        try:
            for index, name in enumerate(plan):
                # 每步一个 DBOS step：这是"重放不重复执行"的唯一保证。
                payload = {"task_id": task_id, "step": name, "index": index}
                outcome = self._run_step(payload)     # type: ignore[attr-defined]
                if outcome.get("status") == "gate":
                    gate = self._wait_for_gate(task_id, name)
                    if not gate.approved:
                        return self._finish(task_id, "cancelled", gate,
                                            steps_done, reason="闸门被拒")
                steps_done.append(name)
        except BaseException as exc:
            # 失败要落库，否则业务表永远显示 running
            self._mark(task_id, "failed", error=f"{type(exc).__name__}: {exc}")
            raise

        return self._finish(task_id, "done", gate, steps_done)

    def _plan(self, task: Mapping[str, Any]) -> list[str]:
        """把任务拆成步骤名。默认按 ``step`` 表的既有行；没有就单步。"""
        rows = self.store.list_steps(str(task["task_id"]))
        if rows:
            rows.sort(key=lambda s: int(s.get("idx") or 0))
            return [str(r["name"]) for r in rows]
        return [str(task.get("kind") or "run")]

    def _execute_step(self, payload: dict) -> dict:
        """``@step`` 的真正内容。**有副作用的都在这里，且只在这里。**"""
        task_id = str(payload["task_id"])
        name = str(payload["step"])
        task = self.store.get_task(task_id)

        # 闸门步骤：不动外部世界，只告诉工作流"该停下来等人了"
        if self._is_gate_step(name):
            return {"status": "gate", "step": name}

        # 记一步（写业务库 = 有副作用 = 必须在 step 里）
        step_rows = [r for r in self.store.list_steps(task_id)
                     if str(r.get("name")) == name]
        if step_rows:
            self.store.update_step(
                str(step_rows[0]["id"]), status="running", now=utcnow())

        if self.executor is None:
            result: Any = {"ok": True, "note": "没有接执行器"}
        else:
            # 执行器要能知道"我在跑哪一步"——否则它只能靠计数器猜，
            # 而计数器在崩溃续跑时会从 0 重新开始，猜出来的身份是错的。
            # 用附加键 ``current_step`` 传，不改 task 的既有列。
            context = dict(task)
            context["current_step"] = name
            result = self.executor(context)

        if step_rows:
            self.store.update_step(
                str(step_rows[0]["id"]),
                status="done",
                output=result if isinstance(result, (dict, list)) else str(result),
                error="",
                now=utcnow(),
            )
        return {"status": "ok", "step": name, "result": result}

    def _is_gate_step(self, name: str) -> bool:
        return name in getattr(self, "_gate_steps", ())

    def set_gate_steps(self, names: Sequence[str]) -> None:
        """声明哪些步骤是闸门（要停下来等人）。必须在 :meth:`launch` 之前调。"""
        if self._started:
            raise OrchestratorError("gate 步骤必须在 launch() 之前声明")
        self._gate_steps = tuple(str(n) for n in names)

    def _wait_for_gate(self, task_id: str, step: str) -> GateDecision:
        """停下等人：业务表标 ``waiting_approval``，然后 ``sleep`` + ``recv``。

        ``sleep`` 的作用是给"人等三天"一个**可被杀**的等待点（实测进程能死，
        重启接着等）；``recv`` 是真正被唤醒的通道。两个都要：
        只用 ``recv`` 会在超时上很别扭，只用 ``sleep`` 则收不到"批了"的信号。
        """
        from dbos import DBOS

        self._mark(task_id, "waiting_approval")
        # 先睡一小段（可配置）再收信号；生产上把这里设成小时级。
        DBOS.sleep(self.gate_poll_seconds)
        message = DBOS.recv(topic=f"gate:{task_id}",
                            timeout_seconds=self.gate_recv_timeout_seconds)
        if message is None:
            return GateDecision(approved=False, by="", note="等待超时")
        if isinstance(message, Mapping):
            return GateDecision(
                approved=bool(message.get("approved")),
                by=str(message.get("by") or ""),
                note=str(message.get("note") or ""),
            )
        return GateDecision(approved=bool(message))

    #: 闸门轮询间隔（秒）。测试里调小，生产上调大。
    gate_poll_seconds: float = 0.05
    #: 收信号的超时（秒）。None 语义上等于"一直等"，但 DBOS 要一个数。
    gate_recv_timeout_seconds: float = 300.0

    # ---------------------------------------------------------------- 收尾 --
    def _finish(
        self,
        task_id: str,
        status: str,
        gate: Optional[GateDecision],
        steps_done: list[str],
        *,
        reason: str = "",
    ) -> dict:
        self._mark(task_id, status, error=reason or None)
        return TaskOutcome(
            task_id=task_id,
            status=status,
            result={"steps_done": list(steps_done), "reason": reason},
            steps_done=list(steps_done),
            gate=gate,
        ).to_dict()

    def _mark(
        self,
        task_id: str,
        status: str,
        *,
        error: Optional[str] = None,
    ) -> None:
        """把状态写回业务表。

        **这是有副作用的**，所以只在工作流的收尾处调一次；中途的状态推进
        由 :meth:`_execute_step` 里的 ``update_step`` 负责，两者不重复写同一行。
        """
        sets = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status, to_iso(utcnow())]
        if error is not None:
            sets.append("last_error = ?")
            params.append(str(error)[:4000])
        if status in ("done", "failed", "cancelled", "dead"):
            sets.append("lease_owner = NULL")
            sets.append("lease_expires_at = NULL")
        params.append(task_id)
        with self.store.transaction() as conn:
            conn.execute(
                f"UPDATE task SET {', '.join(sets)} WHERE task_id = ?", params)


#: 进程内唯一的 DBOS 持有者。DBOS 自己是单例，这里只是把"谁握着它"记下来，
#: 好在重复配置时**报错**而不是悄悄覆盖（覆盖会让旧工作流永远不再恢复）。
_ACTIVE: Optional[Orchestrator] = None


def active() -> Optional[Orchestrator]:
    """当前进程里活着的编排器；没有则是 ``None``。"""
    return _ACTIVE


def approve(task_id: str, *, by: str = "", note: str = "", approved: bool = True) -> None:
    """人批了：往工作流发一条信号把它唤醒。

    这是闸门的**外部入口**。它必须先 ``launch`` 过（否则工作流不在等），
    所以调用方通常是常驻进程或测试里的同一个实例。
    """
    orch = _ACTIVE
    if orch is None or orch._dbos is None:
        raise OrchestratorError("还没有 Orchestrator 在跑；approve 无处投递")
    orch._dbos.send(
        task_id,
        GateDecision(approved=approved, by=by, note=note).to_dict(),
        topic=f"gate:{task_id}",
    )
