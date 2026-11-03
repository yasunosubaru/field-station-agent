#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_desensitization.py —— 公开仓库的脱敏守卫。

## 它做什么 / 不做什么

扫描 **git 入库** 的文本文件，按两类规则报可疑内容：

1. **通用模式**（高置信、低误报）：Windows 用户目录路径、Unix 家目录路径、
   盘符 + 中文路径、邮箱、中国大陆手机号、13 位学号形状（19xx/20xx 开头）、
   私钥头、GitHub token。
2. **本地词表**（可选，gitignored）：`tools/desensitization.local.txt` 一行一个字面值，
   用于姓名、其他长度的学号、其他本机路径等**无法安全写进公开仓库**的类别 ——
   词表本身不能入库，否则守卫就成了泄露源。CI 上没有这个词表时打印 `[SKIP]`。

三类命中会被区别对待，都不是静默放行：

- **证据文件**（`EVIDENCE_PREFIXES`）：厂商软件与真机自己写出来的文件，里面的本机路径是
  **证据本体**（逐字节比对就是拿它们当基准，改一个字比对就失效）。这些命中**单独计数并打印**，
  默认不计入退出码；`--strict` 打开后一并计入。放开的地方只有这一个前缀列表。
- **厂商支持邮箱**（`EMAIL_ALLOWED_SUFFIXES`）：厂商自己的公开支持地址不算个人数据。
- **收紧过的模式**：`mobile` 与 `home_path_unix` 曾把十六进制串、浮点小数与 URL 路径
  （`url("/home/x.png")`）误报成号码与家目录；误报会把门禁逼成摆设，所以按边界收紧。

**它不是一个证明。** M0 的教训（`docs/superpowers/m0-decisions.md` 第 24 条）：
两版正则扫描器都给过假的「0 命中」，最终靠 `git ls-files` + 逐字面值比对才验干净。
这里的定位是**绊线**：抓常见形状 + 本地精确值，降低回归概率，不替代人工复核。

## 输出与退出码

- 命中时只打印 `文件:行 [类别]`，**绝不打印命中内容** —— 公开仓库的 CI 日志也是
  公开的，把命中的手机号/姓名打进日志等于二次泄露。本机排查用 `--show-hits`。
- `0` 干净；`1` 有命中；`2` 用法错误 / 不是 git 仓库 / 本地词表被 git 跟踪。

## 用法

    python tools/check_desensitization.py
    python tools/check_desensitization.py --root . --denylist tools/desensitization.local.txt
    python tools/check_desensitization.py --show-hits   # 只在本机用

它只扫 **git 入库** 文件：新文件先 `git add` 再跑，否则不在扫描范围（本地绿灯、
CI 红灯的经典坑）。

本脚本只用标准库。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DENYLIST = ROOT / "tools" / "desensitization.local.txt"
BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
    ".whl", ".sqlite3", ".pyc", ".exe", ".dll", ".so", ".dylib", ".woff",
    ".woff2", ".ttf", ".otf",
}

