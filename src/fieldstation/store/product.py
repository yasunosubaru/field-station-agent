"""产品落盘：时间序列 CSV、质量报告 JSON、manifest JSON。

约定：每个产品带 code_commit / config_hash / synthetic 指纹；
缺测一律写 NaN，禁止写 0；合成产物写入独立目录且文件名含 SYNTHETIC。

本模块只用标准库。

【搬运改动 · 本项目新增行为】合成产物的路径隔离
------------------------------------------------
上面第三条约定在源项目里**不由本模块实现**：源项目的 `write_timeseries` /
`write_json` 收到 `synthetic=True` 时只往文件头写两行标记，返回的路径与
`synthetic=False` 完全相同；隔离目录是上游 `cli.run_pipeline` 先算好路径再传进来的。
本仓库不搬 cli（不在 spec §1.1 的搬运清单里），照抄过来等于把隔离彻底丢掉。

实测（2026-10-13，只读导入源项目，产物写临时目录，未向源树写入任何东西）：

    p = tmp / "tec_ts" / "runA_tec.csv"
    write_timeseries([], p, synthetic=False) -> tmp/tec_ts/runA_tec.csv
    write_timeseries([], p, synthetic=True)  -> tmp/tec_ts/runA_tec.csv   # 同一个
    paths equal: True
    # 后果不只是「路径相同」，是**原地覆盖**：先写真实产物
    # （sha256 fa6d660a…，首行 station,system,sv,…），再写合成产物，
    # 同一文件变成 sha256 112cbec3…、首行 "# 合成数据…"，真实产物就此消失。
    # write_json 同样返回同一路径。

因此本项目把隔离下沉到本模块：`synthetic=True` 时路径改写为
`<父目录>/synthetic/SYNTHETIC_<原文件名>`，与源项目 cli 的口径一致
（目录名 `synthetic`、文件名前缀 `SYNTHETIC_`）。这是**本项目新增的行为，
源项目没有**。调用方须一律使用 `write_*` 的**返回值**作为后续
`describe_output` 与摘要里的路径 —— `describe_output` 自己拿不到 synthetic 标志。
"""
from __future__ import annotations

import hashlib
import json
import math
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from ..model import TecRecord
from ..synthetic import SYNTHETIC_MARKER, SYNTHETIC_TAG

MISSING = float("nan")

#: 合成产物的隔离目录名与文件名前缀（口径取自源项目 cli.run_pipeline 的对应两行）
SYNTHETIC_DIRNAME = "synthetic"
SYNTHETIC_PREFIX = SYNTHETIC_TAG + "_"


def _isolated(path: Path, synthetic: bool) -> Path:
    """synthetic=True 时把路径改写到隔离目录；幂等，已隔离过的不再叠加。

    幂等要同时管住**目录**和**文件名**两处：只挡前缀的话，
    `synthetic/SYNTHETIC_x.csv` 再隔离一次会变成 `synthetic/synthetic/SYNTHETIC_x.csv`
    （本项目 tests/test_pipeline.py::test_isolation_is_idempotent 实测到过）。

    本项目新增行为，实测依据见模块 docstring。
    """
    if not synthetic:
        return path
    name = path.name
    if not name.startswith(SYNTHETIC_PREFIX):
        name = SYNTHETIC_PREFIX + name
    parent = path.parent
    if parent.name == SYNTHETIC_DIRNAME:
        return parent / name
    return parent / SYNTHETIC_DIRNAME / name


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def config_hash(cfg: dict) -> str:
    return hashlib.sha256(canonical_json(cfg).encode("utf-8")).hexdigest()


def code_commit(cwd: str | Path | None = None) -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(cwd) if cwd else None,
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:  # pragma: no cover - git 不可用
        pass
    return "unknown"


def env_fingerprint() -> dict:
    return {
        "python": sys.version.split()[0],
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
    }


def _fmt(v) -> str:
    if v is None:
        return "NaN"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "inf" if f > 0 else "-inf"
    return repr(f)


def write_timeseries(records: list[TecRecord], path: str | Path, synthetic: bool = False) -> Path:
    path = _isolated(Path(path), synthetic)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        if synthetic:
            fh.write(f"# {SYNTHETIC_MARKER}\n")
            fh.write(f"# {SYNTHETIC_TAG}\n")
        fields = [
            "station", "system", "sv", "signal_pair", "epoch_utc", "gps_week", "gps_tow_s",
            "sTEC_TECU", "vTEC_TECU", "deltaT_TECU", "level_offset_TECU",
            "arc_id", "quality_flag", "elev_deg", "azim_deg",
            "ipp_lat_deg", "ipp_lon_deg", "algorithm",
        ]
        fh.write(",".join(fields) + "\n")
        for rec in records:
            row = rec.to_row()
            fh.write(",".join(_fmt(row[f]) for f in fields) + "\n")
    return path


def write_json(obj, path: str | Path, synthetic: bool = False) -> Path:
    path = _isolated(Path(path), synthetic)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = obj
    if synthetic and isinstance(obj, dict):
        # 保证 JSON 合法，同时让首行内容含标记文本
        payload = {"_synthetic_note": SYNTHETIC_MARKER, **obj}
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False, default=str, allow_nan=True)
        fh.write("\n")
    return path


def write_manifest(
    path: str | Path,
    *,
    run_id: str,
    cfg: dict,
    inputs: list[dict],
    outputs: list[dict],
    synthetic: bool,
    started_at: str,
    finished_at: str,
    extra: dict | None = None,
) -> Path:
    manifest = {
        "run_id": run_id,
        "config_hash": config_hash(cfg),
        "code_commit": code_commit(),
        "inputs": inputs,
        "outputs": outputs,
        "env": env_fingerprint(),
        "started_at": started_at,
        "finished_at": finished_at,
        "synthetic": bool(synthetic),
    }
    if extra:
        manifest.update(extra)
    return write_json(manifest, path, synthetic=synthetic)


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def describe_output(path: str | Path, rows: int | None = None) -> dict:
    p = Path(path)
    d = {"path": str(p), "sha256": sha256_file(p) if p.exists() else None}
    if rows is not None:
        d["rows"] = rows
    return d
