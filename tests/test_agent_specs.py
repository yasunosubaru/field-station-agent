# -*- coding: utf-8 -*-
"""特化同源（智-4）：一份源 → 两份产物，且校验比的是「产物 vs 源」。

## 这份测试守什么

「特化只写一份源，生成两份产物，CI 校验同源」这句话，能被机器判定的定义只有一个：
**产物里记录的 `spec_sha256` 等于当前源文件的哈希。**

所以这里最重要的不是「能生成」，而是**能发现每一种真实损坏**。正例没有证明力，
下面每个 ``test_catches_*`` 都是先造坏、再断言红。

## 一条设计约束

所有造坏都在**临时副本**上做，绝不改仓库里的真文件。
测试跑完 ``agents/`` 与 ``config/agents/`` 必须逐字节不变。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for extra in (ROOT / "tools", ROOT / "src"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

import check_agent_specs as C  # noqa: E402
import gen_agent_specs as G  # noqa: E402


class TestSourceShape(unittest.TestCase):
    def test_spec_loads_and_validates(self):
        spec = G.load_spec()
        self.assertEqual(spec["name"], "fsa-ops")
        self.assertIn("opencode", [r["id"] for r in spec["runtimes"]])
        self.assertIn("claude", [r["id"] for r in spec["runtimes"]])

    def test_permission_is_per_tool_not_per_group(self):
        """错法三：权限粒度是「工具组」不是「每工具」。

        「读/写」两组会把 station_health（读、低风险）和 data_read（读、可能高风险）
        绑在一起。判据：permissions 的键必须是个体工具名，且覆盖全部 allow。
        """
        spec = G.load_spec()
        perms = spec["permissions"]
        allow = [str(t) for t in spec["tools"]["allow"]]
        for name in allow:
            with self.subTest(tool=name):
                self.assertIn(name, perms, f"{name} 没有单独的策略")
        # 键不能是分组的泛称
        self.assertNotIn("read", perms)
        self.assertNotIn("write", perms)

    def test_every_skill_file_exists(self):
        spec = G.load_spec()
        for item in spec["skills"]:
            with self.subTest(skill=item["id"]):
                self.assertTrue((ROOT / item["path"]).is_file(),
                                f"技能文件不存在：{item['path']}")

    def test_five_skills(self):
        self.assertEqual(len(G.load_spec()["skills"]), 5)


class TestProducts(unittest.TestCase):
    def test_products_record_spec_sha256(self):
        """错法一：产物里没写 spec_sha256，就无法判定同源。"""
        products = G.build_products()
        for key, text in products.items():
            with self.subTest(product=key):
                payload = json.loads(text)
                body = payload.get("agent", payload)
                self.assertIn("spec_sha256", body)
                self.assertEqual(len(body["spec_sha256"]), 64)

    def test_products_have_no_timestamp(self):
        """产物里不能有生成时间戳，否则每次生成都不同，--check 永远失败。"""
        import re
        products = G.build_products()
        for key, text in products.items():
            with self.subTest(product=key):
                self.assertIsNone(
                    re.search(r'"(generated_at|created_at|timestamp|ts)"', text),
                    "产物里出现了时间戳字段")

    def test_generation_is_deterministic(self):
        first = G.build_products()
        second = G.build_products()
        self.assertEqual(first, second)

    def test_shared_fields_identical_across_products(self):
        """两侧能力必须一致：共享字段逐字相同。"""
        products = G.build_products()
        a = json.loads(products["opencode"])["agent"]
        b = json.loads(products["claude"])
        for field in C.SHARED_FIELDS:
            with self.subTest(field=field):
                self.assertEqual(a[field], b[field],
                                 f"两侧在 {field} 上分叉")

    def test_repo_products_are_current(self):
        """仓库里已提交的产物必须与当前源一致。这是 CI 会跑的那条。"""
        problems, report = C.check()
        self.assertEqual(problems, [], "\n".join(problems))
        self.assertTrue(report["ok"])


class TestCatchesTampering(unittest.TestCase):
    """每一条都是「先造坏，再断言必须红」。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        # 只复制需要的文件，构造一个最小仓库
        (self.root / "agents" / "skills").mkdir(parents=True)
        (self.root / "config" / "agents").mkdir(parents=True)
        (self.root / "tools").mkdir()
        shutil.copy2(G.SPEC, self.root / "agents" / "fsa-ops.yaml")
        for item in G.load_spec()["skills"]:
            dst = self.root / item["path"]
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / item["path"], dst)
        for p in G.PRODUCTS.values():
            shutil.copy2(p, self.root / p.relative_to(ROOT))
        for mod in ("gen_agent_specs.py", "check_agent_specs.py"):
            shutil.copy2(ROOT / "tools" / mod, self.root / "tools" / mod)

    def _patch_module(self):
        """把两个模块的路径指到临时仓库（模块级常量都是 Path 对象）。"""
        self._saved = (G.ROOT, G.SPEC, dict(G.PRODUCTS))
        G.ROOT = self.root
        G.SPEC = self.root / "agents" / "fsa-ops.yaml"
        G.PRODUCTS = {"opencode": self.root / "agents" / "fsa-ops.opencode.json",
                      "claude": self.root / "config" / "agents" / "fsa-ops.json"}

    def _restore_module(self):
        G.ROOT, G.SPEC, G.PRODUCTS = self._saved

    def _check(self) -> list[str]:
        self._patch_module()
        try:
            problems, _ = C.check()
            return problems
        finally:
            self._restore_module()

    def test_baseline_is_clean(self):
        self.assertEqual(self._check(), [])

    def test_catches_source_changed_without_regen(self):
        """错法四：改了源不重新生成 -> 门禁必须红。"""
        spec = self.root / "agents" / "fsa-ops.yaml"
        spec.write_bytes(spec.read_bytes() + b"\n# tampered\n")
        problems = self._check()
        self.assertTrue(any("spec_sha256" in p for p in problems), problems)

    def test_compares_against_source_not_against_each_other(self):
        """错法二：校验脚本验「两份产物一样」而不是「都和源一样」。

        造法：让两份产物**一起**过期、且哈希彼此相同。
        只比产物的脚本会判通过；正确实现必须红。
        """
        spec = self.root / "agents" / "fsa-ops.yaml"
        spec.write_bytes(spec.read_bytes() + b"\n# tampered\n")
        for p in G.PRODUCTS.values():
            target = self.root / p.relative_to(ROOT)
            data = json.loads(target.read_text(encoding="utf-8"))
            body = data.get("agent", data)
            body["spec_sha256"] = "0" * 64
            target.write_text(json.dumps(data, ensure_ascii=False) + "\n",
                              encoding="utf-8")
        # 两份产物的 spec_sha256 现在完全相等
        a = json.loads((self.root / "agents" / "fsa-ops.opencode.json")
                       .read_text(encoding="utf-8"))["agent"]["spec_sha256"]
        b = json.loads((self.root / "config" / "agents" / "fsa-ops.json")
                       .read_text(encoding="utf-8"))["spec_sha256"]
        self.assertEqual(a, b, "构造前提：两份产物哈希相同")
        problems = self._check()
        self.assertTrue(problems, "两份一起过期却判通过 —— 校验是恒真的")

    def test_catches_hand_edited_product(self):
        """源没变、产物被手改：只比哈希会漏，必须比内容。"""
        target = self.root / "agents" / "fsa-ops.opencode.json"
        data = json.loads(target.read_text(encoding="utf-8"))
        data["agent"]["permissions"]["execute_device_action"] = "allowed"
        target.write_text(json.dumps(data, ensure_ascii=False) + "\n",
                          encoding="utf-8")
        problems = self._check()
        self.assertTrue(any("内容" in p for p in problems), problems)

    def test_catches_shared_field_drift(self):
        target = self.root / "config" / "agents" / "fsa-ops.json"
        data = json.loads(target.read_text(encoding="utf-8"))
        data["rules"] = data["rules"][:-1]
        target.write_text(json.dumps(data, ensure_ascii=False) + "\n",
                          encoding="utf-8")
        problems = self._check()
        self.assertTrue(problems)

    def test_missing_product_is_reported(self):
        (self.root / "config" / "agents" / "fsa-ops.json").unlink()
        problems = self._check()
        self.assertTrue(any("缺失" in p for p in problems), problems)


