"""E2 botd 常驻主循环：一次 tick = 回收 → 领取 → 执行一步 → 记账。

时钟可注入（``clock`` 返回 ``datetime``），所以测试推进"租约过期"不用真等
60 秒；``--once`` 只跑一个 tick，方便 CI 与人工排查。

刻意保持"一次只做一个任务"：编队里的 worker 是多个进程，每个进程串行执行，
并发度由进程数决定。这样单次执行的失败边界很清楚（失败的就是手上这一条），
也不会出现一个 worker 同时占着几个租约、内存里搅在一起。
"""
from __future__ import annotations

import time as _time
from datetime import datetime
from typing import Any, Callable, List, Optional

from .queue import TaskQueue
from .store import BotStore, to_iso, utcnow
from .supervisor import is_failure_result, result_text

Handler = Callable[[dict], Any]


def default_handler(task: dict) -> dict:
    """兜底执行器：不接真实工具，只回报"哪条任务被处理了"。

    daemon 的骨架价值在于队列/租约/回收跑通；真正的工作由调用方通过
    ``handler`` 注入。默认实现故意什么都不做，避免"看起来跑了其实没跑"。
    """
    return {
        "ok": True,
        "task_id": task["id"],
        "kind": task["kind"],
        "note": "botd 默认执行器：仅确认领取与完成",
    }


class BotDaemon:
    """可注入时钟与执行器的 botd 主循环。"""

    def __init__(
        self,
        store: BotStore,
        *,
        handler: Optional[Handler] = None,
        queue: Optional[TaskQueue] = None,
        worker: str = "botd",
        ttl: float = 60.0,
        clock: Optional[Callable[[], datetime]] = None,
        retry_delay: Optional[float] = None,
        sleep: Callable[[float], None] = _time.sleep,
    ) -> None:
        if ttl <= 0:
            raise ValueError("ttl 必须为正数")
        if retry_delay is not None and retry_delay < 0:
            raise ValueError("retry_delay 不能为负")
        self.store = store
        self.queue = queue or TaskQueue(store)
        self.handler: Handler = handler or default_handler
        self.worker = worker
        self.ttl = float(ttl)
        self.clock = clock or utcnow
        self.retry_delay = retry_delay
        self._sleep = sleep
        self.ticks = 0

    # ---------------------------------------------------------------- tick --
    def tick(self) -> dict:
        """执行一个完整周期，返回本次结果（可直接 JSON 序列化）。"""
        self.ticks += 1
        now = self.clock()
        reaped = self.queue.reap_expired(now=now)
        base = {
            "tick": self.ticks,
            "at": to_iso(now),
            "reaped": [item["task_id"] for item in reaped],
        }
        task = self.queue.lease(self.worker, ttl=self.ttl, now=now)
        if task is None:
            base.update({"action": "idle", "task_id": None, "status": "idle"})
            return base

        base.update(
            {
                "task_id": task["id"],
                "kind": task["kind"],
                "attempts": int(task["attempts"]),
                "parent_id": task.get("parent_id"),
                "step_id": task.get("step_id"),
            }
        )
        try:
            result = self.handler(dict(task))
        except Exception as exc:  # noqa: BLE001 - 执行失败要落库，不能带走 daemon
            updated = self.queue.fail(
                task["id"], exc, delay=self.retry_delay, now=now
            )
            self._sync_step(task, updated, error=result_text(exc), now=now)
            base.update(
                {
                    "action": "failed",
                    "status": updated["status"],
                    "error": result_text(exc),
                }
            )
            return base

        if is_failure_result(result):
            updated = self.queue.fail(
                task["id"],
                result_text(result),
                delay=self.retry_delay,
                now=now,
            )
            self._sync_step(task, updated, error=result_text(result), now=now)
            base.update(
                {
                    "action": "failed",
                    "status": updated["status"],
                    "error": result_text(result),
                }
            )
            return base

        updated = self.queue.complete(task["id"], result, now=now)
        self._sync_step(task, updated, output=result, now=now)
        base.update({"action": "ran", "status": updated["status"], "result": result})
        return base

    def _sync_step(
        self,
        task: dict,
        updated: dict,
        *,
        output: Any = None,
        error: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> None:
        """把队列任务的状态回写到 ``step`` 表。

        Supervisor 拆出的子步在 ``step`` 里有独立记录；daemon 才是实际执行者，
        如果不回写，父任务汇总时看到的永远是 "pending"。没有 ``step_id`` 的
        普通任务直接跳过。
        """
        step_id = task.get("step_id")
        if not step_id:
            return
        status = updated.get("status")
        if status == "done":
            step_status = "done"
        elif status == "pending":
            step_status = "pending"
        elif status in ("failed", "dead"):
            step_status = "failed"
        elif status == "cancelled":
            step_status = "skipped"
        else:  # pragma: no cover - 队列不会给出其它状态
            return
        try:
            self.store.update_step(
                step_id,
                status=step_status,
                output=output,
                error="" if step_status == "done" else error,
                attempts=int(updated.get("attempts", 0)),
                now=now,
            )
        except KeyError:
            # 步骤被清理而任务还在队列里：不因为一条孤儿记录让 daemon 崩掉。
            return

    # ----------------------------------------------------------------- run --
    def run(
        self,
        *,
        once: bool = False,
        max_ticks: Optional[int] = None,
        interval: float = 1.0,
        stop_when_idle: bool = False,
    ) -> List[dict]:
        """跑主循环；``once`` 或 ``max_ticks`` 到达后返回所有 tick 结果。"""
        if interval < 0:
            raise ValueError("interval 不能为负")
        results: List[dict] = []
        while True:
            results.append(self.tick())
            if once:
                break
            if max_ticks is not None and len(results) >= int(max_ticks):
                break
            if stop_when_idle and results[-1]["action"] == "idle":
                break
            self._sleep(interval)
        return results
