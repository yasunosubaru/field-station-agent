#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`tools/eval30_run.py` 的行为钉死（离线、无模型、无网络）。

## 为什么这套测试全部用假运行时

runner 的唯一职责是「喂 prompt、收事件、落 JSONL、记账」。它一旦真的去连一个模型，
这套测试就变成了"本机环境是否装好了运行时"的测试：CI 上没有端点就红，红灯的原因
还不是 runner 坏了。所以这里的每个运行时都是本地类，事件序列写死在测试里。

## 每条用例在防什么

| 用例 | 防的错法 |
|---|---|
| dry-run 全流程 | 落盘形状坏了 / 假标记漏了 / 有人把 dry-run 当真实评测 |
| 契约解析 | runner 手抄 30 条 prompt，与契约脱节 |
| `--tasks` 过滤 | 过滤逻辑静默忽略参数，白跑 30 条 |
| 运行时不可用 | **伪造日志**，把"没跑"写成"跑了但没过" |
| 目录隔离 | dry-run 产物落进 `logs/eval/<runtime>/`，以后真假不分 |
| 中途掉线 | 半截 JSONL 被当成"跑完了但判不过" |
| `--summarize` | 判分器根本没被调，报告却是 runner 自己写的 |
| 越界写盘 | 一个 `--out-dir` 就把文件写到仓库外 |

**没有 skipTest**：本仓库纪律是 skip 必须为 0。条件不满足时断言"降级行为正确"，
而不是跳过。
"""
from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "docs" / "contracts" / "eval-30.md"
TOOL = ROOT / "tools" / "eval30_run.py"

for _extra in (str(ROOT / "src"), str(ROOT / "tools"), str(ROOT)):
    if _extra not in sys.path:
        sys.path.insert(0, _extra)

import eval30_run as R  # noqa: E402
from fieldstation.runtimes import TYPES, Event, RuntimeUnavailable  # noqa: E402


# --------------------------------------------------------------------------- 假运行时
def _event(kind: str, session_id: str, data: dict) -> Event:
    return Event(kind, session_id, dict(data))


class ScriptedRuntime:
    """按固定脚本吐事件；脚本为空就什么都不吐。"""

    name = "scripted"

    def __init__(self, script: list[dict] | None = None) -> None:
        self.script = list(script or [])

    def available(self) -> bool:
        return True

    def cancel(self, session_id: str) -> None:
        return None

    def run(self, req):
        for item in self.script:
            data = dict(item.get("data") or {})
            data.setdefault("runtime", self.name)
            yield _event(str(item["type"]), req.session_id, data)


class OfflineRuntime:
    """`available()` 恒假：模拟"套件/端点没装"。"""

    name = "offline"

    def available(self) -> bool:
        return False

    def cancel(self, session_id: str) -> None:
        return None

    def run(self, req):  # pragma: no cover - 不可用时不该被调用
        raise AssertionError("不可用的运行时不该被调用 run()")
        yield  # noqa: unreachable - 让函数保持生成器语义


class DropsMidwayRuntime:
    """吐一条事件后端口掉线：模拟环境在跑的中途坏掉。"""

    name = "drops"

    def available(self) -> bool:
        return True

    def cancel(self, session_id: str) -> None:
        return None

    def run(self, req):
        yield _event("session.start", req.session_id, {"runtime": self.name})
        raise RuntimeUnavailable("端口 8765 在运行中掉线")


class ExplodingProbeRuntime:
    """`available()` 自己抛异常（探测过程炸掉）。"""

    name = "explode"

    def available(self) -> bool:
        raise OSError("套件路径不存在")

    def cancel(self, session_id: str) -> None:
        return None

    def run(self, req):  # pragma: no cover
        raise AssertionError("探测失败的运行时不该被 run()")
        yield  # noqa: unreachable


#: 一条带审批的事件脚本，用来验 `approvals` 四计数与 `duration_ms`。
APPROVAL_SCRIPT = [
    {"type": "session.start", "data": {"runtime": "scripted", "model": "fake"}},
    {"type": "tool.call", "data": {"id": "t0001", "name": "execute_device_action",
                                   "arguments": "{}", "risk": "high"}},
    {"type": "approval.request", "data": {"approval_id": "ap-01", "call_id": "t0001",
                                          "name": "execute_device_action",
                                          "risk": "high", "reason": "会重启设备",
                                          "prompt": "批准重启？"}},
    {"type": "approval.result", "data": {"approval_id": "ap-01", "call_id": "t0001",
                                         "verdict": "rejected", "by": "tester"}},
    {"type": "tool.result", "data": {"id": "t0001", "name": "execute_device_action",
                                     "ok": False,
                                     "error": {"code": "E_APPROVAL_DENIED",
                                               "message": "被拒", "retryable": False}}},
    {"type": "message.done", "data": {"reason": "stop", "content": "未执行"}},
    {"type": "usage", "data": {"prompt_tokens": 10, "completion_tokens": 5}},
]


# --------------------------------------------------------------------------- 小工具
def _run_main(*args: str, runtimes: dict | None = None) -> tuple[int, str]:
    """在进程内调 main()，把 stdout 抓回来。返回 (退出码, 输出)。"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = R.main(list(args), runtimes=runtimes)
    return rc, buf.getvalue()


