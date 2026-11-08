# -*- coding: utf-8 -*-
"""E2 契约回归：``docs/contracts/run-link.md`` 的五条查询与迁移语义。

这个文件存在的理由：契约 §3 的五条查询**在 Bot-6 之前一条都跑不了**（缺
``thread`` / ``agent`` / ``work_order`` 三张表，``run_link`` 缺 ``kind``，
``task`` 主键还叫 ``id``）。单独跑得通的单元测试证明不了"契约能落地"，只有把
契约里的 SQL **原样**抄进来、对着真库执行一遍才算。

所以这里的期望值一律取自契约原文，不从实现反推：

* §3.1 一条 task 拉全四本账 —— 1 行 × 12 列
* §3.2 从工单反查 —— 走 ``run_link`` 回到 task / thread / agent
* §3.3 某台站未结工单 —— 按 ``priority`` 再 ``created_at`` 排序
* §3.4 崩溃后续跑 —— 找出可恢复的 task 与线程
* §3.5 孤儿与断链体检 —— 两条都返回 0 行

另外覆盖迁移本身：v1 老库升到 v3 后**数据不丢、版本号对、九张表齐**，
以及 ``risk=high`` 的工单没有批准人不能进 ``done``（``E_PRECOND``）。
"""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fieldstation.botd.store import (
    BotStore,
    PreconditionError,
    SCHEMA_VERSION,
    TASK_STATUSES,
)

NOW = datetime(2026, 11, 8, 12, 0, 0, tzinfo=timezone.utc)

#: 契约 §2 要求的九张表（v1 六张 + v2 三张）。
ALL_TABLES = {
    "bot", "task", "step", "memory", "intervention", "run_link",
    "thread", "agent", "work_order",
}


class StoreTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "botd.sqlite3"
        self.store = BotStore(self.db, migrate=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def make_task(self, **kwargs) -> dict:
        kwargs.setdefault("kind", "bot")
        kwargs.setdefault("now", NOW)
        return self.store.create_task(**kwargs)

    def link_everything(self, task_id: str) -> dict:
        """按契约 §4 的写入时序把三本账都挂到同一个 task 上。"""
        thread = self.store.create_thread(
            runtime="claude",
            external_thread_id="sdk-session-1",
            checkpointer_ns="langgraph",
            trace_path="trace/2026-11-08.jsonl",
            now=NOW,
        )
        agent = self.store.create_agent(
            name="supervisor",
            kind="supervisor",
            spec_path="agents/fsa-ops.yaml",
            spec_sha256="0" * 64,
            runtime="claude",
            model="deepseek-v4.1-flash",
            memory_namespace="fsa/ops",
            allowed_tools=["read_file", "run_rpa"],
            now=NOW,
        )
        order = self.store.create_work_order(
            station_id="WUHN",
            title="接收机无数据",
            priority="P0",
            risk="low",
            created_by="agent:supervisor",
            evidence_call_ids=["call-1"],
            now=NOW,
        )
        self.store.link(kind="thread", provider="langgraph",
                        external_id=thread["thread_id"], task_id=task_id, now=NOW)
        self.store.link(kind="agent", provider="letta",
                        external_id=agent["agent_id"], task_id=task_id, now=NOW)
        self.store.link(kind="work_order", provider="ledger",
                        external_id=order["work_order_id"], task_id=task_id, now=NOW)
        return {"thread": thread, "agent": agent, "order": order}


class TestSchemaShape(StoreTestBase):
    def test_schema_version_is_current(self) -> None:
        self.assertEqual(SCHEMA_VERSION, 3)
        self.assertEqual(self.store.schema_version(), 3)

    def test_all_nine_tables_exist(self) -> None:
        with self.store.connect() as conn:
            names = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertTrue(ALL_TABLES <= names, f"缺表：{sorted(ALL_TABLES - names)}")

    def test_run_link_has_kind_and_link_id(self) -> None:
        with self.store.connect() as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(run_link)")]
        self.assertIn("kind", columns)
        self.assertIn("link_id", columns)
        # 契约 §5：id → link_id 是改列名；bot_id 保留但 deprecated
        self.assertNotIn("id", columns)

    def test_run_link_indexes_are_the_contract_ones(self) -> None:
        """v1 的 idx_run_link_* 已被 ux_/ix_ 取代，不能两个都留着。"""
        with self.store.connect() as conn:
            names = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
                " AND name LIKE '%run_link%'"
                " AND name NOT LIKE 'sqlite_autoindex%'")}
        self.assertEqual(names, {"ux_run_link_external", "ix_run_link_task"})

    def test_task_columns_match_contract(self) -> None:
        with self.store.connect() as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(task)")]
        self.assertIn("task_id", columns)
        self.assertIn("parent_task_id", columns)
        self.assertIn("root_task_id", columns)
        self.assertNotIn("id", columns)
        self.assertNotIn("parent_id", columns)

    def test_migrate_is_idempotent(self) -> None:
        self.assertEqual(BotStore(self.db).schema_version(), 3)
        self.assertEqual(BotStore(self.db).schema_version(), 3)

    def test_contract_indexes_exist(self) -> None:
        with self.store.connect() as conn:
            names = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'")}
        for expected in ("ux_run_link_external", "ix_run_link_task",
                         "idx_task_parent", "idx_task_ready"):
            self.assertIn(expected, names)


