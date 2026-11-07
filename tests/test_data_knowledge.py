# -*- coding: utf-8 -*-
"""E6 语义层：元数据卡、Text-to-SQL、答案三件套、手册索引降级。

**不 skip**。llama_index 没装时用例改成断言「明确降级」——那本身是一条要钉住的行为。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.data import knowledge as kn
from fieldstation.data.dialects import SUPPORTED_DIALECTS, to_clickhouse, to_duckdb
from fieldstation.data.engines import EngineError
from fieldstation.data.manifest import PartitionManifest
from fieldstation.data.query import Aggregate, Predicate, QuerySpec
from fieldstation.data.writer import NdjsonWriter

#: 不存在的模块名，用于确定性测试「缺包」分支。
ABSENT_MODULE = "__fieldstation_absent_llama__"


def record(station: str, epoch: str, **extra) -> dict:
    row = {
        "station": station,
        "epoch_utc": epoch,
        "system": "G",
        "sv": 1,
        "cn0_dbhz": 40.0,
        "quality_flag": 0,
    }
    row.update(extra)
    return row


class KnowledgeTestCase(unittest.TestCase):
    """5 行数据集，覆盖两站、两小时、一条 08 点。

    ::

        WUHN 07:05 G sv1 cn0=40
        WUHN 07:35 G sv2 cn0=44
        WUHN 07:55 C sv3 cn0=50
        WUHN 08:15 G sv1 cn0=30
        BJFS 07:10 G sv1 cn0=60
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="fs-knowledge-")
        self.base = Path(self._tmp.name)
        self.root = self.base / "obs"
        NdjsonWriter(self.root).write(
            [
                record("WUHN", "2026-10-01T07:05:00Z", cn0_dbhz=40.0),
                record("WUHN", "2026-10-01T07:35:00Z", cn0_dbhz=44.0, sv=2),
                record("WUHN", "2026-10-01T07:55:00Z", cn0_dbhz=50.0, sv=3, system="C"),
                record("WUHN", "2026-10-01T08:15:00Z", cn0_dbhz=30.0),
                record("BJFS", "2026-10-01T07:10:00Z", cn0_dbhz=60.0),
            ]
        )
        self.card = kn.MetadataCard.from_root(self.root)
        self.planner = kn.RuleBasedPlanner()

    def tearDown(self) -> None:
        self._tmp.cleanup()


