"""E2 botd 记忆：写入、关键词召回、按 bot 隔离、外部后端降级。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from fieldstation.botd.memory import (
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


if __name__ == "__main__":
    unittest.main()
