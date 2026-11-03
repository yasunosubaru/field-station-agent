#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌面版 Agent 的本地存储（WP2）：会话 JSONL、产物目录与 ``settings.json``。

契约见 ``docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md`` §6：

```text
<data_dir>/
  sessions/<id>.jsonl     第一行 meta，之后一行一个事件
  artifacts/<id>/         该会话的产物
  settings.json           provider / base_url / model / temperature
```

设计决定（非事实断言）：

* **只用标准库**，也**不碰** ``secrets.bin``（DPAPI 由 WP3 的
  ``tools/secret_store.py`` 负责）。本模块只管能被任何人读的普通文件。
* **落盘一律原子**：先写同目录临时文件、``fsync``、再 ``os.replace``。
  直接覆盖原文件的写法在断电/被杀进程时会留下半截 JSON —— 那正是会话恢复
  最需要的时刻。
* **追加事件不重写整文件**：一行一次 ``write`` + ``flush`` + ``fsync``，
  省掉「读全文件再写回」的放大成本；改名/删除才重写。
* **会话 id 是文件名**，所以必须先过白名单校验。``..``、斜杠、盘符一律拒绝：
  一个能穿越目录的 id 等于把整个数据目录交给调用方。
* **线程锁在实例上**：HTTP 服务是多线程的，两个线程同时追加同一会话时，
  没有锁就可能把两行拼成一行，之后谁也解析不出来。
* 时间戳统一为 UTC ISO 8601（微秒精度、带 ``+00:00``），字符串序即时间序，
  列表排序不必再解析。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

APP_DIR_NAME = "AllPoweredFSA"
ENV_DATA_DIR = "ALLPOWEREDFSA_DATA_DIR"
DEFAULT_SESSION_TITLE = "新会话"
MAX_TITLE_CHARS = 200

#: 会话 id 同时是文件名，字符集收到最窄。长度上限挡住超长文件名。
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: 产物类型按后缀猜；猜不到就是 ``file``（契约里的 kind 只列了 pdf/csv/json/png/html）。
KIND_BY_SUFFIX = {
    ".pdf": "pdf",
    ".csv": "csv",
    ".json": "json",
    ".png": "png",
    ".html": "html",
    ".htm": "html",
}

_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def utc_now_iso() -> str:
    """当前 UTC 时间的 ISO 8601 字符串。排序可比、解析无歧义。"""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def default_data_dir() -> Path:
    """默认数据目录：``%LOCALAPPDATA%\\AllPoweredFSA``。

    顺序：``ALLPOWEREDFSA_DATA_DIR`` 环境变量 → ``LOCALAPPDATA`` → 家目录。
    环境变量优先，是为了让测试和绿色版能把数据放到别处而不改代码。
    """
    override = os.environ.get(ENV_DATA_DIR, "").strip()
    if override:
        return Path(override).expanduser()
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        return Path(local) / APP_DIR_NAME
    return Path.home() / ".local" / "share" / APP_DIR_NAME


def is_valid_session_id(value) -> bool:
    return isinstance(value, str) and bool(SESSION_ID_RE.fullmatch(value))


def new_session_id() -> str:
    """生成会话 id：``s`` + 12 位十六进制。

    不用自增序号：会话会被删除，序号会重用，重用的 id 会让旧链接指向新会话。
    """
    return f"s{uuid.uuid4().hex[:12]}"


def safe_filename(name: str) -> str:
    """把任意名字收成一个安全的单段文件名（不含目录）。

    Windows 的保留名（``CON``、``NUL`` 等）也一并改名 —— 在那里创建这样的
    文件会静默失败或写到设备上。
    """
    raw = str(name or "").strip()
    # 先砍掉调用方可能带来的路径成分，两种分隔符都认。
    base = raw.replace("\\", "/").rsplit("/", 1)[-1]
    base = _UNSAFE_FILENAME_RE.sub("_", base).strip(" .")
    if not base:
        base = "artifact"
    stem = base.split(".", 1)[0].upper()
    if stem in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(r"COM[1-9]|LPT[1-9]", stem):
        base = f"_{base}"
    return base[:120]


