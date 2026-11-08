#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/dev_chat.py 与 tools/dev_chat_say.py 的测试。

不起真实进程的用例走进程内 ThreadingHTTPServer；需要端到端的用 subprocess。
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TOOLS = REPO / "tools"
sys.path.insert(0, str(TOOLS))

import dev_chat  # noqa: E402


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class _Server:
    """进程内的 ChatServer 包装，用在不需要真进程的用例里。"""

    def __init__(self, tmpdir: str, token: str = ""):
        self.log = Path(tmpdir) / "chat.jsonl"
        self.store = dev_chat.Store(self.log)
        self.srv = dev_chat.ChatServer(("127.0.0.1", 0), dev_chat.Handler,
                                       store=self.store, token=token)
        self.port = self.srv.server_address[1]
        self.base = "http://127.0.0.1:%d" % self.port
        self.token = token
        self._t = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self._t.start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    def _h(self):
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        return h

    def say(self, who, text, tag=""):
        body = json.dumps({"who": who, "text": text, "tag": tag},
                          ensure_ascii=False).encode()
        req = urllib.request.Request(self.base + "/api/say", data=body,
                                     headers=self._h(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    def messages(self, since=0):
        req = urllib.request.Request(
            self.base + "/api/messages?since=%d" % since,
            headers=self._h(), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    def health(self):
        with urllib.request.urlopen(self.base + "/api/health", timeout=5) as r:
            return json.loads(r.read().decode())


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = dev_chat.Store(Path(self.tmp.name) / "c.jsonl")

    def tearDown(self):
        self.tmp.cleanup()

    def test_seq_starts_at_one(self):
        row = self.store.append("A", "hi", "")
        self.assertEqual(row["seq"], 1)

    def test_seq_monotonic(self):
        for i in range(5):
            self.store.append("B", "m%d" % i, "")
        self.assertEqual(self.store.total, 5)

    def test_reload_keeps_seq(self):
        self.store.append("A", "one", "")
        self.store.append("B", "two", "")
        again = dev_chat.Store(self.store.path)
        self.assertEqual(again.total, 2)
        self.assertEqual(again.append("C", "three", "")["seq"], 3)

    def test_since_filters(self):
        for i in range(4):
            self.store.append("A", "m%d" % i, "")
        self.assertEqual(len(self.store.since(2)), 2)

    def test_bad_json_line_skipped(self):
        self.store.append("A", "ok", "")
        with open(self.store.path, "a", encoding="utf-8") as f:
            f.write("{not json\n")
        again = dev_chat.Store(self.store.path)
        self.assertEqual(again.total, 1)


class WhoNormalizationTest(unittest.TestCase):
    def test_members(self):
        for m in ("A", "B", "C", "D", "你"):
            self.assertEqual(dev_chat._norm_who(m), m)

    def test_alias_user(self):
        for a in ("USER", "user", "u"):
            self.assertEqual(dev_chat._norm_who(a), "你")

    def test_lowercase_letters(self):
        self.assertEqual(dev_chat._norm_who("b"), "B")

    def test_rejects_others(self):
        for bad in ("X", "", None, "  ", "USER2", "E"):
            self.assertIsNone(dev_chat._norm_who(bad))


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = _Server(self.tmp.name)

    def tearDown(self):
        self.s.close()
        self.tmp.cleanup()

    def test_say_returns_row(self):
        code, d = self.s.say("B", "工-1 完成")
        self.assertEqual(code, 200)
        self.assertTrue(d["ok"])
        self.assertEqual(d["row"]["who"], "B")
        self.assertEqual(d["row"]["seq"], 1)

    def test_say_rejects_bad_who(self):
        code, d = self.s.say("X", "hi")
        self.assertEqual(code, 400)
        self.assertIn("who", d["error"])

    def test_say_rejects_empty(self):
        code, d = self.s.say("A", "   ")
        self.assertEqual(code, 400)
        self.assertIn("text", d["error"])

    def test_say_rejects_too_long(self):
        code, d = self.s.say("A", "x" * (dev_chat.MAX_TEXT + 1))
        self.assertEqual(code, 400)
        self.assertIn("超过", d["error"])

    def test_alias_mapped(self):
        code, d = self.s.say("USER", "别名")
        self.assertEqual(code, 200)
        self.assertEqual(d["row"]["who"], "你")

    def test_messages_total_and_since(self):
        for i in range(3):
            self.s.say("A", "m%d" % i)
        code, d = self.s.messages(0)
        self.assertEqual(code, 200)
        self.assertEqual(d["total"], 3)
        self.assertEqual(len(d["messages"]), 3)

        code, d = self.s.messages(2)
        self.assertEqual(len(d["messages"]), 1)

    def test_health(self):
        h = self.s.health()
        self.assertTrue(h["ok"])
        self.assertEqual(h["members"], list(dev_chat.MEMBERS))

    def test_unknown_path_404(self):
        req = urllib.request.Request(self.s.base + "/nope", method="GET")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 404)

    def test_page_served(self):
        with urllib.request.urlopen(self.s.base + "/", timeout=5) as r:
            html = r.read().decode()
        self.assertIn("开发群聊", html)
        self.assertIn("api/say", html)

    # ---- chunked 编码：.NET HttpClient 默认这么发，必须支持 ----

    def _post_chunked(self, payload: dict) -> tuple[int, dict]:
        import http.client
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.s.port, timeout=5)
        try:
            conn.putrequest("POST", "/api/say")
            conn.putheader("Content-Type", "application/json")
            if self.s.token:
                conn.putheader("Authorization", "Bearer " + self.s.token)
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            mid = max(1, len(body) // 2)
            for part in (body[:mid], body[mid:]):
                if not part:
                    continue
                conn.send(("%x\r\n" % len(part)).encode() + part + b"\r\n")
            conn.send(b"0\r\n\r\n")
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, {"error": raw}
        finally:
            conn.close()

    def test_say_accepts_chunked(self):
        code, d = self._post_chunked({"who": "B", "text": "chunked 也要能发"})
        self.assertEqual(code, 200, d)
        self.assertTrue(d["ok"])
        self.assertEqual(d["row"]["text"], "chunked 也要能发")

    def test_chunked_rejects_bad_who(self):
        code, d = self._post_chunked({"who": "X", "text": "x"})
        self.assertEqual(code, 400)

    def test_chunked_empty_body(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.s.port, timeout=5)
        try:
            conn.putrequest("POST", "/api/say")
            conn.putheader("Content-Type", "application/json")
            if self.s.token:
                conn.putheader("Authorization", "Bearer " + self.s.token)
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            conn.send(b"0\r\n\r\n")
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400)
            resp.read()
        finally:
            conn.close()


class TokenTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tok = "a" * 32
        self.s = _Server(self.tmp.name, token=self.tok)

    def tearDown(self):
        self.s.close()
        self.tmp.cleanup()

    def test_correct_token_ok(self):
        code, _ = self.s.say("A", "hi")
        self.assertEqual(code, 200)

    def test_wrong_token_401(self):
        body = json.dumps({"who": "A", "text": "hi"}).encode()
        req = urllib.request.Request(
            self.s.base + "/api/say", data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer wrong"},
            method="POST")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 401)

    def test_no_token_401(self):
        req = urllib.request.Request(self.s.base + "/api/messages", method="GET")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 401)

    def test_page_needs_no_token(self):
        with urllib.request.urlopen(self.s.base + "/", timeout=5) as r:
            self.assertEqual(r.status, 200)


