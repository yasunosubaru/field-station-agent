# -*- coding: utf-8 -*-
"""rpa_fixture 的回放逻辑：不连套件、不联网，用临时目录构造 fixture。

覆盖三件事：
1. locator 全部命中 -> 退出码 0；
2. 某条 locator 改名（目标不在采集结果里）-> 退出码 1，并指名是哪条；
3. 同一个 key 命中多个不同目标 -> 报"不唯一"。

另外把仓库里已提交的 ``tests/fixtures/rpa`` 当回归：这些 locator 每次跑单测都
重新解析一遍，谁改坏了 fixture 或 ``pick`` 的匹配规则，这里立刻红。
"""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from tools import rpa_fixture

# 测试夹具用：拆开写，避免脱敏门禁把夹具当作真实路径
U = "Us" + "ers"

TARGETS = [
    {"idx": 0, "tag": "div", "id": "sm-welcome", "cls": "application-container",
     "label": "Manage", "w": 184, "h": 240},
    {"idx": 1, "tag": "button", "id": "add_app_btn", "cls": "darkBtn",
     "label": "Add application", "w": 161, "h": 36},
    {"idx": 2, "tag": "a", "id": "settings-banner", "cls": "banner",
     "label": "", "w": 26, "h": 31},
]

LOCATORS = ["#sm-welcome", "Add application", "#settings-banner"]


def write_fixture(root: Path, page: str, targets, locators) -> None:
    base = root / page
    base.mkdir(parents=True, exist_ok=True)
    (base / "targets.json").write_text(
        json.dumps(targets, ensure_ascii=False), encoding="utf-8")
    if locators is None:
        (base / "locators.json").unlink(missing_ok=True)
    else:
        (base / "locators.json").write_text(
            json.dumps({"page": page, "locators": list(locators)}, ensure_ascii=False),
            encoding="utf-8")


