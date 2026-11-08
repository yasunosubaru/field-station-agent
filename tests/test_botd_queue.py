"""E2 botd 持久队列：并发领取、租约回收、指数退避与终态。

这些测试钉死的是"多 worker 不重复领取"这条底线。只测单线程顺序调用没有意义 ——
真正会出问题的是两个线程同时 ``BEGIN`` 之后都以为自己拿到了同一行。
"""
from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fieldstation.botd.daemon import BotDaemon
from fieldstation.botd.queue import TaskQueue
from fieldstation.botd.store import BotStore, from_iso, to_iso

NOW = datetime(2026, 11, 5, 8, 0, 0, tzinfo=timezone.utc)


class QueueTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db = Path(self._tmp.name) / "botd.sqlite3"
        self.store = BotStore(self.db)
        self.queue = TaskQueue(self.store, backoff_base=10.0, backoff_cap=100.0)

    def enqueue(self, index: int = 0, **overrides) -> dict:
        task = {
            "kind": "demo",
            "title": f"任务 {index}",
            "payload": {"index": index},
        }
        task.update(overrides)
        return self.queue.enqueue(task, now=NOW)


class TestConcurrentLease(QueueTestBase):
    def test_threads_never_lease_the_same_task(self) -> None:
        total = 40
        ids = {self.enqueue(i)["task_id"] for i in range(total)}

        def drain(worker: str) -> list[str]:
            claimed: list[str] = []
            while True:
                task = self.queue.lease(worker, ttl=30.0, now=NOW)
                if task is None:
                    return claimed
                claimed.append(task["task_id"])

        with ThreadPoolExecutor(max_workers=8) as pool:
            batches = list(pool.map(drain, [f"w{i}" for i in range(8)]))

        claimed = [task_id for batch in batches for task_id in batch]
        self.assertEqual(len(claimed), total)
        self.assertEqual(len(set(claimed)), total, "同一个任务被领取了两次")
        self.assertEqual(set(claimed), ids)
        self.assertEqual(self.queue.stats(now=NOW)["running"], total)

    def test_lease_is_exclusive_until_ttl(self) -> None:
        task = self.enqueue()
        first = self.queue.lease("w1", ttl=30.0, now=NOW)
        self.assertEqual(first["task_id"], task["task_id"])
        self.assertEqual(first["status"], "running")
        self.assertEqual(first["lease_owner"], "w1")
        self.assertIsNone(self.queue.lease("w2", ttl=30.0, now=NOW))


class TestLeaseLifecycle(QueueTestBase):
    def test_complete_clears_lease_and_marks_done(self) -> None:
        task = self.enqueue()
        leased = self.queue.lease("w1", ttl=30.0, now=NOW)
        done = self.queue.complete(leased["task_id"], {"ok": True}, now=NOW)
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["result"], {"ok": True})
        self.assertIsNone(done["lease_owner"])
        self.assertIsNone(done["lease_expires_at"])

    def test_reap_expired_returns_task_to_pending_and_counts_attempt(self) -> None:
        task = self.enqueue()
        self.queue.lease("w1", ttl=10.0, now=NOW)
        later = NOW + timedelta(seconds=11)

        self.assertIsNone(self.queue.lease("w2", ttl=10.0, now=later))
        reaped = self.queue.reap_expired(now=later)
        self.assertEqual([item["task_id"] for item in reaped], [task["task_id"]])
        self.assertEqual(reaped[0]["status"], "pending")
        self.assertEqual(
            from_iso(reaped[0]["available_at"]),
            later + timedelta(seconds=10),
            "租约过期按一次失败计，也要走退避",
        )

        self.assertIsNone(
            self.queue.lease("w2", ttl=10.0, now=later + timedelta(seconds=9))
        )
        again = self.queue.lease("w2", ttl=10.0, now=later + timedelta(seconds=10))
        self.assertIsNotNone(again)
        self.assertEqual(again["task_id"], task["task_id"])
        self.assertEqual(again["attempts"], 2, "领取时就要计入一次尝试")

    def test_reap_marks_dead_when_attempts_exhausted(self) -> None:
        task = self.enqueue(max_attempts=1)
        self.queue.lease("w1", ttl=5.0, now=NOW)
        reaped = self.queue.reap_expired(now=NOW + timedelta(seconds=6))
        self.assertEqual(reaped[0]["status"], "dead")
        stored = self.store.get_task(task["task_id"])
        self.assertEqual(stored["status"], "dead")
        self.assertIsNone(stored["lease_owner"])

    def test_heartbeat_extends_only_for_owner(self) -> None:
        task = self.enqueue()
        self.queue.lease("w1", ttl=10.0, now=NOW)
        self.assertFalse(self.queue.heartbeat(task["task_id"], "w2", 10.0, now=NOW))
        self.assertTrue(self.queue.heartbeat(task["task_id"], "w1", 60.0, now=NOW))
        stored = self.store.get_task(task["task_id"])
        self.assertEqual(
            from_iso(stored["lease_expires_at"]), NOW + timedelta(seconds=60)
        )


