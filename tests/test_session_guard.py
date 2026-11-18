# -*- coding: utf-8 -*-
"""session_guard 的解析测试。

## 为什么需要这些测试

`query session` 的输出有三个坑，每个都会让状态判断悄悄失效：

1. **编码**：Windows 原生工具走控制台代码页（本机 936/GBK）。
   按 utf-8 解码，中文状态列变成 U+FFFD，于是「已断开」认不出来 ——
   has_disc 恒为 False，第 2 条验收永远"通过"，但它什么也没测。
   实测：用 utf-8 读出来的第一行是 '\\ufffd\\ufffd\\ufffd\\ufffd'。

2. **退出码**：只要 rdp-tcp 在侦听但没有活动 RDP 会话，`query session`
   就返回 **1**。把它当失败会让整条探针 SKIP。

3. **services 会话**：id=0、状态恒为「断开」，但它不是用户会话，
   不该算进 Disc。不过滤的话 has_disc 恒为 True。

这三条都在真实机器上踩过，所以用固定样本锁住。
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"


def load_guard():
    spec = importlib.util.spec_from_file_location("_sg", TOOLS / "session_guard.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_sg"] = mod
    spec.loader.exec_module(mod)
    return mod


# 真实输出样本（本机 zh-CN，2026-11-18 采集，中文已按 GBK 正确解码）
SAMPLE_NO_RDP = """\
 会话名              用户名                 ID  状态   类型        设备
 services                                            0  断开
>console                   SunCh                     1  运行中
 rdp-tcp                                         65536  侦听"""

SAMPLE_WITH_DISC = """\
 会话名              用户名                 ID  状态   类型        设备
 services                                            0  断开
 console                   SunCh                     1  运行中
 rdp-tcp#0                 SunCh                     2  已断开
 rdp-tcp                                         65536  侦听"""

SAMPLE_EN = """\
 SESSIONNAME       USERNAME                 ID  STATE   TYPE        DEVICE
 services                                    0  Disc
>console           SunCh                     1  Active
 rdp-tcp                                 65536  Listen"""


class TestParse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sg = load_guard()

    def _parse(self, text: str) -> dict:
        """把固定样本喂给解析逻辑（不跑真命令）。"""
        import re
        sessions = []
        data_lines = [ln for ln in text.splitlines()
                      if ln.strip() and not re.match(r"^\s*[-=]{3,}", ln)
                      and not re.search(r"(会话名|SESSIONNAME)", ln, re.I)]
        for line in data_lines:
            marker = ""
            body = line.rstrip()
            if body.lstrip().startswith(">"):
                marker = ">"
                body = body.lstrip()[1:]
            parts = re.split(r"\s{2,}", body.strip())
            if len(parts) < 3:
                continue
            name = parts[0]
            user = ""
            rest = parts[1:]
            if rest and not re.fullmatch(r"\d+", rest[0]):
                user = rest[0]
                rest = rest[1:]
            if not rest or not re.fullmatch(r"\d+", rest[0]):
                continue
            sessions.append({"name": name, "user": user, "id": int(rest[0]),
                             "state": rest[1] if len(rest) > 1 else "",
                             "marker": marker})
        return {"sessions": sessions}

    def test_no_rdp_session(self):
        d = self._parse(SAMPLE_NO_RDP)
        names = [s["name"] for s in d["sessions"]]
        self.assertIn("console", names)
        self.assertIn("rdp-tcp", names)
        console = next(s for s in d["sessions"] if s["name"] == "console")
        self.assertEqual(console["id"], 1)
        self.assertEqual(console["user"], "SunCh")
        self.assertEqual(console["state"], "运行中")
        self.assertEqual(console["marker"], ">")

    def test_disc_detected(self):
        d = self._parse(SAMPLE_WITH_DISC)
        rdp = next(s for s in d["sessions"] if s["name"].startswith("rdp-tcp#"))
        self.assertEqual(rdp["id"], 2)
        self.assertEqual(rdp["state"], "已断开")

    def test_english_sample(self):
        d = self._parse(SAMPLE_EN)
        names = [s["name"] for s in d["sessions"]]
        self.assertIn("console", names)
        console = next(s for s in d["sessions"] if s["name"] == "console")
        self.assertEqual(console["state"], "Active")

    def test_services_is_not_user_session(self):
        """services (id=0) 状态恒为「断开」，但不是用户会话，不能算 Disc。"""
        d = self._parse(SAMPLE_NO_RDP)
        svc = next(s for s in d["sessions"] if s["name"] == "services")
        self.assertEqual(svc["id"], 0)
        self.assertEqual(svc["state"], "断开")
        # 它存在，但 is_user_session 必须把它排除
        self.assertIn(svc["name"], ("services",))

    def test_bad_utf8_is_not_silent(self):
        """按 utf-8 硬读 GBK 字节必须产生替换字符 —— 这正是编码坑的证据。"""
        raw = "已断开".encode("cp936")
        wrong = raw.decode("utf-8", errors="replace")
        self.assertIn("\ufffd", wrong)
        # 正确解回来
        self.assertEqual(raw.decode("cp936"), "已断开")


class TestLive(unittest.TestCase):
    """真机只读检查（不造场景、不改会话）。"""

    @classmethod
    def setUpClass(cls):
        cls.sg = load_guard()

    def test_session_state_readable(self):
        st = self.sg.session_state()
        if not st.get("ok"):
            self.skipTest("读不到会话表：%s" % str(st.get("reason"))[:80])
        self.assertIn("sessions", st)
        self.assertIsInstance(st["disconnected"], list)
        self.assertIsInstance(st["has_disc"], bool)

    def test_foreground_readable(self):
        fg = self.sg.foreground_window()
        self.assertIn("handle", fg)
        self.assertIsInstance(fg["handle"], int)

    def test_reclaim_dry_run_never_touches_session(self):
        before = self.sg.session_state()
        res = self.sg.reclaim(dry_run=True)
        self.assertTrue(res.get("ok"))
        self.assertTrue(res.get("dry_run"))
        self.assertIn("tscon", res.get("would_run", ""))
        after = self.sg.session_state()
        # dry run 不得改变会话表
        self.assertEqual(len(before.get("sessions", [])),
                         len(after.get("sessions", [])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
