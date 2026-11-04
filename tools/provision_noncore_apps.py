# -*- coding: utf-8 -*-
"""把可选应用（非核心应用）预置进套件，不走 GUI 安装。

套件的非核心应用不是"系统安装"，而是解压到用户目录并登记一行：

    %APPDATA%\\NovAtelApplicationSuite\\noncoreapps\\
    ├─ NonCoreAppsData\\nonCoreAppData.json   ← 登记表（每个 app 一个键）
    ├─ NonCoreAppsData.zip                    ← 登记表原样副本
    └─ perceptionViewer\\                      ← 应用本身
       ├─ perceptionViewer.zip                ← 原始包（保留，便于修复）
       └─ perceptionViewer\\                   ← 实际运行目录（package.json 在这里）

所以"自带 Perception Viewer"= 复制目录 + 合并登记表，确定性操作，可校验可回滚。

用法：
    python tools/provision_noncore_apps.py --check
    python tools/provision_noncore_apps.py --apply --source <应用目录> --catalog <登记片段.json>
    python tools/provision_noncore_apps.py --apply --source ... --target <临时目录>   # 演练

`--check` 只读；`--apply` 会先备份登记表再写，并把 zip 按目录重建。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

DEFAULT_TARGET = Path(os.environ.get("APPDATA", "")) / "NovAtelApplicationSuite" / "noncoreapps"
CATALOG_DIR = "NonCoreAppsData"
CATALOG_JSON = "nonCoreAppData.json"
CATALOG_ZIP = "NonCoreAppsData.zip"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_catalog(root: Path) -> dict:
    p = root / CATALOG_DIR / CATALOG_JSON
    if not p.exists():
        return {}
    with open(p, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def merge_catalog(existing: dict, incoming: dict) -> tuple[dict, list[str], list[str]]:
    """合并登记表：不删旧条目，只增/改；返回 (合并结果, 新增键, 变更键)。"""
    merged = json.loads(json.dumps(existing))  # 深拷贝
    added, changed = [], []
    for key, value in incoming.items():
        if key not in merged:
            merged[key] = value
            added.append(key)
        elif merged[key] != value:
            merged[key] = value
            changed.append(key)
    return merged, added, changed


def compare_tree(src: Path, dst: Path, limit: int = 20000) -> dict:
    """比较两个目录：缺哪些、哪些大小/内容不同。用于 --check 与幂等判断。"""
    missing, different, checked = [], [], 0
    for path in src.rglob("*"):
        if not path.is_file():
            continue
        checked += 1
        if checked > limit:
            break
        rel = path.relative_to(src).as_posix()
        other = dst / rel
        if not other.exists():
            missing.append(str(rel))
        elif other.stat().st_size != path.stat().st_size:
            different.append(str(rel))
        elif sha256(path) != sha256(other):
            different.append(str(rel))
    return {"checked": checked, "missing": missing, "different": different}


def find_app_root(app_dir: Path) -> Path | None:
    """应用的实际运行目录：package.json 可能在根，也可能在下一层。"""
    if (app_dir / "package.json").exists():
        return app_dir
    for child in app_dir.iterdir():
        if child.is_dir() and (child / "package.json").exists():
            return child
    return None


def plan(source: Path, catalog_patch: dict, target: Path) -> dict:
    """只读地算一遍：要复制什么、登记表要加什么。"""
    src_root = find_app_root(source)
    if src_root is None:
        raise SystemExit("源目录里找不到 package.json：%s" % source)
    app_name = source.name
    dst_dir = target / app_name
    tree = compare_tree(source, dst_dir) if dst_dir.exists() else {"checked": 0, "missing": ["<全部>"], "different": []}
    existing = read_catalog(target)
    merged, added, changed = merge_catalog(existing, catalog_patch)
    return {
        "app": app_name,
        "run_root": str(src_root),
        "target_dir": str(dst_dir),
        "installed": dst_dir.exists(),
        "files": tree,
        "catalog_added": added,
        "catalog_changed": changed,
        "catalog_total": len(merged),
    }


def rebuild_catalog_zip(root: Path) -> Path | None:
    src = root / CATALOG_DIR
    if not src.exists():
        return None
    out = root / CATALOG_ZIP
    tmp = out.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(src.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(root).as_posix())
    tmp.replace(out)
    return out


def apply(source: Path, catalog_patch: dict, target: Path) -> dict:
    target.mkdir(parents=True, exist_ok=True)
    app_name = source.name
    dst_dir = target / app_name

    # 1) 备份登记表（可回滚）
    cat_path = target / CATALOG_DIR / CATALOG_JSON
    backup = None
    if cat_path.exists():
        backup = cat_path.with_suffix(".json.bak")
        shutil.copy2(cat_path, backup)

    # 2) 复制应用（已存在则覆盖同名文件，不删多余文件）
    if dst_dir.exists():
        for path in source.rglob("*"):
            if path.is_file():
                rel = path.relative_to(source)
                dest = dst_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, dest)
    else:
        shutil.copytree(source, dst_dir)

    # 3) 合并登记表并重建 zip
    merged, added, changed = merge_catalog(read_catalog(target), catalog_patch)
    cat_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cat_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(merged, f, ensure_ascii=False, indent=1)
    zip_path = rebuild_catalog_zip(target)

    return {
        "app": app_name,
        "copied_to": str(dst_dir),
        "catalog_added": added,
        "catalog_changed": changed,
        "catalog_backup": str(backup) if backup else None,
        "catalog_zip": str(zip_path) if zip_path else None,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="预置套件的可选应用（不走 GUI）")
    ap.add_argument("--check", action="store_true", help="只读检查，不写任何文件")
    ap.add_argument("--apply", action="store_true", help="执行复制与登记")
    ap.add_argument("--source", help="应用目录（含 package.json，或下一层含）")
    ap.add_argument("--catalog", help="登记片段 JSON（appId -> 卡片对象）")
    ap.add_argument("--target", default=str(DEFAULT_TARGET), help="noncoreapps 目录")
    ap.add_argument("--json", action="store_true", help="机读输出")
    args = ap.parse_args(argv)

    target = Path(args.target)
    if args.check:
        if args.source:
            patch = {}
            if args.catalog:
                patch = json.loads(Path(args.catalog).read_text(encoding="utf-8-sig"))
            result = plan(Path(args.source), patch, target)
        else:
            existing = read_catalog(target)
            result = {
                "target": str(target),
                "catalog_total": len(existing),
                "apps": sorted(k for k in existing),
                "installed_dirs": sorted(p.name for p in target.iterdir()
                                         if p.is_dir() and p.name != CATALOG_DIR) if target.exists() else [],
            }
        print(json.dumps(result, ensure_ascii=False, indent=1) if args.json else result)
        return 0

    if not (args.apply and args.source and args.catalog):
        ap.print_help()
        return 2

    patch = json.loads(Path(args.catalog).read_text(encoding="utf-8-sig"))
    result = apply(Path(args.source), patch, target)
    print(json.dumps(result, ensure_ascii=False, indent=1) if args.json else result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
