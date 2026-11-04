# -*- coding: utf-8 -*-
"""W0 九份契约的可机械校验部分（只用标准库）。

这些测试不判断文档"写得好不好"，只钉住能数出来的东西：

* 六份文档存在，且关键表格的条数与编号连续；
* 工具表恰好 30 条，每条有入参/返回/错误码/审批/风险；
* 基准 SQL 20 条、验收任务 30 条（四视角 8/8/7/7）；
* 九个事件类型齐全，样例 JSONL 每行可解析；
* 三份 JSON Schema 是合法 JSON、draft-07、required 与 properties 对得上；
* 没有 TBD / 待定 这类占位。
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "docs" / "contracts"
SCHEMA = CONTRACTS / "schema"

DOCS = {
    "agent-events": CONTRACTS / "agent-events.md",
    "mcp-tools": CONTRACTS / "mcp-tools.md",
    "run-link": CONTRACTS / "run-link.md",
    "bench-sql": CONTRACTS / "bench-sql.md",
    "eval-30": CONTRACTS / "eval-30.md",
    "rpa-fixture": CONTRACTS / "rpa-fixture.md",
}

EVENT_TYPES = [
    "session.start",
    "message.delta",
    "message.done",
    "tool.call",
    "tool.result",
    "approval.request",
    "approval.result",
    "usage",
    "error",
]

TOOL_ID_RE = re.compile(r"^\|\s*(T\d{2})\s*\|(.*)$", re.MULTILINE)
SQL_ID_RE = re.compile(r"^\|\s*(SQL-\d{2})\s*\|(.*)$", re.MULTILINE)
SQL_HEAD_RE = re.compile(r"^### (SQL-\d{2}) ", re.MULTILINE)
EV_ID_RE = re.compile(r"^\|\s*(EV-\d{2})\s*\|(.*)$", re.MULTILINE)
EVT_ID_RE = re.compile(r"^\|\s*(EVT-\d{2})\s*\|(.*)$", re.MULTILINE)
INV_ID_RE = re.compile(r"^\|\s*(INV-\d{2})\s*\|(.*)$", re.MULTILINE)


def read(name: str) -> str:
    path = DOCS[name]
    if not path.exists():
        raise AssertionError("缺少契约文档：%s" % path)
    return path.read_text(encoding="utf-8")


def cells(line: str) -> list:
    """把 markdown 表格行拆成单元格；首尾空串保留，调用方按列取值。"""
    return [part.strip() for part in line.split("|")]


def table_rows(pattern: re.Pattern, text: str) -> list:
    return [(m.group(1), cells(m.group(0))) for m in pattern.finditer(text)]


class TestDocsExist(unittest.TestCase):
    def test_six_docs_exist(self):
        for name, path in DOCS.items():
            with self.subTest(doc=name):
                self.assertTrue(path.is_file(), "缺少 %s" % path)
                self.assertGreater(path.stat().st_size, 500, "%s 太短，像占位" % path)

    def test_no_placeholders(self):
        for name in DOCS:
            text = read(name)
            for bad in ("TBD", "TODO", "待定", "待补", "XXX"):
                with self.subTest(doc=name, bad=bad):
                    self.assertNotIn(bad, text, "%s 里还有 %s" % (name, bad))


class TestAgentEvents(unittest.TestCase):
    def setUp(self):
        self.text = read("agent-events")

    def test_index_has_nine_events(self):
        rows = table_rows(EVT_ID_RE, self.text)
        self.assertEqual(len(rows), 9)
        self.assertEqual([rid for rid, _ in rows],
                         ["EVT-%02d" % i for i in range(1, 10)])
        names = []
        for _, row in rows:
            self.assertGreaterEqual(len(row), 6, "事件索引列不够：%s" % row)
            name = row[2].strip("`")
            self.assertIn(name, EVENT_TYPES)
            names.append(name)
        self.assertEqual(names, EVENT_TYPES)

    def test_each_event_has_field_section(self):
        headings = re.findall(r"^### 3\.\d+ `([a-z.]+)`", self.text, re.MULTILINE)
        self.assertEqual(len(headings), 9, "九个事件各要有一张字段表，实际：%s" % headings)
        self.assertEqual(sorted(headings), sorted(EVENT_TYPES))

    def test_every_event_has_field_table(self):
        parts = re.split(r"^### 3\.\d+ `[a-z.]+`.*$", self.text, flags=re.MULTILINE)
        # parts[0] 是 §3 之前的内容，之后每个事件一段
        sections = parts[1:]
        self.assertEqual(len(sections), 9)
        for name, section in zip(EVENT_TYPES, sections):
            with self.subTest(event=name):
                self.assertIn("| 字段 | 类型 | 必填 | 含义 |", section,
                              "%s 没有字段表" % name)
                self.assertGreaterEqual(
                    len(re.findall(r"^\| `?[a-z_]+`? \|", section, re.MULTILINE)), 1,
                    "%s 字段表没有数据行" % name)

    def test_jsonl_samples_parse_and_cover_all_types(self):
        blocks = re.findall(r"```jsonl\n(.*?)```", self.text, re.DOTALL)
        self.assertGreaterEqual(len(blocks), 2, "至少要有一段完整序列 + 一段错误路径")
        seen = set()
        lines = 0
        for block in blocks:
            for raw in block.splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                lines += 1
                event = json.loads(raw)
                self.assertIn("type", event)
                self.assertIn("session_id", event)
                self.assertIn("data", event)
                self.assertIn(event["type"], EVENT_TYPES)
                self.assertIsInstance(event["data"], dict)
                seen.add(event["type"])
        self.assertGreaterEqual(lines, 10)
        self.assertEqual(seen, set(EVENT_TYPES))

    def test_both_runtimes_mapped(self):
        for token in ("OpenCode", "Claude Agent SDK", "permission.asked",
                      "can_use_tool", "message_start"):
            self.assertIn(token, self.text)


class TestMcpTools(unittest.TestCase):
    def setUp(self):
        self.text = read("mcp-tools")
        self.rows = table_rows(TOOL_ID_RE, self.text)
        self.names = [row[2].strip("`") for _, row in self.rows]

    def test_exactly_thirty_tools(self):
        self.assertEqual(len(self.rows), 30, "工具表必须恰好 30 条")
        self.assertEqual([rid for rid, _ in self.rows],
                         ["T%02d" % i for i in range(1, 31)])
        self.assertEqual(len(set(self.names)), 30, "工具名不能重复")

    def test_each_tool_row_is_complete(self):
        for rid, row in self.rows:
            with self.subTest(tool=rid):
                self.assertGreaterEqual(len(row), 9, "%s 列数不够" % rid)
                name = row[2].strip("`")
                self.assertRegex(name, r"^[a-z][a-z0-9_]*$")
                self.assertIn(row[3], {"台站", "质控", "研判", "工单",
                                       "知识", "工作流", "套件", "数据", "管线"})
                params = row[4]
                self.assertTrue(params, "%s 入参为空" % rid)
                self.assertRegex(
                    params,
                    r"[a-z_]+:(string|integer|number|boolean|object|array)")
                self.assertTrue(row[5], "%s 返回为空" % rid)
                codes = re.findall(r"E_[A-Z_]+", row[6])
                self.assertGreaterEqual(len(codes), 1, "%s 没有错误码" % rid)
                self.assertRegex(row[7], r"^(是|否|条件（.+）)$")
                self.assertIn(row[8], {"low", "medium", "high"})
                if row[8] == "high":
                    self.assertEqual(row[7], "是", "high 风险必须审批：%s" % rid)

    def test_error_codes_are_defined(self):
        defined = set(re.findall(r"^\|\s*(E_[A-Z_]+)\s*\|", self.text, re.MULTILINE))
        used = set()
        for _, row in self.rows:
            used.update(re.findall(r"E_[A-Z_]+", row[6]))
        self.assertTrue(used)
        self.assertEqual(used - defined, set(), "用了未定义的错误码")

    def test_groups_and_approval_coverage(self):
        groups = {row[3] for _, row in self.rows}
        self.assertEqual(groups, {"台站", "质控", "研判", "工单",
                                  "知识", "工作流", "套件", "数据", "管线"})
        approvals = [row[7] for _, row in self.rows]
        self.assertGreaterEqual(approvals.count("是"), 2)
        self.assertGreaterEqual(sum(a == "否" for a in approvals), 20)

    def test_legacy_alias_section(self):
        for token in ("knowledge_search", "native_graph_pdf", "suite_launcher.py"):
            self.assertIn(token, self.text)


class TestRunLink(unittest.TestCase):
    def setUp(self):
        self.text = read("run-link")

    def test_four_tables_and_link(self):
        headings = re.findall(
            r"^### 2\.\d+ `([a-z_]+)`.*$", self.text, re.MULTILINE)
        self.assertEqual(len(headings), 5)
        self.assertEqual(set(headings), {"task", "thread", "agent", "work_order", "run_link"})
        self.assertIn("唯一耦合点", self.text)

    def test_each_table_has_field_table(self):
        for name in ("task", "thread", "agent", "work_order", "run_link"):
            with self.subTest(table=name):
                pattern = r"### 2\.\d+ `%s`(.*?)(?=\n### |\Z)" % name
                match = re.search(pattern, self.text, re.DOTALL)
                self.assertIsNotNone(match, "缺少 %s 小节" % name)
                section = match.group(1)
                self.assertIn("| 字段 | 类型 | 必填 | 含义 |", section)
                self.assertGreaterEqual(
                    len(re.findall(r"^\| `[a-z_]+` \|", section, re.MULTILINE)), 6)

    def test_single_coupling_rule_and_ddl(self):
        self.assertIn("四张表互不设外键", self.text)
        self.assertIn("CREATE TABLE run_link", self.text)
        self.assertIn("UNIQUE INDEX", self.text)
        self.assertIn("task_id", self.text)

    def test_query_examples_present(self):
        self.assertGreaterEqual(self.text.count("```sql"), 5)
        self.assertIn("LEFT JOIN run_link", self.text)
        self.assertIn("WHERE t.task_id", self.text)


class TestBenchSql(unittest.TestCase):
    def setUp(self):
        self.text = read("bench-sql")
        self.rows = table_rows(SQL_ID_RE, self.text)
        self.heads = re.findall(r"^### (SQL-\d{2}) ", self.text, re.MULTILINE)

    def test_exactly_twenty(self):
        self.assertEqual(len(self.rows), 20, "基准 SQL 必须 20 条")
        self.assertEqual([rid for rid, _ in self.rows],
                         ["SQL-%02d" % i for i in range(1, 21)])
        self.assertEqual(self.heads, ["SQL-%02d" % i for i in range(1, 21)])

    def test_each_query_has_sql_shape_and_dialect(self):
        parts = re.split(r"^### (SQL-\d{2}) .*$", self.text, flags=re.MULTILINE)
        # parts = [前言, id1, body1, id2, body2, ...]
        bodies = list(zip(parts[1::2], parts[2::2]))
        self.assertEqual(len(bodies), 20)
        for rid, body in bodies:
            with self.subTest(query=rid):
                self.assertEqual(body.count("```sql"), 1, "%s 要恰好一段 SQL" % rid)
                self.assertIn("**预期形状**", body, "%s 缺预期形状" % rid)
                self.assertIn("**差异**", body, "%s 缺方言差异" % rid)
                self.assertRegex(body, r"行|列|count")

    def test_four_views_documented(self):
        for view in ("obs", "tec", "agg_hour", "agg_daily"):
            self.assertIn("`%s`" % view, self.text)
        self.assertIn("station/date/hour", self.text)
        self.assertIn("9,849,600", self.text)
        self.assertIn("4,924,800", self.text)

    def test_both_engines_named(self):
        self.assertIn("DuckDB", self.text)
        self.assertIn("ClickHouse", self.text)


class TestEval30(unittest.TestCase):
    def setUp(self):
        self.text = read("eval-30")
        self.rows = table_rows(EV_ID_RE, self.text)
        self.chain_tools = set()
        for _, row in self.rows:
            chain = row[4].replace("`", "")
            if chain.strip() == "无":
                continue
            for token in chain.split("→"):
                self.chain_tools.add(token.strip())

    def test_exactly_thirty(self):
        self.assertEqual(len(self.rows), 30, "验收任务必须 30 条")
        self.assertEqual([rid for rid, _ in self.rows],
                         ["EV-%02d" % i for i in range(1, 31)])

    def test_four_perspectives_and_distribution(self):
        counts = {"对话": 0, "编队": 0, "数据": 0, "套件": 0}
        for _, row in self.rows:
            self.assertIn(row[2], counts, "未知视角：%s" % row[2])
            counts[row[2]] += 1
        self.assertEqual(counts, {"对话": 8, "编队": 8, "数据": 7, "套件": 7})

    def test_each_task_is_complete(self):
        for rid, row in self.rows:
            with self.subTest(task=rid):
                self.assertGreaterEqual(len(row), 7, "%s 列数不够" % rid)
                self.assertTrue(row[3], "%s 输入为空" % rid)
                self.assertTrue(row[4], "%s 工具链为空" % rid)
                self.assertTrue(row[5], "%s 输出要点为空" % rid)
                self.assertRegex(row[6], r"^S\d(\+S\d)*；", "%s 判分不是规则编号" % rid)

    def test_tool_chains_use_known_tools(self):
        known = {row[2].strip("`") for _, row in table_rows(TOOL_ID_RE, read("mcp-tools"))}
        unknown = self.chain_tools - known
        self.assertEqual(unknown, set(), "验收任务引用了工具表里没有的工具")
        self.assertGreaterEqual(len(self.chain_tools), 20, "工具链覆盖太窄")

    def test_zero_tool_tasks_declared(self):
        zero = [rid for rid, row in self.rows if row[4].strip() == "无"]
        self.assertEqual(zero, ["EV-08", "EV-29", "EV-30"])

    def test_scoring_rubric_defined(self):
        for code in ("S1", "S2", "S3", "S4", "S5", "S6"):
            self.assertRegex(self.text, r"\| %s \|" % code)


class TestRpaFixture(unittest.TestCase):
    def setUp(self):
        self.text = read("rpa-fixture")

    def test_three_required_files(self):
        for name in ("targets.json", "locators.json", "meta.json"):
            self.assertIn(name, self.text)
        self.assertIn("page.html", self.text)
        self.assertIn("2 MiB", self.text)

    def test_target_fields_documented(self):
        for field in ("idx", "tag", "id", "cls", "label", "w", "h"):
            self.assertRegex(self.text, r"\| `%s` \|" % field)

    def test_locator_grammar(self):
        for token in ("`#id`", "`label`", "`label@N`"):
            self.assertIn(token, self.text)
        self.assertIn("1 起", self.text)

    def test_meta_fields_documented(self):
        for field in ("url", "viewport", "captured_at", "suite_version",
                      "target_count", "html_truncated", "html_bytes"):
            self.assertRegex(self.text, r"\| `%s(\.|\`)" % field)

    def test_desensitization(self):
        self.assertIn("<user>", self.text)
        self.assertIn("check_desensitization", self.text)
        self.assertIn("file:///", self.text)

    def test_replay_semantics(self):
        for kind in ("找不到", "不唯一", "越界", "空清单"):
            self.assertIn(kind, self.text)
        self.assertIn("--replay-all", self.text)
        self.assertIn("退出码", self.text)
        self.assertIn("不 import `cdp_driver`", self.text)

    def test_invalidation_criteria(self):
        rows = table_rows(INV_ID_RE, self.text)
        self.assertEqual(len(rows), 10, "失效判据必须 10 条")
        for rid, row in rows:
            with self.subTest(criterion=rid):
                self.assertGreaterEqual(len(row), 6)
                self.assertTrue(row[3], "%s 缺阈值" % rid)
                self.assertTrue(row[4], "%s 缺处置" % rid)


class TestSchemas(unittest.TestCase):
    def load(self, name: str) -> dict:
        path = SCHEMA / name
        self.assertTrue(path.is_file(), "缺少 schema：%s" % path)
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)  # 不合法 JSON 直接失败
        self.assertIn("draft-07", data.get("$schema", ""))
        self.assertTrue(data.get("required"), "%s 没有 required" % name)
        return data

    def assert_required_declared(self, schema: dict, label: str):
        props = schema.get("properties") or {}
        for key in schema.get("required", []):
            self.assertIn(key, props, "%s.required 里的 %s 没在 properties 声明" % (label, key))

    def test_agent_event_schema(self):
        data = self.load("agent-event.schema.json")
        self.assert_required_declared(data, "agent-event")
        enum = data["properties"]["type"]["enum"]
        self.assertEqual(enum, EVENT_TYPES)
        branches = data["oneOf"]
        self.assertEqual(len(branches), 9)
        consts = [b["properties"]["type"]["const"] for b in branches]
        self.assertEqual(consts, EVENT_TYPES)
        for name, definition in data["definitions"].items():
            with self.subTest(definition=name):
                for key in definition.get("required", []):
                    self.assertIn(key, definition.get("properties", {}),
                                  "%s 的 %s 未声明" % (name, key))

    def test_mcp_tool_schema(self):
        data = self.load("mcp-tool.schema.json")
        self.assert_required_declared(data, "mcp-tool")
        self.assertEqual(
            set(data["required"]),
            {"name", "group", "description", "params", "returns",
             "errors", "approval", "risk"})
        params = data["properties"]["params"]["additionalProperties"]
        self.assertIn("type", params["required"])
        self.assertIn("required", params["required"])
        self.assertIn("否", data["properties"]["approval"]["pattern"])
        self.assertIn("是", data["properties"]["approval"]["pattern"])

    def test_run_link_schema(self):
        data = self.load("run-link.schema.json")
        self.assert_required_declared(data, "run-link")
        self.assertEqual(
            set(data["required"]),
            {"task", "thread", "agent", "work_order", "run_link"})
        self.assertEqual(
            set(data["definitions"]),
            {"task", "thread", "agent", "work_order", "run_link"})
        for name, definition in data["definitions"].items():
            with self.subTest(definition=name):
                self.assertTrue(definition["required"])
                for key in definition["required"]:
                    self.assertIn(key, definition["properties"],
                                  "%s 的 %s 未声明" % (name, key))

    def test_run_link_has_four_way_ids(self):
        data = self.load("run-link.schema.json")
        self.assertIn("task_id", data["definitions"]["run_link"]["properties"])
        self.assertIn("kind", data["definitions"]["run_link"]["properties"])
        self.assertIn("external_id", data["definitions"]["run_link"]["properties"])
        kinds = data["definitions"]["run_link"]["properties"]["kind"]["enum"]
        self.assertEqual(set(kinds), {"thread", "agent", "work_order"})


if __name__ == "__main__":
    unittest.main()
