"""runner —— 工作流状态机。

状态机::

    pending → running → succeeded
                     ├→ waiting_approval → running (approved) / cancelled (rejected)
                     ├→ waiting_operator → running (done)    / failed    (failed)
                     └→ failed / cancelled

硬规则（不是建议）
------------------
* **一步失败就停**（``on_fail: stop``，默认），并把失败归类。新分类器给出八类
  （``environment / input / execution / policy / selector_drift /
  dialog_unavailable / gate_timeout / hardware_missing``，见 :mod:`.errors`）；
  引擎层与「有驱动但不该由驱动做」仍沿用 ``artifact`` / ``capability``。
* **没有 retry。** 不可逆动作不自动重试；要再来一次就是一条新 job，审计里看得见。
* **没有驱动就不点。** ``gui`` / ``verify_ui`` / ``wait_ui`` 在 assisted 模式下变成
  ``waiting_operator`` 人工任务，而不是假装执行成功。
* **审批门在看懂风险之前不消失。** ``human_gate`` 只有 ``approved`` 才继续；
  ``rejected`` 直接取消，不执行后面的步骤。
* **证据先落盘再结束。** 失败现场写 ``artifacts/failure.json``；工作流声明
  ``failure.screenshot: true`` 且驱动可用时再补一张截图。
"""
from __future__ import annotations

import hashlib
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import engine as engine_mod
from . import gui as gui_mod
from . import spec as spec_mod
from .errors import (
    GateTimeout,
    classify_failure,
    is_click_error,
    is_gui_unavailable,
)
from .store import Job, JobStore

__all__ = ["JobBusy", "StepFailure", "WorkflowRunner"]

_OPERATORS = frozenset({"exists", "nonempty", "matches", "min", "gte", "lte"})
_VERSION_ID = 37


class JobBusy(RuntimeError):
    """同一个 job 或同一条流程已有别的运行/等待实例。"""

    def __init__(self, message: str, job_id: str | None = None) -> None:
        self.job_id = job_id
        super().__init__(message)


class StepFailure(Exception):
    """一个步骤失败。``failure_class`` 必须是 :data:`spec.KNOWN_FAILURE_CLASSES` 之一。"""

    def __init__(
        self,
        failure_class: str,
        message: str,
        *,
        evidence: dict | None = None,
    ) -> None:
        if failure_class not in spec_mod.KNOWN_FAILURE_CLASSES:
            raise ValueError(f"未知失败类别：{failure_class!r}")
        self.failure_class = failure_class
        self.message = message
        self.evidence = evidence or {}
        super().__init__(message)


def _utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _norm_model(value: object) -> str:
    return "".join(str(value or "").split()).upper()


def _sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


