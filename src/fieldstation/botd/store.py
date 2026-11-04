"""E2 botd 持久层：SQLite schema v1 与迁移。

为什么先落到 SQLite 而不是直接依赖 DBOS / Letta：

* 桌面版必须能在没有网络、没有外部服务、甚至没装那些包的机器上起来；
  队列、记忆、人工介入这些**状态**一旦只能存在外部服务里，离线就什么都跑不了。
* 六张表是编队的最小状态面：``bot`` / ``task`` / ``step`` / ``memory`` /
  ``intervention`` / ``run_link``。DBOS 的 run id、Letta 的 agent id 只作为
  ``run_link`` 里的外部引用，换实现时不动本地表。
* 所有时间字段是 UTC ISO8601 **定长**字符串（``...+00:00``，微秒 6 位），
  因此可以直接按字符串比较先后；这也让"注入时钟"的测试不用等真实时间。

并发约定：一个 :class:`BotStore` 可以被多个线程共用，但**每个操作各自开连接**
（SQLite 连接不是线程安全的）。写操作走 ``BEGIN IMMEDIATE``，用
``busy_timeout`` 排队，而不是在 Python 层加锁 —— 锁在进程内，挡不住第二个进程。
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

SCHEMA_VERSION = 1

#: 定长便于字符串比较；不用 ``isoformat()`` 是因为 3.9 的 fromisoformat 不认 Z。
ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%f+00:00"

TASK_STATUSES = ("pending", "running", "done", "failed", "dead", "cancelled")
STEP_STATUSES = ("pending", "running", "done", "failed", "skipped")


def utcnow() -> datetime:
    """当前 UTC 时间；测试通过显式传 ``now`` 覆盖，不 monkeypatch 本函数。"""
    return datetime.now(timezone.utc)


def to_iso(moment: Optional[datetime] = None) -> str:
    """把时间点格式化成数据库里的 ISO8601 字符串（始终 UTC）。"""
    value = moment if moment is not None else utcnow()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime(ISO_FORMAT)


def from_iso(text: str) -> datetime:
    """解析 :func:`to_iso` 写出的字符串，也接受尾缀 ``Z``。"""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("时间字段必须是非空 ISO8601 字符串")
    raw = text.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"不是合法的 ISO8601 时间：{text!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def add_seconds(moment: datetime, seconds: float) -> datetime:
    return moment + timedelta(seconds=float(seconds))


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:24]}"


def dumps(value: Any) -> str:
    """稳定 JSON：键排序，中文不转义，便于人工查库与对拍。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def loads(text: Optional[str], default: Any = None) -> Any:
    if text is None or text == "":
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        # 库里被人手改坏时不炸整个进程：原样留在字段里，由上层决定怎么报。
        return default


