"""E2 botd 沙箱：只允许 ``workspace/<bot_id>/`` 下的相对路径。"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fieldstation.botd.sandbox import SandboxViolation, WorkspaceSandbox


class SandboxTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.sandbox = WorkspaceSandbox(self.root)


class TestResolve(SandboxTestBase):
    def test_relative_paths_stay_inside_bot_workspace(self) -> None:
        path = self.sandbox.resolve("bot1", "notes/2026-11-05.txt")
        base = self.root / "workspace" / "bot1"
        self.assertEqual(path, base / "notes" / "2026-11-05.txt")

    def test_dot_resolves_to_bot_root(self) -> None:
        self.assertEqual(
            self.sandbox.resolve("bot1", "."), self.root / "workspace" / "bot1"
        )
        self.assertEqual(self.sandbox.resolve("bot1", ""), self.sandbox.resolve("bot1"))

    def test_write_read_and_list(self) -> None:
        written = self.sandbox.write_text("bot1", "reports/qc.txt", "缺测率 0.3%")
        self.assertTrue(written.is_file())
        self.assertEqual(self.sandbox.read_text("bot1", "reports/qc.txt"), "缺测率 0.3%")
        self.assertTrue(self.sandbox.exists("bot1", "reports/qc.txt"))
        self.assertEqual(self.sandbox.listdir("bot1"), ["reports"])
        self.assertEqual(self.sandbox.listdir("bot1", "reports"), ["qc.txt"])
        self.assertEqual(
            self.sandbox.relative("bot1", written), "reports/qc.txt"
        )

    def test_bots_are_isolated(self) -> None:
        self.sandbox.write_text("bot1", "a.txt", "one")
        self.assertFalse(self.sandbox.exists("bot2", "a.txt"))
        self.assertNotEqual(
            self.sandbox.resolve("bot1", "a.txt"),
            self.sandbox.resolve("bot2", "a.txt"),
        )


class TestRejections(SandboxTestBase):
    def assert_blocked(self, relpath, bot_id: str = "bot1") -> None:
        with self.assertRaises(SandboxViolation, msg=f"应当拒绝：{relpath!r}"):
            self.sandbox.resolve(bot_id, relpath)

    def test_dotdot_is_rejected_even_mid_path(self) -> None:
        for relpath in ("../secret.txt", "a/../../secret.txt", "a\\..\\..\\secret.txt",
                        "..", "a/.."):
            self.assert_blocked(relpath)

    def test_absolute_paths_and_drive_letters_are_rejected(self) -> None:
        for relpath in (
            "/etc/passwd",
            "C:\\Windows\\System32\\drivers\\etc\\hosts",
            "C:/Windows/win.ini",
            "C:relative",
            "\\\\server\\share\\file.txt",
            "//server/share/file.txt",
        ):
            self.assert_blocked(relpath)

    def test_alternate_data_stream_and_nul_are_rejected(self) -> None:
        self.assert_blocked("report.txt:secret")
        self.assert_blocked("a/\x00/b")

    def test_bad_bot_ids_are_rejected(self) -> None:
        for bot_id in ("", "   ", ".", "..", "a/b", "a\\b", "bot:1", "-leading",
                       "bot id"):
            with self.assertRaises(SandboxViolation, msg=f"应当拒绝 bot_id={bot_id!r}"):
                self.sandbox.resolve(bot_id, "x.txt")

    def test_relative_rejects_paths_outside(self) -> None:
        outside = self.root / "elsewhere.txt"
        with self.assertRaises(SandboxViolation):
            self.sandbox.relative("bot1", outside)

    def test_writing_to_workspace_root_itself_is_rejected(self) -> None:
        with self.assertRaises(SandboxViolation):
            self.sandbox.write_text("bot1", ".", "x")


class TestSymlinks(SandboxTestBase):
    def test_symlink_on_path_is_rejected_via_probe(self) -> None:
        self.sandbox.write_text("bot1", "ok.txt", "ok")
        real = self.sandbox.resolve("bot1", "link")
        # 在无权限创建符号链接的机器上，用探测点验证拒绝分支。
        with mock.patch(
            "fieldstation.botd.sandbox._is_symlink",
            side_effect=lambda path: Path(path) == real,
        ):
            with self.assertRaises(SandboxViolation):
                self.sandbox.resolve("bot1", "link/secret.txt")

    def test_symlinked_bot_root_is_rejected_via_probe(self) -> None:
        bot_root = self.sandbox.bot_root("bot1")
        with mock.patch(
            "fieldstation.botd.sandbox._is_symlink",
            side_effect=lambda path: Path(path) == bot_root,
        ):
            with self.assertRaises(SandboxViolation):
                self.sandbox.resolve("bot1", "x.txt")

    def test_real_symlink_escape_is_rejected_when_supported(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("secret", encoding="utf-8")
        base = self.sandbox.bot_root("bot1", create=True)
        link = base / "escape"
        try:
            os.symlink(str(outside), str(link), target_is_directory=True)
        except (OSError, NotImplementedError):
            # Windows 未开开发者模式时建不了真实链接；改用探测点走同一条拒绝分支，
            # 保证本用例在任何机器上都真的断言了行为，而不是静默跳过。
            with mock.patch(
                "fieldstation.botd.sandbox._is_symlink",
                side_effect=lambda path: Path(path) == link,
            ):
                with self.assertRaises(SandboxViolation):
                    self.sandbox.resolve("bot1", "escape/secret.txt")
            return
        with self.assertRaises(SandboxViolation):
            self.sandbox.resolve("bot1", "escape/secret.txt")


if __name__ == "__main__":
    unittest.main()