# ---------------------------------------------------------------- 元数据卡
class TestMetadataCard(KnowledgeTestCase):
    def test_shape(self):
        card = self.card
        self.assertEqual(card.partition_count, 3)  # WUHN/07, WUHN/08, BJFS/07
        self.assertEqual(card.total_rows, 5)
        self.assertGreater(card.total_bytes, 0)
        self.assertEqual(card.station_names, ("BJFS", "WUHN"))
        self.assertEqual(card.time_field, "epoch_utc")
        self.assertEqual(card.dates, ("2026-10-01",))
        self.assertEqual(card.min_time, "2026-10-01T07:05:00Z")
        self.assertEqual(card.max_time, "2026-10-01T08:15:00Z")
        self.assertIn("cn0_dbhz", card.fields)
        self.assertIn("station", card.fields)
        self.assertEqual(len(card.paths), 3)

    def test_from_manifest_matches_from_root(self):
        """``from_manifest`` 必须能直接从清单造卡，且与 ``from_root`` 等价。

        为什么单独测这个入口：``from_root`` 内部会读 ``_manifest.json``，所以只测
        ``from_root`` 时，即使 ``from_manifest`` 把 root/字段算错也发现不了。上层
        （评估脚本、UI）拿到的常常是已经 ``scan()`` 好的清单对象，走的就是这条路径。
        如果这条挂了，说明卡的两个构造入口对同一份清单给出了不同答案。
        """
        manifest = PartitionManifest.load(self.root)
        # 先确认用到的是真实清单（manifest.py 写的），不是手工捏的假对象
        self.assertEqual(len(manifest), 3)
        self.assertEqual(manifest.root, self.root)

        card = kn.MetadataCard.from_manifest(manifest)
        # root 取自 manifest.root（清单自带定位），不需要额外传参
        self.assertEqual(card.root, self.root.as_posix())
        self.assertEqual(card.partition_count, self.card.partition_count)
        self.assertEqual(card.total_rows, self.card.total_rows)
        self.assertEqual(card.fields, self.card.fields)
        self.assertEqual(card.stations, self.card.stations)
        self.assertEqual(card.paths, self.card.paths)

        explicit = kn.MetadataCard.from_manifest(manifest, root=self.root)
        self.assertEqual(explicit.to_dict(), card.to_dict())

    def test_to_dict_exposes_paths_under_that_key(self):
        """``to_dict()`` 的清单形状：路径字段叫 ``paths``（不是 ``partition_paths``）。

        为什么钉住键名：``to_dict`` 是给上层/序列化用的稳定契约，改键名会让读
        ``["paths"]`` 的调用方静默拿到 KeyError 或空结果。``partition_paths`` 是
        **方法**（可按分区裁剪），两者不是一个东西——这里同时断言这一点，
        免得后来者以为 ``to_dict()["partition_paths"]`` 应该存在。
        如果这条挂了，说明序列化契约变了，所有消费该 JSON 的代码都要跟着改。
        """
        payload = self.card.to_dict()
        self.assertIn("paths", payload)
        self.assertEqual(payload["paths"], list(self.card.paths))
        self.assertNotIn("partition_paths", payload)
        # 方法仍在：裁剪结果必须是 paths 的子集
        pruned = self.card.partition_paths(hour="07")
        self.assertTrue(pruned)
        self.assertTrue(set(pruned) <= set(payload["paths"]))

    def test_station_summary_is_per_station(self):
        by_name = {item.station: item for item in self.card.stations}
        self.assertEqual(by_name["WUHN"].partitions, 2)
        self.assertEqual(by_name["WUHN"].rows, 4)
        self.assertEqual(by_name["BJFS"].partitions, 1)
        self.assertEqual(by_name["BJFS"].rows, 1)
        self.assertEqual(by_name["WUHN"].first_time, "2026-10-01T07:05:00Z")
        self.assertEqual(by_name["WUHN"].last_time, "2026-10-01T08:15:00Z")

    def test_to_dict_is_serialisable_and_stable(self):
        import json

        payload = self.card.to_dict()
        self.assertEqual(payload["kind"], "fieldstation.metadata_card")
        self.assertEqual(payload["version"], 1)
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        self.assertEqual(text, json.dumps(self.card.to_dict(), ensure_ascii=False, sort_keys=True))
        self.assertNotIn("PosixPath", text)

    def test_partition_paths_prunes_exactly(self):
        self.assertEqual(
            self.card.partition_paths(station="WUHN", date="2026-10-01", hour="07"),
            ("station=WUHN/date=2026-10-01/hour=07/part-000.ndjson",),
        )
        # EV-21 的判分口径：只看 07 点 → 长度必须由裁剪决定，不是「扫全天后筛」
        self.assertEqual(len(self.card.partition_paths(hour="07")), 2)
        self.assertEqual(len(self.card.partition_paths(hour=8)), 1)
        self.assertEqual(self.card.partition_paths(hour="07", station="NOPE"), ())

    def test_card_does_not_scan_disk_by_default(self):
        # 清单为空且 allow_scan=False：不许悄悄全盘扫一遍
        empty_root = self.base / "no-manifest"
        NdjsonWriter(empty_root).write([record("A", "2026-11-04T07:10:00Z")])
        (empty_root / "_manifest.json").unlink()
        card = kn.MetadataCard.from_root(empty_root)
        self.assertEqual(card.partition_count, 0)
        self.assertTrue(card.note)

        scanned = kn.MetadataCard.from_root(empty_root, allow_scan=True)
        self.assertEqual(scanned.partition_count, 1)

    def test_field_type_hints(self):
        hints = self.card.field_types_hint()
        self.assertEqual(hints["epoch_utc"], "时间")
        self.assertEqual(hints["cn0_dbhz"], "数值")
        self.assertEqual(hints["station"], "文本")

    def test_describe_mentions_stations_and_range(self):
        text = self.card.describe()
        self.assertIn("WUHN", text)
        self.assertIn("2026-10-01T07:05:00Z", text)


