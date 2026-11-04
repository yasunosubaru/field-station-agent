# -*- coding: utf-8 -*-
"""运行时网关 HTTP 层的离线测试（本地回环，不连外网、不连模型）。"""
import json
import threading
import unittest
import urllib.error
import urllib.request

from fieldstation.runtimes import FakeRuntime, RuntimeRegistry
from fieldstation.runtimes.server import make_handler, serve


class GatewayCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = RuntimeRegistry([FakeRuntime()])
        cls.httpd = __import__("http.server", fromlist=["ThreadingHTTPServer"]).ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(cls.registry))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def post(self, path, body, *, raw=False):
        data = body if raw else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.url(path), data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        return urllib.request.urlopen(req, timeout=5)


class TestGateway(GatewayCase):
    def test_health(self):
        with urllib.request.urlopen(self.url("/health"), timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertTrue(json.loads(resp.read())["ok"])

    def test_runtimes_status(self):
        with urllib.request.urlopen(self.url("/v1/runtimes"), timeout=5) as resp:
            payload = json.loads(resp.read())
        self.assertIn("fake", payload["runtimes"])
        self.assertEqual(payload["model_default"], "deepseek-v4.1-flash")

    def test_chat_streams_sse(self):
        with self.post("/v1/chat", {"runtime": "fake", "session_id": "s1", "prompt": "hi"}) as resp:
            self.assertEqual(resp.status, 200)
            self.assertTrue(resp.headers["Content-Type"].startswith("text/event-stream"))
            text = resp.read().decode("utf-8")
        events = [line[7:] for line in text.splitlines() if line.startswith("event: ")]
        self.assertEqual(events, ["session.start", "message.delta", "message.done"])
        self.assertIn("（演示）", text)

    def test_missing_runtime_is_400(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post("/v1/chat", {"session_id": "s", "prompt": "x"})
        self.assertEqual(ctx.exception.code, 400)

    def test_missing_prompt_is_400(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post("/v1/chat", {"runtime": "fake", "session_id": "s"})
        self.assertEqual(ctx.exception.code, 400)

    def test_bad_json_is_400(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post("/v1/chat", b"{oops", raw=True)
        self.assertEqual(ctx.exception.code, 400)

    def test_unknown_path_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url("/nope"), timeout=5)
        self.assertEqual(ctx.exception.code, 404)

    def test_unknown_runtime_streams_error_event(self):
        with self.post("/v1/chat", {"runtime": "nope", "session_id": "s", "prompt": "x"}) as resp:
            text = resp.read().decode("utf-8")
        self.assertIn("event: error", text)
        self.assertIn("没有这个运行时", text)


class TestServeSignature(unittest.TestCase):
    def test_on_ready_receives_url(self):
        seen = {}

        class Stop(Exception):
            pass

        def ready(url):
            seen["url"] = url
            raise Stop()

        with self.assertRaises(Stop):
            serve(port=0, registry=RuntimeRegistry([FakeRuntime()]), on_ready=ready)
        self.assertTrue(seen["url"].startswith("http://127.0.0.1:"))


if __name__ == "__main__":
    unittest.main()
