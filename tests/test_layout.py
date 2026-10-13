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
    "README.md", "CLAUDE.md", "PROVENANCE.md",
]


class TestLayout(unittest.TestCase):
    def test_all_required_paths_exist(self):
        for rel in REQUIRED:
            with self.subTest(rel=rel):
                self.assertTrue((ROOT / rel).exists(), f"missing {rel}")