"""`runtimes/opencode.py`：把 `opencode run --format json` 的 NDJSON 折成内部事件。

## 为什么不真的调用模型

真调要网络、要额度、要几分钟，而且**结果不确定**——测试会因为模型今天说了什么
而红或绿，那是不可接受的。所以这里用一个**假的 opencode 脚本**：它照抄我从
`opencode v2.2.0` 实测抓到的 NDJSON 原文（见 `runtimes/opencode.py` 的模块 docstring），
只是把文本与工具输出换成常量。

假脚本是 `.py`（用同一个解释器跑），不是 `.bat`：Windows 上 `.bat` 在
`subprocess` 里的引号处理很麻烦，而这里要测的是**解析**，不是引号。

## 要钉住的六件事

1. 四种真实事件都能正确映射（`step_start` 帧 / `tool_use` / `text` / `step_finish`）。
2. **没有显式终止事件**：`opencode run` 跑完就退出，`message.done` 由适配器补。
3. **非零退出不许补 `stop`**——否则崩溃会被显示成一次成功的空回答。
4. 非 JSON 行折成 `error`，不静默丢。
5. **未知类型也折成 `error`**，不静默丢（这条最重要）。
6. `cancel()` 能真的结束进程树。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from fieldstation.runtimes.base import TYPES, RuntimeRequest, RuntimeUnavailable
from fieldstation.runtimes.opencode import OpenCodeNativeRuntime


def _write_script(dirpath: Path, body: str, name: str = "fake_opencode.py") -> Path:
    """造一个假 opencode，返回**可以直接当可执行文件用**的路径。

    为什么不是直接返回那个 `.py`：Windows 上 `.py` 不是可执行格式，`Popen` 会报
    `[WinError 193] 不是有效的 Win32 应用程序`。所以写一个 `.cmd` 包装器去调
    当前解释器 —— 它与真实 `opencode.exe` 一样是"一个能被 spawn 的文件"，
    适配器那边不需要为测试开特例。

    `.cmd` 里的路径都加引号：`%TEMP%` 在有些账户下带空格。
    """
    script = dirpath / name
    script.write_text(textwrap.dedent(body), encoding="utf-8")

    wrapper = script.with_suffix(".cmd")
    # `.cmd` 不自带编码声明，Windows 控制台按本地代码页读它。所以：
    #   · 路径里可能有非 ASCII（`%TEMP%` 在中文账户名下属常见情况）；
    #   · 用 `chcp 65001` 切到 UTF-8，再逐行写 UTF-8 字节，两边就对上了。
    # 直接 `encoding="ascii"` 会在中文路径上抛 UnicodeEncodeError（实测踩过）。
    wrapper.write_text(
        "@echo off\r\n"
        "chcp 65001 >NUL\r\n"
        f'"{sys.executable}" "{script}" %*\r\n',
        encoding="utf-8",
        newline="\r\n",
    )
    return wrapper


def _fake(binary: Path, timeout: float = 30.0) -> OpenCodeNativeRuntime:
    return OpenCodeNativeRuntime(binary=binary, timeout=timeout)


def _print_script(lines) -> str:
    """把若干 dict 包成一段"逐行打印 NDJSON"的 Python 脚本。

    **不能把 NDJSON 原文直接当脚本写**：`{"type": "step_start", ...}` 在 Python 里
    是一个合法的字典字面量表达式，它求值但不打印 —— 于是子进程静默退出、
    适配器正确地报"没有输出任何事件"，而测试看起来像适配器坏了。实测踩过一次。
    """
    out = ["import json", "import sys"]
    for line in lines:
        out.append(f"print(json.dumps({line!r}, ensure_ascii=False), flush=True)")
    return "\n".join(out) + "\n"


#: 实测抓到的四种事件（2026-11-07，opencode v2.2.0），只把文本与输出换成常量。
REAL_LINES = [
    {"type": "step_start", "timestamp": 1794048255665, "sessionID": "ses_test",
     "part": {"id": "prt_1", "sessionID": "ses_test", "messageID": "msg_1",
              "type": "step-start", "snapshot": "5e6ceffd"}},
    {"type": "tool_use", "timestamp": 1794048258057, "sessionID": "ses_test",
     "part": {"partID": "prt_2", "sessionID": "ses_test", "messageID": "msg_1",
              "type": "tool", "id": "call_abc", "tool": "shell",
              "state": {"status": "completed",
                        "input": {"command": "echo W4PROBE"},
                        "output": "W4PROBE\n", "title": "shell",
                        "metadata": {"metadata": {"status": "completed",
                                                  "truncated": False, "exit": 0}},
                        "time": {"start": 1794048257344, "end": 1794048258057}}}},
    {"type": "step_finish", "timestamp": 1794048258122, "sessionID": "ses_test",
     "part": {"id": "prt_3", "sessionID": "ses_test", "messageID": "msg_1",
              "type": "step-finish", "reason": "tool-calls", "cost": 0.000892428,
              "tokens": {"input": 3606, "output": 46, "reasoning": 129,
                         "cache": {"read": 82176, "write": 0}}}},
    {"type": "text", "timestamp": 1794048262213, "sessionID": "ses_test",
     "part": {"id": "prt_4", "sessionID": "ses_test", "messageID": "msg_2",
              "type": "text", "text": "执行成功",
              "time": {"start": 1794048261301, "end": 1794048262213}}},
]


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def run_script(self, body: str, *, timeout: float = 30.0, req=None):
        script = _write_script(self.dir, body)
        rt = _fake(script, timeout=timeout)
        request = req or RuntimeRequest(session_id="ses_test", prompt="hi")
        return list(rt.run(request))


class MappingTest(Base):
    def test_four_real_events_map_correctly(self) -> None:
        body = _print_script(REAL_LINES)
        events = self.run_script(body)

        kinds = [e.type for e in events]
        # session.start 只发一次（第一行触发）
        self.assertEqual(kinds.count("session.start"), 1)
        self.assertEqual(kinds[0], "session.start")
        # 工具调用与结果成对
        self.assertIn("tool.call", kinds)
        self.assertIn("tool.result", kinds)
        # 文本
        deltas = [e for e in events if e.type == "message.delta"]
        self.assertEqual([d.data["text"] for d in deltas], ["执行成功"])
        # usage 带 tokens
        usages = [e for e in events if e.type == "usage"]
        self.assertEqual(len(usages), 1)
        self.assertEqual(usages[0].data["prompt_tokens"], 3606)
        self.assertEqual(usages[0].data["completion_tokens"], 46 + 129)
        self.assertEqual(usages[0].data["cache_read_tokens"], 82176)

    def test_all_emitted_types_are_in_contract(self) -> None:
        body = _print_script(REAL_LINES)
        for event in self.run_script(body):
            self.assertIn(event.type, TYPES, f"{event.type} 不在契约的九种事件里")

    def test_tool_result_arguments_are_json_text(self) -> None:
        """契约要求 `tool.call.arguments` 是 **JSON 文本**，不是对象。"""
        body = _print_script(REAL_LINES)
        events = self.run_script(body)
        call = next(e for e in events if e.type == "tool.call")
        self.assertIsInstance(call.data["arguments"], str)
        parsed = json.loads(call.data["arguments"])
        self.assertEqual(parsed["command"], "echo W4PROBE")

    def test_tool_result_ok_and_data(self) -> None:
        body = _print_script(REAL_LINES)
        events = self.run_script(body)
        result = next(e for e in events if e.type == "tool.result")
        self.assertTrue(result.data["ok"])
        self.assertEqual(result.data["id"], "call_abc")
        self.assertEqual(result.data["name"], "shell")
        self.assertEqual(result.data["data"]["output"], "W4PROBE\n")
        self.assertEqual(result.data["data"]["exit_code"], 0)
        self.assertNotIn("error", result.data, "成功时不该同时给 error")

    def test_failed_tool_gives_error_not_data(self) -> None:
        lines = [
            {"type": "step_start", "sessionID": "s", "part": {"type": "step-start"}},
            {"type": "tool_use", "sessionID": "s",
             "part": {"type": "tool", "id": "call_x", "tool": "shell",
                      "state": {"status": "error", "error": "权限不足"}}},
        ]
        body = _print_script(lines)
        events = self.run_script(body)
        result = next(e for e in events if e.type == "tool.result")
        self.assertFalse(result.data["ok"])
        self.assertIn("error", result.data)
        self.assertNotIn("data", result.data, "失败时不该同时给 data")

    def test_reasoning_is_intentionally_ignored_not_an_error(self) -> None:
        """`reasoning` 在 INTENTIONALLY_IGNORED 里 —— 忽略要有记录，但不该报错。"""
        lines = [
            {"type": "step_start", "sessionID": "s", "part": {"type": "step-start"}},
            {"type": "reasoning", "sessionID": "s", "part": {"type": "reasoning", "text": "嗯"}},
            {"type": "text", "sessionID": "s", "part": {"type": "text", "text": "好"}},
        ]
        body = _print_script(lines)
        events = self.run_script(body)
        self.assertFalse([e for e in events if e.type == "error"],
                         "已登记忽略的类型不该产生 error")


class CompletionTest(Base):
    def test_message_done_synthesized_on_zero_exit(self) -> None:
        """opencode 没有终止事件，适配器必须自己补 message.done。"""
        body = _print_script([REAL_LINES[0]])
        events = self.run_script(body)
        self.assertEqual(events[-1].type, "message.done")

    def test_reason_is_tool_calls_when_last_step_had_tools(self) -> None:
        body = _print_script(REAL_LINES)
        events = self.run_script(body)
        done = events[-1]
        self.assertEqual(done.type, "message.done")
        self.assertEqual(done.data["reason"], "tool_calls")

    def test_reason_is_stop_without_tools(self) -> None:
        lines = [
            {"type": "step_start", "sessionID": "s", "part": {"type": "step-start"}},
            {"type": "text", "sessionID": "s", "part": {"type": "text", "text": "收到"}},
        ]
        body = _print_script(lines)
        events = self.run_script(body)
        self.assertEqual(events[-1].data["reason"], "stop")

    def test_nonzero_exit_does_not_claim_stop(self) -> None:
        """崩溃不许被显示成"成功但没内容"。"""
        body = (
            "import json, sys\n"
            "print(json.dumps({'type': 'step_start', 'sessionID': 's',"
            " 'part': {'type': 'step-start'}}), flush=True)\n"
            "sys.exit(3)\n"
        )
        events = self.run_script(body)
        kinds = [e.type for e in events]
        self.assertIn("error", kinds)
        done = events[-1]
        self.assertEqual(done.type, "message.done")
        self.assertEqual(done.data["reason"], "error", "退出码非零时不该写 stop")

    def test_no_output_at_all_reports_error(self) -> None:
        """一行都没读到：可能配置错/鉴权失败。不许假装 session 开始过。"""
        body = "import sys\nsys.exit(5)\n"
        events = self.run_script(body)
        kinds = [e.type for e in events]
        self.assertNotIn("session.start", kinds)
        self.assertIn("error", kinds)
        self.assertEqual(events[-1].data["reason"], "error")


class UnknownTypeTest(Base):
    def test_unknown_part_type_is_not_silently_dropped(self) -> None:
        """本模块最重要的纪律：不认识的类型必须留痕，不能静默丢。

        静默丢会让「模型什么都没说」和「我们没解析出来」长得一样。
        """
        lines = [
            {"type": "step_start", "sessionID": "s", "part": {"type": "step-start"}},
            {"type": "brand_new_thing", "sessionID": "s",
             "part": {"type": "brand-new-part", "text": "???"}},
        ]
        body = _print_script(lines)
        events = self.run_script(body)
        errors = [e for e in events if e.type == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("未映射", errors[0].data["message"])
        self.assertIn("brand_new_thing", errors[0].data["message"])

    def test_non_json_line_becomes_error_with_原文(self) -> None:
        body = (
            "import json\n"
            "print('WARNING: something odd', flush=True)\n"
            "print(json.dumps({'type': 'text', 'sessionID': 's',"
            " 'part': {'type': 'text', 'text': 'ok'}}), flush=True)\n"
        )
        events = self.run_script(body)
        errors = [e for e in events if e.type == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("WARNING", errors[0].data["detail"]["line"])


class AvailabilityTest(Base):
    def test_missing_binary_is_unavailable_with_reason(self) -> None:
        rt = OpenCodeNativeRuntime(binary=self.dir / "does-not-exist.exe")
        self.assertFalse(rt.available())
        self.assertTrue(rt.reason)
        with self.assertRaises(RuntimeUnavailable):
            list(rt.run(RuntimeRequest(session_id="s", prompt="hi")))

    def test_binary_that_does_not_respond_is_unavailable(self) -> None:
        """文件存在但跑不起来（截断下载 / 架构不匹配）也要判不可用。"""
        script = _write_script(self.dir, "import sys\nsys.exit(1)\n", name="broken.py")
        rt = OpenCodeNativeRuntime(binary=script)
        self.assertFalse(rt.available())
        self.assertIn("退出码", rt.reason)

    def test_available_true_for_working_binary(self) -> None:
        script = _write_script(self.dir, "print('opencode v2.2.0')\n", name="ok.py")
        rt = OpenCodeNativeRuntime(binary=script)
        self.assertTrue(rt.available())
        self.assertEqual(rt.reason, "")

    def test_output_that_is_not_opencode_is_unavailable(self) -> None:
        script = _write_script(self.dir, "print('some other tool')\n", name="other.py")
        rt = OpenCodeNativeRuntime(binary=script)
        self.assertFalse(rt.available())
        self.assertIn("不像 opencode", rt.reason)


class ModelNameTest(unittest.TestCase):
    def test_bare_model_gets_provider_prefix(self) -> None:
        """不带 provider 的名字会被 opencode 静默回落到默认模型。"""
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        self.assertEqual(rt.model_name("deepseek-v4.1-flash"),
                         "commandcode/deepseek-v4.1-flash")

    def test_prefixed_model_untouched(self) -> None:
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        self.assertEqual(rt.model_name("other/some-model"), "other/some-model")

    def test_empty_model_stays_empty(self) -> None:
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        self.assertEqual(rt.model_name(""), "")


class ArgvTest(unittest.TestCase):
    """钉住**真机实测**才发现的参数形状。

    这一组存在的理由：假脚本会照我对参数的理解写，我理解错了它也跟着错，
    22 项假测试可以全绿而真机直接报 `Unrecognized flag: --prompt`。
    所以这里直接断言发给子进程的 argv 本身。
    """

    def _capture_argv(self, req) -> list:
        captured = {}

        class _FakeProc:
            def __init__(self, argv, **kwargs):
                captured["argv"] = argv
                self.stdout = iter([])
                self.stderr = None
                self.stdin = None

            def wait(self, timeout=None):
                return 1          # 让它走 error 分支，我们只关心 argv

            def poll(self):
                return 1

            @property
            def pid(self):
                return 1

        import fieldstation.runtimes.opencode as mod
        from pathlib import Path

        original_popen = mod.subprocess.Popen
        mod.subprocess.Popen = _FakeProc
        try:
            rt = OpenCodeNativeRuntime()
            # 直接塞一个"看起来存在"的路径：这里要验的是 argv 拼装，
            # 不关心二进制真伪（真机验证在 tools/opencode_smoke.py 与
            # 人工的一次 verify 里做）。`run()` 只检查 binary 是否为 None。
            fake = self._touch_fake_binary()
            rt.binary = Path(fake)
            list(rt.run(req))
        finally:
            mod.subprocess.Popen = original_popen
        return captured.get("argv", [])

    def _touch_fake_binary(self) -> str:
        """造一个空文件当"二进制"。存在即可，`run()` 不会去执行它。"""
        import tempfile
        handle, path = tempfile.mkstemp(prefix="fake-oc-", suffix=".exe")
        import os
        os.close(handle)
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        return path

    def test_prompt_is_positional_not_a_flag(self) -> None:
        """`opencode run --prompt x` 会报 Unrecognized flag（真机实测）。"""
        argv = self._capture_argv(
            RuntimeRequest(session_id="s", prompt="你好", model="m"))
        self.assertNotIn("--prompt", argv, "prompt 必须是位置参数，不是 flag")
        self.assertEqual(argv[-1], "你好", "位置参数必须是最后一个")

    def test_system_prompt_is_prefixed_into_message(self) -> None:
        argv = self._capture_argv(
            RuntimeRequest(session_id="s", prompt="问", system="你是助手", model="m"))
        self.assertEqual(argv[-1], "你是助手\n\n问")

    def test_format_json_always_present(self) -> None:
        argv = self._capture_argv(
            RuntimeRequest(session_id="s", prompt="问", model="m"))
        self.assertIn("--format", argv)
        self.assertEqual(argv[argv.index("--format") + 1], "json")

    def test_session_flag_used_when_given(self) -> None:
        argv = self._capture_argv(
            RuntimeRequest(session_id="ses_x", prompt="问", model="m"))
        self.assertIn("--session", argv)
        self.assertEqual(argv[argv.index("--session") + 1], "ses_x")


class SessionStartTest(Base):
    def test_session_start_carries_runtime_and_native_session(self) -> None:
        body = _print_script([REAL_LINES[0]])
        events = self.run_script(body)
        start = events[0]
        self.assertEqual(start.type, "session.start")
        self.assertEqual(start.data["runtime"], "opencode")
        self.assertEqual(start.data["native_session"], "ses_test")


class CancelTest(Base):
    def test_cancel_kills_child_process(self) -> None:
        """CLI 模式没有中间控制通道，cancel 只能结束整个进程——这条限制是真的。"""
        import threading
        import time

        script = _write_script(self.dir, textwrap.dedent("""
            import json, time
            print(json.dumps({"type":"step_start","sessionID":"s","part":{"type":"step-start"}}))
            print(json.dumps({"type":"text","sessionID":"s","part":{"type":"text","text":"起"}}))
        """).strip() + "\nimport sys\nsys.stdout.flush()\ntime.sleep(30)\n", name="slow.py")

        rt = OpenCodeNativeRuntime(binary=script, timeout=60)
        req = RuntimeRequest(session_id="ses_cancel", prompt="hi")

        collected = []

        def drain():
            for event in rt.run(req):
                collected.append(event)

        worker = threading.Thread(target=drain, daemon=True)
        worker.start()
        time.sleep(1.5)          # 让子进程真的起来
        rt.cancel("ses_cancel")
        worker.join(timeout=15)
        self.assertFalse(worker.is_alive(), "cancel 之后迭代必须结束")
        # 进程被结束 → 退出码非零 → 必须报错而不是 stop
        self.assertTrue(any(e.type == "error" for e in collected),
                        f"被 cancel 的会话必须留下 error 事件，实际 {[e.type for e in collected]}")


if __name__ == "__main__":
    unittest.main()