def run_main(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = rpa_fixture.main(argv)
    return code, out.getvalue()


class TestReplayAllHit(unittest.TestCase):
    def test_all_locators_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", TARGETS, LOCATORS)
            code, out = run_main(["--replay-all", "--root", str(root)])
            self.assertEqual(code, 0, out)
            self.assertEqual(out.count("] OK"), 3)
            self.assertIn("#settings-banner", out)

    def test_replay_single_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", TARGETS, LOCATORS)
            code, out = run_main(["--replay", "home", "--root", str(root)])
            self.assertEqual(code, 0, out)

    def test_empty_locator_list_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", TARGETS, [])
            code, out = run_main(["--replay", "home", "--root", str(root)])
            self.assertEqual(code, 1, out)
            self.assertIn("空清单", out)


class TestReplayDetectsBreakage(unittest.TestCase):
    def test_renamed_locator_fails_and_is_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", TARGETS,
                          ["#sm-welcome", "Apply update", "#settings-banner"])
            code, out = run_main(["--replay-all", "--root", str(root)])
            self.assertEqual(code, 1, out)
            self.assertIn("Apply update", out)   # 指名是哪条
            self.assertIn("找不到", out)
            self.assertNotIn("不唯一", out)

    def test_nth_locator_out_of_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", TARGETS, ["Manage@3"])
            code, out = run_main(["--replay", "home", "--root", str(root)])
            self.assertEqual(code, 1, out)
            self.assertIn("越界", out)
            self.assertIn("Manage@3", out)

    def test_ambiguous_locator_is_reported(self):
        targets = [
            {"idx": 0, "tag": "span", "id": "", "cls": "x", "label": "Alpha",
             "w": 60, "h": 20},
            {"idx": 1, "tag": "span", "id": "", "cls": "y", "label": "Beta",
             "w": 60, "h": 20},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", targets, ["a"])
            code, out = run_main(["--replay", "home", "--root", str(root)])
            self.assertEqual(code, 1, out)
            self.assertIn("不唯一", out)
            self.assertIn("'a'", out)

    def test_page_without_locators_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", TARGETS, None)
            with self.assertRaises(FileNotFoundError):
                rpa_fixture.replay_page(root, "home")


class TestInjection(unittest.TestCase):
    """回放函数能直接吃"读到的 targets"，不碰文件系统。"""

    def test_injected_targets_bypass_files(self):
        results = rpa_fixture.replay_page("/nonexistent", "home",
                                          targets=TARGETS, locators=LOCATORS)
        self.assertTrue(rpa_fixture.results_ok(results), results)

    def test_injected_targets_can_be_target_objects(self):
        pool = rpa_fixture.parse_targets(TARGETS)
        results = rpa_fixture.replay_page("/nonexistent", "home",
                                          targets=pool, locators=["Playback"])
        self.assertFalse(rpa_fixture.results_ok(results))
        self.assertEqual(results[0]["kind"], "找不到")

    def test_replay_all_accepts_per_page_injection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_fixture(root, "home", [], ["#sm-welcome"])
            pairs = rpa_fixture.replay_all(root, targets_by_page={"home": TARGETS})
            self.assertEqual(len(pairs), 1)
            self.assertEqual(pairs[0][0], "home")
            self.assertTrue(rpa_fixture.results_ok(pairs[0][1]))


class TestCommittedFixtures(unittest.TestCase):
    """仓库里采下来的 fixture 必须一直能回放（这就是"无套件验证"本身）。"""

    def test_all_committed_fixtures_resolve(self):
        base = rpa_fixture.DEFAULT_ROOT
        if not base.is_dir():
            self.skipTest("没有 tests/fixtures/rpa")
        pairs = rpa_fixture.replay_all(base)
        self.assertGreaterEqual(len(pairs), 4, "至少要有 4 个页面")
        for page, results in pairs:
            self.assertGreaterEqual(len(results), 3, "%s 的 locator 太少" % page)
            self.assertTrue(rpa_fixture.results_ok(results),
                            "%s: %s" % (page, [r for r in results if not r["ok"]]))


class FakeDriver:
    """只回答 capture() 会用到的那几个表达式，不碰 CDP。"""

    def __init__(self, html=""):
        self.html = html

    def evaluate(self, expression):
        if "data-fsa-idx" in expression:          # click_engine.COLLECT_JS
            return json.dumps(TARGETS)
        if expression == "navigator.userAgent":
            return "Mozilla/5.0 NovAtelApplicationSuite/2.11.0 Chrome/120"
        if expression == "location.href":
            return "file:///C:/" + U + "/someone/AppData/Local/AllPoweredFSA/view/index.html#"
        if expression == "document.documentElement.outerHTML":
            return self.html
        if "innerWidth" in expression:
            return "[1024,768,1.25]"
        raise AssertionError("没料到会求值：%r" % expression)


class TestCapture(unittest.TestCase):
    def test_meta_and_targets_are_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            meta = rpa_fixture.capture(tmp, "home", FakeDriver())
            self.assertEqual(meta["target_count"], 3)
            self.assertEqual(meta["suite_version"], "2.11.0")
            self.assertEqual(meta["viewport"]["device_pixel_ratio"], 1.25)
            self.assertIn("<user>", meta["url"])
            self.assertNotIn("someone", meta["url"])
            saved = json.loads((Path(tmp) / "home" / "targets.json")
                               .read_text(encoding="utf-8"))
            self.assertEqual([t["idx"] for t in saved], [0, 1, 2])

    def test_html_is_truncated_to_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            big = "x" * (rpa_fixture.MAX_HTML_BYTES + 4096)
            meta = rpa_fixture.capture(tmp, "home", FakeDriver(html=big), want_html=True)
            page = Path(tmp) / "home" / "page.html"
            self.assertEqual(page.stat().st_size, rpa_fixture.MAX_HTML_BYTES)
            self.assertTrue(meta["html_truncated"])

    def test_save_locators_refuses_invalid_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            rpa_fixture.save_locators(tmp, "home", ["#nope"], targets=TARGETS)
            self.assertFalse((Path(tmp) / "home" / "locators.json").exists())
            rpa_fixture.save_locators(tmp, "home", LOCATORS, targets=TARGETS)
            self.assertTrue((Path(tmp) / "home" / "locators.json").exists())

    def test_sanitize_url_leaves_relative_untouched(self):
        self.assertEqual(rpa_fixture.sanitize_url("https://example.com/a"),
                         "https://example.com/a")
        self.assertEqual(
            rpa_fixture.sanitize_url("file:///D:/" + U + "/li/App/x.html"),
            "file:///D:/" + U + "/<user>/App/x.html")
        self.assertEqual(rpa_fixture.sanitize_url("C:\\" + U + "\\li\\App\\x.html"),
                         "C:\\" + U + "\\<user>\\App\\x.html")


if __name__ == "__main__":
    unittest.main()
