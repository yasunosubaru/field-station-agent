# -*- coding: utf-8 -*-
"""`ClaudeRuntime` 的 SDK 驱动路径（智-0b）与无 shim 路径（智-3）。

## 这份测试守什么

智-0b 的要害不是「装了个包」，而是**工具循环真的由 SDK 跑**，
且**权限回调真的落到我们的台账**（不是自己放行）。

所以这里的做法是：用一个**假 SDK 模块**（``sys.modules`` 注入）完整走一遍
``ClaudeRuntime.run``，断言

1. 我们传给 SDK 的 ``ClaudeAgentOptions`` 里，``agents`` / ``system_prompt`` /
   ``can_use_tool`` 都带上了——**工具循环交给 SDK 的证据**；
2. ``can_use_tool`` 回调被真的调用时，台账先被问、事件先发出，
   且 ``approval.request`` → ``approval.result`` 顺序正确；
3. 台账拒绝时返回 ``PermissionResultDeny``（不是悄悄放行）；
4. 台账卡住时**超时按拒绝**（不许无限等）。

## 为什么不用真 SDK

真 SDK 要起 Claude Code CLI 子进程、要真模型额度。这份测试守的是**接线**，
不是模型质量——接线用假 SDK 就能验得比真跑更彻底（能造超时、造拒绝）。
真 SDK 的可用性另由一条「装了没有」的测试守。
"""
from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from fieldstation.runtimes.base import Event, RuntimeRequest
from fieldstation.runtimes.impl import (ClaudeRuntime, DenyAllLedger, ScriptedLedger,
                                        translate_sdk_message)


class FakeOptions:
    """模仿 ``ClaudeAgentOptions``：只记构造参数，供断言。"""

    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeAgentDefinition:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeAllow:
    def __init__(self, behavior, updated_input=None):
        self.behavior = behavior
        self.updated_input = updated_input


class FakeDeny:
    def __init__(self, behavior, message="", interrupt=False):
        self.behavior = behavior
        self.message = message
        self.interrupt = interrupt


class FakeTextBlock:
    def __init__(self, text):
        self.text = text


class FakeToolUseBlock:
    def __init__(self, id, name, input):
        self.id = id
        self.name = name
        self.input = input


class FakeAssistantMessage:
    def __init__(self, content, usage=None):
        self.content = content
        self.usage = usage


class FakeSystemMessage:
    def __init__(self, subtype="init", data=None):
        self.subtype = subtype
        self.data = data or {}


class FakeResultMessage:
    def __init__(self, stop_reason="end_turn", is_error=False, result=""):
        self.stop_reason = stop_reason
        self.is_error = is_error
        self.result = result
        self.duration_ms = 10


class FakeClient:
    """记录 query 参数，按预设吐消息。"""

    instances: list["FakeClient"] = []

    def __init__(self, options=None, transport=None):
        self.options = options
        self.queries: list[str] = []
        self.connected = False
        FakeClient.instances.append(self)

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def query(self, prompt, session_id="default"):
        self.queries.append(prompt)

    async def receive_response(self):
        for msg in _SCRIPT:
            yield msg


_SCRIPT: list = []


def install_fake_sdk():
    """把假 SDK 塞进 ``sys.modules``，并返回它（供断言）。"""
    module = types.ModuleType("claude_agent_sdk")
    module.ClaudeAgentOptions = FakeOptions
    module.AgentDefinition = FakeAgentDefinition
    module.ClaudeSDKClient = FakeClient
    module.PermissionResultAllow = FakeAllow
    module.PermissionResultDeny = FakeDeny
    module.AssistantMessage = FakeAssistantMessage
    module.SystemMessage = FakeSystemMessage
    module.ResultMessage = FakeResultMessage
    module.TextBlock = FakeTextBlock
    module.ToolUseBlock = FakeToolUseBlock
    return module


class FakeSdkCase(unittest.TestCase):
    def setUp(self):
        FakeClient.instances.clear()
        _SCRIPT.clear()
        self.module = install_fake_sdk()
        self._patch = mock.patch.dict(sys.modules, {"claude_agent_sdk": self.module})
        self._patch.start()
        self.addCleanup(self._patch.stop)