class TestBackoff(QueueTestBase):
    def test_exponential_backoff_and_dead_letter(self) -> None:
        task = self.enqueue(max_attempts=3)
        leased = self.queue.lease("w1", ttl=30.0, now=NOW)
        self.assertEqual(leased["attempts"], 1)

        failed = self.queue.fail(leased["task_id"], "第一次失败", now=NOW)
        self.assertEqual(failed["status"], "pending")
        self.assertEqual(
            from_iso(failed["available_at"]), NOW + timedelta(seconds=10)
        )
        self.assertIn("第一次失败", failed["last_error"])
        self.assertIsNone(self.queue.lease("w1", ttl=30.0, now=NOW + timedelta(seconds=9)))

        second = self.queue.lease("w1", ttl=30.0, now=NOW + timedelta(seconds=10))
        self.assertEqual(second["attempts"], 2)
        failed = self.queue.fail(second["task_id"], "第二次失败", now=NOW + timedelta(seconds=10))
        self.assertEqual(
            from_iso(failed["available_at"]),
            NOW + timedelta(seconds=10 + 20),
        )

        third = self.queue.lease("w1", ttl=30.0, now=NOW + timedelta(seconds=30))
        self.assertEqual(third["attempts"], 3)
        dead = self.queue.fail(third["task_id"], "第三次失败", now=NOW + timedelta(seconds=30))
        self.assertEqual(dead["status"], "dead")
        self.assertIn("第三次失败", dead["last_error"])
        self.assertEqual(self.queue.stats(now=NOW)["dead"], 1)

    def test_backoff_is_capped_and_explicit_delay_wins(self) -> None:
        self.assertEqual(self.queue.backoff_seconds(1), 10.0)
        self.assertEqual(self.queue.backoff_seconds(2), 20.0)
        self.assertEqual(self.queue.backoff_seconds(9), 100.0)

        task = self.enqueue(max_attempts=5)
        self.queue.lease("w1", ttl=30.0, now=NOW)
        failed = self.queue.fail(task["task_id"], "boom", delay=0.0, now=NOW)
        self.assertEqual(from_iso(failed["available_at"]), NOW)
        self.assertIsNotNone(self.queue.lease("w2", ttl=30.0, now=NOW))

    def test_retry_requeues_without_consuming_attempts(self) -> None:
        task = self.enqueue(max_attempts=1)
        self.queue.lease("w1", ttl=5.0, now=NOW)
        self.queue.fail(task["task_id"], "毒任务", now=NOW)
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "dead")

        revived = self.queue.retry(task["task_id"], delay=3.0, now=NOW)
        self.assertEqual(revived["status"], "pending")
        self.assertEqual(revived["attempts"], 1)
        self.assertEqual(from_iso(revived["available_at"]), NOW + timedelta(seconds=3))
        self.assertIsNone(self.queue.lease("w1", 5.0, now=NOW + timedelta(seconds=2)))
        self.assertIsNotNone(self.queue.lease("w1", 5.0, now=NOW + timedelta(seconds=3)))