#: 类别 → 模式。顺序即报告顺序；模式必须低误报（M0 第 24 条）。
#:
#: `mobile` 与 `home_path_unix` 的边界是后加的：前者曾在 SHA-256 十六进制串与
#: `1.15960574476e-11` 这类小数里误报（11 位数字正好落在 `1[3-9]` 上），
#: 后者曾在 `url("/home/grit-icon.png")` 这类 URL 路径上误报。误报会把门禁逼成摆设。
PATTERNS: tuple[tuple[str, re.Pattern], ...] = (
    ("home_path_win", re.compile(r"[A-Za-z]:\\Users\\[^\\\s\"'`]+")),
    ("home_path_unix", re.compile(r"(?<![A-Za-z0-9._])(?<![/(\"'=])/(?:home|Users)/[A-Za-z0-9._-]+")),
    ("local_path_cjk", re.compile(r"[A-Za-z]:\\[^\s\"'`]*[\u4e00-\u9fff][^\s\"'`]*")),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("mobile", re.compile(r"(?<![0-9A-Za-z.])1[3-9]\d{9}(?![0-9A-Za-z.])")),
    ("student_id", re.compile(r"(?<![\d.])(?:19|20)\d{11}(?![\d.])")),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----")),
    ("github_token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
)

#: 厂商自己的公开支持地址：不是个人数据，报出来只会淹掉真信号。
EMAIL_ALLOWED_SUFFIXES = ("@hexagon.com", "@novatel.com")

#: 证据原样目录：厂商软件或真机自己写出来的文件。里面的本机路径是**证据本体**，
#: 逐字节比对就是拿它们当基准，改一个字比对即失效，所以整目录豁免 —— 但**逐条计数并打印**，
#: 且 `--strict` 会把它们计入退出码。放开的地方只有这一个前缀列表，别往里加自己的文件。
EVIDENCE_PREFIXES = ("逆向/00_来源/samples/",)


def is_evidence(rel: str) -> bool:
    """该入库路径是否属于「证据原样」目录。"""
    return any(rel.startswith(prefix) for prefix in EVIDENCE_PREFIXES)


class ScanError(Exception):
    """用法或环境错误（退出码 2）。"""


def tracked_files(root: Path) -> list[str]:
    """入库文件列表。``core.quotepath=false`` 防止中文路径被转义（M0 的坑）。"""
    result = subprocess.run(
        ["git", "-C", str(root), "-c", "core.quotepath=false",
         "ls-files", "-z"],
        capture_output=True)
    if result.returncode != 0:
        raise ScanError(f"不是 git 仓库或 git 不可用：{root}")
    return [name for name in result.stdout.decode("utf-8", "replace").split("\0")
            if name]


def is_tracked(root: Path, path: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--error-unmatch", str(path)],
        capture_output=True)
    return result.returncode == 0


def load_denylist(path: Path) -> list[str]:
    """一行一个字面值；空行与 ``#`` 注释跳过。"""
    values = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.strip()
        if value and not value.startswith("#"):
            values.append(value)
    return values


def scan_line(line: str, denylist: list[str]) -> list[tuple[str, str]]:
    """返回 [(类别, 命中内容)]。调用方决定是否打印内容。"""
    hits: list[tuple[str, str]] = []
    for name, pattern in PATTERNS:
        for match in pattern.finditer(line):
            value = match.group(0)
            if name == "email" and value.lower().endswith(EMAIL_ALLOWED_SUFFIXES):
                continue
            hits.append((name, value))
    for index, value in enumerate(denylist, 1):
        if value in line:
            hits.append((f"denylist#{index}", value))
    return hits


def _looks_binary(path: Path) -> bool:
    if path.suffix.lower() in BINARY_SUFFIXES:
        return True
    try:
        with path.open("rb") as handle:
            return b"\0" in handle.read(8192)
    except OSError:
        return True


def scan(root: Path, denylist: list[str], *, show_hits: bool = False) -> dict:
    """扫描入库文本。

    返回 ``{files, skipped, hits, evidence}``：``hits`` 是**非证据**命中（决定退出码），
    ``evidence`` 是证据目录里的命中（默认只报数）。
    """
    files = tracked_files(root)
    hits: list[tuple[str, int, str, str]] = []
    evidence: list[tuple[str, int, str, str]] = []
    skipped = 0
    for rel in files:
        path = root / rel
        if _looks_binary(path):
            skipped += 1
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            skipped += 1
            continue
        bucket = evidence if is_evidence(rel) else hits
        for line_no, line in enumerate(text.splitlines(), 1):
            for category, match in scan_line(line, denylist):
                bucket.append((rel, line_no, category, match))
    return {"files": len(files), "skipped": skipped,
            "hits": hits, "evidence": evidence}


def _report_evidence(evidence, deny: bool) -> None:
    """证据目录的命中：按文件汇总打印（逐行打印会把 CI 日志刷成一片）。"""
    per_file: dict[str, int] = {}
    for rel, _line_no, _category, _match in evidence:
        per_file[rel] = per_file.get(rel, 0) + 1
    total = len(evidence)
    print(f"证据豁免 {total} 处（{len(per_file)} 个文件，{EVIDENCE_PREFIXES[0]} 等；"
          f"厂商/真机原样文件，见 docs/known-issues.md 的 KI-12）：")
    for rel, count in sorted(per_file.items())[:12]:
        print(f"  {rel}  ×{count}")
    if len(per_file) > 12:
        print(f"  …… 另有 {len(per_file) - 12} 个文件")
    if deny:
        print("  （--strict：证据命中同样计入退出码）")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="公开仓库脱敏守卫（绊线，不是证明）")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--denylist", default=str(DEFAULT_DENYLIST))
    parser.add_argument("--show-hits", action="store_true",
                        help="打印命中内容（只在本机用；CI 上会把 PII 写进公开日志）")
    parser.add_argument("--strict", action="store_true",
                        help="把证据目录（厂商/真机原样文件）的命中一并计入退出码")
    args = parser.parse_args(argv)

    root = Path(args.root)
    denylist_path = Path(args.denylist)
    try:
        if denylist_path.is_file():
            if is_tracked(root, denylist_path):
                raise ScanError(
                    f"本地词表被 git 跟踪：{denylist_path}（词表本身不能入库）")
            denylist = load_denylist(denylist_path)
        else:
            denylist = []
        report = scan(root, denylist, show_hits=args.show_hits)
    except ScanError as exc:
        print(f"[阻断] {exc}")
        return 2

    print(f"扫描 {report['files']} 个入库文件"
          f"（跳过 {report['skipped']} 个二进制/不可读）")
    if not denylist_path.is_file():
        print(f"[SKIP] 本地词表不存在：{denylist_path}"
              "（只跑通用模式；姓名等类别需本机自查）")
    elif not denylist:
        print(f"[SKIP] 本地词表为空：{denylist_path}")

    hits = list(report["hits"])
    if args.strict:
        hits += list(report["evidence"])
    if args.strict and report["evidence"]:
        _report_evidence(report["evidence"], deny=True)
    elif report["evidence"] and not hits:
        _report_evidence(report["evidence"], deny=False)

    if not hits:
        print("命中 0 处（非证据文件）")
        return 0

    print(f"命中 {len(hits)} 处：")
    for rel, line_no, category, match in hits:
        suffix = f"  {match!r}" if args.show_hits else ""
        print(f"  {rel}:{line_no}  [{category}]{suffix}")
    print("按仓库纪律：个人姓名、学号、电话、邮箱、本机路径不进公开仓库；"
          "确认为误报时收紧模式或加入本地词表（词表不入库）。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
