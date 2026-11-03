#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``tools/agent_store.py``：会话 JSONL、原子写、产物与设置。

测试全部落在 ``tempfile`` 目录里，不读也不写用户的
``%LOCALAPPDATA%\\AllPoweredFSA``。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import agent_store  # noqa: E402


class DefaultDataDir(unittest.TestCase):
    def test_uses_env_override(self):
        with mock.patch.dict(os.environ, {agent_store.ENV_DATA_DIR: r"D:\fsa-data"}):
            self.assertEqual(str(agent_store.default_data_dir()), r"D:\fsa-data")

    def test_uses_localappdata_when_no_override(self):
        env = {k: v for k, v in os.environ.items() if k != agent_store.ENV_DATA_DIR}
        env["LOCALAPPDATA"] = r"C:\Users\x\AppData\Local"
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(agent_store.default_data_dir(),
                             Path(r"C:\Users\x\AppData\Local") / "AllPoweredFSA")


class SessionLifecycle(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = agent_store.SessionStore(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_create_writes_meta_first_line(self):
        meta = self.store.create_session("  第一轮  ")
        path = self.store.session_path(meta["session_id"])
        self.assertTrue(path.is_file())
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        first = json.loads(lines[0])
        self.assertEqual(first["type"], "meta")
        self.assertEqual(first["session_id"], meta["session_id"])
        self.assertEqual(first["title"], "第一轮")
        self.assertIn("created_at", first)

    def test_default_title_and_unique_ids(self):
        a = self.store.create_session()
        b = self.store.create_session()
        self.assertNotEqual(a["session_id"], b["session_id"])
        self.assertEqual(a["title"], agent_store.DEFAULT_SESSION_TITLE)

    def test_duplicate_id_rejected(self):
        meta = self.store.create_session()
        with self.assertRaises(agent_store.StoreError):
            self.store.create_session(session_id=meta["session_id"])

    def test_append_and_load_roundtrip(self):
        sid = self.store.create_session("会话")["session_id"]
        first = self.store.append_event(sid, {"type": "message", "id": "m1",
                                              "role": "user", "content": "你好"})
        self.assertIn("ts", first)
        self.store.append_event(sid, {"type": "tool_result", "id": "c1",
                                      "ok": True, "summary": "好"})
        loaded = self.store.load(sid)
        self.assertEqual(loaded["session"]["id"] if "id" in loaded["session"] else
                         loaded["session"]["session_id"], sid)
        self.assertEqual(len(loaded["events"]), 2)
        self.assertEqual([e["type"] for e in loaded["events"]],
                         ["message", "tool_result"])
        self.assertEqual(loaded["events"][0]["content"], "你好")

    def test_append_requires_known_session(self):
        with self.assertRaises(agent_store.SessionNotFound):
            self.store.append_event("sdeadbeef0000", {"type": "message"})

    def test_append_rejects_meta_and_missing_type(self):
        sid = self.store.create_session()["session_id"]
        with self.assertRaises(ValueError):
            self.store.append_event(sid, {"type": "meta"})
        with self.assertRaises(ValueError):
            self.store.append_event(sid, {"id": "x"})
        with self.assertRaises(ValueError):
            self.store.append_event(sid, "not a dict")

    def test_event_must_be_json_serializable(self):
        sid = self.store.create_session()["session_id"]
        with self.assertRaises(agent_store.StoreError):
            self.store.append_event(sid, {"type": "message", "bad": object()})

    def test_list_sorted_by_last_event(self):
        older = self.store.create_session("旧")["session_id"]
        newer = self.store.create_session("新")["session_id"]
        self.store.append_event(older, {"type": "message", "id": "m1",
                                        "ts": "2026-01-01T00:00:00.000000+00:00"})
        self.store.append_event(newer, {"type": "message", "id": "m2",
                                        "ts": "2026-02-01T00:00:00.000000+00:00"})
        listed = self.store.list_sessions()
        self.assertEqual([item["id"] for item in listed], [newer, older])
        self.assertEqual(listed[0]["title"], "新")
        self.assertEqual(set(listed[0]), {"id", "title", "updated_at"})

    def test_list_skips_corrupt_file(self):
        good = self.store.create_session("好的")["session_id"]
        bad_path = self.store.sessions_dir / "sbadbadbadbad.jsonl"
        bad_path.write_text("{not json}\n", encoding="utf-8")
        listed = self.store.list_sessions()
        self.assertEqual([item["id"] for item in listed], [good])

    def test_rename_keeps_events_and_updates_meta(self):
        sid = self.store.create_session("旧标题")["session_id"]
        self.store.append_event(sid, {"type": "message", "id": "m1", "content": "x"})
        self.store.rename_session(sid, "新标题")
        loaded = self.store.load(sid)
        self.assertEqual(loaded["session"]["title"], "新标题")
        self.assertEqual(len(loaded["events"]), 1)
        first = json.loads(self.store.session_path(sid)
                           .read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(first["title"], "新标题")

    def test_rename_requires_title(self):
        sid = self.store.create_session()["session_id"]
        with self.assertRaises(ValueError):
            self.store.rename_session(sid, "   ")

    def test_delete_removes_session_and_artifacts(self):
        sid = self.store.create_session()["session_id"]
        self.store.write_artifact(sid, "a.json", b"{}")
        self.assertTrue(self.store.artifact_dir(sid, create=False).is_dir())
        self.store.delete_session(sid)
        self.assertFalse(self.store.exists(sid))
        self.assertFalse(self.store.artifact_dir(sid, create=False).exists())
        with self.assertRaises(agent_store.SessionNotFound):
            self.store.delete_session(sid)

    def test_invalid_session_id_cannot_traverse(self):
        for bad in ("../x", "", "a/b", "a\\b", "x" * 65, "s1.jsonl"):
            with self.assertRaises(ValueError):
                self.store.session_path(bad)
        self.assertFalse(self.store.exists("../x"))

    def test_corrupt_session_file_raises_store_error(self):
        sid = self.store.create_session()["session_id"]
        self.store.session_path(sid).write_text("{oops}\n", encoding="utf-8")
        with self.assertRaises(agent_store.StoreError):
            self.store.load(sid)

    def test_missing_meta_line_is_store_error(self):
        sid = self.store.create_session()["session_id"]
        self.store.session_path(sid).write_text(
            json.dumps({"type": "message"}) + "\n", encoding="utf-8")
        with self.assertRaises(agent_store.StoreError):
            self.store.load(sid)


class Concurrency(unittest.TestCase):
    def test_parallel_appends_stay_one_event_per_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = agent_store.SessionStore(tmp)
            sid = store.create_session()["session_id"]
            threads = []
            errors: list[BaseException] = []

            def worker(index: int):
                try:
                    for n in range(25):
                        store.append_event(sid, {"type": "message", "id": f"m{index}-{n}",
                                                 "content": "x" * 200})
                except BaseException as exc:  # pragma: no cover - 失败时才走
                    errors.append(exc)

            for index in range(8):
                thread = threading.Thread(target=worker, args=(index,))
                threads.append(thread)
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
            self.assertEqual(errors, [])
            lines = store.session_path(sid).read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1 + 8 * 25)
            events = [json.loads(line) for line in lines]
            self.assertEqual(events[0]["type"], "meta")
            ids = [event["id"] for event in events[1:]]
            self.assertEqual(len(ids), len(set(ids)))


class Artifacts(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = agent_store.SessionStore(self._tmp.name)
        self.sid = self.store.create_session()["session_id"]

    def tearDown(self):
        self._tmp.cleanup()

    def test_write_artifact_hashes_and_relative_path(self):
        payload = b"hello artifact"
        info = self.store.write_artifact(self.sid, "报告.pdf", payload)
        self.assertEqual(info["name"], "报告.pdf")
        self.assertEqual(info["kind"], "pdf")
        self.assertEqual(info["path"], f"artifacts/{self.sid}/报告.pdf")
        self.assertEqual(info["size"], len(payload))
        import hashlib
        self.assertEqual(info["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertTrue((self.store.data_dir / info["path"]).is_file())

    def test_unsafe_names_are_flattened(self):
        info = self.store.write_artifact(self.sid, "..\\..\\evil.json", b"{}")
        self.assertEqual(info["name"], "evil.json")
        self.assertEqual(info["kind"], "json")
        self.assertTrue((self.store.artifact_dir(self.sid) / "evil.json").is_file())

    def test_list_artifacts(self):
        self.store.write_artifact(self.sid, "a.csv", b"x,y\n")
        self.store.write_artifact(self.sid, "b.png", b"\x89PNG")
        names = [item["name"] for item in self.store.list_artifacts(self.sid)]
        self.assertEqual(names, ["a.csv", "b.png"])
        self.assertEqual(self.store.list_artifacts(self.sid)[0]["kind"], "csv")

    def test_artifact_for_unknown_session(self):
        with self.assertRaises(agent_store.SessionNotFound):
            self.store.write_artifact("sdeadbeef0000", "a.json", b"{}")
        with self.assertRaises(agent_store.SessionNotFound):
            self.store.list_artifacts("sdeadbeef0000")


class Settings(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = agent_store.SessionStore(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_is_empty(self):
        self.assertEqual(self.store.read_settings(), {})

    def test_roundtrip_is_atomic_and_leaves_no_temp_files(self):
        self.store.write_settings({"provider": "fake", "temperature": 0.0})
        self.assertEqual(self.store.read_settings(),
                         {"provider": "fake", "temperature": 0.0})
        leftovers = [p.name for p in self.store.data_dir.iterdir()
                     if p.name.startswith(".settings.json")]
        self.assertEqual(leftovers, [])
        text = self.store.settings_path.read_text(encoding="utf-8")
        self.assertIn('"provider"', text)

    def test_update_merges(self):
        self.store.write_settings({"provider": "fake", "model": "a"})
        merged = self.store.update_settings({"model": "b"})
        self.assertEqual(merged, {"provider": "fake", "model": "b"})
        self.assertEqual(self.store.read_settings()["model"], "b")

    def test_corrupt_settings_raise_instead_of_resetting(self):
        self.store.settings_path.write_text("{broken", encoding="utf-8")
        with self.assertRaises(agent_store.StoreError):
            self.store.read_settings()

    def test_non_object_settings_rejected(self):
        self.store.settings_path.write_text("[1, 2]", encoding="utf-8")
        with self.assertRaises(agent_store.StoreError):
            self.store.read_settings()

    def test_ensure_dirs(self):
        self.store.ensure_dirs()
        for path in (self.store.sessions_dir, self.store.artifacts_root,
                     self.store.exports_dir):
            self.assertTrue(path.is_dir())


if __name__ == "__main__":
    unittest.main()