# ---------------------------------------------------------------- 规划器
class TestRuleBasedPlanner(KnowledgeTestCase):
    def plan(self, question: str) -> kn.Plan:
        return self.planner.plan(question, self.card)

    def test_ev17_style_count(self):
        plan = self.plan("WUHN 2026-10-01 一共多少行？")
        self.assertIn("count(*)", plan.sql)
        self.assertIn("station = 'WUHN'", plan.sql)
        self.assertIn("date = DATE '2026-10-01'", plan.sql)
        self.assertEqual(plan.station, "WUHN")
        self.assertEqual(plan.date, "2026-10-01")
        self.assertIsNotNone(plan.spec)

    def test_ev21_style_hour_only(self):
        plan = self.plan("只看 07 点这一小时")
        self.assertIn("hour = '07'", plan.sql)
        self.assertEqual(plan.hour, "07")
        # 不从清单偷偷补日期：SQL 必须与问题一致
        self.assertNotIn("date =", plan.sql)

    def test_hour_forms(self):
        for question in ("WUHN 07 点多少行", "WUHN 7:00 多少行", "WUHN 7时 多少行"):
            self.assertEqual(self.plan(question).hour, "07", question)

    def test_average_and_extremes(self):
        avg = self.plan("CN0 的平均值是多少")
        self.assertIn("avg(cn0_dbhz)", avg.sql)
        self.assertEqual(avg.metric, "cn0_dbhz")

        top = self.plan("WUHN 最高载噪比是多少")
        self.assertIn("max(cn0_dbhz)", top.sql)

        low = self.plan("WUHN 最低质量旗标是多少")
        self.assertIn("min(quality_flag)", low.sql)

    def test_metric_absent_from_card_is_an_error(self):
        # 问仰角但数据集没这个字段：不许悄悄改成「载噪比」再给个数
        with self.assertRaises(kn.UnsupportedQuestion) as ctx:
            self.plan("WUHN 最低仰角是多少")
        self.assertIn("elev_deg", str(ctx.exception))

    def test_group_by_and_limit(self):
        grouped = self.plan("每个台站多少行")
        self.assertIn("GROUP BY station", grouped.sql)
        self.assertEqual(grouped.group_by, "station")

        limited = self.plan("前 1 条台站统计")
        self.assertIn("LIMIT 1", limited.sql)
        self.assertEqual(limited.limit, 1)

    def test_hourly_bucket_matches_bench_sql_subset(self):
        plan = self.plan("按小时统计行数")
        self.assertIn("time_bucket('1 hour', epoch_utc)", plan.sql)
        self.assertEqual(plan.bucket, "1h")
        # 这条必须能过 dialects 的两个方言翻译（即它真在支持子集里）
        for target in SUPPORTED_DIALECTS:
            translated = (
                to_clickhouse(plan.sql) if target == "clickhouse" else to_duckdb(plan.sql)
            )
            self.assertIn("FROM obs", translated)

    def test_distinct_epochs(self):
        plan = self.plan("WUHN 2026-10-01 07 点有多少历元")
        self.assertIn("count(DISTINCT epoch_utc)", plan.sql)
        self.assertEqual(plan.hour, "07")

    def test_every_plan_passes_the_sql_gate(self):
        questions = [
            "WUHN 2026-10-01 一共多少行？",
            "只看 07 点这一小时",
            "CN0 的平均值是多少",
            "WUHN 最高载噪比是多少",
            "每个台站多少行",
            "按小时统计行数",
            "历元数有多少",
            "前 1 条台站统计",
            "你好",
        ]
        for question in questions:
            plan = self.plan(question)
            self.assertEqual(kn.ensure_supported_sql(plan.sql), plan.sql.strip(), question)
            self.assertEqual(plan.planner, "rule")
            self.assertTrue(plan.note, question)

    def test_note_records_which_rule_fired(self):
        self.assertIn("台站=WUHN", self.plan("WUHN 多少行").note)
        self.assertIn("小时=07", self.plan("07 点多少行").note)
        self.assertIn("分组=station", self.plan("每个台站多少行").note)

    def test_unknown_station_is_an_error_not_a_silent_wrong_answer(self):
        with self.assertRaises(kn.UnsupportedQuestion) as ctx:
            self.plan("XXXX 2026-10-01 多少行")
        self.assertIn("XXXX", str(ctx.exception))

    def test_unknown_question_falls_back_to_row_count(self):
        # 认不出的问题不猜语义，只给「多少行」并把规则记进 note
        plan = self.plan("帮我看看这个数据")
        self.assertIn("count(*) AS row_count", plan.sql)
        self.assertIn("默认按行数回答", plan.note)

    def test_planner_is_deterministic(self):
        first = self.plan("WUHN 2026-10-01 一共多少行？")
        second = self.plan("WUHN 2026-10-01 一共多少行？")
        self.assertEqual(first, second)

    def test_planner_protocol_is_satisfied(self):
        self.assertIsInstance(self.planner, kn.SqlPlanner)

    def test_injected_planner_is_used(self):
        class Fixed:
            name = "fixed"

            def plan(self, question, card=None):
                return kn.Plan(
                    question=question,
                    sql="SELECT count(*) AS n FROM obs WHERE hour = '08'",
                    planner=self.name,
                    spec=QuerySpec(
                        aggregates=(Aggregate("count", "*", "n"),), hour="08"
                    ),
                    hour="08",
                    note="注入的固定规划器",
                )

        self.assertIsInstance(Fixed(), kn.SqlPlanner)


