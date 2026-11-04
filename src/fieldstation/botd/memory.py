"""E2 botd 记忆：SQLite 主存 + 可选 Chroma / Letta 适配器接口。

设计取舍：**SQLite 永远是事实来源**。外部记忆（Chroma 向量库、Letta 的
memory blocks）只是加速层/共享层：

* 没装、没启动、鉴权失败、接口不兼容 —— 任何一种都不许把 ``recall`` 变成异常。
  降级时结果里带 ``degraded=True`` 与原因，调用方能看见"这次是本地朴素匹配"，
  而不是误以为向量检索生效了；
* 外部适配器只有**接口**（``available`` / ``remember`` / ``recall``），
  真正接上时按协议实现即可，``BotMemory`` 的调用点不用改；
* 朴素召回用标准库：英文按词、中文按二字/三字片段打分。它不追求语义，
  只保证离线可用、结果可解释（分数能算出来，不依赖模型）。

"降级并标记"落在两处：内存里的 ``degraded`` / ``degraded_reason``，以及
写入行的 ``backend`` 字段（``local`` / ``chroma`` / ``local-fallback``）。
"""
from __future__ import annotations

import importlib.util
import re
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple

from .store import BotStore

#: 适配器名 → 需要探测的模块名。只探测，不 import：import chromadb 会拉起
#: 一堆重依赖，在"只是想知道它在不在"的路径上不值得。
EXTERNAL_PROVIDERS: Dict[str, str] = {
    "chroma": "chromadb",
    "letta": "letta",
}

_TOKEN_SPLIT = re.compile(r"[^0-9A-Za-z_\u4e00-\u9fff]+")


class MemoryBackend(Protocol):
    """外部记忆适配器协议。实现方负责把异常收在自己的边界内。"""

    name: str

    def available(self) -> bool:
        ...  # pragma: no cover - 协议声明

    def remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Sequence[str] = (),
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Optional[str]:
        ...  # pragma: no cover - 协议声明

    def recall(self, bot_id: str, query: str, limit: int = 5) -> List[dict]:
        ...  # pragma: no cover - 协议声明


def probe_external() -> Dict[str, bool]:
    """探测外部记忆模块是否可导入（不真正 import）。"""
    found: Dict[str, bool] = {}
    for name, module in EXTERNAL_PROVIDERS.items():
        try:
            found[name] = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError, AttributeError):
            found[name] = False
    return found


class ExternalMemoryBackend:
    """外部适配器占位实现：只做可用性探测，写入/召回显式未实现。

    真正接入时子类化它并覆盖 ``remember`` / ``recall``；基类故意抛
    ``NotImplementedError``，让"看起来接上了其实没有"在第一次调用时就暴露。
    """

    name = "external"
    requires = ""

    def __init__(self) -> None:
        self.reason = ""

    def available(self) -> bool:
        if not self.requires:
            self.reason = "适配器未声明 requires 模块"
            return False
        try:
            present = importlib.util.find_spec(self.requires) is not None
        except (ImportError, ValueError) as exc:
            self.reason = f"探测 {self.requires} 失败：{exc}"
            return False
        if not present:
            self.reason = f"未安装 {self.requires}"
        return present

    def remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Sequence[str] = (),
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Optional[str]:
        raise NotImplementedError(f"{self.name} 记忆适配器尚未实现写入")

    def recall(self, bot_id: str, query: str, limit: int = 5) -> List[dict]:
        raise NotImplementedError(f"{self.name} 记忆适配器尚未实现召回")


class ChromaBackend(ExternalMemoryBackend):
    name = "chroma"
    requires = "chromadb"


class LettaBackend(ExternalMemoryBackend):
    name = "letta"
    requires = "letta"


def _available(backend: Any) -> Tuple[bool, str]:
    if backend is None:
        return False, "未指定外部记忆后端"
    try:
        checker = getattr(backend, "available", None)
        ok = bool(checker()) if callable(checker) else True
    except Exception as exc:  # noqa: BLE001 - 探测本身不允许把调用方拖崩
        return False, f"{type(backend).__name__}.available() 失败：{exc}"
    if ok:
        return True, ""
    return False, str(getattr(backend, "reason", "") or "外部记忆后端报告不可用")


def _backend_name(backend: Any) -> str:
    return str(getattr(backend, "name", type(backend).__name__))


def _terms(text: str) -> List[str]:
    """把查询切成可解释的关键词：英文/数字整词，中文二/三字片段。

    中文不装分词器是刻意的：装 jieba 会引入依赖，而这里只需要"能不能命中"，
    不需要词性。二字片段（以及整段 ≤3 字）足以覆盖"电池 电压 过低"这类查询。
    """
    lowered = str(text or "").lower()
    terms: List[str] = []
    for chunk in _TOKEN_SPLIT.split(lowered):
        if not chunk:
            continue
        if chunk.isascii():
            terms.append(chunk)
            continue
        if len(chunk) <= 3:
            terms.append(chunk)
            continue
        # 中文长串：二字片段 + 三字片段，允许重叠。
        terms.extend(chunk[i:i + 2] for i in range(len(chunk) - 1))
        terms.extend(chunk[i:i + 3] for i in range(len(chunk) - 2))
    # 保序去重：打分时同一个词只按一次权重算，避免短查询被重复片段放大。
    return list(dict.fromkeys(terms))


