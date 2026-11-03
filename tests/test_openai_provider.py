#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAICompatibleProvider 的离线测试：回环 HTTP 桩冒充 ``/v1/chat/completions``。

门禁要求 skip==0，所以「没配 key 就跳过」的路子不走 —— 本文件测的是
报文构造、SSE 解析、错误分类，全部在 ``127.0.0.1`` 随机端口上确定性发生，
不连任何真实服务、不消耗任何额度。

桩的形状：``ThreadingHTTPServer``（流式响应要一边写一边读完，单线程会自锁），
handler 按 ``server.script`` 逐条应答。每条脚本是：

* ``{"chunks": [...], "status": 200}`` —— 分块写入并 flush，模拟 SSE；
  不写 Content-Length，靠连接关闭收尾（HTTP/1.0 语义）。
* ``{"body": "...", "status": 200}`` —— 一次性 JSON 响应。

收到的请求记在 ``server.requests`` 里（路径 / 头 / 解析后的 JSON 体），
供用例断言「发出去的报文长什么样」。
"""
from __future__ import annotations

import json
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fieldstation.agents.providers import (
    ChatMessage,
    ChatResponse,
    OpenAICompatibleProvider,
    Provider,
    ProviderError,
    get_provider,
)


def sse(obj) -> str:
    """一条 SSE data 行。对象用 json 序列化，避免手写转义出错。"""
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


DONE = "data: [DONE]\n\n"


def _delta(content: str) -> dict:
    return {"choices": [{"index": 0, "delta": {"content": content}}]}


def _closed_port() -> int:
    """拿一个「刚才还开着、现在肯定没人监听」的本机端口。

    固定用 1 号端口在 Windows 上会被防火墙静默丢弃，连接要等 2 秒才失败；
    先 bind 再 close 得到的端口会立刻回 RST，测试快得多。
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
    finally:
        probe.close()


def _finish(reason: str = "stop") -> dict:
    return {"choices": [{"index": 0, "delta": {}, "finish_reason": reason}]}


class _StubHandler(BaseHTTPRequestHandler):
    """按 ``self.server.script`` 预置脚本应答的桩。"""

    protocol_version = "HTTP/1.0"  # 无 Content-Length 时以关闭连接表示结束

    def do_POST(self):  # noqa: N802  (BaseHTTPRequestHandler 命名)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"__raw__": raw}
        self.server.requests.append({
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        })
        spec = self.server.script.pop(0)
        if spec.get("delay"):
            time.sleep(spec["delay"])
        status = spec.get("status", 200)
        try:
            if spec.get("chunks") is not None:
                self.send_response(status)
                self.send_header("Content-Type", spec.get(
                    "content_type", "text/event-stream"))
                self.send_header("Connection", "close")
                self.end_headers()
                for chunk in spec["chunks"]:
                    data = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                    self.wfile.write(data)
                    self.wfile.flush()
                return
            payload = spec.get("body", "").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", spec.get(
                "content_type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            # 超时用例里客户端已经走了，写失败是预期内的，不要污染测试输出
            # （Windows 上是 ConnectionAbortedError，Linux 上是 BrokenPipe）。
            pass

    def log_message(self, *args):  # 静默：测试输出只看断言
        pass


