#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""试运行台账（M6-1 的骨架，issue #97）。

台账记的是「跑起来之后每个数据源好不好使、失败是什么原因」—— 试运行报告靠它，
不靠回忆。

## 一行记录（JSONL，一行 = 一个源的一次尝试）

| 字段 | 含义 |
|---|---|
| `ts` | ISO 8601（UTC） |
| `run_id` | 本轮运行的标识 |
| `source_id` | 数据源 id（清单里的 id，或 ``probe:<名字>``） |
| `url` | 实际请求的地址 |
| `status` | ``ok`` / ``failed`` |
| `failure_class` | 失败分类（见下）；``status=ok`` 时为 null |
| `bytes` | 取到的字节数（失败为 null） |
| `sha256` | 取到内容的**规范化摘要**（JSON 去逐次变化字段后的规范形式；见 `tools/fetch_public_data.py`） |
| `n_records` | 记录条数（失败或无法判定为 null） |
| `duration_ms` | 本次尝试耗时 |
| `notes` | 人看的备注 |

## 失败分类（固定六类，不许自由发挥）

| 分类 | 判据 |
|---|---|
| `连接失败` | DNS / 连接层就失败（URLError、ConnectionError、SSL 错误） |
| `超时` | 读或连超时（socket timeout） |
| `校验不符` | 拿到了内容但 sha256 与登记的不符 —— **数据源变了** |
| `格式不支持` | 内容拿到了，但不是登记的格式（JSON 解析失败 / RINEX 判据不通过） |
| `字段缺失` | 格式对，但必需字段没有 |
| `未知` | 以上都不是 —— 要查，不要装懂 |

## 用法

```powershell
# 跑清单里的全部源，逐个记行
python tools/trial_ledger.py --append logs/trial_ledger_20261021.jsonl

# 单独探一个地址（用来填分类表）
python tools/trial_ledger.py --probe-url <url> --probe-id probe:xxx \
    --expect-sha256 <sha> --append logs/trial_ledger_20261021.jsonl

# 汇总
python tools/trial_ledger.py --summarize logs/trial_ledger_20261021.jsonl \
    --summary logs/trial_ledger_summary_20261021.json
```

退出码：``0`` 记录/汇总完成；``2`` 用法错误（清单缺失、参数不合法）。
**台账里有失败行不是错误** —— 失败行正是台账的价值。

本脚本只用标准库（本仓模块除外）。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT / "tools")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
MANIFEST = ROOT / "data" / "public" / "manifest.json"

#: 失败分类（固定六类）
FAILURE_CLASSES = (
    "连接失败", "超时", "校验不符", "格式不支持", "字段缺失", "未知",
)

_SPEC = importlib.util.spec_from_file_location(
    "fetch_public_data", ROOT / "tools" / "fetch_public_data.py")
_FETCH = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_FETCH)


def classify(exc: BaseException) -> str:
    """把异常映射到固定分类。"""
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "超时"
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return "超时"
        return "连接失败"
    if isinstance(exc, (ConnectionError, OSError)):
        return "连接失败"
    return "未知"


def count_records(payload: bytes) -> int | None:
    """JSON 载荷里的记录条数；判不出就返回 None（不猜）。"""
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(data, dict):
        hourly = data.get("hourly")
        if isinstance(hourly, dict):
            times = hourly.get("time")
            if isinstance(times, list):
                return len(times)
        for key in ("rows", "records", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return len(value)
    if isinstance(data, list):
        return len(data)
    return None


def check_payload(payload: bytes, *, require_fields=()) -> str | None:
    """返回失败分类；``None`` 表示通过。"""
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        try:
            info = sniff_bytes(payload)
        except Exception:  # noqa: BLE001 —— 判据不通过就是格式不支持
            return "格式不支持"
        if not info.get("supported"):
            return "格式不支持"
        return None
    if require_fields:
        missing = [field for field in require_fields if field not in data]
        if missing:
            return "字段缺失"
    return None


def sniff_bytes(payload: bytes) -> dict:
    """给字节找一个 RINEX 判据（先写成临时文件再 sniff）。"""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".tmp", delete=False) as handle:
        handle.write(payload)
        path = Path(handle.name)
    try:
        from fieldstation.ingest.reader import sniff
        return sniff(str(path))
    finally:
        path.unlink(missing_ok=True)


def _sanitize(text: str) -> str:
    """台账是要入库的：把本机家目录换成 ``<home>``（否则守卫会抓本机路径）。"""
    if not isinstance(text, str):
        return text
    home = str(Path.home())
    for form in (home, home.replace("\\", "/")):
        if form:
            text = text.replace(form, "<home>")
    return text