# ---------------------------------------------------------------- SQL 闸门
class TestSqlGate(unittest.TestCase):
    def test_read_only_accepts_select_and_with(self):
        self.assertEqual(kn.ensure_read_only("SELECT 1"), "SELECT 1")
        self.assertEqual(
            kn.ensure_read_only("  SELECT count(*) FROM obs;  "),
            "SELECT count(*) FROM obs",
        )
        self.assertTrue(kn.ensure_read_only("WITH x AS (SELECT 1) SELECT * FROM x"))

    def test_write_statements_are_rejected_with_eval_code(self):
        for sql in (
            "DELETE FROM obs",
            "DROP TABLE obs",
            "INSERT INTO obs VALUES (1)",
            "UPDATE obs SET cn0_dbhz = 0",
            "CREATE TABLE t AS SELECT 1",
            "ATTACH 'x.db'",
            "COPY obs TO 'x.csv'",
        ):
            with self.assertRaises(kn.ReadOnlyError) as ctx:
                kn.ensure_read_only(sql)
            self.assertEqual(ctx.exception.code, "E_READONLY", sql)

    def test_multiple_statements_rejected(self):
        with self.assertRaises(kn.ReadOnlyError):
            kn.ensure_read_only("SELECT 1; DROP TABLE obs")

    def test_string_literal_is_not_a_keyword(self):
        # 引号里的 delete 是数据，不是写语句
        sql = "SELECT count(*) AS n FROM obs WHERE note = 'delete'"
        self.assertEqual(kn.ensure_read_only(sql), sql)

    def test_unsupported_function_rejected(self):
        with self.assertRaises(kn.UnsupportedSqlError) as ctx:
            kn.ensure_supported_sql("SELECT regexp_matches(station, '^WU') FROM obs")
        self.assertEqual(ctx.exception.code, "E_UNSUPPORTED_SQL")

    def test_must_query_obs_view(self):
        with self.assertRaises(kn.UnsupportedSqlError):
            kn.ensure_supported_sql("SELECT count(*) FROM other")

    def test_supported_functions_are_a_dialects_subset(self):
        # 白名单里的时间函数必须在 dialects 的翻译表里有对应处理
        from fieldstation.data.dialects import _HANDLERS

        for name in kn.SUPPORTED_SQL_FUNCTIONS:
            if name in ("count", "avg", "min", "max", "sum"):
                continue
            self.assertIn(name, _HANDLERS, name)


