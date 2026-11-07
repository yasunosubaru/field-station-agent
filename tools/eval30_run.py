#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eval30_run.py —— 把一个运行时真的跑完 `docs/contracts/eval-30.md` 的 30 条任务，
逐条落 `logs/eval/<runtime>/<task_id>.jsonl`，最后把判分交给 `tools/eval30_judge.py`。

## 为什么 runner 不自己判分

判分是**第二方视角**。如果同一个脚本既"跑"又"判"，它就有动机把自己跑得不顺的那条
写成"通过"——而且这种偏差在报告里长得和正常结果一模一样：不会报错，只会让结论变好看。
所以职责切得很硬：

- **runner**：喂 prompt、收事件、落 JSONL、记只有现场才知道的量（`duration_ms`、
  `approvals` 四计数、`fallbacks`）；
- **judge**（`tools/eval30_judge.py`）：吃 JSONL，按 S1–S6 机械判定，退出码 0/1/2。

runner 通过 **subprocess 调 judge 的 CLI**，不 import 它的内部函数。理由是判定口径
必须只有一份：调用 CLI 意味着「judge 怎么判，报告就是什么」，runner 没有插手的位置。

runner 也**不复制**契约里的期望工具链与数值区间。那些是判分口径，复制一份必然与
judge 漂移；漂移的判分口径比没有判分更糟（两份各自"自洽"，谁也不报错）。

## dry-run 为什么必须物理隔离

dry-run 用的是**内置假运行时**：事件形状合法（能过 `agent-events.md` 的九个类型），
但内容全是假的。它存在的唯一目的是验证流水线（落盘、目录、判分器接线）本身没坏。

假报告最危险的用法是被人当成真报告。所以做了三层隔离：

1. **目录**：dry-run 默认写 `logs/eval/_dryrun/<runtime>/`，真实运行写
   `logs/eval/<runtime>/`；dry-run 显式 `--out-dir` 指到真实目录会被**拒绝**（退出码 2）。
2. **字段**：每条事件的 `data.synthetic` 都是 `true`，假工具调用带 `E_DRYRUN` 错误码。
3. **横幅**：stdout 与 `report.md` 顶部都写明「这是 dry-run，不是真实评测」。

假日志还刻意**让每条都判不过**：假工具名 `dryrun_probe` 对不上任何期望工具链，
S1 必挂，所以 dry-run 的判分结果里 PASS 恒为 0。「假数据碰巧过了一条」这种最容易
被误读的情况不会出现。

## 默认行为是安全的

不写 `--real` 就只是 dry-run。原因：真跑会打 30 次模型调用、可能要真实设备/套件，
误触的代价远高于多打一个参数。要真跑必须显式 `--real --runtime <名字>`。

## 缺日志 = 阻塞，不是通过

`runtime.available()` 为假时**不伪造任何 `.jsonl`**，只写 `_blocked.json` 逐条记
`blocked: environment`。契约 §3.3 明写阻塞项「既不判 pass 也不判 fail」。

同理，运行中途抛 `RuntimeUnavailable`（端口掉了）时不落 `<task_id>.jsonl`——否则
判分器会把一条被环境打断的记录判成 FAIL，把环境问题伪装成模型问题。那种情况写
`<task_id>.blocked.json` 供排障。

## 退出码

与 `eval30_judge.py` 同档：`0` / `1` / `2`。但**含义按模式分开**：

- **真实运行**：`0` 判分全过；`1` 有 FAIL·manual·阻塞或漏写日志；`2` 用法/输入坏掉。
- **dry-run**：`0` 流水线跑通（30 条日志都写成功）；`1` 有阻塞/漏写；`2` 用法坏掉。
  dry-run 的假数据必然判不过，若让它在"跑通"时返回 1，这个自检在 CI 里永远红，
  最后一定被关掉 —— 那才是真的危险。所以 dry-run 把判分器的退出码**原样打印**，
  但不用它决定自己的进退，并在汇总里说清「runner 退出码 0 只表示流水线跑通」。

## 已知限制（不为它编理由）

- `RuntimeRequest` 没有 `temperature` / `seed` 字段，契约 §1.1 要求的
  `temperature=0, seed=42` 目前只能由运行时侧默认值保证；这里**不假装**已经传下去了。
