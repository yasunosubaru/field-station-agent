#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回放式评测器：合成 fixture -> 智能体单轮 -> 归因结论 + trace -> SHA256 对拍。

用法::

    python harness/replay.py --fixture harness/fixtures/replay_20261013.json
    python harness/replay.py --fixture <path> --log-dir <dir>  # 日志落别处（测试用）
    python harness/replay.py --fixture <path> --bless          # 重建期望

退出码（tests/test_replay.py 两条路径钉死）：

- ``0``  归因输出与 fixture 期望一致（或 ``--bless`` 成功）
- ``1``  不一致：``expected_sha256`` 或 ``config_hash`` 任一漂移
- ``2``  用法 / IO 错误（缺 ``--fixture``、fixture 不存在且未 ``--bless``、
  JSON 坏、缺字段、kind 不对）

链路（每一步只由种子与代码决定，不碰真实数据、不调真实模型）::

    synthetic.default_cfg(seed=fixture.seed)
      -> synthetic.generate(...)                    # 合成观测 + 生效配置
      -> derive_user_input(...)                     # 提问从观测派生（数据驱动）
      -> runtime.run(agent, user_input, trace)      # FakeProvider 单轮
      -> sha256({"conclusion": .., "trace": [..]})  # 归因结论 + 整个 trace
      -> 与 fixture.expected_sha256 对拍，写 logs/replay_<seed>.json

**哈希为什么可以直接对整个 trace 算（不存在"去时间戳"这一步）**：
trace 设计上就不含时间戳与随机量（`agents/trace/writer.py` 顶部），测试上被钉死
（`tests/test_runtime.py::TestRun::test_two_identical_runs_produce_identical_trace`
要求同输入两次运行 trace 逐字节相同）。本机实测（2026-10-13，两次**独立进程**
跑同一 fixture）::

    run1 sha256: 775435d08a5da1cc1539326fbef750c3f635f1098951d98d484356a124bbd14a
    run2 sha256: 775435d08a5da1cc1539326fbef750c3f635f1098951d98d484356a124bbd14a

两次完全一致，故对 trace 原文整体哈希即可。更早的设想「先去掉 trace 里的
时间戳再哈希」建立在一个后来被证伪的假设上 —— trace 根本没有时间戳可去。

**M0 不接真实模型**：provider 固定 ``FakeProvider``，响应是本文件的
``RESPONSES`` 常量。M3 换真实模型时只需换 provider，对拍结构不变，但结论
必然不同 —— 那时基线要 ``--bless`` 有意重建，这是设计内的事，不是漂移。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation import synthetic                                # noqa: E402
from fieldstation.agents import runtime                           # noqa: E402
from fieldstation.agents.providers.fake import FakeProvider       # noqa: E402
from fieldstation.agents.trace.reader import read_trace           # noqa: E402
from fieldstation.agents.trace.writer import TraceWriter          # noqa: E402
from fieldstation.store import product                            # noqa: E402

#: fixture 的结构指纹。读到 kind 不对的 JSON 一律拒绝（防止 --bless 盖掉别的文件）。
FIXTURE_KIND = "fieldstation.replay.fixture"
FIXTURE_VERSION = 1

#: FakeProvider 的预置响应（M0 不接真实模型）——这就是"归因结论"的正文。
#: 改它等于改基线：对拍必然失败，须用 ``--bless`` 有意重建。
RESPONSES = [
    "归因：该历元载波相位出现单历元扰动，与配置注入的 jump_cycles 一致；"
    "码伪距未同步跳变，排除接收机钟跳；判为相位异常，不计作周跳阶跃。",
]

_SYSTEM_PROMPT = "你是野外台站观测数据的质控与归因助手，只依据给出的量下结论。"

#: 日志记录的结构标识。
LOG_KIND = "fieldstation.replay.log"


def derive_user_input(merged: dict, obs: list, truth: list) -> str:
    """从合成观测派生给智能体的提问（数据驱动，不是模板常量）。

    提问带观测条数、历元数、注入异常数与注入点的二阶差分 —— 合成数据一变，
    提问就变，trace 里的 ``input_digest`` 跟着变，对拍哈希随之变。
    这是**设计决定**（非实测断言）：这些数都由 cfg 与生成代码唯一确定，
    同种子同代码必然逐字相同。
    """
    slips = merged.get("slips") or []
    parts = [f"台站 {merged['station']}：{len(obs)} 条观测 / {len(truth)} 个历元，"
             f"注入异常 {len(slips)} 处"]
    if slips:
        s0 = slips[0]
        series = [o.adr_cycles for o in obs
                  if o.system == s0["system"] and o.sv == s0["sv"]
                  and o.signal == s0["signal"]]
        i = int(s0["index"])
        if 1 <= i < len(series) - 1:
            d2 = series[i + 1] - 2.0 * series[i] + series[i - 1]
            parts.append(f"{s0['system']} {s0['sv']} {s0['signal']} 历元 {i} "
                         f"二阶差分 {d2:.4f} cycle")
        else:
            parts.append(f"{s0['system']} {s0['sv']} {s0['signal']} 序列长度 "
                         f"{len(series)}（注入点 {i} 不在可差分区间）")
    return "；".join(parts) + "。请给出归因结论。"


def _sha256_canonical(obj) -> str:
    return hashlib.sha256(product.canonical_json(obj).encode("utf-8")).hexdigest()