class SessionNotFound(KeyError):
    """会话不存在。HTTP 层据此回 404，而不是当成内部错误。"""


class StoreError(RuntimeError):
    """存储层失败（文件损坏、写入失败等）。"""


def _atomic_replace(path: Path, data: bytes) -> None:
    """同目录临时文件 + ``os.replace``；失败也不留半截目标文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def _dumps_line(event: dict) -> str:
    """一行一个事件：紧凑分隔符，避免文件里出现无意义空白。"""
    try:
        body = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise StoreError(f"事件无法序列化为 JSON：{exc}") from exc
    return body + "\n"


class SessionStore:
    """一个数据目录的读写门面。所有方法都以会话 id 为第一参数。"""

    def __init__(self, data_dir: str | os.PathLike | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else default_data_dir()
        self._lock = threading.RLock()

    # ---- 路径 ---------------------------------------------------------

    @property
    def data_dir(self) -> Path:
        return self._data_dir

    @property
    def sessions_dir(self) -> Path:
        return self._data_dir / "sessions"

    @property
    def artifacts_root(self) -> Path:
        return self._data_dir / "artifacts"

    @property
    def settings_path(self) -> Path:
        return self._data_dir / "settings.json"

    @property
    def exports_dir(self) -> Path:
        return self._data_dir / "exports"

    def ensure_dirs(self) -> None:
        """建好目录树。第一次启动时由服务调用；每次写入也会各自补建。"""
        with self._lock:
            for path in (self._data_dir, self.sessions_dir,
                         self.artifacts_root, self.exports_dir):
                path.mkdir(parents=True, exist_ok=True)

    def session_path(self, session_id: str) -> Path:
        if not is_valid_session_id(session_id):
            raise ValueError(f"会话 id 非法：{session_id!r}")
        return self.sessions_dir / f"{session_id}.jsonl"

    def artifact_dir(self, session_id: str, *, create: bool = True) -> Path:
        if not is_valid_session_id(session_id):
            raise ValueError(f"会话 id 非法：{session_id!r}")
        path = self.artifacts_root / session_id
        if create:
            path.mkdir(parents=True, exist_ok=True)
        return path

    # ---- 会话 ---------------------------------------------------------

    def create_session(self, title: str | None = None,
                       session_id: str | None = None) -> dict:
        """新建会话并写 meta 首行，返回 meta 内容。"""
        sid = session_id or new_session_id()
        if not is_valid_session_id(sid):
            raise ValueError(f"会话 id 非法：{sid!r}")
        clean_title = _clean_title(title) or DEFAULT_SESSION_TITLE
        meta = {
            "type": "meta",
            "session_id": sid,
            "title": clean_title,
            "created_at": utc_now_iso(),
        }
        with self._lock:
            path = self.session_path(sid)
            if path.exists():
                raise StoreError(f"会话已存在：{sid}")
            self.ensure_dirs()
            _atomic_replace(path, _dumps_line(meta).encode("utf-8"))
        return dict(meta)

    def exists(self, session_id: str) -> bool:
        return is_valid_session_id(session_id) and self.session_path(session_id).is_file()

    def _load_lines(self, session_id: str) -> list[dict]:
        path = self.session_path(session_id)
        if not path.is_file():
            raise SessionNotFound(session_id)
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise StoreError(f"会话文件读取失败：{exc}") from exc
        events: list[dict] = []
        for lineno, line in enumerate(raw.splitlines(), 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise StoreError(
                    f"会话 {session_id} 第 {lineno} 行不是合法 JSON：{exc.msg}") from exc
            if not isinstance(value, dict):
                raise StoreError(f"会话 {session_id} 第 {lineno} 行不是 JSON object")
            events.append(value)
        if not events or events[0].get("type") != "meta":
            raise StoreError(f"会话 {session_id} 缺少 meta 首行")
        return events

    def read_meta(self, session_id: str) -> dict:
        events = self._load_lines(session_id)
        meta = dict(events[0])
        meta.setdefault("session_id", session_id)
        meta.setdefault("title", DEFAULT_SESSION_TITLE)
        meta["updated_at"] = _last_timestamp(events)
        return meta

    def load(self, session_id: str) -> dict:
        """返回 ``{session: {...}, events: [...]}``；events 不含 meta 首行。"""
        with self._lock:
            events = self._load_lines(session_id)
            meta = dict(events[0])
            meta.setdefault("session_id", session_id)
            meta.setdefault("title", DEFAULT_SESSION_TITLE)
            meta["updated_at"] = _last_timestamp(events)
            return {"session": meta, "events": events[1:]}

    def read_events(self, session_id: str) -> list[dict]:
        return self.load(session_id)["events"]

    def append_event(self, session_id: str, event: dict) -> dict:
        """追加一个事件，返回落盘后的副本（补齐 ``ts``）。

        事件必须带非空 ``type``；``id`` 唯一性是调用方的责任（服务层用
        随机后缀生成）。这里不静默改写 id —— 改了就没人能追回原始通知。
        """
        if not isinstance(event, dict):
            raise ValueError("事件必须是 JSON object")
        etype = event.get("type")
        if not isinstance(etype, str) or not etype.strip():
            raise ValueError("事件缺少 type")
        if etype == "meta":
            raise ValueError("meta 只能由 create_session 写入首行")
        stored = dict(event)
        stored.setdefault("ts", utc_now_iso())
        line = _dumps_line(stored)
        with self._lock:
            path = self.session_path(session_id)
            if not path.is_file():
                raise SessionNotFound(session_id)
            try:
                with open(path, "a", encoding="utf-8", newline="\n") as fh:
                    fh.write(line)
                    fh.flush()
                    os.fsync(fh.fileno())
            except OSError as exc:
                raise StoreError(f"事件写入失败：{exc}") from exc
        return stored

    def list_sessions(self) -> list[dict]:
        """按 ``updated_at`` 倒序列出会话；坏文件跳过而不是让整页 500。"""
        out: list[dict] = []
        with self._lock:
            if not self.sessions_dir.is_dir():
                return []
            for path in self.sessions_dir.glob("*.jsonl"):
                sid = path.stem
                if not is_valid_session_id(sid):
                    continue
                try:
                    events = self._load_lines(sid)
                except (SessionNotFound, StoreError, ValueError):
                    continue
                meta = events[0]
                out.append({
                    "id": sid,
                    "title": meta.get("title") or DEFAULT_SESSION_TITLE,
                    "updated_at": _last_timestamp(events),
                })
        out.sort(key=lambda item: item["updated_at"], reverse=True)
        return out

    def rename_session(self, session_id: str, title: str) -> dict:
        """只改 meta 首行的标题；事件一行不动。"""
        clean_title = _clean_title(title)
        if not clean_title:
            raise ValueError("标题不能为空")
        with self._lock:
            events = self._load_lines(session_id)  # 顺带校验存在
            events[0]["title"] = clean_title
            body = "".join(_dumps_line(event) for event in events)
            path = self.session_path(session_id)
            _atomic_replace(path, body.encode("utf-8"))
            meta = dict(events[0])
            meta["updated_at"] = _last_timestamp(events)
            return meta

    def delete_session(self, session_id: str) -> None:
        """删会话文件与它的产物目录。``SessionNotFound`` 用于 404。"""
        with self._lock:
            path = self.session_path(session_id)
            if not path.is_file():
                raise SessionNotFound(session_id)
            try:
                path.unlink()
            except OSError as exc:
                raise StoreError(f"会话删除失败：{exc}") from exc
            artifacts = self.artifacts_root / session_id
            if artifacts.is_dir():
                try:
                    shutil.rmtree(artifacts)
                except OSError as exc:
                    raise StoreError(f"产物目录删除失败：{exc}") from exc

    # ---- 产物 ---------------------------------------------------------

    def write_artifact(self, session_id: str, filename: str, data: bytes,
                       *, kind: str | None = None) -> dict:
        """把字节写进 ``artifacts/<sid>/``，返回可直接塞进 artifact 事件的描述。"""
        if not self.exists(session_id):
            raise SessionNotFound(session_id)
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            raise ValueError("产物内容必须是 bytes")
        name = safe_filename(filename)
        payload = bytes(data)
        with self._lock:
            target = self.artifact_dir(session_id) / name
            _atomic_replace(target, payload)
        return {
            "name": name,
            "kind": kind or _kind_for(name),
            "path": f"artifacts/{session_id}/{name}",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "created_at": utc_now_iso(),
        }

    def list_artifacts(self, session_id: str) -> list[dict]:
        """列出产物；``path`` 是相对数据目录的 POSIX 形式，不回显绝对路径。"""
        if not self.exists(session_id):
            raise SessionNotFound(session_id)
        directory = self.artifacts_root / session_id
        if not directory.is_dir():
            return []
        items: list[dict] = []
        for path in sorted(directory.iterdir(), key=lambda p: p.name):
            if not path.is_file():
                continue
            try:
                data = path.read_bytes()
            except OSError as exc:
                raise StoreError(f"产物读取失败：{exc}") from exc
            items.append({
                "name": path.name,
                "kind": _kind_for(path.name),
                "path": f"artifacts/{session_id}/{path.name}",
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "created_at": datetime.fromtimestamp(
                    path.stat().st_mtime, timezone.utc
                ).isoformat(timespec="microseconds"),
            })
        return items

    # ---- 设置 ---------------------------------------------------------

    def read_settings(self) -> dict:
        """读 ``settings.json``；不存在返回 ``{}``。

        内容损坏抛 ``StoreError`` —— 把坏文件当空设置会让下一次保存把用户的
        配置悄悄覆盖掉。
        """
        with self._lock:
            path = self.settings_path
            if not path.is_file():
                return {}
            try:
                raw = path.read_text(encoding="utf-8")
            except OSError as exc:
                raise StoreError(f"设置读取失败：{exc}") from exc
            try:
                value = json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError as exc:
                raise StoreError(f"settings.json 不是合法 JSON：{exc.msg}") from exc
            if not isinstance(value, dict):
                raise StoreError("settings.json 顶层必须是 JSON object")
            return value

    def write_settings(self, settings: dict) -> dict:
        """整体替换 ``settings.json``（原子写）。"""
        if not isinstance(settings, dict):
            raise ValueError("设置必须是 JSON object")
        with self._lock:
            self.ensure_dirs()
            body = json.dumps(settings, ensure_ascii=False, indent=2,
                              sort_keys=True) + "\n"
            _atomic_replace(self.settings_path, body.encode("utf-8"))
        return dict(settings)

    def update_settings(self, patch: dict) -> dict:
        """按键合并进现有设置，返回合并结果。"""
        if not isinstance(patch, dict):
            raise ValueError("设置补丁必须是 JSON object")
        with self._lock:
            merged = self.read_settings()
            merged.update(patch)
            return self.write_settings(merged)


def _clean_title(title) -> str:
    if title is None:
        return ""
    if not isinstance(title, str):
        raise ValueError("标题必须是字符串")
    return title.strip()[:MAX_TITLE_CHARS]


def _kind_for(filename: str) -> str:
    return KIND_BY_SUFFIX.get(Path(filename).suffix.lower(), "file")


def _last_timestamp(events: list[dict]) -> str:
    """最后一条带 ``ts`` 的事件的时刻；一个都没有就用 meta 的 ``created_at``。"""
    for event in reversed(events):
        ts = event.get("ts")
        if isinstance(ts, str) and ts.strip():
            return ts
    created = events[0].get("created_at")
    return created if isinstance(created, str) and created else utc_now_iso()