- runner 不装配工具表（`mcp-tools.md` 的 30 个工具），`tools=[]` 留给运行时/装配层；
  真实运行前必须由装配层补上，否则模型拿不到工具。
- **真实运行时本轮无法验证**：本仓库没有可用的 opencode/claude 端点，所以真实路径
  只走到了 `available() == False` 那条分支。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "docs" / "contracts" / "eval-30.md"
JUDGE = ROOT / "tools" / "eval30_judge.py"

#: dry-run 默认落盘的子目录名。真实产物永远在 `logs/eval/<runtime>/`，两者不共享目录。
DRYRUN_DIRNAME = "_dryrun"
#: `--runtime` 缺省时的标签（只在 dry-run 下允许缺省）。
DRYRUN_LABEL = "dryrun"

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2

_TASK_ID_RE = re.compile(r"^EV-\d{2}$")


class UsageError(RuntimeError):
    """用法/输入错误。CLI 折成退出码 2，与 judge 的 `JudgeInputError` 同档。

    与"跑完了但有 FAIL"（1）分开的理由和 judge 一致：1 要人去查任务，
    2 要人去查命令本身。
    """


class NoEvents(RuntimeError):
    """运行时一条事件都没产出来。按环境阻塞处理，不写成"任务失败"。"""


# --------------------------------------------------------------------------- 契约解析
@dataclass(frozen=True)
class ContractTask:
    """runner 眼里的一条任务：只有"喂什么进去"。

    期望工具链、判分规则、数值区间**一律不复制**——那些是判分口径，复制一份必然与
    `eval30_judge.py` 漂移。
    """

    task_id: str
    view: str
    prompt: str


def parse_contract_tasks(text: str) -> list[ContractTask]:
    """从契约正文解析 §2 任务表的前三列：编号 / 视角 / 输入原文。

    只认形状（第一列是 `EV-xx`），不认小节标题：契约改标题不该让 runner 失明，
    改表结构则应该失明——解析出 0 条是硬失败，不能静默当成"没有任务"。
    """
    tasks: list[ContractTask] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        task_id = cells[0]
        if not _TASK_ID_RE.match(task_id):
            continue
        tasks.append(ContractTask(task_id, cells[1], cells[2]))
    return tasks


def load_contract_tasks(path: Path = CONTRACT) -> list[ContractTask]:
    if not path.is_file():
        raise UsageError(f"找不到契约文档：{path}")
    tasks = parse_contract_tasks(path.read_text("utf-8", errors="replace"))
    if not tasks:
        raise UsageError(
            f"{path} 里解析出 0 条任务 —— 表结构变了或解析器坏了，本次运行作废"
            "（0 条绝不能被当成「全部通过」）。")
    return tasks


def select_tasks(tasks: Sequence[ContractTask], spec: str) -> list[ContractTask]:
    """`--tasks EV-01,EV-05` 过滤；不认识的名字直接报错并列出可用的。"""
    spec = (spec or "").strip()
    if not spec:
        return list(tasks)
    by_id = {task.task_id: task for task in tasks}
    wanted = [item.strip().upper() for item in spec.split(",") if item.strip()]
    if not wanted:
        return list(tasks)
    unknown = [item for item in wanted if item not in by_id]
    if unknown:
        raise UsageError(f"契约里没有这些任务：{unknown}；可用：{list(by_id)}")
    seen: set[str] = set()
    out: list[ContractTask] = []
    for item in wanted:  # 保序去重：同一条写两遍不该跑两遍
        if item in seen:
            continue
        seen.add(item)
        out.append(by_id[item])
    return out


# --------------------------------------------------------------------------- 运行时发现
def _protocol() -> Any:
    """延迟导入运行时契约。

    延迟的理由：没有 `PYTHONPATH=src` 时要能打印一句可操作的提示，而不是一屏
    ImportError 堆栈；`--list-tasks` 这种纯文本操作也不该被它挡住。
    """
    try:
        from fieldstation.runtimes import base as module  # noqa: WPS433
    except Exception as exc:  # noqa: BLE001
        raise UsageError(
            "导入 `fieldstation.runtimes` 失败（是不是没设 PYTHONPATH=src？）："
            f"{type(exc).__name__}: {exc}") from exc
    return module


