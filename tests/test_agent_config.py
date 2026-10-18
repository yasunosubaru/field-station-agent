"""声明式 agent 配置的测试（M3-1，issue #51 的落点）。

验收三条各对应测试：

* 「未注册工具调不动」→ ``TestBuildScope::test_out_of_whitelist_call_is_rejected``：
  白名单通过**过滤**实现（装配一个只含白名单工具的注册表视图，交给 runtime），
  名单外的工具调用走 runtime 既有未注册路径被拒 —— 不为此改 runtime 一行。
* 「参数不合 schema 给明确错误」→ ``TestVerdictTools::test_bad_params_get_clear_errors``。
* 「agent 不依赖 rules/ 的内部字段名」→ ``TestVerdictTools::test_*_matches_rules_*``：
  工具返回与 rules 纯函数**同入参逐键相等**。如果 rules 改了公开返回形状，
  这组测试立刻红，逼着在工具层显式做一次归一决定 —— 相等是漂移报警，不是耦合。

* 「新增 agent 没改运行时代码」→ ``TestAgentFromRepoConfig``：
  配置文件 + 现成注册表 + FakeProvider 脚本化的工具回合，全程走 runtime.run ——
  装配物是一份 JSON 与三个工具包装，runtime / providers / trace 零改动。

本文件只用标准库；不接真实模型。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation import constants as C
from fieldstation.agents import config as agent_config
from fieldstation.agents import runtime
from fieldstation.agents.config import AgentConfig, build, load_agent_config
from fieldstation.agents.providers.base import ChatResponse
from fieldstation.agents.providers.fake import FakeProvider
from fieldstation.agents.tools import ToolRegistry, ToolResult
from fieldstation.agents.tools.qc_tools import (
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
    slip_detect_tool,
)
from fieldstation.agents.trace.reader import read_trace
from fieldstation.agents.trace.writer import TraceWriter
from fieldstation.rules import qc
from tests import t7_support

ROOT = Path(__file__).resolve().parents[1]
REPO_QC_CONFIG = ROOT / "config" / "agents" / "qc.json"


class _StubExtraTool:
    """注册在 base 里、但故意不进 qc 白名单的工具，用来验证过滤。"""

    name = "stub_extra"
    description = "测试桩：不在 qc 的白名单里"
    params = {}
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        return ToolResult(ok=True, data={"stub": True})


def _write_cfg(td: str, **over) -> Path:
    cfg = {
        "name": "qc",
        "system_prompt": "你是数据质量校验助手",
        "tools": ["robust_stats", "slip_detect", "continuity_verdict",
                  "magnitude_verdict"],
        "provider": "ollama",
        "output_contract": "最终结论必须是 JSON",
    }
    cfg.update(over)
    path = Path(td) / "qc.json"
    path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    return path


def _base_registry() -> ToolRegistry:
    base = ToolRegistry()
    base.register(robust_stats_tool())
    base.register(slip_detect_tool())
    base.register(continuity_verdict_tool())
    base.register(magnitude_verdict_tool())
    base.register(_StubExtraTool())
    return base


def _slip_args(series) -> dict:
    s1, s2 = C.DEFAULT_PAIR["GPS"]
    rows = []
    for ep in series:
        row = {
            "gps_week": ep.gps_week,
            "gps_tow_s": ep.gps_tow_s,
            "quality_flag": ep.quality_flag,
        }
        for signal in (s1, s2):
            ob = ep.get(signal)
            row[signal] = None if ob is None else {
                "psr_m": ob.psr_m,
                "adr_cycles": ob.adr_cycles,
            }
        rows.append(row)
    return {
        "series": rows,
        "system": "GPS",
        "signal_1": s1,
        "signal_2": s2,
        "sign": C.meas_cycle_sign("adr"),
    }


class TestLoadAgentConfig(unittest.TestCase):
    def test_load_maps_all_fields(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = load_agent_config(_write_cfg(td))
        self.assertEqual(cfg.name, "qc")
        self.assertEqual(cfg.system_prompt, "你是数据质量校验助手")
        self.assertEqual(cfg.tools,
                         ["robust_stats", "slip_detect",
                          "continuity_verdict", "magnitude_verdict"])
        self.assertEqual(cfg.provider, "ollama")
        self.assertEqual(cfg.output_contract, "最终结论必须是 JSON")

    def test_output_contract_is_optional(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write_cfg(td)
            raw = json.loads(path.read_text(encoding="utf-8"))
            del raw["output_contract"]
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            cfg = load_agent_config(path)
        self.assertEqual(cfg.output_contract, "")

    def test_missing_required_field_names_the_file(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write_cfg(td)
            raw = json.loads(path.read_text(encoding="utf-8"))
            del raw["tools"]
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(ValueError) as cm:
                load_agent_config(path)
        self.assertIn("缺必需字段", str(cm.exception))
        self.assertIn("'tools'", str(cm.exception))
        self.assertIn("qc.json", str(cm.exception))

    def test_blank_system_prompt_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write_cfg(td, system_prompt="   ")
            with self.assertRaises(ValueError) as cm:
                load_agent_config(path)
        self.assertIn("system_prompt 不能是空白", str(cm.exception))

    def test_duplicate_tool_in_whitelist_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write_cfg(td, tools=["robust_stats", "robust_stats"])
            with self.assertRaises(ValueError) as cm:
                load_agent_config(path)
        self.assertIn("重名", str(cm.exception))

    def test_non_object_body_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "qc.json"
            path.write_text("[1, 2]", encoding="utf-8")
            with self.assertRaises(ValueError) as cm:
                load_agent_config(path)
        self.assertIn("JSON object", str(cm.exception))

    def test_tools_must_be_string_array(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write_cfg(td, tools="robust_stats")
            with self.assertRaises(ValueError) as cm:
                load_agent_config(path)
        self.assertIn("字符串数组", str(cm.exception))


class TestBuildScope(unittest.TestCase):
    CFG = AgentConfig(name="qc", system_prompt="s",
                      tools=["robust_stats", "continuity_verdict"],
                      provider="ollama")

    def test_build_returns_agent_and_scoped_registry(self):
        agent, scoped = build(TestBuildScope.CFG, FakeProvider(["答"]),
                              _base_registry())
        # describe 按 names() 字典序给出，白名单顺序无关
        self.assertEqual([t["name"] for t in agent.tools],
                         ["continuity_verdict", "robust_stats"])
        self.assertEqual(scoped.names(), ("continuity_verdict", "robust_stats"))
        # agent 拿到的描述就是注册表的 describe 形状（键集合固定）
        self.assertEqual(agent.tools, scoped.describe())

    def test_description_entries_keep_registry_shape(self):
        cfg = AgentConfig(name="qc", system_prompt="s",
                          tools=["robust_stats"], provider="ollama")
        agent, _ = build(cfg, FakeProvider(["答"]), _base_registry())
        self.assertEqual(set(agent.tools[0]),
                         {"name", "description", "params", "risk"})

    def test_unknown_tool_in_whitelist_fails_at_build(self):
        """配置里一个拼写错误在起飞前炸掉，错误里给出已注册清单。"""
        cfg = AgentConfig(name="qc", system_prompt="s",
                          tools=["slip_detect_typo"], provider="ollama")
        with self.assertRaises(ValueError) as cm:
            build(cfg, FakeProvider(["答"]), _base_registry())
        self.assertIn("slip_detect_typo", str(cm.exception))
        self.assertIn("robust_stats", str(cm.exception))

    def test_out_of_whitelist_call_is_rejected(self):
        """「未注册工具调不动」的可测试形态：stub_extra 在 base 已注册、
        在 qc 的白名单外 —— 过滤后的注册表里没有它，模型调它走 runtime
        未注册路径被拒，循环继续，配置一个字都没为它加。"""
        provider = FakeProvider([
            ChatResponse(content="", tool_calls=[
                {"name": "stub_extra", "args": {}}]),
            "改为走白名单工具。",
        ])
        agent, scoped = build(TestBuildScope.CFG, provider, _base_registry())
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            out = runtime.run(agent, "查一下", TraceWriter(path), registry=scoped)
            self.assertEqual(out, "改为走白名单工具。")
            events = read_trace(path)
        rejected = [e for e in events
                    if e["kind"] == "tool_result" and not e["ok"]]
        self.assertTrue(rejected)
        self.assertIn("未注册的工具", rejected[0]["error"])
        self.assertIn("'stub_extra'", rejected[0]["error"])


class TestVerdictTools(unittest.TestCase):
    def test_slip_matches_rules_for_same_pairs(self):
        pairs = t7_support.make_pairs(n=1200, sv=1)
        series = pairs[("TST", "GPS", 1)]
        for ep in series[600:]:
            ep.get("L1").adr_cycles += 5.0
        args = _slip_args(series)

        got = slip_detect_tool().invoke(args)
        s1, s2 = C.DEFAULT_PAIR["GPS"]
        expected, _diag = qc.detect_slips(
            series, "GPS", s1, s2, C.meas_cycle_sign("adr"), qc.QCConfig())

        self.assertTrue(got.ok, got.error)
        self.assertEqual(got.data["slip_indices"], sorted(expected))
        self.assertTrue(any(abs(600 - x) <= 2
                            for x in got.data["slip_indices"]))
        self.assertEqual(set(got.data),
                         {"n_epochs", "slip_indices", "counts", "sigma"})

    def test_slip_allows_explicit_missing_signal(self):
        pairs = t7_support.make_pairs(n=20, sv=1)
        args = _slip_args(pairs[("TST", "GPS", 1)])
        args["series"][3]["L2"] = None
        got = slip_detect_tool().invoke(args)
        self.assertTrue(got.ok, got.error)
        self.assertEqual(got.data["n_epochs"], 20)

    def test_slip_bad_shape_is_clear(self):
        pairs = t7_support.make_pairs(n=20, sv=1)
        args = _slip_args(pairs[("TST", "GPS", 1)])
        args["series"][2]["gps_tow_s"] = "late"
        got = slip_detect_tool().invoke(args)
        self.assertFalse(got.ok)
        self.assertIn("series[2].gps_tow_s", got.error or "")

    def test_slip_requires_time_order(self):
        pairs = t7_support.make_pairs(n=20, sv=1)
        args = _slip_args(pairs[("TST", "GPS", 1)])
        args["series"][2], args["series"][3] = (
            args["series"][3], args["series"][2])
        got = slip_detect_tool().invoke(args)
        self.assertFalse(got.ok)
        self.assertIn("严格递增", got.error or "")

    def test_continuity_matches_rules_for_same_inputs(self):
        tool = continuity_verdict_tool()
        got = tool.invoke({"algorithm": "ilr", "n_arcs": 2, "n_series": 1})
        self.assertTrue(got.ok)
        self.assertEqual(got.data, qc.phase_continuity_verdict("ilr", 2, 1))

    def test_continuity_passes_optional_guards_through(self):
        tool = continuity_verdict_tool()
        got = tool.invoke({"algorithm": "ilr", "n_arcs": 20, "n_series": 1,
                           "n_rows": 100, "rejected_short_arcs": 5,
                           "arc_ratio_guard": 10.0})
        self.assertEqual(
            got.data,
            qc.phase_continuity_verdict("ilr", 20, 1, rejected_short_arcs=5,
                                        n_rows=100, arc_ratio_guard=10.0))

    def test_magnitude_matches_rules_for_same_inputs(self):
        tool = magnitude_verdict_tool()
        got = tool.invoke({"rmse": 126922.1})
        self.assertTrue(got.ok)
        self.assertEqual(got.data, qc.physical_rmse_verdict(126922.1))
        self.assertTrue(got.data["rejected"])  # MTKA DOY006 的非物理 RMSE

    def test_magnitude_none_rmse_passes_through(self):
        tool = magnitude_verdict_tool()
        got = tool.invoke({"rmse": None})
        self.assertTrue(got.ok)
        self.assertEqual(got.data, qc.physical_rmse_verdict(None))
        self.assertFalse(got.data["rejected"])

    def test_custom_cap_is_forwarded(self):
        tool = magnitude_verdict_tool()
        got = tool.invoke({"rmse": 43.1, "cap_tecu": 40.0})
        self.assertEqual(got.data, qc.physical_rmse_verdict(43.1, cap_tecu=40.0))

    def test_bad_params_get_clear_errors(self):
        cases = [
            (continuity_verdict_tool(), {"algorithm": "", "n_arcs": 1,
                                         "n_series": 1}, "algorithm"),
            (continuity_verdict_tool(), {"algorithm": 7, "n_arcs": 1,
                                         "n_series": 1}, "algorithm"),
            (continuity_verdict_tool(), {"algorithm": "ilr", "n_arcs": "2",
                                         "n_series": 1}, "n_arcs"),
            (continuity_verdict_tool(), {"algorithm": "ilr", "n_arcs": None,
                                         "n_series": 1}, "n_arcs"),
            (continuity_verdict_tool(), {"algorithm": "ilr", "n_arcs": 1,
                                         "n_series": 0}, "n_series"),
            (continuity_verdict_tool(), {"algorithm": "ilr", "n_arcs": 1,
                                         "n_series": True}, "n_series"),
            (continuity_verdict_tool(), {"algorithm": "ilr", "n_arcs": 1,
                                         "n_series": 1,
                                         "arc_ratio_guard": "高"},
             "arc_ratio_guard"),
            (continuity_verdict_tool(), {"algorithm": "ilr", "n_arcs": 1,
                                         "n_series": 1, "n_rows": 1.5},
             "n_rows"),
            (magnitude_verdict_tool(), {"rmse": "过高"}, "rmse"),
            (magnitude_verdict_tool(), {"rmse": True}, "rmse"),
            (magnitude_verdict_tool(), {}, "缺少必需参数 rmse"),
            (magnitude_verdict_tool(), {"rmse": 1.0, "cap_tecu": "500"},
             "cap_tecu"),
        ]
        for tool, args, frag in cases:
            with self.subTest(tool=tool.name, args=args):
                result = tool.invoke(args)
                self.assertFalse(result.ok, args)
                self.assertIn(frag, result.error or "", args)


class TestAgentFromRepoConfig(unittest.TestCase):
    """in-repo 的 qc.json：装配出 qc agent 全程跑通一轮带工具调用的循环。"""

    def test_repo_config_loads_and_names_the_four_tools(self):
        cfg = load_agent_config(REPO_QC_CONFIG)
        self.assertEqual(cfg.name, "qc")
        self.assertEqual(set(cfg.tools),
                         {"robust_stats", "slip_detect", "continuity_verdict",
                          "magnitude_verdict"})
        self.assertEqual(cfg.provider, "ollama")
        self.assertIn("evidence", cfg.output_contract)

    def test_repo_config_tool_names_exist_in_registry(self):
        base = ToolRegistry()
        base.register(robust_stats_tool())
        base.register(slip_detect_tool())
        base.register(continuity_verdict_tool())
        base.register(magnitude_verdict_tool())
        agent, scoped = build(load_agent_config(REPO_QC_CONFIG),
                              FakeProvider(["答"]), base)
        self.assertEqual(scoped.names(),
                         ("continuity_verdict", "magnitude_verdict",
                          "robust_stats", "slip_detect"))
        self.assertEqual({t["name"] for t in agent.tools}, set(scoped.names()))

    def test_repo_config_runs_a_whitelisted_tool_round(self):
        provider = FakeProvider([
            ChatResponse(content="", tool_calls=[
                {"name": "magnitude_verdict", "args": {"rmse": 43.1}}]),
            "结论：RMSE 43.1 TECU，在物理量级内。",
        ])
        base = ToolRegistry()
        base.register(robust_stats_tool())
        base.register(slip_detect_tool())
        base.register(continuity_verdict_tool())
        base.register(magnitude_verdict_tool())
        agent, scoped = build(load_agent_config(REPO_QC_CONFIG),
                              provider, base)
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "t.jsonl"
            out = runtime.run(agent, "评估 RMSE=43.1", TraceWriter(path),
                              registry=scoped)
            events = read_trace(path)
        self.assertEqual(out, "结论：RMSE 43.1 TECU，在物理量级内。")
        ok_calls = [e for e in events
                    if e["kind"] == "tool_result" and e["ok"]]
        self.assertEqual(len(ok_calls), 1)
        self.assertIn("result_digest", ok_calls[0])

    def test_runtime_run_signature_unchanged(self):
        """装配物是 runtime.run 的普通调用方：三个必填参数一个没多。"""
        import inspect
        params = list(inspect.signature(runtime.run).parameters)
        self.assertEqual(params[:3], ["agent", "user_input", "trace"])


if __name__ == "__main__":
    unittest.main()
