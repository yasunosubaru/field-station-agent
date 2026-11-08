"""E2 botd 监督者：把大任务拆成可独立重试的子步。

这里**不接真实 LLM**。``Planner`` 是协议，默认的 :class:`RulePlanner` 按任务
类型给出固定步骤，每步带工具白名单和验收条件 —— 先把"编队应该长什么样"钉成
可测的数据，之后换成 LLM 规划器时，队列、重试、汇总逻辑一行都不用改。

执行模型：

* 父任务在 ``task`` 表里状态为 ``running``，只做汇总，**不进队列**，所以不会被
  worker 领走；
* 每个子步对应一条 ``step`` 记录 + 一条可领取的 ``task`` 记录（``step_id``
  唯一索引保证一步一行，不会重复入队）；
* ``Supervisor.run(..., executor=None)`` 只入队并返回，交给常驻 daemon 慢慢跑；
  给了 ``executor`` 就在本进程内按计划顺序跑到终态，方便测试与单机小任务。

``retry_delay`` 默认 0：监督者是"就地重试"，不该在 ``run`` 里睡几秒再接着跑；
常驻 daemon 走队列的指数退避，两者共用 ``attempts`` 与 ``max_attempts``。
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple

from .queue import TaskQueue
from .store import BotStore, dumps, to_iso, utcnow


def _prompt_field(prompt: str, key: str) -> str:
    """从 ``interaction._compose_prompt()`` 造出的文本里取一个字段。

    格式是 ``note; key=value; key=value``（见 ``interaction.py`` 的注释：那张表
    没有 metadata 列，拼进 prompt 是既定做法）。取不到返回空串。
    """
    prefix = f"{key}="
    for chunk in str(prompt).split(";"):
        chunk = chunk.strip()
        if chunk.startswith(prefix):
            return chunk[len(prefix):].strip()
    return ""


class SupervisorError(RuntimeError):
    """任务拆分或执行阶段的确定性错误。"""


@dataclass(frozen=True)
class StepSpec:
    """一步做什么、能用什么工具、怎样算做完。"""

    name: str
    tools: Tuple[str, ...] = ()
    acceptance: str = ""
    kind: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "tools": list(self.tools),
            "acceptance": self.acceptance,
            "kind": self.kind,
        }


class Planner(Protocol):
    """规划器协议：输入任务描述，输出有序步骤。"""

    def plan(self, task: Mapping[str, Any]) -> List[StepSpec]:
        ...  # pragma: no cover - 协议声明


#: 默认的固定拆步表。工具名是白名单**字符串**，真实工具注册表不在这一步校验；
#: 这样 RulePlanner 可以离线跑测试，也不会因为某个工具暂未加载而拆不出步。
DEFAULT_PLANS: Dict[str, Tuple[StepSpec, ...]] = {
    "data_qc": (
        StepSpec(
            name="读取观测数据",
            tools=("data.read", "station.list"),
            acceptance="拿到任务指定时段的数据，且记录条数 > 0",
            kind="data.read",
        ),
        StepSpec(
            name="质量检查",
            tools=("qc.run", "qc.summary"),
            acceptance="输出缺测率/跳变/越界三类计数，缺测率有明确数值",
            kind="qc.run",
        ),
        StepSpec(
            name="生成 QC 报告",
            tools=("report.render", "artifact.write"),
            acceptance="报告落盘并给出可回源的产物路径",
            kind="report.render",
        ),
    ),
    "station_health": (
        StepSpec(
            name="采集站点状态",
            tools=("station.status", "station.list"),
            acceptance="每个站点都有 online/offline 与 last_seen",
            kind="station.status",
        ),
        StepSpec(
            name="核对告警阈值",
            tools=("station.alerts", "rules.evaluate"),
            acceptance="每条告警都能指回具体阈值与读数",
            kind="station.alerts",
        ),
        StepSpec(
            name="生成健康摘要",
            tools=("report.render", "board.post"),
            acceptance="摘要列出异常站点数量与处置建议",
            kind="report.render",
        ),
    ),
    "work_order": (
        StepSpec(
            name="生成工单",
            tools=("work_order.create", "approval.request"),
            acceptance="工单带优先级、风险等级与证据引用",
            kind="work_order.create",
        ),
        StepSpec(
            name="等待人工审批",
            tools=("approval.wait",),
            acceptance="审批结论为 approved 才继续；rejected 则终止",
            kind="approval.wait",
        ),
        StepSpec(
            name="回填执行结果",
            tools=("work_order.update", "board.post"),
            acceptance="工单状态与执行证据一致",
            kind="work_order.update",
        ),
    ),
    "generic": (
        StepSpec(
            name="准备上下文",
            tools=("memory.recall",),
            acceptance="列出本步用到的输入与约束",
            kind="context",
        ),
        StepSpec(
            name="执行任务",
            tools=(),
            acceptance="产出非空结果，或给出明确的失败原因",
            kind="execute",
        ),
        StepSpec(
            name="归档结果",
            tools=("memory.remember", "artifact.write"),
            acceptance="结果可被下一次任务召回",
            kind="archive",
        ),
    ),
}


class RulePlanner:
    """按任务类型查固定步骤表；未知类型落到 ``generic``。"""

    def __init__(self, plans: Optional[Mapping[str, Sequence[StepSpec]]] = None) -> None:
        source = plans if plans is not None else DEFAULT_PLANS
        self._plans: Dict[str, Tuple[StepSpec, ...]] = {
            str(kind): tuple(steps) for kind, steps in source.items()
        }
        if "generic" not in self._plans:
            raise ValueError("RulePlanner 必须包含 generic 兜底计划")
        self.last_fallback = False

    def plan(self, task: Mapping[str, Any]) -> List[StepSpec]:
        kind = str(task.get("kind") or "").strip()
        steps = self._plans.get(kind)
        self.last_fallback = steps is None
        if steps is None:
            steps = self._plans["generic"]
        return list(steps)

    def kinds(self) -> List[str]:
        return sorted(self._plans)


@dataclass
class RunResult:
    """一次 ``Supervisor.run`` 的可序列化结果。"""

    task_id: str
    kind: str
    status: str
    plan: List[dict] = field(default_factory=list)
    children: List[dict] = field(default_factory=list)
    attempts: int = 0
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "kind": self.kind,
            "status": self.status,
            "plan": self.plan,
            "children": self.children,
            "attempts": self.attempts,
            "error": self.error,
        }


Executor = Callable[[dict], Any]


def is_failure_result(result: Any) -> bool:
    if isinstance(result, Mapping):
        if result.get("ok") is False:
            return True
        if str(result.get("status", "")).lower() in ("failed", "error", "dead"):
            return True
    return False


def result_text(result: Any) -> str:
    if isinstance(result, BaseException):
        return f"{type(result).__name__}: {result}"
    if isinstance(result, Mapping):
        for key in ("error", "message", "reason"):
            value = result.get(key)
            if value:
                return str(value)
        return f"执行器报告失败：{result}"
    return str(result) if result is not None else "执行器报告失败"


class Supervisor:
    """拆步 → 入队 → （可选）执行 → 汇总。"""

    def __init__(
        self,
        store: BotStore,
        planner: Optional[Planner] = None,
        *,
        queue: Optional[TaskQueue] = None,
        worker: str = "supervisor",
        retry_delay: float = 0.0,
        max_attempts: int = 3,
        lease_ttl: float = 60.0,
    ) -> None:
        if retry_delay < 0:
            raise ValueError("retry_delay 不能为负")
        if max_attempts < 1:
            raise ValueError("max_attempts 至少为 1")
        self.store = store
        self.planner = planner or RulePlanner()
        self.queue = queue or TaskQueue(store)
        self.worker = worker
        self.retry_delay = float(retry_delay)
        self.max_attempts = int(max_attempts)
        self.lease_ttl = float(lease_ttl)

    # ---------------------------------------------------------------- run --
    def run(
        self,
        task: Mapping[str, Any],
        *,
        executor: Optional[Executor] = None,
        now: Optional[datetime] = None,
        max_turns: Optional[int] = None,
    ) -> RunResult:
        if not isinstance(task, Mapping):
            raise TypeError("Supervisor.run 需要 mapping（kind / payload / ...）")
        kind = str(task.get("kind") or "").strip()
        if not kind:
            raise SupervisorError("任务必须带非空 kind")
        payload = task.get("payload") or {}
        if not isinstance(payload, Mapping):
            raise SupervisorError("task.payload 必须是 mapping")
        bot_id = task.get("bot_id")
        priority = int(task.get("priority", 0))

        # 先校验计划，再落库：规划器返回空/重复步骤时不该留下一个孤儿父任务。
        specs = list(self.planner.plan(task))
        if not specs:
            raise SupervisorError(f"规划器没有为 {kind!r} 给出任何步骤")
        seen_names: set[str] = set()
        for spec in specs:
            if not isinstance(spec, StepSpec):
                raise SupervisorError("规划器必须返回 StepSpec 列表")
            if not spec.name.strip():
                raise SupervisorError("步骤名不能为空")
            if spec.name in seen_names:
                raise SupervisorError(f"步骤名重复：{spec.name!r}")
            seen_names.add(spec.name)

        parent = self.store.create_task(
            kind=kind,
            bot_id=bot_id,
            title=str(task.get("title") or kind),
            payload=dict(payload),
            status="running",
            priority=priority,
            max_attempts=self.max_attempts,
            now=now,
        )

        child_ids: List[str] = []
        for idx, spec in enumerate(specs):
            step = self.store.create_step(
                task_id=parent["task_id"],
                idx=idx,
                name=spec.name,
                kind=spec.kind,
                tools=list(spec.tools),
                acceptance=spec.acceptance,
                now=now,
            )
            child = self.queue.enqueue(
                {
                    "kind": spec.kind or kind,
                    "bot_id": bot_id,
                    "parent_task_id": parent["task_id"],
                    "step_id": step["id"],
                    "title": spec.name,
                    "payload": {
                        "task": dict(payload),
                        "step": spec.name,
                        "acceptance": spec.acceptance,
                        "tools": list(spec.tools),
                    },
                    "priority": priority,
                    "max_attempts": self.max_attempts,
                },
                now=now,
            )
            self.store.update_step(step["id"], task_ref=child["task_id"], now=now)
            child_ids.append(child["task_id"])

        if executor is not None:
            self._drive(parent, child_ids, executor, now=now, max_turns=max_turns)

        return self._summarize(parent, specs, now=now)

    def collect(self, task_id: str, *, now: Optional[datetime] = None) -> RunResult:
        """重新汇总一个已存在的父任务。

        ``run(executor=None)`` 之后子步由常驻 daemon 执行，父任务不会自己知道
        全部完成；由调用方（cron、看板轮询）调本方法推进父任务终态。
        """
        parent = self.store.get_task(task_id)
        steps = self.store.list_steps(task_id)
        specs = [
            StepSpec(
                name=step["name"],
                tools=tuple(step["tools"]),
                acceptance=step["acceptance"],
                kind=step["kind"],
            )
            for step in steps
        ]
        return self._summarize(parent, specs, now=now)

    # -------------------------------------------------------------- drive --
    def _drive(
        self,
        parent: dict,
        child_ids: Sequence[str],
        executor: Executor,
        *,
        now: Optional[datetime],
        max_turns: Optional[int],
    ) -> None:
        """逐步推进子任务，**每个步骤边界都读一次干预表**。

        位置纪律（这是本条最容易做错的地方）：干预只在**领步之前**读，不在
        工具执行到一半时插进去。理由不是洁癖 —— 中途强插会在日志里留下一条
        ``tool.call`` 没有对应的 ``tool.result``，事后没人能说清那个工具到底
        跑完没有。

        所以"点了暂停"的真实语义是：**当前这一步会跑完，然后不再领下一步**。
        """
        budget = max_turns or (
            len(child_ids) * (self.max_attempts + 1) + len(child_ids) + 5
        )
        for _ in range(int(budget)):
            # ---- 步骤边界 ①：领步之前 ----
            # 父任务已经被人按住（暂停 / 接管）就别再往前推。这一条不能省：
            # 接管是把某一步交给人工，人还没给结论时继续跑别的步，
            # 等于"接管了但没停"。
            if self._is_held(parent["task_id"]):
                return
            verdict = self._consume_intervention(parent["task_id"], now=now)
            if verdict == "pause":
                self._set_waiting(parent["task_id"], "waiting_operator", now=now)
                return
            if verdict == "takeover":
                self._set_waiting(parent["task_id"], "waiting_operator", now=now)
                return
            if verdict == "resume":
                # 继续：状态恢复成 running，然后照常领步
                self._set_status(parent["task_id"], "running", now=now)

            if self.queue.pending_children(parent["task_id"]) == 0:
                return
            child = self.queue.lease(
                self.worker,
                ttl=self.lease_ttl,
                parent_task_id=parent["task_id"],
                now=now,
            )
            if child is None:
                return  # 子步都在退避等待或已被别的 worker 领走
            step = self.store.get_step(child["step_id"])
            try:
                result = executor(dict(child))
            except Exception as exc:  # noqa: BLE001 - 执行器的异常要变成任务失败
                updated = self.queue.fail(
                    child["task_id"], exc, delay=self.retry_delay, now=now
                )
                self.store.update_step(
                    step["id"],
                    status="pending" if updated["status"] == "pending" else "failed",
                    error=result_text(exc),
                    attempts=int(updated["attempts"]),
                    now=now,
                )
                continue
            if is_failure_result(result):
                updated = self.queue.fail(
                    child["task_id"],
                    result_text(result),
                    delay=self.retry_delay,
                    now=now,
                )
                self.store.update_step(
                    step["id"],
                    status="pending" if updated["status"] == "pending" else "failed",
                    error=result_text(result),
                    attempts=int(updated["attempts"]),
                    now=now,
                )
                continue
            updated = self.queue.complete(child["task_id"], result, now=now)
            self.store.update_step(
                step["id"],
                status="done",
                output=result,
                error="",
                attempts=int(updated["attempts"]),
                now=now,
            )
            # ---- 步骤边界 ②：执行之后 ----
            # 这一步已经跑完了，此时读到的 pause / takeover 立刻生效。
            #
            # **这里必须处理返回值。** 第一版只调用不判断，结果消费掉的 pause
            # 被丢掉了：`_consume_intervention` 会把这行转成 resolved，下一轮
            # 再也读不到它，于是"暂停"变成了一次无声的空操作 —— 三步全跑完，
            # 界面上却显示点过暂停。那正是本条验收第 2 条要防的事。
            after = self._consume_intervention(parent["task_id"], now=now)
            if after in ("pause", "takeover"):
                self._set_waiting(parent["task_id"], "waiting_operator", now=now)
                return

    def _is_held(self, task_id: str) -> bool:
        """这条任务是否处在"等人"状态（暂停 / 接管之后）。"""
        status = str(self.store.get_task(task_id).get("status") or "")
        return status in ("waiting_operator", "waiting_approval")

    # ------------------------------------------------------------ 干预消费 --
    def _consume_intervention(self, task_id: str, *, now: Optional[datetime]) -> str:
        """读一条待处理干预，**应用它**，返回它的 kind（没有就返回空串）。

        必须"读一条、处理一条"，否则同一条 ``pause`` 会被每轮读到，
        任务永远停不下来 —— 那不是暂停，那是死循环。

        应用之后把该行转成终态（``resolved``），``response`` 里写清是系统应用
        还是人工裁决。审计上要能区分这两种，所以不能只留一个布尔值。
        """
        rows = self.store.list_interventions(status="pending")
        mine = [r for r in rows if str(r.get("task_id") or "") == str(task_id)]
        if not mine:
            return ""
        mine.sort(key=lambda r: str(r.get("created_at") or ""))
        row = mine[0]
        kind = str(row.get("kind") or "")
        intervention_id = str(row.get("id") or "")
        prompt = str(row.get("prompt") or "")

        applied = ""
        try:
            if kind == "retry":
                applied = self._apply_retry(task_id, prompt, now=now)
            elif kind == "takeover":
                applied = self._apply_takeover(task_id, prompt, now=now)
            else:
                applied = kind          # pause / resume 本身就是结论
        finally:
            # 无论应用成功与否都要消费掉：留着一条永远应用不了的 pending，
            # 会让每轮都重复尝试、并且挡住后面真正的指令。
            self.store.resolve_intervention(
                intervention_id,
                f"applied_by=supervisor; kind={kind}; detail={applied}",
                status="resolved",
                now=now,
            )
        return kind

    def _apply_retry(
        self, task_id: str, prompt: str, *, now: Optional[datetime]
    ) -> str:
        """让目标步骤重跑：``attempts + 1``，并把人工说明带进 payload。

        ``attempts`` 加一的意义是"这一次尝试被消耗掉了"，与队列领取时自增
        同源。旧尝试的结果保留在 ``step.output`` / ``step.error`` 里不擦除 ——
        审计要看得到"上一次是怎么失败的、这次改了什么"。
        """
        step_id = _prompt_field(prompt, "step_id")
        children = self.store.list_tasks(parent_task_id=task_id)
        target = None
        for child in children:
            if step_id and str(child.get("step_id") or "") == step_id:
                target = child
                break
        if target is None:
            return "no_target_step"
        stamp = to_iso(now or utcnow())
        with self.store.transaction() as conn:
            conn.execute(
                """
                UPDATE task
                SET status = 'pending', attempts = attempts + 1,
                    available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                    updated_at = ?
                WHERE task_id = ?
                """,
                (stamp, stamp, target["task_id"]),
            )
        return f"requeued_step={target['step_id']}"

    def _apply_takeover(
        self, task_id: str, prompt: str, *, now: Optional[datetime]
    ) -> str:
        """人工接管：该步不再交给执行器，等人工给结论。

        不把任务标成 ``done`` —— 接管的意思是"结果由人来给"，在人来之前
        它既不是完成也不是失败。

        **父任务也要一起按住。** 第一版只改了目标子任务，父任务仍是
        ``running``，于是 ``_drive`` 的 ``_is_held`` 看不到它，继续领别的步 ——
        「接管了但没停」。父子两个状态都要落到 ``waiting_operator``。
        """
        step_id = _prompt_field(prompt, "step_id")
        children = self.store.list_tasks(parent_task_id=task_id)
        target = None
        for child in children:
            if step_id and str(child.get("step_id") or "") == step_id:
                target = child
                break
        if target is None:
            return "no_target_step"
        stamp = to_iso(now or utcnow())
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE task SET status = 'waiting_operator', updated_at = ?,"
                " lease_owner = NULL, lease_expires_at = NULL WHERE task_id = ?",
                (stamp, target["task_id"]),
            )
            conn.execute(
                "UPDATE task SET status = 'waiting_operator', updated_at = ?,"
                " lease_owner = NULL, lease_expires_at = NULL WHERE task_id = ?",
                (stamp, task_id),
            )
        if target.get("step_id"):
            try:
                self.store.update_step(
                    str(target["step_id"]), status="running", now=now)
            except KeyError:
                pass
        return f"handover_step={target['step_id']}"

    def _set_waiting(
        self, task_id: str, status: str, *, now: Optional[datetime]
    ) -> None:
        """把父任务置为"等人"，并清掉租约（否则会被别人当成还活着）。"""
        self._set_status(task_id, status, now=now, clear_lease=True)

    def _set_status(
        self,
        task_id: str,
        status: str,
        *,
        now: Optional[datetime],
        clear_lease: bool = False,
    ) -> None:
        sets = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status, to_iso(now or utcnow())]
        if clear_lease:
            sets.append("lease_owner = NULL")
            sets.append("lease_expires_at = NULL")
        params.append(task_id)
        with self.store.transaction() as conn:
            conn.execute(
                f"UPDATE task SET {', '.join(sets)} WHERE task_id = ?", params
            )

    # ---------------------------------------------------------- summarize --
    def _summarize(
        self,
        parent: dict,
        specs: Sequence[StepSpec],
        *,
        now: Optional[datetime],
    ) -> RunResult:
        children = self.store.list_tasks(parent_task_id=parent["task_id"])
        steps = self.store.list_steps(parent["task_id"])
        statuses = Counter(child["status"] for child in children)
        attempts = sum(int(child["attempts"]) for child in children)

        # 「等人」必须先于完/败判断：接管或暂停时子步可能已经全 done，
        # 若先按 done 汇总，人的裁决就再也送不进来了。
        current = str(self.store.get_task(parent["task_id"]).get("status") or "")
        if current in ("waiting_operator", "waiting_approval"):
            final = current
            error = "" if current == "waiting_operator" else ""
        elif not children:
            final = "failed"
            error = "没有子任务入队"
        elif statuses.get("done", 0) == len(children):
            final = "done"
            error = ""
        elif statuses.get("dead", 0) or statuses.get("failed", 0):
            final = "failed"
            error = "有子步重试用尽"
        elif statuses.get("cancelled", 0):
            final = "cancelled"
            error = "有子步被取消"
        else:
            final = "running"  # 仍在队列里等 daemon / 等退避
            error = ""

        summary = {
            "status": final,
            "steps": [
                {
                    "step_id": step["id"],
                    "name": step["name"],
                    "status": step["status"],
                    "task_ref": step["task_ref"],
                }
                for step in steps
            ],
            "counts": dict(statuses),
            "attempts": attempts,
        }
        if final in ("done", "failed", "cancelled"):
            self.queue.finish(
                parent["task_id"], final, result=summary, error=error or None, now=now
            )
        else:
            # 父任务保持 running / waiting_*；这里只把结果写回去，状态由下一次
            # run / 巡检 / 人工裁决推进。
            with self.store.transaction() as conn:
                conn.execute(
                    "UPDATE task SET result = ?, updated_at = ? WHERE task_id = ?",
                    (dumps(summary), to_iso(now or utcnow()), parent["task_id"]),
                )

        return RunResult(
            task_id=parent["task_id"],
            kind=parent["kind"],
            status=final,
            plan=[spec.to_dict() for spec in specs],
            children=[
                {
                    "task_id": child["task_id"],
                    "step_id": child["step_id"],
                    "kind": child["kind"],
                    "status": child["status"],
                    "attempts": int(child["attempts"]),
                    "result": child["result"],
                    "last_error": child["last_error"],
                }
                for child in children
            ],
            attempts=attempts,
            error=error,
        )
