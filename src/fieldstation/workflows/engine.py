"""engine —— 重实现引擎（B）的 HTTP 客户端。

流程不直接碰接收机，只通过 B 的 ``/api/*`` 说话；这样「脚本做什么」与「界面做什么」
走的是同一条代码路径，不会出现两套行为。默认地址 ``http://127.0.0.1:7788``
（``packages/app/src/server.ts`` 的 ``DEFAULT_PORT``），可用 ``FIELD_STATION_ENGINE``
或 ``--engine`` 覆盖。

失败分类直接决定流程停在哪个类里（见 :data:`spec.FAILURE_CLASSES`）：

* 连不上 / 超时 → ``environment``
* 400 / 409 / 422 → ``input``（参数或前置状态不对）
* 404 → ``artifact``（要导出的东西不存在）
* 401 / 403 → ``capability``（这个构建没有这项能力）
* 5xx → ``execution``
"""
from __future__ import annotations

import json as _json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

__all__ = [
    "DEFAULT_BASE_URL",
    "EngineClient",
    "EngineError",
    "EngineHttpError",
    "EngineProtocolError",
    "EngineUnavailable",
    "Response",
    "parse_target",
    "parse_target_string",
    "resolve_base_url",
]

DEFAULT_BASE_URL = "http://127.0.0.1:7788"
_USER_AGENT = "fieldstation-workflows/1"

_TCP_RE = re.compile(r"^(tcp|udp)://(.+):(\d+)$")
_SERIAL_STATUS_RE = re.compile(r"^(.+?) @ (\d+)$")
_SERIAL_BAUD_RE = re.compile(r"^(.+?)@(\d+)$")


@dataclass
class Response:
    status: int
    headers: Any
    body: bytes

    def json(self) -> dict:
        try:
            data = _json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            snippet = self.body[:200].decode("utf-8", "replace")
            raise EngineProtocolError(f"响应不是 JSON：{snippet!r}") from exc
        if not isinstance(data, dict):
            raise EngineProtocolError(f"响应不是 JSON 对象：{type(data).__name__}")
        return data


class EngineError(RuntimeError):
    """流程能识别的引擎错误。``failure_class`` 直接进 job.failure。"""

    failure_class = "execution"

    def __init__(self, message: str, *, evidence: dict | None = None) -> None:
        super().__init__(message)
        self.evidence = evidence or {}


class EngineUnavailable(EngineError):
    failure_class = "environment"


class EngineProtocolError(EngineError):
    failure_class = "execution"


class EngineHttpError(EngineError):
    def __init__(self, status: int, message: str, *, body: bytes = b"") -> None:
        self.status = status
        self.body = body
        super().__init__(message, evidence={"status": status, "body": _snippet(body)})

    @property
    def failure_class(self) -> str:  # type: ignore[override]
        if self.status in (400, 409, 422):
            return "input"
        if self.status in (401, 403):
            return "capability"
        if self.status == 404:
            return "artifact"
        return "execution"


def _snippet(body: bytes, limit: int = 400) -> str:
    text = body[:limit].decode("utf-8", "replace")
    return text if len(body) <= limit else text + "…"


def resolve_base_url(explicit: str | None = None) -> str:
    import os

    value = explicit or os.environ.get("FIELD_STATION_ENGINE") or DEFAULT_BASE_URL
    return value.rstrip("/")


