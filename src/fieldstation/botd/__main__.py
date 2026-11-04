"""``python -m fieldstation.botd --db <path> --once``。

只打印 JSON 行（每个 tick 一行），方便在批处理/测试里直接断言。
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Optional, Sequence

from .daemon import BotDaemon
from .queue import TaskQueue
from .store import BotStore


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m fieldstation.botd",
        description="野外台站智能体编队的 botd 主循环（骨架）",
    )
    parser.add_argument("--db", required=True, help="SQLite 数据库路径（不存在会新建并迁移）")
    parser.add_argument("--once", action="store_true", help="只跑一个 tick 后退出")
    parser.add_argument(
        "--max-ticks", type=int, default=None, help="跑够 N 个 tick 后退出（默认无限）"
    )
    parser.add_argument("--interval", type=float, default=1.0, help="tick 间隔秒数")
    parser.add_argument("--worker", default="botd-0", help="worker 标识（写进租约）")
    parser.add_argument("--ttl", type=float, default=60.0, help="租约有效期秒数")
    parser.add_argument(
        "--seed-demo",
        action="store_true",
        help="入队一条 demo 任务，便于观察一次完整 tick",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):  # 非交互流/旧环境
        pass
    args = build_parser().parse_args(argv)
    if args.max_ticks is not None and args.max_ticks < 1:
        print("--max-ticks 必须 ≥ 1", file=sys.stderr)
        return 2
    if args.ttl <= 0:
        print("--ttl 必须为正数", file=sys.stderr)
        return 2

    store = BotStore(args.db)
    queue = TaskQueue(store)
    if args.seed_demo:
        queue.enqueue(
            {
                "kind": "demo",
                "title": "botd 演示任务",
                "payload": {"source": "cli", "argv": list(argv or [])},
            }
        )
    daemon = BotDaemon(
        store, queue=queue, worker=args.worker, ttl=args.ttl
    )
    try:
        results = daemon.run(
            once=args.once, max_ticks=args.max_ticks, interval=args.interval
        )
    except KeyboardInterrupt:
        return 130
    for result in results:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
