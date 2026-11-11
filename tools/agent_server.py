#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌面版 Agent 的本地 HTTP 服务（WP2）。

契约见 ``docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md`` §2–§3：

```text
python tools/agent_server.py --port 0 --token <hex> \
    --node-url http://127.0.0.1:<nodePort> --repo <root> --data-dir <dir>
→ stdout: AGENT_READY <agentPort>
```

## 边界

* 只监听 ``127.0.0.1``；每个请求都要 ``Authorization: Bearer <token>``。
* 请求体上限 5 MB；超了直接 413，不读进内存。
* 错误统一 ``{ok:false,error,class}``；``class`` 取契约的五个值。
* 事件先落盘、再写 SSE：客户端中途断开时，会话文件里仍是完整的一轮，
  重新打开会话可以重放；连接断了不影响这次运行跑完。
* ``done`` 是**流的结束标记**，不写进会话 JSONL —— 会话重放不需要它，
  而且一次运行只有一个结束点。
* 不打印 token、不打印本机绝对路径。日志里最多出现异常类名。

## 线程模型

``ThreadingHTTPServer``：每个连接一个线程。同一会话同时只允许一个运行
（第二个请求回 409），否则两条运行会交错写同一个 JSONL，事件顺序就废了。
审批与取消都是「服务端状态 + ``threading.Event``」，没有轮询文件的延迟。
"""
from __future__ import annotations

import argparse
import hmac
import importlib
import inspect
import json
import mimetypes
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
for _path in (str(REPO_ROOT / "src"), str(TOOLS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from agent_store import (  # noqa: E402
    SessionNotFound,
    SessionStore,
    StoreError,
    default_data_dir,
)
from fieldstation.agents import orchestrator  # noqa: E402
from fieldstation.agents.demo_provider import DemoProvider  # noqa: E402

AGENT_VERSION = "1.0.0"
MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 100_000
MAX_TITLE_CHARS = 200
PROVIDERS = ("fake", "openai_compatible", "ollama")
DEFAULT_SETTINGS = {
    "provider": "openai_compatible",
    "base_url": "",
    "model": "",
    "temperature": 0.0,
}
ERROR_CLASSES = ("environment", "input", "execution", "artifact", "capability")


# --------------------------------------------------------------------------
# 错误
# --------------------------------------------------------------------------

class ApiError(Exception):
    """带 HTTP 状态与契约错误类的失败。"""

    def __init__(self, status: int, message: str, error_class: str = "input",
                 *, close: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.error_class = error_class if error_class in ERROR_CLASSES else "execution"
        self.close = close


class _BodyTooLarge(ApiError):
    def __init__(self) -> None:
        super().__init__(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                         f"请求体超过上限 {MAX_BODY_BYTES} 字节", "input",
                         close=True)


class _Approval:
    """一次待决审批。``event`` 被 set 之后 ``decision`` 才有意义。"""

    def __init__(self, approval_id: str, call_id: str) -> None:
        self.approval_id = approval_id
        self.call_id = call_id
        self.event = threading.Event()
        self.decision: str | None = None
        self.note: str = ""


class _RunState:
    """一次运行的可变状态：取消标志与待决审批表。"""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.cancel = threading.Event()
        self.approvals: dict[str, _Approval] = {}
        self.client_gone = False


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _secret_module():
    """延迟 import WP3 的 ``tools/secret_store.py``；不在就返回 None。"""
    try:
        return importlib.import_module("secret_store")
    except Exception:
        return None


def _callable(module, names: tuple[str, ...]):
    for name in names:
        candidate = getattr(module, name, None)
        if callable(candidate):
            return candidate
    return None


def _call_with_key(func, key: str | None):
    """按签名猜调用形状：``fn(key)`` 或 ``fn(name, key)``。

    secret_store 由另一个工作包实现，接口名未冻结；只容忍 ``TypeError``
    （签名不匹配），真正的存储失败要原样抛给调用方 —— 静默吞掉会让用户以为
    key 存进去了。
    """
    if key is None:
        try:
            return func()
        except TypeError:
            return func("openai_api_key")
    try:
        return func(key)
    except TypeError:
        return func("openai_api_key", key)


def _filter_kwargs(func, kwargs: dict) -> dict:
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return {}
    params = signature.parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)
    return {name: value for name, value in kwargs.items() if name in params}


def _load_ollama_config(repo_root: Path) -> dict:
    """``config/providers.json`` 的 ollama 段，``providers.local.json`` 覆盖它。"""
    config: dict = {}
    for name in ("providers.json", "providers.local.json"):
        path = Path(repo_root) / "config" / name
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, dict):
            section = raw.get("providers", raw)
            if isinstance(section, dict):
                ollama = section.get("ollama")
                if isinstance(ollama, dict):
                    config.update(ollama)
    return config


def _source_of(name: str, tool) -> str:
    explicit = getattr(tool, "source", None)
    if isinstance(explicit, str) and explicit:
        return explicit
    if name.startswith("native_"):
        return "native"
    if name.startswith("workflow_"):
        return "rpa"
    return "local"


def _tool_description(tool) -> dict:
    return {
        "name": tool.name,
        "description": getattr(tool, "description", "") or "",
        "risk": getattr(tool, "risk", "medium") or "medium",
        "source": _source_of(tool.name, tool),
        "params": getattr(tool, "params", {}) or {},
    }


# --------------------------------------------------------------------------
# 服务对象
# --------------------------------------------------------------------------

class AgentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, *, store: SessionStore, token: str,
                 repo_root: Path, node_url: str | None,
                 approval_timeout: float = orchestrator.APPROVAL_TIMEOUT_DEFAULT,
                 provider_factory=None, tool_registry=None,
                 registry_factory=None) -> None:
        super().__init__(address, handler)
        self.store = store
        self.token = token
        self.repo_root = Path(repo_root)
        self.node_url = node_url
        self.approval_timeout = float(approval_timeout)
        self.provider_factory = provider_factory
        self.tool_registry = tool_registry
        self.registry_factory = registry_factory
        self.warnings: list[str] = []
        self._warning_set: set[str] = set()
        self._registries: dict[str, object] = {}
        self._registries_lock = threading.RLock()
        self.active_runs: dict[str, _RunState] = {}
        self.runs_lock = threading.RLock()
        self._work_orders = None

    # ---- 工具注册表 ----------------------------------------------------

    def warn(self, message: str) -> None:
        if message in self._warning_set:
            return
        self._warning_set.add(message)
        self.warnings.append(message)
        # 只报模块名/工具名，不带绝对路径。
        sys.stderr.write(f"[agent] {message}\n")
        sys.stderr.flush()

    def registry(self, session_id: str | None):
        key = session_id or ""
        with self._registries_lock:
            cached = self._registries.get(key)
            if cached is not None:
                return cached
        if self.tool_registry is not None:
            registry = self.tool_registry
        elif self.registry_factory is not None:
            registry = self.registry_factory(session_id)
        else:
            registry = orchestrator.build_registry(
                repo_root=self.repo_root,
                data_dir=self.store.data_dir,
                session_id=session_id,
                node_url=self.node_url,
                token=self.token,
                warnings=_WarningSink(self),
                work_order_service=self._work_orders,
            )
        with self._registries_lock:
            self._registries[key] = registry
        return registry

    # ---- 设置与 provider ------------------------------------------------

    def settings(self) -> dict:
        stored = self.store.read_settings()
        merged = dict(DEFAULT_SETTINGS)
        for key in DEFAULT_SETTINGS:
            if key in stored:
                merged[key] = stored[key]
        # 环境变量优先：打包产物里没有「用户在界面上填设置」这一步，
        # 启动器（start.cmd）通过环境变量把后端地址与模型名传进来。
        # 这几条不设就退回 store 里的值，行为不变。
        env_map = {
            "base_url": ("FSA_OPENAI_BASE_URL", "FSA_AGENT_BASE_URL"),
            "model": ("FSA_OPENAI_MODEL", "FSA_AGENT_MODEL"),
            "provider": ("FSA_AGENT_PROVIDER",),
        }
        for field, names in env_map.items():
            for name in names:
                value = (os.environ.get(name) or "").strip()
                if value:
                    merged[field] = value
                    break
        return merged

    def secret_path(self) -> Path:
        """契约固定 key 落在 ``<data_dir>/secrets.bin``（DPAPI 密文）。"""
        return self.store.data_dir / "secrets.bin"

    def has_key(self) -> bool:
        # 环境变量优先级最高：打包产物由 start.cmd 提供密钥，不走 DPAPI 文件。
        if (os.environ.get("FSA_OPENAI_API_KEY") or "").strip():
            return True
        module = _secret_module()
        path = self.secret_path()
        if module is not None:
            checker = _callable(module, ("has_secret",))
            if checker is not None:
                try:
                    return bool(checker(path))
                except Exception:
                    pass
            loader = _callable(module, ("load_secret",))
            if loader is not None:
                try:
                    value = loader(path)
                except Exception:
                    value = None
                if isinstance(value, str) and value.strip():
                    return True
            reader = _callable(module, ("get_api_key", "load_api_key",
                                        "read_api_key", "get_key", "load_key"))
            if reader is not None:
                try:
                    value = _call_with_key(reader, None)
                except Exception:
                    value = None
                if isinstance(value, str) and value.strip():
                    return True
                if isinstance(value, (bytes, bytearray)) and value:
                    return True
        # 模块缺失时只能看文件在不在；能解开与否由 provider 构造时才发现。
        return path.is_file()

    def fallback_active(self) -> bool:
        """配置层面是否一定会回退 fake。

        与 ``resolve_provider`` 分开：``/settings`` 描述的是**配置**，不受测试
        注入的 ``provider_factory`` 影响，否则界面会显示「没有回退」而实际在
        演示模式里跑。
        """
        settings = self.settings()
        name = settings.get("provider") or "fake"
        if name == "fake":
            return False
        if name == "ollama":
            try:
                importlib.import_module("fieldstation.agents.providers.ollama")
            except Exception:
                return True
            return False
        if not (settings.get("base_url") or "").strip():
            return True
        if not (settings.get("model") or "").strip():
            return True
        if not self.has_key():
            return True
        try:
            importlib.import_module("fieldstation.agents.providers.openai_compatible")
        except Exception:
            return True
        return False

    def read_api_key(self) -> str | None:
        # 环境变量优先级最高（打包产物由 start.cmd 注入）。
        env_key = (os.environ.get("FSA_OPENAI_API_KEY") or "").strip()
        if env_key:
            return env_key
        module = _secret_module()
        if module is None:
            return None
        path = self.secret_path()
        loader = _callable(module, ("load_secret",))
        if loader is not None:
            try:
                value = loader(path)
            except Exception:
                return None
        else:
            reader = _callable(module, ("get_api_key", "load_api_key",
                                        "read_api_key", "get_key", "load_key"))
            if reader is None:
                return None
            try:
                value = _call_with_key(reader, None)
            except Exception:
                return None
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    def save_api_key(self, key: str) -> None:
        module = _secret_module()
        if module is None:
            raise ApiError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "secret_store 模块不可用：api_key 需要 WP3 的 tools/secret_store.py（DPAPI）",
                "capability")
        path = self.secret_path()
        writer = _callable(module, ("save_secret",))
        legacy = _callable(module, ("save_api_key", "set_api_key", "save_key",
                                    "set_key", "write_api_key", "save"))
        if writer is None and legacy is None:
            raise ApiError(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "secret_store 没有可用的保存函数（期望 save_secret / save_api_key 之一）",
                "capability")
        try:
            if writer is not None:
                writer(path, key)
            else:
                _call_with_key(legacy, key)
        except ApiError:
            raise
        except Exception as exc:
            raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                           f"api_key 保存失败（{type(exc).__name__}）",
                           "capability") from exc

    def resolve_provider(self):
        """返回 ``(provider, meta)``；构造不出来就回退 fake，并如实标记。"""
        if self.provider_factory is not None:
            produced = self.provider_factory()
            if isinstance(produced, tuple):
                provider, meta = produced
                return provider, dict(meta or {})
            return produced, {"model": getattr(produced, "model", ""),
                              "fake_fallback": False}
        settings = self.settings()
        name = settings.get("provider") or "fake"

        if name == "fake":
            return DemoProvider(model="demo"), {"model": "demo",
                                                "fake_fallback": False}

        if name == "ollama":
            try:
                from fieldstation.agents.providers.base import get_provider

                config = _load_ollama_config(self.repo_root)
                if settings.get("model"):
                    config["model"] = settings["model"]
                return (get_provider("ollama", config),
                        {"model": config.get("model", ""), "fake_fallback": False})
            except Exception as exc:
                return self._fallback(f"ollama 通道不可用（{type(exc).__name__}）")

        base_url = (settings.get("base_url") or "").strip()
        if not base_url:
            return self._fallback("未配置 base_url")
        key = self.read_api_key()
        if not key:
            return self._fallback("未配置 API key")
        try:
            module = importlib.import_module(
                "fieldstation.agents.providers.openai_compatible")
        except Exception as exc:
            return self._fallback(
                f"openai_compatible 模块不可用（{type(exc).__name__}）")
        cls = getattr(module, "OpenAICompatibleProvider", None)
        if not isinstance(cls, type):
            for attr, value in vars(module).items():
                if isinstance(value, type) and attr.endswith("Provider"):
                    cls = value
                    break
        if not isinstance(cls, type):
            return self._fallback("openai_compatible 模块里没有 provider 类")
        model = (settings.get("model") or "").strip()
        if not model:
            return self._fallback("未配置模型名")
        try:
            config = {
                "base_url": base_url,
                "model": model,
                "api_key": key,
                "temperature": settings.get("temperature", 0.0),
            }
            # WP3 的 provider 接收一个 config dict；别的实现可能要好几个关键字参数。
            try:
                parameters = inspect.signature(cls).parameters
            except (TypeError, ValueError):
                parameters = {}
            if "config" in parameters:
                provider = cls(config=config)
            else:
                provider = cls(**_filter_kwargs(cls, config))
        except Exception as exc:
            return self._fallback(
                f"openai_compatible 构造失败（{type(exc).__name__}）")
        return provider, {"model": model, "fake_fallback": False}

    def _fallback(self, reason: str):
        self.warn(f"provider 回退 fake：{reason}")
        return DemoProvider(model="demo"), {"model": "demo",
                                            "fake_fallback": True,
                                            "reason": reason}


class _WarningSink(list):
    """既当列表收集警告，又转发给服务（去重 + 打一行 stderr）。"""

    def __init__(self, server: AgentHTTPServer) -> None:
        super().__init__()
        self._server = server

    def append(self, item) -> None:  # type: ignore[override]
        super().append(item)
        self._server.warn(str(item))


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------

class AgentHandler(BaseHTTPRequestHandler):
    server_version = f"AllPoweredFSA-Agent/{AGENT_VERSION}"
    protocol_version = "HTTP/1.1"

    # 默认实现会把每个请求打到 stderr，里面含路径与查询串；桌面版不需要。
    def log_message(self, fmt, *args):  # noqa: A003
        return

    # ---- 入口 ---------------------------------------------------------

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PATCH(self):
        self._dispatch("PATCH")

    # ---- 分发 ---------------------------------------------------------

    def _dispatch(self, method: str) -> None:
        self._sse_started = False
        try:
            self._authorize()
            parts = self._segments()
            self._route(method, parts)
        except _BodyTooLarge as exc:
            self._send_error(exc, close=True)
        except ApiError as exc:
            self._send_error(exc)
        except SessionNotFound as exc:
            sid = exc.args[0] if exc.args else ""
            self._send_error(ApiError(HTTPStatus.NOT_FOUND,
                                      f"会话不存在：{sid}", "input"))
        except StoreError as exc:
            self._send_error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                                      str(exc), "execution"))
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:  # 兜底：不回栈、不泄路径
            sys.stderr.write(f"[agent] 未处理异常：{type(exc).__name__}\n")
            sys.stderr.flush()
            if not self._sse_started:
                self._send_error(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                                          f"内部错误（{type(exc).__name__}）",
                                          "execution"))
            else:
                self.close_connection = True

    def _segments(self) -> list[str]:
        path = unquote(urlparse(self.path).path)
        # Node 代理理论上会剥前缀；这里再兜一次，免得 /api/agent/health 打到 404。
        if path == "/api/agent":
            path = "/"
        elif path.startswith("/api/agent/"):
            path = path[len("/api/agent"):]
        return [part for part in path.split("/") if part]

    def _authorize(self) -> None:
        header = self.headers.get("Authorization") or ""
        expected = f"Bearer {getattr(self.server, 'token', '')}"
        # 用字节比较：compare_digest 对 str 只接受 ASCII，而请求头可能带任意字节。
        try:
            matched = hmac.compare_digest(header.encode("utf-8", "replace"),
                                          expected.encode("utf-8"))
        except (UnicodeError, TypeError):
            matched = False
        if not matched:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "unauthorized", "capability")

    def _route(self, method: str, parts: list[str]) -> None:
        store: SessionStore = self.server.store

        if parts == ["health"]:
            self._require(method, "GET")
            self._handle_health()
            return
        if parts == ["tools"]:
            self._require(method, "GET")
            self._handle_tools()
            return
        if parts == ["settings"]:
            self._require(method, "GET", "POST")
            if method == "GET":
                self._handle_settings_get()
            else:
                self._handle_settings_post()
            return
        if parts == ["sessions"]:
            self._require(method, "GET", "POST")
            if method == "GET":
                self._send_json(HTTPStatus.OK,
                                {"sessions": store.list_sessions()})
            else:
                self._handle_session_create()
            return
        if len(parts) >= 2 and parts[0] == "sessions":
            sid = parts[1]
            self._check_session_id(sid)
            if len(parts) == 2:
                self._require(method, "GET")
                self._handle_session_detail(sid)
                return
            action = parts[2]
            if len(parts) == 3 and action == "message":
                self._require(method, "POST")
                self._handle_message(sid)
                return
            if len(parts) == 3 and action == "approval":
                self._require(method, "POST")
                self._handle_approval(sid)
                return
            if len(parts) == 3 and action == "cancel":
                self._require(method, "POST")
                self._handle_cancel(sid)
                return
            if len(parts) == 3 and action == "artifacts":
                self._require(method, "GET")
                self._send_json(HTTPStatus.OK,
                                {"artifacts": store.list_artifacts(sid)})
                return
            if len(parts) == 4 and action == "artifacts":
                self._require(method, "GET")
                name = parts[3]
                if not name or "/" in name or "\\" in name or name in (".", ".."):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "产物名非法", "input")
                path = store.artifact_dir(sid, create=False) / name
                if not path.is_file():
                    raise ApiError(HTTPStatus.NOT_FOUND, "产物不存在", "input")
                self._send_file(path, name)
                return
        raise ApiError(HTTPStatus.NOT_FOUND, f"未知路径：/{'/'.join(parts)}",
                       "input")

    def _require(self, method: str, *allowed: str) -> None:
        if method not in allowed:
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED,
                           f"不支持的方法 {method}", "input")

    def _check_session_id(self, session_id: str) -> None:
        if not _valid_session_id(session_id):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"会话 id 非法：{session_id!r}", "input")

    # ---- 读取请求 -----------------------------------------------------

    def _read_json(self) -> dict:
        header = self.headers.get("Content-Length")
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "不支持 chunked 请求体", "input")
        if not header:
            return {}
        try:
            length = int(header)
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length 非法", "input")
        if length < 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Content-Length 非法", "input")
        if length > MAX_BODY_BYTES:
            raise _BodyTooLarge()
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求体不完整", "input")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求体不是合法 JSON", "input")
        if not isinstance(value, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求体必须是 JSON object", "input")
        return value

    # ---- 响应 ---------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if status >= 400:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_file(self, path: Path, name: str) -> None:
        try:
            body = path.read_bytes()
        except OSError as exc:
            raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR,
                           f"产物读不了（{type(exc).__name__}）", "artifact") from exc
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition",
                             f'attachment; filename="{name}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_error(self, exc: ApiError, *, close: bool = False) -> None:
        if self._sse_started:
            self.close_connection = True
            return
        self._send_json(exc.status, {"ok": False, "error": exc.message,
                                     "class": exc.error_class})
        if close or exc.close:
            self.close_connection = True

    # ---- 端点 ---------------------------------------------------------

    def _handle_health(self) -> None:
        provider, meta = self.server.resolve_provider()
        registry = self.server.registry(None)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "version": AGENT_VERSION,
            "provider": getattr(provider, "name", "fake"),
            "model": meta.get("model") or getattr(provider, "model", ""),
            "tools": len(registry.names()),
        })

    def _handle_tools(self) -> None:
        registry = self.server.registry(None)
        tools = [_tool_description(registry.get(name))
                 for name in registry.names()]
        self._send_json(HTTPStatus.OK, {"tools": tools})

    def _handle_session_create(self) -> None:
        body = self._read_json()
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "title 必须是字符串", "input")
        if isinstance(title, str) and len(title) > MAX_TITLE_CHARS:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"title 超过 {MAX_TITLE_CHARS} 字", "input")
        meta = self.server.store.create_session(title)
        self._send_json(HTTPStatus.OK, {"session_id": meta["session_id"]})

    def _handle_session_detail(self, session_id: str) -> None:
        loaded = self.server.store.load(session_id)
        meta = loaded["session"]
        self._send_json(HTTPStatus.OK, {
            "session": {
                "id": meta.get("session_id", session_id),
                "title": meta.get("title", "新会话"),
                "created_at": meta.get("created_at", ""),
                "updated_at": meta.get("updated_at", ""),
            },
            "events": loaded["events"],
        })

    def _handle_settings_get(self) -> None:
        self._send_json(HTTPStatus.OK, self._settings_view())

    def _handle_settings_post(self) -> None:
        body = self._read_json()
        patch: dict = {}

        if "provider" in body:
            provider = body.get("provider")
            if provider not in PROVIDERS:
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               f"provider 必须是 {list(PROVIDERS)} 之一", "input")
            patch["provider"] = provider

        if "base_url" in body:
            base_url = body.get("base_url")
            if not isinstance(base_url, str):
                raise ApiError(HTTPStatus.BAD_REQUEST, "base_url 必须是字符串", "input")
            base_url = base_url.strip()
            if base_url and not base_url.startswith(("http://", "https://")):
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               "base_url 必须以 http:// 或 https:// 开头", "input")
            patch["base_url"] = base_url

        if "model" in body:
            model = body.get("model")
            if not isinstance(model, str) or len(model) > MAX_TITLE_CHARS:
                raise ApiError(HTTPStatus.BAD_REQUEST, "model 必须是字符串", "input")
            patch["model"] = model.strip()

        if "temperature" in body:
            temperature = body.get("temperature")
            if (isinstance(temperature, bool)
                    or not isinstance(temperature, (int, float))
                    or not (0.0 <= float(temperature) <= 2.0)):
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               "temperature 必须是 [0,2] 内的数值", "input")
            patch["temperature"] = float(temperature)

        api_key = body.get("api_key")
        if api_key is not None:
            if not isinstance(api_key, str) or not api_key.strip():
                raise ApiError(HTTPStatus.BAD_REQUEST, "api_key 必须是非空字符串",
                               "input")
            # 先存 key：存不进去就不要留下「设置改了但用不了」的假象。
            self.server.save_api_key(api_key.strip())

        if patch:
            self.server.store.update_settings(patch)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "settings": self._settings_view(),
        })

    def _settings_view(self) -> dict:
        settings = self.server.settings()
        return {
            "provider": settings.get("provider"),
            "base_url": settings.get("base_url"),
            "model": settings.get("model"),
            "temperature": settings.get("temperature"),
            "has_key": bool(self.server.has_key()),
            "fake_fallback": bool(self.server.fallback_active()),
        }

    # ---- 运行 ---------------------------------------------------------

    def _handle_message(self, session_id: str) -> None:
        store: SessionStore = self.server.store
        if not store.exists(session_id):
            raise ApiError(HTTPStatus.NOT_FOUND, f"会话不存在：{session_id}", "input")
        body = self._read_json()
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ApiError(HTTPStatus.BAD_REQUEST, "text 必须是非空字符串", "input")
        if len(text) > MAX_TEXT_CHARS:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           f"text 超过 {MAX_TEXT_CHARS} 字符", "input")
        attachments = body.get("attachments")
        if attachments is not None and not isinstance(attachments, list):
            raise ApiError(HTTPStatus.BAD_REQUEST, "attachments 必须是数组", "input")

        state = _RunState(session_id)
        with self.server.runs_lock:
            if session_id in self.server.active_runs:
                raise ApiError(HTTPStatus.CONFLICT,
                               "该会话已有运行中的任务，请先取消或等待结束",
                               "execution")
            self.server.active_runs[session_id] = state

        try:
            provider, _ = self.server.resolve_provider()
            registry = self.server.registry(session_id)
        except BaseException:
            # 任何失败都要把「会话忙」标记撤掉，否则这个会话再也发不出消息。
            with self.server.runs_lock:
                self.server.active_runs.pop(session_id, None)
            raise

        self._start_sse()
        emit = self._sse_emitter(state)
        wait_decision = self._approval_waiter(state)
        try:
            orchestrator.run_session(
                session_id, text,
                emit=emit,
                provider=provider,
                registry=registry,
                approval_timeout=self.server.approval_timeout,
                wait_decision=wait_decision,
                cancel_event=state.cancel,
                attachments=attachments,
            )
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:
            if not state.client_gone:
                try:
                    emit({"type": "error", "class": "execution",
                          "message": f"运行失败（{type(exc).__name__}）"})
                except Exception:
                    pass
        finally:
            with self.server.runs_lock:
                self.server.active_runs.pop(session_id, None)
            self._finish_sse(session_id)

    def _start_sse(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        self._sse_started = True
        try:
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _sse_emitter(self, state: _RunState):
        store: SessionStore = self.server.store

        def emit(event: dict) -> None:
            # 先落盘：客户端断开时，会话文件里依然要有完整的一轮。
            stored = store.append_event(state.session_id, event)
            if (stored.get("type") == "approval"
                    and stored.get("status") == "pending"):
                state.approvals[str(stored.get("id"))] = _Approval(
                    str(stored.get("id")), str(stored.get("call_id", "")))
            if state.client_gone:
                return
            try:
                payload = json.dumps(stored, ensure_ascii=False)
                self.wfile.write(
                    f"event: agent\ndata: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                state.client_gone = True

        return emit

    def _approval_waiter(self, state: _RunState):
        def wait_decision(approval_id: str, timeout: float) -> str:
            slot = state.approvals.get(approval_id)
            if slot is None:
                return "rejected"
            deadline = time.monotonic() + max(0.0, float(timeout))
            while True:
                if slot.event.wait(0.05):
                    return slot.decision or "rejected"
                if state.cancel.is_set():
                    return "cancelled"
                if time.monotonic() >= deadline:
                    return "timeout"

        return wait_decision

    def _finish_sse(self, session_id: str) -> None:
        try:
            payload = json.dumps({"type": "done", "session_id": session_id},
                                 ensure_ascii=False)
            self.wfile.write(f"event: done\ndata: {payload}\n\n".encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def _handle_approval(self, session_id: str) -> None:
        if not self.server.store.exists(session_id):
            raise ApiError(HTTPStatus.NOT_FOUND, f"会话不存在：{session_id}", "input")
        body = self._read_json()
        approval_id = body.get("approval_id")
        decision = body.get("decision")
        if not isinstance(approval_id, str) or not approval_id:
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "approval_id 必须是非空字符串", "input")
        if decision not in ("approved", "rejected"):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "decision 必须是 approved 或 rejected", "input")
        note = body.get("note", "")
        if note is not None and not isinstance(note, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "note 必须是字符串", "input")

        state = self.server.active_runs.get(session_id)
        if state is None:
            raise ApiError(HTTPStatus.CONFLICT, "当前没有等待审批的运行", "execution")
        slot = state.approvals.get(approval_id)
        if slot is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "审批请求不存在", "input")
        if slot.event.is_set():
            raise ApiError(HTTPStatus.CONFLICT, "审批已经决定过了", "execution")
        slot.note = note or ""
        slot.decision = decision
        slot.event.set()
        self._send_json(HTTPStatus.OK, {"ok": True, "approval_id": approval_id,
                                        "decision": decision})

    def _handle_cancel(self, session_id: str) -> None:
        if not self.server.store.exists(session_id):
            raise ApiError(HTTPStatus.NOT_FOUND, f"会话不存在：{session_id}", "input")
        self._read_json()
        state = self.server.active_runs.get(session_id)
        if state is None:
            self._send_json(HTTPStatus.OK, {"ok": True, "cancelled": False})
            return
        state.cancel.set()
        for slot in list(state.approvals.values()):
            if not slot.event.is_set():
                slot.decision = "cancelled"
                slot.note = "运行已取消"
                slot.event.set()
        self._send_json(HTTPStatus.OK, {"ok": True, "cancelled": True})


def _valid_session_id(value: str) -> bool:
    from agent_store import is_valid_session_id

    return is_valid_session_id(value)


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------

def make_server(*, port: int = 0, token: str,
                node_url: str | None = None,
                repo_root: str | Path | None = None,
                data_dir: str | Path | None = None,
                approval_timeout: float = orchestrator.APPROVAL_TIMEOUT_DEFAULT,
                provider_factory=None, tool_registry=None,
                registry_factory=None) -> AgentHTTPServer:
    """创建一个已绑定端口的服务（不阻塞）。``port=0`` 由系统挑端口。"""
    if not isinstance(token, str) or not token:
        raise ValueError("token 不能为空")
    store = SessionStore(data_dir)
    store.ensure_dirs()
    server = AgentHTTPServer(
        ("127.0.0.1", int(port)), AgentHandler,
        store=store, token=token,
        repo_root=Path(repo_root) if repo_root else REPO_ROOT,
        node_url=node_url,
        approval_timeout=approval_timeout,
        provider_factory=provider_factory,
        tool_registry=tool_registry,
        registry_factory=registry_factory)
    return server


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent_server.py",
        description="All powered-FSA 桌面版 Agent 本地服务（只监听 127.0.0.1）")
    parser.add_argument("--port", type=int, default=0,
                        help="监听端口；0 = 由系统分配（默认）")
    parser.add_argument("--token", required=True,
                        help="Bearer token；由壳生成后传入")
    parser.add_argument("--node-url", default=None,
                        help="Node 服务地址，例如 http://127.0.0.1:12345")
    parser.add_argument("--repo", default=str(REPO_ROOT),
                        help="仓库根目录（读 config/ 与 workflows/）")
    parser.add_argument("--data-dir", default=None,
                        help="数据目录；默认 %%LOCALAPPDATA%%\\AllPoweredFSA")
    parser.add_argument("--approval-timeout", type=float,
                        default=orchestrator.APPROVAL_TIMEOUT_DEFAULT,
                        help="审批等待秒数；超时按拒绝处理（默认 600）")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    data_dir = args.data_dir or default_data_dir()
    try:
        server = make_server(
            port=args.port, token=args.token, node_url=args.node_url,
            repo_root=args.repo, data_dir=data_dir,
            approval_timeout=args.approval_timeout)
    except OSError as exc:
        sys.stderr.write(f"[agent] 端口绑定失败（{type(exc).__name__}）\n")
        return 2
    port = server.server_address[1]
    sys.stdout.write(f"AGENT_READY {port}\n")
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
