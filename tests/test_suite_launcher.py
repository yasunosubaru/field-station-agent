#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""原版套件启动器：定位优先级、启动命令行、状态与收尾。

这里**不启动原版套件**：真启动会抢串口、弹窗，还会把本机装的那一份拉起来。
``Popen`` 全部注入/打桩；Windows API 的存活检查与关窗/强杀也只在打桩下走流程。
唯一被真实创建的是临时目录里的空 exe 文件（``b"MZ"``），用来验证 ``exists``。

另外三条钉的是「选择器表跟得上流程」：

1. 新流程点名的逻辑控件都在 ``tools/uia_selectors.json`` 里；
2. 工作流 ``page:`` 里的页面名都能在选择器表里找到（``open`` 按菜单段解析，
   PowerShell 的成员访问不分大小写，所以这里也按小写比对）；
3. ``uia_driver --check`` 的 JSON 有 ``installed/available/selectors/missing``。
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parents[1] / "tools"
EXE = "NovAtelApplicationSuite.exe"


def _load(name: str, filename: str):
    path = TOOLS / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_launcher():
    return _load("suite_launcher_test", "suite_launcher.py")


def _load_uia():
    return _load("uia_driver_suite_test", "uia_driver.py")


class _FakeProc:
    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid


class LauncherCase(unittest.TestCase):
    """每个用例一个临时根，并把真实安装目录/环境变量挡在外面。"""

    def setUp(self):
        self.launcher = _load_launcher()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "repo"

        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(self.launcher.ENV_VAR, None)

        pf = mock.patch.object(self.launcher, "DEFAULT_SUITE", self.tmp / "program-files")
        pf.start()
        self.addCleanup(pf.stop)

    def make_exe(self, directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        exe = directory / EXE
        exe.write_bytes(b"MZ")
        return exe

    def payload_suite(self) -> Path:
        return self.root / "payload" / "original" / "NovAtel Application Suite"

    def popen(self):
        """注入一个只记账的 Popen；返回 (calls, patcher)。"""
        calls: list[tuple[list[str], dict]] = []

        def fake(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return _FakeProc()

        patcher = mock.patch.object(self.launcher.subprocess, "Popen", side_effect=fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls


class FindSuite(LauncherCase):
    def test_env_wins_over_payload_and_program_files(self):
        env_dir = self.tmp / "env-suite"
        exe = self.make_exe(env_dir)
        self.make_exe(self.payload_suite())
        self.make_exe(self.tmp / "program-files")
        os.environ[self.launcher.ENV_VAR] = str(env_dir)

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.dir, env_dir)
        self.assertEqual(suite.exe, exe)
        self.assertTrue(suite.exists)
        self.assertFalse(suite.portable)
        self.assertEqual(suite.source, "env")

    def test_payload_before_program_files(self):
        payload_exe = self.make_exe(self.payload_suite())
        self.make_exe(self.tmp / "program-files")

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.exe, payload_exe)
        self.assertTrue(suite.exists)
        self.assertTrue(suite.portable)
        self.assertEqual(suite.source, "payload")

    def test_program_files_is_the_last_resort(self):
        self.make_exe(self.tmp / "program-files")

        suite = self.launcher.find_suite(self.root)
        self.assertTrue(suite.exists)
        self.assertFalse(suite.portable)
        self.assertEqual(suite.source, "program-files")
        self.assertEqual(suite.exe.name, EXE)

    def test_flat_payload_layout_is_portable(self):
        # tools/build_payload.py 把套件平铺进 original/（arc = "original/<name>"）。
        exe = self.make_exe(self.root / "payload" / "original")
        self.make_exe(self.tmp / "program-files")

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.exe, exe)
        self.assertTrue(suite.portable)
        self.assertTrue(suite.exists)

    def test_packaged_layout_at_root_is_portable(self):
        # 解包后的 app-<version>/ 顶层就是 original/，仓库根不是 <root>/payload。
        exe = self.make_exe(self.root / "original")
        self.make_exe(self.tmp / "program-files")

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.exe, exe)
        self.assertTrue(suite.portable)

    def test_packaged_nested_layout_is_portable(self):
        exe = self.make_exe(self.root / "original" / "NovAtel Application Suite")
        self.make_exe(self.tmp / "program-files")

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.exe, exe)
        self.assertTrue(suite.portable)

    def test_missing_env_falls_through_to_payload(self):
        os.environ[self.launcher.ENV_VAR] = str(self.tmp / "gone")
        payload_exe = self.make_exe(self.payload_suite())

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.exe, payload_exe)
        self.assertEqual(suite.source, "payload")

    def test_nothing_found_reports_the_first_candidate(self):
        suite = self.launcher.find_suite(self.root)
        self.assertFalse(suite.exists)
        self.assertFalse(suite.portable)
        self.assertEqual(suite.dir, self.payload_suite())
        self.assertEqual(suite.exe, self.payload_suite() / EXE)
        self.assertEqual(suite.source, "payload")

    def test_env_may_point_at_the_exe(self):
        exe = self.make_exe(self.tmp / "env-suite")
        os.environ[self.launcher.ENV_VAR] = str(exe)

        suite = self.launcher.find_suite(self.root)
        self.assertEqual(suite.dir, exe.parent)
        self.assertEqual(suite.exe, exe)

    def test_default_root_is_the_repository(self):
        suite = self.launcher.find_suite()
        self.assertEqual(suite.exe.name, EXE)
        self.assertIn(str(self.launcher.ROOT), str(suite.dir))