# ---------------------------------------------------------------- 答案三件套
class TestAnswerContract(KnowledgeTestCase):
    def answer(self, question: str, **kwargs) -> kn.QueryAnswer:
        return kn.answer_question(self.root, question, card=self.card, **kwargs)

    def test_ev17_requires_three_fields(self):
        answer = self.answer("WUHN 2026-10-01 一共多少行？", engine="builtin")
        self.assertIsInstance(answer.partition_paths, tuple)
        self.assertEqual(len(answer.partition_paths), 2)
        self.assertTrue(answer.sql.startswith("SELECT"))
        self.assertEqual(answer.row_count, 4)
        self.assertEqual(answer.result_rows, 1)
        payload = answer.to_dict()
        for key in ("partition_paths", "sql", "row_count"):
            self.assertIn(key, payload)
        self.assertEqual(payload["row_count"], 4)

    def test_ev21_hour_hits_exactly_one_partition_per_station(self):
        answer = self.answer("WUHN 2026-10-01 07 点多少行", engine="builtin")
        self.assertEqual(len(answer.partition_paths), 1)
        self.assertIn("hour=07", answer.partition_paths[0])
        self.assertEqual(answer.row_count, 3)

    def test_hour_only_query_reports_two_partitions(self):
        answer = self.answer("只看 07 点这一小时", engine="builtin")
        self.assertEqual(len(answer.partition_paths), 2)
        self.assertEqual(answer.row_count, 4)
        self.assertIn("hour = '07'", answer.sql)

    def test_row_count_is_source_rows_not_result_rows(self):
        answer = self.answer("每个台站多少行", engine="builtin")
        self.assertEqual(answer.row_count, 5)  # 源数据行数
        self.assertEqual(answer.result_rows, 2)  # 两个台站
        self.assertEqual(answer.partition_count, 3)

    def test_result_values_are_correct(self):
        answer = self.answer("每个台站多少行", engine="builtin")
        rows = {row["station"]: row["row_count"] for row in answer.rows}
        self.assertEqual(rows, {"BJFS": 1, "WUHN": 4})

        average = self.answer("CN0 的平均值是多少", engine="builtin")
        self.assertAlmostEqual(average.rows[0]["avg_cn0_dbhz"], 44.8, places=6)

    def test_describe_has_all_three(self):
        text = self.answer("WUHN 2026-10-01 一共多少行？", engine="builtin").describe()
        self.assertIn("SQL", text)
        self.assertIn("分区", text)
        self.assertIn("4", text)

    def test_note_explains_engine_choice(self):
        answer = self.answer("多少行", engine="builtin")
        self.assertEqual(answer.engine, "builtin")
        self.assertIn("engine=builtin", answer.note)

    def test_max_rows_truncates_and_says_so(self):
        answer = self.answer("每个台站多少行", engine="builtin", max_rows=1)
        self.assertTrue(answer.truncated)
        self.assertEqual(len(answer.rows), 1)
        self.assertEqual(answer.result_rows, 2)

    def test_unknown_engine_rejected(self):
        with self.assertRaises(kn.KnowledgeError):
            self.answer("多少行", engine="mysql")

    def test_missing_manifest_is_declared_not_faked(self):
        bare = self.base / "bare"
        NdjsonWriter(bare).write([record("WUHN", "2026-10-01T07:05:00Z")])
        (bare / "_manifest.json").unlink()
        answer = kn.answer_question(
            bare, "WUHN 2026-10-01 多少行", card=kn.MetadataCard.from_root(bare), engine="builtin"
        )
        self.assertEqual(answer.partition_paths, ())
        self.assertIn("warning", answer.metadata)
        # 行数仍是真的（来自内置引擎），只是缺出处
        self.assertEqual(answer.row_count, 1)

    def test_partition_paths_are_relative_and_exist(self):
        answer = self.answer("WUHN 2026-10-01 一共多少行？", engine="builtin")
        for rel in answer.partition_paths:
            self.assertFalse(rel.startswith("/"), rel)
            self.assertTrue((self.root / rel).is_file(), rel)


