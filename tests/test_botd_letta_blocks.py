# -*- coding: utf-8 -*-
"""Bot-5 验收：Letta 真接（memory blocks）。

计划书两条验收：

| 情形 | 期望 |
|---|---|
| 有真服务 | 记忆块写入可查 |
| 服务关闭 | 降级不崩，且结果里有 ``memory_missing`` 标记 |

本机**没有**跑 Letta 服务（要 Postgres + 一整套 FastAPI），所以"有真服务"
这一条用**假客户端**验：假客户端实现 ``agents`` / ``blocks`` 的真实调用形状
（读自 ``letta-client`` 1.12.1 的签名，不是猜的）。这样验的是适配器的逻辑，
不是网络的连通性 —— 后者只能等真服务到位再验，那一点在文档里写明。

第二条用**真的连不上**来验：不注入客户端，指向一个必然没人听的端口。
"""
from __future__ import annotations

import socket
import tempfile
import unittest
from pathlib import Path

from fieldstation.botd import letta as letta_mod
from fieldstation.botd.letta import LettaClientBackend
from fieldstation.botd.memory import BotMemory
from fieldstation.botd.store import BotStore


# --------------------------------------------------------------- 假 Letta --
class _Obj:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class _FakeBlocksAPI:
    """``client.agents.blocks`` 的最小实现，签名对齐 letta-client 1.12.1。"""

    def __init__(self, owner) -> None:
        self.owner = owner

    def retrieve(self, block_label: str, *, agent_id: str):
        store = self.owner.blocks_by_agent.get(agent_id, {})
        if block_label not in store:
            raise RuntimeError(f"没有 block {block_label}")
        return _Obj(id=f"blk-{block_label}", label=block_label,
                    value=store[block_label])

    def update(self, block_label: str, *, agent_id: str, value=None, **kwargs):
        store = self.owner.blocks_by_agent.setdefault(agent_id, {})
        if block_label not in store:
            raise RuntimeError(f"没有 block {block_label}")
        if value is not None:
            store[block_label] = value
        return _Obj(id=f"blk-{block_label}", label=block_label,
                    value=store[block_label])

    def attach(self, block_id: str, *, agent_id: str, **kwargs):
        # 真实 API 是 attach(block_id, agent_id=...)
        self.owner.attached.append((agent_id, block_id))
        return _Obj(id=block_id)


class _FakeAgentsAPI:
    def __init__(self, owner) -> None:
        self.owner = owner
        self.blocks = _FakeBlocksAPI(owner)

    def list(self, limit: int = 200, **kwargs):
        return [_Obj(id=aid, name=name)
                for name, aid in self.owner.agents_by_name.items()]

    def create(self, *, name: str, memory_blocks=None, **kwargs):
        agent_id = f"agent-{name}"
        self.owner.agents_by_name[name] = agent_id
        self.owner.blocks_by_agent[agent_id] = {
            blk["label"]: blk["value"] for blk in (memory_blocks or [])
        }
        return _Obj(id=agent_id, name=name)


class _FakePassagesAPI:
    def __init__(self, owner) -> None:
        self.owner = owner

    def create(self, *, agent_id: str, text: str, tags=None, metadata=None):
        passage_id = f"passage-{len(self.owner.passages) + 1}"
        self.owner.passages.append({
            "id": passage_id, "agent_id": agent_id,
            "text": text, "tags": list(tags or []),
        })
        return _Obj(id=passage_id)

    def search(self, *, agent_id: str, query: str, limit: int = 5):
        hits = [p for p in self.owner.passages if p["agent_id"] == agent_id]
        return [_Obj(id=p["id"], text=p["text"], tags=p["tags"], score=0.9)
                for p in hits[:limit]]


class _FakeAgentScoped:
    def __init__(self, owner) -> None:
        self.owner = owner
        self.passages = _FakePassagesAPI(owner)


class _FakeLetta:
    """够用的假客户端：agents / passages / blocks 三条路径都有。"""

    def __init__(self) -> None:
        self.agents_by_name: dict[str, str] = {}
        self.blocks_by_agent: dict[str, dict[str, str]] = {}
        self.passages: list[dict] = []
        self.attached: list[tuple[str, str]] = []
        self._agents = _FakeAgentsAPI(self)
        self._agent_scoped = _FakeAgentScoped(self)
        self._blocks = _FakeBlockRoot(self)

    @property
    def agents(self):
        return self._agents

    @property
    def blocks(self):
        return self._blocks


class _FakeBlockRoot:
    def __init__(self, owner) -> None:
        self.owner = owner

    def create(self, *, label: str, value: str, **kwargs):
        self.owner.blocks_by_agent.setdefault("_detached", {})[label] = value
        return _Obj(id=f"blk-new-{label}", label=label, value=value)


def _agent_scoped_passages(client):
    """``client.agents.passages`` —— 真实客户端挂在 agents 上。"""
    return client._agent_scoped.passages


