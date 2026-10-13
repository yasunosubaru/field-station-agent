#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布门禁自检：五项，逐条 PASS/FAIL，任一 FAIL 非零退出。

::

    $env:PYTHONPATH="src"; python harness/selftest.py   # 完整五项（固定命令）
    python harness/selftest.py --item 1                  # 只跑第 1 项
    python harness/selftest.py --item 1,3                # 跑第 1、3 项

退出码 ``0`` 当且仅当**被选中的每一项都 PASS 且至少跑了一项**；任一 FAIL 为 ``1``，
用法错误为 ``2``。

五项分别钉住什么：

1. **tests/ 全绿且 skipped == 0** —— 从 unittest runner 的结果对象读
   ``result.skipped``，不靠人眼看输出。仓库既有教训（见 `.gitignore` 顶部注释）：
   fixture 未入库时 3 个测试**静默跳过**，而 unittest 对 skip 不报错，
   `OK` 照样打印 —— 门禁就这么假绿过。跳过必须被当作失败显式拦下来。
2. **无源项目包名残留** —— `src/ tests/ harness/ tools/` 下所有 `.py`
   （含注释与 docstring）零命中；扫描器自己也在扫描范围内，不设豁免。
3. **PROVENANCE.md 与 src/ 双向一致** —— 表里每行「新位置」都存在；
   `src/` 下每个 `.py` 要么已登记、要么是本项目原创（各包 `__init__.py`
   与 `agents/` 运行时）。与 `tests/test_provenance.py` 共用同一份解析器。
4. **合成 fixture 生成可复现** —— 同 seed 两次 `config_hash` 相同，
   且换 seed 后必须不同（否则一个恒定返回的假实现也能过）。
5. **tools/audit_claims.py 退出码 0** —— README 机维护块与仓库实际状态一致。

