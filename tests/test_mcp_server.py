# -*- coding: utf-8 -*-
"""`fieldstation.mcp_server` 的验收测试。

这份测试守的不是「服务能起」，而是**工具面这张表可信**。三件事一旦破了，
表面上一切都正常，只有实际调用时才逐个失败：

1. **工具清单从契约现解析** —— 若哪天有人把它改成硬编码，契约加了工具服务也看不到。
   所以这里有一条「改契约里的工具名，解析结果必须跟着变」的测试。
2. **解析出 0 个就硬失败** —— 静默返回空列表会让服务正常起但一个工具都没有。
3. **审批守卫在服务里** —— 放在调用方等于任何直连接口都能绕过。

另守一条仓库纪律：**不许 skip**。
"""
from __future__ import annotations

import asyncio
import unittest
from pathlib import Path

from fieldstation import mcp_server as M

ROOT = Path(__file__).resolve().parents[1]

SPECS = M.load_tools()


def _call(server, name: str, args: dict) -> dict:
    """走一次真 MCP 调用并取回 JSON 载荷。"""
    import json

    result = asyncio.run(server.call_tool(name, args))
    text = result.content[0].text if result.content else "{}"
    return json.loads(text)


def _server(**ctx_kwargs):
    return M.build_server(SPECS, M.DispatchContext(**ctx_kwargs))


class TestParse(unittest.TestCase):
    def test_parses_exactly_thirty(self):
        """契约说 30 个，就必须解析出 30 个。"""
        self.assertEqual(len(SPECS), M.EXPECTED_TOOLS,
                         f"契约说 {M.EXPECTED_TOOLS} 个，解析出 {len(SPECS)} 个")

    def test_names_are_unique_and_well_formed(self):
        names = [s.name for s in SPECS]
        self.assertEqual(len(set(names)), len(names), "契约里有重名工具")
        for name in names:
            self.assertRegex(name, r"^[a-z][a-z0-9_]*$", f"工具名不合规：{name}")

    def test_every_tool_has_required_fields(self):
        for s in SPECS:
            with self.subTest(tool=s.name):
                self.assertTrue(s.name)
                self.assertTrue(s.description, "描述不能为空（MCP schema 要求 minLength=1）")
                self.assertIn(s.risk, M.RISK_LEVELS)
                self.assertTrue(s.errors, "至少给一个错误码")
                for code in s.errors:
                    self.assertRegex(code, r"^E_[A-Z_]+$")

    def test_risk_denominator_is_stable(self):
        """高危工具必须恰好是契约里那两个（execute_device_action / workflow_gate）。

        这条盯的是「风险级解析错位」：一旦列对齐错一格，risk 会整体串位，
        而总数仍然是 30 —— 只有钉住具体名单才看得出来。
        """
        high = sorted(s.name for s in SPECS if s.risk == "high")
        self.assertEqual(high, ["execute_device_action", "workflow_gate"])

    def test_needs_approval_matches_contract_rule(self):
        """审批 = 「是」 或 risk=high 时必须审批；条件型不猜。"""
        for s in SPECS:
            with self.subTest(tool=s.name):
                expected = (s.approval == "是") or (s.risk == "high")
                self.assertEqual(s.needs_approval, expected)


class TestNotHardcoded(unittest.TestCase):
    """错法一：手抄 30 个。改契约必须立刻反映到解析结果。"""

    def test_renaming_a_tool_in_contract_changes_result(self):
        text = M.CONTRACT.read_text(encoding="utf-8", errors="replace")
        self.assertIn("`station_health`", text)
        mutated = text.replace("`station_health`", "`station_health_v2`", 1)
        names = [s.name for s in M.parse_tools(mutated)]
        self.assertIn("station_health_v2", names)
        self.assertNotIn("station_health", names)

    def test_dropping_a_row_changes_count(self):
        text = M.CONTRACT.read_text(encoding="utf-8", errors="replace")
        lines = [ln for ln in text.splitlines() if not ln.startswith("| T30 ")]
        self.assertEqual(len(M.parse_tools("\n".join(lines))), M.EXPECTED_TOOLS - 1)


