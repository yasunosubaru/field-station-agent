"""CDP 驱动的纯函数与离线行为（不启动原版套件）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import cdp_driver  # noqa: E402


class TestScripts(unittest.TestCase):
    def test_click_js_embeds_target_and_keeps_template(self):
        js = cdp_driver._click_js('设备 "A"')
        self.assertIn('"设备 \\"A\\""', js)
        self.assertNotIn("__TARGET_JSON__", js)
        self.assertIn("__pool()", js)

    def test_click_js_supports_css_selector(self):
        js = cdp_driver._click_js("css:#settings-banner")
        self.assertIn("querySelector", js)
        self.assertIn("#settings-banner", js)

    def test_read_js_is_case_insensitive(self):
        js = cdp_driver._read_js("Manage")
        self.assertIn("toLowerCase()", js)
        self.assertIn('"Manage"', js)

    def test_type_js_escapes_value(self):
        js = cdp_driver._type_js("File", 'C:\\a "b".txt')
        self.assertNotIn("__VALUE_JSON__", js)
        self.assertIn('\\\\a', js)

    def test_select_js_uses_option_text(self):
        js = cdp_driver._select_js("Baud", "115200")
        self.assertIn('"115200"', js)


class TestUnavailable(unittest.TestCase):
    def test_no_cdp_returns_unavailable(self):
        result = cdp_driver.check(port=1)
        self.assertFalse(result["available"])
        self.assertIn("CDP", result["reason"])

    def test_create_reads_env(self):
        old = __import__("os").environ.get("FSA_CDP_PORT")
        __import__("os").environ["FSA_CDP_PORT"] = "9999"
        try:
            driver = cdp_driver.create()
            self.assertEqual(driver.port, 9999)
        finally:
            if old is None:
                __import__("os").environ.pop("FSA_CDP_PORT", None)
            else:
                __import__("os").environ["FSA_CDP_PORT"] = old


if __name__ == "__main__":
    unittest.main()
