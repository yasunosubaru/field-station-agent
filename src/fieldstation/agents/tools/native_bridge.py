"""Node 现有 ``/api/*`` 的 Python 侧桥（Agent 桌面版 WP5）。

Node 那侧的 server 是**唯一**能读采集、跑转换、连串口、出 PDF 的地方，Python 不
重写一遍。本模块只做四件事：拼 URL、带 token、解码响应、把失败折成
``ToolResult(ok=False, ...)``。

三条约束（与 ``tools/__init__.py`` 同源）：

* **失败要报，不要抛。** 桥的方法一律返回 ``ToolResult``；连接失败、HTTP 4xx/5xx、
  超时、响应不是 JSON、``ok:false`` 全部折成 ``error``。抛异常会打崩运行循环，
  一次 Node 没起来就整轮报废。
* **二进制落盘，不塞进事件流。** PDF 这类响应写进 ``artifacts_dir``，只回
  ``{path, sha256, bytes}``；把 PDF 的字节塞进会话 JSONL 既撑爆前端又没法审计。
* **token 只走请求头。** ``X-FSA-Token`` 不进 URL（URL 会进 Node 的访问日志），
  也不写进任何返回的 data。

接口形状以契约 §5 为准：``native_captures`` / ``native_records`` / ``native_ports``
/ ``native_convert`` / ``native_graph_projects`` / ``native_graph_files`` /
``native_graph_pdf`` / ``native_live_status`` / ``native_live_connect`` /
``native_live_command`` / ``native_playback_info``。参数名与 Node 的查询参数一致
（``msgId``、``project``、``file``），只有 Python 侧形参用下划线。

本模块只用标准库。
"""
from __future__ import annotations

import hashlib
import http.client
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import ToolResult

__all__ = [
    "NativeBridge",
    "NativeCapturesTool",
    "NativeConvertTool",
    "NativeGraphFilesTool",
    "NativeGraphPdfTool",
    "NativeGraphProjectsTool",
    "NativeLiveCommandTool",
    "NativeLiveConnectTool",
    "NativeLiveStatusTool",
    "NativePlaybackInfoTool",
    "NativePortsTool",
    "NativeRecordsTool",
    "build_native_tools",
    "build_tools",
]

#: Node 的 ``/api/records`` 单页上限（server.ts：``limit`` 的 1..25）。
RECORDS_PAGE_MAX = 25


class _BridgeError(RuntimeError):
    """一次请求失败：连不上、HTTP 状态非 2xx、响应体 ``ok:false``、响应不是 JSON。"""


class _BridgeTimeout(_BridgeError):
    """请求或下载超时。单独成类，好让调用方把「超时」与「Node 报错」分开。"""


def _int(value, label: str, *, minimum: int | None = None,
         maximum: int | None = None) -> int | None:
    """校验整数参数。``bool`` 是 ``int`` 的子类，必须单独拦（``True`` 不该变成 1）。"""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"参数 {label} 必须是整数，收到：{value!r}")
    if minimum is not None and value < minimum:
        raise ValueError(f"参数 {label} 必须 ≥ {minimum}，收到：{value}")
    if maximum is not None and value > maximum:
        raise ValueError(f"参数 {label} 必须 ≤ {maximum}，收到：{value}")
    return value


