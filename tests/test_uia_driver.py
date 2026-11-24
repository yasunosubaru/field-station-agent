#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UIA 驱动：选择器表、文件加载、失败时不伪造。

这里**不启动原版套件**（那会抢串口、弹窗），也不假设 Windows 之外的 CI 有 PowerShell。
只钉三件在哪种机器上都成立的事：

1. 选择器表没有坐标，控件名能从 ``Device > Update > Firmware file`` 退化到末段；
2. 生成的 PowerShell 脚本是**纯 ASCII**（PS 5.1 无 BOM 按 GBK 读，中文会炸）；
3. 套件不在时 ``available`` 为假、动作直接报 ``GuiUnavailable``，不会静默返回成功。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# 让 `python -m unittest tests.test_uia_driver` 从仓库根就能跑通：fieldstation
# 在 src/ 下（和本仓库其它测试的做法一致）。
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_ROOT / "src"))

from fieldstation.workflows import gui as gui_mod
from fieldstation.workflows import yaml_lite  # noqa: F401  （保证包能整体导入）


def _load_uia():
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "tools" / "uia_driver.py"
    spec = importlib.util.spec_from_file_location("uia_driver_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Selectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.uia = _load_uia()
        cls.selectors = cls.uia.load_selectors()

    def test_no_coordinates_anywhere(self):
        text = json.dumps(self.selectors["controls"])
        for banned in ('"x"', '"y"', '"left"', '"top"', "clickAt", "position"):
            self.assertNotIn(banned, text)

    def test_every_control_has_a_descriptor(self):
        """每个键要么有 UIA 描述，要么有一条 note 明确说明本版不存在。"""
        for name, descriptors in self.selectors["controls"].items():
            self.assertIsInstance(descriptors, list, name)
            self.assertTrue(descriptors, name)
            for desc in descriptors:
                self.assertTrue(
                    desc.get("names") or desc.get("automationId") or desc.get("note"),
                    name)

    def test_workflow_locators_resolve(self):
        suite_root = Path(__file__).resolve().parents[1] / "workflows"
        used: set[str] = set()
        for path in sorted(suite_root.glob("*.yaml")):
            data = yaml_lite.load(path)
            for step in data.get("steps") or []:
                if step.get("port"):
                    # 带 port 的步骤指向另一个进程（例如 Graph 的 9224），
                    # 它们的控件不属于套件的 UIA 选择器表。
                    continue
                for action in step.get("actions") or []:
                    if action.get("locator"):
                        used.add(str(action["locator"]))
                if step.get("control"):
                    used.add(str(step["control"]))
                if step.get("kind") == "gui" and step.get("locator"):
                    used.add(str(step["locator"]))
        controls = self.selectors["controls"]
        for locator in used:
            if (locator.startswith("css:") or locator.startswith("${")
                    or locator.startswith("target:") or locator.startswith("target!:")):
                continue  # CDP 选择器 / 点击引擎目标 / 运行时参数，都不走 UIA 表
            self.assertTrue(
                locator in controls or locator.split(">")[-1].strip() in controls,
                f"选择器表缺 {locator!r}")

    def test_combined_locator_falls_back_to_tail(self):
        driver = self.uia.UiaDriver(selectors=self.selectors, suite_dir=tempfile.gettempdir())
        self.assertIsInstance(driver._control("Device > Update > Firmware file"), list)

    def test_unknown_locator_is_an_error(self):
        driver = self.uia.UiaDriver(selectors=self.selectors, suite_dir=tempfile.gettempdir())
        with self.assertRaises(self.uia.GuiUnavailable):
            driver._control("Nonexistent control")


class Availability(unittest.TestCase):
    def test_missing_suite_reports_unavailable_and_refuses_actions(self):
        uia = _load_uia()
        with tempfile.TemporaryDirectory() as tmp:
            driver = uia.UiaDriver(suite_dir=tmp)
            self.assertFalse(driver.available)
            with self.assertRaises(uia.GuiUnavailable) as ctx:
                driver.read("Model")
            self.assertIn("没找到原版套件", str(ctx.exception))
            with self.assertRaises(uia.GuiUnavailable):
                driver.open("Device > Update")
            with self.assertRaises(uia.GuiUnavailable):
                driver.screenshot(Path(tmp) / "x.png")

    def test_installed_layout_reports_available(self):
        uia = _load_uia()
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "NovAtelApplicationSuite.exe").write_bytes(b"MZ")
            driver = uia.UiaDriver(suite_dir=tmp)
            self.assertTrue(driver.available)


class Script(unittest.TestCase):
    def test_powershell_script_is_ascii(self):
        uia = _load_uia()
        uia._PS_SCRIPT.encode("ascii")  # 不能编码就说明混进了非 ASCII 字面量

    def test_script_never_uses_coordinates(self):
        uia = _load_uia()
        for banned in ("mouse_event", "Cursor.Position", "SetCursorPos", "ClickAt"):
            self.assertNotIn(banned, uia._PS_SCRIPT)


