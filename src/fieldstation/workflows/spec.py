"""spec —— 工作流规格的加载、校验与参数解析。

规格是**数据**（``workflows/<id>.yaml``），执行器只认这里列出的步骤种类。认不出的
字段、拼错的键、缺失的必填项都在**加载时**报错，而不是运行到一半才发现——固定流程
的价值就在于每一步都是事先定死的。

安全不变量（加载时强制，不靠执行器自觉）
----------------------------------------
* 任何 ``RESET`` / ``FRESET`` 命令所在的流程，``approval.required`` 必须为 ``true``。
  这条约束不是文档建议：它写在 :func:`_check_irreversible_approval` 里，违反就加载失败。
* 产物文件名只能是**裸文件名**（不能带目录分隔符），不允许用 ``../`` 写到 jobs 目录外。
* ``on_fail`` 只有 ``stop`` 与 ``continue`` 两种；没有 ``retry``。不可逆动作不自动重试。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import yaml_lite

__all__ = [
    "FAILURE_CLASSES",
    "KNOWN_FAILURE_CLASSES",
    "LEGACY_FAILURE_CLASSES",
    "RISK_LEVELS",
    "STEP_KINDS",
    "Workflow",
    "WorkflowSpecError",
    "load_all",
    "load_spec",
    "resolve",
    "resolve_params",
    "validate_params",
]

#: 失败分类（八类）。:func:`fieldstation.workflows.errors.classify_failure` 只返回这批值；
#: job 记录里的 ``failure.class`` 以它为准，同时仍可能出现历史的 ``artifact`` /
#: ``capability``（见 :data:`LEGACY_FAILURE_CLASSES`）。每类直接对应「下一步该谁动」：
#: 换环境 / 改参数 / 修选择器 / 叫人批 / 插设备。
FAILURE_CLASSES = (
    "environment",        # 引擎连不上、套件没开、没有驱动
    "input",              # 参数/规格不合法，改参数重跑
    "execution",          # 动作执行了但没效果，或未预期异常
    "policy",             # 审批被拒、危险动作被策略挡下
    "selector_drift",     # 找不到目标 / 不唯一 / 坐标漂移——界面文案变了
    "dialog_unavailable", # 该出现的对话框/弹窗不在
    "gate_timeout",       # 条件等待（wait_ui / 闸门）超时
    "hardware_missing",   # 设备/接收机/串口根本没接
)

#: 历史类别。引擎层仍在产出它们（``artifact`` 下载/产物、``capability`` 403 与
#: 「有驱动但不该由驱动做」），所以加载校验仍接受，但不作为新分类器的输出。
LEGACY_FAILURE_CLASSES = ("artifact", "capability")

#: 规格里 ``failure.classes`` 允许声明、``StepFailure`` 允许携带的全部类别。
KNOWN_FAILURE_CLASSES = FAILURE_CLASSES + LEGACY_FAILURE_CLASSES

RISK_LEVELS = ("low", "medium", "high")

#: 每种步骤允许的字段。``COMMON_STEP_FIELDS`` 对所有步骤都成立。
COMMON_STEP_FIELDS = frozenset({"id", "kind", "description", "on_fail", "save_as"})

STEP_FIELDS: dict[str, frozenset[str]] = {
    "http": frozenset({"method", "path", "query", "json", "expect_status", "expect", "headers", "timeout_s"}),
    "download": frozenset({"path", "query", "filename", "magic", "min_bytes", "expect_header", "timeout_s"}),
    "live_command": frozenset({"line", "await_reply", "reply_status_any_of", "timeout_s"}),
    "ensure_live": frozenset({"target"}),
    "await_receiver": frozenset({
        "wait_for", "model", "software", "after_cursor", "timeout_s", "poll_s",
        "reconnect", "drop_grace_s", "send_after_reconnect",
    }),
    "mark_cursor": frozenset(),
    "file_digest": frozenset({"path"}),
    "gui": frozenset({"action", "actions", "page", "locator", "value", "option", "screenshot", "assisted", "port"}),
    "verify_ui": frozenset({"control", "expect", "assisted", "port"}),
    "wait_ui": frozenset({
        "control", "expect", "timeout", "timeout_s", "poll_ms", "assisted", "port",
    }),
    "human_gate": frozenset({"reason", "prompt", "risk"}),
    "assert": frozenset({"checks"}),
    "artifact": frozenset({"name", "content", "format"}),
    "sleep": frozenset({"seconds"}),
}

STEP_KINDS = tuple(STEP_FIELDS)
#: ``click_optional`` = 「有就点，没有就算」：只用于关闭残留弹窗这类可空操作，
#: 绝不能用来做真正的步骤（真正的点击必须失败可见）。
GUI_ACTIONS = ("open", "click", "click_optional", "type", "select", "read", "sequence")

_WORKFLOW_FIELDS = frozenset({
    "id", "version", "title", "summary", "intent", "risk", "tags", "requires",
    "params", "approval", "steps", "artifacts", "failure", "docs", "since",
    "oem729_notes", "extends",
})
_PARAM_FIELDS = frozenset({"type", "required", "default", "enum", "pattern", "description", "example"})
_PARAM_TYPES = ("string", "integer", "number", "boolean", "path")
_APPROVAL_FIELDS = frozenset({"required", "reason", "risk", "by"})
_FAILURE_FIELDS = frozenset({"screenshot", "classes", "note"})
_ARTIFACT_FIELDS = frozenset({"name", "kind", "description", "required"})
_ASSISTED_FIELDS = frozenset({"enabled", "prompt"})
_GUI_ACTION_FIELDS = ("action", "page", "locator", "value", "option")

_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$")
_STEP_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_IRREVERSIBLE = re.compile(r"^\s*(?:RESET|FRESET\b)", re.IGNORECASE)

_MISSING = object()
_TEMPLATE_RE = re.compile(r"\$\{([^}]+)\}")


class WorkflowSpecError(ValueError):
    """规格不合法。``errors`` 是全部问题（一次报完，不让人挤牙膏式地修）。"""

    def __init__(self, source: str, errors: list[str]) -> None:
        self.source = source
        self.errors = list(errors)
        joined = "\n".join(f"  - {e}" for e in self.errors)
        super().__init__(f"{source} 规格不合法：\n{joined}")


@dataclass(frozen=True)
class Workflow:
    """一份通过校验的规格。``raw`` 保留原样，供 ``describe_workflow`` 直接返回。"""

    id: str
    version: int
    title: str
    intent: str
    risk: str
    summary: str
    tags: tuple[str, ...]
    requires: dict
    params: dict[str, dict]
    approval: dict
    steps: tuple[dict, ...]
    artifacts: tuple[dict, ...]
    failure: dict
    docs: tuple[str, ...]
    path: Path
    raw: dict = field(repr=False)

    @property
    def step_count(self) -> int:
        return len(self.steps)

    def step(self, index: int) -> dict:
        return self.steps[index]

    def step_ids(self) -> list[str]:
        return [s["id"] for s in self.steps]

    def summary_dict(self) -> dict:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "summary": self.summary,
            "intent": self.intent,
            "risk": self.risk,
            "tags": list(self.tags),
            "params": {
                name: {
                    "type": spec.get("type", "string"),
                    "required": bool(spec.get("required", False)),
                    "default": spec.get("default"),
                    "description": spec.get("description", ""),
                }
                for name, spec in self.params.items()
            },
            "approval": dict(self.approval),
            "steps": self.step_count,
            "artifacts": [a["name"] for a in self.artifacts],
            "path": str(self.path),
        }

    def full_dict(self) -> dict:
        out = dict(self.raw)
        out["path"] = str(self.path)
        out["step_kinds"] = [s["kind"] for s in self.steps]
        return out


# --------------------------------------------------------------------------- 加载
def load_spec(path: str | Path) -> Workflow:
    p = Path(path)
    try:
        raw = yaml_lite.load(p)
    except yaml_lite.YamlError as exc:
        raise WorkflowSpecError(str(p), [f"YAML 解析失败：{exc}"]) from exc
    return build_spec(raw, source=str(p), path=p)


def load_all(root: str | Path) -> list[Workflow]:
    """加载目录下所有 ``*.yaml``，按 id 排序；重复 id 视为错误。"""
    base = Path(root)
    if not base.is_dir():
        raise WorkflowSpecError(str(base), ["工作流目录不存在"])
    workflows: list[Workflow] = []
    seen: dict[str, str] = {}
    for path in sorted(base.glob("*.yaml")):
        wf = load_spec(path)
        if wf.id in seen:
            raise WorkflowSpecError(str(path), [
                f"重复的工作流 id {wf.id!r}（另一份在 {seen[wf.id]}）"])
        seen[wf.id] = str(path)
        workflows.append(wf)
    workflows.sort(key=lambda w: (w.intent, w.id))
    return workflows


def build_spec(raw: object, source: str = "<memory>", path: Path | None = None) -> Workflow:
    errors: list[str] = []
    if not isinstance(raw, dict):
        raise WorkflowSpecError(source, ["顶层必须是映射（key: value）"])

    unknown = sorted(set(raw) - _WORKFLOW_FIELDS)
    if unknown:
        errors.append(f"未知的顶层字段：{', '.join(unknown)}")

    wf_id = raw.get("id")
    if not isinstance(wf_id, str) or not _ID_RE.match(wf_id):
        errors.append("id 必须形如 `domain.action`（小写字母/数字，点分隔，至少两段）")

    version = raw.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        errors.append("version 必须是 >= 1 的整数")

    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append("title 不能为空")

    intent = raw.get("intent")
    if not isinstance(intent, str) or not _ID_RE.match(intent):
        errors.append("intent 必须形如 `domain.action`")

    risk = raw.get("risk", "low")
    if risk not in RISK_LEVELS:
        errors.append(f"risk 必须是 {RISK_LEVELS} 之一")

    tags_raw = raw.get("tags", [])
    if not isinstance(tags_raw, list) or any(not isinstance(t, str) for t in tags_raw):
        errors.append("tags 必须是字符串列表")
        tags: tuple[str, ...] = ()
    else:
        tags = tuple(tags_raw)

    requires = _check_requires(raw.get("requires", {}), errors)
    params = _check_params(raw.get("params", {}), errors)
    approval = _check_approval(raw.get("approval", {}), errors)
    steps = _check_steps(raw.get("steps"), errors)
    artifacts = _check_artifacts(raw.get("artifacts", []), errors)
    failure = _check_failure(raw.get("failure", {}), errors)

    docs_raw = raw.get("docs", [])
    if isinstance(docs_raw, str):
        docs = (docs_raw,)
    elif isinstance(docs_raw, list) and all(isinstance(d, str) for d in docs_raw):
        docs = tuple(docs_raw)
    else:
        errors.append("docs 必须是字符串或字符串列表")
        docs = ()

    if errors:
        raise WorkflowSpecError(source, errors)

    _check_irreversible_approval(steps, approval, errors)
    _check_step_templates(steps, params, errors)
    if errors:
        raise WorkflowSpecError(source, errors)

    assert isinstance(wf_id, str) and isinstance(intent, str) and isinstance(title, str)
    return Workflow(
        id=wf_id,
        version=int(version),  # type: ignore[arg-type]
        title=title.strip(),
        intent=intent,
        risk=str(risk),
        summary=str(raw.get("summary", "")).strip(),
        tags=tags,
        requires=requires,
        params=params,
        approval=approval,
        steps=tuple(steps),
        artifacts=tuple(artifacts),
        failure=failure,
        docs=docs,
        path=path or Path(source),
        raw=raw,
    )


# --------------------------------------------------------------------------- 校验片段
def _check_requires(value: object, errors: list[str]) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        errors.append("requires 必须是映射")
        return {}
    allowed = {"engine", "live", "gui", "node"}
    out: dict[str, bool] = {}
    for key, flag in value.items():
        if key not in allowed:
            errors.append(f"requires 未知字段：{key}（只认 {sorted(allowed)}）")
            continue
        if not isinstance(flag, bool):
            errors.append(f"requires.{key} 必须是 true/false")
            continue
        out[key] = flag
    return out


def _check_params(value: object, errors: list[str]) -> dict[str, dict]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        errors.append("params 必须是映射")
        return {}
    out: dict[str, dict] = {}
    for name, spec in value.items():
        if not isinstance(name, str) or not _STEP_ID_RE.match(name):
            errors.append(f"参数名不合法：{name!r}（小写字母/数字/下划线）")
            continue
        if not isinstance(spec, dict):
            errors.append(f"params.{name} 必须是映射")
            continue
        extra = sorted(set(spec) - _PARAM_FIELDS)
        if extra:
            errors.append(f"params.{name} 未知字段：{', '.join(extra)}")
        ptype = spec.get("type", "string")
        if ptype not in _PARAM_TYPES:
            errors.append(f"params.{name}.type 必须是 {_PARAM_TYPES} 之一")
        required = spec.get("required", False)
        if not isinstance(required, bool):
            errors.append(f"params.{name}.required 必须是 true/false")
        if "enum" in spec and (not isinstance(spec["enum"], list) or not spec["enum"]):
            errors.append(f"params.{name}.enum 必须是非空列表")
        if "pattern" in spec:
            try:
                re.compile(str(spec["pattern"]))
            except re.error as exc:
                errors.append(f"params.{name}.pattern 不是合法正则：{exc}")
        norm = dict(spec)
        norm["type"] = ptype
        norm["required"] = bool(required)
        out[name] = norm
    return out


def _check_approval(value: object, errors: list[str]) -> dict:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        errors.append("approval 必须是映射")
        return {"required": False}
    extra = sorted(set(value) - _APPROVAL_FIELDS)
    if extra:
        errors.append(f"approval 未知字段：{', '.join(extra)}")
    required = value.get("required", False)
    if not isinstance(required, bool):
        errors.append("approval.required 必须是 true/false")
        required = False
    risk = value.get("risk", "high")
    if risk not in RISK_LEVELS:
        errors.append(f"approval.risk 必须是 {RISK_LEVELS} 之一")
    reason = value.get("reason", "")
    if required and not (isinstance(reason, str) and reason.strip()):
        errors.append("approval.required 为 true 时必须写 reason")
    return {
        "required": required,
        "reason": str(reason),
        "risk": str(risk),
        "by": str(value.get("by", "")),
    }


def _check_steps(value: object, errors: list[str]) -> list[dict]:
    if not isinstance(value, list) or not value:
        errors.append("steps 必须是非空列表")
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for index, step in enumerate(value):
        where = f"steps[{index}]"
        if not isinstance(step, dict):
            errors.append(f"{where} 必须是映射")
            continue
        step_id = step.get("id")
        if not isinstance(step_id, str) or not _STEP_ID_RE.match(step_id):
            errors.append(f"{where}.id 不合法（小写字母/数字/下划线，字母开头）")
            continue
        if step_id in seen:
            errors.append(f"{where}.id 重复：{step_id}")
            continue
        seen.add(step_id)
        kind = step.get("kind")
        if kind not in STEP_FIELDS:
            errors.append(f"{where}.kind 不认识：{kind!r}（只认 {list(STEP_KINDS)}）")
            continue
        allowed = COMMON_STEP_FIELDS | STEP_FIELDS[str(kind)]
        extra = sorted(set(step) - allowed)
        if extra:
            errors.append(f"{where}（{step_id}）有未知字段：{', '.join(extra)}")
        on_fail = step.get("on_fail", "stop")
        if on_fail not in ("stop", "continue"):
            errors.append(f"{where}.on_fail 只能是 stop / continue")
        if "timeout_s" in step and not _is_positive_or_template(step["timeout_s"]):
            errors.append(f"{where}.timeout_s 必须是正数或 ${{...}} 模板")
        if "port" in step:
            port = step["port"]
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                errors.append(f"{where}.port 必须是 1–65535 的整数（CDP 端口）")
        if "seconds" in step and not _is_positive_or_template(step["seconds"]):
            errors.append(f"{where}.seconds 必须是正数或 ${{...}} 模板")
        for key in ("timeout", "poll_ms"):
            if key in step and not _is_positive_or_template(step[key]):
                errors.append(f"{where}.{key} 必须是正数或 ${{...}} 模板")
        _check_step_body(str(kind), step, where, errors)
        out.append(dict(step))
    return out


def _check_step_body(kind: str, step: dict, where: str, errors: list[str]) -> None:
    step_id = step.get("id", "?")
    if kind == "http":
        method = step.get("method", "GET")
        if not isinstance(method, str) or method.upper() not in ("GET", "POST", "PUT", "DELETE"):
            errors.append(f"{where}.method 必须是 GET/POST/PUT/DELETE")
        path = step.get("path")
        if not isinstance(path, str) or not path.startswith("/"):
            errors.append(f"{where}.path 必须以 / 开头")
        expect_status = step.get("expect_status", 200)
        if isinstance(expect_status, list):
            if any(not isinstance(s, int) for s in expect_status):
                errors.append(f"{where}.expect_status 必须是整数列表")
        elif not isinstance(expect_status, int):
            errors.append(f"{where}.expect_status 必须是整数或整数列表")
        if "expect" in step and not isinstance(step["expect"], dict):
            errors.append(f"{where}.expect 必须是映射（目前只认 json:）")
    elif kind == "download":
        path = step.get("path")
        if not isinstance(path, str) or not path.startswith("/"):
            errors.append(f"{where}.path 必须以 / 开头")
        _check_bare_name(step.get("filename"), f"{where}.filename", errors)
        if "magic" in step and not isinstance(step["magic"], str):
            errors.append(f"{where}.magic 必须是字符串")
        if "min_bytes" in step and (not isinstance(step["min_bytes"], int) or step["min_bytes"] < 0):
            errors.append(f"{where}.min_bytes 必须是非负整数")
    elif kind == "live_command":
        line = step.get("line")
        if not isinstance(line, str) or not line.strip():
            errors.append(f"{where}.line 不能为空")
        if "await_reply" in step and not isinstance(step["await_reply"], bool):
            errors.append(f"{where}.await_reply 必须是 true/false")
        allowed = step.get("reply_status_any_of", ["ok"])
        if not isinstance(allowed, list) or not allowed:
            errors.append(f"{where}.reply_status_any_of 必须是非空列表")
    elif kind == "ensure_live":
        if "target" in step and not isinstance(step["target"], (str, type(None))):
            errors.append(f"{where}.target 必须是字符串或 null")
    elif kind == "await_receiver":
        wait_for = step.get("wait_for", "version")
        if wait_for not in ("version", "reconnect_and_version"):
            errors.append(f"{where}.wait_for 只能是 version / reconnect_and_version")
        for key in ("model", "software", "send_after_reconnect"):
            if key in step and not isinstance(step[key], (str, type(None))):
                errors.append(f"{where}.{key} 必须是字符串或 null")
        if "reconnect" in step and not isinstance(step["reconnect"], bool):
            errors.append(f"{where}.reconnect 必须是 true/false")
        if "poll_s" in step and not _is_positive_or_template(step["poll_s"]):
            errors.append(f"{where}.poll_s 必须是正数或 ${{...}} 模板")
    elif kind == "file_digest":
        path = step.get("path")
        if not isinstance(path, str) or not path.strip():
            errors.append(f"{where}.path 不能为空")
    elif kind == "gui":
        actions = step.get("actions")
        if actions is not None:
            if not isinstance(actions, list) or not actions:
                errors.append(f"{where}.actions 必须是非空列表")
            else:
                for i, action in enumerate(actions):
                    _check_gui_action(action, f"{where}.actions[{i}]", errors)
        else:
            single = {key: step[key] for key in _GUI_ACTION_FIELDS if key in step}
            _check_gui_action(single, where, errors)
        if "screenshot" in step and not isinstance(step["screenshot"], bool):
            errors.append(f"{where}.screenshot 必须是 true/false")
        _check_assisted(step.get("assisted"), where, errors)
    elif kind == "verify_ui":
        control = step.get("control")
        if not isinstance(control, str) or not control.strip():
            errors.append(f"{where}.control 不能为空")
        if "expect" in step and not isinstance(step["expect"], dict):
            errors.append(f"{where}.expect 必须是映射")
        _check_assisted(step.get("assisted"), where, errors)
    elif kind == "wait_ui":
        control = step.get("control")
        if not isinstance(control, str) or not control.strip():
            errors.append(f"{where}.control 不能为空")
        expect = step.get("expect")
        if expect is None:
            errors.append(f"{where}.expect 不能为空（wait_ui 必须有等待条件）")
        elif not isinstance(expect, dict):
            errors.append(f"{where}.expect 必须是映射")
        else:
            unknown = sorted(set(expect) - {"contains", "matches", "equals", "absent"})
            if unknown:
                errors.append(
                    f"{where}.expect 只认 contains / matches / equals / absent，"
                    f"不认：{', '.join(unknown)}")
            if not ({"contains", "matches", "equals", "absent"} & set(expect)):
                errors.append(
                    f"{where}.expect 至少要有一个断言（contains / matches / equals / absent）")
            if "absent" in expect:
                if expect["absent"] is not True:
                    errors.append(f"{where}.expect.absent 只能是 true")
                if len(expect) > 1:
                    errors.append(
                        f"{where}.expect.absent 不能和 contains/matches/equals 同时写"
                        "（「不出现」与「等于什么」是两种条件）")
        if "timeout" in step and "timeout_s" in step:
            errors.append(f"{where} 不能同时写 timeout 与 timeout_s（选一个）")
        _check_assisted(step.get("assisted"), where, errors)
    elif kind == "human_gate":
        reason = step.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            errors.append(f"{where}.reason 不能为空")
        risk = step.get("risk", "high")
        if risk not in RISK_LEVELS:
            errors.append(f"{where}.risk 必须是 {RISK_LEVELS} 之一")
        if "prompt" in step and not isinstance(step["prompt"], str):
            errors.append(f"{where}.prompt 必须是字符串")
    elif kind == "assert":
        checks = step.get("checks")
        if not isinstance(checks, list) or not checks:
            errors.append(f"{where}.checks 必须是非空列表")
        else:
            for i, check in enumerate(checks):
                if not isinstance(check, dict) or "path" not in check:
                    errors.append(f"{where}.checks[{i}] 必须是含 path 的映射")
                    continue
                ops = set(check) - {"path", "note"}
                if not ops:
                    errors.append(f"{where}.checks[{i}] 至少要有一个断言（equals/contains/matches/…）")
                unknown_ops = ops - {"equals", "contains", "matches", "exists", "nonempty", "min", "gte", "lte"}
                if unknown_ops:
                    errors.append(f"{where}.checks[{i}] 未知断言：{', '.join(sorted(unknown_ops))}")
    elif kind == "artifact":
        _check_bare_name(step.get("name"), f"{where}.name", errors)
        if "content" not in step:
            errors.append(f"{where}.content 不能为空")
        fmt = step.get("format", "json")
        if fmt not in ("json", "text"):
            errors.append(f"{where}.format 只能是 json / text")
    _ = step_id


def _check_gui_action(action: object, where: str, errors: list[str]) -> None:
    if not isinstance(action, dict):
        errors.append(f"{where} 必须是映射")
        return
    allowed = {"action", "page", "locator", "value", "option"}
    extra = sorted(set(action) - allowed)
    if extra:
        errors.append(f"{where} 未知字段：{', '.join(extra)}")
    name = action.get("action", "click")
    if name not in GUI_ACTIONS:
        errors.append(f"{where}.action 必须是 {GUI_ACTIONS} 之一")
        return
    if name in ("click", "click_optional", "type", "select", "read") and not action.get("locator"):
        errors.append(f"{where}.locator 不能为空（action={name}）")
    if name == "type" and "value" not in action:
        errors.append(f"{where}.value 不能为空（action=type）")
    if name == "select" and "option" not in action:
        errors.append(f"{where}.option 不能为空（action=select）")
    if name == "open" and not action.get("page"):
        errors.append(f"{where}.page 不能为空（action=open）")


def _check_assisted(value: object, where: str, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        errors.append(f"{where}.assisted 必须是映射")
        return
    extra = sorted(set(value) - _ASSISTED_FIELDS)
    if extra:
        errors.append(f"{where}.assisted 未知字段：{', '.join(extra)}")
    if "enabled" in value and not isinstance(value["enabled"], bool):
        errors.append(f"{where}.assisted.enabled 必须是 true/false")
    if "prompt" in value and not isinstance(value["prompt"], str):
        errors.append(f"{where}.assisted.prompt 必须是字符串")


def _check_artifacts(value: object, errors: list[str]) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        errors.append("artifacts 必须是列表")
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for i, item in enumerate(value):
        where = f"artifacts[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{where} 必须是映射")
            continue
        extra = sorted(set(item) - _ARTIFACT_FIELDS)
        if extra:
            errors.append(f"{where} 未知字段：{', '.join(extra)}")
        name = item.get("name")
        _check_bare_name(name, f"{where}.name", errors)
        if isinstance(name, str):
            if name in seen:
                errors.append(f"{where}.name 重复：{name}")
            seen.add(name)
        kind = item.get("kind", "file")
        if kind not in ("file", "json", "text"):
            errors.append(f"{where}.kind 只能是 file / json / text")
        out.append(dict(item))
    return out


def _check_failure(value: object, errors: list[str]) -> dict:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        errors.append("failure 必须是映射")
        return {"screenshot": False, "classes": list(KNOWN_FAILURE_CLASSES)}
    extra = sorted(set(value) - _FAILURE_FIELDS)
    if extra:
        errors.append(f"failure 未知字段：{', '.join(extra)}")
    screenshot = value.get("screenshot", False)
    if not isinstance(screenshot, bool):
        errors.append("failure.screenshot 必须是 true/false")
    classes = value.get("classes", list(KNOWN_FAILURE_CLASSES))
    if not isinstance(classes, list) or any(c not in KNOWN_FAILURE_CLASSES for c in classes):
        errors.append(f"failure.classes 必须是 {KNOWN_FAILURE_CLASSES} 的子集")
        classes = list(KNOWN_FAILURE_CLASSES)
    return {
        "screenshot": bool(screenshot),
        "classes": list(classes),
        "note": str(value.get("note", "")),
    }


def _check_irreversible_approval(steps: list[dict], approval: dict, errors: list[str]) -> None:
    """RESET / FRESET 所在流程必须有审批门。违反就加载失败，不靠执行器记得检查。"""
    if approval.get("required"):
        return
    for step in steps:
        if step.get("kind") != "live_command":
            continue
        line = str(step.get("line", ""))
        if _IRREVERSIBLE.match(line):
            errors.append(
                f"steps.{step.get('id')} 会发送不可逆命令 {line.split()[0]!r}，"
                "但 approval.required 不是 true —— 拒绝加载")


def _check_step_templates(steps: list[dict], params: dict[str, dict], errors: list[str]) -> None:
    """``${params.x}`` 引用的参数必须存在；``${steps.x}`` 必须指向**前面**的步骤。

    步骤既可以用自己的 ``id`` 引用，也可以用 ``save_as`` 起的别名——两者都指向
    同一份输出，校验时都算「已经执行过」。
    """
    seen_steps: set[str] = set()
    for step in steps:
        for path in _collect_templates(step):
            if path.startswith("params."):
                name = path.split(".", 1)[1]
                if name not in params:
                    errors.append(f"steps.{step.get('id')} 引用了未声明的参数 {name!r}")
            elif path.startswith("steps."):
                ref = path.split(".")[1]
                if ref not in seen_steps:
                    errors.append(
                        f"steps.{step.get('id')} 引用了 {path!r}，但步骤 {ref!r} 还没执行"
                        "（只能引用前面的步骤）")
        seen_steps.add(str(step.get("id")))
        if step.get("save_as"):
            seen_steps.add(str(step["save_as"]))


def _collect_templates(value: object) -> list[str]:
    out: list[str] = []
    if isinstance(value, str):
        out.extend(m.group(1).strip() for m in _TEMPLATE_RE.finditer(value))
    elif isinstance(value, dict):
        for v in value.values():
            out.extend(_collect_templates(v))
    elif isinstance(value, list):
        for v in value:
            out.extend(_collect_templates(v))
    return out


def _check_bare_name(value: object, where: str, errors: list[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{where} 不能为空")
        return
    if any(sep in value for sep in ("/", "\\", "..")) or Path(value).name != value:
        errors.append(f"{where} 只能是裸文件名（不能带目录或 ..）：{value!r}")


def _is_positive_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _is_positive_or_template(value: object) -> bool:
    """数值字段允许写 ``${params.x}``：加载时拿不到值，交由执行器在解析后使用。

    仍拒绝裸的负数/零/字符串，避免把 ``timeout_s: -1`` 这种明显笔误带进运行期。
    """
    if isinstance(value, str):
        return bool(_TEMPLATE_RE.fullmatch(value.strip()))
    return _is_positive_number(value)


# --------------------------------------------------------------------------- 参数
def validate_params(workflow: Workflow, given: dict | None = None) -> dict:
    """校验并补默认值；不合法时抛 :class:`WorkflowSpecError`。"""
    resolved, errors = resolve_params(workflow, given)
    if errors:
        raise WorkflowSpecError(f"{workflow.id} 参数", errors)
    return resolved


def resolve_params(workflow: Workflow, given: dict | None = None) -> tuple[dict, list[str]]:
    given = dict(given or {})
    errors: list[str] = []
    unknown = sorted(set(given) - set(workflow.params))
    if unknown:
        errors.append(f"未知参数：{', '.join(unknown)}（只认 {sorted(workflow.params)}）")
    out: dict = {}
    for name, spec in workflow.params.items():
        if name in given:
            raw = given[name]
        elif "default" in spec:
            raw = spec["default"]
        elif spec.get("required"):
            errors.append(f"缺少必填参数 {name}")
            continue
        else:
            out[name] = None
            continue
        value, err = _coerce(name, spec, raw)
        if err:
            errors.append(err)
        else:
            out[name] = value
    return out, errors


def _coerce(name: str, spec: dict, raw: object) -> tuple[object, str | None]:
    ptype = spec.get("type", "string")
    if raw is None:
        if spec.get("required"):
            return None, f"参数 {name} 不能为 null"
        return None, None
    try:
        if ptype == "string":
            if isinstance(raw, bool):
                raise ValueError
            value: object = str(raw)
        elif ptype == "path":
            if isinstance(raw, bool):
                raise ValueError
            value = str(raw)
        elif ptype == "integer":
            if isinstance(raw, bool):
                raise ValueError
            value = int(raw)
        elif ptype == "number":
            if isinstance(raw, bool):
                raise ValueError
            value = float(raw)
        elif ptype == "boolean":
            if isinstance(raw, bool):
                value = raw
            elif isinstance(raw, str) and raw.strip().lower() in ("true", "false"):
                value = raw.strip().lower() == "true"
            elif raw in (0, 1):
                value = bool(raw)
            else:
                raise ValueError
        else:  # pragma: no cover —— 加载时已挡住
            raise ValueError
    except (TypeError, ValueError):
        return None, f"参数 {name} 应为 {ptype}，收到 {raw!r}"
    if "enum" in spec and value not in spec["enum"]:
        return None, f"参数 {name} 只能是 {spec['enum']} 之一，收到 {value!r}"
    pattern = spec.get("pattern")
    if pattern and not re.fullmatch(str(pattern), str(value)):
        return None, f"参数 {name} 不匹配 {pattern}：{value!r}"
    return value, None


# --------------------------------------------------------------------------- 模板
def resolve(value: object, context: dict) -> object:
    """递归替换 ``${...}``。

    * 整个字符串就是一个模板（``"${params.x}"``）时，返回**原对象**（列表/字典/None 都保留）。
    * 混在文本里的模板按字符串拼接；``None`` 变空串。
    """
    if isinstance(value, str):
        whole = _TEMPLATE_RE.fullmatch(value)
        if whole:
            found = _lookup(context, whole.group(1).strip())
            return None if found is _MISSING else found
        def repl(match: re.Match[str]) -> str:
            found = _lookup(context, match.group(1).strip())
            if found is _MISSING or found is None:
                return ""
            if isinstance(found, (dict, list)):
                import json
                return json.dumps(found, ensure_ascii=False, sort_keys=True)
            return str(found)
        return _TEMPLATE_RE.sub(repl, value)
    if isinstance(value, dict):
        return {k: resolve(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, context) for v in value]
    return value


def _lookup(context: dict, path: str) -> object:
    node: object = context
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
            continue
        if isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
            continue
        return _MISSING
    return node