class TestTaskTree(StoreTestBase):
    def test_root_task_id_points_at_itself(self) -> None:
        root = self.make_task()
        self.assertEqual(root["root_task_id"], root["task_id"])

    def test_children_inherit_root(self) -> None:
        root = self.make_task()
        child = self.make_task(parent_task_id=root["task_id"])
        grandchild = self.make_task(parent_task_id=child["task_id"])
        self.assertEqual(child["root_task_id"], root["task_id"])
        # 契约 §2.1：一次拉全树，孙辈也必须指回根，不能只指父
        self.assertEqual(grandchild["root_task_id"], root["task_id"])

    def test_list_tasks_by_root(self) -> None:
        root = self.make_task()
        child = self.make_task(parent_task_id=root["task_id"])
        self.make_task(parent_task_id=child["task_id"])
        self.make_task()  # 另一个根，不该被拉进来
        rows = self.store.list_tasks(root_task_id=root["task_id"])
        self.assertEqual(len(rows), 3)

    def test_waiting_statuses_are_accepted(self) -> None:
        # 契约 §2.1 的状态枚举里有这两个；v1 的 TASK_STATUSES 没有
        for status in ("waiting_approval", "waiting_operator"):
            with self.subTest(status=status):
                self.assertIn(status, TASK_STATUSES)
                task = self.make_task(status=status)
                self.assertEqual(task["status"], status)

    def test_waiting_tasks_are_not_leased(self) -> None:
        """挂起（等审批/等操作员）的任务不能被 worker 领走。"""
        from fieldstation.botd.queue import TaskQueue

        queue = TaskQueue(self.store)
        self.make_task(status="waiting_approval")
        self.make_task(status="waiting_operator")
        self.assertIsNone(queue.lease("w1", ttl=60.0, now=NOW))
        ready = self.make_task(status="pending")
        leased = queue.lease("w1", ttl=60.0, now=NOW)
        self.assertIsNotNone(leased)
        self.assertEqual(leased["task_id"], ready["task_id"])

    def test_unknown_status_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.make_task(status="paused")