class TestSourceValidation(unittest.TestCase):
    """源本身写错时，生成器必须拒绝，不许生成半对的产物。"""

    def test_rejects_undeclared_permission(self):
        """allow 里的工具没有策略 = 没声明，不能默认放行。"""
        text = G.SPEC.read_text(encoding="utf-8")
        mutated = text.replace("  station_health: allowed\n", "", 1)
        self.assertNotEqual(text, mutated)
        tmp = Path(tempfile.mkdtemp()) / "spec.yaml"
        tmp.write_text(mutated, encoding="utf-8")
        with self.assertRaises(G.SpecError) as ctx:
            G.load_spec(tmp)
        self.assertIn("station_health", str(ctx.exception))

    def test_rejects_bad_permission_value(self):
        text = G.SPEC.read_text(encoding="utf-8")
        tmp = Path(tempfile.mkdtemp()) / "spec.yaml"
        tmp.write_text(text.replace("station_health: allowed",
                                    "station_health: allow", 1), encoding="utf-8")
        with self.assertRaises(G.SpecError):
            G.load_spec(tmp)

    def test_rejects_allow_deny_overlap(self):
        text = G.SPEC.read_text(encoding="utf-8")
        tmp = Path(tempfile.mkdtemp()) / "spec.yaml"
        tmp.write_text(text.replace("  deny:\n    - execute_device_action",
                                    "  deny:\n    - station_health", 1),
                       encoding="utf-8")
        with self.assertRaises(G.SpecError):
            G.load_spec(tmp)


class TestCli(unittest.TestCase):
    def test_check_mode_passes_on_repo(self):
        self.assertEqual(C.main([]), 0)

    def test_spec_sha_is_file_hash_not_content_guess(self):
        expected = hashlib.sha256(G.SPEC.read_bytes()).hexdigest()
        self.assertEqual(G.spec_sha256(), expected)


class TestNoSkipDiscipline(unittest.TestCase):
    def test_no_skip_invocations(self):
        p = "skip"
        tokens = (p + "Test(", "." + p + "(", p + "Unless(", p + "If(")
        src = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual([t for t in tokens if t in src], [])


if __name__ == "__main__":
    unittest.main()