def _jsonl_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.glob("EV-*.jsonl"))


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in
            path.read_text("utf-8").splitlines() if line.strip()]


def _contract_row(task_id: str) -> list[str]:
    """从契约**现读**一行表格，独立于 runner 自己的解析器切单元格。

    独立实现是刻意的：拿 runner 的解析器去核对 runner 的解析结果，等于让错的人改卷。
    """
    for line in CONTRACT.read_text("utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if cells and cells[0] == task_id:
            return cells
    raise AssertionError(f"契约里找不到 {task_id}")


# --------------------------------------------------------------------------- 1. dry-run 全流程
class DryRunFlow(unittest.TestCase):
    def test_thirty_logs_and_legal_event_shapes(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "dryrun"
            rc, text = _run_main("--dry-run", "--out-dir", str(out))
            self.assertEqual(rc, 0, text)
            files = _jsonl_files(out)
            self.assertEqual(len(files), 30, [p.name for p in files])
            self.assertEqual([p.stem for p in files],
                             [f"EV-{i:02d}" for i in range(1, 31)])

            for path in files:
                events = _read_jsonl(path)
                self.assertGreaterEqual(len(events), 1, path.name)
                for event in events:
                    self.assertIn(event["type"], TYPES, path.name)
                    self.assertIsInstance(event["session_id"], str)
                    self.assertIsInstance(event["data"], dict)
                # 假标记必须逐条都在 —— 这一条漏了，假日志就能冒充真日志。
                for event in events:
                    self.assertIs(event["data"].get("synthetic"), True,
                                  f"{path.name} 有事件没标 synthetic")
                kinds = [e["type"] for e in events]
                self.assertIn("message.done", kinds, path.name)

    def test_summary_says_it_is_dryrun(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "dryrun"
            _rc, text = _run_main("--out-dir", str(out))
            self.assertIn("dry-run", text)
            self.assertIn("不是真实评测", text)
            self.assertIn("不代表任何一条任务通过", text)

    def test_dryrun_never_passes_a_task(self):
        """假数据必须一条都判不过，否则"假数据碰巧过了一条"会被误读成真结论。"""
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "dryrun"
            rc, text = _run_main("--dry-run", "--out-dir", str(out), "--summarize")
            self.assertEqual(rc, 0, text)
            self.assertIn("PASS 0", text)
            self.assertIn("E_DRYRUN", "".join(
                p.read_text("utf-8") for p in _jsonl_files(out)))

    def test_meta_records_runner_side_quantities(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "dryrun"
            _run_main("--tasks", "EV-01", "--out-dir", str(out))
            meta = json.loads((out / "EV-01.meta.json").read_text("utf-8"))
            for key in ("duration_ms", "approvals", "fallbacks", "tool_calls"):
                self.assertIn(key, meta, key)
            self.assertGreaterEqual(meta["duration_ms"], 0)
            self.assertEqual(set(meta["approvals"]),
                             {"request", "approved", "rejected", "expired"})
            self.assertIs(meta["synthetic"], True)


# --------------------------------------------------------------------------- 2. 契约解析
class ContractParsing(unittest.TestCase):
    def setUp(self):
        self.tasks = R.load_contract_tasks(CONTRACT)

    def test_thirty_tasks_with_stable_ids(self):
        self.assertEqual(len(self.tasks), 30)
        self.assertEqual([t.task_id for t in self.tasks],
                         [f"EV-{i:02d}" for i in range(1, 31)])

    def test_prompt_is_the_verbatim_contract_text(self):
        by_id = {t.task_id: t for t in self.tasks}
        for task_id in ("EV-17", "EV-01", "EV-30"):
            with self.subTest(task_id=task_id):
                self.assertEqual(by_id[task_id].prompt, _contract_row(task_id)[2])

    def test_ev17_prompt_read_fresh_from_contract(self):
        """不抄期望值：EV-17 的输入从契约文本现取，且必须是那条问行数的中文。"""
        by_id = {t.task_id: t for t in self.tasks}
        fresh = _contract_row("EV-17")[2]
        self.assertEqual(by_id["EV-17"].prompt, fresh)
        self.assertIn("2026-10-01", fresh)
        self.assertIn("多少行", fresh)

    def test_empty_contract_is_fatal_not_zero_pass(self):
        """解析出 0 条必须硬失败：0 条绝不能被当成"全部通过"。

        纯解析函数返回空表是它的正常行为（它是形状匹配器）；**落成一次运行**的那层
        （`load_contract_tasks`）才必须把空表判死。混为一谈会让"契约表结构坏了"
        这件事一路静默到报告里变成 0 条 0 失败。
        """
        self.assertEqual(R.parse_contract_tasks("| 不是 | 任务表 |\n|---|---|\n"), [])
        with tempfile.TemporaryDirectory() as td:
            bogus = Path(td) / "bogus.md"
            bogus.write_text("| 不是 | 任务表 |\n|---|---|\n", encoding="utf-8")
            with self.assertRaises(R.UsageError):
                R.load_contract_tasks(bogus)
        with self.assertRaises(R.UsageError):
            R.load_contract_tasks(ROOT / "docs" / "contracts" / "no-such-contract.md")

    def test_view_column_is_carried(self):
        by_id = {t.task_id: t for t in self.tasks}
        self.assertEqual(by_id["EV-01"].view, "对话")
        self.assertEqual(by_id["EV-17"].view, "数据")


# --------------------------------------------------------------------------- 3. --tasks 过滤
class TaskFilter(unittest.TestCase):
    def test_two_tasks_two_files(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "two"
            rc, text = _run_main("--tasks", "EV-01,EV-05", "--out-dir", str(out))
            self.assertEqual(rc, 0, text)
            self.assertEqual([p.stem for p in _jsonl_files(out)], ["EV-01", "EV-05"])

    def test_unknown_task_is_usage_error(self):
        with tempfile.TemporaryDirectory() as td:
            rc, text = _run_main("--tasks", "EV-99", "--out-dir", str(Path(td) / "x"))
            self.assertEqual(rc, 2, text)
            self.assertIn("EV-99", text)
            self.assertIn("可用", text)

    def test_duplicate_ids_run_once(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "dup"
            _run_main("--tasks", "EV-02,EV-02", "--out-dir", str(out))
            self.assertEqual([p.stem for p in _jsonl_files(out)], ["EV-02"])


# --------------------------------------------------------------------------- 4. 运行时不可用
class RuntimeUnavailablePath(unittest.TestCase):
    def test_offline_runtime_blocks_without_fake_logs(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "real"
            rc, text = _run_main("--real", "--runtime", "offline",
                                 "--out-dir", str(out),
                                 runtimes={"offline": OfflineRuntime()})
            self.assertNotEqual(rc, 0, text)              # 阻塞必须非零退出
            self.assertEqual(rc, 1, text)
            self.assertEqual(_jsonl_files(out), [])       # 一条日志都不许伪造
            blocked = json.loads((out / "_blocked.json").read_text("utf-8"))
            self.assertEqual(blocked["blocked"], "environment")
            self.assertEqual(blocked["count"], 30)
            self.assertIs(blocked["runtime_available"], False)
            self.assertTrue(all(item["blocked"] == "environment"
                                for item in blocked["tasks"]))
            self.assertIn("环境阻塞 30", text)

    def test_probe_exception_also_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "boom"
            rc, text = _run_main("--real", "--runtime", "explode",
                                 "--out-dir", str(out),
                                 runtimes={"explode": ExplodingProbeRuntime()})
            self.assertEqual(rc, 1, text)
            self.assertEqual(_jsonl_files(out), [])
            blocked = json.loads((out / "_blocked.json").read_text("utf-8"))
            self.assertIn("OSError", blocked["reason"])

    def test_drop_midway_does_not_write_half_log(self):
        """中途掉线 = 环境阻塞，不能留一份半截 JSONL 被判成 FAIL。"""
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "drops"
            rc, text = _run_main("--real", "--runtime", "drops",
                                 "--tasks", "EV-01",
                                 "--out-dir", str(out),
                                 runtimes={"drops": DropsMidwayRuntime()})
            self.assertEqual(rc, 1, text)
            self.assertEqual(_jsonl_files(out), [])
            self.assertTrue((out / "EV-01.blocked.json").is_file())
            blocked = json.loads((out / "_blocked.json").read_text("utf-8"))
            self.assertEqual(blocked["count"], 1)
            self.assertIn("掉线", blocked["tasks"][0]["reason"])

    def test_unknown_runtime_lists_available(self):
        rc, text = _run_main("--real", "--runtime", "nope",
                             runtimes={"scripted": ScriptedRuntime()})
        self.assertEqual(rc, 2, text)
        self.assertIn("nope", text)
        self.assertIn("scripted", text)

    def test_real_mode_cannot_omit_runtime(self):
        rc, text = _run_main("--real")
        self.assertEqual(rc, 2, text)
        self.assertIn("--runtime", text)


# --------------------------------------------------------------------------- 5. 目录隔离
class DirectoryIsolation(unittest.TestCase):
    def test_dryrun_default_dir_differs_from_real_dir(self):
        real = R.default_out_dir("opencode", dry_run=False)
        dry = R.default_out_dir("opencode", dry_run=True)
        self.assertNotEqual(real, dry)
        self.assertEqual(real, ROOT / "logs" / "eval" / "opencode")
        self.assertIn(R.DRYRUN_DIRNAME, dry.parts)
        self.assertNotEqual(dry.parent, real.parent)

    def test_dryrun_label_default_is_not_a_runtime_dir(self):
        dry = R.default_out_dir(R.DRYRUN_LABEL, dry_run=True)
        real = R.default_out_dir(R.DRYRUN_LABEL, dry_run=False)
        self.assertNotEqual(dry, real)

    def test_dryrun_refuses_real_product_dir(self):
        target = ROOT / "logs" / "eval" / "opencode"
        with self.assertRaises(R.UsageError):
            R.check_out_dir(target, dry_run=True, label="opencode")

    def test_cli_refuses_dryrun_into_real_dir(self):
        target = ROOT / "logs" / "eval" / "claude"
        rc, text = _run_main("--dry-run", "--runtime", "claude",
                             "--out-dir", str(target))
        self.assertEqual(rc, 2, text)
        self.assertIn("dry-run 不能写进真实产物目录", text)
        self.assertFalse(target.exists(), "被拒绝的目录不该被创建")

    def test_real_mode_allows_real_product_dir(self):
        """真实运行写真实目录是**允许**的——这条防止把守卫写成"谁都不许写"。"""
        target = ROOT / "logs" / "eval" / "claude"
        got = R.check_out_dir(target, dry_run=False, label="claude")
        self.assertEqual(got, target.resolve())


# --------------------------------------------------------------------------- 6. --summarize 真的调判分器
class SummarizeWiring(unittest.TestCase):
    def test_summarize_prints_judge_output_and_writes_report(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "sum"
            rc, text = _run_main("--out-dir", str(out), "--summarize")
            self.assertEqual(rc, 0, text)
            # 判分器的表格表头与合计行只可能来自它自己，runner 不复制这些口径。
            self.assertIn("合计 30 条", text)
            self.assertIn("判分器退出码", text)
            self.assertIn("eval30_judge.py 原始输出", text)
            report = (out / "report.md").read_text("utf-8")
            self.assertIn("合计 30 条", report)
            self.assertIn("这是 dry-run，不是真实评测", report)
            self.assertIn("duration_ms", report)
            self.assertIn("approvals", report)

    def test_filtered_summarize_does_not_invent_blocks(self):
        """`--tasks EV-01,EV-05` 时另外 28 条是**没被要求跑**，不是缺日志。

        若照搬 `--events-dir`，判分器会把它们写成 28 条 `BLOCK`——报告里凭空多出
        28 条环境阻塞，还会让「两个运行时的 blocked 集合必须相同」这条判据失效。
        """
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "partial"
            rc, text = _run_main("--tasks", "EV-01,EV-05",
                                 "--out-dir", str(out), "--summarize")
            self.assertEqual(rc, 0, text)
            self.assertNotIn("BLOCK", text, "部分运行不许凭空造阻塞")
            self.assertNotIn("环境阻塞 2", text)
            self.assertNotIn("环境阻塞 30", text)
            self.assertIn("环境阻塞 0", text)
            self.assertIn("部分任务", (out / "report.md").read_text("utf-8"))

    def test_judge_exit_code_is_one_of_0_1_2(self):
        """不断言通过率（判分口径会变），只钉住"判分器真的跑起来了"。"""
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "rc"
            _rc, text = _run_main("--tasks", "EV-02", "--out-dir", str(out),
                                  "--summarize")
            match = re.search(r"判分器退出码=(\d+)", text)
            self.assertIsNotNone(match, text)
            self.assertIn(int(match.group(1)), (0, 1, 2))

    def test_summarize_on_blocked_run_still_reports_blocked(self):
        """没有日志时判分器必须报 BLOCK，runner 也不许把它算成通过。"""
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "blocked"
            rc, text = _run_main("--real", "--runtime", "offline",
                                 "--tasks", "EV-01,EV-02",
                                 "--out-dir", str(out), "--summarize",
                                 runtimes={"offline": OfflineRuntime()})
            self.assertEqual(rc, 1, text)
            self.assertIn("环境阻塞 2", text)
            self.assertIn("无事可判", text)


# --------------------------------------------------------------------------- 7. 越界写盘
class OutDirSafety(unittest.TestCase):
    def _outside_path(self) -> Path:
        """仓库与临时目录之外的一个位置（不创建、不写）。"""
        temp = Path(tempfile.gettempdir()).resolve()
        for candidate in temp.parents:
            if not R._inside(candidate, ROOT) and not R._inside(candidate, temp):
                return candidate / "eval30-outside-probe"
        raise AssertionError("找不到仓库与临时目录之外的位置")

    def test_rejects_outside_repo_and_temp(self):
        target = self._outside_path()
        rc, text = _run_main("--dry-run", "--out-dir", str(target))
        self.assertEqual(rc, 2, text)
        self.assertIn("拒绝把日志写到仓库与系统临时目录之外", text)
        self.assertFalse(target.exists(), "被拒绝的目录不该被创建")

    def test_allow_flag_warns_but_proceeds(self):
        target = self._outside_path()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            got = R.check_out_dir(target, dry_run=True, label="dryrun",
                                  allow_outside=True)
        self.assertEqual(got, target.resolve())
        self.assertIn("--allow-outside-repo 已生效", buf.getvalue())

    def test_temp_dir_is_allowed(self):
        with tempfile.TemporaryDirectory() as td:
            got = R.check_out_dir(Path(td) / "ok", dry_run=True, label="dryrun")
            self.assertEqual(got, (Path(td) / "ok").resolve())


# --------------------------------------------------------------------------- 记账细节
class BookKeeping(unittest.TestCase):
    def test_approvals_and_duration_come_from_runner(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "ap"
            rc, text = _run_main("--real", "--runtime", "scripted",
                                 "--tasks", "EV-05", "--out-dir", str(out),
                                 runtimes={"scripted": ScriptedRuntime(APPROVAL_SCRIPT)})
            self.assertEqual(rc, 0, text)
            meta = json.loads((out / "EV-05.meta.json").read_text("utf-8"))
            self.assertEqual(meta["approvals"],
                             {"request": 1, "approved": 0, "rejected": 1, "expired": 0})
            self.assertEqual(meta["tool_calls"], 1)
            self.assertTrue(meta["duration_closed_by_done"])
            self.assertGreaterEqual(meta["duration_ms"], 0)
            # 真实模式下不许出现 synthetic 注入，否则真假又混了。
            for event in _read_jsonl(out / "EV-05.jsonl"):
                self.assertNotIn("synthetic", event["data"])

    def test_seq_and_session_id_are_normalised(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "seq"
            _run_main("--real", "--runtime", "scripted", "--tasks", "EV-01",
                      "--out-dir", str(out),
                      runtimes={"scripted": ScriptedRuntime(APPROVAL_SCRIPT)})
            events = _read_jsonl(out / "EV-01.jsonl")
            self.assertEqual([e["seq"] for e in events],
                             list(range(1, len(events) + 1)))
            self.assertEqual(len({e["session_id"] for e in events}), 1)

    def test_fallbacks_collected(self):
        script = [
            {"type": "session.start", "data": {"runtime": "scripted",
                                               "fallbacks": ["engine:duckdb"],
                                               "memory_missing": True}},
            {"type": "message.done", "data": {"reason": "stop", "content": "x"}},
        ]
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "fb"
            _run_main("--real", "--runtime", "scripted", "--tasks", "EV-13",
                      "--out-dir", str(out),
                      runtimes={"scripted": ScriptedRuntime(script)})
            meta = json.loads((out / "EV-13.meta.json").read_text("utf-8"))
            self.assertIn("engine:duckdb", meta["fallbacks"])
            self.assertIn("memory_missing", meta["fallbacks"])

    def test_bad_event_type_is_fatal(self):
        script = [{"type": "not.a.real.type", "data": {}}]
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "bad"
            rc, text = _run_main("--real", "--runtime", "scripted",
                                 "--tasks", "EV-01", "--out-dir", str(out),
                                 runtimes={"scripted": ScriptedRuntime(script)})
            self.assertEqual(rc, 2, text)
            self.assertIn("事件类型非法", text)

    def test_run_index_lists_written_tasks(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "idx"
            _run_main("--tasks", "EV-01,EV-02", "--out-dir", str(out))
            index = json.loads((out / "_run.json").read_text("utf-8"))
            self.assertEqual(index["written"], ["EV-01", "EV-02"])
            self.assertEqual(index["blocked"], [])
            self.assertEqual(index["summary"]["written"], 2)
            self.assertIs(index["synthetic"], True)


# --------------------------------------------------------------------------- 运行时发现
class Discovery(unittest.TestCase):
    def test_finds_repo_runtimes_from_the_package(self):
        """名单必须从包现场发现，不能硬编码。

        `OpenCodeRuntime` 是 `OpenAICompatibleRuntime` 的别名（实例 `.name` 是
        `openai-compatible`），而契约 §3.3 里的运行时名是 `opencode`。所以别名注册
        是必要的：只认实例 `.name` 的话，`--runtime opencode` 会报"没有这个运行时"。

        **不断言 `opencode` 与 `openai-compatible` 是同一个实例**：仓库里正在新增一个
        真正的 `OpenCodeNativeRuntime`（它的 `.name` 就是 `opencode`）。一旦它被导出，
        `opencode` 就该指向它而不是别名。钉死身份会让别人的正常工作把我的测试弄红。
        """
        found = R.discover_runtimes()
        self.assertIn("claude", found)
        self.assertIn("fake", found)
        self.assertIn("openai-compatible", found)
        self.assertIn("opencode", found)
        for key, runtime in found.items():
            with self.subTest(key=key):
                self.assertTrue(callable(runtime.available))
                self.assertTrue(callable(runtime.run))
                self.assertTrue(callable(runtime.cancel))

    def test_discovered_runtime_is_usable_by_name(self):
        """发现出来的名字必须能真的驱动一轮（这里用 fake，不联网）。"""
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "fake"
            rc, text = _run_main("--real", "--runtime", "fake",
                                 "--tasks", "EV-01", "--out-dir", str(out),
                                 runtimes=R.discover_runtimes())
            self.assertEqual(rc, 0, text)
            self.assertTrue((out / "EV-01.jsonl").is_file())

    def test_one_instance_per_class(self):
        """同一个类挂两个名字时只该构造一次 —— 否则"是不是同一个运行时"没人说得清。"""
        class Shared:
            name = "shared"

            def __init__(self):
                Shared.constructed += 1

            def available(self):
                return True

            def run(self, req):
                return iter(())

            def cancel(self, session_id):
                return None

        class Package:
            Alpha = Shared
            Beta = Shared        # 同一类的第二个名字，模拟 OpenCodeRuntime 别名

        Shared.constructed = 0
        found = R.discover_runtimes(Package)
        self.assertEqual(Shared.constructed, 1)
        self.assertIs(found["shared"], found["alpha"])

    def test_unconstructible_class_is_skipped_not_fatal(self):
        class NeedsArgs:
            name = "needs-args"

            def __init__(self, required):     # 故意构造不了
                self.required = required

            def available(self):
                return True

            def run(self, req):
                return iter(())

            def cancel(self, session_id):
                return None

        class Package:
            Broken = NeedsArgs
            Good = ScriptedRuntime

        found = R.discover_runtimes(Package)
        self.assertIn("scripted", found)      # Good 被发现了
        self.assertNotIn("needs-args", found)  # Broken 构造不了，跳过


if __name__ == "__main__":
    unittest.main()
