"""M6-6：Webhook 上报通道（issue #110）。

钉住四件事：

* **默认 dry-run 不发请求**（CI 不联网）；
* 载荷契约固定、只发摘要：白名单字段、换行折平、本机路径替换成 ``<home>``；
* 本地 fake server 收得到；5xx 有上限重试、4xx 不重试、连不上不阻塞；
* 每一次尝试都进审计，且审计里只留 URL 的 host（不带 token）。
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.agents.notify import (  # noqa: E402
    DETAIL_MAX,
    PAYLOAD_FIELDS,
    WebhookNotifier,
    build_payload,
)

ALERT = {
    "station": "BADG",
    "level": "critical",
    "source": "heartbeat",
    "title": "LINK 心跳 offline",
    "detail": "age 2100s > 1800s",
    "evidence": [{"agent": "device_heartbeat", "call_id": "heartbeat/LINK",
                  "secret": "不要发出去"}],
    "extra_not_allowed": "不要发出去",
}


class _Server:
    """本地 fake Webhook 服务：记录收到的 POST，按 ``status`` 回码。"""

    def __init__(self, status: int = 200) -> None:
        self.received: list[dict] = []
        received = self.received

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 —— http.server 的约定
                length = int(self.headers.get("Content-Length", "0") or 0)
                body = self.rfile.read(length)
                received.append({
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": json.loads(body.decode("utf-8")),
                })
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_args) -> None:  # 静默
                return None

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/hook"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _audit_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


class TestPayload(unittest.TestCase):
    def test_whitelist_and_sanitization(self):
        payload = build_payload(
            ALERT, generated_at="2024-01-01T06:00:00+00:00",
            log_path=str(Path.home() / "logs" / "x.jsonl"))
        self.assertEqual(set(payload), set(PAYLOAD_FIELDS))
        self.assertNotIn("extra_not_allowed", payload)
        self.assertEqual(set(payload["evidence"][0]), {"agent", "call_id"})
        self.assertTrue(payload["log_path"].startswith("<home>"),
                        payload["log_path"])

    def test_detail_is_one_line_and_truncated(self):
        alert = dict(ALERT, detail=("第一行\n第二行\n" + "x" * (DETAIL_MAX * 2)))
        payload = build_payload(alert, generated_at="t")
        self.assertNotIn("\n", payload["detail"])
        self.assertLessEqual(len(payload["detail"]), DETAIL_MAX)

    def test_bad_alert_rejected(self):
        with self.assertRaises(ValueError):
            build_payload("not a dict", generated_at="t")


class TestNotifier(unittest.TestCase):
    def test_dry_run_sends_nothing(self):
        server = _Server()
        try:
            with tempfile.TemporaryDirectory() as td:
                audit = Path(td) / "audit.jsonl"
                notifier = WebhookNotifier(server.url, dry_run=True,
                                           audit_path=audit)
                result = notifier.send(ALERT, generated_at="t")
                self.assertEqual(result.status, "dry_run")
                self.assertEqual(result.attempts, 0)
                self.assertEqual(server.received, [])
                rows = _audit_rows(audit)
                self.assertEqual([r["status"] for r in rows], ["dry_run"])
        finally:
            server.close()

    def test_dry_run_is_default_and_url_missing_forces_it(self):
        self.assertTrue(WebhookNotifier().dry_run)
        self.assertTrue(WebhookNotifier("http://127.0.0.1:1/x").dry_run)
        env = {"FIELD_STATION_WEBHOOK_URL": "http://127.0.0.1:1/x"}
        self.assertTrue(WebhookNotifier.from_env(env).dry_run)

    def test_fake_server_receives_contract(self):
        server = _Server()
        try:
            notifier = WebhookNotifier(server.url, dry_run=False,
                                       timeout_s=5, max_attempts=1)
            result = notifier.send(ALERT, generated_at="2024-01-01T06:00:00+00:00",
                                   log_path="logs/x.jsonl")
            self.assertEqual(result.status, "sent")
            self.assertEqual(result.attempts, 1)
            self.assertEqual(len(server.received), 1)
            body = server.received[0]["body"]
            self.assertEqual(set(body), set(PAYLOAD_FIELDS))
            self.assertEqual(body["event"], "station_alert")
            self.assertEqual(body["station"], "BADG")
            self.assertEqual(server.received[0]["path"], "/hook")
            self.assertIn("application/json",
                          server.received[0]["headers"]["Content-Type"])
        finally:
            server.close()

    def test_5xx_retries_up_to_limit_and_audits_each_attempt(self):
        server = _Server(status=500)
        try:
            with tempfile.TemporaryDirectory() as td:
                audit = Path(td) / "audit.jsonl"
                notifier = WebhookNotifier(server.url, dry_run=False,
                                           max_attempts=3, audit_path=audit)
                result = notifier.send(ALERT, generated_at="t")
                self.assertEqual(result.status, "failed")
                self.assertEqual(result.attempts, 3)
                self.assertEqual(len(server.received), 3)
                rows = _audit_rows(audit)
                self.assertEqual([r["status"] for r in rows],
                                 ["retry", "retry", "failed"])
                self.assertEqual({r["url_host"] for r in rows},
                                 {f"127.0.0.1:{server.httpd.server_address[1]}"})
        finally:
            server.close()

    def test_4xx_is_not_retried(self):
        server = _Server(status=404)
        try:
            with tempfile.TemporaryDirectory() as td:
                audit = Path(td) / "audit.jsonl"
                notifier = WebhookNotifier(server.url, dry_run=False,
                                           max_attempts=3, audit_path=audit)
                result = notifier.send(ALERT, generated_at="t")
                self.assertEqual(result.status, "failed")
                self.assertEqual(result.attempts, 1)
                self.assertEqual(len(server.received), 1)
                self.assertEqual([r["status"] for r in _audit_rows(audit)],
                                 ["failed"])
        finally:
            server.close()

    def test_connection_error_does_not_raise(self):
        with tempfile.TemporaryDirectory() as td:
            audit = Path(td) / "audit.jsonl"
            notifier = WebhookNotifier("http://127.0.0.1:1/hook", dry_run=False,
                                       timeout_s=1, max_attempts=2,
                                       audit_path=audit)
            result = notifier.send(ALERT, generated_at="t")   # 不抛异常即通过
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.attempts, 2)
            self.assertEqual(len(_audit_rows(audit)), 2)

    def test_audit_never_contains_full_url(self):
        server = _Server(status=200)
        try:
            with tempfile.TemporaryDirectory() as td:
                audit = Path(td) / "audit.jsonl"
                url = server.url + "?token=super-secret"
                notifier = WebhookNotifier(url, dry_run=False,
                                           max_attempts=1, audit_path=audit)
                notifier.send(ALERT, generated_at="t")
                raw = audit.read_text(encoding="utf-8")
                self.assertNotIn("super-secret", raw)
                self.assertNotIn("/hook", raw)
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