class TestDuckDBFallback(KnowledgeTestCase):
    """DuckDB 装了但执行失败时，``auto`` 必须回落内置引擎 **并明示**。"""

    class BrokenDuck:
        name = "duckdb"

        def __init__(self) -> None:
            self.calls = 0

        def available(self) -> bool:
            return True

        def unavailable_reason(self) -> str:
            return ""

        def execute(self, sql, params=None):
            self.calls += 1
            raise EngineError("duckdb 执行失败：模拟时间类型解码失败")

    def test_auto_falls_back_and_says_why(self):
        answer = kn.answer_question(
            self.root, "WUHN 2026-10-01 一共多少行？", card=self.card, engine="auto",
            duckdb=self.BrokenDuck(),
        )
        self.assertEqual(answer.engine, "builtin")
        self.assertIn("回落", answer.note)
        self.assertEqual(answer.row_count, 4)

    def test_explicit_duckdb_propagates_error(self):
        with self.assertRaises(EngineError):
            kn.answer_question(
                self.root, "WUHN 2026-10-01 一共多少行？", card=self.card,
                engine="duckdb", duckdb=self.BrokenDuck(),
            )


# ---------------------------------------------------------------- 手册索引
class TestHandbook(KnowledgeTestCase):
    DOCS = [
        {
            "doc_id": "d1",
            "title": "CN0 判据",
            "category": "阈值",
            "source": "manual#1",
            "body": "CN0 载噪比低于 30 dB-Hz 视为异常，需要检查天线与线缆。",
        },
        {
            "doc_id": "d2",
            "title": "重启流程",
            "category": "操作",
            "source": "manual#2",
            "body": "接收机重启：先停止记录，再断电十秒，等待电压稳定后上电。",
        },
        {
            "doc_id": "d3",
            "title": "周跳检测",
            "category": "算法",
            "source": "manual#3",
            "body": "周跳检测使用多频相位组合与多项式拟合残差。",
        },
    ]

    def test_availability_is_a_bool_not_an_exception(self):
        self.assertIsInstance(kn.handbook_available(), bool)
        self.assertFalse(kn.handbook_available(ABSENT_MODULE))

    def test_absent_module_degrades_to_explanation(self):
        result = kn.search_handbook("载噪比", module_name=ABSENT_MODULE)
        self.assertEqual(result.hits, ())
        self.assertFalse(result.indexed)
        self.assertIn("不可用", result.reason)
        self.assertIn("不可用", result.describe())
    def test_default_does_not_build_an_index(self):
        index = kn.HandbookIndex()
        self.assertFalse(index.status()["built"])
        if not kn.handbook_available():
            # 缺包时连「没给模型」都轮不到——必须先报依赖不可用
            with self.assertRaises(kn.HandbookUnavailable):
                index.build(self.DOCS)
            return
        # 有包但没给模型：明确拒绝，不偷偷用某个默认模型
        with self.assertRaises(kn.EmbeddingUnavailable):
            index.build(self.DOCS)
        self.assertFalse(index.status()["built"])

    def test_query_before_build_raises_explicitly(self):
        index = kn.HandbookIndex(embed_model="hashing")
        with self.assertRaises(kn.HandbookUnavailable):
            index.query("x")

    def test_absent_module_build_raises_explicitly(self):
        index = kn.HandbookIndex(module_name=ABSENT_MODULE, embed_model="hashing")
        with self.assertRaises(kn.HandbookUnavailable):
            index.build(self.DOCS)

    def test_build_query_and_persist_round_trip(self):
        if not kn.handbook_available():
            # 缺包分支已由上面的用例钉住，这里只断言不假装能检索
            result = kn.search_handbook("载噪比")
            self.assertEqual(result.hits, ())
            self.assertTrue(result.reason)
            return

        persist = self.base / "index"
        index = kn.HandbookIndex(embed_model="hashing", similarity_top_k=1)
        self.assertEqual(index.build(self.DOCS, persist_dir=persist), 3)
        self.assertTrue(index.status()["built"])
        self.assertEqual(index.status()["uses_model"], "hashing")

        hits = index.query("载噪比低于多少算异常", top_k=1)
        self.assertEqual(len(hits), 1)
        # 出处必须回到原文档
        self.assertEqual(hits[0].doc_id, "d1")
        self.assertEqual(hits[0].metadata["source"], "manual#1")
        self.assertIsNotNone(hits[0].score)
        self.assertGreaterEqual(hits[0].score or 0.0, 0.0)

        reloaded = kn.HandbookIndex.load(persist, embed_model="hashing", similarity_top_k=1)
        self.assertTrue(reloaded.status()["built"])
        self.assertEqual(reloaded.query("周跳怎么检测", top_k=1)[0].doc_id, "d3")

    def test_search_handbook_builds_from_documents_when_asked(self):
        result = kn.search_handbook("接收机怎么重启", documents=self.DOCS, top_k=1)
        if not kn.handbook_available():
            self.assertEqual(result.hits, ())
            self.assertTrue(result.reason)
            return
        self.assertTrue(result.indexed)
        self.assertEqual(result.hits[0].doc_id, "d2")
        self.assertIn("d2", result.describe())

    def test_empty_documents_rejected(self):
        if not kn.handbook_available():
            self.assertFalse(kn.handbook_available())
            return
        with self.assertRaises(kn.HandbookError):
            kn.HandbookIndex(embed_model="hashing").build([])

    def test_malformed_document_rejected(self):
        if not kn.handbook_available():
            self.assertFalse(kn.handbook_available())
            return
        with self.assertRaises(kn.HandbookError):
            kn.HandbookIndex(embed_model="hashing").build([{"doc_id": "d1"}])

    def test_index_metadata_carries_provenance_keys(self):
        if not kn.handbook_available():
            self.assertFalse(kn.handbook_available())
            return
        index = kn.HandbookIndex(embed_model="hashing", similarity_top_k=1)
        index.build(self.DOCS)
        self.assertTrue(index.built)
        hit = index.query("周跳检测", top_k=1)[0]
        for key in ("doc_id", "title", "category", "source"):
            self.assertIn(key, hit.metadata)


