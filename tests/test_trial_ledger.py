"""试运行台账（M6-1 骨架，issue #97）与「规范化摘要」的行为。

钉住四件事：

* **规范化摘要**只忽略逐次变化的字段（``generationtime_ms``），数据一变摘要就变 ——
  否则活取数的校验就是摆设（实测：Open-Meteo 响应每次差 1 字节）。
* **失败分类**固定六类，映射明确。
* **一行台账**的字段齐全，**汇总**的计数与分类分布算得对。
* 入库台账与入库汇总**互相对得上**（台账是记录，汇总是它的读法）。
"""
from __future__ import annotations

import importlib.util
import json
import socket
import tempfile
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "logs" / "trial_ledger_20261021.jsonl"
SUMMARY = ROOT / "logs" / "trial_ledger_summary_20261021.json"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_FETCH = _load("fetch_public_data", ROOT / "tools" / "fetch_public_data.py")
_LEDGER = _load("trial_ledger", ROOT / "tools" / "trial_ledger.py")


class TestNormalizedDigest(unittest.TestCase):
    def test_volatile_field_ignored_but_content_change_not(self):
        first = json.dumps({"hourly": {"time": ["t"]}, "generationtime_ms": 1.5},
                           ensure_ascii=False).encode("utf-8")
        second = json.dumps({"hourly": {"time": ["t"]}, "generationtime_ms": 9.9},
                            ensure_ascii=False).encode("utf-8")
        third = json.dumps({"hourly": {"time": ["u"]}, "generationtime_ms": 1.5},
                           ensure_ascii=False).encode("utf-8")
        self.assertEqual(_FETCH.normalized_digest(first),
                         _FETCH.normalized_digest(second))
        self.assertNotEqual(_FETCH.normalized_digest(first),
                            _FETCH.normalized_digest(third))

    def test_non_json_payload_hashed_as_bytes(self):
        payload = b"not json at all"
        import hashlib
        self.assertEqual(_FETCH.normalized_digest(payload),
                         hashlib.sha256(payload).hexdigest())


class TestClassification(unittest.TestCase):
    def test_exception_mapping(self):
        self.assertEqual(_LEDGER.classify(socket.timeout()), "超时")
        self.assertEqual(_LEDGER.classify(TimeoutError()), "超时")
        self.assertEqual(
            _LEDGER.classify(urllib.error.URLError("boom")), "连接失败")
        self.assertEqual(_LEDGER.classify(ConnectionResetError()), "连接失败")
        self.assertEqual(_LEDGER.classify(ValueError("x")), "未知")

    def test_payload_checks(self):
        self.assertIsNone(_LEDGER.check_payload(b'{"a": 1}'))
        self.assertEqual(_LEDGER.check_payload(b'{"a": 1}',
                                              require_fields=("hourly",)),
                         "字段缺失")
        self.assertEqual(_LEDGER.check_payload(b"plain text"), "格式不支持")

    def test_failure_classes_are_fixed(self):
        self.assertEqual(len(_LEDGER.FAILURE_CLASSES), 6)
        self.assertIn("校验不符", _LEDGER.FAILURE_CLASSES)


class TestLedger(unittest.TestCase):
    def test_missing_local_file_is_connection_failure(self):
        row = _LEDGER.attempt("probe:missing", "file:///nonexistent/x.json",
                              run_id="test", ts="2026-10-21T00:00:00+00:00")
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["failure_class"], "连接失败")
        for key in ("ts", "run_id", "source_id", "url", "status",
                    "failure_class", "bytes", "sha256", "n_records",
                    "duration_ms", "notes"):
            self.assertIn(key, row)

    def test_rows_append_and_summarize(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ledger.jsonl"
            rows = [
                {"ts": "2026-10-21T00:00:00+00:00", "run_id": "r",
                 "source_id": "a", "url": "u", "status": "ok",
                 "failure_class": None, "bytes": 10, "sha256": "x",
                 "n_records": 1, "duration_ms": 1.0, "notes": ""},
                {"ts": "2026-10-21T00:01:00+00:00", "run_id": "r",
                 "source_id": "b", "url": "u", "status": "failed",
                 "failure_class": "超时", "bytes": None, "sha256": None,
                 "n_records": None, "duration_ms": 2.0, "notes": ""},
            ]
            _LEDGER.append_rows(path, rows)
            read = _LEDGER.read_rows(path)
            self.assertEqual(len(read), 2)
            summary = _LEDGER.summarize(read)
            self.assertEqual(summary["rows"], 2)
            self.assertEqual(summary["by_status"], {"ok": 1, "failed": 1})
            self.assertEqual(summary["by_failure_class"], {"超时": 1})
            self.assertEqual(summary["success_rate"], 0.5)
            self.assertEqual(summary["distinct_sources"], 2)

    def test_committed_ledger_and_summary_agree(self):
        rows = _LEDGER.read_rows(LEDGER)
        self.assertTrue(rows, "入库台账是空的")
        for row in rows:
            for key in ("ts", "run_id", "source_id", "url", "status",
                        "failure_class", "bytes", "sha256", "n_records",
                        "duration_ms", "notes"):
                self.assertIn(key, row)
            self.assertIn(row["status"], ("ok", "failed"))
            if row["status"] == "failed":
                self.assertIn(row["failure_class"], _LEDGER.FAILURE_CLASSES)
        committed = json.loads(SUMMARY.read_text(encoding="utf-8"))
        self.assertEqual(committed, _LEDGER.summarize(rows))


if __name__ == "__main__":
    unittest.main()