class TestRunLink(StoreTestBase):
    def test_link_rejects_inconsistent_kind(self) -> None:
        task = self.make_task()
        with self.assertRaises(ValueError):
            self.store.link(kind="agent", provider="langgraph",
                            external_id="th-1", task_id=task["task_id"])

    def test_link_rejects_unknown_provider(self) -> None:
        task = self.make_task()
        with self.assertRaises(ValueError):
            self.store.link(kind="thread", provider="postgres",
                            external_id="th-1", task_id=task["task_id"])

    def test_link_is_upsert_not_duplicate(self) -> None:
        task = self.make_task()
        first = self.store.link(kind="thread", provider="langgraph",
                                external_id="th-1", task_id=task["task_id"], now=NOW)
        second = self.store.link(kind="thread", provider="langgraph",
                                 external_id="th-1", task_id=task["task_id"], now=NOW)
        self.assertEqual(first["link_id"], second["link_id"])
        self.assertEqual(len(self.store.list_run_links()), 1)

    def test_unlink_keeps_the_row(self) -> None:
        task = self.make_task()
        self.store.link(kind="thread", provider="langgraph",
                        external_id="th-1", task_id=task["task_id"], now=NOW)
        row = self.store.unlink(provider="langgraph", external_id="th-1", now=NOW)
        self.assertEqual(row["status"], "unlinked")
        # 契约 §1 第 3 条：追加型，不物理删
        self.assertEqual(len(self.store.list_run_links()), 1)

    def test_bot_id_moves_into_detail(self) -> None:
        task = self.make_task()
        row = self.store.link(kind="thread", provider="langgraph",
                              external_id="th-1", task_id=task["task_id"],
                              bot_id="bot-7", now=NOW)
        self.assertEqual(row["detail"]["bot_id"], "bot-7")

    def test_kind_check_constraint_is_enforced(self) -> None:
        with self.store.transaction() as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO run_link (link_id, kind, provider, external_id,"
                    " status, detail, created_at, updated_at)"
                    " VALUES ('r-x', 'nonsense', 'langgraph', 'th-x', 'linked',"
                    " '{}', 'now', 'now')")


class TestContractQueries(StoreTestBase):
    """契约 §3 五条查询。SQL 原样搬进实现，这里验结果。"""

    def test_q31_one_task_pulls_four_ledgers(self) -> None:
        task = self.make_task()
        made = self.link_everything(task["task_id"])
        rows = self.store.task_accounts(task["task_id"])
        self.assertEqual(len(rows), 1, "§3.1 预期 1 行")
        row = rows[0]
        self.assertEqual(len(row), 12, "§3.1 预期 12 列")
        self.assertEqual(row["task_id"], task["task_id"])
        self.assertEqual(row["thread_id"], made["thread"]["thread_id"])
        self.assertEqual(row["agent_id"], made["agent"]["agent_id"])
        self.assertEqual(row["work_order_id"], made["order"]["work_order_id"])

    def test_q31_missing_links_are_null_not_empty_string(self) -> None:
        task = self.make_task()
        rows = self.store.task_accounts(task["task_id"])
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["thread_id"], "契约 §3.1：没有的关联给 NULL")
        self.assertIsNone(rows[0]["agent_id"])

    def test_q32_work_order_traces_back(self) -> None:
        task = self.make_task()
        made = self.link_everything(task["task_id"])
        rows = self.store.work_order_trace(made["order"]["work_order_id"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["task_id"], task["task_id"])
        self.assertEqual(rows[0]["thread_id"], made["thread"]["thread_id"])
        self.assertEqual(rows[0]["agent_id"], made["agent"]["agent_id"])

    def test_q33_open_orders_sorted_by_priority(self) -> None:
        task = self.make_task()
        for priority in ("P3", "P0", "P2"):
            self.store.create_work_order(
                station_id="WUHN", title=f"t-{priority}", priority=priority,
                risk="low", created_by="user:1", now=NOW)
        self.store.create_work_order(
            station_id="WUHN", title="done-one", priority="P0", risk="low",
            created_by="user:1", status="done", now=NOW)
        rows = self.store.list_work_orders(station_id="WUHN", open_only=True)
        self.assertEqual([r["priority"] for r in rows], ["P0", "P2", "P3"])
        self.assertNotIn("done-one", [r["title"] for r in rows])

    def test_q34_resumable_tasks(self) -> None:
        task = self.make_task()
        made = self.link_everything(task["task_id"])
        # 契约 §3.4 只挑这三种状态
        with self.store.transaction() as conn:
            conn.execute("UPDATE task SET status = 'running',"
                         " lease_expires_at = NULL WHERE task_id = ?",
                         (task["task_id"],))
        rows = self.store.resumable_tasks(now=NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["thread_id"], made["thread"]["thread_id"])
        self.assertEqual(rows[0]["last_event_seq"], 0)

    def test_q34_skips_tasks_with_live_lease(self) -> None:
        task = self.make_task()
        self.link_everything(task["task_id"])
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE task SET status = 'running', lease_expires_at = ?"
                " WHERE task_id = ?",
                ("2099-01-01T00:00:00.000000+00:00", task["task_id"]))
        self.assertEqual(self.store.resumable_tasks(now=NOW), [])

    def test_q35_orphan_checks_both_return_zero(self) -> None:
        task = self.make_task()
        self.link_everything(task["task_id"])
        # 一条完整的、关联齐全的 task 不该被体检报出来
        self.assertEqual(self.store.orphan_links(), [])
        self.assertEqual(self.store.unlinked_tasks(), [])

    def test_q35_orphan_link_is_reported(self) -> None:
        task = self.make_task()
        self.store.link(kind="thread", provider="langgraph",
                        external_id="th-missing", task_id=task["task_id"], now=NOW)
        orphans = self.store.orphan_links()
        self.assertEqual(len(orphans), 1)
        self.assertEqual(orphans[0]["external_id"], "th-missing")

    def test_q35_unlinked_task_is_reported(self) -> None:
        task = self.make_task(status="running")
        unlinked = self.store.unlinked_tasks()
        self.assertEqual([r["task_id"] for r in unlinked], [task["task_id"]])