def _score(content: str, key: str, tags: Sequence[str], query: str) -> float:
    terms = _terms(query)
    if not terms:
        return 0.0
    haystack = content.lower()
    key_text = (key or "").lower()
    tag_text = " ".join(str(tag) for tag in tags).lower()
    score = 0.0
    for term in terms:
        occurrences = haystack.count(term)
        if occurrences:
            score += 1.0 + 0.25 * (occurrences - 1)  # 多次命中略微加权，但不刷分
        if key_text and term in key_text:
            score += 0.75
        if tag_text and term in tag_text:
            score += 0.5
    phrase = "".join(str(query or "").lower().split())
    if phrase and phrase in "".join(haystack.split()):
        score += 2.0
    return round(score, 4)


class BotMemory:
    """机器人记忆门面：写库、召回、外部后端降级。"""

    def __init__(
        self,
        store: BotStore,
        *,
        backend: Optional[Any] = None,
        limit: int = 5,
    ) -> None:
        if int(limit) < 1:
            raise ValueError("limit 至少为 1")
        self.store = store
        self.limit = int(limit)
        self.backend = backend
        self.degraded = False
        self.degraded_reason = ""
        if backend is not None:
            ok, reason = _available(backend)
            if not ok:
                self._degrade(reason)

    # -------------------------------------------------------------- 状态 --
    def _degrade(self, reason: str) -> None:
        self.degraded = True
        if reason:
            self.degraded_reason = reason

    @property
    def backend_name(self) -> str:
        return _backend_name(self.backend) if self.backend is not None else "local"

    def status(self) -> Dict[str, Any]:
        return {
            "backend": self.backend_name,
            "available": self.backend is not None and not self.degraded,
            "degraded": self.degraded,
            "reason": self.degraded_reason,
            "external": probe_external(),
        }

    # -------------------------------------------------------------- 写入 --
    def remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Optional[Sequence[str]] = None,
        source: str = "manual",
        metadata: Optional[Mapping[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        """写一条记忆。本地一定写成功；外部镜像失败只降级，不抛异常。"""
        tag_list = [str(tag) for tag in (tags or [])]
        backend_label = "local"
        external_id: Optional[str] = None
        if self.backend is not None and not self.degraded:
            try:
                external_id = self.backend.remember(
                    bot_id,
                    content,
                    key=key,
                    tags=tag_list,
                    metadata=dict(metadata or {}),
                )
                backend_label = self.backend_name
            except Exception as exc:  # noqa: BLE001 - 外部失败必须降级
                self._degrade(f"{self.backend_name} 写入失败：{exc}")
                backend_label = "local-fallback"
        row = self.store.add_memory(
            bot_id,
            content,
            key=key,
            tags=tag_list,
            source=source,
            backend=backend_label,
            now=now,
        )
        row["degraded"] = self.degraded
        row["external_id"] = external_id
        return row

    # -------------------------------------------------------------- 召回 --
    def recall(
        self,
        bot_id: str,
        query: str,
        *,
        limit: Optional[int] = None,
    ) -> List[dict]:
        """按关键词打分召回；外部后端可用时先问它，失败则本地兜底。"""
        size = int(limit if limit is not None else self.limit)
        if size < 1:
            raise ValueError("limit 至少为 1")
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("bot_id 必须是非空字符串")

        if self.backend is not None and not self.degraded:
            try:
                external = self.backend.recall(bot_id, query, size)
                if external:
                    results = []
                    for item in external:
                        row = dict(item)
                        row.setdefault("backend", self.backend_name)
                        row["degraded"] = False
                        results.append(row)
                    return results[:size]
            except Exception as exc:  # noqa: BLE001 - 外部失败必须降级
                self._degrade(f"{self.backend_name} 召回失败：{exc}")

        rows = self.store.list_memory(bot_id)
        scored: List[dict] = []
        for row in rows:
            value = _score(row["content"], row.get("key", ""), row["tags"], query)
            if _terms(query) and value <= 0:
                continue
            item = dict(row)
            item["score"] = value
            item["degraded"] = self.degraded
            item["backend"] = "local-fallback" if self.degraded else row["backend"]
            scored.append(item)

        # 分数高的在前；同分时新写入的在前，再同则按 id 稳定排序。
        scored.sort(
            key=lambda item: (item["score"], item["updated_at"], item["id"]),
            reverse=True,
        )
        return scored[:size]

    # -------------------------------------------------------------- 其它 --
    def forget(self, bot_id: str, key: str) -> bool:
        """按 key 删除一条记忆；不存在返回 False。"""
        for row in self.store.list_memory(bot_id):
            if row["key"] == key:
                return self.store.delete_memory(row["id"])
        return False

    def list(self, bot_id: str, *, limit: int = 50) -> List[dict]:
        rows = self.store.list_memory(bot_id)
        return rows[-int(limit):] if limit else rows
