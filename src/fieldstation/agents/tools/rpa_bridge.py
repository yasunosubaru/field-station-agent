"""``tools/workflow_cli.py`` 的 Python 侧桥（Agent 桌面版 WP5）。

Agent 要执行原版 GUI 的固定流程，不能自己点、也不能自己拼 HTTP：所有语义都在
``fieldstation.workflows`` 里，命令行是它与 Agent 之间最小的公共面。本模块只
负责调用它、解析 ``--json``、把退出码翻译成 ``ToolResult``。

## 为什么按「退出码 + JSON」两路判成败

CLI 的退出码是**状态**，不是**命令成败**（见 ``tools/workflow_cli.py`` 文件头）：

* ``0`` 成功；``1`` 失败（job 进了非 succeeded 终态）；``2`` 用法错误；
* ``3`` 停在闸门（``waiting_approval`` / ``waiting_operator``）——**不是失败**，
  上层要发审批卡或人工任务卡。

所以本模块同时读退出码和 stdout 里的 job 视图：``3`` 一律当「等待」，不做成
error；``1`` 若视图里写明了状态，就把 ``status`` 与 ``failure.message`` 折进
``error``，让模型知道是哪一步、哪一类失败。

## 三个不能省的做法

* ``shell=False`` 的列表参数：参数由模型给，进 shell 就是一条命令注入通道。
* ``cwd`` 固定仓库根、``PYTHONPATH`` 指到 ``src``：CLI 自己也会插路径，但只
  依赖它自己的兜底，换个工作目录就会莫名其妙地 import 失败。
* 超时返回 ``error="timeout"``：600 秒还没回，继续等只会把整个对话挂住。

本模块只用标准库。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from . import ToolResult

__all__ = [
    "RpaBridge",
    "WorkflowArtifactsTool",
    "WorkflowCancelTool",
    "WorkflowDescribeTool",
    "WorkflowGateTool",
    "WorkflowListTool",
    "WorkflowResumeTool",
    "WorkflowRunTool",
    "WorkflowStatusTool",
    "build_rpa_tools",
    "build_tools",
]

#: CLI 的退出码（与 ``tools/workflow_cli.py`` 的常量一致）。
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_WAITING = 3

#: 停在闸门的两个状态：**不是失败**，等审批或等人工做完。
WAITING_STATUSES = ("waiting_approval", "waiting_operator")

#: 还在跑的 job 也不是失败：``status`` 命令可能撞上另一路正在执行的 job。
RUNNING_STATUSES = ("running",)

GATE_DECISIONS = ("approved", "rejected")
RESUME_DECISIONS = ("done", "failed")

#: 错误信息上限：CLI 的 traceback 或引擎响应可能有几十 KB，全塞进会话事件里
#: 前端会卡、审计也不好读。只要够定位就够。
_ERROR_CHARS = 600


def _tail(text: str | None, limit: int = _ERROR_CHARS) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return "…" + text[-limit:]


def extract_json(text: str | None):
    """从 CLI 输出里取最后一个 JSON 文档；取不到返回 ``None``。

    ``--json`` 的输出是 ``json.dumps(indent=2)`` 的**多行**文档，不是一行——只解
    最后一行会永远拿到 ``}``。这里先整段试一次（单行输出），再自下而上找以
    ``{`` / ``[`` 开头的行，把从那里到末尾当作候选。
    """
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    lines = text.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        head = lines[index].lstrip()
        if not head.startswith(("{", "[")):
            continue
        try:
            return json.loads("\n".join(lines[index:]))
        except ValueError:
            continue
    return None


class RpaBridge:
    """``workflow_cli.py`` 的进程内封装。每个方法返回 ``ToolResult``，不抛。"""

    def __init__(self, repo: str | Path, python: str | Path | None = None,
                 timeout_s: float = 600, *,
                 jobs_root: str | Path | None = None,
                 engine: str | None = None,
                 driver: str | None = None) -> None:
        self.repo = Path(repo).resolve()
        self.script = self.repo / "tools" / "workflow_cli.py"
        if not self.script.is_file():
            raise ValueError(
                f"找不到 {self.script}——repo 必须是仓库根（含 tools/workflow_cli.py）")
        self.python = str(python) if python else sys.executable
        self.timeout_s = float(timeout_s)
        self.jobs_root = str(Path(jobs_root).resolve()) if jobs_root else None
        self.engine = engine
        self.driver = driver

    # -------------------------------------------------------------- 进程
    def _argv(self, *args: str) -> list[str]:
        argv = [self.python, str(self.script), *args, "--json"]
        if self.jobs_root:
            argv += ["--jobs-root", self.jobs_root]
        if self.engine:
            argv += ["--engine", self.engine]
        if self.driver:
            argv += ["--driver", self.driver]
        return argv

    def _env(self) -> dict:
        env = dict(os.environ)
        src = str(self.repo / "src")
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = src + (os.pathsep + existing if existing else "")
        # 子进程输出按 UTF-8 编码，父进程才能稳定解码：Windows 默认是 cp936，
        # 一旦 CLI 打印中文（它几乎总会），不设这个就会拿到乱码或替换字符。
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        if self.jobs_root:
            env.setdefault("NAS_WORKFLOW_JOBS", self.jobs_root)
        return env

    def _run(self, *args: str) -> tuple[int, str, str]:
        """跑一条 CLI 命令，返回 ``(exit_code, stdout, stderr)``；超时抛 ``TimeoutError``。"""
        argv = self._argv(*args)
        try:
            proc = subprocess.run(
                argv, cwd=str(self.repo), env=self._env(),
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=self.timeout_s, shell=False)
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("timeout") from exc
        return proc.returncode, proc.stdout or "", proc.stderr or ""

    # ------------------------------------------------------------ 结果映射
    def _call(self, label: str, *args: str):
        """跑一条命令并解析；超时返回 ``code=None``，由结果映射统一折成 timeout。"""
        try:
            code, out, err = self._run(*args)
        except TimeoutError:
            return None, None, "", "", label
        return code, extract_json(out), out, err, label

    @staticmethod
    def _plain_result(label: str, code: int | None, view, out: str,
                      err: str) -> ToolResult:
        """非 job 命令（list / describe / artifacts）：退出码 0 就是成功。"""
        if code is None:
            return ToolResult(ok=False, error="timeout")
        if code == EXIT_OK:
            if isinstance(view, list):
                return ToolResult(ok=True, data={
                    "items": view, "count": len(view), "exit_code": code})
            if isinstance(view, dict):
                return ToolResult(ok=True, data={**view, "exit_code": code})
            return ToolResult(ok=True, data={"exit_code": code, "output": _tail(out)})
        detail = _tail(err) or _tail(out) or f"退出码 {code}"
        return ToolResult(ok=False, error=f"{label}: {detail}")

    @staticmethod
    def _job_result(label: str, code: int | None, view, out: str, err: str,
                    accept: tuple[str, ...] = ()) -> ToolResult:
        """job 类命令：成功 / 等待闸门 / 失败三种。``accept`` 是本命令下算成功的终态。"""
        if code is None:
            return ToolResult(ok=False, error="timeout")
        if isinstance(view, list) and code == EXIT_OK:
            return ToolResult(ok=True, data={
                "items": view, "count": len(view), "exit_code": code})
        status = ""
        if isinstance(view, dict):
            status = str(view.get("status") or "")
            if (status == "succeeded" or status in WAITING_STATUSES
                    or status in RUNNING_STATUSES or status in accept):
                return ToolResult(ok=True, data={
                    **view,
                    "exit_code": code,
                    "waiting": status in WAITING_STATUSES,
                })
        if code == EXIT_WAITING:
            # 视图没解出来但退出码说停在闸门：按契约「不失败」处理，让人看原始输出。
            return ToolResult(ok=True, data={
                "exit_code": code, "waiting": True, "output": _tail(out)})

        detail = ""
        if isinstance(view, dict) and status:
            job_id = str(view.get("job_id") or "").strip()
            detail = f"job {job_id} status={status}" if job_id else f"status={status}"
            failure = view.get("failure")
            if isinstance(failure, dict) and failure.get("message"):
                detail += (f"（{failure.get('class') or '失败'}: "
                           f"{failure['message']}）")
        if not detail:
            detail = _tail(err) or _tail(out) or f"退出码 {code}"
        return ToolResult(ok=False, error=f"{label}: {detail}")

    # -------------------------------------------------------------- 目录
    def list(self, intent: str | None = None) -> ToolResult:
        """列出工作流；``intent`` 可按 intent / id / tag 过滤。"""
        args = ["list"]
        if isinstance(intent, str) and intent.strip():
            args += ["--intent", intent.strip()]
        elif intent is not None and not isinstance(intent, str):
            return ToolResult(ok=False, error="workflow_list: 参数 intent 必须是字符串")
        code, view, out, err, label = self._call("workflow_list", *args)
        if code == EXIT_OK and isinstance(view, list):
            return ToolResult(ok=True, data={
                "workflows": view, "count": len(view), "exit_code": code})
        return self._plain_result(label, code, view, out, err)

    def describe(self, workflow: str) -> ToolResult:
        """一份工作流的完整定义（步骤、参数、审批门、风险）。"""
        if not isinstance(workflow, str) or not workflow.strip():
            return ToolResult(ok=False,
                              error="workflow_describe: 参数 workflow 必填")
        code, view, out, err, label = self._call(
            "workflow_describe", "describe", workflow.strip())
        return self._plain_result(label, code, view, out, err)

    # -------------------------------------------------------------- 运行
    def run(self, workflow: str, params: dict | None = None, *,
            idempotency_key: str | None = None,
            allow_concurrent: bool = False,
            force_lock: bool = False) -> ToolResult:
        """新建并运行一个 job。停在闸门时 ``ok=True`` 且 ``data["waiting"]=True``。"""
        if not isinstance(workflow, str) or not workflow.strip():
            return ToolResult(ok=False, error="workflow_run: 参数 workflow 必填")
        if params is not None and not isinstance(params, dict):
            return ToolResult(ok=False,
                              error="workflow_run: 参数 params 必须是 JSON object")
        args = ["run", workflow.strip()]
        if params:
            try:
                payload = json.dumps(params, ensure_ascii=False)
            except (TypeError, ValueError) as exc:
                return ToolResult(ok=False,
                                  error=f"workflow_run: params 不能序列化：{exc}")
            args += ["--params-json", payload]
        if idempotency_key:
            args += ["--idempotency-key", str(idempotency_key)]
        if allow_concurrent:
            args.append("--allow-concurrent")
        if force_lock:
            args.append("--force-lock")
        code, view, out, err, label = self._call("workflow_run", *args)
        return self._job_result(label, code, view, out, err)

    def status(self, job_id: str) -> ToolResult:
        """一个 job 的状态（含下一步建议与审计尾部）。"""
        check = self._job_id("workflow_status", job_id)
        if isinstance(check, ToolResult):
            return check
        code, view, out, err, label = self._call("workflow_status", "status", check)
        return self._job_result(label, code, view, out, err)

    # -------------------------------------------------------------- 闸门
    def gate(self, job_id: str, decision: str, *, by: str = "operator",
             note: str = "") -> ToolResult:
        """审批门。**只接受 approved / rejected**：批准等于放行不可逆动作。"""
        check = self._job_id("workflow_gate", job_id)
        if isinstance(check, ToolResult):
            return check
        if decision not in GATE_DECISIONS:
            return ToolResult(
                ok=False,
                error=("workflow_gate: decision 只能是 approved / rejected，"
                       f"收到 {decision!r}"))
        code, view, out, err, label = self._call(
            "workflow_gate", "gate", check, "--decision", decision,
            "--by", by or "operator", "--note", note or "")
        # 拒绝是人的正常选择：job 变成 cancelled 是预期结果，不是命令失败。
        return self._job_result(label, code, view, out, err,
                                accept=("cancelled", "failed"))

    def resume(self, job_id: str, decision: str, *, by: str = "operator",
               note: str = "") -> ToolResult:
        """人工任务完成后继续。**只接受 done / failed**。"""
        check = self._job_id("workflow_resume", job_id)
        if isinstance(check, ToolResult):
            return check
        if decision not in RESUME_DECISIONS:
            return ToolResult(
                ok=False,
                error=("workflow_resume: decision 只能是 done / failed，"
                       f"收到 {decision!r}"))
        code, view, out, err, label = self._call(
            "workflow_resume", "resume", check, "--decision", decision,
            "--by", by or "operator", "--note", note or "")
        # 人判定 failed 也是决定被接受；job 失败由状态如实反映。
        return self._job_result(label, code, view, out, err, accept=("failed",))

    def cancel(self, job_id: str, *, reason: str = "cancelled",
               by: str = "operator") -> ToolResult:
        """取消一个还没结束的 job。"""
        check = self._job_id("workflow_cancel", job_id)
        if isinstance(check, ToolResult):
            return check
        code, view, out, err, label = self._call(
            "workflow_cancel", "cancel", check, "--reason", reason or "cancelled",
            "--by", by or "operator")
        return self._job_result(label, code, view, out, err, accept=("cancelled",))

    def artifacts(self, job_id: str, out: str | None = None) -> ToolResult:
        """列出 job 的证据文件；给 ``out`` 时再复制一份到该目录。"""
        check = self._job_id("workflow_artifacts", job_id)
        if isinstance(check, ToolResult):
            return check
        args = ["artifacts", check]
        if out:
            args += ["--out", str(out)]
        code, view, out_text, err, label = self._call("workflow_artifacts", *args)
        result = self._plain_result(label, code, view, out_text, err)
        if result.ok and isinstance(view, list):
            result.data = {"artifacts": view, "count": len(view),
                           "exit_code": code}
        return result

    @staticmethod
    def _job_id(label: str, job_id: str) -> str | ToolResult:
        if not isinstance(job_id, str) or not job_id.strip():
            return ToolResult(ok=False, error=f"{label}: 参数 job_id 必填")
        return job_id.strip()


# ====================================================================== 工具


class WorkflowListTool:
    name = "workflow_list"
    description = (
        "列出可用工作流（id、标题、风险、是否需要审批门、参数）。"
        "要跑流程前先看这里，别猜工作流 id。只读。")
    params = {
        "intent": {"type": "string", "required": False,
                   "description": "按 intent / id / tag 过滤，例如 graph 或 device"},
    }
    risk = "low"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.list(intent=args.get("intent"))


class WorkflowDescribeTool:
    name = "workflow_describe"
    description = (
        "一份工作流的完整定义：步骤、必填参数、审批门位置、风险与失败分类。"
        "运行前用它确认参数名与类型。只读。")
    params = {
        "workflow": {"type": "string", "required": True,
                     "description": "工作流 id，例如 gui.graph.export"},
    }
    risk = "low"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.describe(args.get("workflow"))


class WorkflowRunTool:
    name = "workflow_run"
    description = (
        "新建并运行一个 job。参数由 workflow_describe 给出。返回 status："
        "succeeded / failed / waiting_approval / waiting_operator。"
        "waiting_approval 时必须发审批卡，不得自行 gate；waiting_operator 时"
        "给出人工任务说明。会驱动原版 GUI，属有副作用动作。")
    params = {
        "workflow": {"type": "string", "required": True,
                     "description": "工作流 id，例如 gui.graph.export"},
        "params": {"type": "object", "required": False,
                   "description": "参数对象，键与类型按 workflow_describe 的 params"},
        "idempotency_key": {"type": "string", "required": False,
                            "description": "幂等键；命中运行中/成功的 job 时直接复用"},
        "allow_concurrent": {"type": "boolean", "required": False,
                             "description": "同一条流程已有未结束 job 时是否允许再开一个"},
        "force_lock": {"type": "boolean", "required": False,
                       "description": "强制拿过期的锁"},
    }
    #: 静态默认值取 medium：真风险要看流程本身（risk_for），拿不到就按更严的处理。
    risk = "medium"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def risk_for(self, args: dict) -> str:
        """按流程定义给真实 risk；查不到就退回 ``high``（宁严不松）。

        ``Tool`` 协议只暴露静态 ``risk``，所以支持动态风险的调用方（审批门）应当
        优先用这个方法；不支持的调用方拿到的是保守的 ``medium``，而流程自带的
        审批门仍会把它停在 waiting_approval，不会静默放行不可逆动作。
        """
        workflow = (args or {}).get("workflow")
        if not isinstance(workflow, str) or not workflow.strip():
            return "high"
        described = self.bridge.describe(workflow)
        if not described.ok:
            return "high"
        risk = str(described.data.get("risk") or "").strip().lower()
        return risk if risk in ("low", "medium", "high") else "high"

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.run(
            args.get("workflow"), args.get("params"),
            idempotency_key=args.get("idempotency_key"),
            allow_concurrent=bool(args.get("allow_concurrent", False)),
            force_lock=bool(args.get("force_lock", False)))


class WorkflowStatusTool:
    name = "workflow_status"
    description = (
        "查一个 job 的状态、当前步骤、失败原因与下一步建议。只读；"
        "不要在 waiting 状态下反复轮询——那是浪费，等审批或人工任务。")
    params = {
        "job_id": {"type": "string", "required": True,
                   "description": "workflow_run 返回的 job_id"},
    }
    risk = "low"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.status(args.get("job_id"))


class WorkflowGateTool:
    name = "workflow_gate"
    description = (
        "审批门：对停在 waiting_approval 的 job 给出 approved / rejected。"
        "**批准等于放行不可逆动作**（重启、断电、固件升级、写设备配置）。"
        "只能由用户的明确决定触发，不得由模型自行批准。")
    params = {
        "job_id": {"type": "string", "required": True,
                   "description": "停在 waiting_approval 的 job_id"},
        "decision": {"type": "string", "required": True,
                     "enum": ["approved", "rejected"],
                     "description": "approved 放行 / rejected 取消"},
        "by": {"type": "string", "required": False,
               "description": "决定人；默认 operator"},
        "note": {"type": "string", "required": False,
                 "description": "理由或现场说明，写入审计"},
    }
    risk = "high"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.gate(
            args.get("job_id"), args.get("decision"),
            by=args.get("by", "operator"), note=args.get("note", ""))


class WorkflowResumeTool:
    name = "workflow_resume"
    description = (
        "人工任务完成后继续：done 表示人已经做完，failed 表示人报告做不了。"
        "只对 waiting_operator 的 job 有效；不得用它代替审批。")
    params = {
        "job_id": {"type": "string", "required": True,
                   "description": "停在 waiting_operator 的 job_id"},
        "decision": {"type": "string", "required": True,
                     "enum": ["done", "failed"],
                     "description": "done 继续 / failed 终止并记为失败"},
        "by": {"type": "string", "required": False,
               "description": "执行人；默认 operator"},
        "note": {"type": "string", "required": False,
                 "description": "现场说明，写入审计"},
    }
    risk = "medium"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.resume(
            args.get("job_id"), args.get("decision"),
            by=args.get("by", "operator"), note=args.get("note", ""))


class WorkflowCancelTool:
    name = "workflow_cancel"
    description = (
        "取消一个还没结束的 job（含停在闸门的）。取消不撤销已发生的设备动作，"
        "只是让流程不再往下走。")
    params = {
        "job_id": {"type": "string", "required": True,
                   "description": "要取消的 job_id"},
        "reason": {"type": "string", "required": False,
                   "description": "取消原因，写入审计；默认 cancelled"},
        "by": {"type": "string", "required": False,
               "description": "操作人；默认 operator"},
    }
    risk = "medium"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.cancel(
            args.get("job_id"), reason=args.get("reason", "cancelled"),
            by=args.get("by", "operator"))


class WorkflowArtifactsTool:
    name = "workflow_artifacts"
    description = (
        "列出一个 job 的证据文件（路径、类型、sha256、来源步骤）。只读；"
        "引用产物时用这里的 sha256，不要口头描述文件内容。")
    params = {
        "job_id": {"type": "string", "required": True,
                   "description": "job_id"},
        "out": {"type": "string", "required": False,
                "description": "可选：把这些文件复制到该目录"},
    }
    risk = "low"

    def __init__(self, bridge: RpaBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.artifacts(args.get("job_id"), out=args.get("out"))


def build_rpa_tools(bridge: RpaBridge) -> list:
    """按契约 §5 的 rpa 清单建工具；顺序即模型看到的顺序（读在前、写在后）。"""
    return [
        WorkflowListTool(bridge),
        WorkflowDescribeTool(bridge),
        WorkflowStatusTool(bridge),
        WorkflowArtifactsTool(bridge),
        WorkflowRunTool(bridge),
        WorkflowResumeTool(bridge),
        WorkflowCancelTool(bridge),
        WorkflowGateTool(bridge),
    ]


def build_tools(*, repo_root: str | Path | None = None,
                data_dir: str | Path | None = None,
                jobs_root: str | Path | None = None,
                python: str | Path | None = None,
                engine: str | None = None,
                driver: str | None = None,
                timeout_s: float = 600,
                **context) -> list:
    """按 orchestrator 的上下文建 rpa 工具（它按签名过滤 kwargs，认这个名字）。

    ``jobs_root`` 缺省取 ``<data_dir>/jobs``（契约 §6：job 落在应用数据目录，不落
    仓库）。仓库根缺省取本文件向上四级。``context`` 里剩下的键（``node_url`` /
    ``token`` / ``artifacts_dir`` / ``session_id`` 等）用不上，直接忽略。
    """
    repo = Path(repo_root) if repo_root else Path(__file__).resolve().parents[4]
    jobs = jobs_root
    if jobs is None and data_dir:
        jobs = Path(data_dir) / "jobs"
    bridge = RpaBridge(repo, python, timeout_s, jobs_root=jobs,
                       engine=engine, driver=driver)
    return build_rpa_tools(bridge)