class TestWorkOrderStateMachine(StoreTestBase):
    def test_high_risk_cannot_close_without_approval(self) -> None:
        order = self.store.create_work_order(
            station_id="WUHN", title="重启接收机", priority="P0", risk="high",
            created_by="agent:ops", now=NOW)
        with self.assertRaises(PreconditionError) as ctx:
            self.store.update_work_order(order["work_order_id"], status="done", now=NOW)
        self.assertEqual(ctx.exception.code, "E_PRECOND")

    def test_high_risk_closes_after_approval(self) -> None:
        order = self.store.create_work_order(
            station_id="WUHN", title="重启接收机", priority="P0", risk="high",
            created_by="agent:ops", now=NOW)
        self.store.update_work_order(order["work_order_id"], approved_by="user:1", now=NOW)
        done = self.store.update_work_order(order["work_order_id"], status="done", now=NOW)
        self.assertEqual(done["status"], "done")
        self.assertIsNotNone(done["closed_at"], "终态必须写 closed_at")

    def test_low_risk_closes_without_approval(self) -> None:
        order = self.store.create_work_order(
            station_id="WUHN", title="补日志", priority="P3", risk="low",
            created_by="agent:ops", now=NOW)
        done = self.store.update_work_order(order["work_order_id"], status="done", now=NOW)
        self.assertEqual(done["status"], "done")

    def test_bad_priority_and_risk_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.store.create_work_order(
                station_id="WUHN", title="x", priority="P9", risk="low",
                created_by="user:1", now=NOW)
        with self.assertRaises(ValueError):
            self.store.create_work_order(
                station_id="WUHN", title="x", priority="P0", risk="extreme",
                created_by="user:1", now=NOW)

    def test_evidence_call_ids_roundtrip_as_json(self) -> None:
        order = self.store.create_work_order(
            station_id="WUHN", title="x", priority="P1", risk="low",
            created_by="agent:ops", evidence_call_ids=["c1", "c2"], now=NOW)
        self.assertEqual(order["evidence_call_ids"], ["c1", "c2"])


