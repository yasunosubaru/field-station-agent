"""store —— job 目录、状态机持久化、锁、幂等索引、只追加审计。

一个 job 一个目录::

    workflows/jobs/<job_id>/
        job.json        # 当前状态（原子替换，永远是一份完整快照）
        audit.jsonl     # 只追加：谁在什么时候做了什么
        artifacts/      # 证据（PDF、截图、VERSION 记录、失败现场）
        .lock           # 运行中的排他锁（进程崩溃后按时间判 stale）

为什么不用数据库：job 数量是个位数到几十，文件目录能直接看、直接备份、直接
diff；数据库会让「这条流程当时到底跑了什么」变成一次查询而不是一次 ``cat``。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .spec import Workflow

__all__ = ["Job", "JobStore", "FileLock", "STATUSES", "TERMINAL_STATUSES"]

STATUSES = (
    "pending",
    "running",
    "waiting_approval",
    "waiting_operator",
    "succeeded",
    "failed",
    "cancelled",
)
TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
WAITING_STATUSES = frozenset({"waiting_approval", "waiting_operator"})

_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{2,120}$")


def _utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


class Job:
    """一次流程运行的可序列化状态。字段刻意铺平，方便直接进 JSON 与审计。"""

    __slots__ = (
        "job_id", "workflow", "workflow_version", "title", "status", "params",
        "created_at", "updated_at", "started_at", "finished_at",
        "step_index", "current_step", "steps_total", "context",
        "pending_gate", "gates", "artifacts", "failure", "warnings",
        "cancel_reason", "idempotency_key", "rerun_of", "attempts",
        "engine", "driver", "reused",
    )

    def __init__(
        self,
        job_id: str,
        workflow: str,
        workflow_version: int = 1,
        title: str = "",
        status: str = "pending",
        params: dict | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
        started_at: str | None = None,
        finished_at: str | None = None,
        step_index: int = 0,
        current_step: str | None = None,
        steps_total: int = 0,
        context: dict | None = None,
        pending_gate: dict | None = None,
        gates: list | None = None,
        artifacts: list | None = None,
        failure: dict | None = None,
        warnings: list | None = None,
        cancel_reason: str | None = None,
        idempotency_key: str | None = None,
        rerun_of: str | None = None,
        attempts: int = 1,
        engine: str = "",
        driver: str = "",
        reused: bool = False,
    ) -> None:
        self.job_id = job_id
        self.workflow = workflow
        self.workflow_version = workflow_version
        self.title = title
        self.status = status
        self.params = params or {}
        self.created_at = created_at or _utcnow()
        self.updated_at = updated_at or self.created_at
        self.started_at = started_at
        self.finished_at = finished_at
        self.step_index = step_index
        self.current_step = current_step
        self.steps_total = steps_total
        self.context = context or {}
        self.pending_gate = pending_gate
        self.gates = gates or []
        self.artifacts = artifacts or []
        self.failure = failure
        self.warnings = warnings or []
        self.cancel_reason = cancel_reason
        self.idempotency_key = idempotency_key
        self.rerun_of = rerun_of
        self.attempts = attempts
        self.engine = engine
        self.driver = driver
        self.reused = reused

    # ------------------------------------------------------------------ 序列化
    def to_dict(self) -> dict:
        return {name: getattr(self, name) for name in self.__slots__ if name != "reused"}

    @classmethod
    def from_dict(cls, data: dict) -> "Job":
        known = {name for name in cls.__slots__ if name != "reused"}
        return cls(**{k: v for k, v in data.items() if k in known})  # type: ignore[arg-type]

    # ------------------------------------------------------------------ 便捷
    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def is_waiting(self) -> bool:
        return self.status in WAITING_STATUSES

    def touch(self) -> None:
        self.updated_at = _utcnow()

    def view(self) -> dict:
        """给 agent / CLI 的摘要视图。不返回整个 context（可能含大块报文）。"""
        return {
            "job_id": self.job_id,
            "workflow": self.workflow,
            "workflow_version": self.workflow_version,
            "title": self.title,
            "status": self.status,
            "params": self.params,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "current_step": self.current_step,
            "step_index": self.step_index,
            "steps_total": self.steps_total,
            "gate": self.pending_gate,
            "failure": self.failure,
            "warnings": self.warnings,
            "cancel_reason": self.cancel_reason,
            "artifacts": self.artifacts,
            "idempotency_key": self.idempotency_key,
            "rerun_of": self.rerun_of,
            "attempts": self.attempts,
            "engine": self.engine,
            "driver": self.driver,
            "context_keys": sorted(self.context),
        }


class FileLock:
    """``O_CREAT|O_EXCL`` 排他锁；按 mtime 判 stale，不猜进程是否活着。

    不用 ``os.kill(pid, 0)``：Windows 上 ``os.kill`` 不是「探活」，``sig=0`` 会把
    目标进程当退出码 0 结束掉。宁可按时间判过期，也不冒这个险。
    """

    def __init__(self, path: Path, stale_after_s: float = 900.0) -> None:
        self.path = Path(path)
        self.stale_after_s = stale_after_s

    def owner(self) -> dict | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def is_stale(self) -> bool:
        try:
            age = datetime.now(timezone.utc).timestamp() - self.path.stat().st_mtime
        except OSError:
            return True
        return age > self.stale_after_s

    def acquire(self, force: bool = False) -> dict | None:
        """拿到锁时返回 owner 字典；被占用且不 stale 时返回 ``None``。"""
        payload = {
            "pid": os.getpid(),
            "at": _utcnow(),
            "host": os.environ.get("COMPUTERNAME", ""),
        }
        attempt = 0
        while attempt < 2:
            attempt += 1
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if force or self.is_stale():
                    try:
                        self.path.unlink()
                    except OSError:
                        return None
                    continue
                return None
            except OSError:
                return None
            try:
                os.write(fd, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            finally:
                os.close(fd)
            return payload
        return None

    def release(self) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass


class JobStore:
    """``workflows/jobs`` 的读写门面。"""

    def __init__(self, root: str | Path, lock_stale_s: float = 900.0) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock_stale_s = lock_stale_s
        self._locks_dir = self.root / ".locks"
        self._locks_dir.mkdir(exist_ok=True)
        self._index_path = self.root / "index.json"

    # ------------------------------------------------------------------ 路径
    def job_dir(self, job_id: str) -> Path:
        if not _JOB_ID_RE.match(job_id):
            raise ValueError(f"job_id 不合法：{job_id!r}")
        return self.root / job_id

    def artifacts_dir(self, job_id: str) -> Path:
        d = self.job_dir(job_id) / "artifacts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def lock(self, job_id: str) -> FileLock:
        self.job_dir(job_id)
        return FileLock(self.job_dir(job_id) / ".lock", self.lock_stale_s)

    def workflow_lock(self, workflow_id: str) -> FileLock:
        safe = re.sub(r"[^a-z0-9.-]", "_", workflow_id.lower())
        return FileLock(self._locks_dir / f"{safe}.lock", max(self.lock_stale_s, 3600.0))

    # ------------------------------------------------------------------ 建/读/存
    def create(
        self,
        workflow: Workflow,
        params: dict,
        *,
        idempotency_key: str | None = None,
        rerun_of: str | None = None,
        engine: str = "",
        driver: str = "",
        force: bool = False,
    ) -> tuple[Job, bool]:
        """建一个新 job；同一个幂等键命中运行中/成功/等待中的 job 时直接复用。"""
        if idempotency_key:
            existing = self.find_idempotent(idempotency_key)
            if existing is not None:
                existing.reused = True
                return existing, True
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        job_id = f"{workflow.id}-{stamp}-{secrets.token_hex(3)}"
        directory = self.job_dir(job_id)
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "artifacts").mkdir()
        job = Job(
            job_id=job_id,
            workflow=workflow.id,
            workflow_version=workflow.version,
            title=workflow.title,
            params=params,
            steps_total=workflow.step_count,
            idempotency_key=idempotency_key,
            rerun_of=rerun_of,
            engine=engine,
            driver=driver,
        )
        self.save(job)
        self.audit(job, "job.created", workflow=workflow.id, params=params,
                   idempotency_key=idempotency_key, engine=engine, driver=driver)
        if idempotency_key:
            index = self._read_index()
            index[idempotency_key] = {
                "job_id": job_id,
                "workflow": workflow.id,
                "params_hash": _hash_params(params),
                "status": job.status,
                "created_at": job.created_at,
            }
            self._write_index(index)
        _ = force
        return job, False

    def find_idempotent(self, key: str) -> Job | None:
        entry = self._read_index().get(key)
        if not isinstance(entry, dict):
            return None
        try:
            job = self.load(str(entry.get("job_id", "")))
        except (OSError, ValueError):
            return None
        if job.status in TERMINAL_STATUSES and job.status != "succeeded":
            return None
        return job

    def load(self, job_id: str) -> Job:
        path = self.job_dir(job_id) / "job.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"{path} 不是对象")
        return Job.from_dict(data)

    def save(self, job: Job) -> None:
        job.touch()
        self._write_json(self.job_dir(job.job_id) / "job.json", job.to_dict())
        if job.idempotency_key:
            index = self._read_index()
            entry = index.get(job.idempotency_key)
            if isinstance(entry, dict) and entry.get("job_id") == job.job_id:
                entry["status"] = job.status
                self._write_index(index)

    def list(self, limit: int = 50, status: str | None = None) -> list[Job]:
        jobs: list[Job] = []
        for path in self.root.iterdir():
            if not path.is_dir() or path.name.startswith("."):
                continue
            try:
                job = self.load(path.name)
            except (OSError, ValueError, TypeError):
                continue
            if status and job.status != status:
                continue
            jobs.append(job)
        jobs.sort(key=lambda j: (j.created_at, j.job_id), reverse=True)
        if limit > 0:
            jobs = jobs[:limit]
        return jobs

    # ------------------------------------------------------------------ 审计
    def audit(self, job: Job, event: str, **fields: object) -> dict:
        record = {"ts": _utcnow(), "job": job.job_id, "event": event}
        for key, value in fields.items():
            record[key] = value
        path = self.job_dir(job.job_id) / "audit.jsonl"
        with path.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True, default=str) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return record

    def audit_tail(self, job_id: str, limit: int = 20) -> list[dict]:
        path = self.job_dir(job_id) / "audit.jsonl"
        if not path.is_file():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()
        out: list[dict] = []
        for line in lines[-limit:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    # ------------------------------------------------------------------ 产物
    def write_artifact(
        self,
        job: Job,
        name: str,
        data: bytes | str | dict,
        *,
        kind: str = "file",
        source_step: str | None = None,
        note: str = "",
    ) -> dict:
        if any(sep in name for sep in ("/", "\\")) or name in ("", ".", ".."):
            raise ValueError(f"产物名必须是裸文件名：{name!r}")
        if isinstance(data, dict):
            blob = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        elif isinstance(data, str):
            blob = data.encode("utf-8")
        else:
            blob = bytes(data)
        path = self.artifacts_dir(job.job_id) / name
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(blob)
        os.replace(tmp, path)
        record = {
            "name": name,
            "kind": kind,
            "bytes": len(blob),
            "sha256": _sha256(blob),
            "path": str(path),
            "created_at": _utcnow(),
            "step": source_step,
            "note": note,
        }
        job.artifacts = [a for a in job.artifacts if a.get("name") != name] + [record]
        self.save(job)
        return record

    def read_artifact(self, job_id: str, name: str) -> bytes:
        if any(sep in name for sep in ("/", "\\")) or name in ("", ".", ".."):
            raise ValueError(f"产物名必须是裸文件名：{name!r}")
        return (self.artifacts_dir(job_id) / name).read_bytes()

    def delete_job(self, job_id: str) -> None:
        shutil.rmtree(self.job_dir(job_id))

    # ------------------------------------------------------------------ 内部
    def _read_index(self) -> dict:
        try:
            data = json.loads(self._index_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_index(self, index: dict) -> None:
        self._write_json(self._index_path, index)

    @staticmethod
    def _write_json(path: Path, data: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, path)


def _hash_params(params: dict) -> str:
    return hashlib.sha256(_canonical_json(params).encode("utf-8")).hexdigest()[:16]


def _canonical(value: object) -> str:
    return _canonical_json(value)
