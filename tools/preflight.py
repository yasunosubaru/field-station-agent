# -*- coding: utf-8 -*-
"""本地合并前检查：一次跑完所有门禁，输出一张表。

用法：
    python tools/preflight.py            # 全量（Python + Node + 门禁）
    python tools/preflight.py --fast     # 跳过 Node（改 Python 时用）

退出码：全绿 0，否则 1。任何一项失败都会把最后 2000 字输出打出来，不用翻日志。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "逆向" / "04_重实现"


def run(name: str, args: list[str], cwd: Path, timeout: int = 1800) -> tuple[bool, str]:
    try:
        proc = subprocess.run(args, cwd=str(cwd), capture_output=True, timeout=timeout)
    except FileNotFoundError:
        return False, "%s 不存在" % args[0]
    except subprocess.TimeoutExpired:
        return False, "超时（%ss）" % timeout
    out = (proc.stdout or b"").decode("utf-8", "replace") + (proc.stderr or b"").decode("utf-8", "replace")
    return proc.returncode == 0, out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="合并前门禁")
    ap.add_argument("--fast", action="store_true", help="跳过 Node 测试")
    ap.add_argument("--node-only", action="store_true", help="只跑 Node 测试")
    args = ap.parse_args(argv)

    py = sys.executable
    checks: list[tuple[str, list[str], Path]] = []

    if not args.node_only:
        checks += [
            ("unittest", [py, "-m", "unittest", "discover", "-s", "tests", "-t", "."], ROOT),
            ("selftest", [py, "harness/selftest.py"], ROOT),
            ("workflow validate", [py, "tools/workflow_cli.py", "validate"], ROOT),
            ("desensitization", [py, "tools/check_desensitization.py"], ROOT),
        ]
    if not args.fast:
        checks.append(("node tests", ["node", "--test", "--test-force-exit",
                                      "packages/app/test/*.test.ts"], APP))

    rows, failures = [], []
    for name, cmd, cwd in checks:
        ok, out = run(name, cmd, cwd)
        detail = ""
        if not ok:
            tail = out.strip().splitlines()[-12:]
            detail = " | ".join(line.strip() for line in tail)[:300]
            failures.append((name, out))
        rows.append((name, "PASS" if ok else "FAIL", detail))

    width = max(len(r[0]) for r in rows)
    print("=" * (width + 60))
    for name, status, detail in rows:
        print("%-*s  %-4s  %s" % (width, name, status, detail))
    print("=" * (width + 60))

    if failures:
        for name, out in failures:
            print("\n----- %s -----" % name)
            print("\n".join(out.strip().splitlines()[-25:]))
        print("\n合计 %d/%d PASS —— 有失败" % (len(rows) - len(failures), len(rows)))
        return 1
    print("合计 %d/%d PASS" % (len(rows), len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