class Launch(LauncherCase):
    def suite(self):
        self.make_exe(self.payload_suite())
        return self.launcher.find_suite(self.root)

    def test_command_line_is_flag_first_and_never_shell(self):
        suite = self.suite()
        calls = self.popen()

        result = self.launcher.launch(suite, ["--no-sandbox", "--lang=en-US"])
        self.assertTrue(calls[0][0][0].endswith("NASRunner.exe"))
        self.assertEqual(calls[0][0][1:], [
            "--force-renderer-accessibility", "--no-sandbox", "--lang=en-US"])
        self.assertEqual(calls[0][1].get("shell"), False)
        self.assertEqual(calls[0][1].get("cwd"), str(suite.dir))
        self.assertIsInstance(calls[0][0], list)
        self.assertEqual(result["pid"], 4242)
        self.assertEqual(result["cmd"], calls[0][0])
        self.assertTrue(result["portable"])
        self.assertTrue(result["accessibility"])
        self.assertNotIn("ready", result)

    def test_accessibility_flag_is_not_duplicated(self):
        suite = self.suite()
        calls = self.popen()

        self.launcher.launch(suite, ["--force-renderer-accessibility", "--x"])
        cmd = calls[0][0]
        self.assertEqual(cmd.count("--force-renderer-accessibility"), 1)
        self.assertEqual(cmd[1], "--force-renderer-accessibility")

    def test_string_extra_args_is_rejected(self):
        suite = self.suite()
        calls = self.popen()

        with self.assertRaises(ValueError):
            self.launcher.launch(suite, "--no-sandbox")
        self.assertEqual(calls, [])

    def test_missing_exe_raises_and_does_not_start_anything(self):
        calls = self.popen()
        suite = self.launcher.find_suite(self.root)
        self.assertFalse(suite.exists)

        with self.assertRaises(self.launcher.SuiteUnavailable) as ctx:
            self.launcher.launch(suite)
        self.assertIn("没找到原版套件", str(ctx.exception))
        self.assertEqual(calls, [])

    def test_path_input_is_accepted(self):
        suite = self.suite()
        calls = self.popen()

        result = self.launcher.launch(str(suite.dir))
        self.assertTrue(result["cmd"][0].endswith("NASRunner.exe"))
        self.assertEqual(len(calls), 1)

    def test_oserror_is_reported_as_unavailable(self):
        suite = self.suite()
        with mock.patch.object(self.launcher.subprocess, "Popen",
                               side_effect=OSError("denied")):
            with self.assertRaises(self.launcher.SuiteUnavailable):
                self.launcher.launch(suite)

    def test_wait_ready_not_ready_returns_state_instead_of_raising(self):
        suite = self.suite()
        self.popen()

        class Driver:
            available = False

        result = self.launcher.launch(suite, wait_ready=True, timeout=0.0,
                                      interval=0.0, driver=Driver())
        self.assertEqual(result["pid"], 4242)
        self.assertFalse(result["ready"])
        self.assertEqual(result["state"], "not_ready")
        self.assertIn("未就绪", result["reason"])

    def test_wait_ready_true(self):
        suite = self.suite()
        self.popen()

        class Driver:
            available = True

        result = self.launcher.launch(suite, wait_ready=True, timeout=5.0,
                                      interval=0.0, driver=Driver())
        self.assertTrue(result["ready"])
        self.assertEqual(result["state"], "ready")
        self.assertNotIn("reason", result)

    def test_wait_ready_survives_a_broken_driver(self):
        suite = self.suite()
        self.popen()

        class Broken:
            @property
            def available(self):
                raise RuntimeError("boom")

        result = self.launcher.launch(suite, wait_ready=True, timeout=0.0,
                                      interval=0.0, driver=Broken())
        self.assertFalse(result["ready"])
        self.assertIn("boom", result["reason"])


