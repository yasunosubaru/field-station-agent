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
import tempfile
import unittest
from pathlib import Path

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
                for action in step.get("actions") or []:
                    if action.get("locator"):
                        used.add(str(action["locator"]))
                if step.get("control"):
                    used.add(str(step["control"]))
                if step.get("kind") == "gui" and step.get("locator"):
                    used.add(str(step["locator"]))
        controls = self.selectors["controls"]
        for locator in used:
            if locator.startswith("css:") or locator.startswith("${"):
                continue  # CDP 选择器 / 运行时参数，不走 UIA 表
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