class TestSdkIsRealAgentSdk(unittest.TestCase):
    """错法一：装了 ``anthropic`` 就以为装好了。这条必须用真包验。"""

    def test_claude_agent_sdk_is_importable(self):
        import claude_agent_sdk as sdk
        self.assertTrue(hasattr(sdk, "ClaudeSDKClient"))
        self.assertTrue(hasattr(sdk, "AgentDefinition"))
        self.assertTrue(hasattr(sdk, "ClaudeAgentOptions"))

    def test_anthropic_alone_is_not_enough(self):
        """``anthropic`` 是 API 客户端，没有 AgentDefinition / skills / 权限模式。"""
        import anthropic
        self.assertFalse(hasattr(anthropic, "AgentDefinition"))
        self.assertFalse(hasattr(anthropic, "ClaudeSDKClient"))


class TestOptionsWiring(FakeSdkCase):
    def _run(self, runtime, prompt="查 WUHN 状态"):
        _SCRIPT.extend([
            FakeSystemMessage("init", {"model": "deepseek-v4.1-flash", "agent": "fsa-ops"}),
            FakeAssistantMessage([FakeTextBlock("我先查。")],
                                 usage={"input_tokens": 9, "output_tokens": 3}),
            FakeResultMessage("end_turn"),
        ])
        return list(runtime.run(RuntimeRequest("s1", prompt)))

    def test_passes_agent_definition_to_sdk(self):
        rt = ClaudeRuntime(allowed_tools=["station_health"],
                           disallowed_tools=["execute_device_action"],
                           system_prompt="你是值守体",
                           skills=["health"])
        self._run(rt)
        opts = FakeClient.instances[-1].options
        self.assertIsInstance(opts, FakeOptions)
        self.assertIn("fsa-ops", opts.kwargs["agents"])
        agent = opts.kwargs["agents"]["fsa-ops"]
        self.assertEqual(agent.kwargs["tools"], ["station_health"])
        self.assertEqual(agent.kwargs["disallowedTools"], ["execute_device_action"])
        self.assertEqual(agent.kwargs["skills"], ["health"])
        self.assertEqual(opts.kwargs["system_prompt"], "你是值守体")

    def test_registers_permission_callback(self):
        """智-0b 的核心：权限回调必须交给 SDK。"""
        self._run(ClaudeRuntime())
        opts = FakeClient.instances[-1].options
        self.assertTrue(callable(opts.kwargs.get("can_use_tool")),
                        "没把 can_use_tool 交给 SDK，审批门形同虚设")

    def test_query_receives_prompt_and_connects(self):
        self._run(ClaudeRuntime(), prompt="查 BADG")
        client = FakeClient.instances[-1]
        self.assertEqual(client.queries, ["查 BADG"])

    def test_events_are_translated(self):
        events = self._run(ClaudeRuntime())
        kinds = [e.type for e in events]
        self.assertIn("session.start", kinds)
        self.assertIn("message.delta", kinds)
        self.assertIn("usage", kinds)
        self.assertIn("message.done", kinds)
        start = next(e for e in events if e.type == "session.start")
        self.assertEqual(start.data["runtime"], "claude")


