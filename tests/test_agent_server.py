#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``tools/agent_server.py``：真实 HTTP、真实 SSE、假 provider。

不连外网、不连 Node：工具注册表由用例自己提供（``echo`` / 高风险工具 /
会抛异常的工具），provider 是脚本化的替身。这样每条用例只测服务本身：
token、路由、事件顺序、审批门、取消、设置与 5 MB 上限。
"""
from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "src"))

import agent_server  # noqa: E402
from fieldstation.agents.providers.base import ChatResponse  # noqa: E402
from fieldstation.agents.tools import ToolRegistry, ToolResult  # noqa: E402

TOKEN = "test-token-4f1c9a"
SECRET = "sk-test-should-never-be-echoed"


# --------------------------------------------------------------------------
# 替身
# --------------------------------------------------------------------------

class ScriptedProvider:
    """按顺序吐预置响应；用尽后回一句普通文本（避免用例因调用次数意外失败）。"""

    name = "fake"

    def __init__(self, turns: list[ChatResponse]) -> None:
        self.turns = list(turns)
        self.calls: list[list] = []

    def chat(self, messages, tools):
        self.calls.append(list(messages))
        if self.turns:
            return self.turns.pop(0)
        return ChatResponse(content="（测试）完成。")


class EchoTool:
    name = "echo"
    description = "回显参数"
    params = {"text": {"type": "string", "required": True}}
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        return ToolResult(ok=True, data={"echo": args.get("text", "")})


class RiskyTool:
    name = "reboot_station"
    description = "重启台站（高风险）"
    params = {"station_id": {"type": "string", "required": True}}
    risk = "high"

    def invoke(self, args: dict) -> ToolResult:
        return ToolResult(ok=True, data={"rebooted": args.get("station_id", "")})


class BoomTool:
    name = "boom"
    description = "总是抛异常"
    params = {}
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        raise RuntimeError("传感器总线断开")


def make_registry(*tools) -> ToolRegistry:
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    return registry


def tool_call(name: str, args: dict | None = None) -> ChatResponse:
    return ChatResponse(content="", tool_calls=[{
        "name": name, "args": args or {}, "reason": "用例",
    }])


# --------------------------------------------------------------------------
# HTTP / SSE 辅助
# --------------------------------------------------------------------------

class BlockingProvider:
    """第一次 ``chat`` 卡住，直到用例放行 —— 用来测「同一会话不许并发运行」。"""

    name = "fake"

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def chat(self, messages, tools):
        self.started.set()
        self.release.wait(timeout=20)
        return ChatResponse(content="慢回答")


class ServerCase(unittest.TestCase):
    approval_timeout = 0.5
    registry: ToolRegistry | None = None
    turns: list[ChatResponse] | None = None

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.provider = ScriptedProvider(self.turns or [])
        self.boot()

    def boot(self, *, registry=None, provider=None, approval_timeout=None):
        if provider is not None:
            self.provider = provider
        active_registry = (registry if registry is not None
                           else (self.registry if self.registry is not None
                                 else make_registry(EchoTool())))
        self.server = agent_server.make_server(
            port=0, token=TOKEN, node_url="http://127.0.0.1:1",
            repo_root=str(ROOT), data_dir=self._tmp.name,
            approval_timeout=(self.approval_timeout if approval_timeout is None
                              else approval_timeout),
            provider_factory=lambda: (self.provider,
                                      {"model": "stub", "fake_fallback": False}),
            tool_registry=active_registry)
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
            daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)

    def tearDown(self):
        self.stop_server()
        self._tmp.cleanup()

    # ---- 请求 ---------------------------------------------------------

    def request(self, method: str, path: str, body=None, *,
                token: str | None = TOKEN, headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            all_headers = {"Content-Type": "application/json"}
            if token is not None:
                all_headers["Authorization"] = f"Bearer {token}"
            all_headers.update(headers or {})
            payload = None if body is None else json.dumps(body).encode("utf-8")
            conn.request(method, path, body=payload, headers=all_headers)
            response = conn.getresponse()
            raw = response.read()
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                parsed = None
            return response.status, parsed, raw, response
        finally:
            conn.close()

    def json_request(self, method: str, path: str, body=None, **kwargs):
        status, parsed, _, _ = self.request(method, path, body, **kwargs)
        self.assertIsInstance(parsed, dict, f"{method} {path} 返回的不是 JSON")
        return status, parsed

    def new_session(self, title: str | None = None) -> str:
        status, payload = self.json_request("POST", "/sessions", {"title": title})
        self.assertEqual(status, 200, payload)
        return payload["session_id"]

    # ---- SSE ----------------------------------------------------------

    def open_stream(self, session_id: str, text: str):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        body = json.dumps({"text": text}).encode("utf-8")
        conn.request("POST", f"/sessions/{session_id}/message", body=body,
                     headers={"Authorization": f"Bearer {TOKEN}",
                              "Content-Type": "application/json"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type") or "")
        return conn, response

    def read_stream(self, response) -> list[tuple[str, dict]]:
        events: list[tuple[str, dict]] = []
        event = "message"
        data_lines: list[str] = []
        while True:
            line = response.readline()
            if not line:
                break
            text = line.decode("utf-8").rstrip("\r\n")
            if text == "":
                if data_lines:
                    events.append((event, json.loads("\n".join(data_lines))))
                event, data_lines = "message", []
                continue
            if text.startswith("event:"):
                event = text[len("event:"):].strip()
            elif text.startswith("data:"):
                data_lines.append(text[len("data:"):].strip())
        if data_lines:
            events.append((event, json.loads("\n".join(data_lines))))
        return events

    def next_event(self, response) -> tuple[str, dict] | None:
        event = "message"
        data_lines: list[str] = []
        while True:
            line = response.readline()
            if not line:
                return None
            text = line.decode("utf-8").rstrip("\r\n")
            if text == "" and data_lines:
                return event, json.loads("\n".join(data_lines))
            if text.startswith("event:"):
                event = text[len("event:"):].strip()
            elif text.startswith("data:"):
                data_lines.append(text[len("data:"):].strip())


# --------------------------------------------------------------------------
# 认证与基础端点
# --------------------------------------------------------------------------

class AuthAndHealth(ServerCase):
    def test_health_requires_token(self):
        status, payload = self.json_request("GET", "/health", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(payload["ok"], False)
        self.assertEqual(payload["class"], "capability")
        self.assertIn("error", payload)

    def test_health_rejects_wrong_token(self):
        status, payload = self.json_request("GET", "/health", token="nope")
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])

    def test_health_shape(self):
        status, payload = self.json_request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["provider"], "fake")
        self.assertEqual(payload["model"], "stub")
        self.assertIsInstance(payload["tools"], int)
        self.assertGreaterEqual(payload["tools"], 1)
        self.assertIn("version", payload)

    def test_tools_lists_registry(self):
        self.stop_server()
        self.boot(registry=make_registry(EchoTool(), RiskyTool()))
        status, payload = self.json_request("GET", "/tools")
        self.assertEqual(status, 200)
        names = [tool["name"] for tool in payload["tools"]]
        self.assertEqual(names, ["echo", "reboot_station"])
        first = payload["tools"][0]
        self.assertEqual(set(first), {"name", "description", "risk", "source", "params"})
        self.assertEqual(first["source"], "local")
        self.assertEqual(first["risk"], "low")

    def test_unknown_route_404(self):
        status, payload = self.json_request("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload["class"], "input")

    def test_wrong_method_405(self):
        status, payload = self.json_request("PUT", "/health")
        self.assertEqual(status, 405)
        self.assertEqual(payload["ok"], False)

    def test_body_limit(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.putrequest("POST", "/sessions")
            conn.putheader("Authorization", f"Bearer {TOKEN}")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length",
                           str(agent_server.MAX_BODY_BYTES + 1))
            conn.endheaders()
            response = conn.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()
        self.assertEqual(response.status, 413)
        self.assertEqual(payload["class"], "input")

    def test_invalid_json_400(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request("POST", "/sessions", body=b"{oops",
                         headers={"Authorization": f"Bearer {TOKEN}",
                                  "Content-Type": "application/json"})
            response = conn.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()
        self.assertEqual(response.status, 400)
        self.assertFalse(payload["ok"])


# --------------------------------------------------------------------------
# 会话 CRUD 与产物
# --------------------------------------------------------------------------

class SessionsApi(ServerCase):
    def test_create_list_detail(self):
        sid = self.new_session("第一条")
        status, listing = self.json_request("GET", "/sessions")
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in listing["sessions"]], [sid])

        status, detail = self.json_request("GET", f"/sessions/{sid}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["session"]["id"], sid)
        self.assertEqual(detail["session"]["title"], "第一条")
        self.assertEqual(detail["events"], [])

    def test_detail_404(self):
        status, payload = self.json_request("GET", "/sessions/sdeadbeef0000")
        self.assertEqual(status, 404)
        self.assertEqual(payload["class"], "input")

    def test_invalid_id_400(self):
        status, payload = self.json_request("GET", "/sessions/..%2Fetc")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])

    def test_title_too_long(self):
        status, payload = self.json_request("POST", "/sessions",
                                            {"title": "x" * 500})
        self.assertEqual(status, 400)

    def test_artifacts_endpoint(self):
        sid = self.new_session()
        status, payload = self.json_request("GET", f"/sessions/{sid}/artifacts")
        self.assertEqual(status, 200)
        self.assertEqual(payload["artifacts"], [])
        self.server.store.write_artifact(sid, "report.pdf", b"%PDF-1.4")
        status, payload = self.json_request("GET", f"/sessions/{sid}/artifacts")
        self.assertEqual(status, 200)
        self.assertEqual([item["name"] for item in payload["artifacts"]],
                         ["report.pdf"])
        self.assertEqual(payload["artifacts"][0]["kind"], "pdf")


# --------------------------------------------------------------------------
# 流式事件
# --------------------------------------------------------------------------

class Streaming(ServerCase):
    turns = [ChatResponse(content="你好，这里是演示回答。")]

    def test_plain_text_event_order(self):
        sid = self.new_session()
        conn, response = self.open_stream(sid, "你好")
        try:
            events = self.read_stream(response)
        finally:
            conn.close()

        names = [name for name, _ in events]
        self.assertEqual(names[0], "agent")
        self.assertEqual(names[-1], "done")
        payloads = [data for _, data in events]
        self.assertEqual(payloads[0]["type"], "message")
        self.assertEqual(payloads[0]["role"], "user")
        self.assertEqual(payloads[-1]["type"], "done")
        self.assertEqual(payloads[-1]["session_id"], sid)

        types = [item["type"] for item in payloads[:-1]]
        self.assertIn("token", types)
        assistant = [item for item in payloads if item["type"] == "message"
                     and item["role"] == "assistant"]
        self.assertEqual(len(assistant), 1)
        self.assertEqual(assistant[0]["content"], "你好，这里是演示回答。")
        token_ids = {item["id"] for item in payloads if item["type"] == "token"}
        self.assertEqual(token_ids, {assistant[0]["id"]})

    def test_events_are_persisted_without_done(self):
        sid = self.new_session()
        conn, response = self.open_stream(sid, "你好")
        try:
            events = self.read_stream(response)
        finally:
            conn.close()
        streamed = [data for name, data in events if name == "agent"]
        status, detail = self.json_request("GET", f"/sessions/{sid}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["events"], streamed)
        self.assertNotIn("done", [item["type"] for item in detail["events"]])

    def test_empty_text_400(self):
        sid = self.new_session()
        status, payload = self.json_request("POST", f"/sessions/{sid}/message",
                                            {"text": "   "})
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])

    def test_message_missing_session_404(self):
        status, payload = self.json_request("POST", "/sessions/sdeadbeef0000/message",
                                            {"text": "hi"})
        self.assertEqual(status, 404)

    def test_session_busy_409(self):
        sid = self.new_session()
        blocker = BlockingProvider()
        self.provider = blocker
        conn, response = self.open_stream(sid, "第一句")
        try:
            self.assertTrue(blocker.started.wait(timeout=10), "运行没有启动")
            status, payload = self.json_request("POST", f"/sessions/{sid}/message",
                                                {"text": "第二句"})
            self.assertEqual(status, 409)
            self.assertEqual(payload["class"], "execution")
            blocker.release.set()
            payloads = [data for _, data in self.read_stream(response)]
        finally:
            blocker.release.set()
            conn.close()
        self.assertEqual(payloads[-1]["type"], "done")


# --------------------------------------------------------------------------
# 工具与错误
# --------------------------------------------------------------------------

class ToolFlow(ServerCase):
    registry = make_registry(EchoTool(), BoomTool())
    turns = [tool_call("echo", {"text": "hi"}), ChatResponse(content="工具跑完了")]

    def test_low_risk_tool_roundtrip(self):
        sid = self.new_session()
        conn, response = self.open_stream(sid, "调用回显")
        try:
            payloads = [data for _, data in self.read_stream(response)]
        finally:
            conn.close()

        calls = [item for item in payloads if item["type"] == "tool_call"]
        results = [item for item in payloads if item["type"] == "tool_result"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["name"], "echo")
        self.assertEqual(calls[0]["status"], "running")
        self.assertEqual(calls[0]["risk"], "low")
        self.assertEqual(results[0]["id"], calls[0]["id"])
        self.assertTrue(results[0]["ok"])
        self.assertEqual(results[0]["evidence"],
                         {"agent": "ops", "call_id": "t0001"})
        self.assertEqual(results[0]["data"], {"echo": "hi"})
        self.assertIsInstance(results[0]["duration_ms"], int)
        self.assertEqual(payloads[-2]["role"], "assistant")
        self.assertEqual(payloads[-1]["type"], "done")


class ToolFailures(ServerCase):
    registry = make_registry(EchoTool(), BoomTool())

    def test_unknown_tool_is_capability_error(self):
        self.provider = ScriptedProvider(
            [tool_call("does_not_exist"), ChatResponse(content="我换个办法")])
        sid = self.new_session()
        conn, response = self.open_stream(sid, "编个工具")
        try:
            payloads = [data for _, data in self.read_stream(response)]
        finally:
            conn.close()
        results = [item for item in payloads if item["type"] == "tool_result"]
        errors = [item for item in payloads if item["type"] == "error"]
        self.assertFalse(results[0]["ok"])
        self.assertEqual(errors[0]["class"], "capability")

    def test_tool_exception_is_execution_error(self):
        self.provider = ScriptedProvider(
            [tool_call("boom"), ChatResponse(content="失败了")])
        sid = self.new_session()
        conn, response = self.open_stream(sid, "炸一下")
        try:
            payloads = [data for _, data in self.read_stream(response)]
        finally:
            conn.close()
        results = [item for item in payloads if item["type"] == "tool_result"]
        errors = [item for item in payloads if item["type"] == "error"]
        self.assertFalse(results[0]["ok"])
        self.assertIn("RuntimeError", results[0]["summary"])
        self.assertEqual(errors[0]["class"], "execution")

    def test_max_turns_emits_error(self):
        self.provider = ScriptedProvider([tool_call("echo", {"text": "x"})
                                          for _ in range(20)])
        sid = self.new_session()
        conn, response = self.open_stream(sid, "无限循环")
        try:
            payloads = [data for _, data in self.read_stream(response)]
        finally:
            conn.close()
        errors = [item for item in payloads if item["type"] == "error"]
        self.assertTrue(errors)
        self.assertIn("轮次", errors[-1]["message"])
        self.assertEqual(len([item for item in payloads
                              if item["type"] == "tool_call"]), 8)


# --------------------------------------------------------------------------
# 审批与取消
# --------------------------------------------------------------------------

class ApprovalFlow(ServerCase):
    registry = make_registry(RiskyTool())
    approval_timeout = 5.0

    def _start_risky(self, sid: str):
        self.provider = ScriptedProvider([
            tool_call("reboot_station", {"station_id": "SYNTH-01"}),
            ChatResponse(content="已按决定处理。"),
        ])
        return self.open_stream(sid, "重启 SYNTH-01")

    def _read_until_approval(self, response) -> tuple[str, dict]:
        deadline = time.monotonic() + 10
        event = None
        while time.monotonic() < deadline:
            event = self.next_event(response)
            self.assertIsNotNone(event, "流提前结束，没等到审批事件")
            name, data = event
            if data.get("type") == "approval" and data.get("status") == "pending":
                return data["id"], data
            self.assertNotEqual(data.get("type"), "tool_result",
                                "审批未决时不得出现 tool_result")
        self.fail("没有等到 pending 审批")

    def test_approved_then_execute(self):
        sid = self.new_session()
        conn, response = self._start_risky(sid)
        try:
            approval_id, pending = self._read_until_approval(response)
            self.assertEqual(pending["risk"], "high")
            self.assertIn("prompt", pending)
            status, payload = self.json_request(
                "POST", f"/sessions/{sid}/approval",
                {"approval_id": approval_id, "decision": "approved",
                 "note": "确认重启"})
            self.assertEqual(status, 200, payload)
            rest = self.read_stream(response)
        finally:
            conn.close()

        approvals = [data for _, data in rest if data.get("type") == "approval"]
        self.assertEqual(approvals[0]["status"], "approved")
        self.assertEqual(approvals[0]["id"], approval_id)
        results = [data for _, data in rest if data.get("type") == "tool_result"]
        self.assertTrue(results[0]["ok"])
        self.assertEqual(results[0]["data"], {"rebooted": "SYNTH-01"})

    def test_rejected_skips_tool(self):
        sid = self.new_session()
        conn, response = self._start_risky(sid)
        try:
            approval_id, _ = self._read_until_approval(response)
            status, _ = self.json_request(
                "POST", f"/sessions/{sid}/approval",
                {"approval_id": approval_id, "decision": "rejected"})
            self.assertEqual(status, 200)
            rest = self.read_stream(response)
        finally:
            conn.close()

        approvals = [data for _, data in rest if data.get("type") == "approval"]
        self.assertEqual(approvals[0]["status"], "rejected")
        results = [data for _, data in rest if data.get("type") == "tool_result"]
        self.assertFalse(results[0]["ok"])
        self.assertIn("未获批准", results[0]["summary"])
        messages = [data for _, data in rest
                    if data.get("type") == "message" and data.get("role") == "assistant"]
        self.assertEqual(messages[-1]["content"], "已按决定处理。")

    def test_invalid_decision_400(self):
        sid = self.new_session()
        conn, response = self._start_risky(sid)
        try:
            approval_id, _ = self._read_until_approval(response)
            status, payload = self.json_request(
                "POST", f"/sessions/{sid}/approval",
                {"approval_id": approval_id, "decision": "maybe"})
            self.assertEqual(status, 400)
            self.assertFalse(payload["ok"])
            # 收尾：拒绝掉，避免用例结束时运行还挂着。
            self.json_request("POST", f"/sessions/{sid}/approval",
                              {"approval_id": approval_id, "decision": "rejected"})
            self.read_stream(response)
        finally:
            conn.close()

    def test_unknown_approval_404(self):
        self.server.approval_timeout = 0.3
        sid = self.new_session()
        conn, response = self._start_risky(sid)
        try:
            self._read_until_approval(response)
            status, payload = self.json_request(
                "POST", f"/sessions/{sid}/approval",
                {"approval_id": "a-does-not-exist", "decision": "approved"})
            self.assertEqual(status, 404)
            self.assertFalse(payload["ok"])
            # 等审批超时把这一轮跑完，别让运行挂到用例结束之后。
            self.read_stream(response)
        finally:
            conn.close()

    def test_approval_timeout_is_rejected(self):
        self.server.approval_timeout = 0.3
        sid = self.new_session()
        conn, response = self._start_risky(sid)
        started = time.monotonic()
        try:
            payloads = [data for _, data in self.read_stream(response)]
        finally:
            conn.close()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0)
        approvals = [item for item in payloads if item["type"] == "approval"]
        self.assertEqual(approvals[-1]["status"], "rejected")
        self.assertIn("超时", approvals[-1].get("note", ""))
        results = [item for item in payloads if item["type"] == "tool_result"]
        self.assertFalse(results[0]["ok"])

    def test_cancel_interrupts(self):
        sid = self.new_session()
        conn, response = self._start_risky(sid)
        try:
            self._read_until_approval(response)
            status, payload = self.json_request("POST", f"/sessions/{sid}/cancel")
            self.assertEqual(status, 200)
            self.assertTrue(payload["cancelled"])
            rest = self.read_stream(response)
        finally:
            conn.close()

        approvals = [data for _, data in rest if data.get("type") == "approval"]
        self.assertEqual(approvals[-1]["status"], "rejected")
        results = [data for _, data in rest if data.get("type") == "tool_result"]
        self.assertFalse(results[0]["ok"])
        errors = [data for _, data in rest if data.get("type") == "error"]
        self.assertTrue(errors)

        # 运行结束后会话不再 busy：再发一句能正常跑。
        self.provider = ScriptedProvider([ChatResponse(content="取消之后仍然可用")])
        conn2, response2 = self.open_stream(sid, "再来一次")
        try:
            payloads = [data for _, data in self.read_stream(response2)]
        finally:
            conn2.close()
        self.assertEqual(payloads[-1]["type"], "done")
        self.assertIn("取消之后仍然可用",
                      [item.get("content") for item in payloads
                       if item["type"] == "message"])

    def test_cancel_without_run_reports_false(self):
        sid = self.new_session()
        status, payload = self.json_request("POST", f"/sessions/{sid}/cancel")
        self.assertEqual(status, 200)
        self.assertFalse(payload["cancelled"])


# --------------------------------------------------------------------------
# 设置
# --------------------------------------------------------------------------

class SettingsApi(ServerCase):
    def test_defaults(self):
        status, payload = self.json_request("GET", "/settings")
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"provider", "base_url", "model",
                                        "temperature", "has_key", "fake_fallback"})
        self.assertEqual(payload["provider"], "openai_compatible")
        self.assertFalse(payload["has_key"])
        self.assertTrue(payload["fake_fallback"])

    def test_post_updates_and_fake_has_no_fallback(self):
        status, payload = self.json_request("POST", "/settings", {
            "provider": "fake", "model": "demo-x", "temperature": 0.25,
        })
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["settings"]["provider"], "fake")
        self.assertEqual(payload["settings"]["model"], "demo-x")
        self.assertEqual(payload["settings"]["temperature"], 0.25)
        self.assertFalse(payload["settings"]["fake_fallback"])

        status, payload = self.json_request("GET", "/settings")
        self.assertEqual(payload["model"], "demo-x")

    def test_settings_persist_to_disk(self):
        self.json_request("POST", "/settings", {"provider": "fake", "model": "m1"})
        stored = json.loads(Path(self._tmp.name, "settings.json")
                            .read_text(encoding="utf-8"))
        self.assertEqual(stored["model"], "m1")

    def test_invalid_values(self):
        for patch in ({"provider": "nope"},
                      {"temperature": 9},
                      {"temperature": True},
                      {"base_url": "ftp://x"},
                      {"model": 42}):
            status, payload = self.json_request("POST", "/settings", patch)
            self.assertEqual(status, 400, f"{patch} 应被拒绝")
            self.assertFalse(payload["ok"])

    def test_api_key_never_echoed(self):
        status, payload, raw, _ = self.request("POST", "/settings", {
            "provider": "openai_compatible",
            "base_url": "https://example.invalid/v1",
            "model": "demo",
            "api_key": SECRET,
        })
        self.assertNotIn(SECRET.encode("utf-8"), raw)
        # WP3 的 secret_store 可能还没合入；两种结果都算合理，但都不能回显。
        self.assertIn(status, (200, 500))
        if status == 200:
            self.assertNotIn(SECRET, json.dumps(payload, ensure_ascii=False))
            status, settings = self.json_request("GET", "/settings")
            self.assertEqual(status, 200)
            self.assertTrue(settings["has_key"])
            self.assertFalse(settings["fake_fallback"])
            self.assertNotIn(SECRET, json.dumps(settings, ensure_ascii=False))
        else:
            self.assertEqual(payload["class"], "capability")

    def test_provider_falls_back_without_key(self):
        self.json_request("POST", "/settings", {
            "provider": "openai_compatible",
            "base_url": "https://example.invalid/v1",
            "model": "demo",
        })
        status, payload = self.json_request("GET", "/settings")
        self.assertEqual(status, 200)
        self.assertTrue(payload["fake_fallback"])


# --------------------------------------------------------------------------
# 客户端断开
# --------------------------------------------------------------------------

class Disconnect(ServerCase):
    registry = make_registry(RiskyTool())
    approval_timeout = 0.3
    turns = [tool_call("reboot_station", {"station_id": "SYNTH-01"}),
             ChatResponse(content="按决定处理完了。")]

    def test_client_close_does_not_kill_server_or_lose_events(self):
        sid = self.new_session()
        conn, response = self.open_stream(sid, "重启")
        try:
            self.next_event(response)  # 用户消息
        finally:
            conn.close()
        deadline = time.monotonic() + 10
        types = []
        while time.monotonic() < deadline:
            status, detail = self.json_request("GET", f"/sessions/{sid}")
            types = [item["type"] for item in detail["events"]]
            if "tool_result" in types and "error" in types:
                break
            time.sleep(0.05)
        self.assertIn("approval", types)
        self.assertIn("tool_result", types)
        # 服务仍在：健康检查可用。
        status, payload = self.json_request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])


if __name__ == "__main__":
    unittest.main()
