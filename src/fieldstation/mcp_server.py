# -*- coding: utf-8 -*-
"""MCP 工具面服务（E1）。

## 这个服务是什么

A 侧（OpenCode）与 B 侧（Claude Agent SDK）都不自己实现工具，而是**直连同一个
MCP 服务**。本模块就是那个服务：把 `agents/tools/` 里已有的实现暴露成 MCP 工具，
用 Streamable HTTP 传输。

## 三条不可让的纪律

1. **工具清单从契约现解析，不硬编码。**
   唯一权威是 `docs/contracts/mcp-tools.md`（30 行表格）。代码里另抄一份，
   契约改了代码不知道，两边会各自「自洽」——这是 `tools/audit_claims.py`
   同一条纪律（期望值从文档取）。

2. **解析出 0 个工具就硬失败（`sys.exit(2)`）。**
   静默返回空列表会让服务正常启动、一个工具都没有、所有调用都报「工具不存在」,
   而没人知道根因是契约格式变了。看不见就说看不见。

3. **高风险工具的审批校验在服务里，不在调用方。**
   放调用方等于把安全约束交给「别人记得先审批」；脚本或另一个 AI 直连接口即可绕过。

## 审批默认是「关」的

`ApprovalLedger` 默认实现 `DenyAllLedger`：任何需要审批的调用都拿不到批准。
显式传入 ledger（测试、或接上 `intervention` 表之后）才可能放行。
这与 `agents/approval.py`「没有审批者时不给默认放行」是同一条纪律。

## 用法

    python -m fieldstation.mcp_server                    # 127.0.0.1:7804/mcp
    python -m fieldstation.mcp_server --port 7805
    python -m fieldstation.mcp_server --check            # 只体检契约解析，不起服务

退出码：0 正常；2 输入不可用（契约缺失/解析出 0 个工具）。
"""
from __future__ import annotations

import argparse
import inspect
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

#: 仓库根。本文件在 ``src/fieldstation/`` 下，上溯三级。
ROOT = Path(__file__).resolve().parents[2]

#: 唯一权威：30 条工具的契约表。
CONTRACT = ROOT / "docs" / "contracts" / "mcp-tools.md"

#: 默认监听。7804 不与其他服务冲突（9223/9224 套件、8788 运行时网关、4096 opencode）。
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 7804

#: 契约要求恰好这么多条。少于它就说明解析口径漏了。
EXPECTED_TOOLS = 30

#: 风险级白名单。拼错一个字母等于静默关掉审批。
RISK_LEVELS = ("low", "medium", "high")

#: 必须审批的审批列取值。契约 §3：``risk=high`` 恒过审批门；``条件（…）`` 由条件决定，
#: 本服务不猜条件——条件型工具若实际命中高风险，调用方仍应带 ``approval_id``。
APPROVAL_ALWAYS = "是"

#: 契约里的类型写法 → Python 注解。数组只保留 ``list``，元素类型交给 JSON Schema 描述。
_TYPE_MAP: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "object": dict,
    "array": list,
}


class ContractError(RuntimeError):
    """契约不可读或解析不出工具。调用方应据此退出码 2，而不是继续起服务。"""


# --------------------------------------------------------------------- 解析
@dataclass(frozen=True)
class Param:
    """一个工具入参。``default`` 只在契约写了 ``=值`` 时非空。"""

    name: str
    type: str
    required: bool
    default: str | None = None
    items: str | None = None


@dataclass(frozen=True)
class ToolSpec:
    """契约里的一行。

    字段与 `docs/contracts/schema/mcp-tool.schema.json` 对齐：
    ``name`` / ``group`` / ``description`` / ``params`` / ``returns`` /
    ``errors`` / ``approval`` / ``risk``。
    """

    index: str
    name: str
    group: str
    params: tuple[Param, ...]
    returns: str
    errors: tuple[str, ...]
    approval: str
    risk: str

    @property
    def needs_approval(self) -> bool:
        """是否需要审批 id。

        契约 §3 两条硬规则：审批列写「是」，或风险级为 ``high``，都必须过审批门。
        ``条件（…）`` 不计入——条件由具体调用决定，本服务不替它猜。
        """
        return self.approval == APPROVAL_ALWAYS or self.risk == "high"

    @property
    def description(self) -> str:
        """契约表没有「说明」列，故由**分组 + 返回摘要**拼出，不改写、不臆造。

        MCP 的 ``description`` 不能为空（schema ``minLength=1``），而契约里
        唯一可用的描述性文字就是这两列。
        """
        return f"{self.group}｜成功返回：{self.returns}"


