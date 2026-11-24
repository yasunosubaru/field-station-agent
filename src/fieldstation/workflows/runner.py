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
import os
import re
import sys
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
        #: 按端口缓存的额外驱动（套件 9223 / Graph 9224 各一个）
        self._port_drivers: dict[int, object] = {}
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
        if kind in ("gui", "verify_ui", "wait_ui") and not self._available_for(step):
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
            shot_driver = self.driver
            if step is not None:
                try:
                    shot_driver = self._driver_for(step)
                except Exception:  # noqa: BLE001 —— 截图驱动建不起来就用默认的
                    shot_driver = self.driver
            driver_available = bool(getattr(shot_driver, "available", False))
            if driver_available and step is not None:
                name = f"failure-{step['id']}.png"
                try:
                    path = self.store.artifacts_dir(job.job_id) / name
                    written = shot_driver.screenshot(path)
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

    def _available_for(self, step: dict) -> bool:
        """按步骤的端口判断驱动是否可用；端口驱动建不起来也算不可用。"""
        try:
            return bool(getattr(self._driver_for(step), "available", False))
        except Exception:  # noqa: BLE001 —— 端口没起/模块加载失败都按"不可用"处理
            return False

    def _driver_for(self, step: dict):
        """步骤带 ``port`` 时用那个端口的驱动（例如 Graph 的 9224），否则用默认驱动。"""
        port = step.get("port")
        if not port:
            return self.driver
        key = int(port)
        cached = self._port_drivers.get(key)
        if cached is not None:
            return cached
        extra = gui_mod.load_cdp_driver(key)
        if not getattr(extra, "available", False):
            raise StepFailure(
                "environment", f"端口 {key} 上没有可用的 CDP 驱动（对应程序没启动？）")
        self._port_drivers[key] = extra
        return extra

    def _uia_driver(self):
        """懒加载 UIA 驱动，专供原生对话框。

        为什么单独一个入口：同一个步骤里可能既有页面元素（CDP 能点）又有原生
        对话框（只有 UIA 能看见）。实测 gui.graph.new-project 第 10 步
        choose_folder 就是这种：
            click locator="target:Select"   -> 页面上的 Select 按钮（CDP）
            dialog / fill_dialog            -> 弹出的 Windows「选择文件夹」（UIA）
        把整步换成 UIA 会让 `target:` 这种 CDP 语义键找不到选择器。
        """
        cached = getattr(self, "_uia_driver_obj", None)
        if cached is not None:
            return cached if cached is not False else None
        try:
            drv = gui_mod.load_driver("uia")
        except Exception:  # noqa: BLE001 —— 没有 UIA 就退回原驱动，报错交给分派处
            self._uia_driver_obj = False
            return None
        if drv is None or not getattr(drv, "available", False):
            self._uia_driver_obj = False
            return None
        self._uia_driver_obj = drv
        return drv

    def _uia_driver(self):
        """懒加载 UIA 驱动；不可用时返回 None（保留原来那条明确的报错）。"""
        cached = getattr(self, "_uia_driver_obj", None)
        if cached is not None:
            return cached if cached is not False else None
        try:
            drv = gui_mod.load_driver("uia")
        except Exception:  # noqa: BLE001 —— 没有 UIA 就退回原驱动，报错交给分派处
            self._uia_driver_obj = False
            return None
        if drv is None or not getattr(drv, "available", False):
            self._uia_driver_obj = False
            return None
        self._uia_driver_obj = drv
        return drv

    def _step_gui(self, step: dict, job: Job, ctx: dict) -> dict:
        driver = self._driver_for(step)
        actions = step.get("actions") or [step]
        performed: list[dict] = []
        try:
            for action in actions:
                name = str(action.get("action", "click"))
                if name == "open":
                    page = str(spec_mod.resolve(action.get("page"), ctx))
                    driver.open(page)
                    performed.append({"action": "open", "page": page})
                elif name == "click":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    css = action.get("css")
                    css = str(spec_mod.resolve(css, ctx)) if css else None
                    if css:
                        # 声明了 css 就走三级升级：语义 → 坐标+真鼠标 → 报错带全部原因。
                        # 只声明 locator 时保持原行为（语义路径），不改变既有流程语义。
                        entry = _click_escalating(driver, locator, css,
                                                  allow_danger=_allows_danger(locator))
                        performed.append({"action": "click", "locator": locator,
                                          "css": css,
                                          "escalation": entry.get("escalation"),
                                          "x": entry.get("x"), "y": entry.get("y")})
                    else:
                        driver.click(locator)
                        performed.append({"action": "click", "locator": locator})
                elif name == "click_optional":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    try:
                        driver.click(locator)
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
                elif name == "real_mouse":
                    # 真鼠标点击：Electron 的原生对话框要求真实用户手势，
                    # JS element.click() 不算（实测，见文件头注释）。
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    info = _real_mouse_click(driver, locator)
                    performed.append({"action": "real_mouse", "locator": locator,
                                      **info})
                elif name == "type":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    raw = spec_mod.resolve(action.get("value"), ctx)
                    # 可选参数未提供时 resolve 返回 None。**不能 str(None)**：
                    # 那会把字面量 'None' 填进输入框，而大部分应用的表单校验
                    # 会因此判定"没填"，按钮永久禁用，点它毫无反应。
                    # 实测踩过（2026-11-18，Graph 的 Project Description 被填成
                    # 'None'，导致 Next 一直 disabled、Select 点不动，我因此
                    # 误判成"Graph 不弹原生对话框"，白查了好几轮）。
                    if raw is None:
                        performed.append({"action": "type", "locator": locator,
                                          "skipped": "value 为 None（可选参数未提供）"})
                        continue
                    value = str(raw)
                    if value == "":
                        performed.append({"action": "type", "locator": locator,
                                          "skipped": "value 为空字符串"})
                        continue
                    driver.type_text(locator, value)
                    performed.append({"action": "type", "locator": locator})
                elif name == "select":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    raw_opt = spec_mod.resolve(action.get("option"), ctx)
                    if raw_opt is None:
                        performed.append({"action": "select", "locator": locator,
                                          "skipped": "option 为 None（可选参数未提供）"})
                        continue
                    option = str(raw_opt)
                    driver.select(locator, option)
                    performed.append({"action": "select", "locator": locator, "option": option})
                elif name == "read":
                    locator = str(spec_mod.resolve(action.get("locator"), ctx))
                    performed.append({"action": "read", "locator": locator,
                                      "value": driver.read(locator)})
                elif name == "dialog":
                    # 等一个**原生对话框**出现（Open / Save / Select Folder）。
                    # 这类窗口是独立顶层窗口，CDP 的页面查询完全看不到它，
                    # 所以必须走 UIA（tools/uia_driver.py 的 dialog 动作）。
                    #
                    # `value` 是标题正则，可选；不给就中英文都认。
                    pattern = action.get("value")
                    pattern = str(spec_mod.resolve(pattern, ctx)) if pattern else None
                    seconds = self._number(action, "timeout_s", 20.0, ctx)
                    # 原生对话框只有 UIA 能看见（CDP 只认页面元素）。这里按**动作**
                    # 换驱动，不按步骤换：同一步里可能既有页面按钮又有原生对话框。
                    dialog_driver = self._uia_driver() or driver
                    dialog = getattr(dialog_driver, "dialog", None)
                    if not callable(dialog):
                        raise StepFailure(
                            "capability",
                            f"步骤 {step['id']} 需要等原生对话框，但驱动 "
                            f"{getattr(dialog_driver, 'name', '?')} 不支持 dialog()。"
                            "原生对话框只能走 UIA（tools/uia_driver.py）；CDP 看不到它。")
                    info = dialog(pattern, seconds=seconds) or {}
                    performed.append({"action": "dialog",
                                      "title": info.get("title"),
                                      "class_name": info.get("class_name")})
                elif name == "fill_dialog":
                    # 在原生「打开 / 选择文件夹」对话框里填路径并确认。
                    # 这是 app.install 导入 ZIP、graph.newproject 选目录/文件
                    # 这几处以前只能人工的原因所在。
                    value = spec_mod.resolve(action.get("value"), ctx)
                    if value is None or str(value).strip() == "":
                        raise StepFailure(
                            "input", f"步骤 {step['id']} 的 fill_dialog 缺少 value（路径）")
                    path = str(value)
                    confirm = action.get("option")
                    confirm = str(spec_mod.resolve(confirm, ctx)) if confirm else None
                    seconds = self._number(action, "timeout_s", 20.0, ctx)
                    # 同上：原生对话框只能走 UIA（CDP 只认页面元素）。
                    fill_driver = self._uia_driver() or driver
                    fill = getattr(fill_driver, "fill_dialog", None)
                    if not callable(fill):
                        raise StepFailure(
                            "capability",
                            f"步骤 {step['id']} 需要原生对话框，但驱动 "
                            f"{getattr(fill_driver, 'name', '?')} 不支持 fill_dialog()。"
                            "原生对话框只能走 UIA（tools/uia_driver.py）。")
                    filled = fill(path, confirm=confirm, seconds=seconds)
                    performed.append({"action": "fill_dialog", "path": str(filled),
                                      "confirm": confirm})
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
                produced = driver.screenshot(path)
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
        driver = self._driver_for(step)
        control = str(spec_mod.resolve(step["control"], ctx))
        expected = spec_mod.resolve(step.get("expect") or {}, ctx)
        try:
            value = driver.read(control)
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
        driver = self._driver_for(step)
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
                value = driver.read(control)
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

    def _step_restore_home(self, step: dict, job: Job, ctx: dict) -> dict:
        """关掉残留弹窗、结束残留对话框、回首页，并**验证真的回到了首页**。

        为什么需要这个步骤
        ------------------
        `tools/rpa_fixture.py` 里早就有 `restore_home(driver)`，但它只是一个 CLI 开关
        （`--restore-home`），流程里用不到 —— 于是每条流程各写各的收尾，
        而 `rpa-completion.md` §5.6 记录的事故正是「上一条流程没关弹窗会挡住下一条」。

        实现顺序（与 `rpa_fixture.restore_home` 完全一致，避免两套行为）：
        1. 判更新弹窗是否**真的可见**（关掉后节点仍在 DOM，只是尺寸为 0）；
        2. 可见就点 Close；
        3. 若页面里有 "New Connection" 就点 Cancel；
        4. 点 `a.homemenu-title` 回首页；
        5. 验证页面里出现 "My Applications"。

        驱动层的 ``restore_home()`` 优先；驱动没有这个能力时（UIA / assisted），
        退化为 ``open("manage")`` 并记 ``degraded: true``——不假装清过。
        """
        driver = self._driver_for(step)
        timeout = self._number(step, "timeout_s", 20.0, ctx)
        restore = getattr(driver, "restore_home", None)
        actions: list
        degraded = False
        if callable(restore):
            try:
                actions = list(restore(timeout_s=timeout) or [])
            except TypeError:
                actions = list(restore() or [])
            except Exception as exc:  # noqa: BLE001 —— 驱动各有自己的异常类型
                raise self._step_failure(exc, step) from exc
        else:
            degraded = True
            opener = getattr(driver, "open", None)
            if callable(opener):
                actions = [{"action": "open", "page": "manage",
                            "why": "驱动没有 restore_home"}]
                try:
                    opener("manage")
                except Exception as exc:  # noqa: BLE001
                    # 前置清理失败不该拦整条流程。理由：这一步的职责是「别让上一条
                    # 流程的残留挡住这一条」，不是本流程要验证的业务行为。环境里没有
                    # GUI 驱动时，让它以 environment 失败等于把「环境准备」算成
                    # 「业务失败」，而且会让所有不碰界面的回归测试连带失败。
                    #
                    # 但仍然如实记录：degraded=True + actions 里写明原因，不能假装清过。
                    actions = [{"action": "open-failed", "page": "manage",
                                "why": f"驱动没有 restore_home，open 也失败：{exc}"}]
                    self.store.audit(job, "restore_home.degraded", step=step["id"],
                                     reason=str(exc))
            else:
                # 第三层降级：驱动连导航能力都没有（例如只有 request/download 的
                # 脚本引擎，或者测试替身）。这是一个**前置清理**步骤，不是本流程
                # 要验证的行为——让整条流程因为「清不了残留」而失败，等于把
                # 环境准备失败算成业务失败，方向是错的。
                #
                # 记 skipped 而不是 succeeded：审计里要能看出这一步没真做，
                # 不能假装清过（rpa-completion.md §5.6 的教训是"不留痕=会重犯"）。
                actions = [{"action": "skipped",
                            "why": "驱动既没有 restore_home 也没有 open，无法清理残留"}]
                degraded = True
        self.store.audit(job, "restore_home.done", step=step["id"],
                         actions=actions, degraded=degraded)
        return {"actions": actions, "degraded": degraded, "driver": str(
            getattr(driver, "name", "?"))}

    def _step_ensure_display(self, step: dict, job: Job, ctx: dict) -> dict:
        """校验当前主屏分辨率等于期望值；不符就报 ``environment``，**绝不继续点**。

        为什么要有这一步
        ----------------
        §3 把几何固化做成三层，第一层（虚拟屏）由 `setup_display.ps1` 在外壳启动时
        完成。但如果那一步悄悄失败了（驱动没装、切不过去、有人手动改了分辨率），
        后面的坐标就全都失去意义——而且失败会表现成「点不中」，看起来像选择器坏了。

        这一步把那种情况提前转换成明确的 ``environment`` 错误，消息里带实际值与期望值。

        字段：``width`` / ``height``（必成对）、``refresh``（可选）、
        ``tolerance``（默认 0）、``allow_mismatch``（默认 false）。
        """
        want_w = step.get("width")
        want_h = step.get("height")
        if want_w is None and want_h is None:
            raise StepFailure("input", f"步骤 {step['id']} 的 ensure_display 没有给 width/height")
        want_w = int(want_w)
        want_h = int(want_h)
        tolerance = int(step.get("tolerance", 0) or 0)
        allow_mismatch = bool(step.get("allow_mismatch", False))
        want_refresh = step.get("refresh")
        want_refresh = int(want_refresh) if want_refresh is not None else None

        actual = _screen_mode()
        if actual is None:
            raise StepFailure(
                "environment",
                "读不到当前显示模式（可能没有活动桌面会话）",
                evidence={"expected": {"width": want_w, "height": want_h}})

        width = int(actual.get("width") or 0)
        height = int(actual.get("height") or 0)
        refresh = actual.get("refresh")
        problems: list[str] = []
        if abs(width - want_w) > tolerance:
            problems.append(f"宽 {width} ≠ {want_w}（容差 {tolerance}）")
        if abs(height - want_h) > tolerance:
            problems.append(f"高 {height} ≠ {want_h}（容差 {tolerance}）")
        if want_refresh is not None and refresh is not None and int(refresh) != want_refresh:
            problems.append(f"刷新率 {refresh} ≠ {want_refresh}")

        evidence = {
            "expected": {"width": want_w, "height": want_h, "refresh": want_refresh},
            "actual": actual,
            "problems": problems,
        }
        if problems:
            if allow_mismatch:
                job.warnings.append({
                    "class": "environment", "step": step["id"],
                    "message": "显示模式不符但 allow_mismatch=true：" + "；".join(problems),
                    "at": _utcnow(),
                })
                self.store.save(job)
                self.store.audit(job, "ensure_display.allowed", step=step["id"],
                                 problems=problems, actual=actual)
                return {"ok": False, "allowed": True, "actual": actual,
                        "problems": problems}
            raise StepFailure(
                "environment",
                "显示模式不符合几何固化要求：" + "；".join(problems)
                + "。先跑 tools/setup_display.ps1 把虚拟屏切到目标模式。",
                evidence=evidence)
        self.store.audit(job, "ensure_display.ok", step=step["id"], actual=actual)
        return {"ok": True, "allowed": False, "actual": actual, "problems": []}

    def _step_select_folder(self, step: dict, job: Job, ctx: dict) -> dict:
        """用 agent-desktop 操作原生「选择文件夹」对话框（全自动）。

        ## 为什么单独一个 kind

        Project Folder 的 Select 走 Electron IPC -> 主进程 dialog.showOpenDialog。
        实测（2026-11-24）所有纯 CDP 路径都不弹原生对话框：
          JS click / CDP dispatchMouseEvent -> 手势/模态问题，不弹
          真鼠标 SetCursorPos -> window.screenX=0,0 点错窗口
        agent-desktop 的 Windows accessibility 能看到 Electron 网页内容和原生
        对话框，按 ref 定位、--headed 发物理输入，正好绕开这两个问题。

        ## 前置

        - Graph 必须已在 Information 页（由前一步 fill_information 保证）
        - agent-desktop 已 npm install（默认在 AGENT_DESKTOP_DIR）
        - Windows 前台锁定时会 AttachThreadInput 强制把 Graph 提到前台

        失败一律 StepFailure("capability"/"dialog_unavailable")，
        不静默、不假装成功。
        """
        import importlib.util

        from . import spec as spec_mod

        app = str(spec_mod.resolve(step.get("app", "Graph"), ctx))
        raw_dir = spec_mod.resolve(step.get("project_dir"), ctx)
        if raw_is_none := (raw_dir is None):
            raise StepFailure("input", "select_folder 缺 project_dir")
        project_dir = str(raw_dir)
        timeout = self._number(step, "timeout_s", 20.0, ctx)

        # 按路径加载 tools/agent_desktop_driver.py（不用裸导入，打包安全）
        # runner.py 在 <repo>/src/fieldstation/workflows/，仓库根是 parents[3]。
        # 同时兼容从别的目录布局加载时按 gui_mod._ROOT 兜底。
        _candidates = [
            Path(__file__).resolve().parents[3] / "tools" / "agent_desktop_driver.py",
            Path(getattr(gui_mod, "_ROOT", ".")) / "tools" / "agent_desktop_driver.py",
        ]
        driver_path = next((p for p in _candidates if p.is_file()), _candidates[0])
        if not driver_path.is_file():
            raise StepFailure("capability",
                              "找不到 tools/agent_desktop_driver.py")
        sp = importlib.util.spec_from_file_location("_fsa_agent_desktop", driver_path)
        if sp is None or sp.loader is None:
            raise StepFailure("capability", "无法加载 agent_desktop_driver")
        mod = importlib.util.module_from_spec(sp)
        sys.modules["_fsa_agent_desktop"] = mod
        try:
            sp.loader.exec_module(mod)
        except Exception as exc:  # noqa: BLE001
            raise StepFailure("capability",
                              "agent_desktop_driver 加载失败：%s" % exc) from exc

        try:
            result = mod.select_folder(project_dir, app=app, timeout_s=timeout)
        except Exception as exc:  # noqa: BLE001
            raise StepFailure("dialog_unavailable",
                              "agent-desktop 选目录失败：%s" % exc) from exc

        if not result.get("ok"):
            raise StepFailure(
                "dialog_unavailable",
                "agent-desktop 选目录失败：%s（步骤：%s）"
                % (result.get("error"), result.get("steps")))

        self.store.audit(job, "select_folder.ok", step=step["id"],
                         project_dir=project_dir, steps=result.get("steps"))
        return {"ok": True, "project_dir": project_dir,
                "steps": result.get("steps", [])}

    def _step_select_file(self, step: dict, job: Job, ctx: dict) -> dict:
        """用 agent-desktop 操作原生「打开」对话框选文件（全自动）。

        与 select_folder 同构：CDP 弹不出 Electron 原生对话框，agent-desktop
        的 accessibility ref + --headed 物理输入可以。见 _step_select_folder。
        """
        import importlib.util

        from . import spec as spec_mod

        app = str(spec_mod.resolve(step.get("app", "Graph"), ctx))
        raw = spec_mod.resolve(step.get("file"), ctx)
        if raw is None:
            raise StepFailure("input", "select_file 缺 file")
        file_path = str(raw)
        timeout = self._number(step, "timeout_s", 20.0, ctx)

        driver_path = Path(__file__).resolve().parents[3] / "tools" / "agent_desktop_driver.py"
        if not driver_path.is_file():
            driver_path = Path(getattr(gui_mod, "_ROOT", ".")) / "tools" / "agent_desktop_driver.py"
        if not driver_path.is_file():
            raise StepFailure("capability", "找不到 tools/agent_desktop_driver.py")
        sp = importlib.util.spec_from_file_location("_fsa_agent_desktop_file", driver_path)
        if sp is None or sp.loader is None:
            raise StepFailure("capability", "无法加载 agent_desktop_driver")
        mod = importlib.util.module_from_spec(sp)
        sys.modules["_fsa_agent_desktop_file"] = mod
        try:
            sp.loader.exec_module(mod)
        except Exception as exc:  # noqa: BLE001
            raise StepFailure("capability", "agent_desktop_driver 加载失败：%s" % exc) from exc

        try:
            result = mod.select_file(file_path, app=app, timeout_s=timeout)
        except Exception as exc:  # noqa: BLE001
            raise StepFailure("dialog_unavailable",
                              "agent-desktop 选文件失败：%s" % exc) from exc
        if not result.get("ok"):
            raise StepFailure(
                "dialog_unavailable",
                "agent-desktop 选文件失败：%s（步骤：%s）"
                % (result.get("error"), result.get("steps")))

        self.store.audit(job, "select_file.ok", step=step["id"],
                         file=file_path, steps=result.get("steps"))
        return {"ok": True, "file": file_path, "steps": result.get("steps", [])}

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


