"""对真实 Ollama 服务做连通与可复现性实测（M3-0，issue #50）。

这不是 unittest，不进测试门禁（门禁 skip==0，不能为「没装 Ollama 的机器」留
skip）。它的产出是 ``logs/`` 下的实测记录，供 ``docs/decisions/`` 的复现性
口径 ADR 引用 —— 「设了 temperature=0 就可复现」这种话没有实测记录不准说。

用法（本机 Ollama 在跑、``config/providers.json`` 指向真实模型）::

    python tools/probe_provider_live.py             # smoke + 5 次可复现性
    python tools/probe_provider_live.py --runs 3    # 缩短

退出码：0 = smoke 返回了工具调用且 N 次逐字一致；
       1 = smoke 通过但 N 次不一致，或 smoke 没拿到工具调用（两种都写进记录）；
       2 = 服务不可达 / 配置错（先修环境再谈复现性）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fieldstation.agents.providers import (  # noqa: E402
    ChatMessage,
    ProviderError,
    get_provider,
)

SMOKE_TOOLS = [{
    "type": "function",
    "function": {
        "name": "query_station",
        "description": "查询一个台站在指定时间段的观测情况",
        "parameters": {
            "type": "object",
            "properties": {
                "station": {"type": "string", "description": "台站代码，4 字符"},
                "days": {"type": "integer", "description": "最近几天"},
            },
            "required": ["station"],
        },
    },
}]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default="config/providers.json")
    ap.add_argument("--provider", default="ollama")
    ap.add_argument("--runs", type=int, default=5)
    args = ap.parse_args(argv)

    cfg = json.loads((ROOT / args.config).read_text(encoding="utf-8"))
    conf = cfg["providers"][args.provider]
    base_url = (conf.get("url") or "http://127.0.0.1:11434").rstrip("/")

    # 证据链第一环：连的是哪个版本的服务
    try:
        with urllib.request.urlopen(base_url + "/api/version", timeout=5) as r:
            version = json.loads(r.read().decode("utf-8")).get("version", "?")
    except OSError as exc:
        print(f"[阻断] Ollama 服务不可达（{base_url}）：{exc}")
        return 2

    provider = get_provider(args.provider, conf)
    report = {
        "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provider": args.provider,
        "config_model": conf.get("model"),
        "options": conf.get("options"),
        "ollama_version": version,
        "runs": args.runs,
    }

    # ---- 第 1 步：smoke —— 工具调用能不能回来（#50 第 1 条） -----------------
    try:
        smoke = provider.chat([
            ChatMessage("system", "你是台站质控助手。回答用户前必须先调用工具查询，"
                                  "不允许凭空回答。"),
            ChatMessage("user", "查一下 BADG 站最近 3 天的观测情况。"),
        ], SMOKE_TOOLS)
    except ProviderError as exc:
        print(f"[阻断] provider 错误：{exc}")
        return 2
    report["smoke"] = {"content": smoke.content,
                       "tool_calls": smoke.tool_calls, "usage": smoke.usage}
    print(f"smoke: tool_calls={len(smoke.tool_calls)} 条 {smoke.tool_calls}"
          f"  usage={smoke.usage}")

    # ---- 第 2 步：可复现性 —— 同输入 N 次，配置里的 temperature/seed ---------
    question = [
        ChatMessage("system", "用一句话回答，不要解释。"),
        ChatMessage("user", "用一个词回答：一组数据从小到大排在正中间的数叫什么？"),
    ]
    answers = []
    for i in range(args.runs):
        resp = provider.chat(question, [])
        answers.append(resp.content)
        print(f"  run{i + 1}: {resp.content!r}")
    identical = len(set(answers)) == 1
    report["reproducibility"] = {"answers": answers, "identical": identical}

    out = ROOT / "logs" / ("probe_provider_%s.json" % time.strftime("%Y%m%d"))
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"记录已写 {out}")

    if not smoke.tool_calls:
        print("[结论] smoke 没拿到工具调用 —— 查模型是否支持 tools、"
              "think 口径是否与 config 一致；先解决再谈评测")
        return 1
    if identical:
        print(f"[结论] {args.runs} 次逐字一致 —— 本地通道在当前配置下可复现，"
              "口径写进 ADR")
        return 0
    print(f"[结论] {args.runs} 次不一致 —— 本地通道也非逐字可复现，"
          "评测走 N 次分布口径（均值±极差）")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