_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS bot (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active',
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
    id               TEXT PRIMARY KEY,
    bot_id           TEXT,
    parent_id        TEXT,
    step_id          TEXT,
    kind             TEXT NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    payload          TEXT NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL DEFAULT 'pending',
    priority         INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 5,
    available_at     TEXT NOT NULL,
    lease_owner      TEXT,
    lease_expires_at TEXT,
    result           TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES task(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_ready
    ON task(status, available_at, priority);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_step
    ON task(step_id) WHERE step_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS step (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    tools       TEXT NOT NULL DEFAULT '[]',
    acceptance  TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    task_ref    TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    output      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_step_task ON step(task_id, idx);

CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      TEXT NOT NULL,
    key         TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL DEFAULT 'manual',
    backend     TEXT NOT NULL DEFAULT 'local',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_bot ON memory(bot_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_key
    ON memory(bot_id, key) WHERE key <> '';

CREATE TABLE IF NOT EXISTS intervention (
    id          TEXT PRIMARY KEY,
    task_id     TEXT,
    bot_id      TEXT,
    kind        TEXT NOT NULL,
    prompt      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    response    TEXT,
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intervention_task ON intervention(task_id, status);

CREATE TABLE IF NOT EXISTS run_link (
    id          TEXT PRIMARY KEY,
    task_id     TEXT,
    bot_id      TEXT,
    provider    TEXT NOT NULL,
    external_id TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'linked',
    detail      TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_link_external
    ON run_link(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_run_link_task ON run_link(task_id);
"""


class BotStore:
    """SQLite 连接工厂 + 六张表的读写原语。

    连接**不缓存**：每次操作新开一个，``check_same_thread`` 因此永远为真，
    多线程测试不需要在线程间传连接。
    """

    def __init__(
        self,
        path: str | Path,
        *,
        timeout: float = 30.0,
        migrate: bool = True,
    ) -> None:
        self.path = Path(path)
        if str(self.path) == ":memory:":
            raise ValueError(
                "BotStore 不支持 :memory:：每个操作各自开连接，内存库会在连接之间丢失"
                "schema；请传入文件路径"
            )
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.timeout = float(timeout)
        if migrate:
            self.migrate()

    # ---------------------------------------------------------------- 连接 --
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.path), timeout=self.timeout, isolation_level=None
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = %d" % int(self.timeout * 1000))
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """``BEGIN IMMEDIATE`` 事务；并发领取串行化的唯一入口。"""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    # ---------------------------------------------------------------- 迁移 --
    def migrate(self) -> int:
        """迁移到 ``SCHEMA_VERSION``，返回迁移后的版本号；可重复调用。"""
        with self.connect() as conn:
            if str(self.path) != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"数据库 schema v{version} 比本程序支持的 v{SCHEMA_VERSION} 新，"
                    "拒绝降级写入"
                )
            if version < 1:
                conn.executescript(_SCHEMA_V1)
                conn.execute("PRAGMA user_version = 1")
                version = 1
        return version

    def schema_version(self) -> int:
        with self.connect() as conn:
            return int(conn.execute("PRAGMA user_version").fetchone()[0])

    # ------------------------------------------------------------ task 写入 --
    def create_task(
        self,
        *,
        kind: str,
        bot_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        step_id: Optional[str] = None,
        title: str = "",
        payload: Optional[Mapping[str, Any]] = None,
        status: str = "pending",
        priority: int = 0,
        max_attempts: int = 5,
        available_at: Optional[datetime] = None,
        now: Optional[datetime] = None,
        task_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("task.kind 必须是非空字符串")
        if status not in TASK_STATUSES:
            raise ValueError(f"未知 task 状态：{status!r}")
        if int(max_attempts) < 1:
            raise ValueError("max_attempts 至少为 1")
        moment = now or utcnow()
        stamp = to_iso(moment)
        task_id = task_id or new_id("t")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO task (
                    id, bot_id, parent_id, step_id, kind, title, payload, status,
                    priority, attempts, max_attempts, available_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    bot_id,
                    parent_id,
                    step_id,
                    kind.strip(),
                    title or "",
                    dumps(dict(payload or {})),
                    status,
                    int(priority),
                    int(max_attempts),
                    to_iso(available_at or moment),
                    stamp,
                    stamp,
                ),
            )
        return self.get_task(task_id)

    def get_task(self, task_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM task WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(f"任务不存在：{task_id!r}")
        return _task_dict(row)

    def task_exists(self, task_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute("SELECT 1 FROM task WHERE id = ?", (task_id,)).fetchone()
        return row is not None

    def list_tasks(
        self,
        *,
        parent_id: Optional[str] = None,
        status: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if parent_id is not None:
            clauses.append("parent_id = ?")
            params.append(parent_id)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM task{where} ORDER BY created_at, rowid", params
            ).fetchall()
        return [_task_dict(row) for row in rows]

    # ------------------------------------------------------------ step 读写 --
    def create_step(
        self,
        *,
        task_id: str,
        idx: int,
        name: str,
        kind: str = "",
        tools: Optional[list[str]] = None,
        acceptance: str = "",
        task_ref: Optional[str] = None,
        now: Optional[datetime] = None,
        step_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("step.name 必须是非空字符串")
        stamp = to_iso(now or utcnow())
        step_id = step_id or new_id("s")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO step (
                    id, task_id, idx, name, kind, tools, acceptance, status,
                    task_ref, attempts, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
                """,
                (
                    step_id,
                    task_id,
                    int(idx),
                    name.strip(),
                    kind or "",
                    dumps(list(tools or [])),
                    acceptance or "",
                    task_ref,
                    stamp,
                    stamp,
                ),
            )
        return self.get_step(step_id)

    def get_step(self, step_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM step WHERE id = ?", (step_id,)).fetchone()
        if row is None:
            raise KeyError(f"步骤不存在：{step_id!r}")
        return _step_dict(row)

    def list_steps(self, task_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM step WHERE task_id = ? ORDER BY idx, rowid", (task_id,)
            ).fetchall()
        return [_step_dict(row) for row in rows]

    def update_step(
        self,
        step_id: str,
        *,
        status: Optional[str] = None,
        output: Any = None,
        error: Optional[str] = None,
        attempts: Optional[int] = None,
        task_ref: Optional[str] = None,
        now: Optional[datetime] = None,
        touch: bool = True,
    ) -> dict:
        sets: list[str] = []
        params: list[Any] = []
        if status is not None:
            if status not in STEP_STATUSES:
                raise ValueError(f"未知 step 状态：{status!r}")
            sets.append("status = ?")
            params.append(status)
        if output is not None:
            sets.append("output = ?")
            params.append(dumps(output))
        if error is not None:
            sets.append("error = ?")
            params.append(str(error))
        if attempts is not None:
            sets.append("attempts = ?")
            params.append(int(attempts))
        if task_ref is not None:
            sets.append("task_ref = ?")
            params.append(task_ref)
        if touch:
            sets.append("updated_at = ?")
            params.append(to_iso(now or utcnow()))
        if not sets:
            return self.get_step(step_id)
        params.append(step_id)
        with self.transaction() as conn:
            cur = conn.execute(
                f"UPDATE step SET {', '.join(sets)} WHERE id = ?", params
            )
            if cur.rowcount == 0:
                raise KeyError(f"步骤不存在：{step_id!r}")
        return self.get_step(step_id)

    # ------------------------------------------------------------ bot 读写 --
    def upsert_bot(
        self,
        bot_id: str,
        *,
        name: str = "",
        role: str = "",
        status: str = "active",
        meta: Optional[Mapping[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("bot.id 必须是非空字符串")
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO bot (id, name, role, status, meta, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    role = excluded.role,
                    status = excluded.status,
                    meta = excluded.meta,
                    updated_at = excluded.updated_at
                """,
                (
                    bot_id,
                    name or bot_id,
                    role or "",
                    status,
                    dumps(dict(meta or {})),
                    stamp,
                    stamp,
                ),
            )
        return self.get_bot(bot_id)

    def get_bot(self, bot_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM bot WHERE id = ?", (bot_id,)).fetchone()
        if row is None:
            raise KeyError(f"bot 不存在：{bot_id!r}")
        return _row_dict(row)

    def list_bots(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM bot ORDER BY id").fetchall()
        return [_row_dict(row) for row in rows]

    # -------------------------------------------------------- memory 读写 --
    def add_memory(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Optional[list[str]] = None,
        source: str = "manual",
        backend: str = "local",
        now: Optional[datetime] = None,
    ) -> dict:
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("memory.bot_id 必须是非空字符串")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("memory.content 必须是非空字符串")
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            if key:
                existing = conn.execute(
                    "SELECT id FROM memory WHERE bot_id = ? AND key = ?",
                    (bot_id, key),
                ).fetchone()
            else:
                existing = None
            if existing is not None:
                conn.execute(
                    """
                    UPDATE memory SET content = ?, tags = ?, source = ?, backend = ?,
                                      updated_at = ?
                    WHERE id = ?
                    """,
                    (content, dumps(list(tags or [])), source, backend, stamp,
                     existing["id"]),
                )
                memory_id = int(existing["id"])
            else:
                cur = conn.execute(
                    """
                    INSERT INTO memory (bot_id, key, content, tags, source, backend,
                                        created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (bot_id, key, content, dumps(list(tags or [])), source,
                     backend, stamp, stamp),
                )
                memory_id = int(cur.lastrowid)
        return self.get_memory(memory_id)

    def get_memory(self, memory_id: int) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM memory WHERE id = ?", (int(memory_id),)
            ).fetchone()
        if row is None:
            raise KeyError(f"记忆不存在：{memory_id!r}")
        return _memory_dict(row)

    def list_memory(self, bot_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memory WHERE bot_id = ? ORDER BY updated_at, id",
                (bot_id,),
            ).fetchall()
        return [_memory_dict(row) for row in rows]

    def delete_memory(self, memory_id: int) -> bool:
        with self.transaction() as conn:
            cur = conn.execute("DELETE FROM memory WHERE id = ?", (int(memory_id),))
        return cur.rowcount > 0

    # ---------------------------------------------------- intervention 读写 --
    def add_intervention(
        self,
        *,
        kind: str,
        task_id: Optional[str] = None,
        bot_id: Optional[str] = None,
        prompt: str = "",
        now: Optional[datetime] = None,
        intervention_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("intervention.kind 必须是非空字符串")
        intervention_id = intervention_id or new_id("i")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO intervention (id, task_id, bot_id, kind, prompt, status,
                                          created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?)
                """,
                (intervention_id, task_id, bot_id, kind.strip(), prompt,
                 to_iso(now or utcnow())),
            )
        return self.get_intervention(intervention_id)

    def get_intervention(self, intervention_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM intervention WHERE id = ?", (intervention_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"介入记录不存在：{intervention_id!r}")
        return _row_dict(row)

    def resolve_intervention(
        self,
        intervention_id: str,
        response: str,
        *,
        status: str = "resolved",
        now: Optional[datetime] = None,
    ) -> dict:
        if status not in ("resolved", "rejected", "expired"):
            raise ValueError(f"未知介入状态：{status!r}")
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE intervention SET status = ?, response = ?, resolved_at = ?
                WHERE id = ?
                """,
                (status, response, stamp, intervention_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"介入记录不存在：{intervention_id!r}")
        return self.get_intervention(intervention_id)

    def list_interventions(self, *, status: Optional[str] = None) -> list[dict]:
        if status is None:
            sql, params = "SELECT * FROM intervention ORDER BY created_at", []
        else:
            sql, params = (
                "SELECT * FROM intervention WHERE status = ? ORDER BY created_at",
                [status],
            )
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_dict(row) for row in rows]

    # --------------------------------------------------------- run_link 读写 --
    def add_run_link(
        self,
        *,
        provider: str,
        external_id: str,
        task_id: Optional[str] = None,
        bot_id: Optional[str] = None,
        status: str = "linked",
        detail: Optional[Mapping[str, Any]] = None,
        now: Optional[datetime] = None,
        link_id: Optional[str] = None,
    ) -> dict:
        if not provider.strip() or not external_id.strip():
            raise ValueError("run_link.provider / external_id 不能为空")
        stamp = to_iso(now or utcnow())
        link_id = link_id or new_id("r")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO run_link (id, task_id, bot_id, provider, external_id,
                                      status, detail, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, external_id) DO UPDATE SET
                    task_id = excluded.task_id,
                    bot_id = excluded.bot_id,
                    status = excluded.status,
                    detail = excluded.detail,
                    updated_at = excluded.updated_at
                """,
                (link_id, task_id, bot_id, provider.strip(), external_id.strip(),
                 status, dumps(dict(detail or {})), stamp, stamp),
            )
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM run_link WHERE provider = ? AND external_id = ?",
                (provider.strip(), external_id.strip()),
            ).fetchone()
        return _row_dict(row)

    def list_run_links(
        self, *, task_id: Optional[str] = None, provider: Optional[str] = None
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if task_id is not None:
            clauses.append("task_id = ?")
            params.append(task_id)
        if provider is not None:
            clauses.append("provider = ?")
            params.append(provider)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM run_link{where} ORDER BY created_at, rowid", params
            ).fetchall()
        return [_row_dict(row) for row in rows]


# --------------------------------------------------------------- row 解码 --
def _row_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


def _task_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["payload"] = loads(data.get("payload"), {})
    data["result"] = loads(data.get("result"), None)
    return data


def _step_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["tools"] = loads(data.get("tools"), [])
    data["output"] = loads(data.get("output"), None)
    return data


def _memory_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["tags"] = loads(data.get("tags"), [])
    return data