def attempt(source_id: str, url: str, *, expect_sha256: str | None = None,
            expect_normalized: bool = False,
            require_fields=(), timeout: int = 120, run_id: str = "local",
            ts: str | None = None, notes: str = "") -> dict:
    """试一次取数，返回一行台账记录。

    ``expect_normalized=True`` 时用**规范化摘要**比对（活取数的 JSON 源：原始字节
    逐次不同）；否则用原始字节 sha（固定文件）。
    """
    stamp = ts or datetime.now(timezone.utc).isoformat(timespec="seconds")
    started = time.perf_counter()
    row = {
        "ts": stamp, "run_id": run_id, "source_id": source_id,
        "url": _sanitize(url),
        "status": "failed", "failure_class": None, "bytes": None,
        "sha256": None, "n_records": None, "duration_ms": 0.0,
        "notes": _sanitize(notes),
    }
    try:
        payload = _FETCH.fetch(url, timeout=timeout)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        row["failure_class"] = classify(exc)
        row["notes"] = _sanitize(
            (notes + " " if notes else "") + f"{type(exc).__name__}: {exc}")
        row["duration_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return row
    row["bytes"] = len(payload)
    digest = (_FETCH.normalized_digest(payload) if expect_normalized
              else hashlib.sha256(payload).hexdigest())
    row["sha256"] = digest
    if expect_sha256 and digest != expect_sha256:
        row["failure_class"] = "校验不符"
        row["notes"] = _sanitize(
            (notes + " " if notes else "") + (
                f"sha256 登记 {expect_sha256[:12]}… 实际 {digest[:12]}…"))
    else:
        failure = check_payload(payload, require_fields=require_fields)
        if failure:
            row["failure_class"] = failure
        else:
            row["status"] = "ok"
            row["n_records"] = count_records(payload)
    row["duration_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return row


def run_manifest(manifest_path: Path, *, run_id: str = "local", timeout: int = 120,
                 ts: str | None = None) -> list[dict]:
    """跑清单里的每个源，逐个记行。"""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = []
    for source in manifest.get("sources", []):
        sample = source.get("committed_sample")
        if sample:
            path = ROOT / sample
            started = time.perf_counter()
            payload = path.read_bytes()
            # 入库样本是固定文件：校验和用**原始字节** sha（它逐次不变）。
            digest = hashlib.sha256(payload).hexdigest()
            failure = ("校验不符" if digest != source.get("sha256")
                       else check_payload(payload))
            rows.append({
                "ts": ts or datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "run_id": run_id, "source_id": source["id"],
                "url": source.get("url", ""),
                "status": "failed" if failure else "ok",
                "failure_class": failure,
                "bytes": len(payload),
                "sha256": digest,
                "n_records": None if failure else count_records(payload),
                "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                "notes": "取自入库样本（未走网络）",
            })
            continue
        rows.append(attempt(source["id"], source["url"],
                            expect_sha256=(source.get("sha256_normalized")
                                           or source.get("sha256")),
                            expect_normalized=bool(source.get("sha256_normalized")),
                            run_id=run_id, timeout=timeout, ts=ts,
                            notes="清单源"))
    return rows


def append_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def read_rows(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarize(rows: list[dict]) -> dict:
    """台账汇总：覆盖、成功率、失败分类分布。"""
    by_status: dict[str, int] = {}
    by_class: dict[str, int] = {}
    for row in rows:
        status = row.get("status", "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        failure = row.get("failure_class")
        if failure:
            by_class[failure] = by_class.get(failure, 0) + 1
    total = len(rows)
    ok = by_status.get("ok", 0)
    return {
        "rows": total,
        "by_status": by_status,
        "by_failure_class": by_class,
        "success_rate": round(ok / total, 3) if total else None,
        "distinct_sources": len({row.get("source_id") for row in rows}),
        "failure_classes": list(FAILURE_CLASSES),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="试运行台账（M6-1 骨架）")
    parser.add_argument("--append", help="把记录追加到这个 JSONL")
    parser.add_argument("--manifest", default=str(MANIFEST))
    parser.add_argument("--run-id", default="local")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--ts", default=None, help="覆盖时间戳（测试/复算用）")
    parser.add_argument("--probe-url", help="只探这个地址")
    parser.add_argument("--probe-id", help="探针的 source_id")
    parser.add_argument("--expect-sha256", help="探针的期望校验和")
    parser.add_argument("--require-field", action="append", default=[],
                        help="探针要求的必需字段（可重复）")
    parser.add_argument("--summarize", help="汇总这个 JSONL")
    parser.add_argument("--summary", help="汇总写到这里")
    args = parser.parse_args(argv)

    try:
        if args.summarize:
            rows = read_rows(Path(args.summarize))
            summary = summarize(rows)
            if args.summary:
                target = Path(args.summary)
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("w", encoding="utf-8", newline="\n") as handle:
                    handle.write(json.dumps(summary, ensure_ascii=False, indent=2,
                                            sort_keys=True) + "\n")
            print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
            return 0
        if args.probe_url:
            if not args.probe_id:
                print("[阻断] 探针必须给 --probe-id")
                return 2
            row = attempt(args.probe_id, args.probe_url,
                          expect_sha256=args.expect_sha256,
                          require_fields=tuple(args.require_field),
                          timeout=args.timeout, run_id=args.run_id, ts=args.ts,
                          notes="探针")
        else:
            manifest_path = Path(args.manifest)
            if not manifest_path.is_file():
                print(f"[阻断] 清单不存在：{manifest_path}")
                return 2
            row = None
            rows = run_manifest(manifest_path, run_id=args.run_id,
                                 timeout=args.timeout, ts=args.ts)
        if args.append:
            append_rows(Path(args.append), rows if row is None else [row])
        for item in (rows if row is None else [row]):
            print(f"{item['status']:>6}  {item['source_id']:<32} "
                  f"{item.get('failure_class') or ''} "
                  f"{item.get('bytes') or 0} B  {item.get('duration_ms')} ms")
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[阻断] {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
