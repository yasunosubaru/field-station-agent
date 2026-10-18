"""OllamaProvider 的离线测试：用本机回环 HTTP 桩冒充 ``/api/chat``，不连任何真实服务。

门禁要求 skip==0，所以「没装 Ollama 就跳过」的路子不走 —— 本文件测的是 provider
的报文构造、响应归一与错误语义，全部在回环端口上确定性发生。真实服务的连通性
与可复现性由 ``tools/probe_provider_live.py`` 实测（那不是 unittest，不进测试门禁）。

桩的形状：``HTTPServer`` 起在 ``127.0.0.1`` 随机端口，handler 按用例预置的
``(status, body)`` 脚本逐条应答，并把收到的请求体记在 ``server.requests`` 上，
供用例断言「发出去的报文长什么样」。
"""
from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from fieldstation.agents.providers import (
    ChatMessage,
    OllamaProvider,
    Provider,
    ProviderError,
    get_provider,
)


class _StubHandler(BaseHTTPRequestHandler):
    """按 ``self.server.script`` 预置脚本应答的桩。"""

    def do_POST(self):  # noqa: N802  (BaseHTTPRequestHandler 命名)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        self.server.requests.append(json.loads(body))
        status, payload = self.server.script.pop(0)
        data = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # 静默：测试输出只看断言
        pass


class _StubServer:
    """回环端口上的 /api/chat 桩，setUp/tearDown 各起停一次。"""

    def __init__(self):
        self.httpd = HTTPServer(("127.0.0.1", 0), _StubHandler)
        self.httpd.script = []
        self.httpd.requests = []
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.httpd.server_port

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def _chat_body(payload):
    return json.dumps(payload, ensure_ascii=False)


