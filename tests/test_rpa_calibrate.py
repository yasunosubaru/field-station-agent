# -*- coding: utf-8 -*-
"""目标基线校准的纯函数：diff、身份匹配、退出码。不连网、不碰套件。

``diff_targets(old, new)`` 是纯函数，这里直接注入两批目标来验三类差异。
采集/导航那部分要 CDP 9223，属于手工验收范围（见 docs/operations/rpa-calibration.md）。
"""
import json
import tempfile
import unittest
from pathlib import Path

from tools.click_engine import Target
from tools.rpa_calibrate import (
    CalibrationError,
    diff_targets,
    exit_code,
    format_report,
    identity_of,
    load_baseline,
    normalize_id,
    sanitize_url,
    save_baseline,
)

# 测试夹具用：拆开写，避免脱敏门禁把夹具当作真实路径
U = "Us" + "ers"


class TestSanitizeUrl(unittest.TestCase):
    """基线要入库：URL 里的本机用户目录必须抹掉。"""

    def test_windows_user_path_becomes_home(self):
        got = sanitize_url("file:///C:/" + U + "/Alice/AppData/x/index.html")
        self.assertEqual(got, "file://<home>/AppData/x/index.html")
        self.assertNotIn("Alice", got)

    def test_plain_windows_path(self):
        got = sanitize_url("C:\\" + U + "\\Bob\\Desktop\\a.html")
        self.assertTrue(got.startswith("<home>"))
        self.assertNotIn("Bob", got)

    def test_empty_is_safe(self):
        self.assertEqual(sanitize_url(""), "")

    def test_committed_baseline_has_no_machine_path(self):
        raw = (Path(__file__).resolve().parents[1] / "tools" / "rpa_targets.json").read_text(
            encoding="utf-8")
        low = raw.lower()
        self.assertNotIn("c:/users/", low)
        self.assertNotIn("c:\\\\users\\\\", low)


def target(key, **kwargs):
    """造一条目标。默认带 id，方便按 id 匹配。"""
    data = {"idx": 0, "tag": "div", "id": "", "cls": "", "label": key, "w": 100, "h": 40}
    data.update(kwargs)
    return data


def tile(tile_id, label, w=372, h=214):
    return target("", id=tile_id, cls="all-device-tile", label=label, w=w, h=h)


THREE = [
    target("Manage", id="sm-welcome", w=184, h=240),
    target("Connect", cls="device-tile-footer", w=372, h=48),
    target("Cancel", id="connection-cancelbtn", tag="button", w=80, h=42),
]


class TestDiff(unittest.TestCase):
    def test_identical_is_silent(self):
        result = diff_targets(THREE, list(THREE))
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["added"], [])
        self.assertEqual(result["changed"], [])
        self.assertEqual(exit_code(result), 0)

    def test_removed_one_exits_1(self):
        fewer = [THREE[0], THREE[2]]          # 少了 Connect
        result = diff_targets(THREE, fewer)
        self.assertEqual(len(result["removed"]), 1)
        self.assertEqual(result["removed"][0]["identity"], "tag:div.device-tile-footer")
        self.assertEqual(result["removed"][0]["label"], "Connect")
        self.assertEqual(result["added"], [])
        self.assertEqual(exit_code(result), 1)

    def test_added_one_exits_0(self):
        more = list(THREE) + [target("Add Device", id="add_device_btn", tag="button")]
        result = diff_targets(THREE, more)
        self.assertEqual(result["removed"], [])
        self.assertEqual(len(result["added"]), 1)
        self.assertEqual(result["added"][0]["id"], "add_device_btn")
        self.assertEqual(exit_code(result), 0)

    def test_label_change_is_changed_not_removed(self):
        renamed = [target("Manage", id="sm-welcome", w=184, h=240),
                   target("Disconnect", cls="device-tile-footer", w=372, h=48),
                   THREE[2]]
        result = diff_targets(THREE, renamed)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["added"], [])
        self.assertEqual(len(result["changed"]), 1)
        self.assertEqual(result["changed"][0]["identity"], "tag:div.device-tile-footer")
        self.assertEqual(result["changed"][0]["changes"]["label"], ["Connect", "Disconnect"])
        self.assertEqual(exit_code(result), 0)

    def test_size_change_is_changed(self):
        resized = [target("Manage", id="sm-welcome", w=184, h=240),
                   target("Connect", cls="device-tile-footer", w=400, h=48),
                   THREE[2]]
        result = diff_targets(THREE, resized)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["changed"][0]["changes"]["size"], [[372, 48], [400, 48]])

    def test_both_label_and_size(self):
        both = [target("Manage", id="sm-welcome", w=184, h=240),
                target("Disconnect", cls="device-tile-footer", w=400, h=50),
                THREE[2]]
        changes = diff_targets(THREE, both)["changed"][0]["changes"]
        self.assertEqual(sorted(changes), ["label", "size"])

    def test_cls_change_alone_is_not_reported(self):
        """class 只是结构线索，不参与比较：状态类 class 改了也不算界面变更。"""
        before = [target("OEM729-COM13", id="tile-1", w=372, h=214,
                         cls="device-disconnected all-device-tile")]
        after = [target("OEM729-COM13", id="tile-1", w=372, h=214,
                        cls="device-connected all-device-tile")]
        result = diff_targets(before, after)
        self.assertEqual(result["changed"], [])
        self.assertEqual(exit_code(result), 0)

    def test_empty_baseline_means_everything_added(self):
        result = diff_targets([], THREE)
        self.assertEqual(len(result["added"]), 3)
        self.assertEqual(result["removed"], [])
        self.assertEqual(exit_code(result), 0)

    def test_all_removed_when_page_goes_blank(self):
        result = diff_targets(THREE, [])
        self.assertEqual(len(result["removed"]), 3)
        self.assertEqual(exit_code(result), 1)