#: 表格数据行：``| T01 | `station_health` | 台站 | … |``
_ROW_RE = re.compile(r"^\|\s*(T\d{2})\s*\|", re.M)
#: 入参项：``readings:array<object>*`` / ``stale_after_s:number=300``
_PARAM_RE = re.compile(
    r"`(?P<name>[a-z][a-z0-9_]*)\s*:\s*(?P<type>[a-z]+)(?:<(?P<items>[a-z]+)>)?"
    r"(?P<req>\*)?(?:\s*=\s*(?P<default>[^`]*))?`")
#: 错误码：``E_ARG, E_LIMIT``
_ERROR_RE = re.compile(r"E_[A-Z_]+")


def _cells(line: str) -> list[str]:
    """把一行 markdown 表格拆成单元（去掉首尾竖线与两侧空白）。"""
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [c.strip() for c in body.split("|")]


def _parse_params(text: str) -> tuple[Param, ...]:
    """解析入参列。

    契约写法：`` `readings:array<object>*`；`station_id:string` ``。
    ``*`` 表示必填，``=值`` 表示默认值。只认反引号包着的项，避免把说明文字当成参数。
    """
    out: list[Param] = []
    for m in _PARAM_RE.finditer(text):
        out.append(Param(
            name=m.group("name"),
            type=m.group("type"),
            items=m.group("items"),
            required=bool(m.group("req")),
            default=(m.group("default") or "").strip() or None,
        ))
    return tuple(out)


def parse_tools(text: str) -> list[ToolSpec]:
    """从契约正文解析出 30 条工具。

    **解析出 0 条就抛 :class:`ContractError`**（调用方转成退出码 2）。
    这是「失明即硬失败」：契约格式一变，宁可起不来，也不要起一个空服务。
    """
    lines = text.splitlines()
    tools: list[ToolSpec] = []

    for i, line in enumerate(lines):
        m = _ROW_RE.match(line)
        if not m:
            continue
        cells = _cells(line)
        # 8 列：编号 / 名称 / 分组 / 入参 / 返回 / 错误码 / 审批 / 风险
        if len(cells) < 8:
            continue
        name_cell = cells[1]
        name_match = re.search(r"`([a-z][a-z0-9_]*)`", name_cell)
        if not name_match:
            continue
        approval = cells[6]
        risk = cells[7].lower()
        if risk not in RISK_LEVELS:
            raise ContractError(
                f"第 {i + 1} 行 {name_match.group(1)} 的风险级 {risk!r} 不在 {RISK_LEVELS}")
        tools.append(ToolSpec(
            index=m.group(1),
            name=name_match.group(1),
            group=cells[2],
            params=_parse_params(cells[3]),
            returns=cells[4],
            errors=tuple(dict.fromkeys(_ERROR_RE.findall(cells[5]))),
            approval=approval,
            risk=risk,
        ))

    if not tools:
        raise ContractError(
            "契约里没有解析出任何工具（表格格式可能变了）。"
            "拒绝启动空工具面服务。")
    return tools


def load_tools(path: Path | None = None) -> list[ToolSpec]:
    """读契约并解析。文件缺失同样按输入不可用处理。"""
    target = Path(path) if path else CONTRACT
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ContractError(f"读不到契约 {target}：{exc}") from exc
    return parse_tools(text)


# --------------------------------------------------------------------- 审批
class ApprovalLedger(Protocol):
    """审批台账。**只回答「这个 approval_id 有没有被批准」**，不解释理由。"""

    def is_approved(self, approval_id: str) -> bool:
        ...


class DenyAllLedger:
    """默认实现：一律不批。

    宁可让高风险工具不可用，也不默认放行——与 ``agents/approval.py`` 同一条纪律：
    默认放行等于把安全约束交给「有没有人记得配」。
    """

    def is_approved(self, approval_id: str) -> bool:  # noqa: ARG002 —— 明确拒绝
        return False


@dataclass
class InMemoryLedger:
    """脚本化台账：测试与本地演示用。**不接真实审批，不要用于生产。**"""

    approved: set[str] = field(default_factory=set)

    def grant(self, approval_id: str) -> None:
        self.approved.add(approval_id)

    def revoke(self, approval_id: str) -> None:
        self.approved.discard(approval_id)

    def is_approved(self, approval_id: str) -> bool:
        return approval_id in self.approved


