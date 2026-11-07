#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`botd/letta.py` 的行为覆盖：映射、惰性创建、降级边界。

## 为什么用假客户端而不是真起 Letta

真起 Letta 要 78 MB 服务端 + Postgres 方言 + 一把向量库，而且和本项目已钉住的
六个引擎争 pydantic / httpx 的版本。让门禁依赖那样一套东西，等于让"测试"先要求
"先装好一个服务"——本仓库的纪律是**门禁不依赖任何可选包**。

所以这里用一个 `FakeLetta`，它的方法签名、返回对象的属性名都照 `letta-client`
1.12.1 的真实形状写（`agents.list/create/passages.create/passages.search`）。
这样"映射对不对"能钉死，而"真服务的 HTTP 细节对不对"留给真机冒烟
（`tools/letta_smoke.py`，只在装了 client 且连得上服务时才跑）。

## 要钉住的三件事

1. **惰性创建**：召回不该凭空造 agent；只有写入才建。
2. **key 进 tags 不进正文**：正文必须就是内容本身，否则召回要再剥前缀，
   而内容天然含 `key:` 时那一步会切错。
3. **降级边界**：服务挂了 / 客户端没装 / agent 不存在，三件事必须分开——
   前两个要留痕，第三个应静默返回空。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fieldstation.botd import letta as letta_mod
from fieldstation.botd.letta import LettaClientBackend, build_default_backend
from fieldstation.botd.memory import BotMemory
from fieldstation.botd.store import BotStore


class _Obj(SimpleNamespace):
    """模拟 pydantic 返回对象：按属性名取值，多余字段不报错。"""


class FakeAgents:
    def __init__(self, owner: "FakeLetta") -> None:
        self.owner = owner
        self.passages = FakePassages(owner)

    def list(self, limit: int = 200):
        if self.owner.fail_list:
            raise ConnectionError("connection refused")
        return [_Obj(id=a["id"], name=a["name"]) for a in self.owner.agents]

    def create(self, name: str, memory_blocks=None):
        agent = {"id": f"agent-{len(self.owner.agents) + 1}", "name": name,
                 "blocks": memory_blocks or []}
        self.owner.agents.append(agent)
        self.owner.created.append(name)
        return _Obj(id=agent["id"], name=name)


class FakePassages:
    def __init__(self, owner: "FakeLetta") -> None:
        self.owner = owner

    def create(self, agent_id: str, text: str, tags=None, metadata=None):
        if self.owner.fail_write:
            raise ConnectionError("connection refused")
        pid = f"passage-{len(self.owner.passages) + 1}"
        self.owner.passages.append({
            "id": pid, "agent_id": agent_id, "text": text,
            "tags": list(tags or []), "metadata": dict(metadata or {}),
        })
        return _Obj(id=pid)

    def search(self, agent_id: str, query: str, limit: int = 5):
        if self.owner.fail_search:
            raise ConnectionError("connection refused")
        hits = [p for p in self.owner.passages
                if p["agent_id"] == agent_id and query.lower() in p["text"].lower()]
        return [_Obj(id=p["id"], text=p["text"], tags=p["tags"], score=0.9)
                for p in hits][:limit]


class FakeLetta:
    """照 `letta-client` 1.12.1 的调用形状写的假服务。"""

    def __init__(self) -> None:
        self.agents: list[dict] = []
        self.passages: list[dict] = []
        self.created: list[str] = []
        self.fail_list = False
        self.fail_write = False
        self.fail_search = False
        self.agents_api = FakeAgents(self)

    # 让 `client.agents` 能直接调，同时保留 `agents_api` 便于断言
    @property
    def agents_resource(self):  # pragma: no cover - 兼容写法
        return self.agents_api


class _FakeClientWrapper:
    """把 FakeLetta 的 `agents` 暴露成 client.agents（与 SDK 一致）。"""

    def __init__(self, fake: FakeLetta) -> None:
        self._fake = fake
        self.agents = fake.agents_api


class BackendTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = BotStore(Path(self._tmp.name) / "botd.sqlite3")
        self.fake = FakeLetta()
        self.client = _FakeClientWrapper(self.fake)
        self.backend = LettaClientBackend(client=self.client)

    # ------------------------------------------------------------------ 写入
    def test_remember_creates_agent_lazily_and_writes_passage(self) -> None:
        self.assertEqual(self.fake.agents, [], "写入前不该有 agent")
        passage_id = self.backend.remember("bot1", "电池电压偏低会导致丢星", key="power")
        self.assertTrue(passage_id)
        self.assertEqual(len(self.fake.agents), 1)
        self.assertEqual(self.fake.agents[0]["name"], "bot1")
        self.assertEqual(self.fake.passages[0]["text"], "电池电压偏低会导致丢星")

    def test_key_goes_into_tags_not_into_body(self) -> None:
        """正文必须就是内容本身 —— 否则召回要再剥前缀，内容含 key: 时会切错。"""
        self.backend.remember("bot1", "内容里本来就有 key: 这种字样", key="power")
        passage = self.fake.passages[0]
        self.assertEqual(passage["text"], "内容里本来就有 key: 这种字样")
        self.assertIn("key:power", passage["tags"])

    def test_remember_reuses_existing_agent(self) -> None:
        self.backend.remember("bot1", "第一条")
        self.backend.remember("bot1", "第二条")
        self.assertEqual(len(self.fake.agents), 1, "同一个 bot 不该建两个 agent")
        self.assertEqual(len(self.fake.passages), 2)

    def test_different_bots_get_different_agents(self) -> None:
        self.backend.remember("bot1", "一")
        self.backend.remember("bot2", "二")
        names = [a["name"] for a in self.fake.agents]
        self.assertEqual(names, ["bot1", "bot2"])

    # ------------------------------------------------------------------ 召回
    def test_recall_returns_empty_for_unknown_bot_without_creating_agent(self) -> None:
        """召回不该凭空造 agent —— 否则 Letta 侧对象数量与我们的 bot 表对不上。"""
        results = self.backend.recall("never-seen", "任意查询")
        self.assertEqual(results, [])
        self.assertEqual(self.fake.agents, [])

    def test_recall_recovers_key_from_tags(self) -> None:
        self.backend.remember("bot1", "低电压会丢星", key="power")
        results = self.backend.recall("bot1", "丢星")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["key"], "power")
        self.assertEqual(results[0]["content"], "低电压会丢星")
        self.assertEqual(results[0]["backend"], "letta")
        self.assertFalse(results[0]["degraded"])

    def test_recall_respects_limit(self) -> None:
        for i in range(5):
            self.backend.remember("bot1", f"丢星记录 {i}")
        results = self.backend.recall("bot1", "丢星", limit=2)
        self.assertEqual(len(results), 2)

    # ------------------------------------------------------------------ 可用性
    def test_available_true_when_service_answers(self) -> None:
        backend = LettaClientBackend(client=self.client)
        self.assertTrue(backend.available())
        self.assertEqual(backend.reason, "")

    def test_available_false_and_reason_when_service_down(self) -> None:
        self.fake.fail_list = True
        backend = LettaClientBackend(client=self.client)
        self.assertFalse(backend.available())
        self.assertIn("不可达", backend.reason)
        self.assertIn("connection refused", backend.reason)

    def test_available_false_when_client_missing(self) -> None:
        """没装 letta_client 时必须说清是缺包，而不是"服务不可达"。"""
        backend = LettaClientBackend()
        self.assertIsNone(backend._client)

        import importlib.util as real_util
        saved = real_util.find_spec

        def _no_spec(name):
            return None

        real_util.find_spec = _no_spec
        try:
            self.assertFalse(backend.available())
            self.assertIn("未安装", backend.reason)
        finally:
            real_util.find_spec = saved

    def test_build_default_backend_returns_none_when_unavailable(self) -> None:
        self.fake.fail_list = True
        self.assertIsNone(build_default_backend(client=self.client))

    def test_build_default_backend_returns_backend_when_available(self) -> None:
        backend = build_default_backend(client=self.client)
        self.assertIsNotNone(backend)
        self.assertEqual(backend.name, "letta")


class WithBotMemoryTest(BackendTestBase):
    """与 `BotMemory` 的组合：外部生效、失败降级、状态如实。"""

    def test_external_backend_is_used_when_healthy(self) -> None:
        memory = BotMemory(self.store, backend=self.backend)
        row = memory.remember("bot1", "外部写入", key="k1")
        self.assertEqual(row["backend"], "letta")
        self.assertTrue(row["external_id"])

        results = memory.recall("bot1", "外部")
        self.assertTrue(results)
        self.assertFalse(results[0]["degraded"])

    def test_write_failure_degrades_to_local_and_marks_rows(self) -> None:
        memory = BotMemory(self.store, backend=self.backend)
        memory.remember("bot1", "先写一条正常的")
        self.fake.fail_write = True

        row = memory.remember("bot1", "这次会失败")
        self.assertEqual(row["backend"], "local-fallback")
        self.assertTrue(memory.degraded)
        self.assertIn("connection refused", memory.degraded_reason)

        # 本地仍然是事实来源：失败的那条照样能召回
        results = memory.recall("bot1", "失败")
        self.assertTrue(results)
        self.assertEqual(results[0]["content"], "这次会失败")
        self.assertTrue(results[0]["degraded"])

    def test_search_failure_falls_back_to_local(self) -> None:
        """agent 已存在、检索失败 → 才该降级。

        先 `remember` 一条，让 agent 真的建出来；否则 `recall` 会在
        "agent 不存在"这一步就返回空列表（那是正确行为，不是故障）。
        """
        memory = BotMemory(self.store, backend=self.backend)
        memory.remember("bot1", "外部先写一条")
        self.assertFalse(memory.degraded, "写入成功时不该已经降级")

        self.store.add_memory("bot1", "本地兜底内容")
        self.fake.fail_search = True

        results = memory.recall("bot1", "本地")
        self.assertTrue(results)
        self.assertEqual(results[0]["content"], "本地兜底内容")
        self.assertTrue(memory.degraded)
        self.assertIn("connection refused", memory.degraded_reason)

    def test_missing_agent_is_not_a_failure(self) -> None:
        """「这个 bot 还没记忆」与「记忆服务挂了」必须分开，否则首次查询被记成故障。"""
        memory = BotMemory(self.store, backend=self.backend)
        self.store.add_memory("bot1", "本地内容")
        results = memory.recall("bot1", "本地")
        self.assertTrue(results)
        self.assertFalse(memory.degraded, "agent 不存在不该被当成服务故障")

    def test_status_reports_backend_and_degradation(self) -> None:
        memory = BotMemory(self.store, backend=self.backend)
        status = memory.status()
        self.assertEqual(status["backend"], "letta")
        self.assertFalse(status["degraded"])
        self.assertIn("letta", status["external"])


if __name__ == "__main__":
    unittest.main()