本脚本只用标准库；跑第 1 项时**不接真实模型、不联网**（被测测试自身也不接）。
"""
from __future__ import annotations

import argparse
import datetime
import io
import os
import subprocess
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

#: 源项目包名。**由拼接构造** —— 本文件在第 2 项扫描范围内，
#: 字面量写出来这条门禁会先命中它自己（同 tests/test_no_foreign_refs.py）。
NEEDLE = "gns" + "stec"

#: 第 2 项的扫描目录。
SCAN_DIRS = ("src", "tests", "harness", "tools")

#: 本项目原创、按登记规则无需入表的 src 子树（智能体运行时，Task 7 从零写）。
#: 各包 `__init__.py` 同样原创。新增**整块原创**的 src 子树时把前缀加到这里 ——
#: 这是一次有意识的口径扩展，不是自动放行。
ORIGINAL_SRC_PREFIXES = ("src/fieldstation/agents/",)


# ---------------------------------------------------------------- 第 1 项
def check_tests() -> tuple[bool, list[str]]:
    """跑完整测试套件，从结果对象读 skipped / failures / errors。"""
    buf = io.StringIO()
    suite = unittest.TestLoader().discover(
        str(ROOT / "tests"), pattern="test*.py", top_level_dir=str(ROOT))
    result = unittest.TextTestRunner(stream=buf, verbosity=1).run(suite)

    lines = [
        f"  发现并运行 {result.testsRun} 个测试",
        f"  失败 {len(result.failures)}  错误 {len(result.errors)}  "
        f"跳过 {len(result.skipped)}",
    ]
    ok = True
    if result.testsRun == 0:
        lines.append("  !! 一个测试都没发现 —— 门禁在空转")
        ok = False
    if not result.wasSuccessful():
        ok = False
        lines.append("  !! 有用例失败/错误：")
        for case, _tb in result.failures + result.errors:
            lines.append(f"    {case.id()}")
        lines.append("  --- runner 输出尾部 ---")
        lines.extend("    " + ln for ln in buf.getvalue().splitlines()[-25:])
    if result.skipped:
        # 这一条是本项存在的全部理由：unittest 把 skip 当"没意见"，
        # wasSuccessful() 对它返回 True，只看 OK 会漏掉整块覆盖。
        ok = False
        lines.append("  !! 存在静默跳过（skip != 通过，本门禁显式拦截）：")
        for case, reason in result.skipped:
            lines.append(f"    {case.id()}  --  {reason}")
    return ok, lines


# ---------------------------------------------------------------- 第 2 项
def check_no_foreign_refs() -> tuple[bool, list[str]]:
    hits: list[str] = []
    n_files = 0
    for rel in SCAN_DIRS:
        for p in sorted((ROOT / rel).rglob("*.py")):
            n_files += 1
            if NEEDLE in p.read_text(encoding="utf-8", errors="replace"):
                hits.append(p.relative_to(ROOT).as_posix())
    lines = [f"  扫描 {'/'.join(SCAN_DIRS)} 下 {n_files} 个 .py，命中 {len(hits)} 处"]
    if hits:
        lines.append("  !! 源项目包名残留（含注释与 docstring，扫描器自身不豁免）：")
        lines.extend("    " + h for h in hits)
        return False, lines
    return True, lines


# ---------------------------------------------------------------- 第 3 项
def _is_original_src(rel: str) -> bool:
    """本项目原创、无需登记的 src 文件（口径见 ORIGINAL_SRC_PREFIXES 注释）。"""
    return rel.endswith("__init__.py") or any(
        rel.startswith(p) for p in ORIGINAL_SRC_PREFIXES)


def check_provenance() -> tuple[bool, list[str]]:
    from tests.test_provenance import DERIVED_FROM_SOURCE, registered_locations

    registered = registered_locations()
    src_files = sorted(p.relative_to(ROOT).as_posix()
                       for p in (ROOT / "src").rglob("*.py"))
    lines = [f"  登记 {len(registered)} 行，src/ 下 {len(src_files)} 个 .py"
             f"（其中原创豁免 {sum(1 for f in src_files if _is_original_src(f))} 个）"]
    problems: list[str] = []
    if not registered:
        problems.append("表格解析为空（解析器或表格格式走样）")
    ghosts = [p for p in registered if not (ROOT / p).is_file()]
    if ghosts:
        problems.append(f"登记的新位置不存在: {ghosts}")
    missing = [p for p in DERIVED_FROM_SOURCE if p not in registered]
    if missing:
        problems.append(f"派生文件未登记: {missing}")
    unreg = [f for f in src_files
             if f not in registered and not _is_original_src(f)]
    if unreg:
        problems.append(f"src/ 下既未登记也非本项目原创的文件: {unreg}")
    if problems:
        lines.append("  !! PROVENANCE 与 src/ 不再双向一致：")
        lines.extend("    " + p for p in problems)
        return False, lines
    lines.append("  双向一致：行行有文件，src/ 无漏账")
    return True, lines


# ---------------------------------------------------------------- 第 4 项
def check_fixture_reproducible() -> tuple[bool, list[str]]:
    from fieldstation import synthetic
    from fieldstation.store import product

    cfg_a = synthetic.default_cfg()
    cfg_b = synthetic.default_cfg()
    h_cfg_a = product.config_hash(cfg_a)
    h_cfg_b = product.config_hash(cfg_b)
    h_gen_a = product.config_hash(synthetic.generate(cfg_a)[2])
    h_gen_b = product.config_hash(synthetic.generate(cfg_b)[2])
    h_other = product.config_hash(
        synthetic.generate(synthetic.default_cfg(seed=1))[2])

    lines = [
        f"  default_cfg 两次   {h_cfg_a}",
        f"                     {h_cfg_b}",
        f"  generate 生效配置   {h_gen_a}",
        f"                     {h_gen_b}",
        f"  换 seed=1          {h_other}",
    ]
    ok = True
    if not (h_cfg_a == h_cfg_b == h_gen_a == h_gen_b):
        ok = False
        lines.append("  !! 同 seed 两次 config_hash 不同 —— fixture 不可复现")
    if h_other == h_gen_a:
        ok = False
        lines.append("  !! 换 seed 后 config_hash 不变 —— 种子没起作用，"
                     "恒定返回的假实现也能过")
    return ok, lines


# ---------------------------------------------------------------- 第 5 项
def check_audit_claims() -> tuple[bool, list[str]]:
    env = dict(os.environ)
    # 与 test_replay 同一口径：子进程 stdio 钉死 UTF-8，解码才不会拿到乱码。
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "audit_claims.py")],
        cwd=str(ROOT), capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=env, timeout=300)
    out = (r.stdout or "") + (r.stderr or "")
    lines = [f"  退出码 {r.returncode}"]
    lines.extend("    " + ln for ln in out.splitlines())
    if r.returncode != 0:
        lines.append("  !! README 机维护块与仓库实际状态不符"
                     "（先跑 python tools/sync_code_counts.py 再复核）")
        return False, lines
    return True, lines


# ---------------------------------------------------------------- 主流程
CHECKS = (
    ("tests/ 全绿且 skipped == 0（读 result.skipped）", check_tests),
    ("无源项目包名残留（src/tests/harness/tools 的 .py）", check_no_foreign_refs),
    ("PROVENANCE.md 与 src/ 双向一致", check_provenance),
    ("同 seed 两次 config_hash 相同", check_fixture_reproducible),
    ("tools/audit_claims.py 退出码 0", check_audit_claims),
)


def main(argv=None) -> int:
    # 被重定向到管道/文件时，Windows 的 stdout 是 locale 编码（本机 GBK），
    # 而测试输出里可能夹带任何 Unicode 字符（乱码、替换符）—— 直接 print
    # 会抛 UnicodeEncodeError 把自检本身搞崩（2026-10-13 实测踩过）：
    # 门禁崩在"打印失败详情"这一步，比 FAIL 更糟。降级为替换符，绝不崩。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):   # pragma: no cover
            pass

    ap = argparse.ArgumentParser(
        description="发布门禁自检（五项，任一 FAIL 非零退出）")
    ap.add_argument("--item", default="",
                    help="只跑含这些序号的项，逗号分隔，如 1,3（缺省跑全部）")
    args = ap.parse_args(argv)

    want = None
    if args.item:
        try:
            want = {int(x) for x in args.item.split(",") if x.strip()}
        except ValueError:
            print(f"[阻断] --item 只接受数字序号: {args.item!r}")
            return 2
        bad = sorted(x for x in want if not 1 <= x <= len(CHECKS))
        if bad or not want:
            print(f"[阻断] 无效序号 {bad or args.item!r}，有效范围 1..{len(CHECKS)}")
            return 2

    w = 78
    print("=" * w)
    print("harness 自检（发布门禁）  ——  "
          + datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * w)

    n_pass = n_run = 0
    results: list[tuple[int, str, bool | None]] = []
    for i, (title, fn) in enumerate(CHECKS, 1):
        if want is not None and i not in want:
            continue
        print(f"\n[{i}] {title}")
        try:
            ok, lines = fn()
        except Exception as exc:                       # noqa: BLE001
            import traceback
            ok = False
            lines = [f"  !! 检查本身抛异常: {type(exc).__name__}: {exc}",
                     traceback.format_exc()[-1500:]]
        for ln in lines:
            print(ln)
        n_run += 1
        n_pass += 1 if ok else 0
        print(f"  => {'PASS' if ok else 'FAIL'}")
        results.append((i, title, ok))

    print()
    print("=" * w)
    for i, title, ok in results:
        print(f"  [{i}] {title:<48} {'PASS' if ok else 'FAIL'}")
    print("-" * w)
    print(f"  合计 {n_pass}/{n_run} PASS"
          + (f"（{n_run - n_pass} FAIL）" if n_run - n_pass else ""))
    print("=" * w)
    return 0 if (n_run and n_pass == n_run) else 1


if __name__ == "__main__":
    sys.exit(main())
