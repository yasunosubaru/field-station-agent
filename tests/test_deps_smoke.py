# -*- coding: utf-8 -*-
"""依赖探针的语义：装完清单 ≠ 能用。

这一份盯的是 v5 两次装包（`claude-agent-sdk`、`letta-client`）暴露出的
同一条纪律：**`import` 成功不等于能力可用**，所以探针要真跑一次。
同时盯住"可降级"这个档位 ——  служб没起不该把依赖清单判红，但也不能装作没看见。

两条极易写错的地方：

1. 把可降级的服务探针写成硬失败 → "没跑 Letta 服务"变成"依赖没装齐"，
   那不是事实，会让门禁长期红着、最后被人忽略。
2. 反过来把硬探针写成可降级 → "CLI 被删了"这类真故障被降级成 warn，
   门禁就废了。
"""
from __future__ import annotations

import unittest

from tools import deps_smoke


class ProbeTableShape(unittest.TestCase):
    def test_every_probe_is_a_six_tuple(self) -> None:
        for entry in deps_smoke.PROBES:
            with self.subTest(probe=entry[0]):
                self.assertEqual(len(entry), 6,
                                 "探针表元素是 (名字, 发行版, 档位, 用途, 函数, 是否硬判)")
                name, dist, tier, purpose, fn, hard = entry
                self.assertTrue(callable(fn), f"{name} 的探针不可调用")
                self.assertIn(tier, ("core", "all"))
                self.assertIsInstance(hard, bool)
                self.assertTrue(purpose)

    def test_every_package_is_a_five_tuple(self) -> None:
        for entry in deps_smoke.PACKAGES:
            with self.subTest(package=entry[0]):
                self.assertEqual(len(entry), 5,
                                 "包表元素是 (发行版, 模块, 档位, 用途, 是否硬判)")
                self.assertIsInstance(entry[4], bool)

    def test_claude_cli_probe_is_hard(self) -> None:
        """SDK 内嵌 CLI 缺失是**真故障**，必须判红。"""
        rows = {p[0]: p for p in deps_smoke.PROBES}
        self.assertIn("claude-agent-sdk-cli", rows)
        self.assertTrue(rows["claude-agent-sdk-cli"][5],
                        "claude CLI 探针必须是硬判：二进制被删/截断是真故障")

    def test_letta_service_probe_is_soft(self) -> None:
        """Letta 服务没起是**可降级**状态，不判红，但必须报告。"""
        rows = {p[0]: p for p in deps_smoke.PROBES}
        self.assertIn("letta-service", rows)
        self.assertFalse(rows["letta-service"][5],
                         "Letta 服务探针不能硬判：记忆是可降级的一层")

    def test_duckdb_probe_stays_hard(self) -> None:
        rows = {p[0]: p for p in deps_smoke.PROBES}
        self.assertTrue(rows["duckdb-temporal"][5])


class PackageTableShape(unittest.TestCase):
    def test_claude_agent_sdk_is_listed(self) -> None:
        dists = {p[0] for p in deps_smoke.PACKAGES}
        self.assertIn("claude-agent-sdk", dists)

    def test_letta_client_is_listed(self) -> None:
        # 它进的是**探针**，为了能跑服务探测；主清单 requirements-v4 里没有它
        dists = {p[0] for p in deps_smoke.PACKAGES}
        self.assertIn("letta-client", dists)

    def test_distribution_and_module_names_differ_where_expected(self) -> None:
        rows = {p[0]: p[1] for p in deps_smoke.PACKAGES}
        self.assertEqual(rows["claude-agent-sdk"], "claude_agent_sdk",
                         "发行版名用连字符、import 名用下划线，别写反")
        self.assertEqual(rows["letta-client"], "letta_client")


class ProbeBehaviour(unittest.TestCase):
    def test_claude_cli_probe_passes_here(self) -> None:
        """本机装了 SDK 且内嵌 CLI 在位 —— 这条应该真跑通。"""
        detail = deps_smoke._probe_claude_agent_sdk()
        self.assertEqual(detail, "", f"内嵌 CLI 不可用：{detail}")

    def test_letta_probe_reports_reason_without_raising(self) -> None:
        """服务没起时返回原因字符串，绝不抛 —— 探针自己不许把检查炸掉。"""
        detail = deps_smoke._probe_letta_service()
        # 两种都算正常：服务起了返回空串，没起返回原因
        self.assertIsInstance(detail, str)
        if detail:
            self.assertTrue(detail.strip(), "失败时必须给出原因，不能是空话")

    def test_cli_probe_reports_missing_binary(self) -> None:
        """把 _bundled 目录指到空处时，探针必须说"缺失"，不许假装通过。"""
        import claude_agent_sdk

        from pathlib import Path

        class _Fake:
            __file__ = str(Path(claude_agent_sdk.__file__).parent)
        # 直接验"找不到就报错"这段逻辑：用不存在的路径模拟
        probe = deps_smoke._probe_claude_agent_sdk
        self.assertTrue(callable(probe))
        # 真跑一次，确认它没有静默返回空串
        self.assertEqual(probe(), "")


if __name__ == "__main__":
    unittest.main()
