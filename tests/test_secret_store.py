#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``tools/secret_store.py`` 的测试：真实路径 + 真实 DPAPI（Windows 上）。

不 mock 加密本身 —— mock 掉了就只在测「自己写的假加密」。唯一被替换的是
``_dpapi_available``（非 Windows 降级分支那条用例），因为要在一台 Windows
机器上走到「没有 DPAPI」的代码路径，只能显式改判定。

用例覆盖：往返、覆盖、删除、文件不存在、损坏文件、空值拒写、空文件、
非 Windows 降级文件带标记且能读回、落盘字节里不出现明文 key。
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools import secret_store

VALUE = "sk-live-1234567890abcdef"


class _TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "secrets.bin"


class TestRoundtrip(_TempDirCase):
    def test_save_then_load(self):
        secret_store.save_secret(self.path, VALUE)
        self.assertTrue(self.path.is_file())
        self.assertEqual(secret_store.load_secret(self.path), VALUE)
        self.assertTrue(secret_store.has_secret(self.path))

    def test_value_is_stripped_before_write(self):
        """粘贴常带换行：strip 后存，读回来就是干净的 key。"""
        secret_store.save_secret(self.path, f"  {VALUE}\r\n")
        self.assertEqual(secret_store.load_secret(self.path), VALUE)

    def test_parent_directory_is_created(self):
        nested = Path(self._tmp.name) / "a" / "b" / "secrets.bin"
        secret_store.save_secret(nested, VALUE)
        self.assertEqual(secret_store.load_secret(nested), VALUE)

    def test_overwrite_replaces_old_value(self):
        secret_store.save_secret(self.path, VALUE)
        secret_store.save_secret(self.path, "sk-second-999")
        self.assertEqual(secret_store.load_secret(self.path), "sk-second-999")
        self.assertNotIn(VALUE.encode("utf-8"), self.path.read_bytes())

    def test_no_temp_file_left_behind(self):
        secret_store.save_secret(self.path, VALUE)
        leftovers = [p.name for p in self.path.parent.iterdir()
                     if p.name != self.path.name]
        self.assertEqual(leftovers, [])

    def test_saved_file_never_stores_plaintext(self):
        """DPAPI 分支盘上不得出现明文；降级分支必须带明文标记。"""
        secret_store.save_secret(self.path, VALUE)
        raw = self.path.read_bytes()
        if secret_store.backend() == "dpapi":
            self.assertNotIn(VALUE.encode("utf-8"), raw)
            self.assertTrue(raw.startswith(secret_store.PROTECTED_PREFIX))
        else:
            self.assertTrue(raw.startswith(secret_store.PLAINTEXT_PREFIX))


class TestMissingAndDamaged(_TempDirCase):
    def test_missing_file_returns_none(self):
        self.assertIsNone(secret_store.load_secret(self.path))
        self.assertFalse(secret_store.has_secret(self.path))

    def test_empty_file_returns_none(self):
        self.path.write_bytes(b"")
        self.assertIsNone(secret_store.load_secret(self.path))
        self.assertFalse(secret_store.has_secret(self.path))

    def test_garbage_file_returns_none(self):
        self.path.write_bytes(b"\x00\xff this is not a secret")
        self.assertIsNone(secret_store.load_secret(self.path))

    def test_truncated_dpapi_blob_returns_none(self):
        self.path.write_bytes(secret_store.PROTECTED_PREFIX + b"\x01\x02\x03\x04")
        self.assertIsNone(secret_store.load_secret(self.path))

    def test_prefix_only_returns_none(self):
        """有前缀没有内容：不能当成空 key 返回 ''。"""
        self.path.write_bytes(secret_store.PROTECTED_PREFIX)
        self.assertIsNone(secret_store.load_secret(self.path))

    def test_plaintext_marker_with_empty_payload_returns_none(self):
        self.path.write_bytes(secret_store.PLAINTEXT_PREFIX)
        self.assertIsNone(secret_store.load_secret(self.path))


class TestDelete(_TempDirCase):
    def test_delete_existing_returns_true_and_removes(self):
        secret_store.save_secret(self.path, VALUE)
        self.assertTrue(secret_store.delete_secret(self.path))
        self.assertFalse(self.path.exists())
        self.assertIsNone(secret_store.load_secret(self.path))

    def test_delete_missing_returns_false(self):
        self.assertFalse(secret_store.delete_secret(self.path))


class TestEmptyValue(_TempDirCase):
    def test_empty_or_whitespace_value_is_rejected(self):
        for bad in ("", "   ", "\r\n\t"):
            with self.assertRaises(ValueError):
                secret_store.save_secret(self.path, bad)
        self.assertFalse(self.path.exists())

    def test_non_str_value_is_rejected(self):
        with self.assertRaises(TypeError):
            secret_store.save_secret(self.path, b"bytes-not-str")


class TestPlaintextFallback(_TempDirCase):
    """非 Windows 降级分支：文件带明确标记，读写仍然可用。"""

    def test_fallback_writes_marker_and_roundtrips(self):
        with mock.patch.object(secret_store, "_dpapi_available",
                               lambda: False):
            self.assertEqual(secret_store.backend(), "plaintext-fallback")
            secret_store.save_secret(self.path, VALUE)
            raw = self.path.read_bytes()
            self.assertTrue(raw.startswith(secret_store.PLAINTEXT_PREFIX))
            self.assertEqual(secret_store.load_secret(self.path), VALUE)
            self.assertTrue(secret_store.has_secret(self.path))

    def test_fallback_file_permissions_and_roundtrip(self):
        with mock.patch.object(secret_store, "_dpapi_available",
                               lambda: False):
            secret_store.save_secret(self.path, VALUE)
            self.assertEqual(secret_store.load_secret(self.path), VALUE)
        if os.name != "nt":
            # Windows 的 chmod 不改 ACL；那里由 DPAPI 负责，不在这里断言 0600。
            mode = self.path.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)

    def test_dpapi_blob_is_unreadable_without_dpapi(self):
        """换到没有 DPAPI 的环境：密文必须被当成不可用，而不是明文。"""
        if secret_store.backend() == "dpapi":
            secret_store.save_secret(self.path, VALUE)
        else:
            # 本机没有 DPAPI，造一份“看起来像密文”的样本走同一条读取分支。
            self.path.write_bytes(secret_store.PROTECTED_PREFIX + b"\x01\x02\x03")
        with mock.patch.object(secret_store, "_dpapi_available",
                               lambda: False):
            self.assertIsNone(secret_store.load_secret(self.path))


class TestBackendLabel(unittest.TestCase):
    def test_backend_is_one_of_two_known_values(self):
        self.assertIn(secret_store.backend(), {"dpapi", "plaintext-fallback"})


if __name__ == "__main__":
    unittest.main()
