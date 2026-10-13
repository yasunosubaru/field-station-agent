import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def counted_files() -> int:
    r = subprocess.run(["git", "ls-files"], capture_output=True, text=True, cwd=str(ROOT))
    return len([l for l in r.stdout.splitlines()
                if l.endswith(".py") and (l.startswith("tests/") or l.startswith("src/"))])


class TestAuditClaims(unittest.TestCase):
    def _run(self, doc_text):
        with tempfile.TemporaryDirectory() as td:
            doc = pathlib.Path(td) / "claim.md"
            doc.write_text(doc_text, encoding="utf-8")
            r = subprocess.run([sys.executable, str(ROOT / "tools" / "audit_claims.py"),
                                "--doc", str(doc)],
                               capture_output=True, text=True, cwd=str(ROOT))
            return r.returncode, r.stdout + r.stderr

    def test_correct_number_passes(self):
        n = counted_files()
        rc, out = self._run(f"入库 Python 文件数：{n} 个\n")
        self.assertEqual(rc, 0, out)

    def test_wrong_number_is_detected(self):
        n = counted_files() + 1
        rc, out = self._run(f"入库 Python 文件数：{n} 个\n")
        self.assertNotEqual(rc, 0, out)
        self.assertIn("FAIL", out)          # 钉住"报错是因为发现不符"，不是因为脚本崩了

    def test_unverifiable_claim_is_flagged(self):
        rc, out = self._run("某个无法回源核对的数字：314159 个\n")
        self.assertNotEqual(rc, 0, out)
        self.assertIn("UNVERIFIED", out)


if __name__ == "__main__":
    unittest.main()
