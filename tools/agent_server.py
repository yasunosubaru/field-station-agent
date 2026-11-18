#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌面版 Agent 的本地 HTTP 服务（WP2）。

契约见 ``docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md`` §2–§3：

```text
python tools/agent_server.py --port 0 --token <hex> \
    --node-url http://127.0.0.1:<nodePort> --repo <root> --data-dir <dir>
→ stdout: AGENT_READY <agentPort>
```

## 边界

* 只监听 ``127.0.0.1``；每个请求都要 ``Authorization: Bearer <token>``。
* 请求体上限 5 MB；超了直接 413，不读进内存。
* 错误统一 ``{ok:false,error,class}``；``class`` 取契约的五个值。
* 事件先落盘、再写 SSE：客户端中途断开时，会话文件里仍是完整的一轮，
  重新打开会话可以重放；连接断了不影响这次运行跑完。
* ``done`` 是**流的结束标记**，不写进会话 JSONL —— 会话重放不需要它，
  而且一次运行只有一个结束点。
* 不打印 token、不打印本机绝对路径。日志里最多出现异常类名。

## 线程模型

``ThreadingHTTPServer``：每个连接一个线程。同一会话同时只允许一个运行
（第二个请求回 409），否则两条运行会交错写同一个 JSONL，事件顺序就废了。
审批与取消都是「服务端状态 + ``threading.Event``」，没有轮询文件的延迟。
"""
from __future__ import annotations

import argparse
import hmac
import importlib
import inspect
import json
import math
import mimetypes
import os
import re
import sys
import threading
import time
from datetime import date as _date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


# --- 按路径加载同目录模块（打包后 sys.path 里没有 tools/）----------------------
# 由 tools/apply_loader_safe.py 生成。为什么不用裸导入、为什么必须写 sys.modules，
# 见那个脚本的模块文档（和 tools/cdp_driver.py::_load_click_engine 的实现）。
def _fsa_load_sibling(name: str):
    """加载与当前文件同目录的 ``<name>.py``，返回模块对象。"""
    import importlib.util as _iu
    import sys as _sys
    from pathlib import Path as _P

    alias = f"_fsa_tool_{name}"
    cached = _sys.modules.get(alias)
    if cached is not None:
        return cached
    path = _P(__file__).with_name(f"{name}.py")
    if not path.is_file():
        raise ImportError(f"同目录缺少 {name}.py（{path}）")
    spec = _iu.spec_from_file_location(alias, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {path}")
    module = _iu.module_from_spec(spec)
    # dataclasses 解析字符串注解时要靠 sys.modules 找到模块，必须先注册。
    _sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
for _path in (str(REPO_ROOT / "src"), str(TOOLS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

# 按路径加载：写成 `from agent_store import ...` 只有在 tools/ 进 sys.path 时成立，
# 打成自包含包后必然 ImportError（tools/probe_packaged_imports.py 盯着这条）。
_agent_store_mod = _fsa_load_sibling("agent_store")
SessionNotFound = _agent_store_mod.SessionNotFound
SessionStore = _agent_store_mod.SessionStore
StoreError = _agent_store_mod.StoreError
default_data_dir = _agent_store_mod.default_data_dir
from fieldstation.agents import orchestrator  # noqa: E402
from fieldstation.agents.demo_provider import DemoProvider  # noqa: E402

AGENT_VERSION = "1.0.0"
MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 100_000
MAX_TITLE_CHARS = 200
PROVIDERS = ("fake", "openai_compatible", "ollama")
DEFAULT_SETTINGS = {
    "provider": "openai_compatible",
    "base_url": "",
    "model": "",
    "temperature": 0.0,
}
ERROR_CLASSES = ("environment", "input", "execution", "artifact", "capability")


# --------------------------------------------------------------------------
# 错误
# --------------------------------------------------------------------------

class ApiError(Exception):
    """带 HTTP 状态与契约错误类的失败。"""

    def __init__(self, status: int, message: str, error_class: str = "input",
                 *, close: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.error_class = error_class if error_class in ERROR_CLASSES else "execution"
        self.close = close


class _BodyTooLarge(ApiError):
    def __init__(self) -> None:
        super().__init__(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                         f"请求体超过上限 {MAX_BODY_BYTES} 字节", "input",
                         close=True)


class _Approval:
    """一次待决审批。``event`` 被 set 之后 ``decision`` 才有意义。"""

    def __init__(self, approval_id: str, call_id: str) -> None:
        self.approval_id = approval_id
        self.call_id = call_id
        self.event = threading.Event()
        self.decision: str | None = None
        self.note: str = ""


class _RunState:
    """一次运行的可变状态：取消标志与待决审批表。"""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.cancel = threading.Event()
        self.approvals: dict[str, _Approval] = {}
        self.client_gone = False


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _secret_module():
    """延迟 import WP3 的 ``tools/secret_store.py``；不在就返回 None。"""
    try:
        return importlib.import_module("secret_store")
    except Exception:
        return None


def _callable(module, names: tuple[str, ...]):
    for name in names:
        candidate = getattr(module, name, None)
        if callable(candidate):
            return candidate
    return None


def _call_with_key(func, key: str | None):
    """按签名猜调用形状：``fn(key)`` 或 ``fn(name, key)``。

    secret_store 由另一个工作包实现，接口名未冻结；只容忍 ``TypeError``
    （签名不匹配），真正的存储失败要原样抛给调用方 —— 静默吞掉会让用户以为
    key 存进去了。
    """
    if key is None:
        try:
            return func()
        except TypeError:
            return func("openai_api_key")
    try:
        return func(key)
    except TypeError:
        return func("openai_api_key", key)


def _filter_kwargs(func, kwargs: dict) -> dict:
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return {}
    params = signature.parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)
    return {name: value for name, value in kwargs.items() if name in params}


def _load_ollama_config(repo_root: Path) -> dict:
    """``config/providers.json`` 的 ollama 段，``providers.local.json`` 覆盖它。"""
    config: dict = {}
    for name in ("providers.json", "providers.local.json"):
        path = Path(repo_root) / "config" / name
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, dict):
            section = raw.get("providers", raw)
            if isinstance(section, dict):
                ollama = section.get("ollama")
                if isinstance(ollama, dict):
                    config.update(ollama)
    return config


def _source_of(name: str, tool) -> str:
    explicit = getattr(tool, "source", None)
    if isinstance(explicit, str) and explicit:
        return explicit
    if name.startswith("native_"):
        return "native"
    if name.startswith("workflow_"):
        return "rpa"
    return "local"


def _tool_description(tool) -> dict:
    return {
        "name": tool.name,
        "description": getattr(tool, "description", "") or "",
        "risk": getattr(tool, "risk", "medium") or "medium",
        "source": _source_of(tool.name, tool),
        "params": getattr(tool, "params", {}) or {},
    }


# --------------------------------------------------------------------------
# 编队 / 数据 / 套件：HTTP 出口
#
# 三个前端视角（`web/views/fleet.js` / `data.js` / `suite.js`）各自写死了要读的
# 键名，所以这一节的形状**不由本文件决定**，而是逐字照着那三个文件填：
#
#   GET  /board/forest            {"tasks":[…], "pending":[…]}   fleet.js:436
#   GET  /board/tree?task_id=     {"root","steps","children","counts"}  fleet.js:394-401
#   GET  /board/events?task_id=   **[…]**（裸数组，fleet.js:454 用 Array.isArray）
#   GET  /board/pending           {"pending":[…]}
#   POST /board/intervene         {"intervention":{…}, "effective_at":{…}}
#   GET  /data/batches            {"batches":[{id,station,date,period,rows,partitions,bytes}]}
#   GET  /data/quality?batch=     {"counts":{missing,jumps,outOfRange,…Rate,rows}, "engineDown":bool}
#   GET  /data/search?batch=&q=   {question,value,sql,partition,rows,engine,elapsedMs,missingField}
#   GET  /data/eval?batch=        {"results":{"S1":true|false|null,…}}
#   GET  /suite/field-parity      text/markdown（suite.js 直接 .text() 再 parse）
#
# 业务逻辑一行都不在这里重写：编队走 `botd.interaction.InteractionBoard`，批次走
# `data.manifest.PartitionManifest`，质控阈值走 `rules.verdict` 的 R-4.2/R-4.3，
# 检索走 `data.knowledge.answer_question`，评测走 `tools/eval30_judge.py` 的判分器。
# 本文件只做「取参 → 调那一层 → 摊成前端认得的键」。
# --------------------------------------------------------------------------

#: 质控单次最多扫多少行。超过就如实报 `truncated`，不假装扫完了。
DATA_ROW_LIMIT = 500_000

#: 批次 id 就是 `station/date`（fleet/data 两侧都按这个拼）。
BATCH_ID_RE = re.compile(r"^([^/\\]{1,64})/(\d{4}-\d{2}-\d{2})$")


def _query_params(raw_path: str) -> dict:
    """查询串 → 单值字典（重复键取最后一个）。"""
    parsed = parse_qs(urlparse(raw_path).query, keep_blank_values=True)
    return {key: values[-1] for key, values in parsed.items()}


def _data_root(repo_root: Path) -> Path:
    """NDJSON 分区根。``FSA_DATA_ROOT`` 覆盖，默认 ``<repo>/data/warehouse``。"""
    override = os.environ.get("FSA_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser()
    return Path(repo_root) / "data" / "warehouse"


def _manifest_of(root: Path):
    """读清单；根目录不存在时返回 ``(None, note)``，**不扫盘**（扫盘是显式动作）。"""
    from fieldstation.data.manifest import PartitionManifest

    if not root.is_dir():
        return None, (f"数据根 {root.as_posix()} 不存在：导入一份抓包成 NDJSON 分区后"
                      "这里才会出现批次")
    try:
        return PartitionManifest.load(root), ""
    except Exception as exc:  # noqa: BLE001 - 清单坏掉是环境问题，原样报给界面
        raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                       f"清单读不了（{type(exc).__name__}）", "environment") from exc


def _batches_of(manifest) -> list[dict]:
    """把分区卡按 (station, date) 折成「批次」——数据视角那一屏的单位。"""
    groups: dict[tuple[str, str], dict] = {}
    for meta in manifest.sorted():
        key = (meta.station, meta.date)
        item = groups.get(key)
        if item is None:
            item = groups[key] = {
                "rows": 0, "partitions": 0, "bytes": 0,
                "hours": set(), "low": None, "high": None,
            }
        item["rows"] += int(meta.rows)
        item["partitions"] += 1
        item["bytes"] += int(meta.bytes)
        item["hours"].add(meta.hour)
        for value, slot, better in ((meta.min_time, "low", min), (meta.max_time, "high", max)):
            if not value:
                continue
            current = item[slot]
            item[slot] = value if current is None else better(str(current), str(value))

    out: list[dict] = []
    for (station, date), item in sorted(groups.items()):
        low, high = item["low"], item["high"]
        out.append({
            "id": f"{station}/{date}",
            "station": station,
            "date": date,
            # `period` 是界面上「时段」那一格；缺时间戳就是日期本身，不编一个区间。
            "period": f"{low} … {high}" if low and high else date,
            "rows": item["rows"],
            "partitions": item["partitions"],
            "bytes": item["bytes"],
            "hours": len(item["hours"]),
            "first_time": low,
            "last_time": high,
        })
    return out


def _cn0_of(row: dict):
    """一行里的 CN0；缺失返回 ``None``。``bool`` 不算数（它是 ``int`` 的子类）。"""
    value = row.get("cn0_dbhz")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _quality_of(root: Path, station: str, date: str) -> dict:
    """三类计数：缺测 / 跳变 / 越界。

    判据一律用仓库已有的那一套，不在这里另定阈值：

    * **缺测** —— CN0 缺失的行数；比例按 ``rules.verdict.missing_rate_verdict``
      的 R-4.3（缺测率 ≤ 5% 合格）判；
    * **越界** —— CN0 低于 ``rules.verdict.RULES["R-4.2"]`` 的下限（30 dB-Hz）；
    * **跳变** —— ``quality_flag`` 带 ``constants.BIT_SLIP`` 的行。周跳位是
      ``rules/qc.detect_slips`` 在 0.5 TECU 门限下打上的，所以这里数位而不是重算。
    """
    from fieldstation import constants as C
    from fieldstation.data.query import iter_rows
    from fieldstation.rules import verdict as V

    floor = V.RULES["R-4.2"].threshold
    rows = missing = jumps = out_of_range = 0
    cn0_values: list[float] = []
    truncated = False

    for row in iter_rows(root, station=station, date=date):
        if rows >= DATA_ROW_LIMIT:
            truncated = True
            break
        rows += 1
        value = _cn0_of(row)
        if value is None:
            missing += 1
        else:
            cn0_values.append(value)
            if value < floor:
                out_of_range += 1
        flag = row.get("quality_flag")
        if isinstance(flag, int) and not isinstance(flag, bool) and flag & C.BIT_SLIP:
            jumps += 1

    def rate(count: int):
        return (count / rows) if rows else None

    return {
        "rows": rows,
        "missing": missing,
        "jumps": jumps,
        "outOfRange": out_of_range,
        "missingRate": rate(missing),
        "jumpsRate": rate(jumps),
        "outOfRangeRate": rate(out_of_range),
        "truncated": truncated,
        "scanned": rows,
        # 两条能直接回源的裁决：界面不显示，但把「凭什么这么算」留在响应里。
        "rules": {
            "R-4.2": V.cn0_verdict(cn0_values),
            "R-4.3": V.missing_rate_verdict(rows, missing),
        },
    }


def _eval_results(repo_root: Path, batch_id: str):
    """``logs/eval/<runtime>/<task>.jsonl`` → S1–S6 的通过与否。

    评测日志按**任务编号**（EV-01…EV-30）归档，不按批次。所以只有当日志名正好是
    这个批次时才给结果；否则返回 ``(None, note)`` —— 界面据此显示六个 `?`（未跑），
    而不是编六个 ✓。
    """
    override = os.environ.get("FSA_EVAL_ROOT", "").strip()
    base = Path(override).expanduser() if override else (Path(repo_root) / "logs" / "eval")
    if not base.is_dir():
        return None, "还没有评测日志：logs/eval/<runtime>/<task>.jsonl 不存在"
    runtimes = sorted(p.name for p in base.iterdir() if p.is_dir())
    if not runtimes:
        return None, "logs/eval 下没有任何 runtime 目录"

    wanted = {batch_id, batch_id.replace("/", "_")}
    files = [p for runtime in runtimes
             for p in (base / runtime).glob("*.jsonl") if p.stem in wanted]
    if not files:
        known = sorted(p.stem for runtime in runtimes
                       for p in (base / runtime).glob("*.jsonl"))[:8]
        return None, (f"评测日志按任务编号归档（现有：{'、'.join(known) or '无'}），"
                      f"没有与批次 {batch_id} 对应的结果")

    source = files[0]
    try:
        # 按路径加载：这行原来是 `import eval30_judge  # tools/ 已在 sys.path 上`，
        # 只在源码树里成立；打成自包含包后 tools/ 不在 sys.path，会 ImportError。
        eval30_judge = _fsa_load_sibling("eval30_judge")

        tasks = {task.task_id: task for task in eval30_judge.load_tasks()}
        task = tasks.get(source.stem)
        if task is None:
            return None, f"{source.stem} 不在评测契约的任务清单里"
        row = eval30_judge.judge_one(task, source, None)
    except Exception as exc:  # noqa: BLE001 - 判分器缺失/日志坏了，报原因不报假结果
        return None, f"判分失败（{type(exc).__name__}）：日志 {source.name}"

    failed = set(row.get("failed_rules") or [])
    manual = set(row.get("manual_rules") or [])
    results = {}
    for rule in eval30_judge.RULES:
        if rule not in task.rules:
            results[rule] = None            # 这条任务不考这一项
        elif rule in failed:
            results[rule] = False
        elif rule in manual:
            results[rule] = None            # 需人工判定
        else:
            results[rule] = True
    return {"results": results, "source": f"logs/eval/{source.parent.name}/{source.name}",
            "task_id": task.task_id, "finished_with": row.get("finished_with", "")}, ""


def _bots_of(board) -> list[dict]:
    """把 bot 表与顶层任务折成界面左栏那一列。

    ``fleet.js`` 读 ``{bot_id, name, status, current_task_id, task_count}``：

    * ``current_task_id`` —— 这个 bot 最近的、还没进终态的任务；没有就是空串。
      取「最近」而不是「随便一个」：一个 bot 可能跑过很多任务，左栏要的是**现在**。
    * ``task_count`` —— 这个 bot 一共有多少任务（含历史），给的是规模感，不是进度。
    * ``status`` —— bot 自己的状态（``active`` / ``paused`` / ``retired``）；
      界面的三档（running / waiting_operator / idle）是**任务**状态，不是 bot 状态。
      所以把 ``current_task`` 的状态一并带出来，界面据此上色（见 ``_bots_of`` 的
      ``current_task_status``），而不是猜。
    """
    try:
        bots = board.store.list_bots()
        tasks = board.store.list_tasks()
    except Exception:  # noqa: BLE001 - 看板没数据就是空列表，不把整块打成 500
        return []

    terminal = {"done", "failed", "dead", "cancelled"}
    by_bot: dict[str, list[dict]] = {}
    for task in tasks:
        owner = str(task.get("bot_id") or "")
        if owner:
            by_bot.setdefault(owner, []).append(task)

    out: list[dict] = []
    for bot in bots:
        bot_id = str(bot.get("id") or "")
        owned = by_bot.get(bot_id, [])
        owned.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        current = next((item for item in owned
                        if str(item.get("status") or "") not in terminal), None)
        out.append({
            "bot_id": bot_id,
            "name": str(bot.get("name") or bot_id),
            "status": str(bot.get("status") or "active"),
            "role": str(bot.get("role") or ""),
            "current_task_id": str((current or {}).get("task_id") or ""),
            "current_task_status": str((current or {}).get("status") or ""),
            "task_count": len(owned),
        })
    return out


def _step_view(step: dict) -> dict:
    """一步摊成界面直接读的那一组键（``fleet.js`` 的步骤时间线）。

    库里叫 ``id`` / ``tools`` / ``output`` / ``error`` / ``attempts``；界面读
    ``step_id`` / ``tool`` / ``input`` / ``output`` / ``elapsed_ms`` / ``attempts``。

    ``elapsed_ms`` 只在**知道**时给：``updated_at - created_at`` 是一个真实的时长
    （这一步从入队到最近一次变动），但 ``pending`` 的步骤这个差不代表「执行了多久」。
    所以按状态给：跑完/失败/跳过给差值，其余给 ``None`` —— 界面画 `—`，不猜。
    """
    from fieldstation.botd.store import from_iso

    status = str(step.get("status") or "")
    elapsed = None
    if status in ("done", "failed", "skipped"):
        try:
            start = from_iso(str(step.get("created_at") or ""))
            end = from_iso(str(step.get("updated_at") or ""))
            elapsed = max(0.0, (end - start).total_seconds() * 1000.0)
        except (TypeError, ValueError):
            elapsed = None

    tools = step.get("tools") or []
    return {
        "step_id": str(step.get("id") or ""),
        "name": str(step.get("name") or ""),
        "kind": str(step.get("kind") or ""),
        "status": status,
        # 界面只显示一个工具名；多工具时给第一个，全部仍留在 `tools` 里。
        "tool": str(tools[0]) if tools else "",
        "tools": list(tools),
        "input": step.get("input") if "input" in step else step.get("task_ref"),
        "output": step.get("output"),
        "error": step.get("error"),
        "attempts": int(step.get("attempts") or 0),
        "acceptance": str(step.get("acceptance") or ""),
        "task_ref": step.get("task_ref"),
        "created_at": step.get("created_at"),
        "updated_at": step.get("updated_at"),
        "elapsed_ms": elapsed,
    }


def _event_view(event: dict) -> dict:
    """一条事件摊成 ``{seq, kind, call_id, tool, ts}`` + 原始字段。

    ``event_stream()`` 给的是 ``{phase, at, label, step_id, error, …}`` —— 那是
    给人读的流。界面读的是 ``kind`` / ``ts`` / ``tool`` / ``call_id``。两套名字指同
    几条记录，所以这里做一次显式改写并**保留全部原始键**：下游要 `label` 也拿得到。
    """
    phase = str(event.get("phase") or "")
    out = {
        "seq": event.get("seq"),
        "kind": phase,
        "ts": event.get("at"),
        "tool": str(event.get("tool") or ""),
        "call_id": str(event.get("call_id") or event.get("step_id") or ""),
        "label": str(event.get("label") or ""),
        "step": str(event.get("step") or ""),
        "error": str(event.get("error") or ""),
    }
    # 保留原始键（`phase` / `at` / `attempts` / `intervention_id` …）：改写不是裁剪。
    return {**event, **out}


def _require_batch(query: dict) -> tuple[str, str]:
    """``?batch=station/date`` → ``(station, date)``；缺参或不合法都是 400。

    日期按**真日历**校验，不是只看形状：``2026-13-99`` 能过正则，却会在后面变成
    一个永远查不到的分区 —— 那种「静默查空」比 400 难查得多。
    """
    raw = (query.get("batch") or "").strip()
    if not raw:
        raise ApiError(HTTPStatus.BAD_REQUEST, "缺少 batch 参数（形如 WUHN/2026-11-07）", "input")
    match = BATCH_ID_RE.match(raw)
    if not match:
        raise ApiError(HTTPStatus.BAD_REQUEST,
                       f"batch 必须形如 station/date（YYYY-MM-DD），收到 {raw!r}", "input")
    station, date = match.group(1), match.group(2)
    try:
        _date.fromisoformat(date)
    except ValueError as exc:
        raise ApiError(HTTPStatus.BAD_REQUEST,
                       f"batch 的日期不是合法日期：{date!r}", "input") from exc
    return station, date


# --------------------------------------------------------------------------
# 服务对象
# --------------------------------------------------------------------------

class AgentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, *, store: SessionStore, token: str,
                 repo_root: Path, node_url: str | None,
                 approval_timeout: float = orchestrator.APPROVAL_TIMEOUT_DEFAULT,
                 provider_factory=None, tool_registry=None,
                 registry_factory=None) -> None:
        super().__init__(address, handler)
        self.store = store
        self.token = token
        self.repo_root = Path(repo_root)
        self.node_url = node_url
        self.approval_timeout = float(approval_timeout)
        self.provider_factory = provider_factory
        self.tool_registry = tool_registry
        self.registry_factory = registry_factory
        self.warnings: list[str] = []
        self._warning_set: set[str] = set()
        self._registries: dict[str, object] = {}
        self._registries_lock = threading.RLock()
        self.active_runs: dict[str, _RunState] = {}
        self.runs_lock = threading.RLock()
        self._work_orders = None
        # 编队看板：懒加载一份，整个进程共用（InteractionBoard 本身无状态）。
        self.board_lock = threading.RLock()
        self._board = None

    # ---- 工具注册表 ----------------------------------------------------

    def warn(self, message: str) -> None:
        if message in self._warning_set:
            return
        self._warning_set.add(message)
        self.warnings.append(message)
        # 只报模块名/工具名，不带绝对路径。
        sys.stderr.write(f"[agent] {message}\n")
        sys.stderr.flush()

    def registry(self, session_id: str | None):
        key = session_id or ""
        with self._registries_lock:
            cached = self._registries.get(key)
            if cached is not None:
                return cached
        if self.tool_registry is not None:
            registry = self.tool_registry
        elif self.registry_factory is not None:
            registry = self.registry_factory(session_id)
        else:
            registry = orchestrator.build_registry(
                repo_root=self.repo_root,
                data_dir=self.store.data_dir,
                session_id=session_id,
                node_url=self.node_url,
                token=self.token,
                warnings=_WarningSink(self),
                work_order_service=self._work_orders,
            )
        with self._registries_lock:
            self._registries[key] = registry
        return registry

    # ---- 设置与 provider ------------------------------------------------

    def settings(self) -> dict:
        stored = self.store.read_settings()
        merged = dict(DEFAULT_SETTINGS)
        for key in DEFAULT_SETTINGS:
            if key in stored:
                merged[key] = stored[key]
        # 环境变量优先：打包产物里没有「用户在界面上填设置」这一步，
        # 启动器（start.cmd）通过环境变量把后端地址与模型名传进来。
        # 这几条不设就退回 store 里的值，行为不变。
        env_map = {
            "base_url": ("FSA_OPENAI_BASE_URL", "FSA_AGENT_BASE_URL"),
            "model": ("FSA_OPENAI_MODEL", "FSA_AGENT_MODEL"),
            "provider": ("FSA_AGENT_PROVIDER",),
        }
        for field, names in env_map.items():
            for name in names:
                value = (os.environ.get(name) or "").strip()
                if value:
                    merged[field] = value
                    break
        return merged

    def secret_path(self) -> Path:
        """契约固定 key 落在 ``<data_dir>/secrets.bin``（DPAPI 密文）。"""
        return self.store.data_dir / "secrets.bin"

    def has_key(self) -> bool:
        # 环境变量优先级最高：打包产物由 start.cmd 提供密钥，不走 DPAPI 文件。
        if (os.environ.get("FSA_OPENAI_API_KEY") or "").strip():
            return True
        module = _secret_module()
        path = self.secret_path()
        if module is not None:
            checker = _callable(module, ("has_secret",))
            if checker is not None:
                try:
                    return bool(checker(path))
                except Exception:
                    pass
            loader = _callable(module, ("load_secret",))
            if loader is not None:
                try:
                    value = loader(path)
                except Exception:
                    value = None
                if isinstance(value, str) and value.strip():
                    return True
            reader = _callable(module, ("get_api_key", "load_api_key",
                                        "read_api_key", "get_key", "load_key"))
            if reader is not None:
                try:
                    value = _call_with_key(reader, None)
                except Exception:
                    value = None
                if isinstance(value, str) and value.strip():
                    return True
                if isinstance(value, (bytes, bytearray)) and value:
                    return True
        # 模块缺失时只能看文件在不在；能解开与否由 provider 构造时才发现。
        return path.is_file()

    def fallback_active(self) -> bool:
        """配置层面是否一定会回退 fake。

        与 ``resolve_provider`` 分开：``/settings`` 描述的是**配置**，不受测试
        注入的 ``provider_factory`` 影响，否则界面会显示「没有回退」而实际在
        演示模式里跑。
        """
        settings = self.settings()
        name = settings.get("provider") or "fake"
        if name == "fake":
            return False
        if name == "ollama":
            try:
                importlib.import_module("fieldstation.agents.providers.ollama")
            except Exception:
                return True
            return False
        if not (settings.get("base_url") or "").strip():
            return True
        if not (settings.get("model") or "").strip():
            return True
        if not self.has_key():
            return True
        try:
            importlib.import_module("fieldstation.agents.providers.openai_compatible")
        except Exception:
            return True
        return False

    def read_api_key(self) -> str | None:
        # 环境变量优先级最高（打包产物由 start.cmd 注入）。
        env_key = (os.environ.get("FSA_OPENAI_API_KEY") or "").strip()
        if env_key:
            return env_key
        module = _secret_module()
        if module is None:
            return None
        path = self.secret_path()
        loader = _callable(module, ("load_secret",))
        if loader is not None:
            try:
                value = loader(path)
            except Exception:
                return None
        else:
            reader = _callable(module, ("get_api_key", "load_api_key",
                                        "read_api_key", "get_key", "load_key"))
            if reader is None:
                return None
            try:
                value = _call_with_key(reader, None)
            except Exception:
                return None
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    def save_api_key(self, key: str) -> None:
        module = _secret_module()
        if module is None:
            raise ApiError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "secret_store 模块不可用：api_key 需要 WP3 的 tools/secret_store.py（DPAPI）",
                "capability")
        path = self.secret_path()
        writer = _callable(module, ("save_secret",))
        legacy = _callable(module, ("save_api_key", "set_api_key", "save_key",
                                    "set_key", "write_api_key", "save"))
        if writer is None and legacy is None:
            raise ApiError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "secret_store 没有可用的保存函数（期望 save_secret / save_api_key 之一）",
                "capability")
        try:
            if writer is not None:
                writer(path, key)
            else:
                _call_with_key(legacy, key)
        except ApiError:
            raise
        except Exception as exc:
            raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                           f"api_key 保存失败（{type(exc).__name__}）",
                           "capability") from exc

    def resolve_provider(self):
        """返回 ``(provider, meta)``；构造不出来就回退 fake，并如实标记。"""
        if self.provider_factory is not None:
            produced = self.provider_factory()
            if isinstance(produced, tuple):
                provider, meta = produced
                return provider, dict(meta or {})
            return produced, {"model": getattr(produced, "model", ""),
                              "fake_fallback": False}
        settings = self.settings()
        name = settings.get("provider") or "fake"

        if name == "fake":
            return DemoProvider(model="demo"), {"model": "demo",
                                                "fake_fallback": False}

        if name == "ollama":
            try:
                from fieldstation.agents.providers.base import get_provider

                config = _load_ollama_config(self.repo_root)
                if settings.get("model"):
                    config["model"] = settings["model"]
                return (get_provider("ollama", config),
                        {"model": config.get("model", ""), "fake_fallback": False})
            except Exception as exc:
                return self._fallback(f"ollama 通道不可用（{type(exc).__name__}）")

        base_url = (settings.get("base_url") or "").strip()
        if not base_url:
            return self._fallback("未配置 base_url")
        key = self.read_api_key()
        if not key:
            return self._fallback("未配置 API key")
        try:
            module = importlib.import_module(
                "fieldstation.agents.providers.openai_compatible")
        except Exception as exc:
            return self._fallback(
                f"openai_compatible 模块不可用（{type(exc).__name__}）")
        cls = getattr(module, "OpenAICompatibleProvider", None)
        if not isinstance(cls, type):
            for attr, value in vars(module).items():
                if isinstance(value, type) and attr.endswith("Provider"):
                    cls = value
                    break
        if not isinstance(cls, type):
            return self._fallback("openai_compatible 模块里没有 provider 类")
        model = (settings.get("model") or "").strip()
        if not model:
            return self._fallback("未配置模型名")
        try:
            config = {
                "base_url": base_url,
                "model": model,
                "api_key": key,
                "temperature": settings.get("temperature", 0.0),
            }
            # WP3 的 provider 接收一个 config dict；别的实现可能要好几个关键字参数。
            try:
                parameters = inspect.signature(cls).parameters
            except (TypeError, ValueError):
                parameters = {}
            if "config" in parameters:
                provider = cls(config=config)
            else:
                provider = cls(**_filter_kwargs(cls, config))
        except Exception as exc:
            return self._fallback(
                f"openai_compatible 构造失败（{type(exc).__name__}）")
        return provider, {"model": model, "fake_fallback": False}

    def _fallback(self, reason: str):
        self.warn(f"provider 回退 fake：{reason}")
        return DemoProvider(model="demo"), {"model": "demo",
                                            "fake_fallback": True,
                                            "reason": reason}


class _WarningSink(list):
    """既当列表收集警告，又转发给服务（去重 + 打一行 stderr）。"""

    def __init__(self, server: AgentHTTPServer) -> None:
        super().__init__()
        self._server = server

    def append(self, item) -> None:  # type: ignore[override]
        super().append(item)
        self._server.warn(str(item))


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------

class AgentHandler(BaseHTTPRequestHandler):
    server_version = f"AllPoweredFSA-Agent/{AGENT_VERSION}"
    protocol_version = "HTTP/1.1"

    # 默认实现会把每个请求打到 stderr，里面含路径与查询串；桌面版不需要。
    def log_message(self, fmt, *args):  # noqa: A003
        return

    # ---- 入口 ---------------------------------------------------------

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PATCH(self):
        self._dispatch("PATCH")

    # ---- 分发 ---------------------------------------------------------

    def _dispatch(self, method: str) -> None:
        self._sse_started = False
        try:
            self._authorize()
            parts = self._segments()
            self._route(method, parts)
        except _BodyTooLarge as exc:
            self._send_error(exc, close=True)
        except ApiError as exc:
            self._send_error(exc)
        except SessionNotFound as exc:
            sid = exc.args[0] if exc.args else ""
            self._send_error(ApiError(HTTPStatus.NOT_FOUND,
                                      f"会话不存在：{sid}", "input"))
        except StoreError as exc:
            self._send_error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                                      str(exc), "execution"))
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # 兜底：不回栈、不泄路径
            sys.stderr.write(f"[agent] 未处理异常：{type(exc).__name__}\n")
            sys.stderr.flush()
            if not self._sse_started:
                self._send_error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                                          f"内部错误（{type(exc).__name__}）",
                                          "execution"))
            else:
                self.close_connection = True

    def _segments(self) -> list[str]:
        path = unquote(urlparse(self.path).path)
        # Node 代理理论上会剥前缀；这里再兜一次，免得 /api/agent/health 打到 404。
        if path == "/api/agent":
            path = "/"
        elif path.startswith("/api/agent/"):
            path = path[len("/api/agent"):]
        return [part for part in path.split("/") if part]

    def _authorize(self) -> None:
        header = self.headers.get("Authorization") or ""
        expected = f"Bearer {getattr(self.server, 'token', '')}"
        # 用字节比较：compare_digest 对 str 只接受 ASCII，而请求头可能带任意字节。
        try:
            matched = hmac.compare_digest(header.encode("utf-8", "replace"),
                                          expected.encode("utf-8"))
        except (UnicodeError, TypeError):
            matched = False
        if not matched:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "unauthorized", "capability")

    def _route(self, method: str, parts: list[str]) -> None:
        store: SessionStore = self.server.store

        if parts == ["health"]:
            self._require(method, "GET")
            self._handle_health()
            return
        if parts == ["tools"]:
            self._require(method, "GET")
            self._handle_tools()
            return
        if parts and parts[0] == "board":
            self._route_board(method, parts[1:])
            return
        if parts and parts[0] == "data":
            self._route_data(method, parts[1:])
            return
        if parts and parts[0] == "suite":
            self._route_suite(method, parts[1:])
            return
        if parts == ["settings"]:
            self._require(method, "GET", "POST")
            if method == "GET":
                self._handle_settings_get()
            else:
                self._handle_settings_post()
            return
        if parts == ["sessions"]:
            self._require(method, "GET", "POST")
            if method == "GET":
                self._send_json(HTTPStatus.OK,
                                {"sessions": store.list_sessions()})
            else:
                self._handle_session_create()
            return
        if len(parts) >= 2 and parts[0] == "sessions":
            sid = parts[1]
            self._check_session_id(sid)
            if len(parts) == 2:
                self._require(method, "GET")
                self._handle_session_detail(sid)
                return
            action = parts[2]
            if len(parts) == 3 and action == "message":
                self._require(method, "POST")
                self._handle_message(sid)
                return
            if len(parts) == 3 and action == "approval":
                self._require(method, "POST")
                self._handle_approval(sid)
                return
            if len(parts) == 3 and action == "cancel":
                self._require(method, "POST")
                self._handle_cancel(sid)
                return
            if len(parts) == 3 and action == "artifacts":
                self._require(method, "GET")
                self._send_json(HTTPStatus.OK,
                                {"artifacts": store.list_artifacts(sid)})
                return
            if len(parts) == 4 and action == "artifacts":
                self._require(method, "GET")
                name = parts[3]
                if not name or "/" in name or "\\" in name or name in (".", ".."):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "产物名非法", "input")
                path = store.artifact_dir(sid, create=False) / name
                if not path.is_file():
                    raise ApiError(HTTPStatus.NOT_FOUND, "产物不存在", "input")
                self._send_file(path, name)
                return
        raise ApiError(HTTPStatus.NOT_FOUND, f"未知路径：/{'/'.join(parts)}",
                       "input")

    def _require(self, method: str, *allowed: str) -> None:
        if method not in allowed:
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED,
                           f"不支持的方法 {method}", "input")

    def _check_session_id(self, session_id: str) -> None:
        if not _valid_session_id(session_id):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"会话 id 非法：{session_id!r}", "input")

    # ---- 读取请求 -----------------------------------------------------

    def _read_json(self) -> dict:
        header = self.headers.get("Content-Length")
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "不支持 chunked 请求体", "input")
        if not header:
            return {}
        try:
            length = int(header)
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length 非法", "input")
        if length < 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length 非法", "input")
        if length > MAX_BODY_BYTES:
            raise _BodyTooLarge()
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求体不完整", "input")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求体不是合法 JSON", "input")
        if not isinstance(value, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求体必须是 JSON object", "input")
        return value

    # ---- 响应 ---------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if status >= 400:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_markdown(self, text: str) -> None:
        """原样吐 markdown。``suite.js`` 用 ``response.text()`` 读，不解析 JSON。"""
        body = text.encode("utf-8")
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_file(self, path: Path, name: str) -> None:
        try:
            body = path.read_bytes()
        except OSError as exc:
            raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                           f"产物读不了（{type(exc).__name__}）", "artifact") from exc
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition",
                             f'attachment; filename="{name}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_error(self, exc: ApiError, *, close: bool = False) -> None:
        if self._sse_started:
            self.close_connection = True
            return
        self._send_json(exc.status, {"ok": False, "error": exc.message,
                                     "class": exc.error_class})
        if close or exc.close:
            self.close_connection = True

    # ---- 端点 ---------------------------------------------------------

    def _handle_health(self) -> None:
        provider, meta = self.server.resolve_provider()
        registry = self.server.registry(None)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "version": AGENT_VERSION,
            "provider": getattr(provider, "name", "fake"),
            "model": meta.get("model") or getattr(provider, "model", ""),
            "tools": len(registry.names()),
        })

    def _handle_tools(self) -> None:
        registry = self.server.registry(None)
        tools = [_tool_description(registry.get(name))
                 for name in registry.names()]
        self._send_json(HTTPStatus.OK, {"tools": tools})

    # ---- 编队 / 数据 / 套件：分发 ---------------------------------------

    def _route_board(self, method: str, parts: list[str]) -> None:
        if parts == ["forest"]:
            self._require(method, "GET")
            self._handle_board_forest()
            return
        if parts == ["tree"]:
            self._require(method, "GET")
            self._handle_board_tree()
            return
        if parts == ["events"]:
            self._require(method, "GET")
            self._handle_board_events()
            return
        if parts == ["pending"]:
            self._require(method, "GET")
            self._handle_board_pending()
            return
        if parts == ["intervene"]:
            self._require(method, "POST")
            self._handle_board_intervene()
            return
        raise ApiError(HTTPStatus.NOT_FOUND,
                       f"未知路径：/board/{'/'.join(parts)}", "input")

    def _route_data(self, method: str, parts: list[str]) -> None:
        if parts == ["batches"]:
            self._require(method, "GET")
            self._handle_data_batches()
            return
        if parts == ["quality"]:
            self._require(method, "GET")
            self._handle_data_quality()
            return
        if parts == ["search"]:
            self._require(method, "GET")
            self._handle_data_search()
            return
        if parts == ["eval"]:
            self._require(method, "GET")
            self._handle_data_eval()
            return
        raise ApiError(HTTPStatus.NOT_FOUND,
                       f"未知路径：/data/{'/'.join(parts)}", "input")

    def _route_suite(self, method: str, parts: list[str]) -> None:
        if parts == ["field-parity"]:
            self._require(method, "GET")
            self._handle_suite_field_parity()
            return
        raise ApiError(HTTPStatus.NOT_FOUND,
                       f"未知路径：/suite/{'/'.join(parts)}", "input")

    # ---- 编队 -----------------------------------------------------------

    def _board_snapshot(self):
        """懒加载一份 ``InteractionBoard``，整个进程共用（它本身无状态）。

        库路径：``FSA_BOTD_DB`` 覆盖，默认 ``<agent data dir>/botd.sqlite3``。
        放在 agent 的数据目录里，是因为这张库的写入方是 botd 守护进程，而它本来就
        跑在同一个用户目录下；放进仓库会让一次「点开编队台」变成往 checkout 里写文件。
        """
        with self.server.board_lock:
            cached = getattr(self.server, "_board", None)
            if cached is not None:
                return cached

            from fieldstation.botd.interaction import InteractionBoard
            from fieldstation.botd.store import BotStore

            override = os.environ.get("FSA_BOTD_DB", "").strip()
            if override:
                path = Path(override).expanduser()
            else:
                path = Path(self.server.store.data_dir) / "botd.sqlite3"
            board = InteractionBoard(BotStore(path))
            board.database_path = path          # 只读诊断用；InteractionBoard 无同名属性
            self.server._board = board
            return board

    def _board_diagnostics(self, board) -> dict:
        path = getattr(board, "database_path", None)
        return {
            "path": path.as_posix() if path is not None else "",
            "exists": bool(path.is_file()) if path is not None else False,
        }

    def _handle_board_forest(self) -> None:
        board = self._board_snapshot()
        tasks = board.forest(limit=DATA_ROW_LIMIT)
        pending = board.pending()
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            # `tasks` 是任务级摘要（`interaction.py::forest()` 的原始形状）；
            # `bots` 是 bot 级视图（`fleet.js` 左栏那一列）。两者同一份库里推导，
            # 所以一起给：界面挑它要的那一份，不必再问一次。
            "tasks": tasks,
            "bots": _bots_of(board),
            "pending": pending,
            "database": self._board_diagnostics(board),
        })

    def _handle_board_tree(self) -> None:
        task_id = self._required_task_id()
        board = self._board_snapshot()
        try:
            tree = board.tree(task_id)
        except KeyError:
            raise ApiError(HTTPStatus.NOT_FOUND, f"任务不存在：{task_id}", "input")
        root = tree.get("root") or {}
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            # 两个口径同时给：
            #   · `root` / `counts` 是 `interaction.py::tree()` 的原样输出（契约 §2.1 形状）；
            #   · 顶层 `task_id` / `status` / `steps` 是界面直接读的那一组。
            # `**tree` 必须排在前面：它自带的 `steps` 是库里的列名（`id` / `tools`），
            # 排在后面会把下面加工好的那一份覆盖掉 —— 实测就是这么错的。
            **tree,
            "task_id": str(root.get("task_id") or task_id),
            "status": str(root.get("status") or ""),
            "started_at": root.get("started_at") or root.get("created_at") or "",
            "finished_at": root.get("finished_at") or "",
            "steps": [_step_view(step) for step in tree.get("steps") or []],
        })

    def _handle_board_events(self) -> None:
        task_id = self._required_task_id()
        board = self._board_snapshot()
        try:
            events = board.event_stream(task_id)
        except KeyError:
            raise ApiError(HTTPStatus.NOT_FOUND, f"任务不存在：{task_id}", "input")
        # 两代形状一起给：
        #   · `event_stream()` 的原始数组（`phase` / `at` / `label`）—— 裸数组最省事，
        #     但界面后来改成读 `{events:[…]}`（fleet.js:40 的 `raw.events`）。
        #   · 所以回一个对象，里面既有 `events`，也保留原始数组的每一条（不丢字段）。
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "events": [_event_view(event) for event in events],
            "task_id": task_id,
        })

    def _handle_board_pending(self) -> None:
        board = self._board_snapshot()
        rows = board.pending()
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            # `intervention_id` 是界面读的键（fleet.js:41）；`id` 是库里的列名。
            # 两个都给，免得下游为了「叫 id 还是 intervention_id」再对一次口径。
            "pending": [{**row, "intervention_id": row.get("id") or row.get("intervention_id")}
                        for row in rows],
        })

    def _handle_board_intervene(self) -> None:
        body = self._read_json()
        board = self._board_snapshot()
        kind = body.get("kind")
        if not isinstance(kind, str) or not kind.strip():
            raise ApiError(HTTPStatus.BAD_REQUEST, "kind 必须是非空字符串", "input")
        task_id = body.get("task_id")
        bot_id = body.get("bot_id")
        for name, value in (("task_id", task_id), ("bot_id", bot_id)):
            if value is not None and not isinstance(value, str):
                raise ApiError(HTTPStatus.BAD_REQUEST, f"{name} 必须是字符串", "input")
        # 界面把说明放在 `note` 里（`interveneBody()`）；`prompt` 是 `interaction.py`
        # 的参数名。两个都收：`note` 优先，因为它才是用户刚打的那句话。
        raw_note = body.get("note", body.get("prompt", ""))
        if raw_note is not None and not isinstance(raw_note, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "note 必须是字符串", "input")
        step_id = body.get("step_id")
        if step_id is not None and not isinstance(step_id, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "step_id 必须是字符串", "input")
        approval_id = body.get("approval_id")
        if approval_id is not None and not isinstance(approval_id, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "approval_id 必须是字符串", "input")
        parametrized = body.get("parametrized", False)
        if not isinstance(parametrized, bool):
            raise ApiError(HTTPStatus.BAD_REQUEST, "parametrized 必须是布尔值", "input")

        try:
            row = board.request(
                kind,
                task_id=task_id or None,
                bot_id=bot_id or None,
                prompt=raw_note or "",
                step_id=step_id or None,
                approval_id=approval_id or None,
                parametrized=parametrized,
            )
        except (ValueError, RuntimeError) as exc:
            # `InterventionError` 表达的是「请求不合法」（未知 kind、takeover 缺审批、
            # retry 没写改动），所以按 400 回，而不是当服务端故障。
            raise ApiError(HTTPStatus.BAD_REQUEST, str(exc), "input") from exc
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "intervention": row,
            "intervention_id": row.get("id"),
            "status": row.get("status"),
            "needs_approval": bool(row.get("needs_approval")),
            "effective_at": row.get("effective_at") or {},
            # 25.10.5：文案由界面出，这里只把「什么时候生效」说清楚。
            "note": "干预在步骤边界被消费，正在执行的步骤会跑完（ADR-009）",
        })

    def _required_task_id(self) -> str:
        query = _query_params(self.path)
        task_id = (query.get("task_id") or "").strip()
        if not task_id:
            raise ApiError(HTTPStatus.BAD_REQUEST, "缺少 task_id 参数", "input")
        if len(task_id) > 128 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", task_id):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"task_id 只允许字母、数字与 _ . : -（收到 {task_id!r}）", "input")
        return task_id

    # ---- 数据 -----------------------------------------------------------

    def _data_root_or_400(self) -> Path:
        return _data_root(Path(self.server.repo_root))

    def _handle_data_batches(self) -> None:
        root = self._data_root_or_400()
        manifest, note = _manifest_of(root)
        if manifest is None:
            self._send_json(HTTPStatus.OK, {
                "ok": True, "root": root.as_posix(), "batches": [], "count": 0, "note": note,
            })
            return
        batches = _batches_of(manifest)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "root": root.as_posix(),
            "count": len(batches),
            "batches": batches,
            "note": "" if batches else "清单是空的：先导入一份抓包成 NDJSON 分区",
        })

    def _handle_data_quality(self) -> None:
        query = _query_params(self.path)
        station, date = _require_batch(query)
        root = self._data_root_or_400()
        if not root.is_dir():
            # 根目录都没有 = 引擎没东西可读；界面按「降级」画，不按「没有数据」画。
            self._send_json(HTTPStatus.OK, {
                "ok": True, "engineDown": True, "counts": None, "rules": [],
                "reason": f"数据根 {root.as_posix()} 不存在",
            })
            return
        try:
            counts = _quality_of(root, station, date)
        except Exception as exc:  # noqa: BLE001 - 读不动就说清是引擎降级
            self._send_json(HTTPStatus.OK, {
                "ok": True, "engineDown": True, "counts": None, "rules": [],
                "reason": f"扫描失败（{type(exc).__name__}）：{exc}",
            })
            return
        rules = counts.pop("rules")
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "engineDown": False,
            "counts": counts,
            # 两类计数在顶层也给一份：契约（`data-workbench.test.ts` 的
            # `missing_rate` / `slip_count` / `out_of_range`）读的是顶层，
            # 后来的界面读 `counts`。同一份数字，两种摆放。
            "rows": counts.get("rows"),
            "missing_rate": counts.get("missingRate"),
            "slip_count": counts.get("jumps"),
            "out_of_range": counts.get("outOfRange"),
            # `rules` 必须是**数组**：界面按 `rule_id` 在里面 find（data.js:330）。
            # 按编号索引的对象会被 `normalizeRules` 也吃下去，但数组是契约写的形状。
            "rules": list(rules.values()),
            "batch": f"{station}/{date}",
        })

    def _handle_data_search(self) -> None:
        query = _query_params(self.path)
        station, date = _require_batch(query)
        question = (query.get("q") or "").strip()
        root = self._data_root_or_400()

        from fieldstation.data import knowledge as KN

        if not question:
            # 空问题不是错误：界面每次换批次都会先问一次空串占位，回一个空答案。
            self._send_json(HTTPStatus.OK, {
                "ok": True, "question": "", "value": None, "sql": "",
                "partition": "", "rows": None, "engine": "", "elapsedMs": None,
                "missingField": False, "note": "还没有提问",
            })
            return
        try:
            answer = KN.answer_question(root, question)
        except KN.UnsupportedQuestion as exc:
            # 第三种空态：字段/台站不在本批次里，说清是哪个。
            self._send_json(HTTPStatus.OK, {
                "ok": True, "question": question, "value": None, "sql": "",
                "partition": "", "rows": None, "engine": "", "elapsedMs": None,
                "missingField": True, "reason": str(exc),
            })
            return
        except Exception as exc:  # noqa: BLE001 - 引擎不可用是降级，不是没数据
            self._send_json(HTTPStatus.OK, {
                "ok": False, "question": question, "engineDown": True,
                "reason": f"查询失败（{type(exc).__name__}）：{exc}",
            })
            return

        payload = answer.to_dict()
        paths = payload.get("partition_paths") or []
        first = (payload.get("rows") or [{}])[0]
        value = first.get(next(iter(payload.get("columns") or []), ""), None)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "question": payload["question"],
            "value": value,
            # 契约把答案叫 `answer`；这里两个都给，读取方不必猜哪一个。
            "answer": value,
            "sql": payload["sql"],
            # 界面「分区」那一格：多个分区时给第一个 + 总数，不把 24 行塞进一格。
            "partition": (paths or [""])[0],
            "partitionCount": payload.get("partition_count", 0),
            # 两个拼法都写：`partition_paths` 是契约（`normalizeSearch`）认的，
            # `partitionPaths` 是 camelCase 版本，同一个数组。
            "partition_paths": list(paths),
            "partitionPaths": list(paths),
            "rows": payload.get("row_count"),
            "row_count": payload.get("row_count"),
            "resultRows": payload.get("result_rows"),
            "engine": payload.get("engine", ""),
            "elapsedMs": payload.get("duration_ms"),
            "duration_ms": payload.get("duration_ms"),
            "missingField": False,
            "note": payload.get("note", ""),
        })

    def _handle_data_eval(self) -> None:
        query = _query_params(self.path)
        station, date = _require_batch(query)
        batch_id = f"{station}/{date}"
        results, note = _eval_results(Path(self.server.repo_root), batch_id)
        if results is None:
            # 没有日志时给六个 null —— 界面画 `?`（未跑），不装作失败也不装作通过。
            # `items` 显式给空数组：界面按 `items` 判断「有没有结果」（data.js:302）。
            empty = {"S1": None, "S2": None, "S3": None, "S4": None, "S5": None, "S6": None}
            self._send_json(HTTPStatus.OK, {
                "ok": True, "batch": batch_id, "results": None, "items": [],
                "checks": empty, "note": note,
            })
            return
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "batch": batch_id,
            "results": results["results"],
            # 契约形状是「每条一行 + 六个三态值」；这里只有一条（一个任务一份日志）。
            "items": [{
                "case_id": results["task_id"],
                **{f"s{index}": value for index, value
                   in enumerate(results["results"].values(), start=1)},
            }],
            "source": results["source"],
            "task_id": results["task_id"],
        })

    # ---- 套件 -----------------------------------------------------------

    def _handle_suite_field_parity(self) -> None:
        """把 ``docs/operations/suite-field-parity.md`` 原样吐出去。

        `suite.js::parseParityMarkdown` 解析的就是这份 markdown（它自己读真实文件
        的测试已经在跑），所以这里**不做 JSON 转换**：多一层转换就多一处可能与
        生成器脱节的地方。
        """
        path = Path(self.server.repo_root) / "docs" / "operations" / "suite-field-parity.md"
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ApiError(HTTPStatus.NOT_FOUND,
                           f"没有字段对照表：{type(exc).__name__}；"
                           "先生成 python tools/suite_field_parity.py", "environment") from exc
        self._send_markdown(text)

    def _handle_session_create(self) -> None:
        body = self._read_json()
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "title 必须是字符串", "input")
        if isinstance(title, str) and len(title) > MAX_TITLE_CHARS:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"title 超过 {MAX_TITLE_CHARS} 字", "input")
        meta = self.server.store.create_session(title)
        self._send_json(HTTPStatus.OK, {"session_id": meta["session_id"]})

    def _handle_session_detail(self, session_id: str) -> None:
        loaded = self.server.store.load(session_id)
        meta = loaded["session"]
        self._send_json(HTTPStatus.OK, {
            "session": {
                "id": meta.get("session_id", session_id),
                "title": meta.get("title", "新会话"),
                "created_at": meta.get("created_at", ""),
                "updated_at": meta.get("updated_at", ""),
            },
            "events": loaded["events"],
        })

    def _handle_settings_get(self) -> None:
        self._send_json(HTTPStatus.OK, self._settings_view())

    def _handle_settings_post(self) -> None:
        body = self._read_json()
        patch: dict = {}

        if "provider" in body:
            provider = body.get("provider")
            if provider not in PROVIDERS:
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               f"provider 必须是 {list(PROVIDERS)} 之一", "input")
            patch["provider"] = provider

        if "base_url" in body:
            base_url = body.get("base_url")
            if not isinstance(base_url, str):
                raise ApiError(HTTPStatus.BAD_REQUEST, "base_url 必须是字符串", "input")
            base_url = base_url.strip()
            if base_url and not base_url.startswith(("http://", "https://")):
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               "base_url 必须以 http:// 或 https:// 开头", "input")
            patch["base_url"] = base_url

        if "model" in body:
            model = body.get("model")
            if not isinstance(model, str) or len(model) > MAX_TITLE_CHARS:
                raise ApiError(HTTPStatus.BAD_REQUEST, "model 必须是字符串", "input")
            patch["model"] = model.strip()

        if "temperature" in body:
            temperature = body.get("temperature")
            if (isinstance(temperature, bool)
                    or not isinstance(temperature, (int, float))
                    or not (0.0 <= float(temperature) <= 2.0)):
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               "temperature 必须是 [0,2] 内的数值", "input")
            patch["temperature"] = float(temperature)

        api_key = body.get("api_key")
        if api_key is not None:
            if not isinstance(api_key, str) or not api_key.strip():
                raise ApiError(HTTPStatus.BAD_REQUEST, "api_key 必须是非空字符串",
                               "input")
            # 先存 key：存不进去就不要留下「设置改了但用不了」的假象。
            self.server.save_api_key(api_key.strip())

        if patch:
            self.server.store.update_settings(patch)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "settings": self._settings_view(),
        })

    def _settings_view(self) -> dict:
        settings = self.server.settings()
        return {
            "provider": settings.get("provider"),
            "base_url": settings.get("base_url"),
            "model": settings.get("model"),
            "temperature": settings.get("temperature"),
            "has_key": bool(self.server.has_key()),
            "fake_fallback": bool(self.server.fallback_active()),
        }

    # ---- 运行 ---------------------------------------------------------

    def _handle_message(self, session_id: str) -> None:
        store: SessionStore = self.server.store
        if not store.exists(session_id):
            raise ApiError(HTTPStatus.NOT_FOUND, f"会话不存在：{session_id}", "input")
        body = self._read_json()
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ApiError(HTTPStatus.BAD_REQUEST, "text 必须是非空字符串", "input")
        if len(text) > MAX_TEXT_CHARS:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"text 超过 {MAX_TEXT_CHARS} 字符", "input")
        attachments = body.get("attachments")
        if attachments is not None and not isinstance(attachments, list):
            raise ApiError(HTTPStatus.BAD_REQUEST, "attachments 必须是数组", "input")

        state = _RunState(session_id)
        with self.server.runs_lock:
            if session_id in self.server.active_runs:
                raise ApiError(HTTPStatus.CONFLICT,
                               "该会话已有运行中的任务，请先取消或等待结束",
                               "execution")
            self.server.active_runs[session_id] = state

        try:
            provider, _ = self.server.resolve_provider()
            registry = self.server.registry(session_id)
        except BaseException:
            # 任何失败都要把「会话忙」标记撤掉，否则这个会话再也发不出消息。
            with self.server.runs_lock:
                self.server.active_runs.pop(session_id, None)
            raise

        self._start_sse()
        emit = self._sse_emitter(state)
        wait_decision = self._approval_waiter(state)
        try:
            orchestrator.run_session(
                session_id, text,
                emit=emit,
                provider=provider,
                registry=registry,
                approval_timeout=self.server.approval_timeout,
                wait_decision=wait_decision,
                cancel_event=state.cancel,
                attachments=attachments,
            )
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:
            if not state.client_gone:
                try:
                    emit({"type": "error", "class": "execution",
                          "message": f"运行失败（{type(exc).__name__}）"})
                except Exception:
                    pass
        finally:
            with self.server.runs_lock:
                self.server.active_runs.pop(session_id, None)
            self._finish_sse(session_id)

    def _start_sse(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        self._sse_started = True
        try:
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _sse_emitter(self, state: _RunState):
        store: SessionStore = self.server.store

        def emit(event: dict) -> None:
            # 先落盘：客户端断开时，会话文件里依然要有完整的一轮。
            stored = store.append_event(state.session_id, event)
            if (stored.get("type") == "approval"
                    and stored.get("status") == "pending"):
                state.approvals[str(stored.get("id"))] = _Approval(
                    str(stored.get("id")), str(stored.get("call_id", "")))
            if state.client_gone:
                return
            try:
                payload = json.dumps(stored, ensure_ascii=False)
                self.wfile.write(
                    f"event: agent\ndata: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                state.client_gone = True

        return emit

    def _approval_waiter(self, state: _RunState):
        def wait_decision(approval_id: str, timeout: float) -> str:
            slot = state.approvals.get(approval_id)
            if slot is None:
                return "rejected"
            deadline = time.monotonic() + max(0.0, float(timeout))
            while True:
                if slot.event.wait(0.05):
                    return slot.decision or "rejected"
                if state.cancel.is_set():
                    return "cancelled"
                if time.monotonic() >= deadline:
                    return "timeout"

        return wait_decision

    def _finish_sse(self, session_id: str) -> None:
        try:
            payload = json.dumps({"type": "done", "session_id": session_id},
                                 ensure_ascii=False)
            self.wfile.write(f"event: done\ndata: {payload}\n\n".encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def _handle_approval(self, session_id: str) -> None:
        if not self.server.store.exists(session_id):
            raise ApiError(HTTPStatus.NOT_FOUND, f"会话不存在：{session_id}", "input")
        body = self._read_json()
        approval_id = body.get("approval_id")
        decision = body.get("decision")
        if not isinstance(approval_id, str) or not approval_id:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "approval_id 必须是非空字符串", "input")
        if decision not in ("approved", "rejected"):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "decision 必须是 approved 或 rejected", "input")
        note = body.get("note", "")
        if note is not None and not isinstance(note, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "note 必须是字符串", "input")

        state = self.server.active_runs.get(session_id)
        if state is None:
            raise ApiError(HTTPStatus.CONFLICT, "当前没有等待审批的运行", "execution")
        slot = state.approvals.get(approval_id)
        if slot is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "审批请求不存在", "input")
        if slot.event.is_set():
            raise ApiError(HTTPStatus.CONFLICT, "审批已经决定过了", "execution")
        slot.note = note or ""
        slot.decision = decision
        slot.event.set()
        self._send_json(HTTPStatus.OK, {"ok": True, "approval_id": approval_id,
                                        "decision": decision})

    def _handle_cancel(self, session_id: str) -> None:
        if not self.server.store.exists(session_id):
            raise ApiError(HTTPStatus.NOT_FOUND, f"会话不存在：{session_id}", "input")
        self._read_json()
        state = self.server.active_runs.get(session_id)
        if state is None:
            self._send_json(HTTPStatus.OK, {"ok": True, "cancelled": False})
            return
        state.cancel.set()
        for slot in list(state.approvals.values()):
            if not slot.event.is_set():
                slot.decision = "cancelled"
                slot.note = "运行已取消"
                slot.event.set()
        self._send_json(HTTPStatus.OK, {"ok": True, "cancelled": True})


def _valid_session_id(value: str) -> bool:
    # 按路径加载（tools/ 不一定在 sys.path）。
    return _fsa_load_sibling("agent_store").is_valid_session_id(value)


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------

def make_server(*, port: int = 0, token: str,
                node_url: str | None = None,
                repo_root: str | Path | None = None,
                data_dir: str | Path | None = None,
                approval_timeout: float = orchestrator.APPROVAL_TIMEOUT_DEFAULT,
                provider_factory=None, tool_registry=None,
                registry_factory=None) -> AgentHTTPServer:
    """创建一个已绑定端口的服务（不阻塞）。``port=0`` 由系统挑端口。"""
    if not isinstance(token, str) or not token:
        raise ValueError("token 不能为空")
    store = SessionStore(data_dir)
    store.ensure_dirs()
    server = AgentHTTPServer(
        ("127.0.0.1", int(port)), AgentHandler,
        store=store, token=token,
        repo_root=Path(repo_root) if repo_root else REPO_ROOT,
        node_url=node_url,
        approval_timeout=approval_timeout,
        provider_factory=provider_factory,
        tool_registry=tool_registry,
        registry_factory=registry_factory)
    return server


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent_server.py",
        description="All powered-FSA 桌面版 Agent 本地服务（只监听 127.0.0.1）")
    parser.add_argument("--port", type=int, default=0,
                        help="监听端口；0 = 由系统分配（默认）")
    parser.add_argument("--token", required=True,
                        help="Bearer token；由壳生成后传入")
    parser.add_argument("--node-url", default=None,
                        help="Node 服务地址，例如 http://127.0.0.1:12345")
    parser.add_argument("--repo", default=str(REPO_ROOT),
                        help="仓库根目录（读 config/ 与 workflows/）")
    parser.add_argument("--data-dir", default=None,
                        help="数据目录；默认 %%LOCALAPPDATA%%\\AllPoweredFSA")
    parser.add_argument("--approval-timeout", type=float,
                        default=orchestrator.APPROVAL_TIMEOUT_DEFAULT,
                        help="审批等待秒数；超时按拒绝处理（默认 600）")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    data_dir = args.data_dir or default_data_dir()
    try:
        server = make_server(
            port=args.port, token=args.token, node_url=args.node_url,
            repo_root=args.repo, data_dir=data_dir,
            approval_timeout=args.approval_timeout)
    except OSError as exc:
        sys.stderr.write(f"[agent] 端口绑定失败（{type(exc).__name__}）\n")
        return 2
    port = server.server_address[1]
    sys.stdout.write(f"AGENT_READY {port}\n")
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