class TestFailsLoudOnEmpty(unittest.TestCase):
    """错法二：解析失败返回空列表。必须抛，不许静默。"""

    def test_empty_text_raises(self):
        with self.assertRaises(M.ContractError):
            M.parse_tools("这里没有任何表格")

    def test_header_only_raises(self):
        with self.assertRaises(M.ContractError):
            M.parse_tools("| 编号 | 名称 |\n|---|---|\n")

    def test_main_exits_two_on_bad_contract(self):
        original = M.CONTRACT
        tmp = Path(__file__).resolve().parent / "_mcp_bad_contract.md"
        tmp.write_text("nope", encoding="utf-8")
        try:
            M.CONTRACT = tmp
            self.assertEqual(M.main(["--check"]), 2)
        finally:
            M.CONTRACT = original
            tmp.unlink(missing_ok=True)

    def test_missing_contract_file_is_contract_error(self):
        with self.assertRaises(M.ContractError):
            M.load_tools(ROOT / "docs" / "contracts" / "__nope__.md")


class TestRegistration(unittest.TestCase):
    def test_registers_thirty_with_exact_names(self):
        server = _server()
        tools = asyncio.run(server.list_tools())
        self.assertEqual(len(tools), M.EXPECTED_TOOLS)
        self.assertEqual({t.name for t in tools}, {s.name for s in SPECS})

    def test_high_risk_tool_schema_takes_approval_id(self):
        """审批 id 是**额外的调用约定参数**，必须出现在 Schema 里，模型才知道能传。"""
        tools = {t.name: t for t in asyncio.run(_server().list_tools())}
        schema = tools["execute_device_action"].input_schema
        self.assertIn("approval_id", schema["properties"])

    def test_low_risk_tool_does_not_take_approval_id(self):
        tools = {t.name: t for t in asyncio.run(_server().list_tools())}
        schema = tools["robust_stats"].input_schema
        self.assertNotIn("approval_id", schema["properties"])

    def test_contract_params_appear_in_schema(self):
        tools = {t.name: t for t in asyncio.run(_server().list_tools())}
        schema = tools["station_health"].input_schema
        self.assertIn("readings", schema["properties"])
        self.assertIn("station_id", schema["properties"])
        self.assertIn("readings", schema.get("required", []))


class TestApproval(unittest.TestCase):
    """错法四/五：审批必须由**服务**校验，不能靠调用方自觉。"""

    ARGS = {"station_id": "WUHN", "action": "restart_receiver", "reason": "无心跳 3 小时"}

    def test_without_approval_id_is_rejected(self):
        payload = _call(_server(), "execute_device_action", dict(self.ARGS))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "E_APPROVAL_REQUIRED")

    def test_forged_approval_id_is_denied(self):
        payload = _call(_server(), "execute_device_action",
                        dict(self.ARGS, approval_id="ap-forged"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "E_APPROVAL_DENIED")

    def test_granted_approval_id_executes(self):
        ledger = M.InMemoryLedger()
        ledger.grant("ap-01")
        payload = _call(_server(ledger=ledger), "execute_device_action",
                        dict(self.ARGS, approval_id="ap-01"))
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["data"]["station_id"], "WUHN")

    def test_default_ledger_denies_everything(self):
        """默认台账一律不批：宁可不可用，也不默认放行。"""
        self.assertFalse(M.DenyAllLedger().is_approved("anything"))

    def test_low_risk_runs_without_approval(self):
        payload = _call(_server(), "robust_stats", {"values": [1, 2, 3, 4, 100]})
        self.assertTrue(payload["ok"], payload)


class TestDispatch(unittest.TestCase):
    """分发要真的落到 `agents/tools/` 的既有实现上，而不是自造一份。"""

    def test_robust_stats_matches_rules_layer(self):
        from fieldstation.rules.qc import mad, median

        values = [1, 2, 3, 4, 100]
        payload = _call(_server(), "robust_stats", {"values": values})
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["data"]["n"], 5)
        self.assertEqual(payload["data"]["median"], median(values))
        self.assertEqual(payload["data"]["mad"], mad(values))

    def test_unimplemented_tool_reports_unavailable_not_success(self):
        """没接的工具必须明说不可用，不许伪造一个「成功」。"""
        payload = _call(_server(), "pipeline_status", {"run_id": "r1"})
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "E_UNAVAILABLE")


class TestEntrypoint(unittest.TestCase):
    def test_check_mode_succeeds_on_real_contract(self):
        self.assertEqual(M.main(["--check"]), 0)

    def test_default_port_does_not_collide(self):
        # 9223/9224 套件 CDP、8788 运行时网关、4096 opencode、18123/19001 ClickHouse 测试
        self.assertNotIn(M.DEFAULT_PORT, {4096, 8788, 9223, 9224, 18123, 19001})


class TestNoSkipDiscipline(unittest.TestCase):
    def test_no_skip_invocations(self):
        p = "skip"
        tokens = (p + "Test(", "." + p + "(", p + "Unless(", p + "If(")
        src = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual([t for t in tokens if t in src], [])


if __name__ == "__main__":
    unittest.main()
