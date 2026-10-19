"""M4-0 最小知识库：SQLite FTS5 + 检索工具。

只使用标准库。知识条目来自项目内规程与已知判据，不冒充真实设备厂商手册；
真实规程到位后替换 ``data/kb/knowledge.jsonl`` 并重建索引即可。
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path

from .tools import ToolResult

REQUIRED_DOC_FIELDS = ("doc_id", "title", "category", "body", "source")


def load_documents(path: str | Path) -> list[dict]:
    """读取 JSONL 知识条目并校验字段。"""
    p = Path(path)
    docs: list[dict] = []
    seen: set[str] = set()
    with p.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{p}:{line_no} 不是合法 JSON: {exc.msg}") from exc
            if not isinstance(doc, dict):
                raise ValueError(f"{p}:{line_no} 必须是 object")
            missing = [k for k in REQUIRED_DOC_FIELDS
                       if not isinstance(doc.get(k), str) or not doc[k].strip()]
            if missing:
                raise ValueError(f"{p}:{line_no} 缺字段或为空: {missing}")
            if doc["doc_id"] in seen:
                raise ValueError(f"{p}:{line_no} doc_id 重复: {doc['doc_id']}")
            seen.add(doc["doc_id"])
            docs.append({k: doc[k].strip() for k in REQUIRED_DOC_FIELDS})
    return docs


def _fts_query(query: str) -> str:
    """把中文短语切成 trigram、英文/数字保留为词，再用 OR 组合。"""
    pieces = [p for p in re.split(r"[\s，。；、：,.;:()（）/]+", query) if p]
    terms: list[str] = []
    for piece in pieces:
        if re.fullmatch(r"[A-Za-z0-9_.+-]+", piece):
            terms.append(piece)
            continue
        if len(piece) <= 3:
            terms.append(piece)
        else:
            terms.extend(piece[i:i + 3] for i in range(len(piece) - 2))
    # FTS5 的引号可避免 + - : 等被当成语法。
    quoted = [f'"{t.replace(chr(34), chr(34) * 2)}"' for t in dict.fromkeys(terms)]
    return " OR ".join(quoted)


def _fallback_terms(query: str) -> list[str]:
    """FTS 无命中时的中文二字词兜底，不替代 FTS 主路径。"""
    pieces = [p for p in re.split(r"[\s，。；、：,.;:()（）/]+", query) if p]
    terms: list[str] = []
    for piece in pieces:
        if re.fullmatch(r"[A-Za-z0-9_.+-]+", piece):
            terms.append(piece.lower())
        elif len(piece) <= 2:
            terms.append(piece)
        else:
            terms.extend(piece[i:i + 2] for i in range(len(piece) - 1))
    return list(dict.fromkeys(terms))


class KnowledgeBase:
    """一个可重建的 SQLite FTS5 知识索引。"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        return con

    def _init_schema(self) -> None:
        with closing(self._connect()) as con:
            with con:
                con.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts "
                    "USING fts5(doc_id UNINDEXED, title, category, body, source, "
                    "tokenize='trigram')")

    def index(self, documents: list[dict]) -> None:
        """全量重建索引，保证同一输入得到同一知识库内容。"""
        with closing(self._connect()) as con:
            with con:
                con.execute("DELETE FROM knowledge_fts")
                con.executemany(
                    "INSERT INTO knowledge_fts(doc_id,title,category,body,source) "
                    "VALUES(:doc_id,:title,:category,:body,:source)",
                    documents)

    def search(self, query: str, limit: int = 5) -> list[dict]:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query 不能为空")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit 必须是正整数")
        fts = _fts_query(query.strip())
        if not fts:
            return []
        with closing(self._connect()) as con:
            rows = con.execute(
                "SELECT doc_id,title,category,body,source,bm25(knowledge_fts) AS score "
                "FROM knowledge_fts WHERE knowledge_fts MATCH ? "
                "ORDER BY score, doc_id LIMIT ?",
                (fts, limit)).fetchall()
            if rows:
                return [dict(row) for row in rows]

            # FTS5 的 trigram 对很短的词或跨词短语可能零命中。用二字词做
            # 可见的兜底排序，并保留同一返回 schema；这不是第二套索引。
            terms = _fallback_terms(query)
            all_rows = con.execute(
                "SELECT doc_id,title,category,body,source FROM knowledge_fts").fetchall()
            scored = []
            for row in all_rows:
                text = " ".join(str(row[k]) for k in
                                ("title", "body")).lower()
                count = sum(1 for term in terms if term in text)
                if count >= 2:
                    scored.append((count, dict(row)))
            scored.sort(key=lambda pair: (-pair[0], pair[1]["doc_id"]))
            return [{**row, "score": -float(count)}
                    for count, row in scored[:limit]]


class KnowledgeSearchTool:
    name = "knowledge_search"
    description = "检索质控、运维、设备与归档规程；返回标题、正文、来源和检索分数。"
    params = {
        "query": {
            "type": "string", "required": True,
            "description": "要查的故障现象或规程问题",
        },
        "limit": {
            "type": "integer", "required": False,
            "description": "最多返回条数，默认 5",
        },
    }
    risk = "low"

    def __init__(self, kb: KnowledgeBase):
        self.kb = kb

    def invoke(self, args: dict) -> ToolResult:
        query = args.get("query")
        limit = args.get("limit", 5)
        if not isinstance(query, str) or not query.strip():
            return ToolResult(ok=False, error="参数 query 必须是非空字符串")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            return ToolResult(ok=False, error="参数 limit 必须是正整数")
        try:
            rows = self.kb.search(query, limit=limit)
        except (ValueError, sqlite3.Error) as exc:
            return ToolResult(ok=False, error=f"知识库检索失败：{exc}")
        return ToolResult(ok=True, data={
            "query": query.strip(),
            "count": len(rows),
            "results": rows,
        })


def knowledge_search_tool(kb: KnowledgeBase) -> KnowledgeSearchTool:
    return KnowledgeSearchTool(kb)