def run_once(seed: int) -> dict:
    """跑一遍完整链路，返回日志记录（含 ``actual_sha256``）。"""
    cfg = synthetic.default_cfg(seed=int(seed))
    obs, truth, merged = synthetic.generate(cfg)
    user_input = derive_user_input(merged, obs, truth)

    agent = runtime.Agent(
        name="attribution",
        system_prompt=_SYSTEM_PROMPT,
        provider=FakeProvider(list(RESPONSES)),
        tools=[],
    )
    with tempfile.TemporaryDirectory() as td:
        trace_path = Path(td) / "replay.jsonl"
        conclusion = runtime.run(agent, user_input, TraceWriter(trace_path))
        events = read_trace(trace_path)

    payload = {"conclusion": conclusion, "trace": events}
    return {
        "kind": LOG_KIND,
        "seed": int(seed),
        "config_hash": product.config_hash(merged),
        "n_obs": len(obs),
        "n_truth": len(truth),
        "user_input": user_input,
        "conclusion": conclusion,
        "conclusion_sha256": _sha256_canonical(conclusion),
        "trace": events,
        "trace_sha256": _sha256_canonical(events),
        "actual_sha256": _sha256_canonical(payload),
    }


def _compare_rows(fixture: dict, record: dict) -> list[tuple[str, str, str, bool]]:
    """返回 [(项, 期望, 实测, 是否一致), ...]。缺字段由调用方先行拦截（退出码 2）。"""
    return [
        ("sha256", str(fixture["expected_sha256"]), record["actual_sha256"],
         str(fixture["expected_sha256"]) == record["actual_sha256"]),
        ("config_hash", str(fixture["config_hash"]), record["config_hash"],
         str(fixture["config_hash"]) == record["config_hash"]),
    ]


def _write_json(path: Path, obj: dict) -> None:
    """落盘 JSON，强制 LF（与 trace 同一约定，跨平台逐字节可比）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False, sort_keys=True)
        fh.write("\n")


def _write_fixture(path: Path, seed: int, record: dict) -> None:
    fx = {
        "kind": FIXTURE_KIND,
        "version": FIXTURE_VERSION,
        "seed": int(seed),
        "config_hash": record["config_hash"],
        "expected_sha256": record["actual_sha256"],
        # 供人读的诊断快照：漂移时 diff 这些字段就知道变在哪一段
        "blessed": {
            "n_obs": record["n_obs"],
            "n_truth": record["n_truth"],
            "user_input": record["user_input"],
            "conclusion_sha256": record["conclusion_sha256"],
            "trace_sha256": record["trace_sha256"],
        },
    }
    _write_json(path, fx)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="回放式评测：归因结论与 trace 的 SHA256 对拍 fixture 期望。")
    ap.add_argument("--fixture", required=True, help="fixture JSON 路径")
    ap.add_argument("--log-dir", default=str(ROOT / "logs"),
                    help="日志目录（默认仓库 logs/；日志名 replay_<seed>.json）")
    ap.add_argument("--bless", action="store_true",
                    help="按当前代码重建 fixture 的期望值（有意变更基线的唯一入口）")
    args = ap.parse_args(argv)

    fx_path = Path(args.fixture)
    if not fx_path.is_absolute():
        fx_path = (Path.cwd() / fx_path).resolve()

    fixture: dict | None = None
    if fx_path.exists():
        try:
            fixture = json.loads(fx_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[阻断] 读不了 fixture {fx_path}: {exc}")
            return 2
        if not isinstance(fixture, dict) or fixture.get("kind") != FIXTURE_KIND:
            print(f"[阻断] {fx_path} 不是本脚本的 fixture"
                  f"（kind != {FIXTURE_KIND}），拒绝处理")
            return 2
    elif not args.bless:
        print(f"[阻断] 找不到 fixture {fx_path}（要新建基线请加 --bless）")
        return 2

    if args.bless:
        seed = int(fixture["seed"]) if fixture and "seed" in fixture \
            else int(synthetic.FIXTURE_SEED)
    else:
        assert fixture is not None
        for key in ("seed", "expected_sha256", "config_hash"):
            if key not in fixture:
                print(f"[阻断] fixture 缺字段 {key}: {fx_path}")
                return 2
        seed = int(fixture["seed"])

    record = run_once(seed)

    print(f"  seed        {seed}")
    print(f"  config_hash {record['config_hash']}")
    print(f"  观测        {record['n_obs']} 条 / {record['n_truth']} 个历元")
    print(f"  user_input  {record['user_input']}")
    print(f"sha256: {record['actual_sha256']}")

    rows: list[tuple[str, str, str, bool]] = []
    if not args.bless:
        rows = _compare_rows(fixture, record)
        record["expected_sha256"] = fixture["expected_sha256"]
        record["match"] = all(good for _, _, _, good in rows)
    else:
        record["expected_sha256"] = record["actual_sha256"]
        record["match"] = True

    log_dir = Path(args.log_dir)
    if not log_dir.is_absolute():
        log_dir = (Path.cwd() / log_dir).resolve()
    log_path = log_dir / f"replay_{seed}.json"
    _write_json(log_path, record)
    print(f"  日志        {log_path}")

    if args.bless:
        _write_fixture(fx_path, seed, record)
        print(f"[BLESS] 已按当前代码把期望写入 {fx_path}")
        return 0

    for name, expected, got, good in rows:
        print(f"  {name:<12} 期望 {expected} 实测 {got}  -> {'PASS' if good else 'FAIL'}")
    if all(good for _, _, _, good in rows):
        print("PASS 归因输出与 fixture 期望一致")
        return 0
    print("FAIL 归因输出与 fixture 期望不一致")
    return 1


if __name__ == "__main__":
    sys.exit(main())