# --------------------------------------------------------------------- 分发
class ToolUnavailable(RuntimeError):
    """该工具在当前环境没有可用实现（缺依赖/缺端点/未接）。**不冒充成功。**"""


#: 契约工具名 → 实现。延迟构造，避免 import 期就触发知识库重建等副作用。
_DISPATCH: dict[str, Callable[[dict, dict], dict]] = {}


def _register_default_implementations() -> None:
    """把 `agents/tools/` 与相邻模块的既有实现挂进分发表。

    **只包装，不重写**：统计口径、QC 判据、工作流语义都在原处，这里只做
    「契约参数名 → 实现参数名」的搬运。谁在这里重写一遍口径，哪天天道走了分叉
    不会有人发现。
    """
    def _tool(factory: Callable[[], Any], args_map: Callable[[dict], dict]):
        def run(args: dict, ctx: dict) -> dict:
            tool = factory()
            return _invoke_tool(tool, args_map(args), ctx)
        return run

    from .agents.tools.heartbeat_tools import device_heartbeat_tool
    from .agents.tools.qc_tools import (continuity_verdict_tool,
                                        magnitude_verdict_tool,
                                        robust_stats_tool, slip_detect_tool)
    from .agents.tools.station_tools import station_health_tool

    _DISPATCH["station_health"] = _tool(station_health_tool, lambda a: a)
    _DISPATCH["device_heartbeat"] = _tool(
        device_heartbeat_tool,
        lambda a: {k: v for k, v in a.items() if v is not None})
    _DISPATCH["robust_stats"] = _tool(robust_stats_tool, lambda a: a)
    _DISPATCH["slip_detect"] = _tool(slip_detect_tool, lambda a: a)
    _DISPATCH["continuity_verdict"] = _tool(continuity_verdict_tool, lambda a: a)
    _DISPATCH["magnitude_verdict"] = _tool(magnitude_verdict_tool, lambda a: a)

    _DISPATCH["execute_device_action"] = _execute_device_action
    _DISPATCH["create_work_order"] = _create_work_order
    _DISPATCH["list_work_orders"] = _list_work_orders
    _DISPATCH["update_work_order"] = _update_work_order
    _DISPATCH["archive_export"] = _archive_export
    _DISPATCH["kb_search"] = _kb_search

    for name in ("native_ports", "suite_graph_export"):
        _DISPATCH[name] = _needs_native_bridge(name)

    for name in ("workflow_list", "workflow_run", "workflow_status",
                 "workflow_gate", "workflow_resume", "workflow_cancel",
                 "workflow_artifacts"):
        _DISPATCH[name] = _workflow(name)

    _DISPATCH["suite_launch"] = _suite_launch
    _DISPATCH["suite_status"] = _suite_status
    _DISPATCH["suite_stop"] = _suite_stop

    _DISPATCH["data_partitions"] = _data_partitions
    _DISPATCH["data_query"] = _data_query
    _DISPATCH["data_aggregate"] = _data_aggregate

    _DISPATCH["pipeline_run"] = _pipeline_run

    _DISPATCH["fault_diagnose"] = _unavailable(
        "fault_diagnose 需要 agent 推理（五阶段链路里的 fault_diagnosis 阶段），"
        "不是确定性函数；本服务不伪造归因结论。走 pipeline_run 触发完整链路。")
    _DISPATCH["pipeline_status"] = _unavailable(
        "pipeline_status 需要跨进程的运行登记表（DBOS run_link），"
        "当前版本未接；A 线接入后在此填充。")


def _unavailable(reason: str) -> Callable[[dict, dict], dict]:
    def run(args: dict, ctx: dict) -> dict:  # noqa: ARG001
        raise ToolUnavailable(reason)
    return run


def _needs_native_bridge(name: str) -> Callable[[dict, dict], dict]:
    def run(args: dict, ctx: dict) -> dict:
        node_url = ctx.get("node_url")
        if not node_url:
            raise ToolUnavailable(
                f"{name} 需要 Node 服务地址（native 工具桥未配置）。"
                "请以 node_url=... 构造服务，或先起套件 Node 服务。")
        raise ToolUnavailable(
            f"{name} 的 Node 桥在 node_url={node_url} 上没有可用实现；"
            "本服务不伪造返回。")
    return run