class WorkflowRunner:
    def __init__(
        self,
        store: JobStore,
        engine: engine_mod.EngineClient | None = None,
        driver: gui_mod.GuiDriver | None = None,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.store = store
        self.engine = engine or engine_mod.EngineClient()
        self.driver = driver or gui_mod.AssistedDriver()
        self.sleep = sleep
        self.clock = clock

    # ================================================================== 入口
    def run(self, job: Job, workflow: spec_mod.Workflow, *, force_lock: bool = False) -> Job:
        """从 ``job.step_index`` 开始跑，直到完成或停在人工闸门。"""
        job_lock = self.store.lock(job.job_id)
        if job_lock.acquire(force=force_lock) is None:
            owner = job_lock.owner() or {}
            raise JobBusy(
                f"job {job.job_id} 正被另一个进程运行（pid={owner.get('pid', '?')}，"
                f"at={owner.get('at', '?')}）", job.job_id)
        wf_lock = self.store.workflow_lock(job.workflow)
        if wf_lock.acquire(force=force_lock) is None:
            job_lock.release()
            owner = wf_lock.owner() or {}
            raise JobBusy(
                f"工作流 {job.workflow} 已有运行实例（pid={owner.get('pid', '?')}，"
                f"at={owner.get('at', '?')}）；等它结束或用 force 解锁", job.job_id)
        try:
            return self._drive(job, workflow)
        finally:
            wf_lock.release()
            job_lock.release()

    def resume(
        self,
        job: Job,
        workflow: spec_mod.Workflow,
        decision: str,
        *,
        by: str = "operator",
        note: str = "",
        force_lock: bool = False,
    ) -> Job:
        if not job.is_waiting or not job.pending_gate:
            raise ValueError(f"job {job.job_id} 没有等待中的闸门（状态 {job.status}）")
        gate = job.pending_gate
        options = gate.get("options") or []
        if decision not in options:
            raise ValueError(f"decision 必须是 {options} 之一，收到 {decision!r}")
        resolved = dict(gate)
        resolved.update({
            "decision": decision,
            "by": by,
            "note": note,
            "resolved_at": _utcnow(),
        })
        job.gates.append(resolved)
        job.pending_gate = None
        self.store.audit(job, "gate.resolved", step=gate.get("step"), kind=gate.get("kind"),
                         decision=decision, by=by, note=note)
        if decision in ("rejected", "failed"):
            job.status = "cancelled" if decision == "rejected" else "failed"
            job.finished_at = _utcnow()
            if decision == "rejected":
                job.cancel_reason = note or "approval_rejected"
                self.store.audit(job, "job.cancelled", reason=job.cancel_reason, by=by)
            else:
                note_text = note or "操作员报告这一步失败"
                job.failure = {
                    "class": classify_failure(None, step_kind=str(gate.get("kind", "")),
                                              message=note_text),
                    "step": gate.get("step"),
                    "kind": gate.get("kind"),
                    "message": note_text,
                    "evidence": {"gate": gate},
                    "at": _utcnow(),
                }
                self._write_failure_artifact(job, workflow)
                self.store.audit(job, "job.failed", **job.failure)
            self.store.save(job)
            return job
        if gate.get("advance", True):
            job.step_index = min(job.step_index + 1, job.steps_total)
        else:
            job.context["workflow_approved"] = True
        job.status = "running"
        self.store.save(job)
        return self.run(job, workflow, force_lock=force_lock)

    def cancel(self, job: Job, reason: str = "cancelled", *, by: str = "operator") -> Job:
        if job.is_terminal:
            return job
        if job.pending_gate:
            gate = dict(job.pending_gate)
            gate.update({"decision": "cancelled", "by": by, "note": reason,
                         "resolved_at": _utcnow()})
            job.gates.append(gate)
        job.status = "cancelled"
        job.cancel_reason = reason
        job.finished_at = _utcnow()
        job.pending_gate = None
        self.store.save(job)
        self.store.audit(job, "job.cancelled", reason=reason, by=by)
        return job

    # ================================================================== 主循环
    def _drive(self, job: Job, workflow: spec_mod.Workflow) -> Job:
        if job.status != "running":
            job.status = "running"
        job.started_at = job.started_at or _utcnow()
        job.current_step = self._step_id(workflow, job.step_index)
        self.store.save(job)
        self.store.audit(job, "job.running", step=job.current_step,
                         index=job.step_index, total=job.steps_total)
        gate = self._workflow_gate(job, workflow)
        if gate is not None:
            job.pending_gate = gate
            job.status = "waiting_approval"
            self.store.save(job)
            self.store.audit(job, "gate.opened", step=gate["step"], kind=gate["kind"],
                             reason=gate.get("reason", ""), prompt=gate.get("prompt", ""))
            return job
        while job.step_index < job.steps_total:
            step = workflow.steps[job.step_index]
            step_id = str(step["id"])
            job.current_step = step_id
            try:
                gate = self._gate_for(step, job)
            except StepFailure as failure:
                self._handle_step_failure(job, workflow, step, failure, duration_ms=0)
                return job
            if gate is not None:
                job.pending_gate = gate
                job.status = "waiting_approval" if gate["kind"] == "approval" else "waiting_operator"
                self.store.save(job)
                self.store.audit(job, "gate.opened", step=step_id, kind=gate["kind"],
                                 reason=gate.get("reason", ""), prompt=gate.get("prompt", ""))
                return job
            started = self.clock()
            self.store.audit(job, "step.begin", step=step_id, kind=step["kind"])
            try:
                output = self._execute(step, job)
            except StepFailure as failure:
                stop = self._handle_step_failure(
                    job, workflow, step, failure,
                    duration_ms=round((self.clock() - started) * 1000))
                if stop:
                    return job
                job.step_index += 1
                job.current_step = self._step_id(workflow, job.step_index)
                self.store.save(job)
                continue
            except engine_mod.EngineError as exc:
                # 引擎错误自带分类（连不上=environment、409=input、404=artifact…）；
                # 在这里统一转换，避免每个步骤各写一遍映射。
                failure = StepFailure(
                    getattr(exc, "failure_class", "execution"), str(exc),
                    evidence=getattr(exc, "evidence", {}) or {})
                stop = self._handle_step_failure(job, workflow, step, failure,
                                                 duration_ms=round((self.clock() - started) * 1000))
                if stop:
                    return job
                job.step_index += 1
                job.current_step = self._step_id(workflow, job.step_index)
                self.store.save(job)
                continue
            except Exception as exc:  # noqa: BLE001 —— 未预期的异常也要归类和落盘
                failure = StepFailure(
                    classify_failure(exc, step_kind=str(step.get("kind", "")),
                                     message=str(exc)),
                    f"{type(exc).__name__}: {exc}",
                    evidence={"traceback": True})
                self._handle_step_failure(job, workflow, step, failure,
                                          duration_ms=round((self.clock() - started) * 1000))
                return job
            self._store_output(job, step, output)
            job.step_index += 1
            job.current_step = self._step_id(workflow, job.step_index)
            self.store.save(job)
            self.store.audit(job, "step.ok", step=step_id, kind=step["kind"],
                             duration_ms=round((self.clock() - started) * 1000),
                             output=_small(output))
        job.status = "succeeded"
        job.finished_at = _utcnow()
        job.current_step = None
        self.store.save(job)
        self.store.write_artifact(
            job, "context.json", job.context, kind="json", note="全部步骤的输出快照")
        self.store.audit(job, "job.succeeded", steps=job.steps_total)
        return job

    def _step_id(self, workflow: spec_mod.Workflow, index: int) -> str | None:
        if 0 <= index < workflow.step_count:
            return str(workflow.steps[index]["id"])
        return None

    # ================================================================== 闸门
    def _workflow_gate(self, job: Job, workflow: spec_mod.Workflow) -> dict | None:
        """工作流级审批：在第一步之前发生，还原时**不**推进 step_index。"""
        if job.step_index != 0 or job.context.get("workflow_approved"):
            return None
        approval = workflow.approval or {}
        if not approval.get("required"):
            return None
        if any(g.get("step") == "(workflow)" for g in job.gates):
            return None
        return {
            "kind": "approval",
            "step": "(workflow)",
            "reason": approval.get("reason", ""),
            "prompt": f"{workflow.title}：{approval.get('reason', '')}",
            "risk": approval.get("risk", "high"),
            "options": ["approved", "rejected"],
            "advance": False,
            "opened_at": _utcnow(),
        }

    def _gate_for(self, step: dict, job: Job) -> dict | None:
        kind = step["kind"]
        if kind == "human_gate":
            return {
                "kind": "approval",
                "step": step["id"],
                "reason": step.get("reason", ""),
                "prompt": step.get("prompt", step.get("reason", "")),
                "risk": step.get("risk", "high"),
                "options": ["approved", "rejected"],
                "opened_at": _utcnow(),
            }
        if kind in ("gui", "verify_ui", "wait_ui") and not getattr(self.driver, "available", False):
            assisted = step.get("assisted") or {}
            if assisted.get("enabled") is False:
                raise StepFailure(
                    "capability",
                    f"步骤 {step['id']} 需要 GUI 驱动，但当前驱动 "
                    f"{getattr(self.driver, 'name', '?')!r} 不可用，且 assisted.enabled=false")
            return {
                "kind": "operator",
                "step": step["id"],
                "reason": "需要人工在 GUI 里完成（当前没有可用的 GUI 驱动）",
                "prompt": assisted.get("prompt") or self._default_prompt(step),
                "risk": "medium",
                "options": ["done", "failed"],
                "opened_at": _utcnow(),
            }
        return None

    @staticmethod
    def _default_prompt(step: dict) -> str:
        if step["kind"] == "wait_ui":
            return (f"请在 GUI 里让 {step.get('control')} 出现并满足 {step.get('expect')}，"
                    "确认后选 done。")
        if step["kind"] == "verify_ui":
            return f"请确认 {step.get('control')} 的值符合 {step.get('expect')}，然后选择 done。"
        if step.get("actions"):
            lines = []
            for action in step["actions"]:
                lines.append(" ".join(f"{k}={v}" for k, v in action.items()))
            return "请在 GUI 里完成：\n" + "\n".join(lines)
        return f"请在 GUI 里完成 {step.get('locator') or step.get('page') or step['id']}。"

    # ================================================================== 执行
    def _execute(self, step: dict, job: Job) -> dict:
        handler = getattr(self, f"_step_{step['kind']}", None)
        if handler is None:  # pragma: no cover —— 加载时已挡住
            raise StepFailure("capability", f"执行器没有 {step['kind']} 的实现")
        context = self._context(job)
        return handler(step, job, context)  # type: ignore[operator]

    def _context(self, job: Job) -> dict:
        return {
            "params": job.params,
            "job": {"id": job.job_id, "workflow": job.workflow},
            "steps": job.context.get("steps", {}),
            "link": job.context.get("link"),
            "cursor": job.context.get("cursor", 0),
            "engine": {"base_url": self.engine.base_url},
        }

    @staticmethod
    def _number(step: dict, key: str, default: float, ctx: dict) -> float:
        """数值字段可能是字面量，也可能是 ``${params.x}``；统一在这里解析。"""
        raw = step.get(key, default)
        value = spec_mod.resolve(raw, ctx)
        if value is None or value == "":
            value = default
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise StepFailure(
                "input", f"步骤 {step.get('id')} 的 {key} 不是数值：{raw!r} → {value!r}") from exc

    def _step_failure(
        self, exc: BaseException, step: dict, *, evidence: dict | None = None
    ) -> StepFailure:
        """把一个驱动/系统异常转成带类别与原始消息的 :class:`StepFailure`。"""
        message = str(exc)
        return StepFailure(
            classify_failure(exc, step_kind=str(step.get("kind", "")), message=message),
            message,
            evidence=evidence,
        )

    def _store_output(self, job: Job, step: dict, output: dict) -> None:
        steps = job.context.setdefault("steps", {})
        steps[str(step["id"])] = output
        alias = step.get("save_as")
        if alias:
            steps[str(alias)] = output
        if isinstance(output, dict) and "cursor" in output:
            job.context["cursor"] = output["cursor"]

    def _handle_step_failure(
        self,
        job: Job,
        workflow: spec_mod.Workflow,
        step: dict,
        failure: StepFailure,
        *,
        duration_ms: int,
    ) -> bool:
        """记录失败；返回 ``True`` 表示 job 应该停下。"""
        record = {
            "class": failure.failure_class,
            "step": step["id"],
            "kind": step["kind"],
            "message": failure.message,
            "evidence": failure.evidence,
            "at": _utcnow(),
        }
        self.store.audit(job, "step.failed", duration_ms=duration_ms, **record)
        if step.get("on_fail", "stop") == "continue" and failure.failure_class != "capability":
            job.warnings.append(record)
            job.context.setdefault("steps", {}).setdefault(str(step["id"]), {"failed": record})
            self.store.save(job)
            return False
        job.status = "failed"
        job.finished_at = _utcnow()
        job.failure = record
        self._write_failure_artifact(job, workflow, step)
        self.store.save(job)
        self.store.audit(job, "job.failed", **record)
        return True

    def _write_failure_artifact(
        self, job: Job, workflow: spec_mod.Workflow, step: dict | None = None
    ) -> None:
        record = job.failure or {}
        evidence = {
            "job": job.job_id,
            "workflow": job.workflow,
            "failure": record,
            "params": job.params,
            "current_step": job.current_step,
            "screenshot": None,
        }
        if workflow.failure.get("screenshot"):
            driver_available = bool(getattr(self.driver, "available", False))
            if driver_available and step is not None:
                name = f"failure-{step['id']}.png"
                try:
                    path = self.store.artifacts_dir(job.job_id) / name
                    written = self.driver.screenshot(path)
                    evidence["screenshot"] = written
                except Exception as exc:  # noqa: BLE001 —— 截图失败不能盖住原失败
                    evidence["screenshot_error"] = f"{type(exc).__name__}: {exc}"
            else:
                evidence["screenshot"] = "no-driver"
        try:
            self.store.write_artifact(job, "failure.json", evidence, kind="json",
                                      source_step=job.current_step)
        except Exception as exc:  # noqa: BLE001
            evidence["artifact_error"] = f"{type(exc).__name__}: {exc}"

    # ================================================================== 步骤实现
    def _step_http(self, step: dict, job: Job, ctx: dict) -> dict:
        path = str(spec_mod.resolve(step["path"], ctx))
        method = str(step.get("method", "GET")).upper()
        query = spec_mod.resolve(step.get("query"), ctx)
        body = spec_mod.resolve(step.get("json"), ctx) if "json" in step else None
        timeout = float(spec_mod.resolve(step["timeout_s"], ctx)) if "timeout_s" in step else None
        resp = self.engine.request(method, path, query=query, json_body=body, timeout=timeout)
        allowed = step.get("expect_status", 200)
        if isinstance(allowed, int):
            allowed = [allowed]
        if resp.status not in allowed:
            raise StepFailure(
                "execution", f"{method} {path} 返回 {resp.status}，期望 {allowed}",
                evidence={"status": resp.status, "body": resp.body[:400].decode("utf-8", "replace")})
        data = resp.json()
        self._apply_expect(step.get("expect"), data, step)
        return {"status": resp.status, "body": data}

    def _step_download(self, step: dict, job: Job, ctx: dict) -> dict:
        path = str(spec_mod.resolve(step["path"], ctx))
        query = spec_mod.resolve(step.get("query"), ctx)
        timeout = float(spec_mod.resolve(step["timeout_s"], ctx)) if "timeout_s" in step else None
        resp = self.engine.download(path, query=query, timeout=timeout)
        if resp.status != 200:
            raise StepFailure(
                "artifact", f"GET {path} 返回 {resp.status}",
                evidence={"status": resp.status, "body": resp.body[:400].decode("utf-8", "replace")})
        blob = resp.body
        minimum = int(step.get("min_bytes", 0) or 0)
        if len(blob) < minimum:
            raise StepFailure(
                "artifact", f"下载内容只有 {len(blob)} B，少于要求的 {minimum} B",
                evidence={"bytes": len(blob)})
        magic = step.get("magic")
        if magic and not blob.startswith(str(magic).encode("utf-8")):
            raise StepFailure(
                "artifact", f"下载内容不是以 {magic!r} 开头",
                evidence={"head": blob[:32].decode("utf-8", "replace")})
        header_expect = spec_mod.resolve(step.get("expect_header") or {}, ctx)
        headers: dict[str, str] = {}
        for header, pattern in dict(header_expect).items():
            value = resp.headers.get(header)
            headers[str(header)] = "" if value is None else str(value)
            if value is None:
                raise StepFailure(
                    "artifact", f"响应缺少头部 {header}",
                    evidence={"headers": dict(resp.headers)})
            if pattern and not re.search(str(pattern), str(value)):
                raise StepFailure(
                    "artifact", f"响应头 {header}={value!r} 不匹配 {pattern!r}",
                    evidence={"header": header, "value": str(value)})
        name = str(spec_mod.resolve(step["filename"], ctx))
        record = self.store.write_artifact(job, name, blob, kind="file",
                                           source_step=str(step["id"]))
        return {
            "file": name,
            "path": record["path"],
            "bytes": len(blob),
            "sha256": _sha256(blob),
            "content_type": str(resp.headers.get("Content-Type", "")),
            "headers": headers,
        }

    def _step_live_command(self, step: dict, job: Job, ctx: dict) -> dict:
        line = str(spec_mod.resolve(step["line"], ctx))
        resp = self.engine.live_command(line)
        commands = resp.get("commands") or []
        if not isinstance(commands, list) or not commands:
            raise StepFailure(
                "execution", "发送命令后 /api/live/status 没有返回命令记录",
                evidence={"response_keys": sorted(resp)})
        entry = max(
            (c for c in commands if isinstance(c, dict)),
            key=lambda c: int(c.get("id", -1)),
            default=None)
        if entry is None or entry.get("line") != line:
            raise StepFailure(
                "execution", f"命令记录里找不到刚发出的 {line!r}",
                evidence={"last": _small(commands[-1])})
        status = str(entry.get("status", "pending"))
        if status in ("not-connected", "send-failed"):
            raise StepFailure(
                "environment", f"命令没有发出去：{line!r}（{status}）",
                evidence={"entry": _small(entry)})
        if step.get("await_reply", False):
            timeout = self._number(step, "timeout_s", 10.0, ctx)
            allowed = [str(s) for s in step.get("reply_status_any_of", ["ok"])]
            deadline = self.clock() + timeout
            command_id = entry.get("id")
            while status == "pending" and self.clock() < deadline:
                self.sleep(0.25)
                status_page = self.engine.live_status()
                found = _find_command(status_page, command_id)
                if found is not None:
                    entry = found
                    status = str(entry.get("status", "pending"))
            if status not in allowed:
                raise StepFailure(
                    "execution",
                    f"命令 {line!r} 的回答是 {status}，期望 {allowed}",
                    evidence={"entry": _small(entry)})
        return {
            "id": entry.get("id"),
            "line": line,
            "status": status,
            "reply": entry.get("reply"),
            "at": entry.get("at"),
            "elapsed_ms": entry.get("elapsedMs"),
        }

    def _step_ensure_live(self, step: dict, job: Job, ctx: dict) -> dict:
        status = self.engine.live_status()
        if status.get("connected"):
            job.context["link"] = {
                "request": None,
                "target": status.get("target"),
                "connected_at": status.get("connectedAt"),
            }
            return {"connected": True, "target": status.get("target"), "reused": True}
        target = spec_mod.resolve(step.get("target"), ctx)
        if target is None:
            target = spec_mod.resolve("${params.target}", ctx)
        if not target:
            raise StepFailure(
                "input",
                "链路没有连上，且没有给 target。给一个 target（COM8@115200 / "
                "tcp://host:port / udp://host:port）或先在 GUI 里连好。",
                evidence={"live": _small(status)})
        try:
            body = engine_mod.parse_target(str(target))
        except ValueError as exc:
            raise StepFailure("input", str(exc)) from exc
        connected = self.engine.live_connect(body)
        if not connected.get("connected"):
            raise StepFailure(
                "environment", f"按 {target!r} 连接后链路仍未连通",
                evidence={"live": _small(connected), "request": body})
        job.context["link"] = {
            "request": body,
            "target": connected.get("target"),
            "connected_at": connected.get("connectedAt"),
        }
        return {"connected": True, "target": connected.get("target"), "reused": False}

    def _step_mark_cursor(self, step: dict, job: Job, ctx: dict) -> dict:
        page = self.engine.live_logs(after=0, limit=1)
        cursor = int(page.get("cursor", 0) or 0)
        return {"cursor": cursor, "entries": len(page.get("entries") or [])}

    def _step_await_receiver(self, step: dict, job: Job, ctx: dict) -> dict:
        wait_for = str(step.get("wait_for", "version"))
        poll = self._number(step, "poll_s", 1.0, ctx)
        timeout = self._number(step, "timeout_s", 60.0, ctx)
        after = int(spec_mod.resolve(step.get("after_cursor"), ctx) or 0)
        deadline = self.clock() + timeout
        started = self.clock()
        saw_drop = False

        if wait_for == "reconnect_and_version":
            status = self.engine.live_status()
            if status.get("connected"):
                drop_grace = self._number(step, "drop_grace_s", 30.0, ctx)
                drop_deadline = min(deadline, self.clock() + drop_grace)
                while self.clock() < drop_deadline:
                    if not self.engine.live_status().get("connected"):
                        saw_drop = True
                        break
                    self.sleep(poll)
            else:
                saw_drop = True
            next_reconnect = self.clock()
            while self.clock() < deadline:
                status = self.engine.live_status()
                if status.get("connected"):
                    break
                if step.get("reconnect", True) and self.clock() >= next_reconnect:
                    request = (job.context.get("link") or {}).get("request")
                    if not request:
                        request = engine_mod.parse_target_string(status.get("target") or "")
                    if request:
                        try:
                            self.engine.live_connect(request)
                        except engine_mod.EngineError:
                            pass
                    next_reconnect = self.clock() + 3.0
                self.sleep(poll)
            else:
                raise StepFailure(
                    "environment",
                    f"接收机在 {timeout:g}s 内没有回到链路"
                    f"（target={(ctx.get('link') or {}).get('target') or status.get('target')!r}）",
                    evidence={"live": _small(status), "saw_drop": saw_drop})
            self.store.audit(job, "receiver.reconnected", saw_drop=saw_drop,
                             target=status.get("target"))
        elif not self.engine.live_status().get("connected"):
            raise StepFailure("environment", "链路未连接，读不到接收机的记录")

        if step.get("send_after_reconnect"):
            line = str(spec_mod.resolve(step["send_after_reconnect"], ctx))
            self.engine.live_command(line)
            self.store.audit(job, "receiver.request", line=line)

        expected_model = spec_mod.resolve(step.get("model"), ctx)
        expected_software = spec_mod.resolve(step.get("software"), ctx)
        last_seen: dict | None = None
        while self.clock() < deadline:
            page = self.engine.live_logs(after=after)
            for entry in page.get("entries") or []:
                found = _version_of(entry)
                if found is None:
                    continue
                last_seen = found
                if expected_model and _norm_model(found.get("model")) != _norm_model(expected_model):
                    continue
                if expected_software and not re.search(
                        str(expected_software), str(found.get("software") or "")):
                    continue
                return {
                    **found,
                    "entry_seq": entry.get("seq"),
                    "saw_drop": saw_drop,
                    "waited_s": round(self.clock() - started, 3),
                    "cursor": int(page.get("cursor", after) or after),
                }
            after = int(page.get("cursor", after) or after)
            self.sleep(poll)
        detail = ""
        if last_seen:
            detail = (f"；最后一条 VERSION 是 model={last_seen.get('model')!r} "
                      f"software={last_seen.get('software')!r}")
        raise StepFailure(
            "execution",
            f"{timeout:g}s 内没有等到匹配的 VERSION"
            f"（model={expected_model!r}, software={expected_software!r}）{detail}",
            evidence={"last_seen": last_seen, "after": after})

    def _step_file_digest(self, step: dict, job: Job, ctx: dict) -> dict:
        raw = str(spec_mod.resolve(step["path"], ctx))
        path = Path(raw).expanduser()
        if not path.is_file():
            raise StepFailure("input", f"文件不存在：{path}")
        blob = path.read_bytes()
        stat = path.stat()
        return {
            "path": str(path),
            "name": path.name,
            "bytes": len(blob),
            "sha256": _sha256(blob),
            "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc)
            .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }

    def _step_gui(self, step: dict, job: Job, ctx: dict) -> dict:
        actions = step.get("actions") or [step]
        performed: list[dict] = []
        try:
            for action in actions:
                name = str(action.get("action", "click"))
                if name == "open":
                    page = str(spec_mod.resolve(action.get("page"), ctx))
                    self.driver.open(page)
                    performed.append({"action": "open", "page": page})
                elif name == "click":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    self.driver.click(locator)
                    performed.append({"action": "click", "locator": locator})
                elif name == "click_optional":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    try:
                        self.driver.click(locator)
                    except Exception as exc:  # noqa: BLE001 —— 找不到就跳过
                        if "危险词" in str(exc):
                            # 危险目标不能被"可选"吞掉：该停闸门的仍然要停
                            raise
                        if not (is_gui_unavailable(exc) or is_click_error(exc)):
                            raise
                        performed.append({"action": "click_optional", "locator": locator,
                                          "clicked": False, "why": str(exc)})
                    else:
                        performed.append({"action": "click_optional", "locator": locator,
                                          "clicked": True})
                elif name == "type":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    value = str(spec_mod.resolve(action.get("value"), ctx))
                    self.driver.type_text(locator, value)
                    performed.append({"action": "type", "locator": locator})
                elif name == "select":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    option = str(spec_mod.resolve(action.get("option"), ctx))
                    self.driver.select(locator, option)
                    performed.append({"action": "select", "locator": locator, "option": option})
                elif name == "read":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    performed.append({"action": "read", "locator": locator,
                                      "value": self.driver.read(locator)})
                else:
                    raise StepFailure("capability", f"不支持的 GUI 动作：{name!r}")
        except Exception as exc:  # noqa: BLE001 —— 驱动各有自己的 GuiUnavailable
            if not is_gui_unavailable(exc):
                raise
            raise self._step_failure(exc, step) from exc
        screenshot = None
        if step.get("screenshot"):
            name = f"gui-{job.step_index:02d}-{step['id']}.png"
            path = self.store.artifacts_dir(job.job_id) / name
            try:
                produced = self.driver.screenshot(path)
            except Exception as exc:  # noqa: BLE001
                raise StepFailure("artifact", f"截图失败：{exc}") from exc
            if produced:
                data = Path(str(produced)).read_bytes()
                self.store.write_artifact(
                    job, name, data, kind="file", source_step=str(step["id"]),
                    note="GUI 截图")
                screenshot = name
        return {"actions": performed, "screenshot": screenshot}

    def _step_verify_ui(self, step: dict, job: Job, ctx: dict) -> dict:
        control = str(spec_mod.resolve(step["control"], ctx))
        expected = spec_mod.resolve(step.get("expect") or {}, ctx)
        try:
            value = self.driver.read(control)
        except Exception as exc:  # noqa: BLE001 —— 驱动各有自己的 GuiUnavailable
            if not is_gui_unavailable(exc):
                raise
            raise self._step_failure(exc, step) from exc
        errors = _compare(value, dict(expected))
        if errors:
            raise StepFailure(
                "execution", f"控件 {control!r} 的值不符合期望",
                evidence={"control": control, "value": value, "expected": expected,
                          "mismatches": errors})
        return {"control": control, "value": value, "expected": expected}

    #: ``wait_ui`` 的默认预算与轮询间隔。间隔固定 200ms：比人眼刷新慢一点，
    #: 但足够快，不至于把一次 3 秒的等待变成 6 秒。
    _WAIT_UI_TIMEOUT_S = 10.0
    _WAIT_UI_POLL_MS = 200.0

    def _step_wait_ui(self, step: dict, job: Job, ctx: dict) -> dict:
        """轮询 ``driver.read(control)``，直到读到的值满足 ``expect``。

        语义
        ----
        * **条件等待，不是盲等**：每 ``poll_ms``（默认 200）读一次，满足
          ``expect.contains`` / ``matches`` / ``equals`` 立刻继续；
        * 读不到控件（``GuiUnavailable``，例如弹窗还没出现）**不算失败**，只是
          「条件还没满足」，继续轮到 ``timeout``（默认 10 秒）；
        * 总时长不超过 ``timeout``：最后一次 sleep 会被夹到剩余预算，超了就抛
          ``gate_timeout``，消息里带轮询次数与最后一次读到的内容；
        * 失败类别固定为 ``gate_timeout``——这是「还没到时候」，不是环境坏、
          也不是选择器坏（选择器坏会在 ``verify_ui`` 里报 ``selector_drift``）。

        两种条件
        --------
        * ``expect: {contains/matches/equals: ...}``：**出现**并满足才算成功；
        * ``expect: {absent: true}``：**读不到**才算成功（等弹窗关掉 / 等遮罩消失）。
          只在「驱动确实能看页面」时成立：CDP 掉线、套件没开归 ``environment``，
          绝不能被当成「控件不在了」而秒过。

        字段：``control``（必填）、``expect``（必填）、
        ``timeout``（秒，默认 10，兼容别名 ``timeout_s``）、``poll_ms``（可选，默认 200）。
        """
        control = str(spec_mod.resolve(step["control"], ctx))
        expected = spec_mod.resolve(step.get("expect") or {}, ctx)
        if not isinstance(expected, dict) or not expected:
            raise StepFailure(
                "input", f"步骤 {step['id']} 的 wait_ui 没有可用的 expect 条件")
        if "timeout" in step:
            timeout = self._number(step, "timeout", self._WAIT_UI_TIMEOUT_S, ctx)
        else:
            timeout = self._number(step, "timeout_s", self._WAIT_UI_TIMEOUT_S, ctx)
        if timeout <= 0:
            raise StepFailure("input", f"步骤 {step['id']} 的 timeout 必须大于 0")
        poll_ms = self._number(step, "poll_ms", self._WAIT_UI_POLL_MS, ctx)
        interval = min(max(poll_ms, 1.0) / 1000.0, timeout)

        started = self.clock()
        deadline = started + timeout
        max_polls = int(timeout / interval) + 2
        absent = expected.get("absent") is True
        polls = 0
        last_value: str | None = None
        last_problem = "还没有读到控件"

        def hit(value: object) -> dict:
            waited = round(self.clock() - started, 3)
            self.store.audit(job, "wait_ui.matched", step=step["id"], control=control,
                             polls=polls, waited_s=waited, absent=absent)
            return {
                "control": control,
                "value": value,
                "expected": expected,
                "polls": polls,
                "waited_s": waited,
                "timeout_s": timeout,
            }

        while True:
            polls += 1
            try:
                value = self.driver.read(control)
            except Exception as exc:  # noqa: BLE001 —— 驱动各有自己的 GuiUnavailable
                # 读不到 ≠ 失败：弹窗/标签页可能还没画出来。
                if not is_gui_unavailable(exc):
                    raise
                if absent:
                    # 「不出现」只有在**驱动确实在看页面**时才算满足：
                    # CDP 掉线/套件没开是环境坏了，不能被当成「控件不在了」。
                    if classify_failure(exc, step_kind="wait_ui",
                                        message=str(exc)) == "environment":
                        raise self._step_failure(exc, step) from exc
                    return hit(None)
                last_problem = str(exc)
            else:
                last_value = value
                if absent:
                    last_problem = f"仍然可见：{str(value)[:120]}"
                else:
                    problems = _compare(str(value), dict(expected))
                    if not problems:
                        return hit(value)
                    last_problem = "；".join(problems)

            if polls >= max_polls or self.clock() >= deadline:
                break
            remaining = deadline - self.clock()
            if remaining <= 0:
                break
            self.sleep(min(interval, remaining))

        want = "消失（读不到才算）" if absent else f"满足 {expected}"
        message = (
            f"{timeout:g}s 内没有等到 {control!r} {want}："
            f"轮询 {polls} 次，最后一次 {last_problem}")
        raise StepFailure(
            "gate_timeout", message,
            evidence={"control": control, "expected": expected, "polls": polls,
                      "last_value": last_value, "last_problem": last_problem,
                      "timeout_s": timeout,
                      "elapsed_s": round(self.clock() - started, 3)})

    def _step_assert(self, step: dict, job: Job, ctx: dict) -> dict:
        results: list[dict] = []
        for check in step["checks"]:
            path = str(check["path"])
            actual = _lookup(ctx, path)
            operators = {k: v for k, v in check.items() if k not in ("path", "note")}
            resolved = {k: spec_mod.resolve(v, ctx) for k, v in operators.items()}
            if any(v is None for v in resolved.values()) and "exists" not in resolved:
                results.append({"path": path, "skipped": "期望值为空（可选参数未提供）"})
                continue
            problems = _check_value(path, actual, resolved)
            if problems:
                raise StepFailure(
                    "execution", f"断言失败：{path}",
                    evidence={"path": path, "actual": actual, "expected": resolved,
                              "problems": problems})
            results.append({"path": path, "ok": True, "actual": actual})
        return {"checks": len(results), "results": results}

    def _step_artifact(self, step: dict, job: Job, ctx: dict) -> dict:
        content = spec_mod.resolve(step["content"], ctx)
        name = str(spec_mod.resolve(step["name"], ctx))
        fmt = str(step.get("format", "json"))
        if isinstance(content, (dict, list)):
            record = self.store.write_artifact(
                job, name, content, kind="json", source_step=str(step["id"]))
        else:
            record = self.store.write_artifact(
                job, name, str(content), kind="text" if fmt == "text" else "json",
                source_step=str(step["id"]))
        return {"file": name, "path": record["path"], "bytes": record["bytes"],
                "sha256": record["sha256"]}

    def _step_sleep(self, step: dict, job: Job, ctx: dict) -> dict:
        seconds = self._number(step, "seconds", 1.0, ctx)
        self.sleep(seconds)
        return {"slept": seconds}

    def _step_human_gate(self, step: dict, job: Job, ctx: dict) -> dict:  # pragma: no cover
        # 永远走不到：_gate_for 在 human_gate 上先返回闸门。
        raise StepFailure("capability", "human_gate 步骤必须先经过闸门")

    # ================================================================== 断言
    def _apply_expect(self, expect: dict | None, data: dict, step: dict) -> None:
        if not expect:
            return
        if not isinstance(expect, dict):
            raise StepFailure("execution", f"步骤 {step['id']} 的 expect 不是映射")
        json_expect = expect.get("json")
        if json_expect is None:
            return
        if not isinstance(json_expect, dict):
            raise StepFailure("execution", f"步骤 {step['id']} 的 expect.json 不是映射")
        for path, expected in json_expect.items():
            actual = _lookup(data, str(path))
            if isinstance(expected, dict) and len(expected) == 1 and \
                    next(iter(expected)) in _OPERATORS:
                problems = _check_value(str(path), actual, dict(expected))
            else:
                problems = [] if actual == expected else [
                    f"期望 {expected!r}，实际 {actual!r}" + ("（缺失）" if actual is _MISSING else "")]
            if problems:
                raise StepFailure(
                    "execution", f"响应校验失败：{path}",
                    evidence={"path": path, "expected": expected,
                              "actual": None if actual is _MISSING else actual,
                              "problems": problems})


# --------------------------------------------------------------------------- 工具
_MISSING = object()


def _lookup(data: object, path: str) -> object:
    node = data
    for part in str(path).split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
            continue
        if isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
            continue
        return _MISSING
    return node


def _check_value(path: str, actual: object, rules: dict) -> list[str]:
    problems: list[str] = []
    missing = actual is _MISSING
    if "exists" in rules:
        want = bool(rules["exists"])
        if missing == want:
            problems.append(f"exists={want}，实际{'缺失' if missing else '存在'}")
    if missing:
        if not problems and any(k in rules for k in ("equals", "contains", "matches", "nonempty", "min", "gte", "lte")):
            problems.append("路径不存在")
        return problems
    if "equals" in rules and actual != rules["equals"]:
        problems.append(f"期望等于 {rules['equals']!r}，实际 {actual!r}")
    if "contains" in rules and str(rules["contains"]) not in str(actual):
        problems.append(f"期望包含 {rules['contains']!r}，实际 {actual!r}")
    if "matches" in rules:
        try:
            if not re.search(str(rules["matches"]), str(actual)):
                problems.append(f"期望匹配 {rules['matches']!r}，实际 {actual!r}")
        except re.error as exc:
            problems.append(f"正则不合法 {rules['matches']!r}：{exc}")
    if "nonempty" in rules:
        want = bool(rules["nonempty"])
        empty = actual is None or actual == "" or actual == [] or actual == {}
        if empty == want:
            problems.append(f"nonempty={want}，实际{'为空' if empty else '非空'}")
    if "min" in rules:
        try:
            if float(actual) < float(rules["min"]):
                problems.append(f"期望 >= {rules['min']}，实际 {actual}")
        except (TypeError, ValueError):
            problems.append(f"min 断言需要数值，实际 {actual!r}")
    if "gte" in rules:
        try:
            if float(actual) < float(rules["gte"]):
                problems.append(f"期望 >= {rules['gte']}，实际 {actual}")
        except (TypeError, ValueError):
            problems.append(f"gte 断言需要数值，实际 {actual!r}")
    if "lte" in rules:
        try:
            if float(actual) > float(rules["lte"]):
                problems.append(f"期望 <= {rules['lte']}，实际 {actual}")
        except (TypeError, ValueError):
            problems.append(f"lte 断言需要数值，实际 {actual!r}")
    return problems


def _compare(value: str, expected: dict) -> list[str]:
    problems: list[str] = []
    if "equals" in expected and value.strip() != str(expected["equals"]).strip():
        problems.append(f"期望等于 {expected['equals']!r}，实际 {value!r}")
    if "contains" in expected and str(expected["contains"]).strip() not in value:
        problems.append(f"期望包含 {expected['contains']!r}，实际 {value!r}")
    if "matches" in expected:
        try:
            if not re.search(str(expected["matches"]), value):
                problems.append(f"期望匹配 {expected['matches']!r}，实际 {value!r}")
        except re.error as exc:
            problems.append(f"正则不合法：{exc}")
    return problems


def _version_of(entry: dict) -> dict | None:
    if not isinstance(entry, dict):
        return None
    if entry.get("messageId") != _VERSION_ID and not str(entry.get("name", "")).upper().startswith("VERSION"):
        return None
    data = entry.get("data")
    if not isinstance(data, dict) or data.get("kind") != "version":
        return None
    return {
        "model": data.get("model") or "",
        "hardware": data.get("hardwareVersion") or "",
        "software": data.get("softwareVersion") or "",
        "ascii": entry.get("ascii") or "",
    }


def _find_command(status_page: dict, command_id: object) -> dict | None:
    for entry in status_page.get("commands") or []:
        if isinstance(entry, dict) and entry.get("id") == command_id:
            return entry
    return None


def _small(value: object, limit: int = 1200) -> object:
    """审计里只留小快照；大块报文进 artifacts。"""
    import json

    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)[:limit]
    if len(text) <= limit:
        return value
    return text[:limit] + "…"
