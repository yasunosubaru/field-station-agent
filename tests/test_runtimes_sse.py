# -*- coding: utf-8 -*-
"""九种事件走同一个 SSE 出口（智-5）。

## 这份测试守什么

`docs/contracts/agent-events.md` 冻结了九种事件，但**两侧真跑时事件流未接入同一出口**：
实测两个翻译器各只产出 6 种，缺的是

* ``tool.result``  —— 工具执行完成（成功或失败都发）
* ``approval.request``  —— 工具风险命中审批门
* ``approval.result``   —— 审批有了结论

缺这三种的后果很具体：**界面上工具卡永远停在「调用中」，审批卡永远不出现**。
而且这不报错——事件流照常结束，只是少了几个。

所以这里的断言不是「能翻译」，而是：

1. 两个翻译器合起来必须覆盖**全部九种**；
2. 同一种事件在两侧的**字段名与顺序完全一致**（两侧习惯不同时改代码不改契约）；
3. SSE 帧结构固定（``event:`` 行 + ``data:`` 行 + 空行），字段序稳定。

另守一条仓库纪律：**不许 skip**。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from fieldstation.runtimes.base import TYPES, Event
from fieldstation.runtimes.service import sse_bytes
from fieldstation.runtimes.sse import (AnthropicState, OpenAIState, iter_sse,
                                       translate_anthropic, translate_openai)

#: 契约 §2 的九种。``TYPES`` 是它的代码镜像，两者必须一致。
NINE = (
    "session.start", "message.delta", "message.done",
    "tool.call", "tool.result", "approval.request", "approval.result",
    "usage", "error",
)

#: 编排层回填事件用的信封键。
#:
#: 为什么需要它：``tool.result`` / ``approval.request`` / ``approval.result`` 这三件事
#: **不由 provider 产生**——provider 只吐模型说的话和它想调的工具；工具真的跑完、
#: 人真的批完，是**我们的运行循环**知道的。所以翻译器要认一个「内部回填」通道：
#: 运行循环把这三类事件按同一套字段灌进来，翻译器原样转成 ``Event``。
#:
#: 这不是给 provider 用的协议，也不上线路：它只是同一套翻译函数的第二个入口，
#: 保证「三件事在两侧字段完全一致」这个不变量由**同一份代码**维持。
INTERNAL = "fsa_internal"


def _drain_openai(chunks) -> list[Event]:
    state = OpenAIState("s1")
    out: list[Event] = []
    for chunk in chunks:
        out.extend(translate_openai(json.dumps(chunk), state))
    return out


def _drain_anthropic(events) -> list[Event]:
    state = AnthropicState("s1")
    out: list[Event] = []
    for name, payload in events:
        # 内部回填的两种写法都接受（测试里想写短的）：
        #   单层 {"tool_result": {...}}  → 补成 {"fsa_internal": {...}}
        #   双层 {"fsa_internal": {...}} → 原样
        body = payload
        if name == "fsa_internal" and "fsa_internal" not in payload:
            body = {"fsa_internal": payload}
        out.extend(translate_anthropic(name, json.dumps(body), state))
    return out


def _internal(kind: str, payload: dict) -> tuple[str, dict]:
    """内部回填的信封。**与实现里的 INTERNAL_KEY 一致**。

    注意外层：``translate_anthropic`` 的第二个参数是整个 JSON 体，
    所以这里返回的 ``payload`` 会被 ``json.dumps`` 一次，形状是
    ``{"fsa_internal": {"tool_result": {...}}}``——正好是实现期望的。
    """
    return "fsa_internal", {"fsa_internal": {kind: payload}}


class TestContractMirror(unittest.TestCase):
    def test_types_matches_the_nine(self):
        self.assertEqual(TYPES, NINE)


class TestBothSidesProduceAllNine(unittest.TestCase):
    """每条都是一次完整的「一轮对话」，断言九种齐。

    ``error`` 是**异常路径**，正常一轮不会有它。所以这两条断言的是
    「六个常规事件 + 三个内部回填」共九种里的八个，``error`` 单独在
    :class:`TestErrorEvent` 里用真实错误路径验。
    """

    #: 正常一轮必然出现的八种（`error` 只在异常路径出现）。
    NORMAL_TURN = ("session.start", "message.delta", "message.done",
                   "tool.call", "tool.result", "approval.request",
                   "approval.result", "usage")

    def test_openai_full_turn(self):
        events = _drain_openai([
            # 文本
            {"choices": [{"delta": {"content": "我先查一下。"}}]},
            # 工具调用（分片）
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "t0001",
                 "function": {"name": "station_health", "arguments": "{\"read"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": "ings\":[]}"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            # 工具结果（由运行循环回填）
            {"fsa_internal": {"tool_result": {
                "id": "t0001", "name": "station_health", "ok": True,
                "data": {"stations": []}, "duration_ms": 8}}},
            # 审批：请求 + 结论（由装配层的权限回调回填）
            {"fsa_internal": {"approval_request": {
                "approval_id": "ap-01", "call_id": "t0002",
                "name": "execute_device_action", "risk": "high",
                "reason": "重启会中断观测", "prompt": "批准重启 WUHN？"}}},
            {"fsa_internal": {"approval_result": {
                "approval_id": "ap-01", "call_id": "t0002",
                "verdict": "rejected", "by": "operator-7",
                "note": "改约维护窗口"}}},
            # 用量 + 结束
            {"choices": [{"delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 10, "completion_tokens": 4}},
        ])
        got = {e.type for e in events}
        self.assertEqual(got & set(self.NORMAL_TURN), set(self.NORMAL_TURN),
                         f"缺 {sorted(set(self.NORMAL_TURN) - got)}")

    def test_anthropic_full_turn(self):
        events = _drain_anthropic([
            ("message_start", {"type": "message_start"}),
            ("content_block_delta", {"delta": {"type": "text_delta", "text": "我先查一下。"}}),
            ("content_block_start", {"content_block": {
                "type": "tool_use", "id": "t0001", "name": "station_health"}}),
            ("content_block_delta", {"delta": {
                "type": "input_json_delta", "partial_json": "{\"readings\":[]}"}}),
            ("content_block_stop", {"type": "content_block_stop"}),
            ("fsa_internal", {"tool_result": {
                "id": "t0001", "name": "station_health", "ok": True,
                "data": {"stations": []}, "duration_ms": 8}}),
            ("fsa_internal", {"approval_request": {
                "approval_id": "ap-01", "call_id": "t0002",
                "name": "execute_device_action", "risk": "high",
                "reason": "重启会中断观测", "prompt": "批准重启 WUHN？"}}),
            ("fsa_internal", {"approval_result": {
                "approval_id": "ap-01", "call_id": "t0002",
                "verdict": "rejected", "by": "operator-7",
                "note": "改约维护窗口"}}),
            ("message_delta", {"delta": {"stop_reason": "end_turn"},
                               "usage": {"input_tokens": 10, "output_tokens": 4}}),
            ("message_stop", {"type": "message_stop"}),
        ])
        got = {e.type for e in events}
        self.assertEqual(got & set(self.NORMAL_TURN), set(self.NORMAL_TURN),
                         f"缺 {sorted(set(self.NORMAL_TURN) - got)}")


class TestCoverageOfAllNine(unittest.TestCase):
    """九种事件必须**每一种都有代码路径能产出**。

    这是智-5 的核心断言。它防的是「少了一种事件」这种错法：``approval.result``
    若只在 A 侧实现，B 侧审批后界面永远不更新——而事件流照常结束，不报错。
    """

    def test_every_type_is_produced_somewhere(self):
        produced: set[str] = set()

        # 正常一轮（两侧各一遍）
        produced |= {e.type for e in _drain_openai([
            {"choices": [{"delta": {"content": "x"}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "t1", "function": {"name": "n", "arguments": "{}"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            {"fsa_internal": {"tool_result": {"id": "t1", "name": "n", "ok": True}}},
            {"fsa_internal": {"approval_request": {
                "approval_id": "a", "call_id": "t1", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}},
            {"fsa_internal": {"approval_result": {
                "approval_id": "a", "call_id": "t1", "verdict": "approved",
                "by": "auto"}}},
            {"choices": [{"delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}},
        ])}
        produced |= {e.type for e in _drain_anthropic([
            ("message_start", {"type": "message_start"}),
            ("content_block_delta", {"delta": {"type": "text_delta", "text": "x"}}),
            ("content_block_start", {"content_block": {
                "type": "tool_use", "id": "t1", "name": "n"}}),
            ("content_block_stop", {"type": "content_block_stop"}),
            ("fsa_internal", {"tool_result": {"id": "t1", "name": "n", "ok": True}}),
            ("fsa_internal", {"approval_request": {
                "approval_id": "a", "call_id": "t1", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}),
            ("fsa_internal", {"approval_result": {
                "approval_id": "a", "call_id": "t1", "verdict": "approved",
                "by": "auto"}}),
            ("message_delta", {"delta": {"stop_reason": "end_turn"},
                               "usage": {"input_tokens": 1, "output_tokens": 1}}),
            ("message_stop", {"type": "message_stop"}),
        ])}
        # 错误路径
        produced.add(translate_openai("{oops", OpenAIState("s"))[0].type)

        missing = [t for t in NINE if t not in produced]
        self.assertEqual(missing, [], f"这些事件没有任何代码路径能产出：{missing}")

    def test_both_sides_cover_the_same_eight(self):
        """两侧覆盖集合必须相同——不能一侧 8 种、另一侧 7 种。"""
        a = {e.type for e in _drain_openai([
            {"choices": [{"delta": {"content": "x"}}]},
            {"fsa_internal": {"tool_result": {"id": "t", "name": "n", "ok": True}}},
            {"fsa_internal": {"approval_request": {
                "approval_id": "a", "call_id": "t", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}},
            {"fsa_internal": {"approval_result": {
                "approval_id": "a", "call_id": "t", "verdict": "approved", "by": "auto"}}},
            {"choices": [{"delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}},
        ])} | {"error"}
        b = {e.type for e in _drain_anthropic([
            ("message_start", {"type": "message_start"}),
            ("content_block_delta", {"delta": {"type": "text_delta", "text": "x"}}),
            ("fsa_internal", {"tool_result": {"id": "t", "name": "n", "ok": True}}),
            ("fsa_internal", {"approval_request": {
                "approval_id": "a", "call_id": "t", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}),
            ("fsa_internal", {"approval_result": {
                "approval_id": "a", "call_id": "t", "verdict": "approved", "by": "auto"}}),
            ("message_delta", {"delta": {"stop_reason": "end_turn"},
                               "usage": {"input_tokens": 1, "output_tokens": 1}}),
            ("message_stop", {"type": "message_stop"}),
        ])} | {"error"}
        self.assertEqual(a, b)


class TestErrorEvent(unittest.TestCase):
    """``error`` 只在异常路径出现，所以单独验——两侧各一条真实错误。"""

    def test_openai_bad_json_emits_error(self):
        events = translate_openai("{oops", OpenAIState("s"))
        self.assertEqual(events[0].type, "error")
        self.assertIn("class", events[0].data)
        self.assertIn("message", events[0].data)

    def test_anthropic_bad_json_emits_error(self):
        events = translate_anthropic("message_start", "{oops", AnthropicState("s"))
        self.assertEqual(events[0].type, "error")

    def test_unknown_internal_kind_emits_error_not_silence(self):
        """未知的内部回填类型不许静默丢——静默丢会表现成「事件流少了几个」。"""
        events = translate_openai(
            json.dumps({"fsa_internal": {"no_such_kind": {}}}), OpenAIState("s"))
        self.assertEqual(events[0].type, "error")
        self.assertIn("no_such_kind", events[0].data["message"])


class TestFieldParity(unittest.TestCase):
    """同一种事件在两侧的``data``键集合必须相同。错法一：A 用 call_id，B 用 callId。"""

    def _keys(self, events: list[Event]) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {}
        for e in events:
            out.setdefault(e.type, set()).update(e.data)
        return out

    def _openai(self):
        return self._keys(_drain_openai([
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "t1", "function": {"name": "n", "arguments": "{}"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            {"fsa_internal": {"tool_result": {
                "id": "t1", "name": "n", "ok": True, "data": {},
                "duration_ms": 1}}},
            {"fsa_internal": {"approval_request": {
                "approval_id": "a1", "call_id": "t1", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}},
            {"fsa_internal": {"approval_result": {
                "approval_id": "a1", "call_id": "t1", "verdict": "approved",
                "by": "auto"}}},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ]))

    def _anthropic(self):
        state = AnthropicState("s1")
        out: list[Event] = []
        seq = [
            ("message_start", {"type": "message_start"}),
            ("content_block_start", {"content_block": {
                "type": "tool_use", "id": "t1", "name": "n"}}),
            ("content_block_stop", {"type": "content_block_stop"}),
            ("fsa_internal", {"tool_result": {
                "id": "t1", "name": "n", "ok": True, "data": {},
                "duration_ms": 1}}),
            ("fsa_internal", {"approval_request": {
                "approval_id": "a1", "call_id": "t1", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}),
            ("fsa_internal", {"approval_result": {
                "approval_id": "a1", "call_id": "t1", "verdict": "approved",
                "by": "auto"}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        for name, payload in seq:
            body = payload
            if name == "fsa_internal" and "fsa_internal" not in payload:
                body = {"fsa_internal": payload}
            out.extend(translate_anthropic(name, json.dumps(body), state))
        return self._keys(out)

    def test_shared_event_keys_are_identical(self):
        a = self._openai()
        b = self._anthropic()
        for kind in ("tool.result", "approval.request", "approval.result"):
            with self.subTest(kind=kind):
                self.assertIn(kind, a, "OpenAI 侧没有这种事件")
                self.assertIn(kind, b, "Anthropic 侧没有这种事件")
                self.assertEqual(a[kind], b[kind],
                                 f"{kind} 两侧字段名不一致：{a[kind]} vs {b[kind]}")

    def test_key_order_is_contract_order(self):
        """字段顺序也要一致（前端按固定顺序渲染卡片）。"""
        def order(events):
            for e in events:
                if e.type == "tool.result":
                    return list(e.data)
            return []

        a = order(_drain_openai([
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "t1", "function": {"name": "n", "arguments": "{}"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            {"fsa_internal": {"tool_result": {
                "id": "t1", "name": "n", "ok": True, "data": {}, "duration_ms": 1}}},
        ]))
        b = order(_drain_anthropic([
            ("content_block_start", {"content_block": {
                "type": "tool_use", "id": "t1", "name": "n"}}),
            ("content_block_stop", {"type": "content_block_stop"}),
            ("fsa_internal", {"tool_result": {
                "id": "t1", "name": "n", "ok": True, "data": {}, "duration_ms": 1}}),
        ]))
        self.assertEqual(a, b)
        self.assertEqual(a[:3], ["id", "name", "ok"])


class TestFrameShape(unittest.TestCase):
    """两边都走同一个 ``sse_bytes``，帧结构固定。"""

    def test_frame_is_event_plus_data_plus_blank(self):
        frame = sse_bytes(Event("message.delta", "s1", {"text": "x"}))
        text = frame.decode("utf-8")
        self.assertTrue(text.startswith("event: message.delta\n"))
        self.assertIn("data: ", text)
        self.assertTrue(text.endswith("\n\n"))

    def test_envelope_key_order_stable(self):
        payload = json.loads(
            sse_bytes(Event("usage", "s", {"prompt_tokens": 1,
                                           "completion_tokens": 2})).decode()
            .split("data: ", 1)[1])
        self.assertEqual(list(payload), ["type", "session_id", "data"])

    def test_frame_roundtrips_through_parser(self):
        """自己吐的帧必须能被自己的解析器读回来（否则两侧互通是假的）。"""
        frame = sse_bytes(Event("tool.call", "s1",
                                {"id": "t1", "name": "n", "arguments": "{}"}))
        lines = frame.decode("utf-8").splitlines(keepends=True)
        pairs = list(iter_sse(lines))
        self.assertEqual(len(pairs), 1)
        name, payload = pairs[0]
        self.assertEqual(name, "tool.call")
        self.assertEqual(json.loads(payload)["data"]["id"], "t1")


class TestApprovalOrdering(unittest.TestCase):
    """契约 §2 的顺序不变量：approval.result 必须先于对应 tool.result。"""

    def test_contract_order_is_respected_by_translators(self):
        events = _drain_anthropic([
            ("message_start", {"type": "message_start"}),
            ("fsa_internal", {"approval_request": {
                "approval_id": "a1", "call_id": "t1", "name": "n", "risk": "high",
                "reason": "r", "prompt": "p"}}),
            ("fsa_internal", {"approval_result": {
                "approval_id": "a1", "call_id": "t1", "verdict": "rejected",
                "by": "op"}}),
            ("fsa_internal", {"tool_result": {
                "id": "t1", "name": "n", "ok": False,
                "error": {"code": "E_APPROVAL_DENIED", "message": "未获批准",
                          "retryable": False}}}),
        ])
        kinds = [e.type for e in events]
        self.assertIn("approval.request", kinds)
        self.assertIn("approval.result", kinds)
        self.assertIn("tool.result", kinds)
        self.assertLess(kinds.index("approval.request"), kinds.index("approval.result"))
        self.assertLess(kinds.index("approval.result"), kinds.index("tool.result"))


class TestNoSkipDiscipline(unittest.TestCase):
    def test_no_skip_invocations(self):
        p = "skip"
        tokens = (p + "Test(", "." + p + "(", p + "Unless(", p + "If(")
        src = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual([t for t in tokens if t in src], [])


if __name__ == "__main__":
    unittest.main()