class TestValidation(QueueTestBase):
    def test_enqueue_rejects_unknown_field_and_empty_kind(self) -> None:
        with self.assertRaises(ValueError):
            self.queue.enqueue({"kind": "demo", "paylod": {}}, now=NOW)
        with self.assertRaises(ValueError):
            self.queue.enqueue({"kind": "   "}, now=NOW)
        with self.assertRaises(ValueError):
            self.queue.enqueue({"kind": "demo", "max_attempts": 0}, now=NOW)

    def test_lease_requires_worker_and_positive_ttl(self) -> None:
        self.enqueue()
        with self.assertRaises(ValueError):
            self.queue.lease("", ttl=10.0, now=NOW)
        with self.assertRaises(ValueError):
            self.queue.lease("w1", ttl=0, now=NOW)

    def test_missing_task_raises_key_error(self) -> None:
        for call in (
            lambda: self.queue.complete("t-missing", now=NOW),
            lambda: self.queue.fail("t-missing", "x", now=NOW),
        ):
            with self.assertRaises(KeyError):
                call()

    def test_migration_is_idempotent_and_memory_db_is_rejected(self) -> None:
        self.assertEqual(self.store.schema_version(), 3)
        self.assertEqual(BotStore(self.db).schema_version(), 3)
        with self.assertRaises(ValueError):
            BotStore(":memory:")

        with self.store.connect() as conn:
            journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
            names = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        self.assertEqual(journal.lower(), "wal")
        self.assertTrue(
            {"bot", "task", "step", "memory", "intervention", "run_link"} <= names
        )


class TestDaemonTick(QueueTestBase):
    def test_tick_leases_executes_completes_and_then_idles(self) -> None:
        task = self.enqueue()
        seen: list[str] = []

        def handler(row: dict) -> dict:
            seen.append(row["task_id"])
            return {"ok": True, "handled": row["task_id"]}

        daemon = BotDaemon(
            self.store,
            queue=self.queue,
            handler=handler,
            worker="botd-test",
            ttl=30.0,
            clock=lambda: NOW,
        )
        first = daemon.tick()
        self.assertEqual(first["action"], "ran")
        self.assertEqual(first["task_id"], task["task_id"])
        self.assertEqual(seen, [task["task_id"]])
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "done")

        second = daemon.tick()
        self.assertEqual(second["action"], "idle")
        self.assertEqual(second["status"], "idle")
        self.assertIsNone(second["task_id"])

    def test_tick_records_failure_and_reschedules(self) -> None:
        task = self.enqueue(max_attempts=3)

        def handler(row: dict) -> dict:
            raise RuntimeError("工具不可用")

        daemon = BotDaemon(
            self.store,
            queue=self.queue,
            handler=handler,
            clock=lambda: NOW,
            retry_delay=0.0,
        )
        result = daemon.tick()
        self.assertEqual(result["action"], "failed")
        self.assertEqual(result["status"], "pending")
        self.assertIn("工具不可用", result["error"])
        stored = self.store.get_task(task["task_id"])
        self.assertEqual(stored["attempts"], 1)
        self.assertEqual(stored["status"], "pending")

    def test_tick_reaps_expired_lease_before_leasing(self) -> None:
        task = self.enqueue()
        self.queue.lease("dead-worker", ttl=10.0, now=NOW)
        later = NOW + timedelta(seconds=11)
        clock = [later]
        daemon = BotDaemon(
            self.store, queue=self.queue, clock=lambda: clock[0], ttl=30.0
        )

        first = daemon.tick()
        self.assertEqual(first["reaped"], [task["task_id"]])
        self.assertEqual(first["action"], "idle", "回收后要等退避，不应立刻再领")
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "pending")

        clock[0] = later + timedelta(seconds=10)
        second = daemon.tick()
        self.assertEqual(second["reaped"], [])
        self.assertEqual(second["action"], "ran")
        self.assertEqual(self.store.get_task(task["task_id"])["status"], "done")

    def test_once_returns_single_result(self) -> None:
        daemon = BotDaemon(
            self.store, queue=self.queue, clock=lambda: NOW, sleep=lambda _: None
        )
        results = daemon.run(once=True)
        self.assertEqual(len(results), 1)

    def test_iso_format_round_trip(self) -> None:
        self.assertEqual(from_iso(to_iso(NOW)), NOW)
        self.assertEqual(from_iso("2026-11-05T08:00:00Z"), NOW)


if __name__ == "__main__":
    unittest.main()
