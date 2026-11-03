#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""yaml_lite：只认一个子集，认不出就报错。

为什么值得单独测：工作流规格是**数据**，解析器是唯一入口。它静默吞掉一行，
就等于静默改掉一条流程的行为。这里逐条钉住「支持什么」与「拒绝什么」。
"""
from __future__ import annotations

import unittest

from fieldstation.workflows import yaml_lite


class SupportedSyntax(unittest.TestCase):
    def test_mapping_and_scalars(self):
        data = yaml_lite.loads(
            "id: a.b\nversion: 3\nratio: 0.5\nflag: true\nnone: ~\n"
            "negative: -2\ntext: plain string\n")
        self.assertEqual(data, {
            "id": "a.b", "version": 3, "ratio": 0.5, "flag": True,
            "none": None, "negative": -2, "text": "plain string",
        })

    def test_nested_mapping_and_sequence(self):
        data = yaml_lite.loads(
            "steps:\n"
            "  - id: one\n"
            "    kind: http\n"
            "    expect:\n"
            "      json:\n"
            "        ok: true\n"
            "  - id: two\n"
            "    kind: sleep\n")
        self.assertEqual(data["steps"][0]["id"], "one")
        self.assertTrue(data["steps"][0]["expect"]["json"]["ok"])
        self.assertEqual([s["id"] for s in data["steps"]], ["one", "two"])

    def test_sequence_at_same_indent_as_key(self):
        data = yaml_lite.loads("tags:\n- a\n- b\n")
        self.assertEqual(data["tags"], ["a", "b"])

    def test_inline_sequence(self):
        data = yaml_lite.loads('list: [a, "b,c", 3]\n')
        self.assertEqual(data["list"], ["a", "b,c", 3])

    def test_quoted_string_keeps_hash_and_colon(self):
        data = yaml_lite.loads('title: "restart # not a comment: really"\n')
        self.assertEqual(data["title"], "restart # not a comment: really")

    def test_comment_after_value(self):
        data = yaml_lite.loads("a: 1   # trailing\n# whole line\nb: 2\n")
        self.assertEqual(data, {"a": 1, "b": 2})

    def test_block_scalar_keeps_newlines(self):
        data = yaml_lite.loads("prose: |\n  first\n  second\n")
        self.assertEqual(data["prose"], "first\nsecond\n")

    def test_folded_scalar_joins_lines(self):
        data = yaml_lite.loads("prose: >\n  alpha\n  beta\n")
        self.assertEqual(data["prose"], "alpha beta\n")

    def test_apostrophe_is_not_a_quote(self):
        """一句英文里的撇号不能把整行判成「引号没闭合」。"""
        data = yaml_lite.loads("note: don't stop\nother: 1\n")
        self.assertEqual(data, {"note": "don't stop", "other": 1})

    def test_single_quote_escape(self):
        data = yaml_lite.loads("note: 'it''s here'\n")
        self.assertEqual(data["note"], "it's here")

    def test_quoted_key(self):
        data = yaml_lite.loads('"quoted key": 1\n')
        self.assertEqual(data["quoted key"], 1)

    def test_utf8_bom_tolerated_on_load(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.yaml"
            path.write_text("id: a.b\n", encoding="utf-8-sig")
            self.assertEqual(yaml_lite.load(path), {"id": "a.b"})


class RejectedSyntax(unittest.TestCase):
    def _err(self, text: str) -> yaml_lite.YamlError:
        with self.assertRaises(yaml_lite.YamlError) as ctx:
            yaml_lite.loads(text)
        return ctx.exception

    def test_tab_indent_rejected(self):
        exc = self._err("a:\n\t- x\n")
        self.assertIn("制表符", str(exc))
        self.assertEqual(exc.line, 2)

    def test_duplicate_key_rejected(self):
        exc = self._err("a: 1\na: 2\n")
        self.assertIn("重复键", str(exc))

    def test_inline_mapping_rejected(self):
        """行内映射不支持——支持了就等于承诺一套没人测的解析规则。"""
        exc = self._err("a: {b: 1}\n")
        self.assertIn("行内映射", str(exc))

    def test_second_document_rejected(self):
        exc = self._err("---\na: 1\n---\nb: 2\n")
        self.assertIn("单文档", str(exc))

    def test_unclosed_quote_rejected_with_line(self):
        exc = self._err('a: "open\n')
        self.assertEqual(exc.line, 1)

    def test_bad_indent_reports_line(self):
        exc = self._err("a:\n  b: 1\n c: 2\n")
        self.assertIsNotNone(exc.line)

    def test_empty_document_is_none(self):
        self.assertIsNone(yaml_lite.loads("# nothing\n\n"))


if __name__ == "__main__":
    unittest.main()
