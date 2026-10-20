#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按清单取公开数据：下载 → 校验 sha256 → 落本地缓存。

清单在 ``data/public/manifest.json``（来源、许可、校验和、用途都在里面登记）。
**原始数据不进仓库**（体积与许可），只进本地缓存；仓库里留小样本与摘要。

用法：

    python tools/fetch_public_data.py                        # 取清单里需要下载的全部
    python tools/fetch_public_data.py --id openmeteo_badg_202401
    python tools/fetch_public_data.py --cache-dir <目录>

退出码：``0`` 全部取到且校验通过；``1`` 有源的内容与登记的 sha256 不符（数据源变了
或被截断）；``2`` 用法错误 / 网络失败 / 清单缺失。

本脚本只用标准库。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "public" / "manifest.json"
DEFAULT_CACHE = ROOT / "data" / "public" / "cache"
TIMEOUT_S = 120


def load_manifest(path: Path = MANIFEST) -> dict:
    """读清单；不存在或结构不对抛 ``ValueError``。"""
    if not path.is_file():
        raise ValueError(f"清单不存在：{path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("sources"), list) or not data["sources"]:
        raise ValueError(f"清单里没有 sources：{path}")
    for source in data["sources"]:
        for key in ("id", "url", "license", "sha256", "retrieved", "used_for"):
            if not source.get(key):
                raise ValueError(f"清单条目缺字段 {key!r}：{source.get('id')!r}")
    return data


def fetch(url: str, timeout: int = TIMEOUT_S) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "fieldstation-agent/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="按清单取公开数据并校验 sha256")
    parser.add_argument("--manifest", default=str(MANIFEST))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--id", action="append", default=None,
                        help="只取这些源（可重复）；缺省取全部需要下载的")
    parser.add_argument("--timeout", type=int, default=TIMEOUT_S)
    args = parser.parse_args(argv)

    try:
        manifest = load_manifest(Path(args.manifest))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[阻断] {exc}")
        return 2

    wanted = set(args.id or [])
    cache_dir = Path(args.cache_dir)
    failures: list[str] = []
    checked = 0

    for source in manifest["sources"]:
        sid = source["id"]
        if wanted and sid not in wanted:
            continue
        sample = source.get("committed_sample")
        if sample:
            path = ROOT / sample
            if not path.is_file():
                failures.append(f"{sid}: 入库样本缺失 {sample}")
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != source["sha256"]:
                failures.append(f"{sid}: 入库样本 sha256 不符（登记 {source['sha256'][:12]}…，"
                                f"实际 {digest[:12]}…）")
                continue
            print(f"[OK] {sid}: 入库样本已就位（{sample}，sha256 {digest[:12]}…）")
            checked += 1
            continue
        try:
            payload = fetch(source["url"], timeout=args.timeout)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            print(f"[阻断] {sid}: 取数失败 {source['url']}（{exc}）")
            return 2
        digest = hashlib.sha256(payload).hexdigest()
        if digest != source["sha256"]:
            failures.append(f"{sid}: sha256 不符（登记 {source['sha256'][:12]}…，"
                            f"实际 {digest[:12]}…）—— 数据源可能变了，别默默换基线")
            continue
        target = cache_dir / Path(source["cache"]).name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as handle:
            handle.write(payload)
        print(f"[OK] {sid}: {len(payload)} B，sha256 {digest[:12]}… → "
              f"{target.relative_to(ROOT) if target.is_relative_to(ROOT) else target}")
        checked += 1

    if failures:
        print(f"[阻断] {len(failures)} 个源没通过：")
        for line in failures:
            print(f"  - {line}")
        return 1
    print(f"全部通过：{checked} 个源")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
