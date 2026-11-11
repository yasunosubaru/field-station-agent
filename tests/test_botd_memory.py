"""E2 botd 记忆：写入、关键词召回、按 bot 隔离、外部后端降级。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from fieldstation.botd.memory import (
    BackendUnavailable,
    BotMemory,
    ChromaBackend,
    ExternalMemoryBackend,
    LettaBackend,
    probe_external,
)
from fieldstation.botd.store import BotStore

NOW = datetime(2026, 11, 5, 8, 0, 0, tzinfo=timezone.utc)


class BrokenBackend:
    """可用性探测通过、实际调用全部失败的适配器（模拟服务没起来）。"""

    name = "broken"

    def available(self) -> bool:
        return True

    def remember(self, bot_id: str, content: str, **kwargs: Any) -> Optional[str]:
        raise RuntimeError("connection refused")

    def recall(self, bot_id: str, query: str, limit: int = 5) -> list:
        raise RuntimeError("connection refused")


class OfflineBackend:
    name = "chroma"
    reason = "未安装 chromadb"

    def available(self) -> bool:
        return False

    def remember(self, bot_id: str, content: str, **kwargs: Any) -> Optional[str]:
        raise AssertionError("不可用后端不应该被调用")

    def recall(self, bot_id: str, query: str, limit: int = 5) -> list:
        raise AssertionError("不可用后端不应该被调用")


class FakeExternalBackend:
    name = "fake"

    def __init__(self) -> None:
        self.written: list[tuple] = []

    def available(self) -> bool:
        return True

    def remember(self, bot_id: str, content: str, **kwargs: Any) -> str:
        self.written.append((bot_id, content, kwargs))
        return "ext-001"

    def recall(self, bot_id: str, query: str, limit: int = 5) -> list:
        return [
            {"content": "向量检索结果", "score": 9.5, "backend": "fake"},
            {"content": "第二条", "score": 8.0, "backend": "fake"},
        ][:limit]


class MemoryTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db = Path(self._tmp.name) / "botd.sqlite3"
        self.store = BotStore(self.db)
        self.memory = BotMemory(self.store)


class TestRememberAndRecall(MemoryTestBase):
    def test_chinese_keyword_recall(self) -> None:
        battery = self.memory.remember(
            "bot1", "电池电压过低会触发告警，需要检查供电模块。",
            tags=["供电"], now=NOW,
        )
        self.memory.remember(
            "bot1", "天线方位角偏离，需要重新对准。", tags=["天线"],
            now=NOW + timedelta(seconds=1),
        )
        results = self.memory.recall("bot1", "电池 电压")
        self.assertTrue(results)
        self.assertEqual(results[0]["id"], battery["id"])
        self.assertGreater(results[0]["score"], 0)
        self.assertFalse(results[0]["degraded"])

    def test_english_keyword_recall_and_ranking(self) -> None:
        weak = self.memory.remember(
            "bot1", "battery level is low", now=NOW
        )
        strong = self.memory.remember(
            "bot1", "battery voltage dropped; voltage below threshold", now=NOW
        )
        self.memory.remember("bot1", "antenna alignment procedure", now=NOW)
        results = self.memory.recall("bot1", "battery voltage")
        self.assertEqual(results[0]["id"], strong["id"])
        self.assertIn(weak["id"], [item["id"] for item in results])

    def test_bots_are_isolated(self) -> None:
        self.memory.remember("bot1", "共享关键词：巡检周期", now=NOW)
        self.memory.remember("bot2", "共享关键词：巡检周期", now=NOW)
        self.assertEqual(len(self.memory.recall("bot1", "巡检")), 1)
        self.assertEqual(
            self.memory.recall("bot1", "巡检")[0]["bot_id"], "bot1"
        )
        self.assertEqual(len(self.memory.list("bot2")), 1)

    def test_limit_and_empty_query(self) -> None:
        for index in range(5):
            self.memory.remember(
                "bot1", f"记录 {index}", now=NOW + timedelta(seconds=index)
            )
        self.assertEqual(len(self.memory.recall("bot1", "记录", limit=2)), 2)
        latest = self.memory.recall("bot1", "")
        self.assertEqual(len(latest), 5)
        self.assertTrue(all(item["score"] == 0 for item in latest))
        self.assertEqual(latest[0]["content"], "记录 4")

    def test_same_key_updates_instead_of_duplicating(self) -> None:
        first = self.memory.remember(
            "bot1", "旧状态：离线", key="station:S01:status", now=NOW
        )
        second = self.memory.remember(
            "bot1", "新状态：在线", key="station:S01:status",
            now=NOW + timedelta(minutes=5),
        )
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.list_memory("bot1")), 1)
        self.assertEqual(second["content"], "新状态：在线")
        self.assertTrue(self.memory.forget("bot1", "station:S01:status"))
        self.assertFalse(self.memory.forget("bot1", "station:S01:status"))

    def test_validation(self) -> None:
        with self.assertRaises(ValueError):
            self.memory.remember("", "x")
        with self.assertRaises(ValueError):
            self.memory.remember("bot1", "   ")
        with self.assertRaises(ValueError):
            self.memory.recall("", "x")
        with self.assertRaises(ValueError):
            self.memory.recall("bot1", "x", limit=0)


class TestDegradation(MemoryTestBase):
    def test_unavailable_backend_degrades_at_construction(self) -> None:
        memory = BotMemory(self.store, backend=OfflineBackend())
        status = memory.status()
        self.assertTrue(status["degraded"])
        self.assertFalse(status["available"])
        self.assertIn("未安装 chromadb", status["reason"])

        memory.remember("bot1", "离线也要能记住", now=NOW)
        results = memory.recall("bot1", "离线")
        self.assertTrue(results)
        self.assertTrue(results[0]["degraded"])
        self.assertEqual(results[0]["backend"], "local-fallback")

    def test_broken_backend_falls_back_and_marks_rows(self) -> None:
        memory = BotMemory(self.store, backend=BrokenBackend())
        self.assertFalse(memory.degraded)

        row = memory.remember("bot1", "写入失败也要落本地", now=NOW)
        self.assertTrue(memory.degraded)
        self.assertEqual(row["backend"], "local-fallback")
        self.assertIn("connection refused", memory.degraded_reason)

        results = memory.recall("bot1", "写入失败")
        self.assertTrue(results)
        self.assertTrue(results[0]["degraded"])
        self.assertIn("connection refused", memory.status()["reason"])

    def test_broken_backend_on_recall_falls_back_to_local(self) -> None:
        memory = BotMemory(self.store, backend=BrokenBackend())
        self.store.add_memory("bot1", "本地兜底内容", now=NOW)
        results = memory.recall("bot1", "本地")
        self.assertTrue(results)
        self.assertEqual(results[0]["content"], "本地兜底内容")
        self.assertTrue(memory.degraded)

    def test_available_backend_is_used_when_it_works(self) -> None:
        backend = FakeExternalBackend()
        memory = BotMemory(self.store, backend=backend)
        row = memory.remember("bot1", "镜像到外部", key="k1", now=NOW)
        self.assertEqual(row["backend"], "fake")
        self.assertEqual(row["external_id"], "ext-001")
        self.assertEqual(backend.written[0][0], "bot1")

        results = memory.recall("bot1", "任意查询")
        self.assertEqual(results[0]["content"], "向量检索结果")
        self.assertFalse(results[0]["degraded"])

    def test_adapters_probe_without_importing_heavy_dependencies(self) -> None:
        found = probe_external()
        self.assertEqual(set(found), {"chroma", "letta"})
        self.assertTrue(all(isinstance(value, bool) for value in found.values()))

        chroma = ChromaBackend()
        self.assertIsInstance(chroma.available(), bool)
        self.assertIsInstance(LettaBackend().available(), bool)
        self.assertIsInstance(ExternalMemoryBackend().available(), bool)

        # 占位适配器即使模块在，也不许假装写成功。
        with self.assertRaises(NotImplementedError):
            ExternalMemoryBackend().remember("bot1", "x")
        # Chroma 仍然是占位：第一次调用必须立刻暴露，不能安静降级。
        with self.assertRaises(NotImplementedError):
            ChromaBackend().remember("bot1", "x")
        with self.assertRaises(NotImplementedError):
            ChromaBackend().recall("bot1", "x")


class _Obj:
    """模拟 pydantic 返回对象：按属性名取值。"""

    def __init__(self, **kwargs: Any) -> None:
        for name, value in kwargs.items():
            setattr(self, name, value)


class _FakeBlocks:
    """``client.agents.blocks``：签名照 letta-client 1.12.1。"""

    def __init__(self, owner: "FakeLettaClient") -> None:
        self.owner = owner

    def retrieve(self, block_label: str, *, agent_id: str):
        store = self.owner.blocks.get(agent_id, {})
        if block_label not in store:
            raise RuntimeError(f"没有 block {block_label}")
        return _Obj(id=f"blk-{block_label}", label=block_label,
                    value=store[block_label])

    def update(self, block_label: str, *, agent_id: str, value=None, **kwargs):
        store = self.owner.blocks.setdefault(agent_id, {})
        if block_label not in store:
            raise RuntimeError(f"没有 block {block_label}")
        if value is not None:
            store[block_label] = value
        return _Obj(id=f"blk-{block_label}", label=block_label,
                    value=store[block_label])

    def attach(self, block_id: str, *, agent_id: str, **kwargs):
        self.owner.attached.append((agent_id, block_id))
        return _Obj(id=block_id)


class _FakePassages:
    """``client.agents.passages``：**只用 1.12.1 的真实参数名**（``top_k``）。

    这里刻意不实现 ``limit=`` 兜底 —— 那样会让"适配器到底传了哪个名字"
    这件事测不出来。假客户端必须比真客户端更严格，否则等于自证成功。
    """

    def __init__(self, owner: "FakeLettaClient") -> None:
        self.owner = owner

    def create(self, agent_id: str, *, text: str, tags=None, created_at=None):
        if self.owner.fail_write:
            raise ConnectionError("connection refused")
        pid = f"passage-{len(self.owner.passages) + 1}"
        self.owner.passages.append({
            "id": pid, "agent_id": agent_id, "text": text,
            "tags": list(tags or []),
        })
        # 1.12.1 的 PassageCreateResponse 是 **List[Passage]**
        return [_Obj(id=pid, text=text, tags=list(tags or []))]

    def search(self, agent_id: str, *, query: str, top_k=None, **kwargs):
        if "limit" in kwargs:
            raise TypeError("search() 在 letta-client 1.12.1 上叫 top_k，不叫 limit")
        if self.owner.fail_search:
            raise ConnectionError("connection refused")
        hits = [
            p for p in self.owner.passages
            if p["agent_id"] == agent_id and query.lower() in p["text"].lower()
        ][: int(top_k or 5)]
        # 1.12.1 的 SearchResult：字段是 content，**没有 score**
        return _Obj(count=len(hits), results=[
            _Obj(id=p["id"], content=p["text"], tags=p["tags"],
                 timestamp="2026-11-11T00:00:00+00:00")
            for p in hits
        ])


class _FakeAgents:
    def __init__(self, owner: "FakeLettaClient") -> None:
        self.owner = owner
        self.blocks = _FakeBlocks(owner)
        self.passages = _FakePassages(owner)

    def list(self, *, name=None, limit=None, **kwargs):
        if self.owner.fail_list:
            raise ConnectionError("connection refused")
        agents = self.owner.agents
        if name is not None:
            agents = [a for a in agents if a["name"] == name]
        if limit is not None:
            agents = agents[: int(limit)]
        return [_Obj(id=a["id"], name=a["name"]) for a in agents]

    def create(self, *, name: str, memory_blocks=None, **kwargs):
        if self.owner.fail_list:
            raise ConnectionError("connection refused")
        agent = {"id": f"agent-{len(self.owner.agents) + 1}", "name": name}
        self.owner.agents.append(agent)
        self.owner.blocks[agent["id"]] = {
            str(block.get("label", "")): str(block.get("value", ""))
            for block in (memory_blocks or [])
        }
        return _Obj(id=agent["id"], name=name)


class FakeLettaClient:
    """照 ``letta-client`` 1.12.1 的真实调用形状写的假服务。

    与 `tests/test_botd_letta.py` 里那份的区别：这份只实现**真客户端有的**参数名
    （``top_k`` / 无 ``metadata`` / ``create`` 返回列表），所以"适配器传错参数"
    会在这里直接失败，而不是被宽宏大量的假实现吞掉。
    """

    def __init__(self) -> None:
        self.agents: list[dict] = []
        self.blocks: dict[str, dict[str, str]] = {}
        self.passages: list[dict] = []
        self.attached: list[tuple[str, str]] = []
        self.fail_list = False
        self.fail_write = False
        self.fail_search = False
        self._agents = _FakeAgents(self)

    @property
    def agents_resource(self):  # pragma: no cover - 只是让 `agents` 可读
        return self._agents

    # 让 `client.agents` 就是资源对象（真实 SDK 也是这样）
    @property
    def agents_api(self):
        return self._agents


class _FakeWrapper:
    def __init__(self, fake: FakeLettaClient) -> None:
        self._fake = fake
        self.agents = fake._agents


class TestLettaRealClientShape(MemoryTestBase):
    """Bot-5 真接：适配器必须对上 `letta-client` 1.12.1 的真实签名。

    这三条是"只看文档不看签名"会踩的坑，每条都在真客户端上会直接失败：

    1. ``passages.search`` 的参数是 ``top_k``，不是 ``limit``；
    2. ``passages.create`` 返回的是 **List[Passage]**，不是单个对象；
    3. ``passages.create`` **没有** ``metadata`` 参数。
    """

    def setUp(self) -> None:
        super().setUp()
        self.fake = FakeLettaClient()
        self.backend = LettaBackend(client=_FakeWrapper(self.fake))

    # ---------------------------------------------------------- 服务可用 --
    def test_available_when_service_answers(self) -> None:
        self.assertTrue(self.backend.available())
        self.assertEqual(self.backend.reason, "")

    def test_write_returns_passage_id_from_list_response(self) -> None:
        """`create` 回的是列表 → 必须能从列表里取到 id，否则等于没拿到。"""
        external_id = self.backend.remember(
            "bot1", "电池电压过低会触发告警", key="power",
        )
        self.assertEqual(external_id, "passage-1")
        self.assertFalse(self.backend.degraded)
        self.assertEqual(self.fake.passages[0]["text"], "电池电压过低会触发告警")
        self.assertIn("key:power", self.fake.passages[0]["tags"])

    def test_remember_then_recall_same_content(self) -> None:
        """写入后能召回同一内容 —— 这是"真接"的最小闭环。"""
        content = "去年同月也出现过连续缺测，重启接收机后恢复。"
        self.backend.remember("bot1", content, key="case", tags=["history"])
        results = self.backend.recall("bot1", "缺测")
        self.assertEqual(len(results), 1, results)
        self.assertEqual(results[0]["content"], content)
        self.assertEqual(results[0]["key"], "case")
        self.assertEqual(results[0]["tags"], ["history"])
        self.assertEqual(results[0]["backend"], "letta")
        self.assertFalse(results[0]["degraded"])

    def test_metadata_folds_into_tags_and_says_so(self) -> None:
        """1.12.1 没有 metadata 字段：折进 tags 并留 warning，不许静默丢。"""
        self.backend.remember("bot1", "带元数据", metadata={"source": "qc"})
        self.assertIn("meta:source=qc", self.fake.passages[0]["tags"])
        self.assertTrue(
            any("metadata" in warning for warning in self.backend._impl.warnings),
            self.backend._impl.warnings,
        )

    def test_block_roundtrip(self) -> None:
        written = self.backend.write_block("bot1", "当前关注：WUHN 连续缺测")
        self.assertEqual(written["value"], "当前关注：WUHN 连续缺测")
        read = self.backend.read_block("bot1")
        self.assertEqual(read["value"], "当前关注：WUHN 连续缺测")

    def test_recall_does_not_create_agent(self) -> None:
        self.backend.recall("ghost", "任意")
        self.assertEqual(self.fake.agents, [])

    # ------------------------------------------------------ 服务不可用 --
    def test_unavailable_service_degrades_and_says_so(self) -> None:
        """服务挂了：降级写本地，且 note / backend / degraded 三处都要明示。"""
        self.fake.fail_list = True
        memory = BotMemory(self.store, backend=self.backend)
        self.assertTrue(memory.degraded, "构造时就该发现服务不可用")
        self.assertIn("connection refused", memory.degraded_reason)

        row = memory.remember("bot1", "服务关了也要记住这条", key="k1")
        self.assertEqual(row["backend"], "local-fallback")
        self.assertTrue(row["degraded"])
        self.assertIn("降级", row["note"], row["note"])
        self.assertIn("connection refused", row["note"])

        # 本地这一条真的落了库，而且能召回
        self.assertEqual(len(self.store.list_memory("bot1")), 1)
        results = memory.recall("bot1", "服务关了")
        self.assertTrue(results)
        self.assertEqual(results[0]["content"], "服务关了也要记住这条")
        self.assertTrue(results[0]["degraded"])
        self.assertIn("降级", results[0]["note"])

    def test_write_failure_after_healthy_probe_degrades(self) -> None:
        """探针过了、写入时服务挂了 → 仍然要标降级，不许当成功。"""
        memory = BotMemory(self.store, backend=self.backend)
        self.assertFalse(memory.degraded, "服务健康时不该预先降级")

        self.fake.fail_write = True
        row = memory.remember("bot1", "写到一半服务挂了")
        self.assertEqual(row["backend"], "local-fallback")
        self.assertIsNone(row["external_id"])
        self.assertTrue(memory.degraded)
        self.assertIn("降级", row["note"])
        self.assertEqual(len(self.store.list_memory("bot1")), 1)

    def test_search_failure_degrades_and_marks_rows(self) -> None:
        memory = BotMemory(self.store, backend=self.backend)
        memory.remember("bot1", "外部先写一条")
        self.assertFalse(memory.degraded)

        self.store.add_memory("bot1", "本地兜底内容")
        self.fake.fail_search = True
        results = memory.recall("bot1", "兜底")
        self.assertTrue(results)
        self.assertTrue(memory.degraded)
        self.assertTrue(results[0]["degraded"])
        self.assertEqual(results[0]["backend"], "local-fallback")
        self.assertIn("connection refused", results[0]["note"])

    def test_empty_external_result_is_not_degraded(self) -> None:
        """服务活着但没有命中 ≠ 降级。混起来会让首次查询被记成故障。"""
        memory = BotMemory(self.store, backend=self.backend)
        self.assertFalse(memory.degraded)
        self.store.add_memory("bot1", "本地内容")
        results = memory.recall("bot1", "本地")
        self.assertTrue(results)
        self.assertFalse(memory.degraded)
        self.assertTrue(results[0].get("external_empty"))
        self.assertIn("没有命中", results[0]["note"])

    # -------------------------------------------------------------- 首尾 --
    def test_recall_at_start_with_service(self) -> None:
        self.backend.write_block("bot1", "旧摘要")
        self.backend.remember("bot1", "一条旧记忆", key="k1")
        memory = BotMemory(self.store, backend=self.backend)
        out = memory.recall_at_start("bot1", "记忆")
        self.assertFalse(out["memory_missing"], out["reason"])
        self.assertEqual(out["block"]["value"], "旧摘要")
        self.assertEqual(len(out["items"]), 1)
        self.assertFalse(out["items"][0]["degraded"])

    def test_recall_at_start_degrades_with_note(self) -> None:
        self.fake.fail_list = True
        memory = BotMemory(self.store, backend=self.backend)
        out = memory.recall_at_start("bot1", "记忆")
        self.assertTrue(out["memory_missing"])
        self.assertIn("降级", out["note"], out["note"])

    def test_remember_at_end_with_service(self) -> None:
        memory = BotMemory(self.store, backend=self.backend)
        out = memory.remember_at_end(
            "bot1", "本轮结论：接收机重启后恢复", block_value="当前摘要：已恢复",
        )
        self.assertFalse(out["memory_missing"], out["reason"])
        self.assertEqual(out["block"]["value"], "当前摘要：已恢复")
        self.assertTrue(out["external_id"])
        self.assertEqual(len(self.fake.passages), 1)
        self.assertEqual(len(self.store.list_memory("bot1")), 1)

    def test_remember_at_end_degrades_with_note(self) -> None:
        self.fake.fail_list = True
        memory = BotMemory(self.store, backend=self.backend)
        out = memory.remember_at_end("bot1", "内容", block_value="摘要")
        self.assertTrue(out["memory_missing"])
        self.assertIn("降级", out["note"], out["note"])
        self.assertEqual(len(self.store.list_memory("bot1")), 1,
                         "降级后本地写入必须成功")


class TestAdapterWithoutStoreRaisesUnavailable(MemoryTestBase):
    """适配器单独使用（没注入 store）：降级要抛 ``BackendUnavailable``。

    抛这个类型而不是"自己悄悄写一份本地"，是为了让本地 SQLite 只有一个作者：
    适配器和门面都写，``key`` 为空时会留下两行同内容记忆，召回时看起来像重复。
    """

    def test_remember_raises_with_reason(self) -> None:
        fake = FakeLettaClient()
        fake.fail_list = True
        backend = LettaBackend(client=_FakeWrapper(fake))
        with self.assertRaises(BackendUnavailable) as caught:
            backend.remember("bot1", "内容")
        self.assertIn("connection refused", str(caught.exception))
        self.assertIn("降级", str(caught.exception))

    def test_recall_raises_with_reason(self) -> None:
        fake = FakeLettaClient()
        fake.fail_list = True
        backend = LettaBackend(client=_FakeWrapper(fake))
        with self.assertRaises(BackendUnavailable):
            backend.recall("bot1", "任意")


class TestAdapterWithStoreDegradesLocally(MemoryTestBase):
    """适配器自己带了 store：单独使用时直接降级写本地，且行上标 ``local-fallback``。"""

    def test_remember_and_recall_degrade_in_place(self) -> None:
        fake = FakeLettaClient()
        fake.fail_list = True
        backend = LettaBackend(client=_FakeWrapper(fake), store=self.store)
        self.assertIsNone(backend.remember("bot1", "适配器自己降级", key="k"))

        rows = self.store.list_memory("bot1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["backend"], "local-fallback")

        results = backend.recall("bot1", "降级")
        self.assertTrue(results)
        self.assertTrue(results[0]["degraded"])
        self.assertEqual(results[0]["backend"], "local-fallback")
        self.assertIn("降级", results[0]["note"])


class TestSingleWriterToLocalStore(MemoryTestBase):
    """本地 SQLite 只允许**一个作者**。

    适配器带了 ``store`` 又被塞进 ``BotMemory`` 时，两边都会写：适配器降级写一行、
    门面再写一行。``key`` 为空时不受 upsert 约束，于是召回里出现两条内容相同的
    记忆 —— 看像"重复记录"，实际是两次写，而没有任何字段能解释这件事。
    门面必须在接手时把适配器的本地落点摘掉。
    """

    def test_facade_takes_over_local_writes(self) -> None:
        fake = FakeLettaClient()
        fake.fail_list = True
        backend = LettaBackend(client=_FakeWrapper(fake), store=self.store)
        memory = BotMemory(self.store, backend=backend)

        self.assertIsNone(backend.store, "门面接手后，适配器不该再持有本地落点")

        memory.remember("bot1", "只该有一行")
        rows = self.store.list_memory("bot1")
        self.assertEqual(len(rows), 1, f"出现重复写入：{rows}")
        self.assertEqual(rows[0]["backend"], "local-fallback")

    def test_no_duplicate_on_empty_key(self) -> None:
        """``key`` 为空时不受 upsert 约束，重复写会真的留下两行。"""
        fake = FakeLettaClient()
        fake.fail_list = True
        backend = LettaBackend(client=_FakeWrapper(fake), store=self.store)
        memory = BotMemory(self.store, backend=backend)

        memory.remember("bot1", "空 key 也不能写两遍", key="")
        memory.remember("bot1", "空 key 也不能写两遍", key="")
        self.assertEqual(len(self.store.list_memory("bot1")), 2,
                         "两次显式调用就该是两行（这是 upsert 的正常语义）")
        # 但**一次**调用只许一行
        memory.remember("bot1", "第三次单次调用", key="")
        self.assertEqual(len(self.store.list_memory("bot1")), 3)


class TestLettaBackendWiring(MemoryTestBase):
    """`memory.LettaBackend` 与 `letta.LettaClientBackend` 必须是同一套实现。"""

    def test_single_implementation(self) -> None:
        from fieldstation.botd.letta import LettaClientBackend

        backend = LettaBackend()
        self.assertIsInstance(backend._impl, LettaClientBackend)
        # 适配器没有自己再实现一遍远程原语
        self.assertIs(type(backend)._write, LettaBackend._write)
        self.assertIs(type(backend)._search, LettaBackend._search)
        self.assertEqual(type(backend)._write.__qualname__.split(".")[0], "LettaBackend")

    def test_build_default_backend_returns_facade_backend(self) -> None:
        from fieldstation.botd.letta import build_default_backend

        built = build_default_backend(client=_FakeWrapper(FakeLettaClient()))
        self.assertIsNotNone(built)
        self.assertIsInstance(built, LettaBackend, "必须返回门面能用的适配器")
        self.assertEqual(built.name, "letta")

    def test_build_default_backend_none_when_down(self) -> None:
        from fieldstation.botd.letta import build_default_backend

        fake = FakeLettaClient()
        fake.fail_list = True
        self.assertIsNone(build_default_backend(client=_FakeWrapper(fake)))

    def test_probe_external_reports_letta_client_module(self) -> None:
        """``letta`` 这一项探的必须是 HTTP 客户端，不是 78 MB 的服务端包。"""
        from fieldstation.botd.memory import EXTERNAL_PROVIDERS

        self.assertEqual(EXTERNAL_PROVIDERS["letta"], "letta_client")


if __name__ == "__main__":
    unittest.main()