def discover_runtimes(package: Any = None) -> dict[str, Any]:
    """从 `fieldstation.runtimes` **现场发现**可用运行时，不在脚本里写死名单。

    硬编码名单的唯一结局是：新增一个运行时、名单没改，然后 CLI 说「没有这个运行时」。
    发现规则是结构性的——一个类，有字符串 `name`、有可调用的 `available/run/cancel`，
    且能零参构造，就是一个可选运行时。

    每个实现注册两个键：实例自己的 `.name`，以及模块里的类名去掉 `Runtime` 后缀
    （`OpenCodeRuntime` → `opencode`）。后者是必要的：仓库把 `OpenCodeRuntime` 定义成
    `OpenAICompatibleRuntime` 的别名，实例 `.name` 是 `openai-compatible`，
    而契约 §3.3 里的运行时名是 `opencode`。
    """
    if package is None:
        try:
            import fieldstation.runtimes as package  # noqa: WPS433
        except Exception as exc:  # noqa: BLE001
            raise UsageError(
                "导入 `fieldstation.runtimes` 失败（是不是没设 PYTHONPATH=src？）："
                f"{type(exc).__name__}: {exc}") from exc

    found: dict[str, Any] = {}
    # 同一个类只构造一次：`OpenCodeRuntime` 是 `OpenAICompatibleRuntime` 的别名，
    # 两个名字指向同一个类。构造两次会得到两个实例，而「opencode 与
    # openai-compatible 是不是同一个运行时」这个问题不该留给人去猜。
    instances: dict[type, Any] = {}
    for attr in sorted(dir(package)):
        if attr.startswith("_"):
            continue
        obj = getattr(package, attr)
        if not isinstance(obj, type):
            continue
        if not isinstance(getattr(obj, "name", None), str):
            continue
        if not all(callable(getattr(obj, member, None))
                   for member in ("available", "run", "cancel")):
            continue
        if obj not in instances:
            try:
                instances[obj] = obj()   # 构造不该联网；真实探测留给 available()
            except Exception:  # noqa: BLE001 —— 构造不了的类不是一个可选运行时
                instances[obj] = None
        instance = instances[obj]
        if instance is None:
            continue
        alias = attr[: -len("Runtime")].lower() if attr.endswith("Runtime") else attr.lower()
        for key in sorted({str(instance.name), alias}):
            found.setdefault(key, instance)
    return found


# --------------------------------------------------------------------------- 假运行时
def _event(kind: str, session_id: str, data: Mapping[str, Any]) -> Any:
    """造一条 `Event`；`Event` 从运行时契约里取，保证形状与仓库唯一真源一致。"""
    protocol = _protocol()
    return protocol.Event(kind, session_id, dict(data))


class DryRunRuntime:
    """内置假运行时：形状合法、内容明确是假的。

    刻意**不**照着期望工具链吐事件。如果它吐了 `station_health` 之类的真工具名，
    判分器会给 S1 打勾，然后有人读报告时会以为「工具链这一项验过了」——而实际上
    什么也没验。所以它只发一个必然失败的假探针（`dryrun_probe` / `E_DRYRUN`），
    保证 dry-run 的判分结果里 PASS 恒为 0。
    """

    name = DRYRUN_LABEL
    #: 假事件统一挂在 data 上的标记；测试与人工都能据此一眼分辨真假。
    SYNTHETIC_NOTE = ("dry-run：本日志由内置假运行时生成，不含任何模型输出，"
                      "不可作为评测结论。")
    #: 假工具名。与 `mcp-tools.md` 的任何真实工具都不同名，S1 必然不成立。
    PROBE_TOOL = "dryrun_probe"

    def available(self) -> bool:
        return True

    def cancel(self, session_id: str) -> None:
        return None

    def run(self, req: Any):
        base = {"synthetic": True}
        yield _event("session.start", req.session_id, {
            **base,
            "runtime": DRYRUN_LABEL,
            "model": "dry-run-no-model",
            "agent": "eval30-dryrun",
            "task_prompt": req.prompt,
        })
        yield _event("message.delta", req.session_id, {
            **base, "text": "（dry-run 假增量，不是模型输出）", "index": 0})
        yield _event("tool.call", req.session_id, {
            **base, "id": "t0001", "name": self.PROBE_TOOL,
            "arguments": "{}", "risk": "low", "approval": "none"})
        yield _event("tool.result", req.session_id, {
            **base, "id": "t0001", "name": self.PROBE_TOOL, "ok": False,
            "error": {"code": "E_DRYRUN",
                      "message": "假运行时不执行任何真实动作",
                      "retryable": False},
            "duration_ms": 0,
        })
        yield _event("message.done", req.session_id, {
            **base, "reason": "stop", "content": self.SYNTHETIC_NOTE})
        yield _event("usage", req.session_id, {
            **base, "prompt_tokens": 0, "completion_tokens": 0,
            "total_tokens": 0, "model": "dry-run-no-model", "duration_ms": 0})