def _allows_danger(locator: str) -> bool:
    """``target!:`` 前缀表示流程作者显式承认这是危险目标（只是打开对话框）。"""
    return str(locator).startswith("target!:")


def _real_mouse_click(driver, locator: str) -> dict:
    """点页面元素，确保**真的点到它**。

    三次踩坑记录（2026-11-18），每次都让结论完全跑偏：

      1. JS `element.click()`：DOM 上看着生效，但 Electron 的
         `dialog.showOpenDialog()` 要求真实用户手势，合成事件不算 -> 不弹窗。
      2. 直接用 Win32 `SetCursorPos` + 屏幕坐标：`window.screenX` 在无边框
         Electron 窗口里报 (0,0)，算出来的坐标落到了**别的窗口**
         （实测落在 OpenChamber 上，`WindowFromPoint` 抓到）。Graph 根本
         没收到点击。
      3. 窗口被遮住时，任何屏幕级点击都会打到遮挡者身上。

    所以这里按顺序做：
      a) 用 CDP `Input.dispatchMouseEvent` 按**视口坐标**派发（不经过 Win32，
         不受窗口位置与遮挡影响）；
      b) 再用 `WindowFromPoint` 自检目标坐标上是哪个窗口，若不是本应用，
         记录进返回值供审计（不静默）。
    """
    import time

    if locator.startswith("target:"):
        want = locator.split(":", 1)[1]
        finder = ("[...document.querySelectorAll('button,a,[role=button]')]"
                  ".find(e => (e.innerText||'').trim() === %s)" % _js_str(want))
    else:
        finder = "document.querySelector(%s)" % _js_str(locator)

    js = """(() => {
      const el = __FINDER__;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return {err: "元素尺寸为 0"};
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const self = hit === el || (hit && el.contains(hit));
      return {vx: cx, vy: cy, self: !!self,
              hitText: hit ? String(hit.innerText || '').trim().slice(0, 30) : ""};
    })()"""

    info = driver.evaluate(js.replace("__FINDER__", finder))
    if not info:
        raise StepFailure("selector_drift", "real_mouse 找不到元素：%s" % locator)
    if info.get("err"):
        raise StepFailure("selector_drift",
                          "real_mouse 目标不可点：%s（%s）" % (locator, info["err"]))
    if not info.get("self"):
        raise StepFailure(
            "selector_drift",
            "real_mouse 目标被遮挡：%s 中心处是 %r" % (locator, info.get("hitText")))

    vx, vy = float(info["vx"]), float(info["vy"])

    # a) 视口坐标派发：不依赖窗口在屏幕上的位置
    driver.call("Input.dispatchMouseEvent", {
        "type": "mouseMoved", "x": vx, "y": vy, "button": "none"})
    time.sleep(0.05)
    driver.call("Input.dispatchMouseEvent", {
        "type": "mousePressed", "x": vx, "y": vy,
        "button": "left", "clickCount": 1})
    time.sleep(0.06)
    driver.call("Input.dispatchMouseEvent", {
        "type": "mouseReleased", "x": vx, "y": vy,
        "button": "left", "clickCount": 1})

    # b) 自检：屏幕坐标上是不是本进程的窗口（只记录，不阻断）
    screen_hit = None
    try:
        import ctypes
        from ctypes import wintypes as _wt

        class _POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        user32 = ctypes.windll.user32
        try:
            user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            pass
        sx = int(driver.evaluate(
            "(() => Math.round(window.screenX + %f))()" % vx) or 0)
        sy = int(driver.evaluate(
            "(() => Math.round(window.screenY + %f))()" % vy) or 0)
        user32.WindowFromPoint.restype = _wt.HWND
        user32.WindowFromPoint.argtypes = [_POINT]
        h = user32.WindowFromPoint(_POINT(sx, sy))
        if h:
            root = user32.GetAncestor(h, 2) or h
            t = ctypes.create_unicode_buffer(200)
            user32.GetWindowTextW(root, t, 200)
            screen_hit = t.value.strip()
        else:
            screen_hit = ""
    except Exception:  # noqa: BLE001
        screen_hit = None

    return {"x": round(vx, 1), "y": round(vy, 1), "via": "cdp_mouse",
            "verified": True, "screen_would_hit": screen_hit}


