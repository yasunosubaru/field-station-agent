import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED = [
    "src/fieldstation/__init__.py",
    "src/fieldstation/rules/__init__.py",
    "src/fieldstation/ingest/__init__.py",
    "src/fieldstation/store/__init__.py",
    "src/fieldstation/agents/__init__.py",
    "data/.gitkeep", "logs/.gitkeep", "figures/.gitkeep", "config/.gitkeep",
    "tests/__init__.py",
    "README.md", "CLAUDE.md", "PROVENANCE.md",
    # spec §2 的两个叶子，M0 静默掉落、由 issue #5 补建（docs/known-issues.md KI-08）。
    # 钉住存在：「静默掉落」的反面就是有人再次删掉它而没有任何测试变红。
    "src/fieldstation/cli.py",
    "harness/REPRODUCE.md",
]


class TestLayout(unittest.TestCase):
    def test_all_required_paths_exist(self):
        for rel in REQUIRED:
            with self.subTest(rel=rel):
                self.assertTrue((ROOT / rel).is_file(), f"missing {rel}")

    def test_superpowers_stays_ignored(self):
        r = subprocess.run(["git", "check-ignore", "-q", ".superpowers/probe.md"],
                           cwd=ROOT)
        self.assertEqual(r.returncode, 0, ".superpowers/ 不再被 ignore")