# --------------------------------------------------------------------------- 路径安全
def _temp_root() -> Path:
    return Path(tempfile.gettempdir())


def _inside(path: Path, root: Path) -> bool:
    """Windows 下大小写不敏感；`normcase` 在 POSIX 上是恒等，一套代码两处成立。"""
    child = os.path.normcase(os.path.abspath(str(path)))
    parent = os.path.normcase(os.path.abspath(str(root)))
    return child == parent or child.startswith(parent + os.sep)


def default_out_dir(label: str, dry_run: bool, root: Path = ROOT) -> Path:
    """默认日志根目录。dry-run 与真实产物**永远不共目录**。"""
    base = root / "logs" / "eval"
    if not dry_run:
        return base / label
    if label == DRYRUN_LABEL:
        return base / DRYRUN_DIRNAME
    return base / DRYRUN_DIRNAME / label


def check_out_dir(path: Path, *, dry_run: bool, label: str,
                  allow_outside: bool = False, root: Path = ROOT) -> Path:
    """写盘前确认目标目录安全。

    三条规矩：
    1. dry-run 不许写进真实产物目录（否则以后没人分得清哪份是真的）；
    2. 只允许写仓库内或系统临时目录（这个仓库对"往盘上乱写"很小心）；
    3. 真要写到别处，必须显式 `--allow-outside-repo`，并且打印警告。
    """
    resolved = path.expanduser().resolve()
    real_dir = (root / "logs" / "eval" / label).resolve()
    if dry_run and os.path.normcase(str(resolved)) == os.path.normcase(str(real_dir)):
        raise UsageError(
            f"dry-run 不能写进真实产物目录 {real_dir}；"
            f"请用默认的 {default_out_dir(label, True)} 或另给 --out-dir")
    if _inside(resolved, root) or _inside(resolved, _temp_root()):
        return resolved
    if allow_outside:
        print(f"[警告] 日志写到仓库与临时目录之外：{resolved}"
              "（--allow-outside-repo 已生效，请自行确认这是你要的）")
        return resolved
    raise UsageError(
        f"拒绝把日志写到仓库与系统临时目录之外：{resolved}\n"
        "  允许的两处：仓库内、系统临时目录内。"
        "确实要写到别处请加 --allow-outside-repo。")


# --------------------------------------------------------------------------- 落盘小工具
def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _write_jsonl(path: Path, events: Sequence[Mapping[str, Any]]) -> None:
    """一行一个事件；显式 LF，避免 Windows 下 CRLF 进证据文件。"""
    text = "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events)
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8", newline="\n")


def _collect_fallbacks(data: Mapping[str, Any], sink: list[str]) -> None:
    """收「引擎/记忆/编排降级」标记（契约 §3.3 的 `fallbacks`）。

    事件协议没有专门的 fallback 事件，所以按字段约定收集：`data.fallbacks` 列表，
    以及 `data.memory_missing is True`（EV-13 的降级标记）。
    """
    raw = data.get("fallbacks")
    if isinstance(raw, list):
        for item in raw:
            text = str(item)
            if text and text not in sink:
                sink.append(text)
    if data.get("memory_missing") is True and "memory_missing" not in sink:
        sink.append("memory_missing")