class TestPermissionCallback(FakeSdkCase):
    """审批门：事件先发、台账先问、拒绝不放行。"""

    def _callback(self, runtime):
        self._run_ok(runtime)
        return FakeClient.instances[-1].options.kwargs["can_use_tool"]

    def _run_ok(self, runtime):
        _SCRIPT.extend([FakeResultMessage("end_turn")])
        list(runtime.run(RuntimeRequest("s1", "x")))

    def test_denies_when_ledger_denies(self):
        rt = ClaudeRuntime(ledger=DenyAllLedger())
        cb = self._callback(rt)
        # 第二轮：抓事件
        sink: list[Event] = []
        cb2 = rt._make_permission_callback(sink, "s1")
        ctx = types.SimpleNamespace(tool_use_id="t1", decision_reason="高风险动作")
        result = asyncio.run(cb2("execute_device_action", {"a": 1}, ctx))

        self.assertEqual(result.behavior, "deny")
        self.assertIn("一律拒绝", result.message)
        kinds = [e.type for e in sink]
        self.assertEqual(kinds, ["approval.request", "approval.result"])
        self.assertEqual(sink[1].data["verdict"], "rejected")

    def test_allows_when_ledger_allows(self):
        rt = ClaudeRuntime(ledger=ScriptedLedger(allow={"station_health"}))
        sink: list[Event] = []
        cb = rt._make_permission_callback(sink, "s1")
        ctx = types.SimpleNamespace(tool_use_id="t2", decision_reason="")
        result = asyncio.run(cb("station_health", {"readings": []}, ctx))
        self.assertEqual(result.behavior, "allow")
        self.assertEqual(sink[1].data["verdict"], "approved")

    def test_approval_request_precedes_result(self):
        rt = ClaudeRuntime(ledger=ScriptedLedger(allow={"x"}))
        sink: list[Event] = []
        cb = rt._make_permission_callback(sink, "s1")
        ctx = types.SimpleNamespace(tool_use_id="t3", decision_reason="")
        asyncio.run(cb("x", {}, ctx))
        self.assertEqual([e.type for e in sink],
                         ["approval.request", "approval.result"])

    def test_request_carries_contract_fields(self):
        rt = ClaudeRuntime(ledger=ScriptedLedger(allow={"x"}))
        sink: list[Event] = []
        cb = rt._make_permission_callback(sink, "s1")
        ctx = types.SimpleNamespace(tool_use_id="t4", decision_reason="会中断观测")
        asyncio.run(cb("x", {}, ctx))
        req = sink[0].data
        for key in ("approval_id", "call_id", "name", "risk", "reason", "prompt"):
            with self.subTest(field=key):
                self.assertIn(key, req)

    def test_timeout_denies_instead_of_hanging(self):
        """错法三：``wait_for_approval`` 无限等。必须超时按拒绝。"""

        class SlowLedger:
            def decide(self, tool_name, tool_input):
                import time
                time.sleep(2.0)
                return True, "too late"

        rt = ClaudeRuntime(ledger=SlowLedger(), approval_timeout_s=0.2)
        sink: list[Event] = []
        cb = rt._make_permission_callback(sink, "s1")
        ctx = types.SimpleNamespace(tool_use_id="t5", decision_reason="")
        result = asyncio.run(cb("x", {}, ctx))
        self.assertEqual(result.behavior, "deny")
        self.assertIn("超时", result.message)
        self.assertEqual(sink[1].data["verdict"], "rejected")


class TestMessageTranslation(unittest.TestCase):
    """SDK 消息 → 九种事件。字段名必须与 Anthropic 侧一致（智-5 的要求）。"""

    def test_system_init_becomes_session_start(self):
        events = translate_sdk_message(
            FakeSystemMessage("init", {"model": "m", "agent": "fsa-ops"}),
            "s1", {})
        self.assertEqual(events[0].type, "session.start")
        self.assertEqual(events[0].data["runtime"], "claude")
        self.assertEqual(events[0].data["agent"], "fsa-ops")

    def test_session_start_only_once(self):
        state: dict = {}
        translate_sdk_message(FakeSystemMessage("init"), "s1", state)
        again = translate_sdk_message(FakeSystemMessage("init"), "s1", state)
        self.assertEqual(again, [])

    def test_text_block_becomes_delta(self):
        events = translate_sdk_message(
            FakeAssistantMessage([FakeTextBlock("你好")]), "s1", {})
        self.assertEqual(events[0].type, "message.delta")
        self.assertEqual(events[0].data["text"], "你好")

    def test_tool_use_block_arguments_is_json_text(self):
        events = translate_sdk_message(
            FakeAssistantMessage([FakeToolUseBlock("t1", "station_health",
                                                  {"readings": []})]), "s1", {})
        call = [e for e in events if e.type == "tool.call"][0]
        self.assertEqual(call.data["id"], "t1")
        self.assertIsInstance(call.data["arguments"], str)
        self.assertEqual(json.loads(call.data["arguments"]), {"readings": []})

    def test_tool_result_name_matches_call_name(self):
        """契约 §3.5：``tool.result.name`` 必须与对应 ``tool.call.name`` 相同。

        实测踩过：原先靠「最后见过的工具名」记，工具一并行 name 就串了，
        表现是空串——而空串不报错，前端只是把结果挂到错误的卡片上。
        """
        class FakeToolResultBlock:
            tool_use_id = "t1"
            content = '{"ok": true}'
            is_error = False

        class FakeUserMessage:
            content = [FakeToolResultBlock()]

        state: dict = {}
        translate_sdk_message(
            FakeAssistantMessage([FakeToolUseBlock("t1", "station_health", {})]),
            "s1", state)
        events = translate_sdk_message(FakeUserMessage(), "s1", state)
        self.assertEqual(events[0].data["name"], "station_health")

    def test_result_message_error_emits_error_event(self):
        events = translate_sdk_message(
            FakeResultMessage(is_error=True, result="额度用尽"), "s1", {})
        kinds = [e.type for e in events]
        self.assertIn("error", kinds)
        self.assertIn("message.done", kinds)
        err = [e for e in events if e.type == "error"][0]
        self.assertEqual(err.data["class"], "provider")

    def test_stop_reason_mapped(self):
        cases = {"end_turn": "stop", "max_tokens": "length", "tool_use": "tool_calls"}
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                events = translate_sdk_message(FakeResultMessage(raw), "s1", {})
                done = [e for e in events if e.type == "message.done"][0]
                self.assertEqual(done.data["reason"], want)


