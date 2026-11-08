"""E2 botd 持久队列：租约、退避、回收。

语义对齐 "SKIP LOCKED"：

* 领取在 ``BEGIN IMMEDIATE`` 里完成 "选一行 → 改成 running"，SQLite 的写锁
  保证同一时刻只有一个事务在选，后到的事务排队而不是拿到同一行；
* 不用 ``SELECT ... FOR UPDATE SKIP LOCKED``（SQLite 没有），也不在 Python
  里加锁 —— 那只能挡住同进程的线程，挡不住第二个 ``botd`` 进程；
* 崩溃恢复靠租约过期：worker 挂了不会把任务永远锁死，``reap_expired``
  把过期租约按"失败一次"处理，计入 ``attempts``。

状态机::

    pending --lease--> running --complete--> done
       ^                  |
       |                  +--fail/租约过期--> pending（还有次数）
       |                                   \\-> dead（次数用尽）
       +--retry（人工/显式）------------------+

另有两条**不进队列主循环**的状态（契约 §2.1）：``waiting_approval`` /
``waiting_operator`` 表示任务停在闸门上等人。它们必须保持
``status != 'pending'``，否则 ``lease`` 会把一个正在等人批的任务重新领走，
闸门就形同虚设。``resume`` 的写法是把状态改回 ``pending``，而不是新开一条。

``attempts`` 在**领取时**加一，而不是失败时：这样"领取后进程直接崩掉"也算
消耗了一次，不会无限重试同一个毒任务。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Optional

from .store import (
    BotStore,
    TASK_STATUSES,
    _task_dict,
    add_seconds,
    dumps,
    from_iso,
    to_iso,
    utcnow,
)

#: enqueue 认识的字段；多传字段视为调用方写错，直接报错而不是悄悄吞掉。
_TASK_FIELDS = frozenset(
    {
        "kind", "bot_id", "parent_task_id", "step_id", "title", "payload",
        "priority", "max_attempts", "available_at", "task_id",
    }
)


class TaskQueue:
    """基于 :class:`BotStore` 的任务队列。"""

    def __init__(
        self,
        store: BotStore,
        *,
        backoff_base: float = 2.0,
        backoff_cap: float = 3600.0,
        default_max_attempts: int = 5,
    ) -> None:
        if backoff_base <= 0:
            raise ValueError("backoff_base 必须为正数")
        if backoff_cap < backoff_base:
            raise ValueError("backoff_cap 不能小于 backoff_base")
        if default_max_attempts < 1:
            raise ValueError("default_max_attempts 至少为 1")
        self.store = store
        self.backoff_base = float(backoff_base)
        self.backoff_cap = float(backoff_cap)
        self.default_max_attempts = int(default_max_attempts)

    # ------------------------------------------------------------ 入队 --
    def enqueue(self, task: Mapping[str, Any], *, now: Optional[datetime] = None) -> dict:
        """把一条任务写入队列，返回完整行。

        ``available_at`` 可以是 ``datetime``（延迟任务），缺省为立即可领。
        """
        if not isinstance(task, Mapping):
            raise TypeError("enqueue 需要 mapping（kind / payload / ...）")
        unknown = set(task) - _TASK_FIELDS
        if unknown:
            raise ValueError(f"enqueue 收到未知字段：{sorted(unknown)}")
        moment = now or utcnow()
        available = task.get("available_at")
        if available is not None and not isinstance(available, datetime):
            raise TypeError("available_at 必须是 datetime")
        return self.store.create_task(
            kind=task.get("kind", ""),
            bot_id=task.get("bot_id"),
            parent_task_id=task.get("parent_task_id"),
            step_id=task.get("step_id"),
            title=task.get("title", ""),
            payload=task.get("payload"),
            priority=int(task.get("priority", 0)),
            max_attempts=int(task.get("max_attempts", self.default_max_attempts)),
            available_at=available,
            now=moment,
            task_id=task.get("task_id"),
        )

    # ------------------------------------------------------------ 领取 --
    def lease(
        self,
        worker: str,
        ttl: float = 60.0,
        *,
        now: Optional[datetime] = None,
        parent_task_id: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> Optional[dict]:
        """领取一条到期任务；没有可领的返回 ``None``。

        ``ttl`` 秒内该任务只属于 ``worker``；过期后由 ``reap_expired`` 收回。
        """
        if not isinstance(worker, str) or not worker.strip():
            raise ValueError("worker 必须是非空字符串")
        if ttl <= 0:
            raise ValueError("ttl 必须为正数")
        moment = now or utcnow()
        stamp = to_iso(moment)
        expires = to_iso(add_seconds(moment, ttl))
        clauses = ["status = 'pending'", "available_at <= ?"]
        params: list[Any] = [stamp]
        if parent_task_id is not None:
            clauses.append("parent_task_id = ?")
            params.append(parent_task_id)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        where = " AND ".join(clauses)
        with self.store.transaction() as conn:
            row = conn.execute(
                f"""
                SELECT task_id FROM task
                WHERE {where}
                ORDER BY priority DESC, available_at ASC, created_at ASC, rowid ASC
                LIMIT 1
                """,
                params,
            ).fetchone()
            if row is None:
                return None
            task_id = row["task_id"]
            updated = conn.execute(
                """
                UPDATE task
                SET status = 'running', lease_owner = ?, lease_expires_at = ?,
                    attempts = attempts + 1, updated_at = ?
                WHERE task_id = ? AND status = 'pending'
                """,
                (worker.strip(), expires, stamp, task_id),
            )
            if updated.rowcount != 1:  # pragma: no cover - 事务内理论上不会发生
                return None
            fresh = conn.execute(
                "SELECT * FROM task WHERE task_id = ?", (task_id,)
            ).fetchone()
        return _task_dict(fresh)

    def heartbeat(
        self,
        task_id: str,
        worker: str,
        ttl: float = 60.0,
        *,
        now: Optional[datetime] = None,
    ) -> bool:
        """续租；只有仍由该 worker 持有的 running 任务才续得上。"""
        if ttl <= 0:
            raise ValueError("ttl 必须为正数")
        moment = now or utcnow()
        with self.store.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE task SET lease_expires_at = ?, updated_at = ?
                WHERE task_id = ? AND status = 'running' AND lease_owner = ?
                """,
                (to_iso(add_seconds(moment, ttl)), to_iso(moment), task_id, worker),
            )
        return cur.rowcount == 1

    # -------------------------------------------------------- 完成 / 失败 --
    def complete(
        self,
        task_id: str,
        result: Any = None,
        *,
        now: Optional[datetime] = None,
    ) -> dict:
        moment = now or utcnow()
        with self.store.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE task
                SET status = 'done', result = ?, last_error = NULL,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE task_id = ?
                """,
                (_json(result), to_iso(moment), task_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"任务不存在：{task_id!r}")
        return self.store.get_task(task_id)

    def finish(
        self,
        task_id: str,
        status: str,
        *,
        result: Any = None,
        error: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        """把任务直接置为终态（汇总父任务用；不要求持有租约）。"""
        if status not in ("done", "failed", "dead", "cancelled"):
            raise ValueError(f"finish 不接受非终态：{status!r}")
        with self.store.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE task
                SET status = ?, result = ?, last_error = ?,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE task_id = ?
                """,
                (status, _json(result), error, to_iso(now or utcnow()), task_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"任务不存在：{task_id!r}")
        return self.store.get_task(task_id)

    def fail(
        self,
        task_id: str,
        error: Any,
        *,
        retry: bool = True,
        delay: Optional[float] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        """失败处理：可重试则按指数退避回到 pending，否则落 ``dead``。

        ``delay`` 显式给出时不做退避计算（测试/人工重排用）。
        """
        moment = now or utcnow()
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT attempts, max_attempts, status FROM task WHERE task_id = ?",
                (task_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"任务不存在：{task_id!r}")
            attempts = int(row["attempts"])
            max_attempts = int(row["max_attempts"])
            if retry and attempts < max_attempts:
                wait = self.backoff_seconds(attempts) if delay is None else float(delay)
                available = to_iso(add_seconds(moment, max(0.0, wait)))
                status = "pending"
            else:
                available = to_iso(moment)
                status = "failed" if not retry else "dead"
            conn.execute(
                """
                UPDATE task
                SET status = ?, available_at = ?, last_error = ?,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE task_id = ?
                """,
                (status, available, _error_text(error), to_iso(moment), task_id),
            )
        return self.store.get_task(task_id)

    def retry(
        self,
        task_id: str,
        *,
        delay: float = 0.0,
        now: Optional[datetime] = None,
    ) -> dict:
        """显式重排（人工/监督者用），不消耗 attempts、也不重置它。

        如果任务已经 ``dead``，重排后仍可能在下一次失败时立刻回到 ``dead``；
        要真正放行请调大 ``max_attempts``（见 :meth:`set_max_attempts`）。
        """
        if delay < 0:
            raise ValueError("delay 不能为负")
        moment = now or utcnow()
        with self.store.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE task
                SET status = 'pending', available_at = ?, lease_owner = NULL,
                    lease_expires_at = NULL, updated_at = ?
                WHERE task_id = ?
                """,
                (to_iso(add_seconds(moment, delay)), to_iso(moment), task_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"任务不存在：{task_id!r}")
        return self.store.get_task(task_id)

    def set_max_attempts(
        self, task_id: str, max_attempts: int, *, now: Optional[datetime] = None
    ) -> dict:
        if int(max_attempts) < 1:
            raise ValueError("max_attempts 至少为 1")
        with self.store.transaction() as conn:
            cur = conn.execute(
                "UPDATE task SET max_attempts = ?, updated_at = ? WHERE task_id = ?",
                (int(max_attempts), to_iso(now or utcnow()), task_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"任务不存在：{task_id!r}")
        return self.store.get_task(task_id)

    def cancel(self, task_id: str, *, now: Optional[datetime] = None) -> dict:
        with self.store.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE task SET status = 'cancelled', lease_owner = NULL,
                                lease_expires_at = NULL, updated_at = ?
                WHERE task_id = ? AND status IN ('pending', 'running')
                """,
                (to_iso(now or utcnow()), task_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"任务不存在或已终态：{task_id!r}")
        return self.store.get_task(task_id)

    # ------------------------------------------------------------ 回收 --
    def reap_expired(self, *, now: Optional[datetime] = None) -> list[dict]:
        """收回过期租约，返回每条任务的处置结果。

        过期按失败一次处理：``attempts`` 在领取时已计入，这里只决定
        "回到 pending 等退避" 还是 "落 dead"。
        """
        moment = now or utcnow()
        stamp = to_iso(moment)
        reaped: list[dict] = []
        with self.store.transaction() as conn:
            rows = conn.execute(
                """
                SELECT task_id, attempts, max_attempts FROM task
                WHERE status = 'running' AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= ?
                ORDER BY lease_expires_at, rowid
                """,
                (stamp,),
            ).fetchall()
            for row in rows:
                attempts = int(row["attempts"])
                max_attempts = int(row["max_attempts"])
                if attempts < max_attempts:
                    wait = self.backoff_seconds(attempts)
                    available = to_iso(add_seconds(moment, wait))
                    status = "pending"
                else:
                    wait = 0.0
                    available = stamp
                    status = "dead"
                conn.execute(
                    """
                    UPDATE task
                    SET status = ?, available_at = ?,
                        last_error = COALESCE(last_error, '租约过期'),
                        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                    WHERE task_id = ?
                    """,
                    (status, available, stamp, row["task_id"]),
                )
                reaped.append(
                    {
                        "task_id": row["task_id"],
                        "status": status,
                        "attempts": attempts,
                        "available_at": available,
                        "delay_seconds": wait,
                    }
                )
        return reaped

    # ------------------------------------------------------------ 辅助 --
    def backoff_seconds(self, attempts: int) -> float:
        """第 ``attempts`` 次失败后的等待秒数：base * 2**(n-1)，带上限。"""
        n = max(1, int(attempts))
        return min(self.backoff_cap, self.backoff_base * (2.0 ** (n - 1)))

    def stats(self, *, now: Optional[datetime] = None) -> dict:
        moment = now or utcnow()
        with self.store.connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM task GROUP BY status"
            ).fetchall()
            ready = conn.execute(
                """
                SELECT COUNT(*) FROM task
                WHERE status = 'pending' AND available_at <= ?
                """,
                (to_iso(moment),),
            ).fetchone()[0]
            expired = conn.execute(
                """
                SELECT COUNT(*) FROM task
                WHERE status = 'running' AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= ?
                """,
                (to_iso(moment),),
            ).fetchone()[0]
        counts = {status: 0 for status in TASK_STATUSES}
        for row in rows:
            counts[row["status"]] = int(row["n"])
        counts["ready"] = int(ready)
        counts["expired_leases"] = int(expired)
        return counts

    def pending_children(self, parent_task_id: str) -> int:
        with self.store.connect() as conn:
            return int(
                conn.execute(
                    """
                    SELECT COUNT(*) FROM task
                    WHERE parent_task_id = ? AND status IN ('pending', 'running')
                    """,
                    (parent_task_id,),
                ).fetchone()[0]
            )


def _json(value: Any) -> Optional[str]:
    if value is None:
        return None
    return dumps(value)


def _error_text(error: Any) -> str:
    if isinstance(error, BaseException):
        text = f"{type(error).__name__}: {error}"
    else:
        text = str(error)
    return text[:4000]


def lease_expired(task: Mapping[str, Any], now: datetime) -> bool:
    """判断一条 running 任务的租约是否已过期（给巡检脚本复用）。"""
    expires = task.get("lease_expires_at")
    if not expires:
        return False
    return from_iso(expires) <= now
