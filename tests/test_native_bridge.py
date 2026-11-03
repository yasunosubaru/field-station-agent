#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NativeBridge：本地假 Node 上的 GET / POST / 二进制 / 错误 / 超时。

不起真 Node：这里要验证的是**桥的行为**（拼 URL、带 token、折错误、落 artifacts），
不是 Node 的采集逻辑。用一个 ThreadingHTTPServer 把每种响应形状各造一遍，
断言桥把它们折成什么样的 ``ToolResult``。

四条不放松的断言：

* ``X-FSA-Token`` 真的出现在请求头里（token 不走 URL）；
* 查询参数被正确 URL 编码（project 名里带空格/中文会踩到）；
* PDF 落盘、sha256 与 bytes 与写出的字节一致（产物是证据，不能只报个路径）；
* Node 报错、连不上、超时都是 ``ok=False``，**不抛异常**。
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

from fieldstation.agents.tools.native_bridge import (
    NativeBridge,
    build_native_tools,
    build_tools,
)
from fieldstation.agents.tools.rpa_bridge import RpaBridge

#: 假 Node 返回的 PDF 字节（带真实的 ``%PDF-`` 魔数，便于上层做同样的校验）。
PDF_BYTES = b"%PDF-1.4\n" + b"0" * 1200 + b"\n%%EOF\n"


