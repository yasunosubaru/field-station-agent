"""`tools/deps_smoke.py` 的运行期探针：import 成功 ≠ 能用。

## 为什么这个测试值得存在

`deps_smoke` 原来的判据是 `importlib.import_module()`。对 **duckdb 缺 pytz**
这种情况它完全失效：

```
duckdb    2.0.0    ok     E4/E5 数据查询     ← 显示 ok，实际是坏的
```

因为 `import duckdb` 完全成功，只有真去把 `TIMESTAMP WITH TIME ZONE` 转成
Python datetime 时才炸。于是"装完清单、门禁全绿、deps_smoke 全绿"三重验证都过了，
而 DuckDB 实际上不可用 —— 这正是本仓库一直在防的"所有检查都说好、能力却缺失"。

## 为什么"缺 pytz"那条必须跑在子进程里

duckdb 是 C 扩展：**从 `sys.modules` 里删掉它并不会卸载已加载的 .pyd**。
所以进程内遮蔽 pytz 之后，duckdb 的 C 层已经带着"时间类型不可用"的内部状态，
后面所有用例都会莫名其妙拿到 `RuntimeError: bad cast` —— 实测踩过，
连正常的"装了 pytz 应 ok"那条也会红。

把这条放进子进程：子进程是干净的，遮蔽只影响它自己，父进程完全不受污染。
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_smoke():
    """按路径加载 tools/deps_smoke.py（tools/ 不在 sys.path 上）。"""
    path = ROOT / "tools" / "deps_smoke.py"
    spec = importlib.util.spec_from_file_location("deps_smoke_under_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ProbeContract(unittest.TestCase):
    """探针本身的契约：有登记、有档位、有用途、不抛异常。"""

    @classmethod
    def setUpClass(cls):
        cls.smoke = _load_smoke()

    def test_probes_are_registered_with_tier_and_purpose(self):
        self.assertTrue(self.smoke.PROBES, "PROBES 不能为空，否则这层检查形同不存在")
        for name, dist, tier, purpose, fn in self.smoke.PROBES:
            self.assertIsInstance(name, str)
            self.assertTrue(name.strip())
            self.assertIn(tier, self.smoke.TIERS, f"{name} 的档位 {tier!r} 不认识")
            self.assertTrue(purpose.strip(), f"{name} 没写用途")
            self.assertTrue(callable(fn), f"{name} 的探针不是可调用对象")

    def test_duckdb_temporal_probe_is_registered(self):
        """这一条防的是"有人把探针删了而没人发现"。"""
        names = {p[0] for p in self.smoke.PROBES}
        self.assertIn("duckdb-temporal", names)

    def test_probe_returns_string_and_never_raises(self):
        """约定：成功返回空串，失败返回非空原因；**不许抛**。

        探针自己崩掉等于把"缺哪个"这条信息也一起吞了。
        """
        detail = self.smoke._probe_duckdb_temporal()
        self.assertIsInstance(detail, str)

    def test_duckdb_probe_is_in_core_tier(self):
        """duckdb 是 core 包，它的探针也必须进 core 档。

        否则 CI 上 `--tier core` 会漏掉这个缺口 —— 那正是最该拦的场景。
        """
        tiers = {p[0]: p[2] for p in self.smoke.PROBES}
        self.assertEqual(tiers.get("duckdb-temporal"), "core")


class DuckdbTemporalProbe(unittest.TestCase):
    """真环境下的行为：本机已装 pytz，所以应 ok。"""

    def test_reports_ok_when_pytz_present(self):
        """装了 pytz 就必须 ok —— 否则探针是"永远红"，同样没用。"""
        try:
            import pytz  # noqa: F401
        except ImportError:
            self.skipTest("本机没装 pytz，这条断言不适用")
        smoke = _load_smoke()
        detail = smoke._probe_duckdb_temporal()
        self.assertEqual(detail, "", f"装了 pytz 却仍报失败：{detail}")


#: 子进程脚本：遮蔽 pytz → 跑探针 → 把结果打到 stdout。
#: 遮蔽用的是 meta_path finder，比"塞一个空 module"更接近"根本没装"。
_BLOCKED_SCRIPT = textwrap.dedent("""
    import importlib.util
    import sys
    from pathlib import Path

    root = Path(sys.argv[1])
    smoke_path = root / "tools" / "deps_smoke.py"

    class _Finders:
        def find_spec(self, name, path=None, target=None):
            if name == "pytz":
                raise ImportError("No module named 'pytz'")
            return None

    # 先清掉已加载的 pytz 与 duckdb，再装拦截器
    for key in [k for k in sys.modules if k == "pytz" or k == "duckdb"
                or k.startswith("duckdb.")]:
        del sys.modules[key]
    sys.meta_path.insert(0, _Finders())

    spec = importlib.util.spec_from_file_location("deps_smoke_blocked", smoke_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    detail = module._probe_duckdb_temporal()
    print("PROBE_DETAIL_START")
    print(detail)
    print("PROBE_DETAIL_END")
    # 非 0 = 探针报了问题。这条退出码让上层（测试/CI）能直接判，不必解析文本。
    sys.exit(3 if detail else 0)
""")


class DuckdbTemporalProbeWithoutPytz(unittest.TestCase):
    """缺 pytz 时探针必须变红 —— 这是本文件的灵魂。

    跑在**子进程**里，理由见模块 docstring：duckdb 的 C 扩展没法在进程内卸载，
    遮蔽 pytz 会毒化整个解释器。
    """

    def test_probe_fails_and_names_pytz(self):
        env = dict(**__import__("os").environ)
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, "-c", _BLOCKED_SCRIPT, str(ROOT)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=180, env=env, cwd=str(ROOT),
        )
        out = proc.stdout or ""
        self.assertIn("PROBE_DETAIL_START", out,
                      f"子进程没跑到打印步骤。stdout={out[-800:]} stderr={(proc.stderr or '')[-800:]}")

        detail = out.split("PROBE_DETAIL_START", 1)[1].split("PROBE_DETAIL_END", 1)[0].strip()

        self.assertNotEqual(detail, "",
                            "缺 pytz 时探针仍报 ok —— 它是装饰，不是检查")
        self.assertNotEqual(proc.returncode, 0,
                            f"探针报了失败但子进程退出码仍是 0（退出码没跟随）：{detail}")
        lowered = detail.lower()
        self.assertTrue(
            "pytz" in lowered or "缺" in detail,
            f"失败消息必须点名 pytz，否则看的人不知道该装什么：{detail}")

    def test_exit_code_is_nonzero_through_cli(self):
        """端到端：缺 pytz 时 `deps_smoke.py` 的 CLI 退出码必须非 0。

        上一条测的是探针函数；这条测"调用方会不会漏看"——
        一个报失败却返回 0 的检查，在 CI 上等于不存在。
        """
        script = textwrap.dedent("""
            import subprocess
            import sys
            from pathlib import Path

            root = Path(sys.argv[1])

            class _Finders:
                def find_spec(self, name, path=None, target=None):
                    if name == "pytz":
                        raise ImportError("No module named 'pytz'")
                    return None

            for key in [k for k in sys.modules if k == "pytz" or k == "duckdb"
                        or k.startswith("duckdb.")]:
                del sys.modules[key]
            sys.meta_path.insert(0, _Finders())

            # 用 -c 再起一层也不行（新进程会重新导入 pytz），
            # 所以这里直接把 main() 拉进来在同一进程里跑。
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "deps_smoke_cli", root / "tools" / "deps_smoke.py")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            sys.exit(mod.main(["--tier", "core"]))
        """)
        env = dict(**__import__("os").environ)
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, "-c", script, str(ROOT)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=180, env=env, cwd=str(ROOT),
        )
        self.assertNotEqual(
            proc.returncode, 0,
            "缺 pytz 时 deps_smoke 的 CLI 仍返回 0 —— 这种检查在 CI 上等于不存在。"
            f"stdout={(proc.stdout or '')[-600:]}")


if __name__ == "__main__":
    unittest.main()
