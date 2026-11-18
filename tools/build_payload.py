#!/usr/bin/env python3
"""Assemble the payload tree and payload.zip for the All powered-FSA shell.

The WinForms shell (逆向/05_打包/NovAtelReverseGui) embeds one zip as a resource. On first
run it extracts that zip under %LOCALAPPDATA%\\AllPoweredFSA\\app-<version> and starts the
bundled Node runtime against 逆向/04_重实现/packages/app/src/server.ts.

This script is the single source of truth for what goes into that zip. It is standard
library only, never touches the network, and never writes outside --out / --payload-dir.

Usage
-----
    python tools/build_payload.py --check          # list inputs, write nothing, exit 0
    python tools/build_payload.py                  # write the default payload.zip
    python tools/build_payload.py --with-original  # + the installed NovAtel suite (~1.4 GB)
    python tools/build_payload.py --payload-dir tmp/payload   # also leave an unpacked copy
    python tools/build_payload.py --print-default-out         # print the default zip path

The zip is written with fixed member timestamps and a stable member order, so the same
inputs produce the same bytes. manifest.json inside the payload records per-item file
counts, byte counts and a name+size digest; a handful of files per item also get a real
content SHA-256 (the full 400 MB tree is deliberately not hashed - it would add minutes
to every build for no diagnostic gain).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

PRODUCT = "All powered-FSA"
VERSION = "0.2.0"
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
CHUNK = 1 << 20

PACKAGING_REL = Path("逆向") / "05_打包" / "NovAtelReverseGui"
DEFAULT_OUT = PACKAGING_REL / "payload.zip"
DEFAULT_SUITE = Path(r"C:\Program Files\NovAtel Inc\NovAtel Application Suite")
DEFAULT_NODE = Path(r"C:\Program Files\nodejs\node.exe")

SKIP_DIR_NAMES = {
    ".git", ".svn", ".hg", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".venv", "venv", ".idea", ".vs", ".vscode", ".cache",
}
SKIP_FILE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
SKIP_FILE_SUFFIXES = (".pyc", ".pyo", ".tmp", ".swp")

# packages/app needs the serialport stack at runtime (Add Device); everything else in
# node_modules is dev-only and would add megabytes for nothing.
SERIALPORT_KEEP = (
    "serialport",
    "@serialport",
    "debug",
    "ms",
    "node-gyp-build",
    "node-addon-api",
)


@dataclass(frozen=True)
class Item:
    """One top-level entry of the payload tree."""

    arc: str                      # member prefix inside the zip
    rel: str = ""                 # source path, relative to --root (or absolute)
    kind: str = "dir"             # "dir" | "file"
    required: bool = True
    note: str = ""
    node_modules_keep: tuple[str, ...] = ()
    exclude_rel: tuple[str, ...] = ()


ITEMS: tuple[Item, ...] = (
    Item("逆向/04_重实现", "逆向/04_重实现",
         note="the TypeScript reimplementation, incl. packages/app/node_modules/serialport",
         node_modules_keep=SERIALPORT_KEEP),
    Item("逆向/00_来源/samples", "逆向/00_来源/samples",
         note="sample captures the app opens on first run"),
    Item("逆向/01_解包/app/view", "逆向/01_解包/app/view"),
    Item("逆向/01_解包/app/model", "逆向/01_解包/app/model"),
    Item("逆向/01_解包/app/assets", "逆向/01_解包/app/assets"),
    Item("逆向/01_解包/app/controller", "逆向/01_解包/app/controller"),
    Item("逆向/01_解包/Graph/out/renderer/assets", "逆向/01_解包/Graph/out/renderer/assets"),
    Item("workflows", "workflows", note="fixed workflows, without jobs/",
         exclude_rel=("jobs",)),
    Item("src/fieldstation", "src/fieldstation"),
    Item("tools/workflow_cli.py", "tools/workflow_cli.py", kind="file"),
    Item("tools/uia_driver.py", "tools/uia_driver.py", kind="file"),
    Item("tools/cdp_driver.py", "tools/cdp_driver.py", kind="file"),
    Item("tools/uia_selectors.json", "tools/uia_selectors.json", kind="file"),
    Item("tools/agent_server.py", "tools/agent_server.py", kind="file"),
    Item("tools/agent_store.py", "tools/agent_store.py", kind="file"),
    Item("tools/suite_launcher.py", "tools/suite_launcher.py", kind="file"),
    Item("tools/secret_store.py", "tools/secret_store.py", kind="file"),
    # 几何三层（计划书 §3.3-3.6）。少了任何一个，自体包里对应步骤会 ImportError：
    #   click_engine      三级升级链的真鼠标实现，cdp_driver 与 rpa_fixture 都按路径加载它
    #   rpa_fixture       restore_home 的原始实现（workflows 的 restore_home 步骤依赖）
    #   rpa_calibrate     坐标校准（记录/回放）
    #   rpa_lint          流程静态检查，CI 与验收都要用
    #   *.ps1             setup_display / keep-desktop 是启动链上的两个 PowerShell 步骤
    #   ensure_virtual_display  虚拟屏接桌面，启动链第三步（v6 新增）
    #   install-vdd       首次装机时安装签名 IDD 驱动
    Item("tools/click_engine.py", "tools/click_engine.py", kind="file"),
    Item("tools/rpa_fixture.py", "tools/rpa_fixture.py", kind="file"),
    Item("tools/rpa_calibrate.py", "tools/rpa_calibrate.py", kind="file"),
    Item("tools/rpa_lint.py", "tools/rpa_lint.py", kind="file"),
    Item("tools/setup_display.ps1", "tools/setup_display.ps1", kind="file"),
    Item("tools/keep-desktop.ps1", "tools/keep-desktop.ps1", kind="file"),
    Item("tools/ensure_virtual_display.py", "tools/ensure_virtual_display.py", kind="file"),
    Item("tools/install-vdd.ps1", "tools/install-vdd.ps1", kind="file"),
    Item("config", "config"),
    Item("docs/operations", "docs/operations", required=False,
         note="optional operating docs"),
    Item("docs/product", "docs/product", required=False,
         note="optional product docs"),
    Item("README.md", "README.md", kind="file", required=False),
    Item("LICENSE", "LICENSE", kind="file", required=False),
    Item("PROVENANCE.md", "PROVENANCE.md", kind="file", required=False),
)


@dataclass
class Collected:
    item: Item
    files: list[tuple[str, Path, int]] = field(default_factory=list)
    missing: bool = False
    bytes: int = 0

    @property
    def count(self) -> int:
        return len(self.files)


# --------------------------------------------------------------------------- paths

def repo_root(explicit: str | None) -> Path:
    if explicit:
        root = Path(explicit).expanduser().resolve()
    else:
        root = Path(__file__).resolve().parent.parent
    if not (root / "src" / "fieldstation").is_dir():
        raise SystemExit(f"not a repo root (src/fieldstation missing): {root}")
    return root


def default_out(root: Path) -> Path:
    return root / DEFAULT_OUT


def resolve_source(root: Path, item: Item) -> Path:
    p = Path(item.rel)
    return p if p.is_absolute() else root / p


def find_node(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_file():
            raise SystemExit(f"--node-exe not found: {p}")
        return p.resolve()
    which = shutil.which("node")
    if which:
        return Path(which).resolve()
    if DEFAULT_NODE.is_file():
        return DEFAULT_NODE
    raise SystemExit("node.exe not found: pass --node-exe or put node on PATH")


# ----------------------------------------------------------------------- selection

def allowed(item: Item, rel: str) -> bool:
    parts = rel.split("/")
    name = parts[-1]
    dirs = parts[:-1]

    if any(p in SKIP_DIR_NAMES for p in dirs):
        return False
    if name in SKIP_FILE_NAMES or name.endswith(SKIP_FILE_SUFFIXES):
        return False
    for excluded in item.exclude_rel:
        if rel == excluded or rel.startswith(excluded + "/"):
            return False

    if "node_modules" in dirs:
        if not item.node_modules_keep:
            return False
        idx = dirs.index("node_modules")
        top = dirs[idx + 1] if len(dirs) > idx + 1 else ""
        if top.startswith("@"):
            if top not in item.node_modules_keep:
                return False
        elif top not in item.node_modules_keep:
            return False
    return True


def collect_item(root: Path, item: Item) -> Collected:
    out = Collected(item=item)
    src = resolve_source(root, item)
    if item.kind == "file":
        if src.is_file():
            size = src.stat().st_size
            out.files.append((item.arc, src, size))
            out.bytes = size
        else:
            out.missing = True
        return out
    if not src.is_dir():
        out.missing = True
        return out
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames.sort()
        rel_dir = Path(dirpath).relative_to(src).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        for name in sorted(filenames):
            rel = rel_dir + name
            if not allowed(item, rel):
                continue
            path = Path(dirpath) / name
            try:
                size = path.stat().st_size
            except OSError:
                continue
            out.files.append((f"{item.arc}/{rel}", path, size))
            out.bytes += size
    return out


def collect_abs(src: Path, item: Item) -> Collected:
    """Collect a tree from an absolute path outside the repo (runtime/python, suite/original)."""
    out = Collected(item=item)
    if not src.is_dir():
        out.missing = True
        return out
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames.sort()
        rel_dir = Path(dirpath).relative_to(src).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        for name in sorted(filenames):
            rel = rel_dir + name
            if not allowed(item, rel):
                continue
            path = Path(dirpath) / name
            try:
                size = path.stat().st_size
            except OSError:
                continue
            out.files.append((f"{item.arc}/{rel}", path, size))
            out.bytes += size
    return out


# ---------------------------------------------------------------------- inspection

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def tree_digest(files: list[tuple[str, Path, int]]) -> str:
    digest = hashlib.sha256()
    for arc, _src, size in sorted(files, key=lambda f: f[0]):
        digest.update(f"{arc}\t{size}\n".encode("utf-8"))
    return digest.hexdigest()


def sample_files(files: list[tuple[str, Path, int]], limit: int = 8) -> list[dict]:
    """A few real content hashes per item: enough to spot a swapped tree, cheap to compute."""
    small = sorted((f for f in files if f[2] <= 1 << 20), key=lambda f: f[0])
    if not small:
        return []
    if len(small) <= limit:
        picks = small
    else:
        step = max(1, len(small) // limit)
        picks = small[::step][:limit]
    out = []
    for arc, src, size in picks:
        try:
            out.append({"path": arc, "bytes": size, "sha256": sha256_file(src)})
        except OSError:
            continue
    return out


def human(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{n} B"


def node_info(node: Path) -> dict:
    info = {"path_name": node.name, "bytes": node.stat().st_size}
    try:
        proc = subprocess.run([str(node), "--version"], capture_output=True,
                              text=True, timeout=30)
        info["version"] = (proc.stdout or "").strip() or None
    except (OSError, subprocess.SubprocessError):
        info["version"] = None
    info["sha256"] = sha256_file(node)
    return info


#: embeddable 运行时的必备文件。缺任何一个都不是自足的。
EMBEDDABLE_REQUIRED = ("python.exe", "python311.dll", "python311.zip")
#: 只可能出现在 venv 里的文件。出现即说明传的是 venv。
VENV_MARKERS = ("pyvenv.cfg",)


def validate_python_dir(py_dir: Path) -> list[str]:
    """检查 ``py_dir`` 是不是**可移植的 embeddable** 运行时。返回问题列表（空=合格）。

    两类失败分开报，因为修法完全不同：

    * **venv**（`pyvenv.cfg` 在）：解释器和标准库留在本机 base Python 里，
      包里只有 `site-packages`。体积可以很大（本机实测 1489 MB），
      换台机器必然 `No module named 'encodings'`。
    * **缺文件**：不是 embeddable 解压目录，或者解压不完整。
    """
    problems: list[str] = []
    for marker in VENV_MARKERS:
        if (py_dir / marker).is_file():
            try:
                cfg = (py_dir / marker).read_text(encoding="utf-8", errors="replace")
            except OSError:
                cfg = ""
            home = next((ln.split("=", 1)[1].strip()
                         for ln in cfg.splitlines() if ln.strip().startswith("home")), "")
            problems.append(
                f"这是 venv 而不是 embeddable（发现 {marker}"
                + (f"，home={home}" if home else "")
                + "）。venv 的解释器与标准库在包外，换机器必失效。")
    for name in EMBEDDABLE_REQUIRED:
        if not (py_dir / name).is_file():
            problems.append(f"缺 {name}（embeddable 解压目录里应有它）")
    # embeddable 用 ._pth 控制 sys.path；venv 没有这个文件
    if not any(py_dir.glob("python3*._pth")) and not problems:
        problems.append("缺 python3xx._pth（embeddable 用它设定 sys.path）")
    return problems


def python_info(py_dir: Path | None) -> dict | None:
    if py_dir is None:
        return None
    # embeddable 的 python.exe 在根；venv 的在 Scripts/ 下。两处都认，
    # 但 present/version 只说明「能不能跑」，是否可移植由 validate_python_dir 判。
    exe = py_dir / "python.exe"
    if not exe.is_file():
        exe = py_dir / "Scripts" / "python.exe"
    info: dict = {"exe": str(exe.relative_to(py_dir)).replace("\\", "/"),
                  "present": exe.is_file(),
                  "embeddable": not validate_python_dir(py_dir)}
    if exe.is_file():
        try:
            proc = subprocess.run([str(exe), "-c", "import sys;print(sys.version.split()[0])"],
                                  capture_output=True, text=True, timeout=30)
            info["version"] = (proc.stdout or "").strip() or None
        except (OSError, subprocess.SubprocessError):
            info["version"] = None
    return info


# ----------------------------------------------------------------------- building

def build_manifest(collected: list[Collected], node: Path, py_dir: Path | None,
                   original: Collected | None, items_meta: list[dict]) -> dict:
    items = []
    total_files = total_bytes = 0
    for entry in collected:
        files = entry.files
        record = {
            "name": entry.item.arc,
            "files": len(files),
            "bytes": entry.bytes,
            "sha256_tree": tree_digest(files) if files else None,
            "sample": sample_files(files),
            "required": entry.item.required,
        }
        if entry.item.note:
            record["note"] = entry.item.note
        if entry.missing:
            record["missing"] = True
        items.append(record)
        total_files += len(files)
        total_bytes += entry.bytes

    missing_optional = [m["name"] for m in items_meta if m.get("missing")]
    manifest = {
        "schema": 1,
        "product": PRODUCT,
        "version": VERSION,
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "generator": "tools/build_payload.py",
        "payload": {
            "files": total_files,
            "bytes": total_bytes,
            "sha256_tree": hashlib.sha256(
                "\n".join(f"{i['name']}\t{i['files']}\t{i['bytes']}\t{i['sha256_tree']}"
                          for i in items).encode("utf-8")).hexdigest(),
        },
        "node": node_info(node),
        "python": python_info(py_dir),
        "original": None if original is None else {
            "included": not original.missing,
            "files": len(original.files),
            "bytes": original.bytes,
            "note": "installed NovAtel Application Suite; redistribution is not permitted "
                    "without a license from NovAtel",
        },
        "items": items,
        "missing_optional": missing_optional,
        "notes": [
            "sha256_tree digests member names and sizes, not content; see sample[] for "
            "real content hashes",
            "paths are relative to the extracted payload root",
        ],
    }
    return manifest


def write_payload_dir(payload_dir: Path, files: list[tuple[str, Path, int]], manifest: dict) -> None:
    payload_dir.mkdir(parents=True, exist_ok=True)
    for arc, src, _size in files:
        dest = payload_dir / Path(arc.replace("/", os.sep))
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    (payload_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_zip(out: Path, files: list[tuple[str, Path, int]], manifest: dict) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    if tmp.exists():
        tmp.unlink()
    blob = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    total = len(files)
    done = 0
    written = 0
    started = time.time()
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6,
                             allowZip64=True) as archive:
            def member(name: str) -> zipfile.ZipInfo:
                info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                return info

            for arc, src, size in sorted(files, key=lambda f: f[0]):
                with src.open("rb") as source, archive.open(member(arc), "w") as target:
                    shutil.copyfileobj(source, target, CHUNK)
                done += 1
                written += size
                if done % 256 == 0 or done == total:
                    print(f"  packed {done}/{total} files ({human(written)})", flush=True)
            with archive.open(member("manifest.json"), "w") as target:
                target.write(blob)
        out.unlink(missing_ok=True)
        os.replace(tmp, out)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    elapsed = time.time() - started
    zip_bytes = out.stat().st_size
    ratio = (zip_bytes / written * 100) if written else 0.0
    print(f"wrote {out}")
    print(f"  {total} files, source {human(written)}, zip {human(zip_bytes)} "
          f"({ratio:.0f}%), {elapsed:.1f}s")


def report(collected: list[Collected], node: Path, py_dir: Path | None,
           original: Collected | None) -> int:
    print(f"{PRODUCT} payload inputs")
    print(f"  root  : {Path(__file__).resolve().parent.parent}")
    print(f"  node  : {node}")
    if py_dir is not None:
        print(f"  python: {py_dir}")
    if original is not None:
        print(f"  suite : {original.item.rel}")
    print()
    print(f"  {'item':<44} {'files':>6} {'bytes':>10}  status")
    problems = 0
    total_files = total_bytes = 0
    for entry in collected:
        name = entry.item.arc
        status = "MISSING (optional)" if entry.missing and not entry.item.required else "MISSING"
        if entry.missing:
            if entry.item.required:
                problems += 1
            print(f"  {name:<44} {'-':>6} {'-':>10}  {status}")
            continue
        print(f"  {name:<44} {entry.count:>6} {human(entry.bytes):>10}  ok")
        total_files += entry.count
        total_bytes += entry.bytes
    print()
    print(f"  total: {total_files} files, {human(total_bytes)}")
    if py_dir is not None and not (py_dir / "python.exe").is_file():
        print(f"  WARNING: no python.exe under {py_dir}")
    if original is not None and original.missing:
        print(f"  WARNING: suite directory not found: {original.item.rel}")
    if problems:
        print(f"FAIL: {problems} required input(s) missing")
        return 1
    print("OK: all required inputs present")
    return 0


# --------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the All powered-FSA payload (payload.zip) for the WinForms shell.")
    parser.add_argument("--root", help="repository root (default: parent of tools/)")
    parser.add_argument("--out", help=f"output zip (default: {DEFAULT_OUT.as_posix()})")
    parser.add_argument("--payload-dir",
                        help="also leave an unpacked copy of the payload tree here")
    parser.add_argument("--node-exe", help="node.exe to bundle (default: PATH node, then "
                                           r"C:\Program Files\nodejs\node.exe)")
    parser.add_argument("--python-dir",
                        help="Python 3.11 embeddable directory copied to runtime/python")
    parser.add_argument("--with-original", action="store_true",
                        help="also copy the installed NovAtel Application Suite to original/")
    parser.add_argument("--suite-dir", help=f"suite source (default: {DEFAULT_SUITE})")
    parser.add_argument("--check", action="store_true",
                        help="only validate inputs and print the file list; write nothing")
    parser.add_argument("--strict", action="store_true",
                        help="fail when optional inputs (agent server etc.) are missing")
    parser.add_argument("--quiet", action="store_true", help="less progress output")
    parser.add_argument("--print-default-out", action="store_true",
                        help="print the default output zip path and exit")
    args = parser.parse_args(argv)

    root = repo_root(args.root)
    if args.print_default_out:
        print(default_out(root))
        return 0

    out = Path(args.out).expanduser() if args.out else default_out(root)
    out = out if out.is_absolute() else (Path.cwd() / out)

    node = find_node(args.node_exe)
    py_dir = None
    if args.python_dir:
        py_dir = Path(args.python_dir).expanduser().resolve()
        if not py_dir.is_dir():
            raise SystemExit(f"--python-dir not found: {py_dir}")
        # 必须是 **embeddable**（自足），不能是 **venv**（依赖本机安装的 base Python）。
        #
        # 为什么加这道门禁（2026-11-17 实测）：以前 `--python-dir` 指向 `.deps/venv`，
        # 打出来的包里 pyvenv.cfg 的 home 指向**本机**的 uv 安装目录
        # （形如 <用户目录>\\AppData\\Roaming\\uv\\python\\...），而且没有
        # python311.dll / 标准库 zip —— 解释器和标准库都在包外。
        # 那个包换一台机器必然 `No module named 'encodings'`，但体积却有 1489 MB
        # （全是 site-packages）。人眼看不出来，所以让脚本拒绝。
        problems = validate_python_dir(py_dir)
        if problems:
            raise SystemExit(
                "--python-dir 不是可移植的 embeddable 运行时：\n  - "
                + "\n  - ".join(problems)
                + "\n  下载 python-3.x.y-embed-amd64.zip 解压后传它的目录；"
                  "\n  不要传 venv（venv 把解释器留在本机，包里只有 site-packages）。")
    original = None
    if args.with_original:
        suite = Path(args.suite_dir).expanduser() if args.suite_dir else DEFAULT_SUITE
        if not suite.is_dir():
            raise SystemExit(f"suite directory not found: {suite} "
                             "(pass --suite-dir, or drop --with-original)")
        original = collect_abs(suite.resolve(), Item("original", str(suite.resolve()),
                                                     required=False))

    collected: list[Collected] = []
    node_entry = Collected(item=Item("runtime/node.exe", required=True, kind="file"))
    node_size = node.stat().st_size
    node_entry.files.append(("runtime/node.exe", node, node_size))
    node_entry.bytes = node_size
    collected.append(node_entry)

    if py_dir is not None:
        collected.append(collect_item(root, Item("runtime/python", str(py_dir),
                                                 required=False)))
    for item in ITEMS:
        collected.append(collect_item(root, item))
    if original is not None:
        collected.append(original)

    if args.check:
        rc = report(collected, node, py_dir, original)
        missing_optional = [c.item.arc for c in collected
                            if c.missing and not c.item.required]
        if args.strict and missing_optional:
            print("FAIL (--strict): missing optional inputs: " + ", ".join(missing_optional))
            return 1
        return rc

    missing_required = [c.item.arc for c in collected if c.missing and c.item.required]
    if missing_required:
        print("FAIL: required inputs missing: " + ", ".join(missing_required), file=sys.stderr)
        print("     run with --check to see the full list", file=sys.stderr)
        return 1
    missing_optional = [c.item.arc for c in collected if c.missing and not c.item.required]
    if missing_optional:
        print("WARNING: shipping without: " + ", ".join(missing_optional), file=sys.stderr)
        if args.strict:
            print("FAIL (--strict)", file=sys.stderr)
            return 1

    files: list[tuple[str, Path, int]] = []
    for entry in collected:
        files.extend(entry.files)
    seen: set[str] = set()
    for arc, _src, _size in files:
        if arc in seen:
            print(f"FAIL: duplicate payload member: {arc}", file=sys.stderr)
            return 1
        seen.add(arc)

    manifest = build_manifest(collected, node, py_dir, original,
                             [{"name": c.item.arc, "missing": c.missing} for c in collected])
    if not args.quiet:
        print(f"{PRODUCT} payload: {len(files)} files, {human(sum(f[2] for f in files))}")
    if args.payload_dir:
        target = Path(args.payload_dir).expanduser()
        write_payload_dir(target, files, manifest)
        print(f"unpacked copy: {target}")
    write_zip(out, files, manifest)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    raise SystemExit(main())