def _invoke_tool(tool: Any, args: dict, ctx: dict) -> dict:
    """调用一个 ``Tool`` 协议对象，并把 ``ToolResult`` 转成契约的返回/错误形状。"""
    result = tool.invoke(args)
    if not getattr(result, "ok", False):
        return {"ok": False,
                "error": {"code": "E_ARG", "message": str(result.error or "调用失败"),
                          "retryable": False}}
    return {"ok": True, "data": dict(result.data or {})}


# ---- 写类工具（在函数体内延迟 import，避免 import 期副作用）
def _execute_device_action(args: dict, ctx: dict) -> dict:
    from .agents.tools.work_order_tools import ExecuteDeviceActionTool

    return _invoke_tool(ExecuteDeviceActionTool(), args, ctx)


def _create_work_order(args: dict, ctx: dict) -> dict:
    from .agents.tools.work_order_tools import CreateWorkOrderTool

    return _invoke_tool(CreateWorkOrderTool(_work_order_service(ctx)), args, ctx)


def _list_work_orders(args: dict, ctx: dict) -> dict:
    service = _work_order_service(ctx)
    items = [o.to_dict() for o in service.list_all()]
    status = args.get("status")
    if status:
        items = [o for o in items if o.get("status") == status]
    station = args.get("station_id")
    if station:
        items = [o for o in items if o.get("station_id") == station]
    limit = args.get("limit") or 50
    return {"ok": True, "data": {"items": items[:int(limit)], "count": len(items[:int(limit)])}}


def _update_work_order(args: dict, ctx: dict) -> dict:
    service = _work_order_service(ctx)
    order = service.transition(args["work_order_id"], args["status"])
    return {"ok": True, "data": {"order": order.to_dict()}}


def _work_order_service(ctx: dict):
    service = ctx.get("work_order_service")
    if service is not None:
        return service
    from .store.work_order import WorkOrderService

    service = WorkOrderService()
    ctx["work_order_service"] = service
    return service


def _archive_export(args: dict, ctx: dict) -> dict:
    from .agents.tools.archive_tools import archive_export_tool

    root = ctx.get("exports_dir") or (ROOT / "data" / "exports")
    return _invoke_tool(archive_export_tool(root), args, ctx)


def _kb_search(args: dict, ctx: dict) -> dict:
    """``kb_search`` 是契约名；实现仍叫 ``knowledge_search``（契约 §4 要求保留别名）。"""
    from .agents.knowledge import KnowledgeBase, knowledge_search_tool, load_documents

    kb = ctx.get("knowledge_base")
    if kb is None:
        # 写盘位置放在 ctx 指定的数据目录，**绝不**默认写仓库内的已入库文件。
        base = Path(ctx.get("data_dir") or (ROOT / "data" / "kb"))
        kb_path = base / "kb.sqlite3"
        kb = KnowledgeBase(kb_path)
        docs = ROOT / "data" / "kb" / "knowledge.jsonl"
        if docs.is_file():
            kb.index(load_documents(docs))
        ctx["knowledge_base"] = kb
    return _invoke_tool(knowledge_search_tool(kb),
                        {"query": args["query"], "limit": args.get("limit") or 5}, ctx)


def _workflow(name: str) -> Callable[[dict, dict], dict]:
    def run(args: dict, ctx: dict) -> dict:
        from .agents.tools import rpa_bridge

        tools = {t.name: t for t in rpa_bridge.build_tools(
            repo_root=ctx.get("repo_root") or ROOT,
            data_dir=ctx.get("data_dir"),
            jobs_root=ctx.get("jobs_root"),
            driver=ctx.get("driver"))}
        tool = tools.get(name)
        if tool is None:
            raise ToolUnavailable(f"工作流工具 {name} 未能构造（缺 rpa_bridge 依赖）")
        return _invoke_tool(tool, args, ctx)
    return run


def _suite_launch(args: dict, ctx: dict) -> dict:
    import tools.suite_launcher as sl  # 仓库根在 sys.path 上

    info = sl.find_suite(ctx.get("suite_root"))
    launched = sl.launch(info, wait_ready=bool(args.get("wait_ready", True)),
                         timeout=float(args.get("timeout_s") or 90),
                         cdp_port=args.get("port"))
    return {"ok": True, "data": {"suite": launched}}


