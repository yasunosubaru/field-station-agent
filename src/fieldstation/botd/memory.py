"""E2 botd 记忆：SQLite 主存 + 可选 Chroma / Letta 适配器接口。

设计取舍：**SQLite 永远是事实来源**。外部记忆（Chroma 向量库、Letta 的
memory blocks）只是加速层/共享层：

* 没装、没启动、鉴权失败、接口不兼容 —— 任何一种都不许把 ``recall`` 变成异常。
  降级时结果里带 ``degraded=True`` 与 ``note``（原因），调用方能看见"这次是本地
  朴素匹配"，而不是误以为向量检索生效了；
* 外部适配器有统一接口（``available`` / ``remember`` / ``recall``），降级语义写在
  基类 :class:`ExternalMemoryBackend` 里**只写一遍**；子类只实现远程原语
  ``_write`` / ``_search``，``BotMemory`` 的调用点不用改；
* **Letta 是真的接了**：:class:`LettaBackend` 就是 :mod:`fieldstation.botd.letta`
  里那份实现（归档 passage + 核心记忆块），``memory.py`` 不再维护第二套；
  Chroma 仍是占位（``_write`` / ``_search`` 未实现），第一次调用就抛
  ``NotImplementedError``，不许"看着接上了其实没接"；
* 朴素召回用标准库：英文按词、中文按二字/三字片段打分。它不追求语义，
  只保证离线可用、结果可解释（分数能算出来，不依赖模型）。

"降级并标记"落在四处，调用方任取一处都能看见，不存在"静默成功"：

* 内存里的 ``degraded`` / ``degraded_reason``（门面状态）；
* 写入行的 ``backend`` 字段（``local`` / ``letta`` / ``local-fallback``）；
* 每条结果的 ``degraded`` 布尔与 ``note`` 文本（人看得懂的一句话）；
* 首尾两个入口的 ``memory_missing`` 标记。
"""
from __future__ import annotations

import importlib.util
import re
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple

from .letta import CALL_TIMEOUT_S, LettaClientBackend
from .store import BotStore

