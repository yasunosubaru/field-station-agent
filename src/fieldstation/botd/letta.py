"""Letta 记忆适配器：把 `agents/blocks`（记忆块）与 `agents/passages`（归档）接到 `BotMemory`。

## 为什么是 HTTP 客户端，不是进程内库

W0 的 spike 问题是「**单进程内能 recall/remember 吗**」，答案在打包后就清楚了：

* `letta`（PyPI 上的服务端发行包）是一个 78.4 MB 的 wheel，装起来会拉一整套
  FastAPI + SQLAlchemy + Postgres 方言 + 向量库，并且和本项目已钉住的
  duckdb / langgraph / pydantic-ai / dbos / llama-index 争 pydantic 与 httpx 的版本；
* `letta-client`（418 KB）只是它的 **HTTP 客户端**，依赖只有
  anyio / distro / httpx / pydantic / sniffio / typing-extensions，全都已在 `.deps/venv` 里。

所以结论是：**Letta 不作为进程内库嵌入**，而是「外部服务 + 轻客户端」。
这与 ADR-009 的降级梯度一致（Letta 不可用 → `bot_memory` + Chroma，任务照跑）。
`docs/operations/suite-embed.md` 是 W3 的嵌入，与本文件无关——这里嵌的不是窗口。

## 这条依赖为什么不进 requirements-v4.txt

`letta-client` 是**可选**的：没装、服务没起、鉴权失败，任何一种都不许把
`BotMemory` 拖崩（那是 `memory.py` 顶部的设计约束）。所以本模块只在
`available()` 返回真之后才被调用，且一切异常都在 `remember` / `recall` 的
try 里被折成降级。

装与不装的判据是 `available()`：它同时要求「客户端可导入」**和**「服务端答得上话」。
只查前者会得出「装了就算接上了」的错误结论——服务没起时那是一次必然超时。

## 映射

| 本项目概念 | Letta 概念 | 说明 |
|---|---|---|
| bot 的长期记忆 | agent 的 core memory block | 按 `bot_id` 取 agent，读写同名 block |
| 一条记忆 | archival passage | `agents.passages.create` 写入，`search` 召回 |
| `key` | passage 的 `tags` | 召回时能按 key 过滤；不塞进正文，正文保持是内容本身 |

**SQLite 仍是事实来源**：本适配器只做镜像与加速，`BotMemory` 写在外部失败时照样落本地。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Mapping, Optional, Sequence

#: 服务端地址。默认是 Letta 自己的默认端口，可用环境变量覆盖。
DEFAULT_BASE_URL = "http://127.0.0.1:8283"
ENV_BASE_URL = "FSA_LETTA_URL"
ENV_TOKEN = "FSA_LETTA_TOKEN"
#: 探测超时（秒）。比调用超时短：可用性探测不该让界面等半分钟。
PROBE_TIMEOUT_S = 2.0
#: 单次读写超时（秒）。
CALL_TIMEOUT_S = 15.0

#: core memory block 的名字。每个 bot 在 Letta 里是一个 agent，
#: 这个 block 存"它是谁、它记得什么"的摘要，与 archival 分工不同。
BLOCK_LABEL = "fsa_bot_memory"


class LettaClientBackend:
    """通过 `letta-client` 访问外部 Letta 服务。

    与 `memory.py` 里的 `ExternalMemoryBackend` 同接口（`available` / `remember` / `recall`），
    但**不是**它的子类：基类故意让 `remember` / `recall` 抛 `NotImplementedError`，
    继承过来还得把两个方法都覆盖掉；而这里要覆盖的逻辑量已经超过"占位实现"该有的样子，
    直接独立成类反而更好读。
    """

    name = "letta"

    def __init__(
        self,
        base_url: str = "",
        token: str = "",
        *,
        client: Any = None,
        timeout: float = CALL_TIMEOUT_S,
    ) -> None:
        self.base_url = base_url or os.environ.get(ENV_BASE_URL, DEFAULT_BASE_URL)
        self.token = token or os.environ.get(ENV_TOKEN, "")
        self.timeout = float(timeout)
        self.reason = ""
        self._client = client

    # ---------------------------------------------------------------- 可用性
    def _make_client(self) -> Any:
        if self._client is not None:
            return self._client
        from letta_client import Letta  # noqa: WPS433 - 可选依赖，只在真用时导入

        kwargs: Dict[str, Any] = {"base_url": self.base_url, "timeout": self.timeout}
        if self.token:
            kwargs["api_key"] = self.token
        self._client = Letta(**kwargs)
        return self._client

    def available(self) -> bool:
        """客户端可导入**且**服务端答得上话，才算可用。

        只判断前者是最常见的错误：包装上了、服务没起，然后第一次 remember 才超时，
        用户看到的是"记忆写入失败"而不是"Letta 没启动"。

        注入 `client` 时跳过导入检查：调用方既然能构造出客户端，依赖就已经被解析了。
        （单测与工具里注入假客户端正是靠这一点，否则每个用例都得先装上 letta_client。）
        """
        if self._client is None:
            try:
                import importlib.util
                if importlib.util.find_spec("letta_client") is None:
                    self.reason = "未安装 letta_client"
                    return False
            except (ImportError, ValueError, AttributeError):
                self.reason = "探测 letta_client 失败"
                return False

        try:
            client = self._make_client()
            # 列一页 agent 是最便宜的"服务活着吗"探针：不需要预先知道任何 id。
            client.agents.list(limit=1)
        except Exception as exc:  # noqa: BLE001 - 探测本身不许把调用方拖崩
            self.reason = f"Letta 服务不可达（{self.base_url}）：{type(exc).__name__}: {exc}"
            return False
        self.reason = ""
        return True

    # ---------------------------------------------------------------- 定位 agent
    def _agent_for(self, bot_id: str, create: bool = True) -> Optional[str]:
        """按 `bot_id` 找到对应的 agent；创建是**惰性**的（只有写入时才建）。

        召回不应顺手建 agent —— 一个从没说过话的 bot 查询时凭空多出一个空 agent，
        会让 Letta 侧的对象数量与我们的 bot 表对不上，排查时很难解释。
        """
        client = self._make_client()
        wanted = str(bot_id)
        for agent in client.agents.list(limit=200):
            if str(getattr(agent, "name", "")) == wanted:
                return str(getattr(agent, "id", ""))
        if not create:
            return None
        created = client.agents.create(name=wanted, memory_blocks=[
            {"label": BLOCK_LABEL, "value": f"bot {wanted} 的记忆（由野外台站智能体维护）"},
        ])
        return str(getattr(created, "id", ""))

    # ---------------------------------------------------------------- 记忆块
    def read_block(self, bot_id: str) -> Optional[dict]:
        """读这个 bot 的 core memory block。没有 agent / 没有 block 时返回 ``None``。

        **为什么不抛异常**：「这个 bot 还没有记忆」是正常状态，不是故障。
        抛异常会让首次查询被记成一次失败，日志里就看不出真实故障率了。
        """
        client = self._make_client()
        agent_id = self._agent_for(bot_id, create=False)
        if not agent_id:
            return None
        try:
            block = client.agents.blocks.retrieve(BLOCK_LABEL, agent_id=agent_id)
        except Exception as exc:  # noqa: BLE001 - 没这个 block 是正常情况
            self.reason = f"读不到记忆块 {BLOCK_LABEL}：{type(exc).__name__}"
            return None
        return _block_dict(block)

    def write_block(self, bot_id: str, value: str) -> dict:
        """把核心记忆块的**整块**内容换成 ``value``。

        与 :meth:`remember`（归档 passage，逐条追加）不同：block 是"它是谁、
        现在记住什么"的摘要，语义是**覆盖**。所以只在任务首尾各写一次
        （召回后整理、记录后归纳），中间过程不碰 —— 这也是"Letta 只在首尾"
        那条纪律在 block 上的落法。
        """
        if not isinstance(value, str):
            raise TypeError("block value 必须是字符串")
        client = self._make_client()
        agent_id = self._agent_for(bot_id, create=True)
        if not agent_id:
            raise RuntimeError(f"无法为 bot {bot_id!r} 创建 Letta agent")
        try:
            block = client.agents.blocks.update(
                BLOCK_LABEL, agent_id=agent_id, value=value)
        except Exception:
            # block 不存在（老 agent 没有这个 label）：建一个再挂上去。
            # 这里刻意不做"先查再建"：查一次也要一次往返，而失败路径本来
            # 就是少数情况，直接建 + 挂更短。
            try:
                block = client.blocks.create(label=BLOCK_LABEL, value=value)
                client.agents.blocks.attach(block.id, agent_id=agent_id)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(
                    f"写记忆块失败（{BLOCK_LABEL}）：{type(exc).__name__}: {exc}"
                ) from exc
        return _block_dict(block)

    # ---------------------------------------------------------------- 写入
    def remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Sequence[str] = (),
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Optional[str]:
        """写一条归档记忆，返回 Letta 侧的 passage id。

        `key` 进 tags 而不进正文：正文必须就是内容本身，否则召回出来要再做一次
        "把前缀剥掉"的解析，而那一步在内容里天然含 `key:` 时就会切错。
        """
        client = self._make_client()
        agent_id = self._agent_for(bot_id, create=True)
        if not agent_id:
            raise RuntimeError(f"无法为 bot {bot_id!r} 创建 Letta agent")
        tag_list = [str(tag) for tag in tags]
        if key:
            tag_list.append(f"key:{key}")
        passage = client.agents.passages.create(
            agent_id=agent_id,
            text=str(content),
            tags=tag_list or None,
            metadata=dict(metadata or {}) or None,
        )
        return str(getattr(passage, "id", "")) or None

    # ---------------------------------------------------------------- 召回
    def recall(self, bot_id: str, query: str, limit: int = 5) -> List[dict]:
        """语义检索归档记忆。agent 不存在时返回空列表（不是异常）。

        「这个 bot 还没记忆」和「记忆服务挂了」是两件事：前者应静默返回空，
        后者应降级并留痕。混在同一个异常里会让首次查询被记成一次故障。
        """
        client = self._make_client()
        agent_id = self._agent_for(bot_id, create=False)
        if not agent_id:
            return []
        results = client.agents.passages.search(
            agent_id=agent_id,
            query=str(query),
            limit=max(1, int(limit)),
        )
        out: List[dict] = []
        # 客户端不同版本的返回形状不同：可能是 list，也可能带 .results / .data。
        items = getattr(results, "results", None) or getattr(results, "data", None) or results or []
        for item in items:
            text = getattr(item, "text", None) or getattr(item, "content", None) or ""
            if not text:
                continue
            raw_tags = getattr(item, "tags", None) or []
            key = ""
            for tag in raw_tags:
                tag_text = str(tag)
                if tag_text.startswith("key:"):
                    key = tag_text[len("key:"):]
                    break
            out.append({
                "id": str(getattr(item, "id", "")),
                "content": str(text),
                "key": key,
                "tags": [str(t) for t in raw_tags if not str(t).startswith("key:")],
                "score": getattr(item, "score", 0.0) or 0.0,
                "backend": self.name,
                "degraded": False,
            })
        return out[: max(1, int(limit))]


def _block_dict(block: Any) -> dict:
    """把 BlockResponse（pydantic 对象）拍平成 dict。取不到就留空，不炸。"""
    return {
        "id": str(getattr(block, "id", "") or ""),
        "label": str(getattr(block, "label", "") or ""),
        "value": str(getattr(block, "value", "") or ""),
        "backend": "letta",
        "degraded": False,
    }


def build_default_backend(
    base_url: str = "",
    token: str = "",
    *,
    client: Any = None,
) -> Optional[LettaClientBackend]:
    """按环境变量造一个后端；探测不通过就返回 `None`。

    返回 `None` 而不是一个「不可用但存在」的对象，是为了让调用方
    `BotMemory(store, backend=build_default_backend())` 在没配 Letta 时
    直接走纯本地路径，`status()` 里也不会多一条永远为假的外部后端。
    """
    backend = LettaClientBackend(base_url, token, client=client)
    return backend if backend.available() else None