class TestOllamaProvider(unittest.TestCase):
    """报文构造、响应归一、错误语义。"""

    def setUp(self):
        self.srv = _StubServer()
        self.cfg = {
            "url": self.srv.url,
            "model": "qwen3.8",
            "think": False,
            "options": {"temperature": 0, "seed": 42},
        }
        self.provider = get_provider("ollama", self.cfg)

    def tearDown(self):
        self.srv.stop()

    def _serve(self, status, payload):
        self.srv.httpd.script = [(status, payload)]
        self.srv.httpd.requests = []

    def test_protocol_and_name(self):
        """结构上满足 Provider 协议，name 来自类属性。"""
        self.assertEqual(self.provider.name, "ollama")
        self.assertIsInstance(self.provider, Provider)

    def test_text_roundtrip_usage_and_request_shape(self):
        """纯文本回合：响应映射 + usage 换算 + 发出去的报文逐键核对。"""
        self._serve(200, _chat_body({
            "message": {"role": "assistant", "content": "中位数是…"},
            "prompt_eval_count": 11,
            "eval_count": 7,
        }))
        resp = self.provider.chat(
            [ChatMessage(role="user", content="什么是中位数")], [])
        self.assertEqual(resp.content, "中位数是…")
        self.assertEqual(resp.tool_calls, [])
        self.assertEqual(resp.usage,
                         {"prompt_tokens": 11, "completion_tokens": 7})
        sent = self.srv.httpd.requests[0]
        self.assertEqual(sent["model"], "qwen3.8")
        self.assertIs(sent["stream"], False)
        self.assertEqual(sent["messages"][0],
                         {"role": "user", "content": "什么是中位数"})
        self.assertEqual(sent["options"], {"temperature": 0, "seed": 42})
        self.assertEqual(sent["think"], False)
        self.assertNotIn("tools", sent)  # 无工具时不发 tools 键

    def test_tool_calls_normalized_to_runtime_shape(self):
        """返回侧：Ollama 的 {function:{name,arguments}} 归一成 runtime 认的 {name,args}。

        入参按新契约用注册表口径的描述（providers 不再期待 Ollama 形状的工具）。"""
        self._serve(200, _chat_body({"message": {
            "role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": "qc_flags",
                                         "arguments": {"station": "BADG"}}}],
        }}))
        spec = [{"name": "qc_flags", "description": "查台站", "risk": "low",
                 "params": {"station": {"type": "string", "required": True}}}]
        resp = self.provider.chat(
            [ChatMessage(role="user", content="查 BADG")], spec)
        self.assertEqual(resp.tool_calls,
                         [{"name": "qc_flags", "args": {"station": "BADG"}}])
        sent = self.srv.httpd.requests[0]
        self.assertEqual(sent["tools"][0]["function"]["name"], "qc_flags")
        self.assertEqual(sent["tools"][0]["function"]["parameters"]["required"],
                         ["station"])

    def test_registry_tools_converted_to_wire_schema(self):
        """请求侧：注册表口径（name/description/params/risk）翻成 Ollama 的
        {"type":"function","function":{...,"parameters":JSON Schema}} ——
        required 收齐、items 变 schema 对象、risk 不进报文。"""
        registry_spec = [{
            "name": "robust_stats",
            "description": "稳健统计",
            "risk": "low",
            "params": {
                "values": {"type": "array", "items": "number",
                           "required": True, "description": "观测序列"},
                "unit": {"type": "string"},
            },
        }]
        self._serve(200, _chat_body({"message": {"role": "assistant",
                                                 "content": ""}}))
        self.provider.chat(
            [ChatMessage(role="user", content="s")], registry_spec)
        wire = self.srv.httpd.requests[0]["tools"]
        self.assertEqual(len(wire), 1)
        self.assertEqual(set(wire[0]), {"type", "function"})
        fn = wire[0]["function"]
        self.assertEqual(set(fn), {"name", "description", "parameters"})
        self.assertEqual(fn["name"], "robust_stats")
        self.assertEqual(fn["description"], "稳健统计")
        parameters = fn["parameters"]
        self.assertEqual(parameters["type"], "object")
        self.assertEqual(parameters["required"], ["values"])
        self.assertEqual(parameters["properties"]["values"],
                         {"type": "array", "items": {"type": "number"},
                          "description": "观测序列"})
        self.assertEqual(parameters["properties"]["unit"], {"type": "string"})

    def test_tool_call_without_arguments_gets_empty_args(self):
        self._serve(200, _chat_body({"message": {
            "role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": "x"}}],
        }}))
        resp = self.provider.chat(
            [ChatMessage(role="user", content="s")],
            [{"name": "x", "description": "", "risk": "low", "params": {}}])
        self.assertEqual(resp.tool_calls, [{"name": "x", "args": {}}])

    def test_http_error_is_typed_provider_error(self):
        """非 200 → ProviderError（带状态码与模型名），不是裸 urllib 异常。"""
        self._serve(500, _chat_body({"error": "boom"}))
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("500", str(cm.exception))
        self.assertIn("qwen3.8", str(cm.exception))

    def test_unreachable_service_is_provider_error(self):
        """服务不可达 → ProviderError，报文里带完整 url 便于定位。"""
        bad = get_provider("ollama", {"url": "http://127.0.0.1:1",
                                      "model": "m", "timeout_s": 2})
        with self.assertRaises(ProviderError) as cm:
            bad.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("http://127.0.0.1:1", str(cm.exception))

    def test_non_json_body_is_provider_error(self):
        self._serve(200, "这不是JSON")
        with self.assertRaises(ProviderError) as cm:
            self.provider.chat([ChatMessage(role="user", content="s")], [])
        self.assertIn("不是 JSON", str(cm.exception))

    def test_missing_model_raises_at_construction(self):
        """缺 model 在构造时就炸，且指明是配置错 —— 不猜默认模型。"""
        with self.assertRaises(ProviderError) as cm:
            OllamaProvider({"url": self.srv.url})
        self.assertIn("缺 model", str(cm.exception))


class TestFactoryContract(unittest.TestCase):
    """get_provider 的契约：新增分支不破旧约束。"""

    def test_unknown_provider_still_valueerror(self):
        with self.assertRaises(ValueError) as cm:
            get_provider("claude", {})
        self.assertIn("未知 provider", str(cm.exception))

    def test_fake_branch_unchanged(self):
        """fake 的行为与 M0 契约一致（tests/test_runtime.py 之外再钉一道）。"""
        p = get_provider("fake", {"responses": ["好"]})
        resp = p.chat([ChatMessage(role="user", content="x")], [])
        self.assertEqual(resp.content, "好")


if __name__ == "__main__":
    unittest.main()
