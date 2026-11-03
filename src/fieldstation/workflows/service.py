"""service —— agent 面向的工作流门面。

这一层只做四件事：**目录、参数、状态、证据**。执行语义全在 :mod:`runner`。

对外方法（与计划里点名的 agent 接口一一对应）::

    capabilities()
    list_workflows(intent=None)
    describe_workflow(workflow_id)
    run_workflow(workflow_id, params=None, idempotency_key=None)
    job_status(job_id)
    resume(job_id, decision, by=..., note=...)
    cancel(job_id, reason=..., by=...)
    human_gate(job_id, decision, by=..., note=...)      # resume 的语义别名
    artifacts(job_id)
    read_artifact(job_id, name)

约定
----
* ``run_workflow`` 是**同步**的：跑到完成或停在闸门才返回。停在闸门时
  ``status`` 是 ``waiting_approval`` / ``waiting_operator``，``gate`` 里带着
  要人做的事，``next_actions`` 给出下一步命令。
* 同一条流程同时只允许一个**未结束**的实例（pending/running/waiting）。
  这是策略检查，不是锁：锁只保护单次写入，策略防止「两条 RESET 同时发出去」。
* 幂等键命中一个成功/运行中/等待中的 job 时直接返回它（``reused`` 不在视图里，
  但 ``job_id`` 与 ``created_at`` 会相同）。
"""
from __future__ import annotations

from pathlib import Path

from . import gui as gui_mod
from . import spec as spec_mod
from .engine import DEFAULT_BASE_URL, EngineClient, EngineError
from .runner import JobBusy, WorkflowRunner
from .store import TERMINAL_STATUSES, Job, JobStore

__all__ = ["WorkflowService", "WORKFLOW_API_VERSION"]

WORKFLOW_API_VERSION = "1.0"
_ROOT = Path(__file__).resolve().parents[3]

_METHODS = [
    "capabilities",
    "list_workflows",
    "describe_workflow",
    "run_workflow",
    "job_status",
    "resume",
    "cancel",
    "human_gate",
    "artifacts",
    "read_artifact",
]