# --------------------------------------------------------------------------- 单条任务
def run_one(runtime: Any, task: ContractTask, *, label: str, dry_run: bool,
            out_dir: Path, protocol: Any) -> dict:
    """驱动一条任务：收事件 → 落 `<task_id>.jsonl` + `<task_id>.meta.json`。

    事件先全部缓存在内存里，跑完才落盘。这样「环境中途断掉」不会留下一份半截 JSONL，
    被判分器当成"模型跑完了但没通过"——那是把环境问题伪装成模型问题。
    """
    session_id = f"eval30-{label}-{task.task_id}"
    request = protocol.RuntimeRequest(
        session_id=session_id,
        prompt=task.prompt,
        max_steps=12,
    )

    events: list[dict] = []
    approvals = {"request": 0, "approved": 0, "rejected": 0, "expired": 0}
    fallbacks: list[str] = []
    started: float | None = None
    finished: float | None = None

    for index, event in enumerate(runtime.run(request), 1):
        if started is None:
            started = time.monotonic()
        raw = event.to_dict() if hasattr(event, "to_dict") else dict(event)
        kind = str(raw.get("type") or "")
        if kind not in protocol.TYPES:
            raise UsageError(
                f"{task.task_id} 第 {index} 条事件类型非法：{kind!r}"
                f"（只认 {', '.join(protocol.TYPES)}）—— 事件流坏了，本次运行作废")
        data = raw.get("data")
        if not isinstance(data, dict):
            data = {}
        if dry_run:
            data = {**data, "synthetic": True}
        raw["data"] = data
        raw["session_id"] = str(raw.get("session_id") or session_id)
        raw["seq"] = index

        if kind == "approval.request":
            approvals["request"] += 1
        elif kind == "approval.result":
            verdict = str(data.get("verdict") or "")
            if verdict in ("approved", "rejected", "expired"):
                approvals[verdict] += 1
        elif kind == "message.done":
            finished = time.monotonic()
        _collect_fallbacks(data, fallbacks)
        events.append(raw)

    end = time.monotonic()
    if started is None:                       # 一条事件都没收到
        raise NoEvents(f"{task.task_id}：运行时没有产出任何事件")

    # 契约 §3.3：duration_ms 是「首事件到 message.done」。没有 message.done 时退回
    # 流结束时间，并在 meta 里标注，避免把一个残缺耗时当成正常耗时。
    closed_by_done = finished is not None
    duration_ms = int(round(((finished if finished is not None else end) - started) * 1000))

    _write_jsonl(out_dir / f"{task.task_id}.jsonl", events)

    last_kind = ""
    for item in reversed(events):
        if str(item.get("type")) in ("message.done", "error"):
            last_kind = str(item.get("type"))
            break

    meta = {
        "task_id": task.task_id,
        "view": task.view,
        "runtime": label,
        "mode": "dry-run" if dry_run else "real",
        "synthetic": bool(dry_run),
        "session_id": session_id,
        "prompt": task.prompt,
        "events": len(events),
        "tool_calls": sum(1 for item in events if item.get("type") == "tool.call"),
        "duration_ms": duration_ms,
        "duration_closed_by_done": closed_by_done,
        "approvals": approvals,
        "fallbacks": fallbacks,
        "finished_with": last_kind,
    }
    _write_json(out_dir / f"{task.task_id}.meta.json", meta)
    return meta


