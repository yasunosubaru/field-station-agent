#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 JSONL 规程构建 SQLite FTS5 知识库，并跑抽查（in_scope + 开放探针）。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.agents.knowledge import KnowledgeBase, load_documents  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="构建野外台站规程知识库")
    ap.add_argument("--docs", default=str(ROOT / "data" / "kb" / "knowledge.jsonl"))
    ap.add_argument("--db", default=str(ROOT / "data" / "kb" / "knowledge.sqlite3"))
    ap.add_argument("--queries", default=str(ROOT / "data" / "kb" / "smoke_queries.json"))
    ap.add_argument("--log", default=str(ROOT / "logs" / "kb_smoke_20261019.json"))
    args = ap.parse_args(argv)

    docs = load_documents(args.docs)
    kb = KnowledgeBase(args.db)
    kb.index(docs)

    cases = json.loads(Path(args.queries).read_text(encoding="utf-8"))
    if not isinstance(cases, dict) or "in_scope" not in cases:
        print(f"[阻断] 抽查输入需含 in_scope/probes：{args.queries}")
        return 2

    rows = []
    for case in cases["in_scope"]:
        hits = kb.search(case["query"], limit=3)
        ids = [hit["doc_id"] for hit in hits]
        rows.append({
            "query": case["query"],
            "expected_id": case["expected_id"],
            "hit": case["expected_id"] in ids,
            "top3": ids,
        })
    n_hit = sum(1 for row in rows if row["hit"])

    probes = []
    for probe in cases.get("probes", []):
        hits = kb.search(probe["query"], limit=3)
        ids = [hit["doc_id"] for hit in hits]
        probes.append({
            "query": probe["query"],
            "note": probe.get("note", ""),
            "top3": ids,
            "empty": not ids,
            "covered": False,
        })

    report = {
        "kind": "fieldstation.kb_smoke",
        "documents": len(docs),
        "construction": (
            f"in_scope 的 {len(rows)} 条问题按库内 {len(docs)} 条规程逐条构造，"
            "问题与条目一一对应；命中率只证明检索通路与切词在工作，"
            "不代表开放查询的泛化命中率"),
        "in_scope_queries": len(rows),
        "in_scope_hits": n_hit,
        "in_scope_hit_rate": round(n_hit / len(rows), 3) if rows else 0.0,
        "failures": [row for row in rows if not row["hit"]],
        "rows": rows,
        "probes": probes,
        "probe_note": (
            "probes 均为库内无对应条目的开放问题；empty=true 表示正确报告"
            "无覆盖，非空只表示词面相近的弱命中（见 top3），不构成知识覆盖"),
    }
    log = Path(args.log)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    empty = sum(1 for probe in probes if probe["empty"])
    print(f"documents={len(docs)} in_scope={len(rows)} hits={n_hit} "
          f"hit_rate={report['in_scope_hit_rate']:.3f}")
    print(f"probes={len(probes)} empty={empty}")
    print(f"db={args.db}")
    print(f"log={log}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