class _Handler(BaseHTTPRequestHandler):
    """按路径路由的假 Node。请求记录进 ``server.records``。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # noqa: D401 —— 测试不出访问日志
        return

    # ------------------------------------------------------------------ 工具
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self, method: str, body: bytes = b"") -> None:
        parsed = urllib.parse.urlsplit(self.path)
        self.server.records.append({
            "method": method,
            "path": parsed.path,
            "query": dict(urllib.parse.parse_qsl(parsed.query)),
            "token": self.headers.get("X-FSA-Token"),
            "content_type": self.headers.get("Content-Type"),
            "body": body.decode("utf-8") if body else "",
        })

    # --------------------------------------------------------------- 路由
    def do_GET(self) -> None:  # noqa: N802 —— BaseHTTPRequestHandler 的约定
        self._record("GET")
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/captures":
            self._send_json(200, {"ok": True, "captures": [
                {"name": "sample.sbf", "bytes": 10}]})
            return
        if path == "/api/records":
            query = dict(urllib.parse.parse_qsl(
                urllib.parse.urlsplit(self.path).query))
            self._send_json(200, {
                "ok": True, "capture": query.get("capture"),
                "msgId": query.get("msgId"), "records": [1, 2],
            })
            return
        if path == "/api/ports":
            self._send_json(200, {"ok": True, "ports": ["COM8"]})
            return
        if path == "/api/graph/projects":
            self._send_json(200, {"ok": True, "count": 1, "projects": ["csv"]})
            return
        if path == "/api/graph/files":
            self._send_json(200, {"ok": True, "count": 1, "files": ["a.csv"]})
            return
        if path == "/api/graph/pdf":
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(PDF_BYTES)))
            self.send_header("X-PDF-Pages", "3")
            self.send_header("X-PDF-Bytes", str(len(PDF_BYTES)))
            self.end_headers()
            self.wfile.write(PDF_BYTES)
            return
        if path == "/api/live/status":
            self._send_json(200, {"ok": True, "connected": False})
            return
        if path == "/api/playback/info":
            self._send_json(200, {"ok": True, "frames": 42})
            return
        if path == "/api/boom":
            # 200 但 ok:false —— Node 用这种形状报业务失败（例如引擎没起来）。
            self._send_json(200, {"ok": False, "error": "engine 未连接"})
            return
        if path == "/api/slow":
            time.sleep(1.5)
            self._send_json(200, {"ok": True})
            return
        if path == "/api/badjson":
            body = b"<html>not json</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._send_json(404, {"ok": False, "error": "没有这个路径"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self._record("POST", body)
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/convert":
            payload = json.loads(body.decode("utf-8"))
            self._send_json(200, {"ok": True, "format": payload.get("format"),
                                  "echo": payload})
            return
        if path == "/api/live/connect":
            self._send_json(200, {"ok": True, "connected": True})
            return
        if path == "/api/live/command":
            self._send_json(200, {"ok": True, "sent": True})
            return
        if path == "/api/boom":
            self._send_json(500, {"ok": False, "error": "内部错误：采集损坏"})
            return
        self._send_json(404, {"ok": False, "error": "没有这个路径"})


class _Server(ThreadingHTTPServer):
    """假 Node 的服务器：客户端超时先走后，写响应会 BrokenPipe——这是用例的一部分。"""

    daemon_threads = True

    def handle_error(self, request, client_address) -> None:  # noqa: D401
        return


class _FakeNode:
    """本地假 Node，绑 127.0.0.1 的随机端口。"""

    def __init__(self) -> None:
        self.server = _Server(("127.0.0.1", 0), _Handler)
        self.server.records = []
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def records(self) -> list[dict]:
        return self.server.records

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class TestNativeBridge(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = _FakeNode()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.node.close()

    def setUp(self) -> None:
        self.node.records.clear()
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.artifacts = Path(self._tmp.name) / "artifacts"
        self.bridge = NativeBridge(self.node.base_url, "tok-123", self.artifacts)

    # ---------------------------------------------------------------- 构造
    def test_rejects_non_http_base_url(self):
        with self.assertRaises(ValueError):
            NativeBridge("127.0.0.1:7799", "t", self.artifacts)

    def test_creates_artifacts_dir(self):
        self.assertTrue(self.artifacts.is_dir())

    # ------------------------------------------------------------------ GET
    def test_get_captures_sends_token_and_returns_payload(self):
        result = self.bridge.native_captures()
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.data["captures"][0]["name"], "sample.sbf")
        record = self.node.records[-1]
        self.assertEqual(record["method"], "GET")
        self.assertEqual(record["path"], "/api/captures")
        self.assertEqual(record["token"], "tok-123", "token 必须在 X-FSA-Token 头里")

    def test_records_query_is_url_encoded(self):
        result = self.bridge.native_records(capture="2023 a+b.sbf", msg_id=7,
                                           offset=0, limit=2)
        self.assertTrue(result.ok, result.error)
        record = self.node.records[-1]
        self.assertEqual(record["query"], {
            "capture": "2023 a+b.sbf", "msgId": "7",
            "offset": "0", "limit": "2"})
        self.assertEqual(result.data["msgId"], "7")

    def test_records_requires_msg_id(self):
        result = self.bridge.native_records(capture="x.sbf")
        self.assertFalse(result.ok)
        self.assertIn("msgId", result.error)
        self.assertEqual(self.node.records, [], "参数不合法时不该发请求")

    def test_records_rejects_out_of_range_limit(self):
        result = self.bridge.native_records(msg_id=1, limit=26)
        self.assertFalse(result.ok)
        self.assertIn("limit", result.error)

    def test_records_rejects_bool_as_integer(self):
        result = self.bridge.native_records(msg_id=True)
        self.assertFalse(result.ok)
        self.assertIn("msgId", result.error)

    def test_ports_and_graph_and_playback(self):
        for name, call in (
            ("native_ports", self.bridge.native_ports),
            ("native_graph_projects", self.bridge.native_graph_projects),
            ("native_graph_files", lambda: self.bridge.native_graph_files("csv")),
            ("native_live_status", self.bridge.native_live_status),
            ("native_playback_info", self.bridge.native_playback_info),
        ):
            with self.subTest(tool=name):
                result = call()
                self.assertTrue(result.ok, f"{name}: {result.error}")
                self.assertIsInstance(result.data, dict)

    def test_graph_files_passes_project(self):
        self.bridge.native_graph_files(project="b1")
        self.assertEqual(self.node.records[-1]["query"], {"project": "b1"})

    # ----------------------------------------------------------------- POST
    def test_convert_posts_json_body(self):
        result = self.bridge.native_convert(
            "sample.sbf", format="RINEX", decimate=0.1)
        self.assertTrue(result.ok, result.error)
        record = self.node.records[-1]
        self.assertEqual(record["method"], "POST")
        self.assertEqual(record["path"], "/api/convert")
        self.assertIn("application/json", record["content_type"])
        body = json.loads(record["body"])
        self.assertEqual(body["capture"], "sample.sbf")
        self.assertEqual(body["decimate"], 0.1)
        self.assertEqual(result.data["format"], "RINEX")

    def test_convert_requires_capture(self):
        result = self.bridge.native_convert(None)
        self.assertFalse(result.ok)
        self.assertIn("capture", result.error)
        self.assertEqual(self.node.records, [])

    def test_live_connect_serial_requires_path(self):
        result = self.bridge.native_live_connect(kind="serial")
        self.assertFalse(result.ok)
        self.assertIn("path", result.error)

    def test_live_connect_tcp_defaults(self):
        result = self.bridge.native_live_connect(kind="tcp")
        self.assertTrue(result.ok, result.error)
        body = json.loads(self.node.records[-1]["body"])
        self.assertEqual(body, {"kind": "tcp", "host": "127.0.0.1",
                                "port": 3001})

    def test_live_command_requires_line(self):
        self.assertFalse(self.bridge.native_live_command("  ").ok)
        result = self.bridge.native_live_command("LOG VERSION")
        self.assertTrue(result.ok, result.error)
        self.assertEqual(json.loads(self.node.records[-1]["body"]),
                         {"line": "LOG VERSION"})

    # --------------------------------------------------------------- 二进制
    def test_graph_pdf_lands_in_artifacts_with_sha256(self):
        result = self.bridge.native_graph_pdf(project="csv", file="a.csv")
        self.assertTrue(result.ok, result.error)
        path = Path(result.data["path"])
        self.assertEqual(path.parent, self.artifacts)
        written = path.read_bytes()
        self.assertEqual(written, PDF_BYTES)
        self.assertEqual(result.data["sha256"],
                         hashlib.sha256(PDF_BYTES).hexdigest())
        self.assertEqual(result.data["bytes"], len(PDF_BYTES))
        self.assertEqual(result.data["name"], "a.pdf")
        self.assertEqual(result.data["headers"]["x-pdf-pages"], "3")

    def test_graph_pdf_does_not_overwrite_previous_artifact(self):
        first = self.bridge.native_graph_pdf(name="report.pdf")
        second = self.bridge.native_graph_pdf(name="report.pdf")
        self.assertTrue(first.ok and second.ok)
        self.assertNotEqual(first.data["path"], second.data["path"])
        self.assertEqual(second.data["name"], "report-2.pdf")

    def test_graph_pdf_strips_path_from_name(self):
        result = self.bridge.native_graph_pdf(name="../../evil.pdf")
        self.assertTrue(result.ok, result.error)
        path = Path(result.data["path"])
        self.assertEqual(path.parent, self.artifacts)
        self.assertEqual(path.name, "evil.pdf")

    # ----------------------------------------------------------------- 错误
    def test_http_500_becomes_error_not_exception(self):
        def call():
            return self.bridge._json("POST", "/api/boom", body={"a": 1})

        result = self.bridge._guard("probe", call)
        self.assertFalse(result.ok)
        self.assertIn("500", result.error)
        self.assertIn("采集损坏", result.error)

    def test_ok_false_body_becomes_error(self):
        result = self.bridge._guard(
            "probe", lambda: self.bridge._json("GET", "/api/boom"))
        self.assertFalse(result.ok)
        self.assertIn("engine 未连接", result.error)

    def test_non_json_response_becomes_error(self):
        result = self.bridge._guard(
            "probe", lambda: self.bridge._json("GET", "/api/badjson"))
        self.assertFalse(result.ok)
        self.assertIn("不是 JSON", result.error)

    def test_closed_port_becomes_error_not_exception(self):
        # 本机实测：连 127.0.0.1 上没监听的端口会一直等到超时（不是 RST），
        # 所以这里不断言具体错误词，只断言「失败被折成 ToolResult 且不拖太久」。
        closed = _FakeNode()
        url = closed.base_url
        closed.close()
        bridge = NativeBridge(url, "t", self.artifacts, timeout_s=1)
        started = time.monotonic()
        result = bridge.native_captures()
        self.assertFalse(result.ok)
        self.assertIn("native_captures", result.error)
        self.assertLess(time.monotonic() - started, 4)

    def test_unresolvable_host_becomes_error(self):
        bridge = NativeBridge("http://no-such-host.invalid:1", "t",
                              self.artifacts, timeout_s=5)
        result = bridge.native_captures()
        self.assertFalse(result.ok)
        self.assertIn("连不上", result.error)

    def test_out_of_range_port_is_config_error(self):
        with self.assertRaises(ValueError):
            NativeBridge("http://127.0.0.1:99999", "t", self.artifacts)

    def test_timeout_becomes_error(self):
        bridge = NativeBridge(self.node.base_url, "t", self.artifacts,
                              timeout_s=0.3)
        started = time.monotonic()
        result = bridge._guard(
            "probe", lambda: bridge._json("GET", "/api/slow"))
        self.assertFalse(result.ok)
        self.assertIn("timeout", result.error)
        self.assertLess(time.monotonic() - started, 1.4,
                        "超时必须按 timeout_s 返回，不能等满服务端")

    # --------------------------------------------------------------- 工具层
    def test_build_native_tools_covers_contract_names(self):
        tools = build_native_tools(self.bridge)
        names = [tool.name for tool in tools]
        self.assertEqual(names, [
            "native_captures", "native_records", "native_ports",
            "native_playback_info", "native_graph_projects",
            "native_graph_files", "native_graph_pdf", "native_live_status",
            "native_convert", "native_live_connect", "native_live_command",
        ])
        by_name = {tool.name: tool for tool in tools}
        self.assertEqual(by_name["native_convert"].risk, "medium")
        self.assertEqual(by_name["native_live_connect"].risk, "medium")
        self.assertEqual(by_name["native_live_command"].risk, "medium")
        self.assertEqual(by_name["native_graph_pdf"].risk, "low")
        for tool in tools:
            self.assertTrue(tool.description)
            self.assertIsInstance(tool.params, dict)
            self.assertIn(tool.risk, ("low", "medium", "high"))

    def test_tool_invoke_maps_camel_case_args(self):
        tool = {tool.name: tool for tool in build_native_tools(self.bridge)}[
            "native_records"]
        result = tool.invoke({"capture": "c.sbf", "msgId": 3})
        self.assertTrue(result.ok, result.error)
        self.assertEqual(self.node.records[-1]["query"]["msgId"], "3")

    def test_build_tools_merges_native_and_rpa_without_duplicates(self):
        rpa = RpaBridge(Path(__file__).resolve().parents[1], timeout_s=60)
        tools = build_tools(self.bridge, rpa)
        names = [tool.name for tool in tools]
        self.assertEqual(len(names), 19)
        self.assertEqual(len(set(names)), 19, "工具名必须唯一")
        self.assertIn("workflow_gate", names)
        self.assertIn("native_captures", names)

    def test_build_tools_without_bridges_is_empty(self):
        self.assertEqual(build_tools(), [])


if __name__ == "__main__":
    unittest.main()