# --------------------------------------------------------------------------- 判定器接线
def call_judge(out_dir: Path, label: str, *, written: Sequence[str], full_run: bool,
               python: str | None = None) -> tuple[int, str]:
    """用 subprocess 调判分器 CLI，拿回它的退出码与原始输出。

    为什么走 CLI 而不是 import：判定口径必须只有一份，而「runner 无意中改了判分」
    这条路径在 import 的情况下是隐形的。调 CLI 时 runner 只有一个身份——调用方。

    为什么过滤运行时**逐条**调 `--events/--task` 而不是复用 `--events-dir`：
    `--events-dir` 永远判契约全部 30 条，缺的日志按 §3.3 记 `BLOCK`。而 `--tasks
    EV-01,EV-05` 时那 28 条**根本没被要求跑**，把它们写成"环境阻塞"是在报告里
    制造 28 条假阻塞，还会污染「两个运行时的 blocked 集合必须相同」这条判据。
    全 30 条时才用 `--events-dir`——那时缺日志才是真的缺。
    """
    if not JUDGE.is_file():
        raise UsageError(f"找不到判分器：{JUDGE}")
    env = dict(os.environ)
    parts = [str(ROOT / "src"), str(ROOT / "tools")]
    existing = env.get("PYTHONPATH", "")
    if existing:
        parts.append(existing)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    env["PYTHONIOENCODING"] = "utf-8"

    if full_run:
        commands = [[str(JUDGE), "--events-dir", str(out_dir), "--runtime", label]]
    else:
        commands = [[str(JUDGE), "--events", str(out_dir / f"{tid}.jsonl"),
                     "--task", tid] for tid in written]
    if not commands:
        return EXIT_FAIL, "（本轮没有写出任何日志，判分器无事可判；缺日志按阻塞计，不算通过）"

    worst = EXIT_OK
    chunks: list[str] = []
    for command in commands:
        proc = subprocess.run(
            [python or sys.executable, *command],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(ROOT), env=env)
        worst = max(worst, proc.returncode)   # 2 > 1 > 0：最坏的那个决定本轮
        chunks.append((proc.stdout or "") + (proc.stderr or ""))
    return worst, "\n".join(chunks)


def build_report(*, label: str, dry_run: bool, out_dir: Path, judge_rc: int,
                 judge_text: str, metas: Sequence[Mapping[str, Any]],
                 blocked: Sequence[Mapping[str, Any]], partial: bool = False) -> str:
    """拼 `report.md`：横幅 + 判分器原样输出 + runner 现场量。

    `duration_ms` 与 `approvals` 判分器算不出来（它只看事件流，不知道墙钟与审批语义），
    所以必须由 runner 补在这一节里，否则契约 §3.3 的九列永远短两列。
    """
    lines: list[str] = ["# eval-30 运行报告", ""]
    if dry_run:
        lines += [
            "> ⚠️ **这是 dry-run，不是真实评测。**",
            "> 事件里每条 `data.synthetic` 都是 `true`，假工具调用带 `E_DRYRUN`。",
            "> 下面的判分只能证明流水线接线正确，不能作为任何评测结论。",
            "> 真实结论必须来自 `--real --runtime <名字>`，"
            "且产物在 `logs/eval/<名字>/`。",
            "",
        ]
    if partial:
        lines += [
            "> 本轮是**部分任务**（`--tasks`）：判分器逐条判，所以下面每段只有一条。",
            "> 没被点名的任务不在本报告范围内，也**不**记成环境阻塞——"
            "它们不是缺日志，是没被要求跑。",
            "",
        ]
    lines += [
        f"- 运行时标签：`{label}`",
        f"- 模式：{'dry-run（内置假运行时）' if dry_run else '真实运行'}",
        f"- 日志目录：`{out_dir}`",
        f"- 已写日志：{len(metas)} 条；环境阻塞：{len(blocked)} 条",
        f"- 判分器退出码：{judge_rc}（0 全过 / 1 有 FAIL·manual·阻塞 / 2 输入坏掉）",
        f"- 生成时间：{_now_iso()}",
        "",
        "## 判分器原始输出",
        "",
        "```text",
        judge_text.rstrip("\n"),
        "```",
        "",
        "## runner 现场记的量（判分器算不出来）",
        "",
        "| task_id | duration_ms | approvals req/appr/rej/exp | fallbacks |",
        "|---|---|---|---|",
    ]
    for meta in sorted(metas, key=lambda item: str(item.get("task_id"))):
        counts = meta.get("approvals") or {}
        lines.append(
            "| {tid} | {ms} | {req}/{appr}/{rej}/{exp} | {fb} |".format(
                tid=meta.get("task_id", ""),
                ms=meta.get("duration_ms", 0),
                req=counts.get("request", 0),
                appr=counts.get("approved", 0),
                rej=counts.get("rejected", 0),
                exp=counts.get("expired", 0),
                fb=", ".join(meta.get("fallbacks") or []) or "—",
            ))
    if blocked:
        lines += ["", "## 环境阻塞（既不判 pass 也不判 fail）", "",
                  "| task_id | 原因 |", "|---|---|"]
        for item in blocked:
            lines.append(f"| {item.get('task_id', '')} | {item.get('reason', '')} |")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- 主流程