class _StubServer:
    """回环端口上的 /v1/chat/completions 桩，setUp/tearDown 各起停一次。"""

    def __init__(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
        self.httpd.daemon_threads = True
        self.httpd.script = []
        self.httpd.requests = []
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.httpd.server_port

    def serve(self, *specs):
        self.httpd.script = list(specs)
        self.httpd.requests = []

    @property
    def last(self) -> dict:
        return self.httpd.requests[-1]

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


class TestOpenAIProvider(unittest.TestCase):
    """报文构造、SSE 解析、错误语义。"""

    def setUp(self):
        self.srv = _StubServer()
        self.cfg = {
            "base_url": self.srv.url + "/",   # 尾斜杠必须被去掉
            "model": "gpt-test",
            "api_key": "sk-test-abc123",
            "timeout_s": 5,
        }
        self.provider = get_provider("openai_compatible", self.cfg)

    def tearDown(self):
        self.srv.stop()

    # ── 正常路径 ────────────────────────────────────────────────────────

    def test_protocol_and_name(self):
        """结构上满足 Provider 协议，name 来自类属性。"""
        self.assertEqual(self.provider.name, "openai_compatible")
        self.assertIsInstance(self.provider, Provider)

    def test_text_stream_roundtrip_usage_and_request_shape(self):
        """默认流式：分块 content 拼成完整正文，usage 与请求头逐项核对。"""
        self.srv.serve({"chunks": [
            sse(_delta("你好")),
            sse(_delta("，世界")),
            sse({"choices": [{"index": 0, "delta": {},
                              "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 9, "completion_tokens": 4,
                           "total_tokens": 13}}),
            DONE,
        ]})
        resp = self.provider.chat(
            [ChatMessage(role="system", content="你是助手"),
             ChatMessage(role="user", content="打个招呼")], [])

        self.assertEqual(resp.content, "你好，世界")
        self.assertEqual(resp.tool_calls, [])
        self.assertEqual(resp.usage, {"prompt_tokens": 9, "completion_tokens": 4,
                                      "total_tokens": 13})

        sent = self.srv.last
        self.assertEqual(sent["path"], "/v1/chat/completions")  # 尾斜杠没留双斜杠
        self.assertEqual(sent["headers"]["authorization"],
                         "Bearer sk-test-abc123")
        body = sent["body"]
        self.assertEqual(body["model"], "gpt-test")
        self.assertIs(body["stream"], True)
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.assertEqual(body["messages"],
                         [{"role": "system", "content": "你是助手"},
                          {"role": "user", "content": "打个招呼"}])
        self.assertNotIn("tools", body)
        self.assertNotIn("temperature", body)

    def test_non_stream_path_request_and_usage(self):
        """``stream: false``：走一次性 JSON，报文里没有 stream_options。"""
        provider = OpenAICompatibleProvider({
            "base_url": self.srv.url, "model": "gpt-test",
            "api_key": "k", "stream": False, "temperature": 0,
        })
        self.srv.serve({"body": json.dumps({
            "choices": [{"message": {"role": "assistant", "content": "答案是 42"}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2,
                      "total_tokens": 7},
        }, ensure_ascii=False)})
        resp = provider.chat([ChatMessage(role="user", content="6*7")], [])
        self.assertEqual(resp.content, "答案是 42")
        self.assertEqual(resp.usage, {"prompt_tokens": 5, "completion_tokens": 2,
                                      "total_tokens": 7})
        body = self.srv.last["body"]
        self.assertIs(body["stream"], False)
        self.assertNotIn("stream_options", body)
        self.assertEqual(body["temperature"], 0)

    def test_on_token_receives_each_delta(self):
        """``chat_stream`` 的 on_token 按块回调，拼起来等于 content。"""
        self.srv.serve({"chunks": [
            sse(_delta("甲")), sse(_delta("乙")), sse(_finish()), DONE]})
        pieces: list[str] = []
        resp = self.provider.chat_stream(
            [ChatMessage(role="user", content="x")], [], on_token=pieces.append)
        self.assertEqual(pieces, ["甲", "乙"])
        self.assertEqual(resp.content, "甲乙")
        self.assertIsInstance(resp, ChatResponse)

    def test_tool_calls_merged_by_index_and_arguments_parsed(self):
        """tool_calls 增量按 index 合并，arguments 片段拼完再解析成 dict。"""
        self.srv.serve({"chunks": [
            sse({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 1, "function": {"name": "qc_flags",
                                          "arguments": '{"sta'}}]}}]}),
            sse({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 1, "function": {"arguments": 'tion": "BADG"}'}}]}}]}),
            sse({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "function": {"name": "station_health",
                                          "arguments": "{}"}}]}}]}),
            sse(_finish("tool_calls")),
            DONE,
        ]})
        resp = self.provider.chat([ChatMessage(role="user", content="查")], [])
        self.assertEqual(resp.tool_calls, [
            {"name": "station_health", "args": {}},
            {"name": "qc_flags", "args": {"station": "BADG"}},
        ])

    def test_registry_tools_converted_to_function_schema(self):
        """请求侧：注册表口径 → OpenAI function schema，risk 不进报文。"""
        self.srv.serve({"chunks": [sse(_finish()), DONE]})
        self.provider.chat(
            [ChatMessage(role="user", content="s")],
            [{"name": "robust_stats", "description": "稳健统计", "risk": "low",
              "params": {
                  "values": {"type": "array", "items": "number",
                             "required": True, "description": "观测序列"},
                  "unit": {"type": "string"},
              }}])
        wire = self.srv.last["body"]["tools"]
        self.assertEqual(len(wire), 1)
        self.assertEqual(set(wire[0]), {"type", "function"})
        fn = wire[0]["function"]
        self.assertEqual(set(fn), {"name", "description", "parameters"})
        self.assertEqual(fn["name"], "robust_stats")
        self.assertEqual(fn["parameters"]["required"], ["values"])
        self.assertEqual(fn["parameters"]["properties"]["values"],
                         {"type": "array", "items": {"type": "number"},
                          "description": "观测序列"})
        self.assertEqual(fn["parameters"]["properties"]["unit"],
                         {"type": "string"})

    def test_wire_shaped_tools_pass_through(self):
        """已经是 ``{"type":"function",...}`` 的工具原样透传，不二次翻译。"""
        self.srv.serve({"chunks": [sse(_finish()), DONE]})
        spec = {"type": "function", "function": {
            "name": "x", "description": "d",
            "parameters": {"type": "object", "properties": {}}}}
        self.provider.chat([ChatMessage(role="user", content="s")], [spec])
        self.assertEqual(self.srv.last["body"]["tools"], [spec])

    def test_no_key_means_no_authorization_header(self):
        """本机免鉴权服务：没有 key 就不发 Authorization，不发空 Bearer。"""
        provider = OpenAICompatibleProvider(
            {"base_url": self.srv.url, "model": "local"})
        self.srv.serve({"chunks": [sse(_finish()), DONE]})
        provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertNotIn("authorization", self.srv.last["headers"])

    # ── 错误分类 ────────────────────────────────────────────────────────

    def test_http_401_is_provider_error_without_key(self):
        """鉴权失败 → ProviderError，带状态码，但绝不把 key 写进消息。"""
        self.srv.serve({"status": 401,
                        "body": json.dumps({"error": {
                            "message": "invalid token sk-test-abc123"}})})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        message = str(cm.exception)
        self.assertIn("401", message)
        self.assertNotIn("sk-test-abc123", message)
        self.assertIn("***", message)  # 服务端回显了 key 也会被抹掉

    def test_http_500_is_provider_error(self):
        self.srv.serve({"status": 500, "body": '{"error":"boom"}'})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("500", str(cm.exception))
        self.assertIn("gpt-test", str(cm.exception))

    def test_non_json_body_on_non_stream_is_provider_error(self):
        provider = OpenAICompatibleProvider(
            {"base_url": self.srv.url, "model": "m", "stream": False})
        self.srv.serve({"body": "这不是JSON"})
        with self.assertRaises(ProviderError) as cm:
            provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("不是 JSON", str(cm.exception))

    def test_non_sse_body_on_stream_is_provider_error(self):
        """默认流式下回了一段普通 JSON：按「不是 SSE」报错，不静默返回空串。"""
        self.srv.serve({"body": "这不是JSON"})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("不是 SSE", str(cm.exception))

    def test_garbage_sse_data_is_provider_error(self):
        """data 行不是 JSON → 报错，不跳过。"""
        self.srv.serve({"chunks": ["data: {这不是JSON\n\n", DONE]})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("不是 JSON", str(cm.exception))

    def test_interrupted_stream_is_provider_error(self):
        """没有 [DONE] 也没有 finish_reason 就断流 → 半截回答不当作完整回答。"""
        self.srv.serve({"chunks": [sse(_delta("半截")), sse(_delta("回答"))]})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("流提前结束", str(cm.exception))

    def test_error_field_inside_stream_is_provider_error(self):
        self.srv.serve({"chunks": [
            sse({"error": {"message": "quota exceeded"}}), DONE]})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("quota exceeded", str(cm.exception))

    def test_invalid_tool_arguments_json_is_provider_error(self):
        """tool_call 参数不是合法 JSON 就抛，不拿 {} 顶替（那是编造参数）。"""
        self.srv.serve({"chunks": [
            sse({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "function": {"name": "x",
                                          "arguments": "{不是JSON"}}]}}]}),
            sse(_finish("tool_calls")), DONE]})
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("tool_call", str(cm.exception))

    def test_unreachable_service_is_provider_error(self):
        port = _closed_port()
        bad = OpenAICompatibleProvider(
            {"base_url": f"http://127.0.0.1:{port}", "model": "m",
             "timeout_s": 2})
        with self.assertRaises(ProviderError) as cm:
            bad.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn(f"http://127.0.0.1:{port}", str(cm.exception))

    def test_timeout_is_provider_error(self):
        """服务端拖着不回 → 超时也必须是 ProviderError，不是裸 socket 异常。"""
        provider = OpenAICompatibleProvider(
            {"base_url": self.srv.url, "model": "m", "timeout_s": 0.3})
        self.srv.serve({"delay": 1.0,
                        "chunks": [sse(_finish()), DONE]})
        with self.assertRaises(ProviderError) as cm:
            provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("超时", str(cm.exception))

    # ── 构造期校验 ──────────────────────────────────────────────────────

    def test_missing_model_raises_at_construction(self):
        with self.assertRaises(ProviderError) as cm:
            OpenAICompatibleProvider({"base_url": self.srv.url})
        self.assertIn("缺 model", str(cm.exception))

    def test_missing_base_url_raises_at_construction(self):
        with self.assertRaises(ProviderError) as cm:
            OpenAICompatibleProvider({"model": "m"})
        self.assertIn("缺 base_url", str(cm.exception))


class TestFactoryContract(unittest.TestCase):
    """get_provider 的契约：新增分支不破旧约束。"""

    def test_openai_compatible_branch(self):
        p = get_provider("openai_compatible",
                         {"base_url": "http://127.0.0.1:9",
                          "model": "m", "api_key": "k"})
        self.assertIsInstance(p, OpenAICompatibleProvider)
        self.assertEqual(p.name, "openai_compatible")

    def test_key_may_be_injected_by_caller(self):
        """key 由调用方从 secret_store 取出后传入；构造器只收内存里的明文。"""
        p = OpenAICompatibleProvider({"base_url": "http://127.0.0.1:9",
                                      "model": "m", "api_key": "sk-x"})
        self.assertIn("Bearer sk-x", p._headers()["Authorization"])

    def test_unknown_provider_still_valueerror(self):
        with self.assertRaises(ValueError) as cm:
            get_provider("claude", {})
        self.assertIn("未知 provider", str(cm.exception))

    def test_fake_branch_unchanged(self):
        p = get_provider("fake", {"responses": ["好"]})
        resp = p.chat([ChatMessage(role="user", content="x")], [])
        self.assertEqual(resp.content, "好")


if __name__ == "__main__":
    unittest.main()
