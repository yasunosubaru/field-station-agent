import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def counted_files() -> int:
    # git ls-files 的输出是纯 ASCII（core.quotepath 会转义中文路径），父进程
    # 按 UTF-8 解码在任何 locale 下都安全 —— 不加 encoding 时 Windows 按
    # GBK 解码，环境一换就有踩线风险。模式同 tests/test_replay.py::_run。
    r = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                       encoding="utf-8", cwd=str(ROOT))
    return len([l for l in r.stdout.splitlines()
                if l.endswith(".py") and (l.startswith("tests/") or l.startswith("src/"))])


class TestAuditClaims(unittest.TestCase):
    def _run(self, doc_text):
        with tempfile.TemporaryDirectory() as td:
            doc = pathlib.Path(td) / "claim.md"
            doc.write_text(doc_text, encoding="utf-8")
            # encoding 与 env 必须**成对**出现，缺一即破：
            # - 子进程 `tools/audit_claims.py` 默认按 locale 吐 GBK（含中文报告行），
            #   所以要把子进程钉成 UTF-8 输出（PYTHONIOENCODING）；
            # - 父进程再按 UTF-8 解码（encoding），errors="replace" 兜住残余字节。
            # 只给父进程加 encoding 会把默认环境打红（实测
            # `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xc9`）；
            # 两个环境（默认 / PYTHONIOENCODING=utf-8）均已实测各 105 OK。
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "utf-8"
            r = subprocess.run([sys.executable, str(ROOT / "tools" / "audit_claims.py"),
                                "--doc", str(doc)],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", cwd=str(ROOT), env=env)
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
