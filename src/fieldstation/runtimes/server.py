# -*- coding: utf-8 -*-
"""把运行时网关挂到本地 HTTP（E1 对外的唯一入口）。

端点：
    GET  /v1/runtimes   两个运行时的可用状态（不触发模型调用）
    POST /v1/chat       一次对话，返回 SSE（统一事件协议）

只监听 127.0.0.1；请求体上限 1 MB；未知路径 404；方法不对 405。
"""
from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from .service import RuntimeRegistry, status_payload, stream_chat

MAX_BODY = 1 << 20


def make_handler(registry: RuntimeRegistry) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "fsa-runtime/1.0"

        def log_message(self, fmt, *args):  # 静音：不想把每个请求打到 stderr
            return

        def _send_json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 —— http.server 的约定
            if self.path.rstrip("/") in ("/v1/runtimes", "/runtimes"):
                self._send_json(200, status_payload(registry))
                return
            if self.path.rstrip("/") in ("/health", ""):
                self._send_json(200, {"ok": True})
                return
            self._send_json(404, {"error": {"type": "not_found", "message": self.path}})

        def do_POST(self):  # noqa: N802
            if self.path.rstrip("/") not in ("/v1/chat", "/chat"):
                self._send_json(404, {"error": {"type": "not_found", "message": self.path}})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY:
                self._send_json(413 if length > MAX_BODY else 400,
                                {"error": {"type": "invalid_request",
                                           "message": "请求体为空或过大"}})
                return
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": {"type": "invalid_request",
                                                "message": "不是合法 JSON"}})
                return
            if not isinstance(body, dict) or not body.get("prompt"):
                self._send_json(400, {"error": {"type": "invalid_request",
                                                "message": "缺少 prompt"}})
                return
            if not body.get("runtime"):
                self._send_json(400, {"error": {"type": "invalid_request",
                                                "message": "缺少 runtime（不自动回退）"}})
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            for chunk in stream_chat(registry, body):
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return   # 客户端断开就停，不要继续烧模型

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8788,
          registry: RuntimeRegistry | None = None,
          on_ready: Callable[[str], None] | None = None) -> None:
    registry = registry or RuntimeRegistry()
    httpd = ThreadingHTTPServer((host, port), make_handler(registry))
    url = "http://%s:%d" % (host, httpd.server_address[1])
    if on_ready:
        on_ready(url)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="运行时网关（SSE）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--once", action="store_true", help="只打印状态就退出")
    args = ap.parse_args(argv)

    registry = RuntimeRegistry()
    if args.once:
        print(json.dumps(status_payload(registry), ensure_ascii=False, indent=1))
        return 0
    print("RUNTIME_GATEWAY_READY http://%s:%d" % (args.host, args.port), flush=True)
    serve(args.host, args.port, registry)
    return 0


if __name__ == "__main__":
    sys.exit(main())