# ---------------------------------------------------------------- 用例 --
class FakeServiceTest(unittest.TestCase):
    """"有真服务"这一半：用假客户端验适配器逻辑。"""

    def setUp(self) -> None:
        self.client = _FakeLetta()
        # 真实客户端把 passages 挂在 agents 上
        self.client.agents.passages = _agent_scoped_passages(self.client)
        self.backend = LettaClientBackend(client=self.client)

    def test_available_with_injected_client(self) -> None:
        self.assertTrue(self.backend.available())

    def test_write_then_read_block(self) -> None:
        """记忆块写入可查（计划书第一条验收）。"""
        written = self.backend.write_block("bot-1", "当前关注：WUHN 连续缺测")
        self.assertEqual(written["value"], "当前关注：WUHN 连续缺测")
        self.assertEqual(written["label"], letta_mod.BLOCK_LABEL)

        read = self.backend.read_block("bot-1")
        self.assertIsNotNone(read, "写进去的块应该能读回来")
        self.assertEqual(read["value"], "当前关注：WUHN 连续缺测")
        self.assertFalse(read["degraded"])

    def test_read_block_returns_none_for_unknown_bot(self) -> None:
        """没有 agent 时返回 None，不抛异常 —— 那是正常状态。"""
        self.assertIsNone(self.backend.read_block("nobody"))

    def test_remember_and_recall_passage(self) -> None:
        passage_id = self.backend.remember(
            "bot-1", "去年同月也出现过同样的缺测", key="case", tags=["history"])
        self.assertTrue(passage_id)
        hits = self.backend.recall("bot-1", "缺测")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["key"], "case")
        self.assertEqual(hits[0]["content"], "去年同月也出现过同样的缺测")
        self.assertNotIn("key:case", hits[0]["tags"])   # key 从 tags 里剥离了

    def test_recall_does_not_create_agent(self) -> None:
        """召回不该顺手建 agent —— 否则对象数量会和 bot 表对不上。"""
        self.backend.recall("ghost-bot", "anything")
        self.assertNotIn("ghost-bot", self.client.agents_by_name)


class MemoryFacadeTest(unittest.TestCase):
    """门面层：只在首尾 + 降级留痕。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = BotStore(Path(self._tmp.name) / "botd.sqlite")
        self.client = _FakeLetta()
        self.client.agents.passages = _agent_scoped_passages(self.client)
        self.backend = LettaClientBackend(client=self.client)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_recall_at_start_reads_block_and_items(self) -> None:
        self.backend.write_block("bot-1", "旧摘要")
        self.backend.remember("bot-1", "一条旧记忆", key="k1")
        memory = BotMemory(self.store, backend=self.backend)
        out = memory.recall_at_start("bot-1", "记忆")
        self.assertFalse(out["memory_missing"], out["reason"])
        self.assertEqual(out["block"]["value"], "旧摘要")
        self.assertEqual(len(out["items"]), 1)

    def test_remember_at_end_writes_both(self) -> None:
        memory = BotMemory(self.store, backend=self.backend)
        out = memory.remember_at_end(
            "bot-1", "本轮结论：接收机重启后恢复", block_value="当前摘要：已恢复")
        self.assertFalse(out["memory_missing"], out["reason"])
        self.assertEqual(out["block"]["value"], "当前摘要：已恢复")
        # 归档 passage 也写进去了
        self.assertEqual(len(self.client.passages), 1)
        # 本地库仍然有（SQLite 是事实来源）
        rows = self.store.list_memory("bot-1")
        self.assertEqual(len(rows), 1)

    def test_no_backend_marks_memory_missing(self) -> None:
        """没有外部后端时，两个入口都要带 ``memory_missing``。"""
        memory = BotMemory(self.store, backend=None)
        start = memory.recall_at_start("bot-1", "x")
        self.assertTrue(start["memory_missing"])
        end = memory.remember_at_end("bot-1", "内容")
        self.assertTrue(end["memory_missing"])
        # 但本地写入照常成功（降级不崩）
        self.assertEqual(len(self.store.list_memory("bot-1")), 1)

    def test_block_write_failure_degrades_but_does_not_crash(self) -> None:
        """写块炸了只影响镜像，不把任务判失败。"""
        class _Broken(LettaClientBackend):
            def write_block(self, bot_id, value):
                raise RuntimeError("块服务 500")

        broken = _Broken(client=self.client)
        memory = BotMemory(self.store, backend=broken)
        out = memory.remember_at_end("bot-1", "内容", block_value="摘要")
        self.assertTrue(out["memory_missing"])
        self.assertIn("500", out["reason"])
        # 本地那条仍然在
        self.assertEqual(len(self.store.list_memory("bot-1")), 1)


class NoServiceTest(unittest.TestCase):
    """服务关闭：真连不上。"""

    def test_unreachable_service_degrades_without_crashing(self) -> None:
        # 找一个确定没人听的端口：绑上再放开
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            dead_port = sock.getsockname()[1]

        backend = LettaClientBackend(
            base_url=f"http://127.0.0.1:{dead_port}", timeout=1.0)
        # 装是装了，但服务答不上话 —— 这就是 must-degrade 的状态
        self.assertFalse(backend.available(),
                         "没人听的端口不该被判成可用")
        self.assertTrue(backend.reason, "降级必须留下原因")

        with tempfile.TemporaryDirectory() as td:
            store = BotStore(Path(td) / "botd.sqlite")
            memory = BotMemory(store, backend=backend)
            # 构造时就该降级，而不是等到第一次写入才炸
            self.assertTrue(memory.degraded)
            out = memory.remember_at_end("bot-1", "写一条", key="k")
            self.assertTrue(out["memory_missing"])
            self.assertEqual(len(store.list_memory("bot-1")), 1,
                             "降级后本地写入必须成功")


class InstalledButNoServiceTest(unittest.TestCase):
    """客户端装了、服务没起：``available()`` 必须说"不可用"。"""

    def test_available_false_when_service_absent(self) -> None:
        import importlib.util

        if importlib.util.find_spec("letta_client") is None:
            self.skipTest("本机没装 letta_client（可选依赖）")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            dead_port = sock.getsockname()[1]
        backend = LettaClientBackend(
            base_url=f"http://127.0.0.1:{dead_port}", timeout=1.0)
        self.assertFalse(backend.available())
        # 关键：不能因为"包装了"就说可用
        self.assertIn("不可达", backend.reason)


if __name__ == "__main__":
    unittest.main()
