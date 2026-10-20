"""环境快照（tools/env_snapshot.py）。

钉住三件事：

* 快照字段齐全（Python / OS / git / 依赖 / 模型通道），且第三方 import 只列真正的
  第三方（标准库与仓库内模块被过滤）；
* **不含本机绝对路径**（公开仓库）；
* 同一工作区两次生成逐字节相同（不含时间戳/随机量）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "env_snapshot.py"
ABS_PATH = re.compile(r"(?:[A-Za-z]:\\|/(?:home|Users)/)")


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(ROOT), env=env, timeout=120)


def _git_commit(td: Path) -> None:
    subprocess.run(["git", "-C", str(td), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(td), "-c", "user.name=test", "-c", "user.email=test@example.com",
         "commit", "-q", "-m", "fixture"],
        check=True)


class TestEnvSnapshot(unittest.TestCase):
    def test_snapshot_fields_and_no_absolute_paths(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "env.json"
            run = _run("--out", str(out))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["kind"], "fieldstation.env_snapshot")
            self.assertEqual(data["version"], 1)
            self.assertTrue(data["python"]["version"])
            self.assertTrue(data["platform"]["system"])
            self.assertRegex(data["git"]["commit"], r"^[0-9a-f]{40}$")
            self.assertIsInstance(data["git"]["dirty"], bool)
            self.assertIn("matplotlib", data["dependencies"]["third_party_imports"])
            self.assertFalse(data["dependencies"]["tests_use_third_party"])
            self.assertIsInstance(data["model_channel"], list)
            self.assertIn("ollama", [p["name"] for p in data["model_channel"]])
            # 公开仓库：快照里不能出现本机绝对路径
            self.assertIsNone(ABS_PATH.search(out.read_text(encoding="utf-8")))

    def test_two_runs_are_byte_identical(self):
        with tempfile.TemporaryDirectory() as td:
            first = Path(td) / "a.json"
            second = Path(td) / "b.json"
            for out in (first, second):
                run = _run("--out", str(out))
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertNotIn(b"\r\n", first.read_bytes())

    def test_minimal_repo_filters_stdlib_and_local_modules(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            subprocess.run(["git", "init", "-q", str(td)], check=True)
            (td / "src").mkdir()
            (td / "src" / "app.py").write_text(
                "import json\nimport os\nfrom . import helper\n"
                "import matplotlib\n", encoding="utf-8")
            (td / "tools").mkdir()
            (td / "tools" / "helper.py").write_text("import pathlib\n",
                                                    encoding="utf-8")
            _git_commit(td)
            out = td / "env.json"
            run = _run("--root", str(td), "--out", str(out))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["dependencies"]["third_party_imports"],
                             ["matplotlib"])
            self.assertEqual(data["model_channel"], [])

    def test_not_a_git_repo_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            run = _run("--root", td, "--out", str(Path(td) / "env.json"))
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn("[阻断]", run.stdout)


if __name__ == "__main__":
    unittest.main()