def main(argv: Sequence[str] | None = None,
         runtimes: Mapping[str, Any] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass
    try:
        return _main(argv, runtimes)
    except UsageError as exc:
        print(f"[用法] {exc}")
        return EXIT_USAGE


def _write_blocked(out_dir: Path, *, label: str, dry_run: bool,
                   available: bool, blocked: Sequence[Mapping[str, Any]]) -> None:
    _write_json(out_dir / "_blocked.json", {
        "runtime": label,
        "mode": "dry-run" if dry_run else "real",
        "synthetic": bool(dry_run),
        "checked_at": _now_iso(),
        "blocked": "environment",
        "runtime_available": available,
        "reason": str(blocked[0].get("reason", "")) if blocked else "",
        "count": len(blocked),
        "tasks": list(blocked),
    })


def _main(argv: Sequence[str] | None,
          injected: Mapping[str, Any] | None) -> int:
    ap = argparse.ArgumentParser(
        description="驱动一个运行时跑完 eval-30 的 30 条任务，逐条落 JSONL，"
                    "再用 eval30_judge.py 出报告")
    ap.add_argument("--runtime", default="",
                    help="运行时名字（可用名单从 fieldstation.runtimes 现场发现）")
    ap.add_argument("--real", action="store_true",
                    help="真的驱动运行时（默认是 dry-run：不动模型、不联网）")
    ap.add_argument("--dry-run", action="store_true",
                    help="显式声明 dry-run（默认就是；与 --real 互斥）")
    ap.add_argument("--tasks", default="", help="只跑这些任务，如 EV-01,EV-05")
    ap.add_argument("--out-dir", default="",
                    help="日志根目录；dry-run 默认 logs/eval/_dryrun/<runtime>/")
    ap.add_argument("--summarize", action="store_true",
                    help="跑完后调 eval30_judge.py，打印并落 <out-dir>/report.md")
    ap.add_argument("--allow-outside-repo", action="store_true",
                    help="允许把日志写到仓库与系统临时目录之外（默认拒绝）")
    ap.add_argument("--contract", default=str(CONTRACT), help="契约文档路径")
    ap.add_argument("--list-tasks", action="store_true", help="打印解析出的任务清单")
    args = ap.parse_args(argv)

    if args.real and args.dry_run:
        raise UsageError("--real 与 --dry-run 互斥：默认就是 dry-run，要真跑只给 --real")
    dry_run = not args.real

    contract_path = Path(args.contract).expanduser()
    tasks = load_contract_tasks(contract_path)

    if args.list_tasks:
        for task in tasks:
            print(f"{task.task_id}  {task.view}  {task.prompt}")
        print(f"\n共 {len(tasks)} 条")
        return EXIT_OK

    selected = select_tasks(tasks, args.tasks)

    label = args.runtime.strip()
    if not label:
        if not dry_run:
            raise UsageError("真实运行必须用 --runtime 指定运行时")
        label = DRYRUN_LABEL

    out_dir = Path(args.out_dir) if args.out_dir else default_out_dir(label, dry_run)
    out_dir = check_out_dir(out_dir, dry_run=dry_run, label=label,
                            allow_outside=args.allow_outside_repo)

    protocol = _protocol()

    if dry_run:
        driver: Any = DryRunRuntime()
    else:
        table = dict(injected) if injected is not None else discover_runtimes()
        if label not in table:
            raise UsageError(f"没有这个运行时：{label!r}；可用：{sorted(table)}")
        driver = table[label]

    mode_text = "dry-run（内置假运行时，不是真实评测）" if dry_run else "真实运行"
    print("=" * 68)
    print(f"eval-30 runner · 运行时={label} · 模式={mode_text}")
    print(f"任务 {len(selected)} 条 → {out_dir}")
    print("=" * 68)

    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- 可用性：不可用就逐条记阻塞，绝不伪造日志
    blocked: list[dict] = []
    try:
        available = bool(driver.available())
        probe_error = ""
    except Exception as exc:  # noqa: BLE001 —— 探测失败也是不可用，不该炸掉整轮
        available = False
        probe_error = f"{type(exc).__name__}: {exc}"

    if not available:
        reason = probe_error or f"运行时 {label!r} 的 available() 为假"
        blocked = [{"task_id": task.task_id, "blocked": "environment",
                    "reason": reason} for task in selected]
        print(f"[阻塞] 运行时 {label!r} 不可用：{reason}")
        print(f"[阻塞] 已逐条记 {len(blocked)} 条 blocked: environment；"
              "按契约 §3.3 既不判 pass 也不判 fail，且不写任何 .jsonl。")

    # ---- 真正跑
    metas: list[dict] = []
    if available:
        for task in selected:
            try:
                meta = run_one(driver, task, label=label, dry_run=dry_run,
                               out_dir=out_dir, protocol=protocol)
            except (protocol.RuntimeUnavailable, NoEvents) as exc:
                # 环境打断：不落 .jsonl（否则判分器会把它判成 FAIL），只记阻塞与排障文件。
                blocked.append({"task_id": task.task_id,
                                "blocked": "environment", "reason": str(exc)})
                _write_json(out_dir / f"{task.task_id}.blocked.json",
                            {"task_id": task.task_id, "blocked": "environment",
                             "reason": str(exc), "at": _now_iso()})
                print(f"[阻塞] {task.task_id}：{exc}")
                continue
            metas.append(meta)
            print(f"  {task.task_id}  事件 {meta['events']:>3}  "
                  f"工具 {meta['tool_calls']:>2}  {meta['duration_ms']:>5} ms")

    if blocked:
        _write_blocked(out_dir, label=label, dry_run=dry_run,
                       available=available, blocked=blocked)

    _write_json(out_dir / "_run.json", {
        "runtime": label,
        "mode": "dry-run" if dry_run else "real",
        "synthetic": bool(dry_run),
        "contract": str(contract_path),
        "generated_at": _now_iso(),
        "requested": [task.task_id for task in selected],
        "written": [meta["task_id"] for meta in metas],
        "blocked": [item["task_id"] for item in blocked],
        "summary": {
            "tasks": len(selected),
            "written": len(metas),
            "blocked": len(blocked),
        },
    })

    # ---- 判分（可选）
    judge_rc: int | None = None
    judge_text = ""
    if args.summarize:
        print("\n---- eval30_judge.py 原始输出 ----")
        judge_rc, judge_text = call_judge(
            out_dir, label,
            written=[meta["task_id"] for meta in metas],
            full_run=len(selected) == len(tasks))
        print(judge_text.rstrip("\n"))
        report = build_report(label=label, dry_run=dry_run, out_dir=out_dir,
                              judge_rc=judge_rc, judge_text=judge_text,
                              metas=metas, blocked=blocked,
                              partial=len(selected) != len(tasks))
        (out_dir / "report.md").write_text(report, encoding="utf-8", newline="\n")
        print(f"报告：{out_dir / 'report.md'}")

    # ---- 汇总
    print("\n" + "-" * 68)
    if dry_run:
        print("模式：dry-run —— 这是流水线自检，**不是真实评测**。"
              "所有日志的 data.synthetic 均为 true。")
    print(f"已写日志 {len(metas)}/{len(selected)}；环境阻塞 {len(blocked)}")
    if judge_rc is not None:
        print(f"判分器退出码={judge_rc}（判分器的码原样报出，不由 runner 改写）")
    elif not blocked:
        print("未判分（没有 --summarize）：本 runner 不对通过率做任何声称。")
    if dry_run:
        print("runner 退出码 0 只表示流水线跑通，**不代表任何一条任务通过**。")

    # ---- 退出码
    if blocked or len(metas) != len(selected):
        return EXIT_FAIL
    if dry_run:
        return EXIT_OK        # 流水线健康；判分结论见上面打印的 judge 退出码
    if judge_rc is not None:
        return judge_rc if judge_rc in (EXIT_OK, EXIT_FAIL, EXIT_USAGE) else EXIT_FAIL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