class WorkflowService:
    def __init__(
        self,
        root: str | Path | None = None,
        *,
        workflows_dir: str | Path | None = None,
        jobs_root: str | Path | None = None,
        engine_url: str | None = None,
        driver: str = "assisted",
        driver_instance: gui_mod.GuiDriver | None = None,
        timeout: float = 10.0,
        store: JobStore | None = None,
        runner: WorkflowRunner | None = None,
    ) -> None:
        self.root = Path(root) if root else _ROOT
        self.workflows_dir = Path(workflows_dir) if workflows_dir else self.root / "workflows"
        self.jobs_root = Path(jobs_root) if jobs_root else self.workflows_dir / "jobs"
        self.store = store or JobStore(self.jobs_root)
        self.engine = EngineClient(engine_url, timeout=timeout)
        if driver_instance is not None:
            self.driver = driver_instance
        else:
            try:
                self.driver = gui_mod.load_driver(driver)
            except gui_mod.GuiUnavailable:
                self.driver = gui_mod.AssistedDriver()
        self.runner = runner or WorkflowRunner(self.store, self.engine, self.driver)
        self._catalog: dict[str, spec_mod.Workflow] | None = None

    # ================================================================== 目录
    @property
    def catalog(self) -> dict[str, spec_mod.Workflow]:
        if self._catalog is None:
            workflows = spec_mod.load_all(self.workflows_dir)
            self._catalog = {w.id: w for w in workflows}
        return self._catalog

    def reload(self) -> None:
        self._catalog = None

    def capabilities(self) -> dict:
        engine: dict = {"base_url": self.engine.base_url, "reachable": False}
        try:
            health = EngineClient(self.engine.base_url, timeout=2.0).health()
            engine.update({
                "reachable": True,
                "service": health.get("service"),
                "version": health.get("version"),
                "node": health.get("node"),
            })
        except EngineError as exc:
            engine["error"] = str(exc)
        counts: dict[str, int] = {}
        for wf in self.catalog.values():
            counts[wf.risk] = counts.get(wf.risk, 0) + 1
        return {
            "ok": True,
            "api_version": WORKFLOW_API_VERSION,
            "root": str(self.root),
            "workflows_dir": str(self.workflows_dir),
            "jobs_root": str(self.jobs_root),
            "workflow_count": len(self.catalog),
            "intents": sorted({wf.intent for wf in self.catalog.values()}),
            "risk_counts": counts,
            "failure_classes": list(spec_mod.FAILURE_CLASSES),
            "engine": engine,
            "gui": gui_mod.describe_driver(self.driver),
            "methods": list(_METHODS),
        }

    def list_workflows(self, intent: str | None = None) -> list[dict]:
        rows = []
        for wf in self.catalog.values():
            if intent and not _intent_matches(wf, intent):
                continue
            rows.append(wf.summary_dict())
        rows.sort(key=lambda row: (row["intent"], row["id"]))
        return rows

    def describe_workflow(self, workflow_id: str) -> dict:
        wf = self._get(workflow_id)
        data = wf.full_dict()
        data["required_params"] = [
            name for name, spec in wf.params.items() if spec.get("required")]
        data["gate_steps"] = [
            s["id"] for s in wf.steps if s["kind"] == "human_gate"]
        data["gui_steps"] = [
            s["id"] for s in wf.steps if s["kind"] in ("gui", "verify_ui")]
        return data

    # ================================================================== 运行
    def run_workflow(
        self,
        workflow_id: str,
        params: dict | None = None,
        *,
        idempotency_key: str | None = None,
        force_lock: bool = False,
        allow_concurrent: bool = False,
    ) -> dict:
        wf = self._get(workflow_id)
        resolved = spec_mod.validate_params(wf, params)
        if idempotency_key:
            found = self.store.find_idempotent(idempotency_key)
            if found is not None:
                return self._view(found)
        if not allow_concurrent:
            active = self._active(wf.id)
            if active is not None:
                raise JobBusy(
                    f"工作流 {wf.id} 已有一个未结束的 job：{active.job_id}"
                    f"（{active.status}）；先 resume/cancel 它，或用 --allow-concurrent",
                    active.job_id)
        job, _ = self.store.create(
            wf, resolved,
            idempotency_key=idempotency_key,
            engine=self.engine.base_url,
            driver=str(getattr(self.driver, "name", "?")),
        )
        job = self.runner.run(job, wf, force_lock=force_lock)
        return self._view(job)

    def job_status(self, job_id: str) -> dict:
        return self._view(self.store.load(job_id))

    def resume(
        self,
        job_id: str,
        decision: str,
        *,
        by: str = "operator",
        note: str = "",
        force_lock: bool = False,
    ) -> dict:
        job = self.store.load(job_id)
        wf = self._get(job.workflow)
        job = self.runner.resume(job, wf, decision, by=by, note=note, force_lock=force_lock)
        return self._view(job)

    def human_gate(
        self,
        job_id: str,
        decision: str,
        *,
        by: str = "operator",
        note: str = "",
    ) -> dict:
        """``resume`` 的语义别名：审批门与人工任务共用同一条恢复路径。"""
        return self.resume(job_id, decision, by=by, note=note)

    def cancel(self, job_id: str, reason: str = "cancelled", *, by: str = "operator") -> dict:
        job = self.store.load(job_id)
        return self._view(self.runner.cancel(job, reason, by=by))

    # ================================================================== 证据
    def artifacts(self, job_id: str) -> list[dict]:
        job = self.store.load(job_id)
        rows = []
        for record in job.artifacts:
            path = Path(str(record.get("path", "")))
            rows.append({
                **record,
                "exists": path.is_file(),
                "readable": path.is_file() and bool(path.stat().st_size >= 0),
            })
        rows.sort(key=lambda r: str(r.get("created_at", "")))
        return rows

    def read_artifact(self, job_id: str, name: str) -> bytes:
        return self.store.read_artifact(job_id, name)

    def audit(self, job_id: str, limit: int = 20) -> list[dict]:
        return self.store.audit_tail(job_id, limit)

    def list_jobs(self, limit: int = 20, status: str | None = None) -> list[dict]:
        return [self._view(job, with_audit=False)
                for job in self.store.list(limit=limit, status=status)]

    # ================================================================== 校验
    def validate(self, path: str | Path | None = None) -> list[dict]:
        targets: list[Path]
        if path is not None:
            p = Path(path)
            targets = [p] if p.is_file() else sorted(p.glob("*.yaml"))
        else:
            targets = sorted(self.workflows_dir.glob("*.yaml"))
        rows = []
        for target in targets:
            try:
                wf = spec_mod.load_spec(target)
                rows.append({"path": str(target), "ok": True, "id": wf.id,
                             "steps": wf.step_count})
            except spec_mod.WorkflowSpecError as exc:
                rows.append({"path": str(target), "ok": False, "errors": exc.errors})
        return rows

    # ================================================================== 内部
    def _get(self, workflow_id: str) -> spec_mod.Workflow:
        wf = self.catalog.get(workflow_id)
        if wf is None:
            known = ", ".join(sorted(self.catalog)) or "（空）"
            raise KeyError(f"没有工作流 {workflow_id!r}；现有：{known}")
        return wf

    def _active(self, workflow_id: str) -> Job | None:
        for job in self.store.list(limit=0):
            if job.workflow != workflow_id:
                continue
            if job.status not in TERMINAL_STATUSES:
                return job
        return None

    def _view(self, job: Job, *, with_audit: bool = True) -> dict:
        view = job.view()
        view["next_actions"] = _next_actions(job)
        if with_audit:
            view["audit_tail"] = self.store.audit_tail(job.job_id, limit=8)
        return view


def _intent_matches(wf: spec_mod.Workflow, wanted: str) -> bool:
    key = wanted.strip().lower()
    if not key:
        return True
    if key in (wf.intent, wf.id):
        return True
    if wf.intent.startswith(key + "."):
        return True
    if key in {t.lower() for t in wf.tags}:
        return True
    return False


def _next_actions(job: Job) -> list[str]:
    if job.status == "waiting_approval":
        return [
            f"workflow gate {job.job_id} --decision approved --by <who> --note <why>",
            f"workflow gate {job.job_id} --decision rejected --note <why>",
        ]
    if job.status == "waiting_operator":
        return [
            f"workflow resume {job.job_id} --decision done",
            f"workflow resume {job.job_id} --decision failed --note <what went wrong>",
        ]
    if job.status == "succeeded":
        return [f"workflow artifacts {job.job_id}"]
    if job.status == "failed":
        return [f"workflow status {job.job_id}",
                f"workflow artifacts {job.job_id}"]
    if job.status == "running":
        return [f"workflow status {job.job_id}"]
    return []


_ = DEFAULT_BASE_URL