class Status(LauncherCase):
    def test_invalid_pids(self):
        for bad in (0, -1, "123", 1.5, True, None):
            with self.subTest(pid=bad):
                with self.assertRaises(ValueError):
                    self.launcher.status(bad)

    def test_valid_pid_reports_running(self):
        with mock.patch.object(self.launcher, "_is_running", return_value=True), \
                mock.patch.object(self.launcher, "_process_exe", return_value="C:/x.exe"):
            self.assertEqual(self.launcher.status(7),
                             {"pid": 7, "running": True, "exe": "C:/x.exe"})

    def test_stop_rejects_bad_pids_before_touching_anything(self):
        with mock.patch.object(self.launcher, "_is_running") as alive:
            for bad in (0, -5, "12", False):
                with self.subTest(pid=bad):
                    with self.assertRaises(ValueError):
                        self.launcher.stop(bad)
        alive.assert_not_called()

    def test_stop_already_exited(self):
        with mock.patch.object(self.launcher, "_is_running", return_value=False), \
                mock.patch.object(self.launcher, "_request_close") as close:
            result = self.launcher.stop(99)
        close.assert_not_called()
        self.assertTrue(result["stopped"])
        self.assertTrue(result["already_exited"])
        self.assertFalse(result["forced"])

    def test_stop_closes_the_window_and_waits(self):
        with mock.patch.object(self.launcher, "_is_running",
                               side_effect=[True, False]), \
                mock.patch.object(self.launcher, "_request_close", return_value=True), \
                mock.patch.object(self.launcher, "_force_kill") as kill:
            result = self.launcher.stop(99, timeout=5.0, interval=0.0)
        kill.assert_not_called()
        self.assertTrue(result["stopped"])
        self.assertTrue(result["close_requested"])
        self.assertFalse(result["forced"])

    def test_stop_forces_kill_when_close_is_ignored(self):
        with mock.patch.object(self.launcher, "_is_running", return_value=True), \
                mock.patch.object(self.launcher, "_request_close", return_value=True), \
                mock.patch.object(self.launcher, "_force_kill", return_value=True):
            result = self.launcher.stop(99, timeout=0.0, interval=0.0, kill_wait=0.0)
        self.assertTrue(result["forced"])
        self.assertFalse(result["stopped"])

    def test_stop_after_force_kill_confirms_the_exit(self):
        with mock.patch.object(self.launcher, "_is_running",
                               side_effect=[True, True, False, False]), \
                mock.patch.object(self.launcher, "_request_close", return_value=True), \
                mock.patch.object(self.launcher, "_force_kill", return_value=True):
            result = self.launcher.stop(99, timeout=0.0, interval=0.0, kill_wait=5.0)
        self.assertTrue(result["forced"])
        self.assertTrue(result["stopped"])


class Check(LauncherCase):
    def test_installed_payload_is_portable_and_available(self):
        exe = self.make_exe(self.payload_suite())
        report = self.launcher.check(self.root)
        self.assertTrue(report["installed"])
        self.assertTrue(report["portable"])
        self.assertTrue(report["available"])
        self.assertEqual(Path(report["exe"]), exe)

    def test_missing_suite_is_reported_not_raised(self):
        report = self.launcher.check(self.root)
        self.assertFalse(report["installed"])
        self.assertFalse(report["available"])
        self.assertFalse(report["portable"])
        self.assertTrue(report["exe"].endswith(EXE))
        self.assertEqual(report["process"], self.launcher.PROCESS_NAME)


