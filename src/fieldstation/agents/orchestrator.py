#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌面版 Agent 的多轮工具循环（WP2）。

``runtime.run`` 是 M3 的**可回放**运行时：它写 trace、要求确定性、凭 trace
逐字节比对。桌面版要的是另一套东西 —— 事件流、SSE、人工审批卡、用户随时
取消。两者的生命周期不同，硬塞进 ``runtime.run`` 会同时毁掉回放基线和交互
体验，所以这里是并行的一层：复用 ``providers`` / ``tools`` 的协议与工具本身，
不复制任何判据实现。

## 事件（契约 §2）

``emit(event)`` 收到的每个 dict 都是要落进会话 JSONL、并原样推给前端的
一行。本模块负责：

* ``message``    用户那句与助手的最终回答（助手回答先发 ``token`` 分片）
* ``tool_call``  开始执行：``id`` 即 call id，``status="running"``
* ``approval``   ``risk="high"`` 时先发 ``status="pending"``，决定后再发一条
                 ``approved|rejected``（事件只追加，所以是第二条同 id 事件）
* ``tool_result`` 执行结果，带 ``evidence={agent, call_id:"t0001"}``
* ``error``      失败才发，``class`` 取契约的五个值之一

不发的：``done``（SSE 流结束标记，由 HTTP 层发，不落盘）、``artifact``
（产物事件由产生产物的工具桥负责）、``plan``（当前没有规划器）。

## 停手条件

* 模型不再要求调工具 → 发最终回答；
* 轮次达到 ``max_turns``（默认 8）→ 发 ``error``，不假装答完；
* 用户取消 → 发 ``error``（cancel 不是一种成功）；
* provider 抛异常 → 发 ``error``，不把栈打到客户端。

## 安全默认

``risk="high"`` 且没有 ``wait_decision`` 时**不会执行**：没人能批，就不动。
未注册的工具一律按高风险处理并且不执行 —— 模型编一个名字出来，不能因为
名字眼熟就放行。
"""
from __future__ import annotations

import importlib
import inspect
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from .providers.base import ChatMessage
from .tools import ToolRegistry, ToolResult

MAX_TURNS_DEFAULT = 8
APPROVAL_TIMEOUT_DEFAULT = 600.0
AGENT_NAME = "ops"
TOKEN_CHUNK_CHARS = 24
#: 回灌给模型的工具结果正文上限。超长结果对下一轮没有增益，只会挤掉上下文。
TOOL_BODY_LIMIT = 20_000
#: 工具结果回灌给模型的形状。**用 user 角色**：``ChatMessage`` 只有
#: role/content，没有 ``tool_call_id``；审阅时把一条 ``role="tool"`` 直接塞给
#: 只认 system/user/assistant 的 provider 会 400。前缀让模型与演示 provider
#: 都能认出这是工具结果而不是用户新说的话。
TOOL_RESULT_PREFIX = "[工具结果]"

_ERROR_CLASSES = ("environment", "input", "execution", "artifact", "capability")


def _tool_message(name: str, call_id: str, body: str) -> ChatMessage:
    return ChatMessage(role="user",
                       content=f"{TOOL_RESULT_PREFIX}[{name}][{call_id}] {body}")


DEFAULT_SYSTEM_PROMPT = """你是野外台站的运维助手（ops）。用简体中文回答。