def _suite_status(args: dict, ctx: dict) -> dict:
    import tools.suite_launcher as sl

    pid = args.get("pid")
    if pid is None:
        raise ToolUnavailable("suite_status 需要 pid；本服务不扫描进程表猜测")
    return {"ok": True, "data": {"suite": sl.status(int(pid))}}


def _suite_stop(args: dict, ctx: dict) -> dict:
    import tools.suite_launcher as sl

    stopped = sl.stop(int(args["pid"]), timeout=float(args.get("timeout_s") or 5))
    return {"ok": True, "data": {"suite": stopped}}


def _data_root(ctx: dict) -> Path:
    return Path(ctx.get("data_dir") or (ROOT / "data" / "public"))


def _data_partitions(args: dict, ctx: dict) -> dict:
    from .data.manifest import iter_data_files

    root = _data_root(ctx)
    parts = []
    for p in iter_data_files(root, station=args.get("station"),
                             date=args.get("date")):
        st = p.stat()
        rel = p.relative_to(root).as_posix()
        parts.append({"path": rel, "bytes": st.st_size})
    return {"ok": True, "data": {"partitions": parts, "count": len(parts)}}


def _data_query(args: dict, ctx: dict) -> dict:
    from .data.engines import EngineUnavailable, get_engine

    engine_name = args.get("engine") or "duckdb"
    try:
        engine = get_engine(engine_name, root=_data_root(ctx))
    except EngineUnavailable as exc:
        return {"ok": False,
                "error": {"code": "E_UNAVAILABLE", "message": str(exc), "retryable": True}}
    result = engine.execute(args["sql"])
    return {"ok": True, "data": {
        "columns": list(getattr(result, "columns", []) or []),
        "rows": [list(r) for r in (getattr(result, "rows", []) or [])],
        "row_count": len(getattr(result, "rows", []) or []),
        "engine": engine_name,
    }}


def _data_aggregate(args: dict, ctx: dict) -> dict:
    from .data.query import QueryEngine

    spec = {
        "group_by": list(args.get("group_by") or []),
        "aggregates": list(args.get("agg") or []),
        "station": args.get("station"),
        "date": args.get("date"),
    }
    result = QueryEngine(_data_root(ctx)).execute(**spec)
    return {"ok": True, "data": {
        "columns": list(result.columns),
        "rows": [list(r) for r in result.rows],
        "row_count": len(result.rows),
    }}


def _pipeline_run(args: dict, ctx: dict) -> dict:
    raise ToolUnavailable(
        "pipeline_run 需要构造五阶段 PipelineStage 列表与消息总线；"
        "本服务不替调用方决定阶段顺序。请用 graph.five_stage.run_five_stage。")


# --------------------------------------------------------------------- 服务
@dataclass
class DispatchContext:
    """分发上下文。**显式传，不用全局单例**——测试要能并行、要能隔离。"""

    repo_root: Path = ROOT
    data_dir: Path | None = None
    exports_dir: Path | None = None
    jobs_root: Path | None = None
    node_url: str | None = None
    token: str | None = None
    suite_root: str | Path | None = None
    driver: str | None = None
    work_order_service: Any = None
    knowledge_base: Any = None
    ledger: ApprovalLedger = field(default_factory=DenyAllLedger)

    def as_dict(self) -> dict:
        return {
            "repo_root": self.repo_root,
            "data_dir": self.data_dir,
            "exports_dir": self.exports_dir,
            "jobs_root": self.jobs_root,
            "node_url": self.node_url,
            "token": self.token,
            "suite_root": self.suite_root,
            "driver": self.driver,
            "work_order_service": self.work_order_service,
            "knowledge_base": self.knowledge_base,
        }


def _coerce_default(param: Param) -> Any:
    if param.default is None:
        return None
    raw = param.default
    try:
        if param.type == "integer":
            return int(raw)
        if param.type == "number":
            return float(raw)
        if param.type == "boolean":
            return raw.strip().lower() in ("true", "1", "yes")
    except ValueError:
        return None
    if param.type in ("array", "object"):
        return None
    return raw


def _annotation(param: Param) -> type:
    return _TYPE_MAP.get(param.type, str)