def _js_str(v: str) -> str:
    import json
    return json.dumps(str(v), ensure_ascii=False)


def _screen_mode() -> dict | None:
    """读当前主屏的分辨率与刷新率。读不到返回 ``None``。

    实现优先级：
    1. 用户显式给的 ``FSA_SCREEN_MODE``（形如 ``1920x1080@60``）—— 测试与无人值守用；
    2. Windows 上走 ``ctypes`` 调 ``GetSystemMetrics``（分辨率）+
       ``EnumDisplaySettingsW``（刷新率）。

    为什么不用 ``Get-CimInstance``/PowerShell：这一步在每条流程开头跑，
    起一次 PowerShell 要 200~400ms，不值得；``ctypes`` 是标准库且一次调用几微秒。
    """
    import os

    override = (os.environ.get("FSA_SCREEN_MODE") or "").strip()
    if override:
        text = override.lower()
        refresh = None
        if "@" in text:
            text, _, tail = text.partition("@")
            try:
                refresh = int(tail)
            except ValueError:
                refresh = None
        if "x" in text:
            left, _, right = text.partition("x")
            try:
                return {"width": int(left), "height": int(right),
                        "refresh": refresh, "source": "FSA_SCREEN_MODE"}
            except ValueError:
                return None

    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:  # noqa: BLE001
        return None

    user32 = ctypes.windll.user32
    # 必须先把自己标成 DPI-aware，否则 GetSystemMetrics 返回的是「虚拟化后」的像素：
    # 本机 150% 缩放下 2560×1600 的屏会读成 1707×1067（实测比值 1.4997）。
    # 那条假数字曾经被当成「物理屏自己变了」的证据写进计划书，见 probe_dpi_screen.py。
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    except Exception:  # noqa: BLE001 —— Win10 1703 之前没有这个符号
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:  # noqa: BLE001
            pass
    width = int(user32.GetSystemMetrics(0))   # SM_CXSCREEN
    height = int(user32.GetSystemMetrics(1))  # SM_CYSCREEN
    refresh: int | None = None
    class DEVMODE(ctypes.Structure):
        _fields_ = [
            ("dmDeviceName", wintypes.WCHAR * 32),
            ("dmSpecVersion", wintypes.WORD),
            ("dmDriverVersion", wintypes.WORD),
            ("dmSize", wintypes.WORD),
            ("dmDriverExtra", wintypes.WORD),
            ("dmFields", wintypes.DWORD),
            ("dmPositionX", ctypes.c_int),
            ("dmPositionY", ctypes.c_int),
            ("dmDisplayOrientation", wintypes.DWORD),
            ("dmDisplayFixedOutput", wintypes.DWORD),
            ("dmColor", ctypes.c_short),
            ("dmDuplex", ctypes.c_short),
            ("dmYResolution", ctypes.c_short),
            ("dmTTOption", ctypes.c_short),
            ("dmCollate", ctypes.c_short),
            ("dmFormName", wintypes.WCHAR * 32),
            ("dmLogPixels", wintypes.WORD),
            ("dmBitsPerPel", wintypes.DWORD),
            ("dmPelsWidth", wintypes.DWORD),
            ("dmPelsHeight", wintypes.DWORD),
            ("dmDisplayFlags", wintypes.DWORD),
            ("dmDisplayFrequency", wintypes.DWORD),
            ("dmICMMethod", wintypes.DWORD),
            ("dmICMIntent", wintypes.DWORD),
            ("dmMediaType", wintypes.DWORD),
            ("dmDitherType", wintypes.DWORD),
            ("dmReserved1", wintypes.DWORD),
            ("dmReserved2", wintypes.DWORD),
            ("dmPanningWidth", wintypes.DWORD),
            ("dmPanningHeight", wintypes.DWORD),
        ]

    devmode = DEVMODE()
    devmode.dmSize = ctypes.sizeof(DEVMODE)
    ENUM_CURRENT_SETTINGS = -1
    # 读哪块屏：**虚拟屏优先**。
    #
    # 这是几何固化的内核。RPA 操作的是虚拟屏上的窗口，物理屏分辨率变化
    # （插拔、RDP、DPI）与坐标无关；而 `GetSystemMetrics(SM_CXSCREEN)` 返回的是
    # **主屏**，本机主屏是 2560×1600 的物理屏，虚拟屏是 1920×1080 —— 读主屏就会
    # 得到「期望 1920×1080，实际 2560×1600」，把明明正确的几何判成环境错。
    #
    # 找法：遍历 `EnumDisplayDevices`，取**已接桌面**且描述里带虚拟驱动关键词的
    # 那一个；找不到才退回主屏（并如实标注 source，让调用方知道退化过）。
    target = _virtual_display_device()
    if target is not None:
        if user32.EnumDisplaySettingsW(target, ENUM_CURRENT_SETTINGS,
                                       ctypes.byref(devmode)):
            if devmode.dmPelsWidth:
                width = int(devmode.dmPelsWidth)
            if devmode.dmPelsHeight:
                height = int(devmode.dmPelsHeight)
            if devmode.dmDisplayFrequency and devmode.dmDisplayFrequency != 1:
                refresh = int(devmode.dmDisplayFrequency)
        if width > 0 and height > 0:
            return {"width": width, "height": height, "refresh": refresh,
                    "source": f"virtual:{target}", "device": target}
    elif user32.EnumDisplaySettingsW(r"\\.\DISPLAY1", ENUM_CURRENT_SETTINGS,
                                     ctypes.byref(devmode)):
        # 没有虚拟屏时退回主屏。source 里写清楚，验收工具能看出这是退化值。
        if devmode.dmPelsWidth:
            width = int(devmode.dmPelsWidth)
        if devmode.dmPelsHeight:
            height = int(devmode.dmPelsHeight)
        if devmode.dmDisplayFrequency and devmode.dmDisplayFrequency != 1:
            refresh = int(devmode.dmDisplayFrequency)

    if width <= 0 or height <= 0:
        return None
    return {"width": width, "height": height, "refresh": refresh,
            "source": "GetSystemMetrics(aware)+EnumDisplaySettings(primary)"}