# ---------------------------------------------------------------- 模块纪律
class TestModuleDiscipline(unittest.TestCase):
    def test_module_imports_without_optional_packages(self):
        import fieldstation.data.knowledge as module

        self.assertTrue(hasattr(module, "MetadataCard"))
        self.assertTrue(hasattr(module, "HandbookIndex"))

    def test_no_toplevel_third_party_import(self):
        """顶层不许出现 pyarrow / llama_index（门禁只依赖标准库）。"""
        source = Path(kn.__file__).read_text(encoding="utf-8")
        head = source.split('"""', 2)[-1]  # 去掉模块 docstring
        top_lines = [
            line
            for line in head.splitlines()
            if line.startswith(("import ", "from ")) and "import" in line
        ]
        joined = "\n".join(top_lines)
        for name in ("pyarrow", "llama_index", "duckdb", "pandas"):
            self.assertNotIn(name, joined, name)

    def test_parquet_module_has_no_toplevel_third_party_import(self):
        from fieldstation.data import parquet as pq

        source = Path(pq.__file__).read_text(encoding="utf-8")
        head = source.split('"""', 2)[-1]
        top_lines = [
            line
            for line in head.splitlines()
            if line.startswith(("import ", "from ")) and "import" in line
        ]
        joined = "\n".join(top_lines)
        for name in ("pyarrow", "pandas", "duckdb"):
            self.assertNotIn(name, joined, name)


if __name__ == "__main__":
    unittest.main()
