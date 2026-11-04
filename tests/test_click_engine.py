# -*- coding: utf-8 -*-
"""点击引擎的纯函数部分：目标解析、挑选、危险词。不需要套件也不需要 CDP。"""
import json
import unittest

from tools.click_engine import ClickError, is_danger, parse_targets, pick

RAW = json.dumps([
    {"idx": 0, "tag": "div", "id": "sm-welcome", "cls": "application-container",
     "label": "Manage 0 Active Connections", "w": 260, "h": 180},
    {"idx": 1, "tag": "div", "id": "pl-welcome", "cls": "application-container",
     "label": "Playback", "w": 260, "h": 180},
    {"idx": 2, "tag": "button", "id": "add_app_btn", "cls": "darkBtn",
     "label": "Add application", "w": 140, "h": 32},
    {"idx": 3, "tag": "button", "id": "", "cls": "tiny",
     "label": "", "w": 20, "h": 20},
])


class TestParse(unittest.TestCase):
    def test_parses_every_target(self):
        targets = parse_targets(RAW)
        self.assertEqual(len(targets), 4)

    def test_danger_flagged_by_label(self):
        targets = parse_targets(RAW)
        self.assertTrue(targets[2].danger)          # Add application
        self.assertFalse(targets[1].danger)

    def test_key_prefers_label_then_tag(self):
        targets = parse_targets(RAW)
        self.assertEqual(targets[0].key, "Manage 0 Active Connections")
        self.assertIn("button", targets[3].key)     # 没名字的退回 tag#id


class TestPick(unittest.TestCase):
    def test_exact_label_wins(self):
        targets = parse_targets(RAW)
        self.assertEqual(pick(targets, "Playback").idx, 1)

    def test_fuzzy_unique(self):
        targets = parse_targets(RAW)
        self.assertEqual(pick(targets, "add app").idx, 2)

    def test_missing_raises_with_hint(self):
        targets = parse_targets(RAW)
        with self.assertRaises(ClickError) as ctx:
            pick(targets, "Update firmware")
        self.assertIn("4 个可点目标", str(ctx.exception))

    def test_ambiguous_raises(self):
        targets = parse_targets(RAW)
        with self.assertRaises(ClickError) as ctx:
            pick(targets, "a")          # 命中多个
        self.assertIn("不唯一", str(ctx.exception))

    def test_id_selector(self):
        targets = parse_targets(RAW)
        self.assertEqual(pick(targets, "#sm-welcome").idx, 0)

    def test_id_selector_missing(self):
        targets = parse_targets(RAW)
        with self.assertRaises(ClickError):
            pick(targets, "#nope")

    def test_nth_of_duplicates(self):
        raw = json.dumps([
            {"idx": 0, "tag": "button", "id": "", "cls": "d", "label": "Select", "w": 60, "h": 30},
            {"idx": 1, "tag": "button", "id": "", "cls": "d", "label": "Select", "w": 60, "h": 30},
        ])
        targets = parse_targets(raw)
        self.assertEqual(pick(targets, "Select@2").idx, 1)
        self.assertEqual(pick(targets, "Select@1").idx, 0)

    def test_nth_out_of_range(self):
        targets = parse_targets(RAW)
        with self.assertRaises(ClickError) as ctx:
            pick(targets, "Playback@3")
        self.assertIn("取不到", str(ctx.exception))


class TestDanger(unittest.TestCase):
    def test_danger_words(self):
        for label in ("Add Device", "Install", "Update application",
                      "Apply", "Delete Device", "Restart receiver"):
            self.assertTrue(is_danger(label), label)

    def test_safe_words(self):
        for label in ("Manage", "Check For Updates", "Cancel", "Plot", "Help"):
            self.assertFalse(is_danger(label), label)

    def test_case_insensitive(self):
        self.assertTrue(is_danger("APPLY"))


if __name__ == "__main__":
    unittest.main()