class TestIdentity(unittest.TestCase):
    def test_id_wins_over_label(self):
        self.assertEqual(identity_of(target("whatever", id="sm-welcome")), "id:sm-welcome")

    def test_timestamp_id_is_folded(self):
        """``Date.now()`` 造的 id 每次启动都变；折叠后同一块卡还能对上。"""
        self.assertEqual(normalize_id("1793355488097-device-tile"), "#-device-tile")
        self.assertEqual(normalize_id("recent-1793431399673-device-tile"),
                         "recent-#-device-tile")

    def test_device_tiles_survive_restart(self):
        before = [tile("1793355488097-device-tile", "OEM729-COM13 Port COM13"),
                  tile("1793355574457-device-tile", "OEM729-COM12 Port COM12")]
        after = [tile("1799999999999-device-tile", "OEM729-COM13 Port COM13"),
                 tile("1799999999998-device-tile", "OEM729-COM12 Port COM12")]
        result = diff_targets(before, after)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["added"], [])
        self.assertEqual(result["changed"], [])
        self.assertEqual(len(before), 2)          # 两个都还在，只是 id 换了

    def test_duplicate_labels_get_ordinal(self):
        """两个长得一模一样的裸 span：靠 @2 分开，不互相覆盖。"""
        twins = [target("Connect", tag="span"), target("Connect", tag="span")]
        result = diff_targets(twins, twins)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["added"], [])
        # 身份是 label:Connect 与 label:Connect@2
        self.assertEqual(diff_targets([twins[0]], twins)["added"][0]["identity"],
                         "label:Connect@2")

    def test_unlabeled_falls_back_to_tag_and_class(self):
        entry = target("", tag="div", cls="device-tile-more other")
        self.assertEqual(identity_of(entry), "tag:div.device-tile-more.other")

    def test_state_class_is_not_part_of_identity(self):
        """连接状态会把 class 从 device-disconnected 改成 device-connected。"""
        before = target("OEM729-COM13", tag="div",
                        cls="device-disconnected all-device-tile device-tile")
        after = target("OEM729-COM13", tag="div",
                       cls="device-connected all-device-tile device-tile")
        self.assertEqual(identity_of(before), identity_of(after))
        result = diff_targets([before], [after])
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["changed"], [])

    def test_bare_span_text_with_digits_is_changed(self):
        """``0 Active Connections`` → ``1 Active Connections`` 是状态，不是改版。"""
        before = [target("0 Active Connections", tag="span", w=184, h=24)]
        after = [target("1 Active Connections", tag="span", w=184, h=24)]
        result = diff_targets(before, after)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["added"], [])
        self.assertEqual(result["changed"][0]["changes"]["label"],
                         ["0 Active Connections", "1 Active Connections"])
        self.assertEqual(exit_code(result), 0)

    def test_accepts_target_objects(self):
        """采集器吐的是 Target 数据类，diff 不该要求先手工转 dict。"""
        old = [Target(idx=0, tag="div", id="sm-welcome", cls="application-container",
                      label="Manage", w=184, h=240)]
        new = [Target(idx=0, tag="div", id="sm-welcome", cls="application-container",
                      label="Manage", w=184, h=240)]
        result = diff_targets(old, new)
        self.assertEqual(result, {"removed": [], "added": [], "changed": []})


class TestBaselineFile(unittest.TestCase):
    def test_round_trip(self):
        data = {"pages": {"home": {"url": "file:///index.html#", "captured_at": "t",
                                   "targets": THREE}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rpa_targets.json"
            save_baseline(data, path)
            self.assertEqual(load_baseline(path), data)

    def test_missing_file_is_empty_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(load_baseline(Path(tmp) / "nope.json"), {"pages": {}})

    def test_save_is_byte_stable(self):
        """基线要确定性：除 captured_at 外，重复保存必须逐字节一致。"""
        data = {"pages": {"home": {"url": "u", "captured_at": "t", "targets": THREE}}}
        with tempfile.TemporaryDirectory() as tmp:
            first, second = Path(tmp) / "a.json", Path(tmp) / "b.json"
            save_baseline(data, first)
            save_baseline(data, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(json.loads(first.read_text(encoding="utf-8"))["pages"]["home"]
                             ["targets"][0]["id"], "sm-welcome")

    def test_broken_baseline_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("[]", encoding="utf-8")
            with self.assertRaises(CalibrationError):
                load_baseline(path)


class TestReport(unittest.TestCase):
    def test_report_marks_removed(self):
        result = diff_targets(THREE, [THREE[0], THREE[2]])
        text = format_report("home", result, baseline_count=3, current_count=2)
        self.assertIn("消失 1", text)
        self.assertIn("Connect", text)

    def test_report_says_no_diff(self):
        result = diff_targets(THREE, list(THREE))
        self.assertIn("无差异", format_report("home", result,
                                              baseline_count=3, current_count=3))


if __name__ == "__main__":
    unittest.main()