class Cli(LauncherCase):
    def test_check_prints_json_and_fails_when_missing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.launcher.main(["--check", "--root", str(self.root)])
        report = json.loads(out.getvalue())
        self.assertEqual(code, 1)
        self.assertFalse(report["installed"])

    def test_check_returns_zero_when_installed(self):
        self.make_exe(self.payload_suite())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.launcher.main(["--check", "--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out.getvalue())["installed"])

    def test_launch_prints_the_pid(self):
        self.make_exe(self.payload_suite())
        self.popen()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.launcher.main(["--launch", "--root", str(self.root)])
        payload = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(payload["pid"], 4242)
        self.assertEqual(payload["cmd"][1], self.launcher.ACCESSIBILITY_FLAG)

    def test_launch_missing_suite_exits_with_usage_error(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = self.launcher.main(["--launch", "--root", str(self.root)])
        self.assertEqual(code, 2)
        self.assertIn("没找到原版套件", err.getvalue())

    def test_stop_rejects_zero(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = self.launcher.main(["--stop", "0"])
        self.assertEqual(code, 2)

    def test_stop_requires_an_integer(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                self.launcher.main(["--stop", "abc"])
        self.assertEqual(ctx.exception.code, 2)

    def test_no_action_prints_help(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.launcher.main([])
        self.assertEqual(code, 2)
        self.assertIn("--launch", out.getvalue())


class SelectorCoverage(unittest.TestCase):
    """选择器表要跟得上 workflows/，否则流程跑到一半才报「没有这个控件」。"""

    @classmethod
    def setUpClass(cls):
        cls.uia = _load_uia()
        cls.selectors = cls.uia.load_selectors()
        cls.controls = cls.selectors["controls"]

    def test_required_controls_are_present(self):
        missing = [n for n in self.uia.REQUIRED_CONTROLS if n not in self.controls]
        self.assertEqual(missing, [])

    def test_workflow_pages_resolve_to_a_selector(self):
        # PowerShell 的 $locator.<segment> 不分大小写，Python 里按小写比对。
        keys = {name.lower(): name for name in self.controls}
        workflows = TOOLS.parent / "workflows"
        used: set[str] = set()
        for path in sorted(workflows.glob("*.yaml")):
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r"^\s*page:\s*(\S+)\s*$", text, re.MULTILINE):
                used.add(match.group(1).strip().strip("'\""))
        pages = {p for p in used if p.lower() not in ("", "manage")}
        self.assertTrue(pages, "工作流里应该至少有一个非 manage 的 page")
        for page in pages:
            self.assertIn(page.lower(), keys, f"选择器表缺页面 {page!r}")

    def test_uia_check_reports_missing_selectors(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = self.uia.check(
                selectors={"controls": {"Model": [{"names": ["Model"]}]}},
                suite_dir=tmp, workflows_dir=Path(tmp) / "nope")
            self.assertFalse(report["installed"])
            self.assertFalse(report["available"])
            self.assertIn("Add Device", report["missing"])
            self.assertEqual(report["selectors"], ["Model"])

    def test_uia_check_on_installed_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / EXE).write_bytes(b"MZ")
            report = self.uia.check(selectors=self.selectors, suite_dir=tmp,
                                    workflows_dir=Path(tmp) / "nope")
        self.assertTrue(report["installed"])
        self.assertEqual(report["missing"], [])
        self.assertEqual(report["exe"], str(Path(tmp) / EXE))

    def test_uia_main_check_prints_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with mock.patch.dict(os.environ, {"NOVATEL_SUITE": tmp}):
                with contextlib.redirect_stdout(out):
                    code = self.uia.main(["--check"])
        report = json.loads(out.getvalue())
        self.assertEqual(code, 1)
        for key in ("installed", "available", "selectors", "missing"):
            self.assertIn(key, report)


class LoaderSafety(unittest.TestCase):
    """payload 里 ``tools/`` 不在 ``sys.path``，模块会被按文件加载（不登记 sys.modules）。"""

    def test_imports_by_path_without_sys_modules_entry(self):
        path = TOOLS / "suite_launcher.py"
        spec = importlib.util.spec_from_file_location("suite_launcher_unregistered", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        self.assertEqual(module.EXE_NAME, EXE)
        self.assertTrue(callable(module.find_suite))
        self.assertTrue(callable(module.launch))


if __name__ == "__main__":
    unittest.main()
