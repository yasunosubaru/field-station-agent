#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``tools/agent_server.py`` 的三组新出口：``/board/*``、``/data/*``、``/suite/*``。

为什么这层要单独测：三个前端视角（``web/views/fleet.js`` / ``data.js`` /
``suite.js``）各自写死了要读的键名，而这三组出口就是按那些键名填的。键名写错
**不会**让端点报错 —— 它会 200 返回一个前端读不懂的对象，然后界面显示「还没接上」。
那种坏法只在浏览器里看得出来，所以这里逐条断言形状。

边界：
* 业务逻辑不在这里测（``tests/test_botd_interaction.py`` / ``test_data_knowledge.py``
  已经测过）；这里只测「HTTP 层有没有把那一层正确摊开」。
* 数据都写到 ``tempfile`` 里：库、批次、评测日志全部临时，不碰仓库。
"""
from __future__ import annotations

import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "src"))

import agent_server  # noqa: E402
from fieldstation.botd.store import BotStore  # noqa: E402
from fieldstation.data.writer import NdjsonWriter  # noqa: E402

TOKEN = "surface-token-7c2e41"


class SurfaceCase(unittest.TestCase):
    """每个用例一份独立临时目录；库 / 批次 / 评测根都由环境变量指过去。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.db = self.base / "botd.sqlite3"
        self.warehouse = self.base / "warehouse"
        self.eval_root = self.base / "eval"

        # 备份再改环境：如果这里改坏了，其它测试不该跟着倒。
        self._env_backup = {key: os.environ.get(key) for key in
                            ("FSA_BOTD_DB", "FSA_DATA_ROOT", "FSA_EVAL_ROOT")}
        os.environ["FSA_BOTD_DB"] = str(self.db)
        os.environ["FSA_DATA_ROOT"] = str(self.warehouse)
        os.environ["FSA_EVAL_ROOT"] = str(self.eval_root)

        self.server = agent_server.make_server(
            port=0, token=TOKEN, node_url="http://127.0.0.1:1",
            repo_root=str(ROOT), data_dir=str(self.base / "agentdata"))
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
            daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()

    # ---- HTTP ---------------------------------------------------------

    def request(self, method: str, path: str, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            headers = {"Content-Type": "application/json",
                       "Authorization": f"Bearer {TOKEN}"}
            payload = None if body is None else json.dumps(body).encode("utf-8")
            conn.request(method, path, body=payload, headers=headers)
            response = conn.getresponse()
            raw = response.read()
            content_type = response.getheader("Content-Type") or ""
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                parsed = None
            return response.status, parsed, raw, content_type
        finally:
            conn.close()

    def json_request(self, method: str, path: str, body=None):
        status, parsed, _, _ = self.request(method, path, body)
        self.assertIsInstance(parsed, dict, f"{method} {path} 返回的不是 JSON 对象")
        return status, parsed

    # ---- 造数 ---------------------------------------------------------

    def make_board(self) -> str:
        """一个三态任务（done / running / skipped）+ 一条 pending 干预。"""
        store = BotStore(self.db)
        task = store.create_task(kind="patrol", title="WUHN 巡检", status="running")
        done = store.create_step(task_id=task["task_id"], idx=0, name="取数", kind="fetch")
        store.update_step(done["id"], status="done")
        running = store.create_step(task_id=task["task_id"], idx=1, name="质控", kind="qc")
        store.update_step(running["id"], status="running")
        skipped = store.create_step(task_id=task["task_id"], idx=2, name="归档", kind="archive")
        store.update_step(skipped["id"], status="skipped")
        store.add_intervention(kind="pause", task_id=task["task_id"], prompt="先停下")
        return task["task_id"]

    def make_warehouse(self) -> None:
        """两个小时分区；含一行 CN0 缺测、一行低于 30 dB-Hz、一行打周跳位。"""
        writer = NdjsonWriter(self.warehouse)
        rows = []
        for hour, values in ((7, (44.0, 45.5, None, 29.0)), (8, (46.0, 25.0, 47.0, 48.0))):
            for sv, cn0 in enumerate(values, start=1):
                rows.append({
                    "station": "WUHN", "system": "GPS", "sv": sv, "signal": "L1",
                    "epoch_utc": f"2026-11-07T{hour:02d}:{sv:02d}:00Z",
                    "gps_week": 2344, "gps_tow_s": float(hour * 3600 + sv * 10),
                    "cn0_dbhz": cn0, "elev_deg": 45.0, "azim_deg": 120.0,
                    "psr_m": 2.1e7, "adr_cycles": 1.1e8, "doppler_hz": 1200.0,
                    "quality_flag": 4 if (hour == 8 and sv == 1) else 0,
                })
        writer.write(rows)


# ---------------------------------------------------------------------------
# /board/*
# ---------------------------------------------------------------------------

class BoardCase(SurfaceCase):
    def test_forest_shape(self):
        task_id = self.make_board()
        status, payload = self.json_request("GET", "/board/forest")
        self.assertEqual(status, 200)
        # 两种读法都在：`tasks` 是任务级摘要，`bots` 是左栏那一列（fleet.js 的端点表）。
        self.assertIn("tasks", payload)
        self.assertIn("bots", payload)
        self.assertIn("pending", payload)
        self.assertIsInstance(payload["tasks"], list)
        self.assertIsInstance(payload["pending"], list)
        self.assertEqual(len(payload["tasks"]), 1)
        item = payload["tasks"][0]
        for key in ("task", "step_count", "done", "failed", "open_interventions"):
            self.assertIn(key, item)
        self.assertEqual(item["task"]["task_id"], task_id)
        self.assertEqual(item["step_count"], 3)
        self.assertEqual(item["done"], 1)
        self.assertEqual(item["open_interventions"], 1)
        self.assertIsInstance(payload["database"], dict)

    def test_forest_bots_list(self):
        """`bots` 那一列：`{bot_id, name, status, current_task_id, task_count}`。"""
        from fieldstation.botd.store import BotStore

        task_id = self.make_board()
        store = BotStore(self.db)
        # 上面 make_board 建的任务没有 bot_id；这里补一个带 bot 的任务。
        store.upsert_bot("bot1", name="ops", role="worker")
        store.create_task(kind="patrol", bot_id="bot1", title="带 bot 的任务",
                          status="running")

        status, payload = self.json_request("GET", "/board/forest")
        self.assertEqual(status, 200)
        bots = payload["bots"]
        self.assertIsInstance(bots, list)
        self.assertEqual(len(bots), 1)
        bot = bots[0]
        for key in ("bot_id", "name", "status", "current_task_id", "task_count"):
            self.assertIn(key, bot, f"bot 缺 {key}")
        self.assertEqual(bot["bot_id"], "bot1")
        self.assertEqual(bot["name"], "ops")
        self.assertTrue(bot["current_task_id"], "有在跑的任务就该给 current_task_id")
        self.assertEqual(bot["task_count"], 1)
        # 那个无 bot 的任务仍在 tasks 里（两种视图互不影响）。
        self.assertEqual(len(payload["tasks"]), 2)

    def test_tree_shape_and_five_counts(self):
        task_id = self.make_board()
        status, payload = self.json_request("GET", f"/board/tree?task_id={task_id}")
        self.assertEqual(status, 200)
        # `interaction.py::tree()` 的原样形状。
        for key in ("root", "steps", "children", "counts"):
            self.assertIn(key, payload)
        # counts 必须五键齐全：只数三档会让 skipped 把进度条卡在 N/N+1。
        counts = payload["counts"]
        for key in ("steps", "done", "failed", "skipped", "pending"):
            self.assertIn(key, counts)
        self.assertEqual(counts["steps"], 3)
        self.assertEqual(counts["done"], 1)
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(payload["root"]["task_id"], task_id)

        # 界面直接读的顶层那组（fleet.js 的端点表：task_id / status / steps）。
        self.assertEqual(payload["task_id"], task_id)
        self.assertEqual(payload["status"], "running")
        self.assertIsInstance(payload["steps"], list)
        self.assertEqual(len(payload["steps"]), 3)
        for step in payload["steps"]:
            for key in ("step_id", "name", "status", "elapsed_ms",
                        "tool", "input", "output", "attempts"):
                self.assertIn(key, step, f"步骤缺 {key}：{step}")
        # 跑完 / 跳过的那一步有真实耗时（从入队到最近一次变动）；
        # 还在跑的步不编耗时 —— 它还没结束，给一个数会被读成「已经跑了这么久且停了」。
        by_status = {step["status"]: step for step in payload["steps"]}
        self.assertIsNotNone(by_status["done"]["elapsed_ms"], "done 的步要有耗时")
        self.assertIsNotNone(by_status["skipped"]["elapsed_ms"], "skipped 的步也有耗时")
        self.assertIsNone(by_status["running"]["elapsed_ms"], "在跑的步不编耗时")

    def test_events_shape(self):
        task_id = self.make_board()
        status, payload = self.json_request("GET", f"/board/events?task_id={task_id}")
        self.assertEqual(status, 200)
        # fleet.js 读 `{events:[{seq,kind,call_id,tool,ts}]}`（第 40 行的端点表）。
        self.assertIn("events", payload)
        events = payload["events"]
        self.assertIsInstance(events, list)
        self.assertGreaterEqual(len(events), 4)   # 派发 + 三步
        for item in events:
            for key in ("kind", "seq", "tool", "call_id", "ts"):
                self.assertIn(key, item, f"事件缺 {key}：{item}")
        self.assertEqual(events[0]["kind"], "dispatched")
        # 原始字段不丢：`phase` / `at` / `label` 仍在（改写不是裁剪）。
        self.assertEqual(events[0]["phase"], "dispatched")
        self.assertTrue(events[0]["label"])

    def test_pending_shape(self):
        self.make_board()
        status, payload = self.json_request("GET", "/board/pending")
        self.assertEqual(status, 200)
        self.assertIsInstance(payload["pending"], list)
        item = payload["pending"][0]
        self.assertEqual(item["kind"], "pause")
        # fleet.js:41 读 `intervention_id`；库里的列名是 `id` —— 两个都在。
        self.assertIn("intervention_id", item)
        self.assertEqual(item["intervention_id"], item["id"])
        self.assertIn("needs_approval", item)
        self.assertIn("effective_at", item)
        self.assertEqual(item["effective_at"]["when"], "next_step_boundary")

    def test_intervene_writes_and_explains_boundary(self):
        task_id = self.make_board()
        # 界面发的键是 `note`（`interveneBody()`），不是 `prompt`。
        status, payload = self.json_request(
            "POST", "/board/intervene",
            {"kind": "pause", "task_id": task_id, "note": "再停一次"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["needs_approval"])
        self.assertEqual(payload["intervention"]["kind"], "pause")
        # 契约读 `{ok, intervention_id, status}`；两个键都在。
        self.assertEqual(payload["intervention_id"], payload["intervention"]["id"])
        self.assertEqual(payload["status"], "pending")
        self.assertEqual(payload["effective_at"]["when"], "next_step_boundary")
        # 文案必须是「在步骤边界消费」，不能写成「已暂停」（25.10.5 点名的那处）。
        self.assertIn("步骤边界", payload["note"])
        self.assertNotIn("已暂停", payload["note"])

        # note 真的落进了库里（作为 prompt）。
        _, pending = self.json_request("GET", "/board/pending")
        self.assertEqual(len(pending["pending"]), 2)
        self.assertTrue(any("再停一次" in str(row.get("prompt") or "")
                            for row in pending["pending"]))

    def test_intervene_accepts_prompt_as_well(self):
        """`prompt` 是 Python 侧的参数名；两个键都收，`note` 优先。"""
        task_id = self.make_board()
        status, payload = self.json_request(
            "POST", "/board/intervene",
            {"kind": "pause", "task_id": task_id, "prompt": "老拼法"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_takeover_without_approval_is_400(self):
        task_id = self.make_board()
        status, payload = self.json_request(
            "POST", "/board/intervene", {"kind": "takeover", "task_id": task_id})
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["class"], "input")
        self.assertIn("审批", payload["error"])

    def test_unknown_kind_is_400(self):
        task_id = self.make_board()
        status, payload = self.json_request(
            "POST", "/board/intervene", {"kind": "explode", "task_id": task_id})
        self.assertEqual(status, 400)
        self.assertIn("explode", payload["error"])

    def test_missing_task_id_is_400(self):
        status, payload = self.json_request("GET", "/board/tree")
        self.assertEqual(status, 400)
        self.assertIn("task_id", payload["error"])

    def test_unknown_task_is_404(self):
        status, payload = self.json_request("GET", "/board/tree?task_id=t-nope")
        self.assertEqual(status, 404)
        self.assertIn("t-nope", payload["error"])

    def test_board_db_lives_outside_the_repo(self):
        # 点开编队台不该往 checkout 里写文件：库路径由 FSA_BOTD_DB 指定。
        self.make_board()
        _, payload = self.json_request("GET", "/board/forest")
        self.assertEqual(Path(payload["database"]["path"]).resolve(), self.db.resolve())
        self.assertTrue(payload["database"]["exists"])

    def test_unknown_board_path_is_404(self):
        status, payload = self.json_request("GET", "/board/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload["class"], "input")


# ---------------------------------------------------------------------------
# /data/*
# ---------------------------------------------------------------------------

class DataCase(SurfaceCase):
    def test_batches_without_warehouse_is_an_empty_list_not_an_error(self):
        status, payload = self.json_request("GET", "/data/batches")
        self.assertEqual(status, 200)
        self.assertEqual(payload["batches"], [])
        self.assertEqual(payload["count"], 0)
        # 空态要能说清「下一步做什么」，不能只说「无数据」。
        self.assertIn("导入", payload["note"])

    def test_batches_collapse_partitions_per_station_day(self):
        self.make_warehouse()
        status, payload = self.json_request("GET", "/data/batches")
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 1)
        batch = payload["batches"][0]
        # 界面读 id / station / date / partitions，并认 `first` / `last`（normalizeBatches）。
        self.assertEqual(batch["id"], "WUHN/2026-11-07")
        self.assertEqual(batch["station"], "WUHN")
        self.assertEqual(batch["date"], "2026-11-07")
        self.assertEqual(batch["partitions"], 2)
        self.assertEqual(batch["rows"], 8)
        self.assertGreater(batch["bytes"], 0)
        self.assertIn("period", batch)
        self.assertTrue(batch["first_time"])
        self.assertTrue(batch["last_time"])

    def test_quality_three_counts_and_rates(self):
        self.make_warehouse()
        status, payload = self.json_request("GET", "/data/quality?batch=WUHN/2026-11-07")
        self.assertEqual(status, 200)
        self.assertFalse(payload["engineDown"])
        counts = payload["counts"]
        # 三列的键名与 `${key}Rate` 的拼法。
        for key in ("missing", "jumps", "outOfRange", "missingRate", "jumpsRate", "outOfRangeRate"):
            self.assertIn(key, counts)
        for key in ("missing", "jumps", "outOfRange", "rows"):
            self.assertIsInstance(counts[key], int)
        # 造的数据：8 行里 1 行 CN0 缺测、2 行低于 30 dB-Hz、1 行打周跳位。
        self.assertEqual(counts["rows"], 8)
        self.assertEqual(counts["missing"], 1)
        self.assertEqual(counts["outOfRange"], 2)
        self.assertEqual(counts["jumps"], 1)
        self.assertAlmostEqual(counts["missingRate"], 1 / 8)

    def test_quality_also_offers_the_flat_aliases(self):
        """契约（data-workbench 的桩）读顶层 `missing_rate` / `slip_count` / `out_of_range`。"""
        self.make_warehouse()
        _, payload = self.json_request("GET", "/data/quality?batch=WUHN/2026-11-07")
        self.assertAlmostEqual(payload["missing_rate"], 1 / 8)
        self.assertEqual(payload["slip_count"], 1)
        self.assertEqual(payload["out_of_range"], 2)
        self.assertEqual(payload["rows"], 8)

    def test_quality_rules_is_an_array(self):
        """界面按 `rule_id` 在 `rules` 里 find（data.js:330）—— 必须是数组。"""
        self.make_warehouse()
        _, payload = self.json_request("GET", "/data/quality?batch=WUHN/2026-11-07")
        rules = payload["rules"]
        self.assertIsInstance(rules, list)
        by_id = {row["rule_id"]: row for row in rules}
        self.assertEqual(set(by_id), {"R-4.2", "R-4.3"})
        for row in rules:
            for key in ("rule_id", "verdict", "value", "threshold", "unit",
                        "section", "reason"):
                self.assertIn(key, row, f"裁决缺 {key}")

    def test_quality_thresholds_come_from_the_rules_module(self):
        """阈值不在这里另定一份：必须与 ``rules.verdict.RULES`` 是同一个数。"""
        from fieldstation.rules import verdict as V

        self.make_warehouse()
        _, payload = self.json_request("GET", "/data/quality?batch=WUHN/2026-11-07")
        rules = {row["rule_id"]: row for row in payload["rules"]}
        self.assertEqual(rules["R-4.2"]["threshold"], V.RULES["R-4.2"].threshold)
        self.assertEqual(rules["R-4.3"]["threshold"], V.RULES["R-4.3"].threshold)
        # 阈值 30 dB-Hz：造出来的最低值是 25，所以 R-4.2 判 fail。
        self.assertEqual(rules["R-4.2"]["verdict"], "fail")

    def test_quality_engine_down_is_a_degradation_not_empty_data(self):
        # 数据根不存在 = 引擎没东西可读，界面按「降级」画。
        status, payload = self.json_request("GET", "/data/quality?batch=WUHN/2026-11-07")
        self.assertEqual(status, 200)
        self.assertTrue(payload["engineDown"])
        self.assertIsNone(payload["counts"])
        self.assertEqual(payload["rules"], [])
        self.assertTrue(payload["reason"])

    def test_quality_needs_batch(self):
        status, payload = self.json_request("GET", "/data/quality")
        self.assertEqual(status, 400)
        self.assertIn("batch", payload["error"])

    def test_batch_format_is_validated(self):
        for bad in ("WUHN", "WUHN/2026-13-99", "../etc/passwd", "a/b/c"):
            status, payload = self.json_request("GET", f"/data/quality?batch={bad}")
            self.assertEqual(status, 400, f"{bad} 应被拒")
            self.assertIn("batch", payload["error"])

    def test_search_returns_answer_with_provenance(self):
        self.make_warehouse()
        # 查询值必须百分号编码：非 ASCII 直接进 URI 会被 http.client 拒（只认 ASCII）。
        status, payload = self.json_request(
            "GET", f"/data/search?batch=WUHN/2026-11-07&q={quote('有多少行')}")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        # 检索区：答案 + 分区 + 行数 + 引擎，四样同时可见。
        for key in ("question", "value", "sql", "partition", "rows", "engine", "elapsedMs"):
            self.assertIn(key, payload)
        self.assertEqual(payload["value"], 8)
        self.assertIn("count(*)", payload["sql"])
        self.assertTrue(payload["partition"].startswith("station=WUHN/"))
        self.assertFalse(payload["missingField"])
        # 契约拼法也在：`answer` / `row_count` / `partition_paths` / `duration_ms`。
        self.assertEqual(payload["answer"], 8)
        self.assertEqual(payload["row_count"], 8)
        self.assertEqual(len(payload["partition_paths"]), 2)
        self.assertIsInstance(payload["duration_ms"], float)

    def test_search_empty_question_is_not_an_error(self):
        self.make_warehouse()
        status, payload = self.json_request("GET", "/data/search?batch=WUHN/2026-11-07&q=")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["sql"], "")
        self.assertIsNone(payload["value"])

    def test_search_unknown_field_sets_missing_field(self):
        self.make_warehouse()
        # 「频率」映射到 freq_hz，而造出来的批次里没有这一列
        # → ``UnsupportedQuestion`` → 界面画「这个字段不在本批次里」（不是「没有数据」）。
        status, payload = self.json_request(
            "GET", f"/data/search?batch=WUHN/2026-11-07&q={quote('平均频率')}")
        self.assertEqual(status, 200)
        self.assertTrue(payload["missingField"])
        self.assertTrue(payload["reason"])
        # 说清是**哪个**字段，不是笼统的「无数据」。
        self.assertIn("freq_hz", payload["reason"])

    def test_eval_without_logs_is_six_nulls(self):
        status, payload = self.json_request("GET", "/data/eval?batch=WUHN/2026-11-07")
        self.assertEqual(status, 200)
        # 已知 true/false 才画 ✓/✗，其余画 `?`（未跑）。
        self.assertIsNone(payload["results"])
        self.assertEqual(payload["checks"],
                         {"S1": None, "S2": None, "S3": None,
                          "S4": None, "S5": None, "S6": None})
        # 契约读 `items`：没有结果时是空数组，不是缺键。
        self.assertEqual(payload["items"], [])
        self.assertTrue(payload["note"])

    def test_unknown_data_path_is_404(self):
        status, payload = self.json_request("GET", "/data/nope")
        self.assertEqual(status, 404)


# ---------------------------------------------------------------------------
# /suite/*
# ---------------------------------------------------------------------------

class SuiteCase(SurfaceCase):
    def test_field_parity_is_markdown_not_json(self):
        status, parsed, raw, content_type = self.request("GET", "/suite/field-parity")
        self.assertEqual(status, 200)
        # suite.js:365-370 直接 `await response.text()` 再交给 parseParityMarkdown。
        self.assertIn("text/markdown", content_type)
        text = raw.decode("utf-8")
        self.assertTrue(text.lstrip().startswith("#"), "开头应是标题")
        self.assertIn("| 字段 |", text, "表头必须在")
        # 不是 JSON：`{` 开头会让前端的解析器拿到 0 行。
        self.assertFalse(text.lstrip().startswith("{"))

    def test_field_parity_matches_the_committed_document(self):
        _, _, raw, _ = self.request("GET", "/suite/field-parity")
        committed = (ROOT / "docs" / "operations" / "suite-field-parity.md").read_bytes()
        # 原样吐出去：多一层 JSON 转换就多一处可能与生成器脱节的地方。
        self.assertEqual(raw, committed)

    def test_unknown_suite_path_is_404(self):
        status, payload = self.json_request("GET", "/suite/nope")
        self.assertEqual(status, 404)


# ---------------------------------------------------------------------------
# 既有接口不受影响
# ---------------------------------------------------------------------------

class RegressionCase(SurfaceCase):
    def test_health_and_tools_still_answer(self):
        status, payload = self.json_request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertIn("tools", payload)

    def test_unknown_route_is_still_404(self):
        status, payload = self.json_request("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload["class"], "input")

    def test_unauthorized_still_401_for_new_paths(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request("GET", "/board/forest")
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 401)
        finally:
            conn.close()

    def test_wrong_method_on_new_path_is_405(self):
        status, payload = self.json_request("PUT", "/board/forest")
        self.assertEqual(status, 405)
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
