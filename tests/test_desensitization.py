"""脱敏守卫（tools/check_desensitization.py）的绊线行为。

两类断言：

* **模式本身**：合成 PII 必须命中；正常技术内容（种子、sha、十进制常数、
  测试用的 ``C:\\x.json``）必须不命中 —— 误报会把门禁逼成摆设，然后被人关掉；
* **端到端**：临时 git 仓库里放坏样本 → 退出 1 且**不回显命中内容**；干净 → 0；
  非 git 仓库 → 2；本地词表被 git 跟踪 → 2；当前仓库自身干净（这条就是 CI 门禁）。

注意：守卫是**绊线不是证明**（M0 决策第 24 条：两版正则都假报过 0 命中）。
测试只钉它该抓的形状，不宣称它覆盖全部 PII。

**本文件里的合成样本全部由片段拼接**：如果写成完整字面量，守卫会（正确地）
把自己也抓出来 —— 这既是自测，也避免仓库里出现真实形状的号码。
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "check_desensitization.py"

# 合成样本：运行时拼接，源码里不出现完整形状。
PHONE = "138" + "0013" + "8000"
EMAIL = "a.student" + "@" + "example.com"
STUDENT_ID = "2023" + "123456789"
WIN_PATH = "C:\\Users\\" + "alice" + "\\secret.txt"
UNIX_PATH = "/home/" + "alice" + "/notes"
CJK_PATH = "D:\\" + "项目" + "资料\\清单.xlsx"
TOKEN = "ghp_" + "a" * 36
PRIVATE_KEY = "-----BEGIN " + "OPENSSH PRIVATE KEY-----"
DENY_NAME = "张" + "三"


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=120)


def _module():
    spec = importlib.util.spec_from_file_location("check_desensitization", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git_repo(td: Path, files: dict[str, str]) -> Path:
    subprocess.run(["git", "init", "-q", str(td)], check=True)
    for rel, text in files.items():
        path = td / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    subprocess.run(["git", "-C", str(td), "add", "-A"], check=True)
    return td


class TestPatterns(unittest.TestCase):
    def setUp(self):
        self.module = _module()

    def _categories(self, line: str, denylist=None) -> set[str]:
        return {category for category, _ in
                self.module.scan_line(line, denylist or [])}

    def test_synthetic_pii_fires(self):
        cases = {
            "mobile": f"联系电话 {PHONE}",
            "email": f"联系 {EMAIL} 处理",
            "student_id": f"学号 {STUDENT_ID} 已登记",
            "home_path_win": f"路径 {WIN_PATH} 已删除",
            "home_path_unix": f"路径 {UNIX_PATH} 已删除",
            "local_path_cjk": f"路径 {CJK_PATH} 已删除",
            "private_key": PRIVATE_KEY,
            "github_token": f"token {TOKEN}",
        }
        for category, line in cases.items():
            with self.subTest(category=category):
                self.assertIn(category, self._categories(line))

    def test_denylist_literal_fires(self):
        self.assertIn("denylist#1",
                      self._categories(f"成员：{DENY_NAME}", [DENY_NAME]))

    def test_clean_technical_content_does_not_fire(self):
        clean = [
            "seed=20261013",
            "sha256 164085a8c0e5ed7ba8d78be935527193e3f16955bcf8ebc980dce72d74",
            "limit = 299792458.0 / 0.1902936728 * margin",
            r'"C:\\x.json", "\\\\server\\share\\x.json"',
            "20240010000",
            "station/BADG alert/A-0001 order/WO-0001",
            "http://127.0.0.1:9001/m5_dashboard.html",
            "GPS 01 L1 +5.0 cycles @ epoch 30",
        ]
        for line in clean:
            with self.subTest(line=line):
                self.assertEqual(self._categories(line), set(), line)


class TestCommandLine(unittest.TestCase):
    def test_repository_is_clean(self):
        """CI 门禁本体：当前入库文件不得命中通用模式。"""
        run = _run()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("命中 0 处", run.stdout)

    def test_dirty_repo_fails_without_echoing_value(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            _git_repo(td, {"docs/leak.md": f"联系电话 {PHONE}\n"})
            run = _run("--root", str(td),
                       "--denylist", str(td / "no-denylist.txt"))
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("mobile", run.stdout)
            self.assertIn("docs/leak.md:1", run.stdout)
            # 公开 CI 日志不能二次泄露：默认输出不得包含命中值
            self.assertNotIn(PHONE, run.stdout)
            shown = _run("--root", str(td),
                         "--denylist", str(td / "no-denylist.txt"),
                         "--show-hits")
            self.assertIn(PHONE, shown.stdout)

    def test_denylist_hit_redacted_and_tracked_denylist_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            _git_repo(td, {"docs/team.md": f"成员：{DENY_NAME}\n"})
            denylist = td / "tools" / "desensitization.local.txt"
            denylist.parent.mkdir(parents=True, exist_ok=True)
            denylist.write_text(DENY_NAME + "\n", encoding="utf-8")  # 先不 add
            run = _run("--root", str(td), "--denylist", str(denylist))
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("denylist#1", run.stdout)
            self.assertNotIn(DENY_NAME, run.stdout)

            subprocess.run(["git", "-C", str(td), "add", "-A"], check=True)
            tracked = _run("--root", str(td), "--denylist", str(denylist))
            self.assertEqual(tracked.returncode, 2, tracked.stdout + tracked.stderr)
            self.assertIn("被 git 跟踪", tracked.stdout)

    def test_not_a_git_repo_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            run = _run("--root", td, "--denylist", str(Path(td) / "none.txt"))
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn("[阻断]", run.stdout)


if __name__ == "__main__":
    unittest.main()