def _str(value, label: str) -> str | None:
    """校验字符串参数；空白串折成 ``None``（「没给」与「给了空串」在这里等价）。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"参数 {label} 必须是字符串，收到：{value!r}")
    text = value.strip()
    return text or None


def _number(value, label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"参数 {label} 必须是数值，收到：{value!r}")
    return float(value)


class NativeBridge:
    """Node ``/api/*`` 的薄客户端。每个方法返回 ``ToolResult``，不抛。"""

    def __init__(self, base_url: str, token: str | None,
                 artifacts_dir: str | Path, timeout_s: float = 30) -> None:
        text = str(base_url or "").strip()
        parts = urllib.parse.urlsplit(text)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(
                f"native base_url 必须是 http(s):// 地址（收到 {base_url!r}）；"
                "这是启动期配置错误，别等到第一次调工具才发现")
        try:
            parts.port  # 端口越界会在这里抛 ValueError
        except ValueError as exc:
            raise ValueError(f"native base_url 的端口不合法：{exc}") from exc
        self.base_url = text.rstrip("/")
        self.token = token or ""
        self.artifacts_dir = Path(artifacts_dir)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.timeout_s = float(timeout_s)

    # ------------------------------------------------------------------ HTTP
    def _url(self, path: str, query: dict | None = None) -> str:
        url = f"{self.base_url}{path}"
        pairs = {k: v for k, v in (query or {}).items() if v is not None}
        if pairs:
            # doseq 让列表参数也能编码；urlencode 会把空格、中文、& 都转义，
            # 不能自己拼字符串——project 名里带空格是实测会遇到的。
            url = f"{url}?{urllib.parse.urlencode(pairs, doseq=True)}"
        return url

    def _open(self, method: str, path: str, query: dict | None = None,
              body: dict | None = None) -> tuple[int, dict, bytes]:
        url = self._url(path, query)
        headers = {"Accept": "application/json"}
        if self.token:
            headers["X-FSA-Token"] = self.token
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(url, data=data, headers=headers,
                                         method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as exc:  # 4xx/5xx：先读 body 再报
            raise _BridgeError(
                f"HTTP {exc.code}：{self._error_text(exc)}") from exc
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise _BridgeTimeout(
                    f"{method} {path} 超过 {self.timeout_s:g}s") from exc
            raise _BridgeError(f"{method} {path} 连不上：{reason}") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise _BridgeTimeout(
                f"{method} {path} 超过 {self.timeout_s:g}s") from exc
        except OSError as exc:
            raise _BridgeError(f"{method} {path} 请求失败：{exc}") from exc
        except (ValueError, http.client.HTTPException) as exc:
            # HTTPException 不是 OSError（例如端口越界时的 InvalidURL）；漏了这一支，
            # 「桥不抛异常」的承诺就只对一半的坏输入成立。
            raise _BridgeError(f"{method} {path} 请求非法：{exc}") from exc

    @staticmethod
    def _error_text(exc: urllib.error.HTTPError) -> str:
        """把 Node 的错误体抽成一行人话；Node 的统一形状是 ``{ok:false,error}``。"""
        try:
            raw = exc.read()[:4000]
        except Exception:  # noqa: BLE001 —— 读错误体失败不能盖住原错误
            return exc.reason or "没有响应体"
        text = raw.decode("utf-8", "replace").strip()
        try:
            parsed = json.loads(text)
        except ValueError:
            return text[:400] or (exc.reason or "没有响应体")
        if isinstance(parsed, dict):
            return str(parsed.get("error") or parsed.get("message") or text)[:400]
        return text[:400]

    def _json(self, method: str, path: str, query: dict | None = None,
              body: dict | None = None) -> dict:
        _, _, payload = self._open(method, path, query, body)
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise _BridgeError(f"{path} 返回的不是 JSON：{exc}") from exc
        if isinstance(parsed, dict):
            if parsed.get("ok") is False:
                raise _BridgeError(
                    str(parsed.get("error") or f"{path} 返回 ok=false"))
            return parsed
        # Node 偶尔直接回数组（例如 job 列表）；统一包一层，data 键集合才是稳定的。
        return {"items": parsed}

    def _download(self, path: str, query: dict | None, name: str | None,
                  fallback: str) -> dict:
        _, headers, payload = self._open("GET", path, query)
        if not payload:
            raise _BridgeError(f"{path} 返回 0 字节——空文件不能当产物")
        target = self._unique(self.artifacts_dir / self._safe_name(name, fallback))
        target.write_bytes(payload)
        return {
            "name": target.name,
            "path": str(target),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "content_type": headers.get("Content-Type"),
            # X-PDF-Pages / X-PDF-Bytes 这类头是 PDF 是否完整的证据（见
            # workflows/gui.graph.export.yaml），原样带回供上层写 artifact 事件。
            "headers": {k.lower(): v for k, v in headers.items()
                        if k.lower().startswith("x-")},
        }

    @staticmethod
    def _safe_name(name: str | None, fallback: str) -> str:
        """只用文件名部分：``name`` 可能来自模型，带路径就是路径穿越。"""
        text = str(name or "").strip() or fallback
        text = re.split(r"[\\/]+", text)[-1].strip()
        text = re.sub(r'[<>:"|?*\x00-\x1f]', "_", text)
        if not text or text in (".", ".."):
            raise _BridgeError(f"下载文件名不可用：{name!r}")
        return text

    @staticmethod
    def _unique(target: Path) -> Path:
        """同名文件不覆盖：产物是证据，后一次不该把前一次的字节吃掉。"""
        if not target.exists():
            return target
        for index in range(2, 1000):
            candidate = target.with_name(f"{target.stem}-{index}{target.suffix}")
            if not candidate.exists():
                return candidate
        raise _BridgeError(f"artifacts 目录里同名文件过多：{target.name}")

    def _guard(self, label: str, fn) -> ToolResult:
        try:
            return ToolResult(ok=True, data=fn())
        except _BridgeTimeout as exc:
            return ToolResult(ok=False, error=f"{label}: timeout（{exc}）")
        except _BridgeError as exc:
            return ToolResult(ok=False, error=f"{label}: {exc}")
        except (ValueError, TypeError) as exc:
            return ToolResult(ok=False, error=f"{label}: 参数无效：{exc}")

    # ---------------------------------------------------------------- 采集
    def native_captures(self) -> ToolResult:
        """``GET /api/captures``：采集列表 + 可用格式。"""

        def call() -> dict:
            return self._json("GET", "/api/captures")

        return self._guard("native_captures", call)

    def native_records(self, capture: str | None = None, msg_id: int | None = None,
                       offset: int | None = 0,
                       limit: int | None = 20) -> ToolResult:
        """``GET /api/records``：读一次采集里某个消息号的记录（分页）。

        ``msgId`` 是必填的：Node 的 ``/api/records`` 只认二进制消息号或 ``name``
        （文本记录表），本工具只走消息号这一路，缺了就明确报错而不是让 Node 回 400。
        """

        def call() -> dict:
            message_id = _int(msg_id, "msgId", minimum=0)
            if message_id is None:
                raise ValueError(
                    "参数 msgId 必填——Node 的 /api/records 需要二进制消息号")
            return self._json("GET", "/api/records", {
                "capture": _str(capture, "capture"),
                "msgId": message_id,
                "offset": _int(offset if offset is not None else 0,
                               "offset", minimum=0),
                "limit": _int(limit if limit is not None else 20, "limit",
                              minimum=1, maximum=RECORDS_PAGE_MAX),
            })

        return self._guard("native_records", call)

    def native_ports(self) -> ToolResult:
        """``GET /api/ports``：本机串口列表（Device Manager 里的名字）。"""

        def call() -> dict:
            return self._json("GET", "/api/ports")

        return self._guard("native_ports", call)

    def native_convert(self, capture: str, format: str | None = None,
                       decimate: float | None = None,
                       unknown: str | None = None,
                       destination: str | None = None,
                       prefix: str | None = None, suffix: str | None = None,
                       start=None, finish=None) -> ToolResult:
        """``POST /api/convert``：按 Convert 向导的输出设置跑转换。

        ``decimate`` 是**周期秒数**（= 1 / Sample Rate），不是 Hz；``start`` / ``finish``
        给 ISO 时间或 ``{week, seconds}``。字段语义与 Node 侧一致，本层不改口径。
        """

        def call() -> dict:
            name = _str(capture, "capture")
            if name is None:
                raise ValueError("参数 capture 必填（要转换哪一次采集）")
            body: dict = {"capture": name}
            for key, value in (("format", _str(format, "format")),
                               ("unknown", _str(unknown, "unknown")),
                               ("destination", _str(destination, "destination")),
                               ("prefix", _str(prefix, "prefix")),
                               ("suffix", _str(suffix, "suffix"))):
                if value is not None:
                    body[key] = value
            period = _number(decimate, "decimate")
            if period is not None:
                if period <= 0:
                    raise ValueError("参数 decimate 必须是大于 0 的秒数")
                body["decimate"] = period
            if start is not None:
                body["start"] = start
            if finish is not None:
                body["finish"] = finish
            return self._json("POST", "/api/convert", body=body)

        return self._guard("native_convert", call)

    # ---------------------------------------------------------------- Graph
    def native_graph_projects(self) -> ToolResult:
        """``GET /api/graph/projects``：Graph 导出目录列表。"""

        def call() -> dict:
            return self._json("GET", "/api/graph/projects")

        return self._guard("native_graph_projects", call)

    def native_graph_files(self, project: str | None = None) -> ToolResult:
        """``GET /api/graph/files``：某个工程的 CSV 列表；不给 project 用内置 csv/。"""

        def call() -> dict:
            return self._json("GET", "/api/graph/files", {
                "project": _str(project, "project"),
            })

        return self._guard("native_graph_files", call)

    def native_graph_pdf(self, project: str | None = None,
                         file: str | None = None,
                         name: str | None = None) -> ToolResult:
        """``GET /api/graph/pdf``：导出 PDF 并落 artifacts，返回 path/sha256/bytes。"""

        def call() -> dict:
            target = _str(file, "file")
            fallback = "graph-report.pdf"
            if target:
                stem = Path(target).stem or "graph"
                fallback = f"{stem}.pdf"
            return self._download("/api/graph/pdf", {
                "project": _str(project, "project"),
                "file": target,
            }, _str(name, "name"), fallback)

        return self._guard("native_graph_pdf", call)

    # ----------------------------------------------------------------- Live
    def native_live_status(self) -> ToolResult:
        """``GET /api/live/status``：当前实时连接状态。"""

        def call() -> dict:
            return self._json("GET", "/api/live/status")

        return self._guard("native_live_status", call)

    def native_live_connect(self, kind: str | None = "tcp",
                            path: str | None = None,
                            baud: int | None = 115200,
                            host: str | None = None,
                            port: int | None = 3001) -> ToolResult:
        """``POST /api/live/connect``：建立串口 / TCP / UDP 实时连接（有副作用）。"""

        def call() -> dict:
            mode = (_str(kind, "kind") or "tcp").lower()
            if mode not in ("serial", "tcp", "udp"):
                raise ValueError("参数 kind 必须是 serial / tcp / udp")
            body: dict = {"kind": mode}
            if mode == "serial":
                device = _str(path, "path")
                if device is None:
                    raise ValueError("kind=serial 时必须给 path（例如 COM8）")
                body["path"] = device
                body["baud"] = _int(baud if baud is not None else 115200,
                                    "baud", minimum=300, maximum=4_000_000)
            else:
                body["host"] = _str(host, "host") or "127.0.0.1"
                body["port"] = _int(port if port is not None else 3001,
                                    "port", minimum=1, maximum=65535)
            return self._json("POST", "/api/live/connect", body=body)

        return self._guard("native_live_connect", call)

    def native_live_command(self, line: str) -> ToolResult:
        """``POST /api/live/command``：往实时链路发一行命令（有副作用）。"""

        def call() -> dict:
            text = _str(line, "line")
            if text is None:
                raise ValueError("参数 line 必填（不能发空行）")
            return self._json("POST", "/api/live/command", body={"line": text})

        return self._guard("native_live_command", call)

    # ------------------------------------------------------------- Playback
    def native_playback_info(self, capture: str | None = None) -> ToolResult:
        """``GET /api/playback/info``：回放的帧数、时间范围与 GPS 周。"""

        def call() -> dict:
            return self._json("GET", "/api/playback/info", {
                "capture": _str(capture, "capture"),
            })

        return self._guard("native_playback_info", call)


# ====================================================================== 工具
#
# 每个工具只是「参数搬运 + 风险标注」，不在这里重做校验或改口径：
# 校验在桥里（一处），模型看到的名字与描述在注册表里（一处）。


class NativeCapturesTool:
    name = "native_captures"
    description = (
        "列出 Node 侧可用的采集文件及其可转换格式。只读；返回采集名、大小、"
        "相对路径与格式清单。找不到采集时据实说没有，不要猜。")
    params = {}
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_captures()


class NativeRecordsTool:
    name = "native_records"
    description = (
        "按消息号读取一次采集里的二进制记录，分页返回（offset/limit）。"
        "msgId 必填；单页最多 25 条。只读。")
    params = {
        "capture": {"type": "string", "required": False,
                    "description": "采集文件名；缺省用 Node 侧当前采集"},
        "msgId": {"type": "integer", "required": True,
                  "description": "二进制消息号（0 起）"},
        "offset": {"type": "integer", "required": False,
                   "description": "起始偏移，默认 0"},
        "limit": {"type": "integer", "required": False,
                  "description": "返回条数 1..25，默认 20"},
    }
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_records(
            capture=args.get("capture"), msg_id=args.get("msgId"),
            offset=args.get("offset", 0), limit=args.get("limit", 20))


class NativePortsTool:
    name = "native_ports"
    description = "列出本机串口（含设备管理器里的名字）。只读；插拔后可能需刷新。"
    params = {}
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_ports()


class NativeConvertTool:
    name = "native_convert"
    description = (
        "按 Convert 向导的输出设置把一次采集转成指定格式（ASCII/RINEX 等）。"
        "会写文件：给了 destination 就落盘到该绝对目录。decimate 是周期秒数"
        "（= 1 / Sample Rate），不是 Hz。")
    params = {
        "capture": {"type": "string", "required": True,
                    "description": "要转换的采集文件名"},
        "format": {"type": "string", "required": False,
                   "description": "输出格式，默认由 Node 决定（ASCII）"},
        "decimate": {"type": "number", "required": False,
                     "description": "抽取周期，单位秒（= 1 / Sample Rate），须 > 0"},
        "unknown": {"type": "string", "required": False,
                    "description": "未知字节处理：SEPARATE / INTERLEAVE / ignore"},
        "destination": {"type": "string", "required": False,
                        "description": "输出目录（绝对路径）；不给则只在 Node 侧生成"},
        "prefix": {"type": "string", "required": False,
                   "description": "文件名前缀（与 suffix 只能给一个，≤18 字符）"},
        "suffix": {"type": "string", "required": False,
                   "description": "文件名后缀（与前缀只能给一个，≤18 字符）"},
        "start": {"type": "string", "required": False,
                  "description": "起始时间，ISO 8601 或 {week, seconds}"},
        "finish": {"type": "string", "required": False,
                   "description": "结束时间，ISO 8601 或 {week, seconds}"},
    }
    risk = "medium"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_convert(
            capture=args.get("capture"), format=args.get("format"),
            decimate=args.get("decimate"), unknown=args.get("unknown"),
            destination=args.get("destination"), prefix=args.get("prefix"),
            suffix=args.get("suffix"), start=args.get("start"),
            finish=args.get("finish"))


class NativeGraphProjectsTool:
    name = "native_graph_projects"
    description = "列出 Graph 已导出过的工程（含 CSV 数与 GPS 时间范围）。只读。"
    params = {}
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_graph_projects()


class NativeGraphFilesTool:
    name = "native_graph_files"
    description = "列出某个 Graph 工程里的 CSV 文件。只读；project 可给目录名或工程名。"
    params = {
        "project": {"type": "string", "required": False,
                    "description": "工程 key（导出目录名）或 CSV 里的工程名；"
                                   "缺省用内置 csv/"},
    }
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_graph_files(project=args.get("project"))


class NativeGraphPdfTool:
    name = "native_graph_pdf"
    description = (
        "把 Graph 工程导出为 PDF 并落进会话产物目录，返回 path / sha256 / bytes "
        "与 X-PDF-* 页数头。只读源数据，但会新建产物文件。")
    params = {
        "project": {"type": "string", "required": False,
                    "description": "工程 key 或工程名；缺省用内置 csv/"},
        "file": {"type": "string", "required": False,
                 "description": "只导这一个 CSV；缺省导整个工程"},
        "name": {"type": "string", "required": False,
                 "description": "落盘文件名（默认按 CSV 名或 graph-report.pdf）"},
    }
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_graph_pdf(
            project=args.get("project"), file=args.get("file"),
            name=args.get("name"))


class NativeLiveStatusTool:
    name = "native_live_status"
    description = "查询实时链路（串口/TCP/UDP）当前是否连着、连到哪。只读。"
    params = {}
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_live_status()


class NativeLiveConnectTool:
    name = "native_live_connect"
    description = (
        "建立实时链路：串口（kind=serial, path=COM8, baud）或 TCP/UDP"
        "（host, port）。会占用设备端口，先确认目标再调。")
    params = {
        "kind": {"type": "string", "required": True,
                 "description": "serial / tcp / udp"},
        "path": {"type": "string", "required": False,
                 "description": "串口名（kind=serial 时必填），例如 COM8"},
        "baud": {"type": "integer", "required": False,
                 "description": "波特率，默认 115200"},
        "host": {"type": "string", "required": False,
                 "description": "TCP/UDP 主机，默认 127.0.0.1"},
        "port": {"type": "integer", "required": False,
                 "description": "TCP/UDP 端口，默认 3001"},
    }
    risk = "medium"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_live_connect(
            kind=args.get("kind", "tcp"), path=args.get("path"),
            baud=args.get("baud", 115200), host=args.get("host"),
            port=args.get("port", 3001))


class NativeLiveCommandTool:
    name = "native_live_command"
    description = (
        "往已建立的实时链路发一行命令（例如查询版本）。会改变设备侧状态，"
        "先读 native_live_status 确认连的是哪台设备。")
    params = {
        "line": {"type": "string", "required": True,
                 "description": "要发送的整行命令（不含换行）"},
    }
    risk = "medium"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_live_command(line=args.get("line"))


class NativePlaybackInfoTool:
    name = "native_playback_info"
    description = "读回放信息：帧数、时间范围、GPS 周。只读。"
    params = {
        "capture": {"type": "string", "required": False,
                    "description": "采集文件名；缺省用 Node 侧当前采集"},
    }
    risk = "low"

    def __init__(self, bridge: NativeBridge) -> None:
        self.bridge = bridge

    def invoke(self, args: dict) -> ToolResult:
        return self.bridge.native_playback_info(capture=args.get("capture"))


def build_native_tools(bridge: NativeBridge) -> list:
    """按契约 §5 的 native 清单建工具；顺序即模型看到的顺序（读在前、写在后）。"""
    return [
        NativeCapturesTool(bridge),
        NativeRecordsTool(bridge),
        NativePortsTool(bridge),
        NativePlaybackInfoTool(bridge),
        NativeGraphProjectsTool(bridge),
        NativeGraphFilesTool(bridge),
        NativeGraphPdfTool(bridge),
        NativeLiveStatusTool(bridge),
        NativeConvertTool(bridge),
        NativeLiveConnectTool(bridge),
        NativeLiveCommandTool(bridge),
    ]


def build_tools(native: NativeBridge | None = None,
                rpa_bridge=None, *,
                node_url: str | None = None,
                token: str | None = None,
                artifacts_dir: str | Path | None = None,
                timeout_s: float = 30,
                **context) -> list:
    """组装整套工具：native + rpa。任一桥为 ``None`` 就跳过那一组。

    两种调用方式：

    * ``build_tools(native, rpa_bridge)``：调用方自己建好两个桥；
    * ``build_tools(node_url=..., token=..., artifacts_dir=...)``：只给 Node 地址，
      本函数按需建 ``NativeBridge``。

    第二个形参刻意**不叫** ``rpa``：orchestrator 的工具发现会把构造出来的桥对象
    自动注入到名为 ``bridge`` / ``native`` / ``rpa`` 的形参上，名字撞上就会在
    native 那一步把 rpa 工具也注册一遍，随后 rpa 那一步再注册同一批 → 一串
    「工具重名」警告、真实工具被跳过。叫 ``rpa_bridge`` 就让注入只落在 native 上，
    各模块只注册自己那一组。

    ``rpa_bridge`` 用鸭子类型接收，避免本模块反向依赖 ``rpa_bridge`` 模块。
    """
    tools: list = []
    if native is None and node_url and artifacts_dir:
        native = NativeBridge(node_url, token, artifacts_dir, timeout_s)
    if native is not None:
        tools.extend(build_native_tools(native))
    if rpa_bridge is not None:
        from .rpa_bridge import build_rpa_tools

        tools.extend(build_rpa_tools(rpa_bridge))
    names = [tool.name for tool in tools]
    if len(set(names)) != len(names):
        raise ValueError(f"工具重名：{sorted(names)}")
    return tools