def make_handler(spec: ToolSpec, ctx: DispatchContext) -> Callable[..., dict]:
    """按契约入参生成一个**签名正确**的分发函数。

    MCP 的入参 Schema 由函数签名推导（``FuncMetadata`` 用 ``inspect.signature``），
    所以要真正设 ``__signature__``，不能只标 ``**kwargs``——那会让 Schema 变成空对象，
    模型永远不知道该传什么。
    """
    approval_param = None
    if spec.needs_approval:
        approval_param = inspect.Parameter(
            "approval_id", inspect.Parameter.KEYWORD_ONLY, annotation=str, default="")

    params: list[inspect.Parameter] = []
    for p in spec.params:
        default = _coerce_default(p)
        if p.required or default is None:
            if p.required:
                params.append(inspect.Parameter(
                    p.name, inspect.Parameter.KEYWORD_ONLY, annotation=_annotation(p)))
            else:
                params.append(inspect.Parameter(
                    p.name, inspect.Parameter.KEYWORD_ONLY,
                    annotation=_annotation(p) | None, default=None))
        else:
            params.append(inspect.Parameter(
                p.name, inspect.Parameter.KEYWORD_ONLY,
                annotation=_annotation(p), default=default))
    if approval_param is not None:
        params.append(approval_param)

    def handler(**kwargs: Any) -> dict:
        approval_id = kwargs.pop("approval_id", "")
        if spec.needs_approval:
            if not approval_id:
                return {"ok": False, "error": {
                    "code": "E_APPROVAL_REQUIRED",
                    "message": (f"{spec.name} 是高风险工具（risk={spec.risk}，"
                                f"审批={spec.approval}）：必须先拿到 approval_id 才能调用"),
                    "retryable": False}}
            if not ctx.ledger.is_approved(approval_id):
                return {"ok": False, "error": {
                    "code": "E_APPROVAL_DENIED",
                    "message": f"审批 {approval_id!r} 未通过或已失效，{spec.name} 未执行",
                    "retryable": False}}
        impl = _DISPATCH.get(spec.name)
        if impl is None:
            return {"ok": False, "error": {
                "code": "E_UNAVAILABLE",
                "message": f"{spec.name} 已登记但未接实现",
                "retryable": False}}
        try:
            return impl(kwargs, ctx.as_dict())
        except ToolUnavailable as exc:
            return {"ok": False, "error": {
                "code": "E_UNAVAILABLE", "message": str(exc), "retryable": True}}
        except Exception as exc:  # noqa: BLE001 —— 领域错误要变成结构，不穿成栈
            return {"ok": False, "error": {
                "code": "E_INTERNAL",
                "message": f"{type(exc).__name__}: {exc}",
                "retryable": True}}

    handler.__name__ = spec.name
    handler.__doc__ = spec.description
    handler.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]
    return handler


def build_server(specs: list[ToolSpec] | None = None,
                 ctx: DispatchContext | None = None,
                 name: str = "fsa-tools"):
    """构造 MCP 服务。**不在这里跑**，方便测试与嵌入（A/B 两侧各拿一个客户端）。"""
    from mcp.server.mcpserver import MCPServer

    tools = specs if specs is not None else load_tools()
    context = ctx or DispatchContext()
    if not _DISPATCH:
        _register_default_implementations()

    server = MCPServer(name)
    for spec in tools:
        server.add_tool(make_handler(spec, context), name=spec.name,
                        description=spec.description)
    return server


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass

    ap = argparse.ArgumentParser(description="MCP 工具面服务（Streamable HTTP）")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--check", action="store_true",
                    help="只解析契约并报告工具数，不起服务")
    args = ap.parse_args(argv)

    try:
        specs = load_tools()
    except ContractError as exc:
        print(f"[阻断] {exc}")
        return 2

    if len(specs) != EXPECTED_TOOLS:
        print(f"[阻断] 契约要求 {EXPECTED_TOOLS} 条工具，解析出 {len(specs)} 条")
        return 2

    names = [s.name for s in specs]
    if len(set(names)) != len(names):
        dup = sorted({n for n in names if names.count(n) > 1})
        print(f"[阻断] 契约里有重名工具：{dup}")
        return 2

    if args.check:
        print(f"[一致] {len(specs)} 条工具，风险级分布：")
        for risk in RISK_LEVELS:
            print(f"  {risk:<7} {sum(1 for s in specs if s.risk == risk)}")
        print(f"  需审批  {sum(1 for s in specs if s.needs_approval)}")
        return 0

    server = build_server(specs)
    print(f"MCP_TOOLS_READY http://{args.host}:{args.port}/mcp "
          f"({len(specs)} tools)", flush=True)
    server.run(transport="streamable-http", host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