#: 适配器名 → 需要探测的模块名。只探测，不 import：import chromadb 会拉起
#: 一堆重依赖，在"只是想知道它在不在"的路径上不值得。
#:
#: ``letta`` 探的是 **HTTP 客户端** ``letta_client``，不是 78 MB 的服务端
#: ``letta`` 包 —— 前者才是本适配器的依赖，理由见 ``letta.py`` 的模块 docstring。
EXTERNAL_PROVIDERS: Dict[str, str] = {
    "chroma": "chromadb",
    "letta": "letta_client",
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


class BackendUnavailable(RuntimeError):
    """外部记忆后端不可用。**这是一次已经发生的降级，不是程序 bug。**

    为什么要有这个类型，而不是让适配器自己悄悄写本地：

    * 本地 SQLite 的写入只能有**一个作者**。适配器和 :class:`BotMemory` 都写，
      ``key`` 为空时就会留下两行内容相同的记忆 —— 召回时看起来像"重复记录"，
      实际是两次写；
    * 所以"没有注入 store 的适配器"只负责**报告不可用**，落本地由门面负责，
      门面在写完之后把 ``backend`` 标成 ``local-fallback`` 并给出 ``note``。

    继承 ``RuntimeError`` 是为了让"``except Exception`` 一把兜住"的既有调用方
    不必改代码。
    """


class ExternalMemoryBackend:
    """外部记忆适配器基类：远程原语 + 本地 SQLite 降级。

    子类只实现两个远程原语 :meth:`_write` / :meth:`_search`（以及可选的
    :meth:`_ping`），写和召回的**降级语义**在本类里只写一遍：

    * 服务可用 → 走远程，返回远程 id / 远程结果；
    * 服务不可用或远程抛异常 → 置 ``degraded`` / ``note``，然后
      —— 注入了 ``store`` 时直接降级写/查本地 SQLite（适配器单独使用时）；
      —— 没注入 ``store`` 时抛 :class:`BackendUnavailable`，由门面落本地。

    **任何一条路径都不会"没做成却返回成功"**：降级一定同时改 ``degraded`` 与
    ``note``，而 ``note`` 是一句人话，直接进返回行。
    """

    name = "external"
    requires = ""
    #: 本地降级落点。``None`` 表示"本地写入交给 :class:`BotMemory` 门面"。
    store: Optional[BotStore] = None

    def __init__(self, *, store: Optional[BotStore] = None) -> None:
        self.store = store
        self.reason = ""
        self.note = ""
        self.degraded = False
        self.last_external_id: Optional[str] = None

    # ------------------------------------------------------------ 可用性 --
    def _implemented(self) -> bool:
        """适配器有没有真的实现远程原语（基类只有抛异常的占位）。"""
        return type(self)._write is not ExternalMemoryBackend._write

    def _ping(self) -> Tuple[bool, str]:
        """服务级探针。默认"模块在就算可用"——本地库（Chroma）正是如此。

        网络型后端（Letta）必须覆盖它：只查包在不在会得出"装了就算接上了"，
        而服务没起时那是一次必然超时。
        """
        return True, ""

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
            return False
        ok, reason = self._ping()
        if not ok:
            self.reason = reason or f"{self.requires} 已装但服务不可用"
            return False
        self.reason = ""
        return True

    def _health(self) -> Tuple[bool, str]:
        """再探一次。**每次调用都探**：服务可能在构造之后才挂掉。"""
        try:
            ok = bool(self.available())
        except Exception as exc:  # noqa: BLE001 - 探测不许把调用方拖崩
            return False, f"{type(self).__name__}.available() 失败：{exc}"
        return (True, "") if ok else (False, self.reason)

    # ------------------------------------------------------------ 降级标记 --
    def _degrade(self, reason: str) -> None:
        self.degraded = True
        if reason:
            self.reason = reason
        self.note = (
            f"外部记忆 {self.name} 不可用，已降级到本地 SQLite：{reason}"
            if reason else f"外部记忆 {self.name} 不可用，已降级到本地 SQLite"
        )

    # ---------------------------------------------------- 远程原语（子类实现） --
    def _write(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Sequence[str] = (),
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Optional[str]:
        raise NotImplementedError(f"{self.name} 记忆适配器尚未实现写入")

    def _search(self, bot_id: str, query: str, limit: int) -> List[dict]:
        raise NotImplementedError(f"{self.name} 记忆适配器尚未实现召回")

    # -------------------------------------------------------------- 对外 --
    def remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Sequence[str] = (),
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Optional[str]:
        if not self._implemented():
            raise NotImplementedError(f"{self.name} 记忆适配器尚未实现写入")
        self.degraded = False
        self.note = ""
        self.last_external_id = None
        ok, reason = self._health()
        if ok:
            try:
                external_id = self._write(
                    bot_id, content, key=key, tags=tags, metadata=metadata,
                )
            except NotImplementedError:
                raise  # 接线错误，不许伪装成"服务不可用"
            except Exception as exc:  # noqa: BLE001 - 远程失败必须降级
                self._degrade(f"写入失败（{type(exc).__name__}: {exc}）")
            else:
                self.last_external_id = external_id
                return external_id
        else:
            self._degrade(reason or "服务不可用")
        return self._fallback_remember(bot_id, content, key=key, tags=tags)

    def recall(self, bot_id: str, query: str, limit: int = 5) -> List[dict]:
        if not self._implemented():
            raise NotImplementedError(f"{self.name} 记忆适配器尚未实现召回")
        size = max(1, int(limit))
        self.degraded = False
        self.note = ""
        ok, reason = self._health()
        if ok:
            try:
                items = self._search(bot_id, query, size)
            except NotImplementedError:
                raise
            except Exception as exc:  # noqa: BLE001 - 远程失败必须降级
                self._degrade(f"召回失败（{type(exc).__name__}: {exc}）")
            else:
                out: List[dict] = []
                for item in items or []:
                    row = dict(item)
                    row.setdefault("backend", self.name)
                    row["degraded"] = False
                    row.setdefault("note", f"来自外部后端 {self.name} 的语义召回")
                    out.append(row)
                return out[:size]
        else:
            self._degrade(reason or "服务不可用")
        return self._fallback_recall(bot_id, query, size)

    # -------------------------------------------------------- 本地 SQLite --
    def _fallback_remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str,
        tags: Sequence[str],
    ) -> Optional[str]:
        if self.store is None:
            # 没有本地落点：把"已降级"这个事实交给门面，由它写本地并打标记。
            # （`BotMemory` 会把本对象的 store 置空，所以正常用法走这条。）
            raise BackendUnavailable(self.note or f"{self.name} 不可用")
        row = self.store.add_memory(
            bot_id,
            content,
            key=key,
            tags=[str(tag) for tag in tags],
            backend="local-fallback",
        )
        self.note = f"{self.note}（已写入本地 SQLite，memory id={row['id']}）"
        return None

    def _fallback_recall(self, bot_id: str, query: str, limit: int) -> List[dict]:
        if self.store is None:
            raise BackendUnavailable(self.note or f"{self.name} 不可用")
        scored: List[dict] = []
        for row in self.store.list_memory(bot_id):
            value = _score(row["content"], row.get("key", ""), row["tags"], query)
            if _terms(query) and value <= 0:
                continue
            item = dict(row)
            item["score"] = value
            item["degraded"] = True
            item["backend"] = "local-fallback"
            item["note"] = self.note
            scored.append(item)
        scored.sort(
            key=lambda item: (item["score"], item["updated_at"], item["id"]),
            reverse=True,
        )
        return scored[: max(1, int(limit))]


class ChromaBackend(ExternalMemoryBackend):
    """向量库适配器：**仍是占位**。

    远程原语故意没有实现（继承基类的 ``_write`` / ``_search``），所以第一次
    调用就会 ``NotImplementedError`` —— 这是刻意的：``chromadb`` 没装时
    ``available()`` 为假会先降级，装了却没接的时候必须立刻暴露，而不是
    假装写成功。要真接，只需实现 ``_write`` / ``_search`` 两个原语。
    """

    name = "chroma"
    requires = "chromadb"


class LettaBackend(ExternalMemoryBackend):
    """Letta 适配器：实现只有一份，在 :mod:`fieldstation.botd.letta`。

    本类不重复任何 HTTP / 记忆块逻辑，只把那边的方法接到基类的钩子上
    （``available`` / ``_write`` / ``_search``）+ 两个记忆块方法。这样
    "``memory.py`` 里的 Letta 适配器"与"``letta.py`` 里的实现"不可能漂成两套。
    """

    name = "letta"
    requires = "letta_client"

    def __init__(
        self,
        base_url: str = "",
        token: str = "",
        *,
        client: Any = None,
        timeout: float = CALL_TIMEOUT_S,
        store: Optional[BotStore] = None,
    ) -> None:
        super().__init__(store=store)
        self._impl = LettaClientBackend(
            base_url, token, client=client, timeout=timeout,
        )

    # 透传，方便调用方查"连的是哪台"（冒烟/诊断会读）
    @property
    def base_url(self) -> str:
        return self._impl.base_url

    @property
    def timeout(self) -> float:
        return self._impl.timeout

    def available(self) -> bool:
        ok = bool(self._impl.available())
        self.reason = "" if ok else (self._impl.reason or "Letta 服务不可达")
        return ok

    def _write(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Sequence[str] = (),
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Optional[str]:
        return self._impl.remember(
            bot_id, content, key=key, tags=tags, metadata=metadata,
        )

    def _search(self, bot_id: str, query: str, limit: int) -> List[dict]:
        return self._impl.recall(bot_id, query, limit)

    # 记忆块：BotMemory 的首尾两个入口要用
    def read_block(self, bot_id: str) -> Optional[dict]:
        return self._impl.read_block(bot_id)

    def write_block(self, bot_id: str, value: str) -> dict:
        return self._impl.write_block(bot_id, value)


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
            # 本地 SQLite 只允许**一个作者**。适配器若自己带了 store，降级时它会
            # 先写一行，本方法再写一行 —— 内容相同、key 为空时不触发 upsert，
            # 召回里就凭空多出一条"重复记录"，而谁都看不出是哪来的。
            # 所以门面接管：把适配器的本地落点摘掉，降级写由本类负责。
            if getattr(backend, "store", None) is not None:
                backend.store = None
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
        """写一条记忆。本地一定写成功；外部镜像失败只降级，不抛异常。

        「本地一定写成功」是因为 **SQLite 是事实来源**：Letta 那边只是镜像与
        共享层，它挂了不能连带把本地这条也丢掉。

        三种落点的 ``backend`` 值：

        ==========================  ======================  ==================
        情形                        ``backend``              ``note``
        ==========================  ======================  ==================
        外部写入成功                ``letta``               说明来自哪个后端
        外部不可用 / 写失败         ``local-fallback``      降级原因，人话
        没配外部后端                ``local``               明说"只写本地"
        ==========================  ======================  ==================
        """
        tag_list = [str(tag) for tag in (tags or [])]
        backend_label = "local"
        write_note = "未配置外部记忆后端，只写入本地 SQLite"
        external_id: Optional[str] = None
        if self.backend is not None and self.degraded:
            # 构造时就已经降级：写入一分钱都没到外部，**必须**说清是本机兜底，
            # 不许退回 "local" —— 那会被读成"本来就没想用外部记忆"。
            backend_label = "local-fallback"
            write_note = (
                f"外部记忆 {self.backend_name} 不可用，已降级到本地 SQLite："
                f"{self.degraded_reason or '服务不可用'}"
            )
        elif self.backend is not None:
            try:
                external_id = self.backend.remember(
                    bot_id,
                    content,
                    key=key,
                    tags=tag_list,
                    metadata=dict(metadata or {}),
                )
            except BackendUnavailable as exc:
                # 适配器没拿到本地 store：本地这一笔由本方法负责。
                self._degrade(str(exc))
                backend_label = "local-fallback"
                write_note = str(exc)
            except Exception as exc:  # noqa: BLE001 - 外部失败必须降级
                self._degrade(f"{self.backend_name} 写入失败：{exc}")
                backend_label = "local-fallback"
                write_note = f"外部记忆 {self.backend_name} 写入失败，已降级到本地 SQLite：{exc}"
            else:
                backend_label = self.backend_name
                write_note = (
                    f"已写入外部记忆 {self.backend_name}"
                    f"（external_id={external_id}），本地 SQLite 同步保有一份"
                )
                # 适配器自己降级时（例如可用探针过、写入时服务挂了），
                # 它会把事实写在 backend 对象上；这里取过来，别让门面说"成功"。
                if getattr(self.backend, "degraded", False):
                    self._degrade(str(getattr(self.backend, "note", "") or ""))
                    backend_label = "local-fallback"
                    write_note = str(getattr(self.backend, "note", "") or write_note)
                    external_id = None
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
        row["note"] = write_note
        return row

    # -------------------------------------------------------------- 召回 --
    def recall(
        self,
        bot_id: str,
        query: str,
        *,
        limit: Optional[int] = None,
    ) -> List[dict]:
        """按关键词打分召回；外部后端可用时先问它，失败则本地兜底。

        返回的每条都带 ``degraded`` 与 ``note``：

        * ``degraded=False`` + ``note`` 说"来自外部后端 X" → 真的走了外部；
        * ``degraded=True`` + ``note`` 说"已降级到本地 SQLite：原因" → 本地朴素匹配。

        **"外部返回空"不等于降级**：一个还没说过话的 bot 本来就没有记忆，
        把它记成故障会让首次查询在日志里凭空多一次失败。
        """
        size = int(limit if limit is not None else self.limit)
        if size < 1:
            raise ValueError("limit 至少为 1")
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("bot_id 必须是非空字符串")

        #: 本地这一趟到底是因为什么 —— 三种，语气不同，不能混成一句话。
        local_note = "未配置外部记忆后端，本次为本地 SQLite 的关键词匹配"
        external_empty = False
        if self.backend is not None and not self.degraded:
            external: Optional[List[dict]] = None
            try:
                external = self.backend.recall(bot_id, query, size)
            except BackendUnavailable as exc:
                # 适配器拿到了降级事实但没拿到本地 store：本地这一趟由门面走。
                self._degrade(str(exc))
            except Exception as exc:  # noqa: BLE001 - 外部失败必须降级
                self._degrade(f"{self.backend_name} 召回失败：{exc}")
            else:
                # 适配器内部已降级（探针过、检索时服务挂了）：事实取过来。
                if getattr(self.backend, "degraded", False):
                    self._degrade(str(getattr(self.backend, "note", "") or ""))
                elif external:
                    results = []
                    for item in external:
                        row = dict(item)
                        row.setdefault("backend", self.backend_name)
                        row["degraded"] = False
                        row.setdefault(
                            "note", f"来自外部后端 {self.backend_name} 的语义召回",
                        )
                        results.append(row)
                    return results[:size]
                else:
                    # 服务活着、就是没有命中：**不是降级**，但要说清"这次外部查了"。
                    external_empty = True
                    local_note = (
                        f"外部记忆 {self.backend_name} 可用但没有命中，"
                        f"本次为本地 SQLite 的关键词匹配"
                    )

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
            if self.degraded:
                item["note"] = (
                    f"外部记忆 {self.backend_name} 不可用：已降级到本地 SQLite 的"
                    f"关键词匹配（{self.degraded_reason}）"
                )
            else:
                item["note"] = local_note
                item["external_empty"] = external_empty
            scored.append(item)

        # 分数高的在前；同分时新写入的在前，再同则按 id 稳定排序。
        scored.sort(
            key=lambda item: (item["score"], item["updated_at"], item["id"]),
            reverse=True,
        )
        return scored[:size]

    # ---------------------------------------------------------- 只在首尾 --
    def recall_at_start(self, bot_id: str, query: str) -> Dict[str, Any]:
        """任务**开头**调一次：召回记忆 + 读核心记忆块。

        ## 为什么单独开一个方法

        「Letta 只在首尾」是架构纪律，不是性能优化：中间过程频繁读写会让记忆
        变脏，而且每次都多一次跨进程往返。把"首"和"尾"各成一个方法，比在每个
        调用点靠人工记得"别在中间调"可靠得多。

        返回里带 ``memory_missing``：**服务不可用要留痕**。不写标记的话，
        以后没人知道这份记忆是真从 Letta 来的，还是本地兜底的。
        """
        out: Dict[str, Any] = {
            "bot_id": str(bot_id),
            "items": self.recall(bot_id, query),
            "block": None,
            "degraded": self.degraded,
            "memory_missing": False,
            "reason": self.degraded_reason,
            "note": "",
        }
        backend = self.backend
        reader = getattr(backend, "read_block", None)
        if backend is None or self.degraded or reader is None:
            out["memory_missing"] = True
            out["reason"] = out["reason"] or "没有可用的外部记忆后端"
            out["note"] = (
                f"记忆块未读取：已降级到本地 SQLite 的关键词召回"
                f"（{out['reason']}）"
            )
            return out
        try:
            out["block"] = reader(bot_id)
        except Exception as exc:  # noqa: BLE001 - 读不到块不该让任务失败
            out["memory_missing"] = True
            out["reason"] = f"{type(exc).__name__}: {exc}"
            out["note"] = f"记忆块读取失败：已降级到本地 SQLite 的关键词召回（{out['reason']}）"
        else:
            out["note"] = (
                "记忆块读取成功"
                if out["block"] is not None
                else "外部服务可用，但这个 bot 还没有核心记忆块（正常状态）"
            )
        return out

    def remember_at_end(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "session_summary",
        tags: Optional[Sequence[str]] = None,
        block_value: Optional[str] = None,
    ) -> Dict[str, Any]:
        """任务**结尾**调一次：写一条归档记忆，可选地更新核心记忆块。

        ``block_value`` 给了就覆盖核心块（语义是"当前摘要"），不给就只追加
        一条归档 passage —— 两者分工见 ``letta.py`` 的模块 docstring。
        """
        row = self.remember(bot_id, content, key=key, tags=tags, source="session")
        out: Dict[str, Any] = {
            "bot_id": str(bot_id),
            "memory_id": row.get("id"),
            "external_id": row.get("external_id"),
            "block": None,
            "degraded": self.degraded,
            "memory_missing": False,
            "reason": self.degraded_reason,
            "note": "",
        }
        backend = self.backend
        writer = getattr(backend, "write_block", None)
        if backend is None or self.degraded or writer is None:
            out["memory_missing"] = True
            out["reason"] = out["reason"] or "没有可用的外部记忆后端"
            out["note"] = (
                f"核心记忆块未更新：归档已降级到本地 SQLite（{out['reason']}）"
            )
            return out
        if block_value is not None:
            try:
                out["block"] = writer(bot_id, block_value)
            except Exception as exc:  # noqa: BLE001 - 写块失败只影响镜像
                out["memory_missing"] = True
                out["reason"] = f"{type(exc).__name__}: {exc}"
                out["note"] = f"核心记忆块写入失败：已降级到本地 SQLite（{out['reason']}）"
                return out
            out["note"] = "归档 passage 与核心记忆块都已写入外部记忆"
        else:
            out["note"] = "归档 passage 已写入外部记忆；未提供 block_value，核心块未动"
        return out

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