class TestNoShimPath(unittest.TestCase):
    """智-3：判断端点类型，需要转换才走 shim，直连就跳过。"""

    def test_sdk_mode_needs_no_shim(self):
        rt = ClaudeRuntime(use_sdk=True)
        self.assertEqual(rt.endpoint_kind(), "sdk")
        self.assertFalse(rt.needs_shim())

    def test_shim_endpoint_detected(self):
        rt = ClaudeRuntime(base_url="http://127.0.0.1:8765", use_sdk=False)
        self.assertEqual(rt.endpoint_kind(), "shim")
        self.assertTrue(rt.needs_shim())

    def test_direct_anthropic_skips_shim(self):
        rt = ClaudeRuntime(base_url="https://api.anthropic.com", use_sdk=False)
        self.assertEqual(rt.endpoint_kind(), "anthropic")
        self.assertFalse(rt.needs_shim(),
                         "直连 Anthropic 不该多跳一层协议转换")

    def test_both_paths_share_translation_layer(self):
        """两条路径的事件翻译层必须是同一套（否则「九种一致」一天就分叉）。"""
        from fieldstation.runtimes import sse
        self.assertTrue(hasattr(sse, "translate_anthropic"))
        # SDK 分支翻译在 impl 里，但它产出的字段名与 anthropic 分支同源
        sdk_events = translate_sdk_message(
            FakeAssistantMessage([FakeTextBlock("x")]), "s1", {})
        anth = sse.translate_anthropic(
            "content_block_delta",
            json.dumps({"delta": {"type": "text_delta", "text": "x"}}),
            sse.AnthropicState("s1"))
        self.assertEqual(list(sdk_events[0].data), list(anth[0].data))


class TestUnavailableSemantics(unittest.TestCase):
    """``RuntimeUnavailable`` 语义不变：不可用就明示，不自动切换。"""

    def test_missing_sdk_raises_unavailable(self):
        with mock.patch.dict(sys.modules, {"claude_agent_sdk": None}):
            rt = ClaudeRuntime(use_sdk=True)
            self.assertFalse(rt.available())
            with self.assertRaises(Exception) as ctx:
                list(rt.run(RuntimeRequest("s1", "x")))
            self.assertIn("claude-agent-sdk", str(ctx.exception))

    def test_default_ledger_denies(self):
        self.assertEqual(DenyAllLedger().decide("x", {})[0], False)


class TestNoSkipDiscipline(unittest.TestCase):
    def test_no_skip_invocations(self):
        p = "skip"
        tokens = (p + "Test(", "." + p + "(", p + "Unless(", p + "If(")
        src = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual([t for t in tokens if t in src], [])


if __name__ == "__main__":
    unittest.main()
