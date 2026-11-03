#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""workflow_cli.py —— 工作流目录、运行、闸门与证据的命令行入口。

这是 :class:`fieldstation.workflows.service.WorkflowService` 的薄壳：所有语义都在
service / runner 里，这里只负责解析参数、打印结果、把状态映射成退出码。

## 为什么需要它

Agent 与人都要能用同一套流程。GUI 里点一遍无法审计，脚本里写一遍又各自为政；
命令行是两者之间最小的公共面：``run`` 一条命令，``job.json`` + ``audit.jsonl``
留下完整证据。

## 用法

    python tools/workflow_cli.py capabilities
    python tools/workflow_cli.py list [--intent device]
    python tools/workflow_cli.py describe device.restart
    python tools/workflow_cli.py run device.restart --param target=COM8@115200
    python tools/workflow_cli.py status <job_id>
    python tools/workflow_cli.py gate <job_id> --decision approved --by sunch --note "site visit"
    python tools/workflow_cli.py resume <job_id> --decision done
    python tools/workflow_cli.py cancel <job_id> --reason "wrong receiver"
    python tools/workflow_cli.py artifacts <job_id> [--out DIR]
    python tools/workflow_cli.py validate [PATH]

公共选项（可放在子命令前或后）：

    --root PATH         仓库根（默认脚本上一级）
    --engine URL        引擎地址（默认 FIELD_STATION_ENGINE 或 http://127.0.0.1:7788）
    --jobs-root PATH    job 目录（默认 <root>/workflows/jobs）
    --driver NAME       GUI 驱动（默认 assisted：没有驱动就转人工任务）
    --json              输出原始 JSON，便于 agent 解析

## 退出码

- ``0``：成功（``succeeded``，或 ``validate`` 全部通过）
- ``1``：失败（``failed``，或 ``validate`` 有规格不合法）
- ``2``：用法错误 / 参数不合法 / 找不到 job
- ``3``：停在闸门（``waiting_approval`` / ``waiting_operator``）—— 不是失败，
  按输出里的 ``next_actions`` 继续
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.workflows import gui as gui_mod          # noqa: E402
from fieldstation.workflows import spec as spec_mod        # noqa: E402
from fieldstation.workflows.runner import JobBusy          # noqa: E402
from fieldstation.workflows.service import WorkflowService  # noqa: E402
from fieldstation.workflows.store import TERMINAL_STATUSES  # noqa: E402

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_WAITING = 3


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", default=None, help="仓库根（默认脚本上一级）")
    parser.add_argument("--engine", default=None,
                        help="引擎地址（默认 FIELD_STATION_ENGINE 或 http://127.0.0.1:7788）")
    parser.add_argument("--jobs-root", default=None, help="job 目录（默认 <root>/workflows/jobs）")
    parser.add_argument("--driver", default="assisted",
                        help="GUI 驱动名（默认 assisted；scripted 仅供测试）")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="workflow",
        description="原版 GUI 缺口工作流：目录、运行、闸门、证据",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="退出码：0 成功 / 1 失败 / 2 用法错误 / 3 停在闸门",
    )
    _common(ap)
    sub = ap.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("capabilities", help="引擎、驱动、目录与可用方法")
    _common(p)

    p = sub.add_parser("list", help="列出工作流")
    _common(p)
    p.add_argument("--intent", default=None, help="按 intent / id / tag 过滤")

    p = sub.add_parser("describe", help="一份工作流的完整定义")
    _common(p)
    p.add_argument("workflow", help="工作流 id，例如 device.restart")

    p = sub.add_parser("run", help="新建并运行一个 job")
    _common(p)
    p.add_argument("workflow", help="工作流 id")
    p.add_argument("--param", action="append", default=[], metavar="KEY=VALUE",
                   help="参数，可重复；值按规格里的 type 解析")
    p.add_argument("--params-json", default=None, metavar="JSON",
                   help="一次性给全部参数（与 --param 合并，后者优先）")
    p.add_argument("--idempotency-key", default=None,
                   help="同一个键命中运行中/成功的 job 时直接复用它")
    p.add_argument("--allow-concurrent", action="store_true",
                   help="允许同一条流程已有未结束 job 时再开一个（默认拒绝）")
    p.add_argument("--force-lock", action="store_true", help="强制拿过期的锁")

    p = sub.add_parser("status", help="一个 job 的状态")
    _common(p)
    p.add_argument("job_id")

    p = sub.add_parser("resume", help="人工任务完成后继续（decision=done/failed）")
    _common(p)
    p.add_argument("job_id")
    p.add_argument("--decision", required=True, choices=["done", "failed"])
    p.add_argument("--by", default="operator")
    p.add_argument("--note", default="")

    p = sub.add_parser("gate", help="审批门（decision=approved/rejected）")
    _common(p)
    p.add_argument("job_id")
    p.add_argument("--decision", required=True, choices=["approved", "rejected"])
    p.add_argument("--by", default="operator")
    p.add_argument("--note", default="")

    p = sub.add_parser("cancel", help="取消一个还没结束的 job")
    _common(p)
    p.add_argument("job_id")
    p.add_argument("--reason", default="cancelled")
    p.add_argument("--by", default="operator")

    p = sub.add_parser("artifacts", help="列出（并可复制出）证据文件")
    _common(p)
    p.add_argument("job_id")
    p.add_argument("--out", default=None, help="把这些文件复制到该目录")

    p = sub.add_parser("jobs", help="最近的 job")
    _common(p)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--status", default=None)

    p = sub.add_parser("validate", help="校验工作流规格（不运行）")
    _common(p)
    p.add_argument("path", nargs="?", default=None, help="单个 .yaml 或目录（默认 workflows/）")

    return ap