class TestThreadAndAgent(StoreTestBase):
    def test_thread_status_enum_enforced(self) -> None:
        with self.assertRaises(ValueError):
            self.store.create_thread(
                runtime="claude", external_thread_id="x", checkpointer_ns="ns",
                trace_path="t.jsonl", status="paused", now=NOW)

    def test_closing_thread_stamps_closed_at(self) -> None:
        thread = self.store.create_thread(
            runtime="opencode", external_thread_id="x", checkpointer_ns="ns",
            trace_path="t.jsonl", now=NOW)
        self.assertIsNone(thread["closed_at"])
        closed = self.store.update_thread(thread["thread_id"], status="closed", now=NOW)
        self.assertEqual(closed["status"], "closed")
        self.assertIsNotNone(closed["closed_at"])

    def test_thread_resume_cursor(self) -> None:
        thread = self.store.create_thread(
            runtime="claude", external_thread_id="x", checkpointer_ns="ns",
            trace_path="t.jsonl", now=NOW)
        updated = self.store.update_thread(
            thread["thread_id"], last_event_seq=42, message_count=7, now=NOW)
        self.assertEqual(updated["last_event_seq"], 42)
        self.assertEqual(updated["message_count"], 7)

    def test_agent_allowed_tools_roundtrip(self) -> None:
        agent = self.store.create_agent(
            name="worker-1", kind="worker", spec_path="agents/w.yaml",
            spec_sha256="a" * 64, runtime="opencode", model="deepseek-v4.1-flash",
            memory_namespace="fsa/w1", allowed_tools=["read_file"], now=NOW)
        self.assertEqual(agent["allowed_tools"], ["read_file"])
        self.assertEqual(agent["status"], "active")

    def test_agent_status_enum_enforced(self) -> None:
        with self.assertRaises(ValueError):
            self.store.create_agent(
                name="x", kind="worker", spec_path="p", spec_sha256="a" * 64,
                runtime="opencode", model="m", memory_namespace="n",
                status="zombie", now=NOW)