#: 虚拟显示驱动的名字特征。`\\.\DISPLAYnn` 的 DeviceString 里会有这些词。
_VIRTUAL_HINTS = ("virtual", "indirect", "idd", "vdd", "mtt", "parsec")


def _virtual_display_device() -> str | None:
    """返回**已接桌面**的虚拟屏设备名（``\\\\.\\DISPLAYnn``）；没有就 None。

    判据与 `tools/ensure_virtual_display.py` 一致：`DISPLAY_DEVICE_ATTACHED_TO_DESKTOP`
    且描述命中文档里的虚拟驱动关键词。未接桌面的虚拟屏不算 —— 它没有桌面坐标。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:  # noqa: BLE001
        return None

    user32 = ctypes.windll.user32
    ATTACHED = 0x00000001

    class DISPLAY_DEVICEW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("DeviceName", wintypes.WCHAR * 32),
            ("DeviceString", wintypes.WCHAR * 128),
            ("StateFlags", wintypes.DWORD),
            ("DeviceID", wintypes.WCHAR * 128),
            ("DeviceKey", wintypes.WCHAR * 128),
        ]

    index = 0
    while True:
        dd = DISPLAY_DEVICEW()
        dd.cb = ctypes.sizeof(DISPLAY_DEVICEW)
        if not user32.EnumDisplayDevicesW(None, index, ctypes.byref(dd), 0):
            break
        index += 1
        if not (dd.StateFlags & ATTACHED):
            continue
        desc = str(devicesafe_description(dd))
        if any(hint in desc.lower() for hint in _VIRTUAL_HINTS):
            return str(dd.DeviceName)
    return None


def devicesafe_description(dd) -> str:
    """``DISPLAY_DEVICEW.DeviceString`` 的安全读取（某些设备返回空串）。"""
    try:
        return str(dd.DeviceString) or ""
    except Exception:  # noqa: BLE001
        return ""


def _click_escalating(driver, locator: str, css: str, *, allow_danger: bool) -> dict:
    """在驱动层找 ``ClickEngine`` 并调用三级升级翻点。

    为什么放在 runner 而不是驱动协议里：``GuiDriver`` 只需要 ``click()`` 这一个原语，
    升级链是 **CDP 通道特有的增强**（UIA/assisted 没有这个概念）。所以这里做能力探测：
    驱动能提供 ``escalating_click`` 就用，否则退化为普通 ``click`` 并把原因记下来。
    """
    engine_factory = getattr(driver, "escalating_click", None)
    if callable(engine_factory):
        return engine_factory(locator, css=css, allow_danger=allow_danger)
    # 驱动不支持升级（UIA / assisted / scripted）：按普通 click 走，行为不变
    driver.click(locator)
    return {"escalation": "driver-click", "locator": locator}


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