class CliTest(unittest.TestCase):
    """端到端：真起进程，按契约读 DEV_CHAT_READY。"""

    def test_ready_line_and_roundtrip(self):
        port = _free_port()
        tmp = tempfile.TemporaryDirectory()
        log = Path(tmp.name) / "chat.jsonl"
        py = sys.executable
        proc = subprocess.Popen(
            [py, str(TOOLS / "dev_chat.py"), "--port", str(port), "--log", str(log)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", cwd=str(REPO),
        )
        try:
            line = proc.stdout.readline()
            self.assertTrue(line.startswith("DEV_CHAT_READY "),
                            "没看到就绪行，实际：%r" % line)
            self.assertEqual(int(line.split()[1]), port)

            env = dict(os.environ)
            env["FSA_DEV_CHAT_URL"] = "http://127.0.0.1:%d" % port
            env.pop("FSA_DEV_CHAT_TOKEN", None)

            r = subprocess.run(
                [py, str(TOOLS / "dev_chat_say.py"), "--who", "B",
                 "--text", "端到端测试", "--tag", "测试"],
                capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(REPO))
            self.assertEqual(r.returncode, 0, r.stderr)

            r = subprocess.run(
                [py, str(TOOLS / "dev_chat_say.py"), "--read", "5"],
                capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(REPO))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("端到端测试", r.stdout)
            self.assertIn("B", r.stdout)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            tmp.cleanup()

    def test_gen_token_is_hex(self):
        r = subprocess.run([sys.executable, str(TOOLS / "dev_chat.py"), "--gen-token"],
                           capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0)
        t = r.stdout.strip()
        self.assertEqual(len(t), 32)
        int(t, 16)


if __name__ == "__main__":
    unittest.main()