class TestMigrationFromV1(unittest.TestCase):
    """v1 老库（``task.id`` + ``parent_id``、``run_link`` 无 ``kind``）升级到 v3。"""

    def test_v1_database_upgrades_and_keeps_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "old.sqlite3"
            conn = sqlite3.connect(str(db))
            conn.executescript(
                """
                CREATE TABLE task (
                    id TEXT PRIMARY KEY, bot_id TEXT, parent_id TEXT,
                    step_id TEXT, kind TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'pending',
                    priority INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 5,
                    available_at TEXT NOT NULL, lease_owner TEXT,
                    lease_expires_at TEXT, result TEXT, last_error TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    FOREIGN KEY (parent_id) REFERENCES task(id) ON DELETE CASCADE
                );
                CREATE INDEX idx_task_parent ON task(parent_id);
                CREATE TABLE run_link (
                    id TEXT PRIMARY KEY, task_id TEXT, bot_id TEXT,
                    provider TEXT NOT NULL, external_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'linked',
                    detail TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX idx_run_link_external
                    ON run_link(provider, external_id);
                PRAGMA user_version = 1;
                """)
            stamp = "2026-11-01T00:00:00.000000+00:00"
            conn.execute(
                "INSERT INTO task (id, kind, available_at, created_at, updated_at)"
                " VALUES ('t-old', 'bot', ?, ?, ?)", (stamp, stamp, stamp))
            conn.execute(
                "INSERT INTO task (id, parent_id, kind, available_at,"
                " created_at, updated_at)"
                " VALUES ('t-child', 't-old', 'bot', ?, ?, ?)",
                (stamp, stamp, stamp))
            conn.executemany(
                "INSERT INTO run_link (id, task_id, provider, external_id,"
                " created_at, updated_at) VALUES (?, 't-old', ?, ?, ?, ?)",
                [("r-1", "langgraph", "th-1", stamp, stamp),
                 ("r-2", "letta", "ag-1", stamp, stamp),
                 ("r-3", "ledger", "wo-1", stamp, stamp),
                 ("r-4", "dbos", "dbos-1", stamp, stamp)])
            conn.commit()
            conn.close()

            store = BotStore(db, migrate=True)
            self.assertEqual(store.schema_version(), 3)

            # 行数没丢
            tasks = store.list_tasks()
            self.assertEqual(len(tasks), 2)
            by_id = {t["task_id"]: t for t in tasks}
            self.assertIn("t-old", by_id)
            self.assertIn("t-child", by_id)

            # 树关系与 root_task_id 回填正确
            self.assertEqual(by_id["t-child"]["parent_task_id"], "t-old")
            self.assertEqual(by_id["t-old"]["root_task_id"], "t-old")
            self.assertEqual(by_id["t-child"]["root_task_id"], "t-old")

            # kind 按 provider 回填（契约 §5）
            links = {row["external_id"]: row for row in store.list_run_links()}
            self.assertEqual(links["th-1"]["kind"], "thread")
            self.assertEqual(links["ag-1"]["kind"], "agent")
            self.assertEqual(links["wo-1"]["kind"], "work_order")
            self.assertEqual(links["dbos-1"]["kind"], "thread")
            # link_id 是改列名，值不变
            self.assertEqual(links["th-1"]["link_id"], "r-1")

    def test_v1_index_survives_rename(self) -> None:
        """§MIGRATE_V3 显式重建 idx_task_parent；这里确认它指向新列。"""
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "x.sqlite3"
            store = BotStore(db, migrate=True)
            with store.connect() as conn:
                sql = conn.execute(
                    "SELECT sql FROM sqlite_master WHERE name = 'idx_task_parent'"
                ).fetchone()[0]
            self.assertIn("parent_task_id", sql, "父索引必须指向改名后的列")

    def test_newer_schema_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "future.sqlite3"
            store = BotStore(db, migrate=True)
            with store.connect() as conn:
                conn.execute("PRAGMA user_version = 99")
            with self.assertRaises(RuntimeError):
                BotStore(db, migrate=True)

    def test_failed_step_rolls_back_ddl_and_version(self) -> None:
        """一个台阶失败时，DDL 与 ``user_version`` 一起回滚，不留半截库。

        这是第 3 节那条「不需要 ``if column exists``」结论的**可执行依据**：
        如果版本号能单独前进，重跑就会撞 ``duplicate column name``。
        """
        from fieldstation.botd import store as store_mod

        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "atomic.sqlite3"
            # 造一个真正的 v1 库（不是"改回去"的 v3），否则重跑会撞已改名的列
            conn = sqlite3.connect(str(db))
            conn.executescript(store_mod._SCHEMA_V1)
            conn.execute("PRAGMA user_version = 1")
            conn.commit()
            conn.close()
            store = BotStore(db, migrate=False)
            self.assertEqual(store.schema_version(), 1)

            broken_link = "ALTER TABLE run_link RENAME COLUMN no_such TO x;"
            saved = store_mod._MIGRATE_V2_LINK
            try:
                store_mod._MIGRATE_V2_LINK = broken_link
                with self.assertRaises(sqlite3.OperationalError):
                    store.migrate()
            finally:
                store_mod._MIGRATE_V2_LINK = saved

            # 版本必须还停在 1；v2 建的表也必须一起回滚
            self.assertEqual(store.schema_version(), 1)
            with store.connect() as check:
                names = {row[0] for row in check.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertNotIn("thread", names, "失败的台阶不该留下半截表")
            self.assertNotIn("work_order", names)
            with store.connect() as check:
                link_cols = [row[1] for row in check.execute(
                    "PRAGMA table_info(run_link)")]
            self.assertIn("id", link_cols, "回滚后 run_link 仍是 v1 的列名")

            # 修好之后能正常迁上去
            self.assertEqual(store.migrate(), SCHEMA_VERSION)
            self.assertEqual(store.schema_version(), SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