规则：
1. 需要事实时先调工具，不要凭印象编造设备状态、统计量或文件路径。
2. 工具失败就把失败原样告诉用户，并说明下一步能做什么；不要假装成功。
3. 高风险动作（重启、断电、配置下发）必须先说明影响，等审批结果再执行。
4. 结论要指出来源：哪次工具调用（t0001 这样的 call_id）给出了依据。
5. 回答简短，先给结论，再给依据。"""


# --------------------------------------------------------------------------
# 事件工具
# --------------------------------------------------------------------------

def _now_iso() -> str:
    # 与 agent_store 的时间戳同精度（微秒）：字符串序即时间序，列表排序不用再解析。
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _default_id(prefix: str) -> str:
    """事件 id：前缀 + 随机后缀。跨轮、跨次运行都不会撞。"""
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _classify_error(message: str | None, *, kind: str = "") -> str:
    """把一句失败信息归进契约的五个 class。

    这是**启发式**，不是判据：工具协议里没有错误分类字段，而 UI 只想显示
    一个稳定的 class。命中不了就落到 ``execution``（最不具误导性的默认）。
    """
    text = f"{kind} {message or ''}".lower()
    if any(word in text for word in ("未注册", "不支持", "不可用", "缺少", "能力",
                                     "not found", "unsupported", "missing module",
                                     "no such tool")):
        return "capability"
    if any(word in text for word in ("artifact", "产物", "文件", "路径", "写盘",
                                     "disk", "permission denied", "拒绝访问")):
        return "artifact"
    if any(word in text for word in ("连接", "网络", "超时", "timeout", "connection",
                                     "refused", "unreachable", "environment")):
        return "environment"
    if any(word in text for word in ("参数", "invalid", "必须", "不能为空",
                                     "类型", "argument", "value error")):
        return "input"
    return "execution"


def _jsonable(value):
    """尽量把工具返回值变成能 JSON 序列化的形状；实在不行就转字符串。"""
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        if isinstance(value, dict):
            return {str(k): _jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_jsonable(item) for item in value]
        return str(value)


def _summarize(name: str, data: dict) -> str:
    """给 UI 一句话摘要。优先用工具自己给的 summary/message/status。"""
    if isinstance(data, dict):
        for key in ("summary", "message", "note", "status", "path"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return f"{name}：{value.strip()[:160]}"
            if isinstance(value, dict):
                parts = []
                for k, v in value.items():
                    if isinstance(v, (dict, list)):
                        continue
                    parts.append(f"{k}={v}")
                    if len(parts) >= 4:
                        break
                if parts:
                    return f"{name}：" + "，".join(parts)
        if data:
            return f"{name} 完成（{len(data)} 个字段）"
    return f"{name} 完成"


class _Emitter:
    """事件生成器：统一 id、时间戳与消息分片。"""

    def __init__(self, emit: Callable[[dict], None],
                 id_factory: Callable[[str], str] | None,
                 agent_name: str) -> None:
        self._emit = emit
        self._id = id_factory or _default_id
        self.agent = agent_name

    def emit(self, event: dict) -> None:
        self._emit(event)

    def new_id(self, prefix: str) -> str:
        value = self._id(prefix)
        return value if isinstance(value, str) and value else _default_id(prefix)

    def error(self, error_class: str, message: str) -> None:
        cls = error_class if error_class in _ERROR_CLASSES else "execution"
        self._emit({"type": "error", "class": cls, "message": message,
                    "ts": _now_iso()})

    def message(self, role: str, content: str,
                attachments: list | None = None) -> str:
        mid = self.new_id("m")
        event = {"type": "message", "id": mid, "role": role,
                 "content": content, "ts": _now_iso()}
        if attachments:
            event["attachments"] = _jsonable(attachments)
        self._emit(event)
        return mid

    def assistant(self, content: str) -> str:
        """先发 token 分片，再发完整 message（同一 id，后者为准）。"""
        mid = self.new_id("m")
        for chunk in _chunks(content, TOKEN_CHUNK_CHARS):
            self._emit({"type": "token", "id": mid, "delta": chunk})
        self._emit({"type": "message", "id": mid, "role": "assistant",
                    "content": content, "ts": _now_iso()})
        return mid


def _chunks(text: str, size: int) -> Iterable[str]:
    if not text:
        return
    for start in range(0, len(text), size):
        yield text[start:start + size]


# --------------------------------------------------------------------------
# 工具注册表
# --------------------------------------------------------------------------

#: WP5 的两个桥：模块名 → (桥类名, 构造函数的候选名)。桥对象由本模块按上下文
#: 构造，再交给模块自己的 ``build_*_tools``；工具实现一行都不复制。
_BRIDGES = (
    ("native", "fieldstation.agents.tools.native_bridge",
     "NativeBridge", ("build_tools", "build_native_tools", "native_tools")),
    ("rpa", "fieldstation.agents.tools.rpa_bridge",
     "RpaBridge", ("build_rpa_tools", "build_tools", "rpa_tools")),
)


def _default_repo_root() -> Path:
    # src/fieldstation/agents/orchestrator.py → 仓库根
    return Path(__file__).resolve().parents[3]


def load_system_prompt(repo_root: str | Path | None = None) -> str:
    """从 ``config/agents/ops.json`` 读 system prompt；读不到就用内置那份。

    文件由 WP5 提供。这里**不报错**：一个还没生成的配置文件不该让服务起不来，
    但也不能让 Agent 没有系统提示 —— 所以有内置兜底，并且只认明确的字段。
    """
    root = Path(repo_root) if repo_root else _default_repo_root()
    path = root / "config" / "agents" / "ops.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return DEFAULT_SYSTEM_PROMPT
    if not isinstance(raw, dict):
        return DEFAULT_SYSTEM_PROMPT
    for key in ("system_prompt", "prompt"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    agents = raw.get("agents")
    if isinstance(agents, dict):
        ops = agents.get("ops")
        if isinstance(ops, dict):
            value = ops.get("system_prompt")
            if isinstance(value, str) and value.strip():
                return value.strip()
    return DEFAULT_SYSTEM_PROMPT


def _filter_kwargs(func: Callable, kwargs: dict) -> dict | None:
    """只把函数真的接受的参数传进去；必需参数缺失就返回 None（调用方报警告）。"""
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return {}
    params = signature.parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return {k: v for k, v in kwargs.items() if v is not None}
    accepted = {}
    for name, param in params.items():
        if name in kwargs and param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                                             inspect.Parameter.KEYWORD_ONLY):
            accepted[name] = kwargs[name]
        elif (param.default is inspect.Parameter.empty
              and param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                                 inspect.Parameter.KEYWORD_ONLY)):
            return None
    return accepted


def _iter_tools(produced) -> list:
    if produced is None:
        return []
    if isinstance(produced, ToolRegistry):
        return [produced.get(name) for name in produced.names()]
    if isinstance(produced, dict):
        return list(produced.values())
    if isinstance(produced, (list, tuple, set)):
        return list(produced)
    return [produced]


def _register_all(registry: ToolRegistry, tools: Iterable, warnings: list[str],
                  label: str) -> None:
    for tool in tools:
        if tool is None:
            continue
        name = getattr(tool, "name", None)
        if not isinstance(name, str) or not name:
            warnings.append(f"{label}：跳过一个没有 name 的工具对象")
            continue
        try:
            registry.register(tool)
        except ValueError as exc:  # 重名
            warnings.append(f"{label}：{exc}")


def build_registry(*, repo_root: str | Path | None = None,
                   data_dir: str | Path | None = None,
                   session_id: str | None = None,
                   node_url: str | None = None,
                   token: str | None = None,
                   warnings: list[str] | None = None,
                   include_local: bool = True,
                   work_order_service=None) -> ToolRegistry:
    """装配一个工具注册表：本地 A 侧工具 + WP5 的两个桥（有就接，没有就警告）。

    桥的接口约定（WP5 实现）：模块里提供 ``build_tools(...)`` 之类的构造函数，
    返回 ``Tool`` 的可迭代对象 / ``ToolRegistry`` / ``{name: Tool}``。本函数按
    签名过滤参数，所以桥可以只声明自己需要的那几个：

    ``node_url`` / ``token`` / ``repo_root`` / ``data_dir`` / ``artifacts_dir`` /
    ``session_id`` / ``exports_dir``。

    **不复制桥的实现**：模块不在就记一条警告（不含绝对路径），注册表照常可用。
    """
    flags = warnings if warnings is not None else []
    root = Path(repo_root) if repo_root else _default_repo_root()
    base_dir = Path(data_dir) if data_dir else None
    artifacts_dir = (base_dir / "artifacts" / session_id) if (base_dir and session_id) else (
        (base_dir / "artifacts") if base_dir else None)

    registry = ToolRegistry()

    if include_local:
        _register_local_tools(
            registry, flags, repo_root=root, data_dir=base_dir,
            work_order_service=work_order_service)

    context = {
        "node_url": node_url,
        "base_url": node_url,
        "token": token,
        "repo_root": root,
        "repo": root,
        "data_dir": base_dir,
        "artifacts_dir": artifacts_dir,
        "exports_dir": (base_dir / "exports") if base_dir else None,
        "jobs_root": (base_dir / "jobs") if base_dir else None,
        "session_id": session_id,
    }
    for label, module_name, bridge_class, builder_names in _BRIDGES:
        tools, reason = _load_bridge(label, module_name, bridge_class,
                                     builder_names, context)
        if reason:
            flags.append(f"未加载 {label} 工具桥：{reason}")
            continue
        _register_all(registry, tools, flags, f"{label} 工具桥")

    return registry


def _load_bridge(label: str, module_name: str, bridge_class_name: str,
                 builder_names: tuple[str, ...],
                 context: dict) -> tuple[list, str]:
    """返回 ``(tools, 失败原因)``。原因文案里不带本机绝对路径。"""
    if label == "native" and not context.get("base_url"):
        return [], "未提供 node_url（native 工具需要 Node 服务地址）"
    if label == "native" and not context.get("artifacts_dir"):
        return [], "未提供 data_dir（native 工具需要产物目录）"
    try:
        module = importlib.import_module(module_name)
    except ImportError:
        return [], f"缺少模块 {module_name}"
    except Exception as exc:  # 桥自己 import 时炸了
        return [], f"导入 {module_name} 失败（{type(exc).__name__}）"

    builder = None
    for name in builder_names:
        candidate = getattr(module, name, None)
        if callable(candidate):
            builder = candidate
            break
    if builder is None:
        return [], (f"{module_name} 里没有可调用的构造函数"
                    f"（找过 {', '.join(builder_names)}）")

    bridge = None
    bridge_cls = getattr(module, bridge_class_name, None)
    if not isinstance(bridge_cls, type):
        bridge_cls = next(
            (value for name, value in vars(module).items()
             if isinstance(value, type) and name.endswith("Bridge")), None)
    if isinstance(bridge_cls, type):
        bridge_kwargs = _filter_kwargs(bridge_cls, context)
        if bridge_kwargs is not None:
            try:
                bridge = bridge_cls(**bridge_kwargs)
            except Exception as exc:
                return [], (f"{bridge_class_name} 构造失败"
                            f"（{type(exc).__name__}: {exc}）")

    merged = dict(context)
    try:
        signature = inspect.signature(builder)
    except (TypeError, ValueError):
        signature = None
    if signature is not None and bridge is not None:
        for name, param in signature.parameters.items():
            if name in merged or name not in ("bridge", "native", "rpa"):
                continue
            if param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                              inspect.Parameter.POSITIONAL_ONLY,
                              inspect.Parameter.KEYWORD_ONLY):
                merged[name] = bridge

    kwargs = _filter_kwargs(builder, merged)
    if kwargs is None:
        return [], (f"{module_name} 的构造函数需要桥对象或服务上下文里没有的参数")
    try:
        produced = builder(**kwargs)
    except Exception as exc:
        return [], f"{module_name} 构造工具失败（{type(exc).__name__}: {exc}）"
    return _iter_tools(produced), ""


def _register_local_tools(registry: ToolRegistry, warnings: list[str], *,
                          repo_root: Path, data_dir: Path | None,
                          work_order_service=None) -> None:
    """注册本地 A 侧工具。**逐个延迟 import**：缺一个不影响其他工具上线。"""
    factory_specs = (
        ("station_health", "fieldstation.agents.tools.station_tools",
         "station_health_tool", {}),
        ("device_heartbeat", "fieldstation.agents.tools.heartbeat_tools",
         "device_heartbeat_tool", {}),
        ("robust_stats", "fieldstation.agents.tools.qc_tools",
         "robust_stats_tool", {}),
        ("slip_detect", "fieldstation.agents.tools.qc_tools",
         "slip_detect_tool", {}),
        ("continuity_verdict", "fieldstation.agents.tools.qc_tools",
         "continuity_verdict_tool", {}),
        ("magnitude_verdict", "fieldstation.agents.tools.qc_tools",
         "magnitude_verdict_tool", {}),
    )
    for label, module_name, factory_name, kwargs in factory_specs:
        try:
            module = importlib.import_module(module_name)
            factory = getattr(module, factory_name)
            tool = factory(**kwargs)
        except Exception as exc:
            warnings.append(f"未注册本地工具 {label}（{type(exc).__name__}）")
            continue
        _register_all(registry, [tool], warnings, "本地工具")

    # 工单工具：共享一个内存服务实例，否则每次运行都从零开始，
    # 上一轮建的工单下一轮就查不到。
    try:
        from ..store.work_order import WorkOrderService
        from .tools.work_order_tools import (CreateWorkOrderTool,
                                             ExecuteDeviceActionTool)

        service = work_order_service or WorkOrderService()
        _register_all(registry, [CreateWorkOrderTool(service),
                                 ExecuteDeviceActionTool()], warnings, "本地工具")
    except Exception as exc:
        warnings.append(f"未注册工单工具（{type(exc).__name__}）")

    # 归档导出：写进数据目录，不往仓库里丢用户数据。
    try:
        from .tools.archive_tools import archive_export_tool

        export_root = ((data_dir / "exports") if data_dir
                       else repo_root / "data" / "exports")
        _register_all(registry, [archive_export_tool(export_root)],
                      warnings, "本地工具")
    except Exception as exc:
        warnings.append(f"未注册 archive_export（{type(exc).__name__}）")


# --------------------------------------------------------------------------
# 多轮循环
# --------------------------------------------------------------------------

def run_session(session_id: str, text: str, *,
                emit: Callable[[dict], None],
                provider,
                registry: ToolRegistry,
                system_prompt: str | None = None,
                max_turns: int = MAX_TURNS_DEFAULT,
                approval_timeout: float = APPROVAL_TIMEOUT_DEFAULT,
                wait_decision: Callable[[str, float], str] | None = None,
                cancel_event=None,
                agent_name: str = AGENT_NAME,
                attachments: list | None = None,
                id_factory: Callable[[str], str] | None = None) -> dict:
    """跑一轮对话（可能多轮工具调用）。返回本次运行的摘要 dict。

    ``wait_decision(approval_id, timeout)`` 由调用方实现，返回
    ``"approved" | "rejected" | "timeout" | "cancelled"``。不传就等于「永远
    没人批」：高风险工具一律不执行。

    ``emit`` 的异常会向上抛给调用方（通常是 HTTP 层），因为写不进会话文件
    时继续跑只会产生一份对不上盘的对话。
    """
    emitter = _Emitter(emit, id_factory, agent_name)
    emitter.message("user", text, attachments=attachments)

    messages = [
        ChatMessage(role="system",
                    content=system_prompt or load_system_prompt()),
        ChatMessage(role="user", content=text),
    ]
    tools = registry.describe()

    turns = 0
    call_seq = 0
    content = ""
    error: str | None = None
    cancelled = False
    final_sent = False

    while turns < max_turns:
        if _is_cancelled(cancel_event):
            cancelled = True
            emitter.error("execution", "运行已取消（用户中断）。")
            break
        turns += 1
        try:
            response = provider.chat(list(messages), tools)
        except Exception as exc:
            error = f"模型调用失败：{type(exc).__name__}: {exc}"
            cls = "capability" if isinstance(exc, ValueError) else "environment"
            emitter.error(cls, error)
            break

        content = (getattr(response, "content", "") or "").strip()
        if content:
            emitter.assistant(content)

        calls = list(getattr(response, "tool_calls", None) or [])
        if not calls:
            final_sent = True
            break

        stopped = False
        for call in calls:
            if _is_cancelled(cancel_event):
                cancelled = True
                stopped = True
                break
            call_seq += 1
            outcome = _run_call(
                call, registry=registry, emitter=emitter, messages=messages,
                call_seq=call_seq, wait_decision=wait_decision,
                approval_timeout=approval_timeout, cancel_event=cancel_event,
                agent_name=agent_name)
            if outcome == "cancelled":
                cancelled = True
                stopped = True
                break
        if cancelled:
            emitter.error("execution", "运行已取消（用户中断）。")
            break
        if stopped:
            break

    if not final_sent and not cancelled and error is None:
        error = f"已达到最大轮次上限 {max_turns}，未得到最终回答。"
        emitter.error("execution", error)

    return {
        "session_id": session_id,
        "ok": error is None and not cancelled,
        "cancelled": cancelled,
        "turns": turns,
        "content": content,
        "error": error,
    }


def _is_cancelled(cancel_event) -> bool:
    return cancel_event is not None and cancel_event.is_set()


def _run_call(call: dict, *, registry: ToolRegistry, emitter: _Emitter,
              messages: list[ChatMessage], call_seq: int,
              wait_decision, approval_timeout: float, cancel_event,
              agent_name: str) -> str:
    """执行一次工具调用。返回 ``"ok" | "rejected" | "cancelled"``。"""
    name = call.get("name") if isinstance(call, dict) else None
    name = name if isinstance(name, str) else ""
    raw_args = call.get("args") if isinstance(call, dict) else None
    args = raw_args if isinstance(raw_args, dict) else {}

    tool = registry.get(name) if name else None
    risk = getattr(tool, "risk", None) if tool is not None else None
    if not isinstance(risk, str) or not risk:
        risk = "high"  # 未注册的工具按高风险看待，且反正不会执行

    call_id = emitter.new_id("c")
    evidence_call = f"t{call_seq:04d}"
    emitter.emit({
        "type": "tool_call", "id": call_id, "name": name, "args": _jsonable(args),
        "risk": risk, "status": "running",
    })

    if tool is None:
        message = f"未注册的工具：{name or '(空名称)'}"
        _emit_result(emitter, call_id, evidence_call, agent_name, False, message,
                     {}, 0)
        emitter.error("capability", message)
        messages.append(_tool_message(name, call_id, f"失败：{message}"))
        return "rejected"

    if risk == "high":
        approval_id = emitter.new_id("a")
        reason = (call.get("reason") if isinstance(call, dict) else "") or ""
        reason = reason.strip() if isinstance(reason, str) else ""
        if not reason:
            reason = f"工具 {name} 标记为高风险，需要人工确认。"
        prompt = _approval_prompt(name, args)
        emitter.emit({
            "type": "approval", "id": approval_id, "call_id": call_id,
            "risk": risk, "reason": reason,
            "prompt": prompt, "status": "pending",
        })
        decision = "rejected"
        if wait_decision is not None:
            try:
                decision = wait_decision(approval_id, float(approval_timeout))
            except Exception as exc:  # 等待机制自己坏了，按拒绝处理
                decision = "rejected"
                note = f"审批等待失败（{type(exc).__name__}），按拒绝处理"
            else:
                note = ""
        else:
            note = "没有审批通道，按拒绝处理"
        if decision not in ("approved", "rejected", "timeout", "cancelled"):
            decision = "rejected"

        approved = decision == "approved"
        status = "approved" if approved else "rejected"
        if decision == "cancelled":
            note = note or "运行已取消"
        elif decision == "timeout":
            note = note or "审批超时，按拒绝处理"
        decided = {
            "type": "approval", "id": approval_id, "call_id": call_id,
            "risk": risk, "reason": reason,
            "prompt": prompt, "status": status,
            "decision": decision, "decided_at": _now_iso(),
        }
        if note:
            decided["note"] = note
        emitter.emit(decided)

        if decision == "cancelled":
            _emit_result(emitter, call_id, evidence_call, agent_name, False,
                         "运行已取消，工具未执行", {}, 0)
            messages.append(_tool_message(name, call_id, "失败：运行已取消"))
            return "cancelled"
        if not approved:
            summary = "未获批准，工具未执行"
            _emit_result(emitter, call_id, evidence_call, agent_name, False,
                         summary, {}, 0)
            messages.append(_tool_message(name, call_id, f"失败：{summary}"))
            return "rejected"

    started = time.perf_counter()
    try:
        result = tool.invoke(args)
    except Exception as exc:
        result = ToolResult(ok=False, data={},
                            error=f"{type(exc).__name__}: {exc}")
    duration_ms = int((time.perf_counter() - started) * 1000)

    ok = bool(getattr(result, "ok", False))
    raw_data = getattr(result, "data", {}) or {}
    data = _jsonable(raw_data) if isinstance(raw_data, dict) else {"value": _jsonable(raw_data)}
    failure = getattr(result, "error", None)
    if ok:
        summary = _summarize(name, data)
    else:
        summary = (failure or "").strip() if isinstance(failure, str) else ""
        summary = summary or "工具执行失败（未返回原因）"

    _emit_result(emitter, call_id, evidence_call, agent_name, ok, summary, data,
                 duration_ms)
    if not ok:
        emitter.error(_classify_error(summary, kind=name), summary)

    body = (json.dumps(data, ensure_ascii=False, sort_keys=True)
            if ok else f"失败：{summary}")
    if len(body) > TOOL_BODY_LIMIT:
        body = body[:TOOL_BODY_LIMIT] + "…（已截断）"
    messages.append(_tool_message(name, call_id, body))
    return "ok"


def _emit_result(emitter: _Emitter, call_id: str, evidence_call: str,
                 agent_name: str, ok: bool, summary: str, data: dict,
                 duration_ms: int) -> None:
    emitter.emit({
        "type": "tool_result", "id": call_id, "ok": ok, "summary": summary,
        "data": data, "evidence": {"agent": agent_name, "call_id": evidence_call},
        "duration_ms": duration_ms,
    })


def _approval_prompt(name: str, args: dict) -> str:
    try:
        rendered = json.dumps(args, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        rendered = str(args)
    if len(rendered) > 400:
        rendered = rendered[:400] + "…"
    return f"是否允许执行 {name}？参数：{rendered}"
