# -*- coding: utf-8 -*-
"""`field_width_for` 的回归测试。

背景（issue #14 / KI-10）：环境变量 `GNSS_TEC_FIELD_WIDTH` 里如果出现
**空值项**（形如 `KEY=`，运维手写配置时极易出这种半截写法），函数会
在 `registry.py` 直接抛未捕获的 `ValueError: int('')`，整个数据接入链崩掉。

这里只钉住**这一条崩溃**及其修法。更广的枚举/优先级覆盖另有安排。
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from fieldstation.ingest import registry

ENV_KEY = "GNSS_TEC_FIELD_WIDTH"


class TestFieldWidthEmptyEnvValue(unittest.TestCase):
    """env 里带空值项 / 无等号 / 多余分隔符：一律不能崩。"""

    def setUp(self):
        self._orig = os.environ.get(ENV_KEY)
        self._p = mock.patch.dict(os.environ)
        self._p.start()

    def tearDown(self):
        self._p.stop()
        if self._orig is None:
            os.environ.pop(ENV_KEY, None)
        else:
            os.environ[ENV_KEY] = self._orig

    def test_empty_value_item_is_skipped_not_crash(self):
        """`DAEJ=` —— 键在、值为空。修复前抛 ValueError: invalid literal for int()。"""
        os.environ[ENV_KEY] = "DAEJ="
        try:
            w = registry.field_width_for("DAEJ")
        except ValueError:
            self.fail("空值环境变量项不应抛 ValueError（应跳过该条继续查）")
        # 空值项本身不提供宽度 -> 落到登记表；DAEJ 在登记表里是 16
        self.assertEqual(w, 16)

    def test_empty_value_item_does_not_shadow_later_valid_item(self):
        """同一 env 里空值项之后的合法项仍须生效。"""
        os.environ[ENV_KEY] = "HKWS=;HKWS=15"
        self.assertEqual(registry.field_width_for("HKWS"), 15)

    def test_dirty_separators_and_junk_items_are_tolerated(self):
        os.environ[ENV_KEY] = "garbage;;HKWS=15,,DAEJ="
        self.assertEqual(registry.field_width_for("HKWS"), 15)
        self.assertEqual(registry.field_width_for("DAEJ"), 16)

    def test_all_items_invalid_falls_through_to_registry(self):
        os.environ[ENV_KEY] = "=;garbage;DAEJ="
        self.assertEqual(registry.field_width_for("HKWS"), 15)

    def test_empty_env_string_is_fine(self):
        os.environ[ENV_KEY] = ""
        self.assertEqual(registry.field_width_for("HKWS"), 15)


if __name__ == "__main__":
    unittest.main()