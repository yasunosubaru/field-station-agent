#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""letta_smoke.py —— 对**真的** Letta 服务做一次 recall / remember 往返。

## 它回答什么

`docs/spec/2026-11-04-v4-实施计划.md` W0 的第一个 spike 是
「**单进程内能 recall/remember；不行则记降级方案**」。结论已经明确：

* `letta`（服务端）是 78.4 MB 的 wheel，会拉一整套 FastAPI + SQLAlchemy + 向量库，
  并与本项目已钉住的 duckdb / langgraph / pydantic-ai / dbos / llama-index
  争 pydantic 与 httpx 的版本 —— **不作为进程内库嵌入**；
* `letta-client`（418 KB）是它的 HTTP 客户端，依赖只有 anyio / distro / httpx /
  pydantic / sniffio / typing-extensions，全部已在 `.deps/venv` 里 ——
  **走「外部服务 + 轻客户端」**。

本脚本验证后半句：客户端真的能对服务端完成一次写入与召回。
`BotMemory` 的降级语义由 `tests/test_botd_letta.py` 用假客户端钉住（不需要服务）。

## 用法

前提：装了 `letta-client`，且有一个 Letta 服务在跑（默认 `http://127.0.0.1:8283`）。

    python tools/letta_smoke.py                     # 用默认地址
    python tools/letta_smoke.py --url http://127.0.0.1:8283
    python tools/letta_smoke.py --json

环境变量：`FSA_LETTA_URL` / `FSA_LETTA_TOKEN`（与 `botd/letta.py` 同一套）。

退出码：``0`` 往返成功 / ``1`` 服务不可达或往返失败 / ``2`` 缺 `letta-client`。

## 它写什么、不写什么

写一个名字带 `fsa-smoke-<随机>` 的 agent 与一条 passage，**跑完不删**（Letta 没有
"临时 agent"概念，删除是不可逆动作，不该由一个冒烟脚本自己决定）。
名字带随机后缀是为了两次冒烟互不干扰；清理留给人在 Letta 侧做。
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass

    ap = argparse.ArgumentParser(description="对真 Letta 服务做一次 recall/remember 往返")
    ap.add_argument("--url", default="", help="服务地址；缺省用 FSA_LETTA_URL 或 127.0.0.1:8283")
    ap.add_argument("--token", default="", help="API key；缺省用 FSA_LETTA_TOKEN")
    ap.add_argument("--json", action="store_true", help="机读输出")
    args = ap.parse_args(argv)

    try:
        import letta_client  # noqa: F401
    except ImportError:
        print("[阻断] 没装 letta_client。装法：\n"
              "  .deps/venv/Scripts/python.exe -m pip install letta-client "
              "-i https://pypi.tuna.tsinghua.edu.cn/simple")
        return 2

    from fieldstation.botd.letta import LettaClientBackend

    backend = LettaClientBackend(args.url, args.token)
    result: dict = {
        "url": backend.base_url,
        "client_version": getattr(__import__("letta_client"), "__version__", "?"),
        "steps": [],
    }

    def step(name: str, ok: bool, detail: str = "") -> None:
        result["steps"].append({"step": name, "ok": ok, "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  —  {detail}" if detail else ""))

    if not backend.available():
        step("服务可达", False, backend.reason)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=1))
        return 1
    step("服务可达", True, backend.base_url)

    bot_id = f"fsa-smoke-{uuid.uuid4().hex[:8]}"
    content = "冒烟内容：电池电压过低会触发告警，需要检查供电模块。"
    try:
        passage_id = backend.remember(bot_id, content, key="smoke")
        step("写入 archival passage", bool(passage_id), f"id={passage_id} bot={bot_id}")
    except Exception as exc:  # noqa: BLE001 - 冒烟要把失败原因原样带出来
        step("写入 archival passage", False, f"{type(exc).__name__}: {exc}")
        traceback.print_exc()
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=1))
        return 1

    try:
        hits = backend.recall(bot_id, "电池电压过低", limit=5)
        found = any(content in str(h.get("content", "")) for h in hits)
        step("召回刚写的记忆", found,
             f"命中 {len(hits)} 条，其中 1 条是刚写入的" if found else f"命中 {len(hits)} 条但都不是刚写入的那条")
        keys = [h.get("key") for h in hits]
        step("key 从 tags 还原", "smoke" in keys, f"keys={keys}")
    except Exception as exc:  # noqa: BLE001
        step("召回刚写的记忆", False, f"{type(exc).__name__}: {exc}")
        traceback.print_exc()
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=1))
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))

    passed = sum(1 for s in result["steps"] if s["ok"])
    print(f"\n合计 {passed}/{len(result['steps'])} PASS")
    print(f"注意：本次在 Letta 侧建了 agent {bot_id!r} 与 1 条 passage，冒烟脚本不删它"
          "（删除是不可逆动作，留给人决定）。")
    return 0 if passed == len(result["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
