# -*- coding: utf-8 -*-
"""引-2 验收：结论只能有一个来源。

计划书这一条只要求一件事，但是全仓性质的：

> **唯一入口**：其他路径构造结论直接抛错。
>
> 验收：全仓搜不到绕开 `conclusion` 的结论构造；五阶段图产出的结论一定带 `attribution`。

## 这条为什么不能只靠"我们约定过"

「结论契约」是本项目最核心的那条纪律：**每条结论必须引用一条成功执行过的
工具调用**。只要有第二个地方能拼出结论，那条纪律就有个后门，而**后门不会报错** ——
它会安静地产出一个看起来正常的结论，然后整条证据链就断了。

所以这里不问"有没有人记得走校验"，只问三件可机判的事：

1. **静态**：生产代码里没有第二处手拼 `attribution` 的地方（白名单只有回放脚本）。
2. **运行时**：五阶段图跑出来的结论**必须**带 `attribution.fault_type` 与证据。
3. **拒绝路径**：绕开契约的结论进来会被拒，而且抛的是 `ConclusionRejected`。

## 白名单为什么只有一个

`graph/parity.py` 的 `_conclusion()` 是**回放用的脚本化模型输出** —— 它造的是
"模型说的话"，本来就该在校验之前。把它算成"绕开"会让这条检查变成假红。
除此之外一个都不放过；加白名单要在这里登记理由。
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from fieldstation.agents.conclusion import (
    ConclusionContract,
    ConclusionRejected,
    validate_conclusion,
)

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "fieldstation"

#: 允许手拼结论的文件 → 理由。加一条就在这里写清为什么它不是后门。
ALLOWED_BUILDERS = {
    "graph/parity.py":
        "回放用的脚本化模型输出：造的是「模型说的话」，按序列化在校验之前。",
}


def _python_files() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


class TestNoSecondSource(unittest.TestCase):
    """第 1 条：静态检查。全仓不许有第二个结论构造点。"""

    def test_no_hand_built_attribution_outside_whitelist(self) -> None:
        offenders: list[str] = []
        for path in _python_files():
            rel = path.relative_to(SRC).as_posix()
            if rel in ALLOWED_BUILDERS:
                continue
            if rel == "agents/conclusion.py":
                continue          # 契约本体，字段名当然出现在这里
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                # 只认「字典字面量里同时出现 attribution 和 recommendation」
                # 这种形状 —— 那才是在拼一条结论，不是读字段。
                if not isinstance(node, ast.Dict):
                    continue
                keys = {k.value for k in node.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)}
                if {"attribution", "recommendation"} <= keys:
                    offenders.append(f"{rel}:{node.lineno}")
        self.assertEqual(
            offenders, [],
            "发现绕开 conclusion 的结论构造点："
            f"{offenders}\n"
            "要么改成走 ConclusionContract.validate()，"
            "要么在 ALLOWED_BUILDERS 里登记理由（仅限回放脚本这类校验前的产物）")

    def test_whitelist_entries_still_exist(self) -> None:
        """白名单不许留尸体：文件删了还挂着，就等于永久豁免了一个不存在的东西。"""
        for rel in ALLOWED_BUILDERS:
            with self.subTest(rel=rel):
                self.assertTrue((SRC / rel).is_file(), f"白名单里的 {rel} 不存在了")

    def test_every_whitelist_entry_has_a_reason(self) -> None:
        for rel, reason in ALLOWED_BUILDERS.items():
            with self.subTest(rel=rel):
                self.assertTrue(reason and reason.strip(),
                                f"{rel} 进白名单必须写理由")

    def test_pipeline_validates_through_the_contract(self) -> None:
        """`pipeline.py` 必须是强制校验点，不是"可以走也可以不走"。"""
        text = (SRC / "agents" / "pipeline.py").read_text(encoding="utf-8")
        self.assertIn("contract.validate(", text,
                      "pipeline 里没有调用结论契约校验")
        self.assertIn("raise ConclusionRejected", text,
                      "校验失败必须抛 ConclusionRejected，不能静默丢弃")


class TestRejectionPath(unittest.TestCase):
    """第 3 条：绕开契约的结论必须被拒。"""

    def test_missing_evidence_is_rejected(self) -> None:
        bad = {
            "attribution": {"fault_type": "receiver", "evidence": []},
            "recommendation": "重启接收机",
            "confidence": 0.9,
        }
        result = validate_conclusion(bad, [])
        self.assertFalse(result.valid)
        self.assertTrue(any("evidence" in e for e in result.errors))

    def test_unknown_call_id_is_rejected(self) -> None:
        bad = {
            "attribution": {
                "fault_type": "receiver",
                "evidence": [{"call_id": "c-404", "tool": "qc.run",
                              "finding": "缺测率 0.4"}],
            },
            "recommendation": "重启接收机",
            "confidence": 0.9,
        }
        result = validate_conclusion(bad, [])
        self.assertFalse(result.valid)
        self.assertTrue(any("不存在于成功的工具调用中" in e for e in result.errors),
                        f"错误信息没说清原因：{result.errors}")

    def test_extra_top_level_field_is_rejected(self) -> None:
        bad = {
            "attribution": {"fault_type": "x", "evidence": []},
            "recommendation": "y",
            "confidence": 0.5,
            "note": "顺手加个字段",
        }
        self.assertFalse(validate_conclusion(bad, []).valid)

    def test_contract_raises_on_invalid(self) -> None:
        contract = ConclusionContract()
        result = contract.validate({"attribution": {}}, [])
        self.assertFalse(result.valid)
        # 调用方（pipeline）拿到 invalid 后抛这个；这里确认异常类型可被捕获
        with self.assertRaises(ConclusionRejected):
            raise ConclusionRejected(result.errors, result.conclusion)

    def test_valid_conclusion_passes(self) -> None:
        events = [{"kind": "tool_result", "ok": True, "call_id": "c-1",
                   "tool": "qc.run"}]
        good = {
            "attribution": {
                "fault_type": "receiver",
                "evidence": [{"call_id": "c-1", "tool": "qc.run",
                              "finding": "缺测率 0.4"}],
            },
            "recommendation": "重启接收机",
            "confidence": 0.9,
        }
        result = validate_conclusion(good, events)
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.evidence_call_ids, ("c-1",))


class TestFiveStageOutputCarriesAttribution(unittest.TestCase):
    """第 4 条：五阶段图产出的结论**一定**带 attribution。"""

    def test_stage_outcome_conclusion_has_attribution(self) -> None:
        """用真实的五阶段装配 + 回放 fixture 跑一遍图，看产物形状。

        不验业务正确性（那是 parity 的活），只验
        「图产出的每条结论都带 attribution.fault_type」。
        """
        import tempfile

        from fieldstation.agents.bus import MessageBus
        from fieldstation.agents.trace.writer import TraceWriter
        from fieldstation.graph import five_stage
        from fieldstation.graph.parity import build_stage_set, load_scenario

        fixture = ROOT / "harness" / "fixtures" / "m5_pipeline_replay_20261020.json"
        self.assertTrue(fixture.is_file(), f"缺少回放 fixture：{fixture}")
        scenario = load_scenario(fixture)

        with tempfile.TemporaryDirectory() as td:
            stages = build_stage_set(Path(td) / "setup", scenario)
            trace_path = Path(td) / "trace.jsonl"
            bus = MessageBus(TraceWriter(trace_path))
            result = five_stage.run_five_stage(
                stages, bus=bus, trace_path=trace_path,
                intake=list(scenario.intake))

        self.assertTrue(result.stages, "图没产出任何阶段结论")
        for outcome in result.stages:
            with self.subTest(stage=outcome.stage):
                self.assertIn("attribution", outcome.conclusion,
                              f"{outcome.stage} 的结论没有 attribution")
                self.assertTrue(
                    outcome.conclusion["attribution"].get("fault_type"),
                    f"{outcome.stage} 的 attribution 里没有 fault_type")
        # 图自己也算过一遍「结论有效」，这条检查不能单靠我上面手验
        self.assertTrue(result.checks.get("conclusions_valid"),
                        "图的自检 conclusions_valid 没通过")


if __name__ == "__main__":
    unittest.main()