class ScriptHardening(unittest.TestCase):
    """内嵌 PowerShell 的回归门禁：实测修复的符号、中文候选、可解析性。

    这里只做静态检查 + 字符串断言，绝不启动真实 UIA（无 GUI 的 CI 会挂）。
    """

    @classmethod
    def setUpClass(cls):
        cls.uia = _load_uia()
        cls.script = cls.uia._PS_SCRIPT

    def test_required_symbols_survive(self):
        # Bug 1/2/3 的实测修复 + 改进 A/B/C 的符号，少一个说明被回退了。
        for symbol in (
            "UiaSkipTitles",          # Bug 1: VNC 窗口黑名单（脚本级）
            "UiaSkipped",             # Bug 1: 诊断记录
            "UIA_OPTION",             # Bug 2: path/confirm 独立传参
            "'fill_dialog'",          # Bug 3: 填路径动作
            "Test-DialogHasButton",   # A: 多窗口消歧
            "Get-DialogButtons",      # B/C: 按钮清单
            "Format-DialogDiag",      # C: 失败诊断
            "fallback = $usedFallback",  # B: 兜底标记写进返回值
        ):
            self.assertIn(symbol, self.script, symbol)

    def test_confirm_candidates_include_english_and_cjk(self):
        # 脚本必须纯 ASCII，中文按钮名只能用 [char]0x.... 拼出来。
        # 把码点还原成中文，逐一断言脚本里确实拼了这些字。
        self.assertIn("'Select Folder|Select|OK|'", self.script)
        for ch in "选择文件夹打开":
            self.assertIn(f"[char]0x{ord(ch):04X}", self.script, ch)

    def test_select_folder_char_codes_assemble_to_cjk(self):
        # 防回退：直接还原 PS 侧 $selectFolderCjk 表达式里的 [char] 序列，
        # 验证它拼出来的就是「选择文件夹」，而不是一串写错的码点。
        marker = "$selectFolderCjk = "
        start = self.script.index(marker)
        # 只取到闭合括号那一行，别把后面的 $openCjk / $saveCjk 码点也算进来。
        end = self.script.index("\n", self.script.index(")", start))
        chunk = self.script[start:end]
        codes = re.findall(r"\[char\]0x([0-9A-Fa-f]{4})", chunk)
        self.assertEqual(len(codes), 5, codes)
        self.assertEqual("".join(chr(int(c, 16)) for c in codes), "选择文件夹")

    def test_option_is_not_concatenated_into_value(self):
        # Bug 2 回归：path 与 confirm 必须分别进 UIA_VALUE / UIA_OPTION。
        src = (_ROOT / "tools" / "uia_driver.py").read_text(encoding="utf-8")
        self.assertIn('"UIA_VALUE": "" if value is None else str(value)', src)
        self.assertIn('"UIA_OPTION": "" if option is None else str(option)', src)

    def test_fill_result_keeps_path_and_exposes_fallback(self):
        # 改进 B：兜底标记写进返回值；同时保持 str 兼容 runner.py 的 str(filled)。
        r = self.uia._FillResult("C:/tmp/a.zip", button="OK", fallback=True,
                                 dialog_title="Open", buttons=["OK", "Cancel"])
        self.assertIsInstance(r, str)
        self.assertEqual(str(r), "C:/tmp/a.zip")
        self.assertTrue(r.fallback)
        self.assertEqual(r.button, "OK")
        self.assertEqual(r.buttons, ["OK", "Cancel"])

    def test_powershell_syntax_parses(self):
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if not powershell:
            self.skipTest("没有 powershell.exe，跳过语法检查")

        # 用 Parser::ParseFile 只解析、不执行；纯 ASCII，避免命令行编码问题。
        checker = (
            "$tokens = $null\n"
            "$errors = $null\n"
            "[void][System.Management.Automation.Language.Parser]::ParseFile("
            "$env:UIA_SRC, [ref]$tokens, [ref]$errors)\n"
            "if ($errors -and $errors.Count -gt 0) {\n"
            "  foreach ($e in $errors) {\n"
            "    Write-Output ('ERR ' + $e.Extent.StartLineNumber + ': ' + $e.Message)\n"
            "  }\n"
            "  exit 1\n"
            "}\n"
            "Write-Output 'SYNTAX_OK'\n"
        )
        with tempfile.TemporaryDirectory(prefix="uia-syntax-test-") as tmp:
            src = Path(tmp) / "uia-action.ps1"
            src.write_bytes(self.script.encode("ascii").replace(b"\n", b"\r\n"))
            chk = Path(tmp) / "check.ps1"
            chk.write_bytes(checker.encode("ascii").replace(b"\n", b"\r\n"))
            env = dict(os.environ)
            env["UIA_SRC"] = str(src)
            proc = subprocess.run(
                [powershell, "-NoProfile", "-NonInteractive",
                 "-ExecutionPolicy", "Bypass", "-File", str(chk)],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120, env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        out = (proc.stdout or "").strip()
        errs = [ln for ln in out.splitlines() if ln.startswith("ERR ")]
        self.assertEqual(proc.returncode, 0,
                         "; ".join(errs) or out or (proc.stderr or "")[:300])
        self.assertIn("SYNTAX_OK", out)


class DriverLoading(unittest.TestCase):
    def test_assisted_and_scripted(self):
        self.assertFalse(gui_mod.load_driver("assisted").available)
        self.assertTrue(gui_mod.load_driver("scripted").available)

    def test_file_path_driver(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "demo_driver.py"
            path.write_text(
                "class D:\n"
                "    name = 'demo'\n"
                "    available = True\n"
                "    def open(self, page): pass\n"
                "    def read(self, control): return ''\n"
                "    def click(self, locator): pass\n"
                "    def type_text(self, locator, text): pass\n"
                "    def select(self, locator, option): pass\n"
                "    def screenshot(self, path): return None\n"
                "def create(): return D()\n",
                encoding="utf-8")
            driver = gui_mod.load_driver(str(path))
            self.assertEqual(driver.name, "demo")

    def test_missing_driver_file_is_gui_unavailable(self):
        with self.assertRaises(gui_mod.GuiUnavailable):
            gui_mod.load_driver(str(Path(tempfile.gettempdir()) / "no-such-driver.py"))


if __name__ == "__main__":
    unittest.main()