class EngineClient:
    """B 的同步 HTTP 客户端（只用标准库）。"""

    def __init__(self, base_url: str | None = None, timeout: float = 10.0) -> None:
        self.base_url = resolve_base_url(base_url)
        self.timeout = float(timeout)

    # ------------------------------------------------------------------ 低层
    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict | None = None,
        json_body: object | None = None,
        timeout: float | None = None,
    ) -> Response:
        if not path.startswith("/"):
            raise ValueError(f"path 必须以 / 开头：{path!r}")
        url = self.base_url + path
        params = _clean_query(query)
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
        data: bytes | None = None
        headers = {"Accept": "application/json", "User-Agent": _USER_AGENT}
        if json_body is not None:
            data = _json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return Response(resp.status, resp.headers, resp.read())
        except urllib.error.HTTPError as exc:
            body = exc.read()
            raise EngineHttpError(
                exc.code,
                f"{method.upper()} {path} → HTTP {exc.code}：{_snippet(body)}",
                body=body,
            ) from exc
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise EngineUnavailable(
                    f"{method.upper()} {path} 超时（{self.timeout:g}s）：{self.base_url}",
                    evidence={"base_url": self.base_url, "reason": "timeout"},
                ) from exc
            raise EngineUnavailable(
                f"连不上引擎 {self.base_url}：{reason}",
                evidence={"base_url": self.base_url, "reason": str(reason)},
            ) from exc
        except (socket.timeout, TimeoutError) as exc:
            raise EngineUnavailable(
                f"{method.upper()} {path} 超时（{self.timeout:g}s）",
                evidence={"base_url": self.base_url, "reason": "timeout"},
            ) from exc

    def json(self, method: str, path: str, **kwargs: object) -> dict:
        return self.request(method, path, **kwargs).json()  # type: ignore[arg-type]

    def get_json(self, path: str, query: dict | None = None) -> dict:
        return self.json("GET", path, query=query)

    def post_json(self, path: str, body: object | None = None, query: dict | None = None) -> dict:
        return self.json("POST", path, json_body=body if body is not None else {}, query=query)

    def download(self, path: str, query: dict | None = None, timeout: float | None = None) -> Response:
        return self.request("GET", path, query=query, timeout=timeout)

    # ------------------------------------------------------------------ 高层
    def health(self) -> dict:
        return self.get_json("/api/health")

    def live_status(self) -> dict:
        return self.get_json("/api/live/status")

    def live_logs(self, after: int = 0, limit: int = 0) -> dict:
        query: dict = {"after": int(after)}
        if limit:
            query["limit"] = int(limit)
        return self.get_json("/api/live/logs", query=query)

    def live_connect(self, body: dict) -> dict:
        return self.post_json("/api/live/connect", body)

    def live_disconnect(self) -> dict:
        return self.post_json("/api/live/disconnect", {})

    def live_command(self, line: str) -> dict:
        return self.post_json("/api/live/command", {"line": line})


def _clean_query(query: dict | None) -> dict:
    if not query:
        return {}
    out: dict = {}
    for key, value in query.items():
        if value is None or value == "":
            continue
        out[key] = value
    return out


def parse_target(text: str) -> dict:
    """把 ``COM8@115200`` / ``tcp://host:port`` / ``udp://…`` / ``serial://…`` 变成连接体。"""
    raw = str(text or "").strip()
    if not raw:
        raise ValueError("target 不能为空")
    match = _TCP_RE.match(raw)
    if match:
        return {"kind": match.group(1), "host": match.group(2), "port": int(match.group(3))}
    if raw.lower().startswith("serial://"):
        parsed = urllib.parse.urlparse(raw)
        path = parsed.path.lstrip("/") or parsed.netloc
        if not path:
            raise ValueError(f"serial:// 缺少端口名：{raw!r}")
        baud = 115200
        qs = urllib.parse.parse_qs(parsed.query)
        if "baud" in qs:
            baud = int(qs["baud"][0])
        return {"kind": "serial", "path": path, "baud": baud}
    match = _SERIAL_BAUD_RE.match(raw)
    if match:
        return {"kind": "serial", "path": match.group(1), "baud": int(match.group(2))}
    if re.match(r"^(COM\d+|/dev/tty\w+)$", raw, re.IGNORECASE):
        return {"kind": "serial", "path": raw, "baud": 115200}
    raise ValueError(
        f"认不出 target {raw!r}；用 COM8@115200、tcp://127.0.0.1:3001、"
        "udp://127.0.0.1:3001 或 serial://COM8?baud=115200")


def parse_target_string(text: str) -> dict | None:
    """把 ``/api/live/status`` 的显示串还原成连接体（与 ``manage.js`` 的
    ``resetReconnectBody`` 同一套规则）。认不出时返回 ``None``。"""
    raw = str(text or "").strip()
    match = _TCP_RE.match(raw)
    if match:
        return {"kind": match.group(1), "host": match.group(2), "port": int(match.group(3))}
    match = _SERIAL_STATUS_RE.match(raw)
    if match:
        return {"kind": "serial", "path": match.group(1), "baud": int(match.group(2))}
    return None