def _service(args: argparse.Namespace) -> WorkflowService:
    root = Path(args.root).resolve() if args.root else ROOT
    workflows_dir = root / "workflows"
    jobs_root = Path(args.jobs_root).resolve() if args.jobs_root else None
    return WorkflowService(
        root=root,
        workflows_dir=workflows_dir,
        jobs_root=jobs_root,
        engine_url=args.engine,
        driver=args.driver,
    )


def _print(data: object, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True, default=str))
        return
    print(_human(data))


def _human(value: object, indent: int = 0) -> str:
    pad = "  " * indent
    if isinstance(value, dict):
        lines = []
        for key, item in value.items():
            if isinstance(item, (dict, list)) and item:
                lines.append(f"{pad}{key}:")
                lines.append(_human(item, indent + 1))
            else:
                lines.append(f"{pad}{key}: {_scalar(item)}")
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return f"{pad}(空)"
        lines = []
        for item in value:
            if isinstance(item, dict):
                lines.append(f"{pad}-")
                lines.append(_human(item, indent + 1))
            else:
                lines.append(f"{pad}- {_scalar(item)}")
        return "\n".join(lines)
    return pad + _scalar(value)


def _scalar(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def _parse_params(args: argparse.Namespace) -> dict:
    params: dict = {}
    if args.params_json:
        try:
            loaded = json.loads(args.params_json)
        except ValueError as exc:
            raise ValueError(f"--params-json 不是合法 JSON：{exc}") from exc
        if not isinstance(loaded, dict):
            raise ValueError("--params-json 必须是 JSON 对象")
        params.update(loaded)
    for item in args.param or []:
        if "=" not in item:
            raise ValueError(f"--param 需要 KEY=VALUE 形状，收到 {item!r}")
        key, _, raw = item.partition("=")
        key = key.strip()
        if not key:
            raise ValueError(f"--param 的键不能为空：{item!r}")
        params[key] = _coerce_cli_value(raw)
    return params


def _coerce_cli_value(raw: str) -> object:
    """命令行上的值都是字符串；布尔与 null 需要还原，其余交给规格的 type 校验。"""
    text = raw.strip()
    lowered = text.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in ("null", "none", "~"):
        return None
    return raw


def _status_exit(job_view: dict) -> int:
    status = str(job_view.get("status", ""))
    if status == "succeeded":
        return EXIT_OK
    if status in TERMINAL_STATUSES:
        return EXIT_FAILED
    return EXIT_WAITING


def _decision_exit(job_view: dict, decision: str) -> int:
    """闸门/人工任务命令的退出码：决定本身被接受就算成功。

    拒绝（``rejected``）是人的正常选择，job 变成 ``cancelled`` 是预期结果，
    不能当成命令失败——否则脚本无法区分「拒绝成功」和「CLI 出错」。
    """
    status = str(job_view.get("status", ""))
    if status == "succeeded":
        return EXIT_OK
    if status in ("waiting_approval", "waiting_operator"):
        return EXIT_WAITING
    if decision == "rejected":
        return EXIT_OK
    return _status_exit(job_view)


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if not args.command:
        ap.print_help()
        return EXIT_USAGE

    try:
        service = _service(args)
    except gui_mod.GuiUnavailable as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return EXIT_USAGE

    command = args.command

    if command == "capabilities":
        data = service.capabilities()
        _print(data, args.json)
        return EXIT_OK

    if command == "list":
        rows = service.list_workflows(args.intent)
        if args.json:
            _print(rows, True)
            return EXIT_OK
        if not rows:
            print(f"没有匹配 {args.intent!r} 的工作流。")
            return EXIT_OK
        for row in rows:
            flags = []
            if row["approval"].get("required"):
                flags.append("审批门")
            if row["risk"] == "high":
                flags.append("高风险")
            suffix = f" [{'/'.join(flags)}]" if flags else ""
            print(f"{row['id']:<24} {row['risk']:<7} {row['title']}{suffix}")
            if row["summary"]:
                print(f"{'':<24} {row['summary']}")
        print(f"\n共 {len(rows)} 条。")
        return EXIT_OK

    if command == "describe":
        try:
            data = service.describe_workflow(args.workflow)
        except KeyError as exc:
            print(f"[错误] {exc.args[0]}", file=sys.stderr)
            return EXIT_USAGE
        _print(data, args.json)
        return EXIT_OK

    if command == "run":
        try:
            params = _parse_params(args)
        except ValueError as exc:
            print(f"[错误] {exc}", file=sys.stderr)
            return EXIT_USAGE
        try:
            view = service.run_workflow(
                args.workflow, params,
                idempotency_key=args.idempotency_key,
                allow_concurrent=args.allow_concurrent,
                force_lock=args.force_lock,
            )
        except KeyError as exc:
            print(f"[错误] {exc.args[0]}", file=sys.stderr)
            return EXIT_USAGE
        except spec_mod.WorkflowSpecError as exc:
            print(f"[错误] {exc}", file=sys.stderr)
            return EXIT_USAGE
        except JobBusy as exc:
            print(f"[拒绝] {exc}", file=sys.stderr)
            return EXIT_USAGE
        _print(view, args.json)
        return _status_exit(view)

    if command == "status":
        try:
            view = service.job_status(args.job_id)
        except (OSError, ValueError) as exc:
            print(f"[错误] 读不到 job {args.job_id}：{exc}", file=sys.stderr)
            return EXIT_USAGE
        _print(view, args.json)
        return _status_exit(view)

    if command in ("resume", "gate"):
        try:
            if command == "resume":
                view = service.resume(args.job_id, args.decision,
                                      by=args.by, note=args.note)
            else:
                view = service.human_gate(args.job_id, args.decision,
                                          by=args.by, note=args.note)
        except (OSError, ValueError, KeyError) as exc:
            print(f"[错误] {exc}", file=sys.stderr)
            return EXIT_USAGE
        except JobBusy as exc:
            print(f"[拒绝] {exc}", file=sys.stderr)
            return EXIT_USAGE
        _print(view, args.json)
        return _decision_exit(view, args.decision)

    if command == "cancel":
        try:
            view = service.cancel(args.job_id, args.reason, by=args.by)
        except (OSError, ValueError) as exc:
            print(f"[错误] {exc}", file=sys.stderr)
            return EXIT_USAGE
        _print(view, args.json)
        return EXIT_OK

    if command == "artifacts":
        try:
            rows = service.artifacts(args.job_id)
        except (OSError, ValueError) as exc:
            print(f"[错误] 读不到 job {args.job_id}：{exc}", file=sys.stderr)
            return EXIT_USAGE
        if args.out:
            target = Path(args.out)
            target.mkdir(parents=True, exist_ok=True)
            for row in rows:
                source = Path(str(row.get("path", "")))
                if source.is_file():
                    shutil.copy2(source, target / source.name)
        _print(rows, args.json)
        return EXIT_OK

    if command == "jobs":
        rows = service.list_jobs(limit=args.limit, status=args.status)
        if args.json:
            _print(rows, True)
            return EXIT_OK
        if not rows:
            print("还没有 job。")
            return EXIT_OK
        for row in rows:
            print(f"{row['job_id']:<48} {row['status']:<18} {row['workflow']}")
        return EXIT_OK

    if command == "validate":
        rows = service.validate(args.path)
        if args.json:
            _print(rows, True)
        else:
            for row in rows:
                if row.get("ok"):
                    print(f"[OK]   {row['path']}  ({row['id']}, {row['steps']} 步)")
                else:
                    print(f"[错误] {row['path']}")
                    for line in row.get("errors", []):
                        print(f"       - {line}")
        return EXIT_OK if all(row.get("ok") for row in rows) else EXIT_FAILED

    ap.print_help()
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
