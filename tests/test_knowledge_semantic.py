"""引-4：手册语义检索——**语义 vs 词面**的命中率必须用数字说话。

为什么这个测试长这样：

- 本仓库纪律是**纯标准库、不联网**（``CLAUDE.md`` §4），所以「真 embedding」不能靠
  装 sentence-transformers 来交代。做法是把向量化器做成可切换的三档，其中 ``semantic``
  是子词哈希 + 概念轴投影；同时**允许把真模型直接注入**——将来装了真模型，换
  ``embed_model=`` 就行，检索管线一行不用改；
- 只证明「有语义档」不够，必须证明**它在同义改写上比词面档命中更多**。下面
  :data:`SYNONYM_CASES` 的查询**故意不与目标规程共享关键词**（说「没电」不说「掉电」，
  说「撬柜子」不说「机柜入侵」），词面档靠字面重叠排不上来；
- **对手必须是一个合格的词面基线**。仓里原有的 ``hashing``（无符号二元组）在
  :data:`SYNONYM_CASES` 上只有 1/25，比随机取 3 条的 7.5/25 还低——那是**退化**，
  不是「词面」。拿它当对手是打稻草人，所以对比用 ``lexical``（带符号子词哈希，
  实测 12/25），``hashing`` 的退化单独钉一个用例记录事实。

**这套语义的来源是 ``knowledge.HANDBOOK_CONCEPTS`` 这张人工同义词表**，不是训练出来的
模型。所以它覆盖表内说法、不覆盖表外说法——这个边界写在 :class:`TestSemanticBoundary`
里，不许含糊过去。
"""
from __future__ import annotations

import json
import random
import unittest
from pathlib import Path

import fieldstation.data.knowledge as kn

ROOT = Path(__file__).resolve().parents[1]
DOCS_PATH = ROOT / "data" / "kb" / "knowledge.jsonl"


def _load_docs() -> list[dict]:
    return [
        json.loads(line)
        for line in DOCS_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


#: 同义改写查询集：``(查询, 期望的 doc_id)``。
#:
#: 每条都避开规程里的关键名词。这是本测试的核心证据，改动前先想清楚：**放宽它等于
#: 取消这条验收**。
SYNONYM_CASES: tuple[tuple[str, str], ...] = (
    # 供电族
    ("电站没电了整套设备都停摆", "power-outage"),
    ("电供不上了怎么办", "power-outage"),
    ("电瓶没电了怎么办", "power-outage"),
    ("停电之后设备还能自己起来吗", "power-outage"),
    ("没有市电了怎么办", "power-outage"),
    ("设备突然全黑", "power-outage"),
    # 网络族
    ("后台看不到站的数", "network-loss"),
    ("上报通路不通但本地还在采", "network-loss"),
    ("数传通道挂了", "network-loss"),
    # 传感器族
    ("两个仪器同一个点差太多", "sensor-drift"),
    ("同一位置两台设备结果不一致", "sensor-drift"),
    ("观测值老是偏离", "sensor-drift"),
    # 质控族
    ("结果大得离谱", "qc-nonphysical-rmse"),
    ("这个数值超出物理可能", "qc-nonphysical-rmse"),
    ("相位蹦了一下", "qc-phase-slip"),
    ("厘米级跳点没回去", "qc-phase-slip"),
    # 审批与工单族
    ("改配置要不要走审批", "workorder-high-risk"),
    ("高危操作谁来批", "workorder-high-risk"),
    ("最要紧的那一级给谁", "workorder-priority"),
    ("最急的那档派给谁", "workorder-priority"),
    ("P1 归谁处理", "workorder-priority"),
    # 归档与安防族
    ("模拟产物和实测不能混着放", "archive-synthetic"),
    ("柜子被人开了", "security-alarm"),
    ("门被撬了", "security-alarm"),
    ("有人非法进入站区", "security-alarm"),
)

#: 指标口径：命中 = 期望条目出现在前 ``TOP_K`` 名。``TOP_K=3`` 与
#: ``HandbookIndex.similarity_top_k`` 的默认值一致。
TOP_K = 3


def _hit_ids(docs, query: str, *, model: str, top_k: int = TOP_K) -> list[str]:
    return [hit.doc_id or "" for hit in kn.rank_handbook(docs, query, model=model, top_k=top_k)]


def _score(docs, *, model: str, top_k: int = TOP_K) -> tuple[int, list[dict]]:
    """跑完整套近义查询，返回 ``(命中条数, 逐条明细)``。明细用于失败时打印数字。"""
    detail: list[dict] = []
    good = 0
    for query, expected in SYNONYM_CASES:
        ids = _hit_ids(docs, query, model=model, top_k=top_k)
        hit = expected in ids
        if hit:
            good += 1
        detail.append({"query": query, "expected": expected, "ids": ids, "hit": hit})
    return good, detail


def _random_baseline(docs, trials: int = 400, seed: int = 20261111) -> float:
    """随机取 ``TOP_K`` 条的平均命中数。用来证明词面基线不是碰巧。

    固定种子：结果可复算，不是「跑几次挑一个好看的」。
    """
    ids = [str(doc.get("doc_id", "")) for doc in docs]
    rng = random.Random(seed)
    total = 0
    for _ in range(trials):
        for _query, expected in SYNONYM_CASES:
            pool = list(ids)
            rng.shuffle(pool)
            total += expected in pool[:TOP_K]
    return total / trials


class TestSemanticBeatsLexical(unittest.TestCase):
    """核心验收：语义路径的命中条数**严格高于**词面路径。"""

    @classmethod
    def setUpClass(cls):
        cls.docs = _load_docs()

    def test_semantic_strictly_beats_lexical_on_synonym_queries(self):
        semantic_hits, semantic_detail = _score(self.docs, model="semantic")
        lexical_hits, lexical_detail = _score(self.docs, model="lexical")
        total = len(SYNONYM_CASES)
        message = {
            "total": total,
            "semantic_hits": semantic_hits,
            "lexical_hits": lexical_hits,
            "semantic_misses": [item for item in semantic_detail if not item["hit"]],
            "lexical_misses": [item for item in lexical_detail if not item["hit"]],
        }
        # 严格大于：不是「不差于」，也不是「大致相当」。
        self.assertGreater(semantic_hits, lexical_hits, message)
        # 语义档自己也要到达下限，否则「比烂的更好」也能过。
        self.assertGreaterEqual(semantic_hits, 24, message)
        # 词面档也不能是瘫的，否则这个对比没有意义。
        self.assertGreaterEqual(lexical_hits, 8, message)

    def test_lexical_beats_random_and_is_not_degenerate(self):
        """合格词面基线必须明确高于随机取 3 条，并明显低于语义档。"""
        lexical_hits, detail = _score(self.docs, model="lexical")
        random_mean = _random_baseline(self.docs)
        semantic_hits, _ = _score(self.docs, model="semantic")
        message = {
            "lexical_hits": lexical_hits,
            "random_mean": random_mean,
            "semantic_hits": semantic_hits,
            "total": len(SYNONYM_CASES),
        }
        self.assertGreater(lexical_hits, random_mean, message)
        self.assertLess(lexical_hits, semantic_hits, message)

    def test_legacy_hashing_is_degenerate_and_recorded(self):
        """记录事实：旧 ``hashing`` 在同义查询上低于随机——所以它不能当对比基线。

        这条不是「夸语义好」，而是把「为什么换对手」写成可执行的事实。它坏的原因是
        无符号二元组累加：短查询与长文档撞不出共享 gram，得分全 0 后退化成按
        ``doc_id`` 字母序排。
        """
        hashing_hits, detail = _score(self.docs, model="hashing")
        random_mean = _random_baseline(self.docs)
        self.assertLess(hashing_hits, random_mean, detail)
        # 它仍然必须**能跑**（降级路径可用），只是质量不行。
        self.assertEqual(len(detail), len(SYNONYM_CASES))

    def test_numbers_are_reproducible(self):
        """同一输入跑两次，计数与顺序完全一致——向量是确定性的，不许有随机性。"""
        first_hits, first_detail = _score(self.docs, model="semantic")
        second_hits, second_detail = _score(self.docs, model="semantic")
        self.assertEqual(first_hits, second_hits)
        self.assertEqual(
            [item["ids"] for item in first_detail],
            [item["ids"] for item in second_detail],
        )

    def test_semantic_scores_top_hit_above_lexical_top_hit_on_synonyms(self):
        """不只看名次，看**分数**：同一句同义改写，语义档给正确条目的相似度更高。"""
        query, expected = SYNONYM_CASES[0]
        semantic_top = kn.rank_handbook(self.docs, query, model="semantic", top_k=1)[0]
        lexical_top = kn.rank_handbook(self.docs, query, model="lexical", top_k=1)[0]
        self.assertEqual(semantic_top.doc_id, expected)
        self.assertIsNotNone(semantic_top.score)
        self.assertIsNotNone(lexical_top.score)
        self.assertGreater(semantic_top.score, lexical_top.score)

    def test_semantic_does_not_regress_on_paraphrases_that_share_terms(self):
        """共享原词的说法上，语义档不许比词面档差——否则改法是拆东墙补西墙。"""
        shared = [
            ("供电电压为零怎么判", "power-outage"),
            ("传感器读数超过量程", "sensor-drift"),
            ("RMSE 超过 500 TECU", "qc-nonphysical-rmse"),
            ("载波相位阶跃按周跳处理", "qc-phase-slip"),
            ("远程重启需要人工审批", "workorder-high-risk"),
            ("合成数据写入 synthetic 目录", "archive-synthetic"),
            ("门禁入侵告警记录来源", "security-alarm"),
        ]
        for query, expected in shared:
            with self.subTest(query=query):
                semantic = _hit_ids(self.docs, query, model="semantic")
                lexical = _hit_ids(self.docs, query, model="lexical")
                self.assertIn(expected, semantic, (query, semantic))
                self.assertIn(expected, lexical, (query, lexical))


class TestDegradedPathIsDeclared(unittest.TestCase):
    """降级路径必须**仍然可用**，而且**明示自己是降级**。"""

    @classmethod
    def setUpClass(cls):
        cls.docs = _load_docs()

    def test_hashing_index_status_declares_degradation(self):
        status = kn.HandbookIndex(embed_model="hashing").status()
        self.assertEqual(status["uses_model"], "hashing")
        self.assertTrue(status["degraded"])
        self.assertIn("不是语义", status["degraded_reason"])

    def test_lexical_index_status_declares_degradation(self):
        status = kn.HandbookIndex(embed_model="lexical").status()
        self.assertEqual(status["uses_model"], "lexical")
        self.assertTrue(status["degraded"])

    def test_semantic_index_status_is_not_degraded(self):
        status = kn.HandbookIndex(embed_model="semantic").status()
        self.assertEqual(status["uses_model"], "semantic")
        self.assertFalse(status["degraded"])
        self.assertEqual(status["degraded_reason"], "")

    def test_degraded_result_says_so_in_describe(self):
        result = kn.search_handbook_local(
            "太阳能电池没电了", self.docs, top_k=3, embed_model="hashing"
        )
        self.assertTrue(result.degraded)
        self.assertEqual(result.model, "hashing")
        self.assertIn("降级", result.describe())
        self.assertTrue(result.hits, "降级路径也要能出结果，否则「降级可用」是空话")
        payload = result.to_dict()
        self.assertTrue(payload["degraded"])
        self.assertEqual(payload["model"], "hashing")

    def test_lexical_result_says_so_in_describe(self):
        result = kn.search_handbook_local("门被撬了", self.docs, top_k=3, embed_model="lexical")
        self.assertTrue(result.degraded)
        self.assertIn("降级", result.describe())

    def test_semantic_result_is_not_marked_degraded(self):
        result = kn.search_handbook_local("太阳能电池没电了", self.docs, top_k=3)
        self.assertFalse(result.degraded)
        self.assertEqual(result.model, "semantic")
        self.assertNotIn("降级", result.describe())

    def test_is_degraded_model_covers_names_and_injections(self):
        self.assertTrue(kn.is_degraded_model("hashing"))
        self.assertTrue(kn.is_degraded_model("lexical"))
        self.assertFalse(kn.is_degraded_model("semantic"))
        # 注入的真模型不是我们的降级路径，本模块不替别人下判断
        self.assertFalse(kn.is_degraded_model(object()))

    def test_unknown_model_name_is_an_explicit_error(self):
        with self.assertRaises(kn.EmbeddingUnavailable):
            kn.handbook_vector("x", model="gpt-embedding-9000")
        with self.assertRaises(kn.EmbeddingUnavailable):
            kn.HandbookIndex(embed_model="gpt-embedding-9000").embed_model()


class TestLocalPathNeedsNoLlamaIndex(unittest.TestCase):
    """免依赖路径：llama_index 在或不在都能做语义检索。"""

    @classmethod
    def setUpClass(cls):
        cls.docs = _load_docs()

    def test_local_index_round_trip(self):
        index = kn.LocalHandbookIndex(embed_model="semantic", similarity_top_k=3)
        self.assertFalse(index.built)
        self.assertEqual(index.build(self.docs), len(self.docs))
        self.assertTrue(index.built)
        hits = index.query("太阳能电池没电了", top_k=3)
        self.assertEqual(hits[0].doc_id, "power-outage")
        self.assertEqual(hits[0].metadata["category"], "运维规程")
        self.assertIsNotNone(hits[0].score)

    def test_local_index_before_build_raises(self):
        with self.assertRaises(kn.HandbookUnavailable):
            kn.LocalHandbookIndex().query("x")

    def test_local_index_rejects_empty_documents(self):
        with self.assertRaises(kn.HandbookError):
            kn.LocalHandbookIndex().build([])

    def test_local_index_rejects_malformed_document(self):
        with self.assertRaises(kn.HandbookError):
            kn.LocalHandbookIndex().build([{"doc_id": "d1"}])

    def test_search_handbook_local_does_not_touch_llama_index(self):
        """把 llama_index 探测打成恒假，免依赖入口照样出结果。"""
        original = kn.handbook_available
        kn.handbook_available = lambda *a, **k: False
        try:
            result = kn.search_handbook_local("门被撬了", self.docs, top_k=3)
        finally:
            kn.handbook_available = original
        self.assertTrue(result.hits)
        self.assertEqual(result.hits[0].doc_id, "security-alarm")
        self.assertFalse(result.degraded)

    def test_empty_query_is_an_explained_failure_not_a_crash(self):
        result = kn.search_handbook_local("   ", self.docs, top_k=3)
        self.assertEqual(result.hits, ())
        self.assertIn("查询为空", result.reason)


class TestInjectionInterface(unittest.TestCase):
    """「可注入真实模型」不是口号：塞一个对象进去，检索就得用它。"""

    @classmethod
    def setUpClass(cls):
        cls.docs = _load_docs()

    def test_encode_style_model_is_used(self):
        calls: list[str] = []

        class Recorder:
            def encode(self, text: str) -> list[float]:
                calls.append(text)
                return list(kn.handbook_vector(text, model="semantic"))

        hits = kn.rank_handbook(self.docs, "太阳能电池没电了", model=Recorder(), top_k=3)
        self.assertEqual(hits[0].doc_id, "power-outage")
        # 一次查询 + 每条文档一次，说明注入对象真在被调用
        self.assertEqual(len(calls), len(self.docs) + 1)
        self.assertEqual(calls[0], "太阳能电池没电了")

    def test_langchain_style_embed_query_is_accepted(self):
        class LangChainish:
            def embed_query(self, text: str):
                return kn.handbook_vector(text, model="semantic")

        hits = kn.rank_handbook(self.docs, "门被撬了", model=LangChainish(), top_k=1)
        self.assertEqual(hits[0].doc_id, "security-alarm")

    def test_nested_vector_is_flattened(self):
        class Nested:
            def encode(self, text: str):
                return [[value] for value in kn.handbook_vector(text, model="semantic")]

        hits = kn.rank_handbook(self.docs, "数传通道挂了", model=Nested(), top_k=1)
        self.assertEqual(hits[0].doc_id, "network-loss")

    def test_model_without_encoder_is_a_clear_error(self):
        class Useless:
            pass

        with self.assertRaises(kn.EmbeddingUnavailable):
            kn.rank_handbook(self.docs, "x", model=Useless(), top_k=1)

    def test_local_index_accepts_injected_model(self):
        class Passthrough:
            def encode(self, text: str):
                return kn.handbook_vector(text, model="semantic")

        index = kn.LocalHandbookIndex(embed_model=Passthrough(), similarity_top_k=2)
        index.build(self.docs)
        self.assertEqual(index.query("最急的那档派给谁")[0].doc_id, "workorder-priority")
        self.assertEqual(index.status()["uses_model"], "injected")
        self.assertFalse(index.status()["degraded"])

    def test_llama_index_path_accepts_injected_model_too(self):
        """``HandbookIndex`` 的注入口径与免依赖路径一致（缺包时只断言口径相同）。"""
        class Passthrough:
            def encode(self, text: str):
                return kn.handbook_vector(text, model="semantic")

        index = kn.HandbookIndex(embed_model=Passthrough(), similarity_top_k=2)
        self.assertIs(index.embed_model(), index.embed_model())
        self.assertEqual(index.status()["uses_model"], "injected")


class TestTwoExecutionPathsAgree(unittest.TestCase):
    """两条执行路径必须同一套向量：llama_index 那条与免依赖那条排序一致。

    没有这条，两边的向量实现可以悄悄漂移——那时「离线可跑」和「生产可落盘」就是两个
    不同的检索器，谁也不知道线上跑的是哪个。
    """

    @classmethod
    def setUpClass(cls):
        cls.docs = _load_docs()

    def test_llama_index_path_matches_local_path(self):
        if not kn.handbook_available():
            # 缺包时这条路根本不存在，但免依赖那条必须还在——不 skip，直接断言降级可用
            self.assertTrue(kn.search_handbook_local("柜子被人开了", self.docs).hits)
            return
        query = "柜子被人开了"
        remote = kn.HandbookIndex(embed_model="semantic", similarity_top_k=3)
        remote.build(self.docs)
        local = kn.LocalHandbookIndex(embed_model="semantic", similarity_top_k=3)
        local.build(self.docs)
        self.assertEqual(
            [hit.doc_id for hit in remote.query(query, top_k=3)],
            [hit.doc_id for hit in local.query(query, top_k=3)],
        )

    def test_persist_and_reload_keeps_semantic_ordering(self):
        if not kn.handbook_available():
            self.assertEqual(
                kn.HandbookIndex(embed_model="semantic").unavailable_reason() != "", True
            )
            return
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            index = kn.HandbookIndex(embed_model="semantic", similarity_top_k=2)
            index.build(self.docs, persist_dir=tmp)
            reloaded = kn.HandbookIndex.load(tmp, embed_model="semantic", similarity_top_k=2)
            self.assertEqual(reloaded.query("门被撬了", top_k=2)[0].doc_id, "security-alarm")


class TestSemanticBoundary(unittest.TestCase):
    """把「这套语义是什么、不是什么」钉成断言，避免被读成训练出来的模型。"""

    def test_vectors_are_deterministic_and_finite(self):
        first = kn.handbook_vector("供电中断", model="semantic")
        second = kn.handbook_vector("供电中断", model="semantic")
        self.assertEqual(first, second)
        self.assertTrue(all(isinstance(value, float) for value in first))
        self.assertTrue(all(value == value for value in first))  # 不是 NaN

    def test_semantic_vector_has_lexical_plus_concept_blocks(self):
        semantic = kn.handbook_vector("供电中断", model="semantic", dim=64)
        lexical = kn.handbook_vector("供电中断", model="lexical", dim=64)
        self.assertEqual(len(semantic), 64 + len(kn.HANDBOOK_CONCEPTS))
        self.assertEqual(len(lexical), 64)

    def test_concept_axis_fires_on_synonyms_sharing_no_characters(self):
        """「掉电」与「供电中断」共享一个字也没有，概念轴必须把它们放到同一族。"""
        a = kn.handbook_vector("掉电", model="semantic")
        b = kn.handbook_vector("供电中断", model="semantic")
        concept_block = slice(-len(kn.HANDBOOK_CONCEPTS), None)
        concept_cosine = kn._cosine(a[concept_block], b[concept_block])
        self.assertGreater(concept_cosine, 0.3, concept_cosine)
        # 词面块对这两个词几乎无话可说，这是「语义比词面强在哪」的直接证据
        lexical_a = kn.handbook_vector("掉电", model="lexical")
        lexical_b = kn.handbook_vector("供电中断", model="lexical")
        self.assertLess(kn._cosine(lexical_a, lexical_b), concept_cosine)

    def test_known_limit_is_stated_in_docs(self):
        """表外说法覆盖不到——这条边界必须写在代码里，不能只活在口头。"""
        doc = kn.__doc__ or ""
        self.assertIn("HANDBOOK_CONCEPTS", doc)
        self.assertIn("不是训练出来的", doc)

    def test_word_table_is_not_empty_and_axes_are_unique(self):
        names = [name for name, _synonyms in kn.HANDBOOK_CONCEPTS]
        self.assertEqual(len(names), len(set(names)), names)
        for name, synonyms in kn.HANDBOOK_CONCEPTS:
            with self.subTest(axis=name):
                self.assertTrue(synonyms, name)
                self.assertTrue(all(word.strip() for word in synonyms), name)


class TestExistingContractKept(unittest.TestCase):
    """既有契约不许被这次改动弄坏。"""

    LEGACY_DOCS = [
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

    def test_status_uses_model_hashing_name_is_kept(self):
        self.assertEqual(kn.HandbookIndex(embed_model="hashing").status()["uses_model"], "hashing")

    def test_none_model_still_refuses(self):
        with self.assertRaises(kn.EmbeddingUnavailable):
            kn.HandbookIndex().embed_model()

    def test_default_search_model_is_semantic(self):
        self.assertEqual(kn.DEFAULT_HANDBOOK_MODEL, "semantic")

    def test_legacy_smoke_queries_still_hit_on_every_model(self):
        """``test_data_knowledge`` 里那三条老查询，三档都还得答对。"""
        cases = (
            ("载噪比低于多少算异常", "d1"),
            ("周跳怎么检测", "d3"),
            ("接收机怎么重启", "d2"),
        )
        for model in kn.HANDBOOK_MODELS:
            for query, expected in cases:
                with self.subTest(model=model, query=query):
                    hits = kn.rank_handbook(self.LEGACY_DOCS, query, model=model, top_k=1)
                    self.assertEqual(hits[0].doc_id, expected)
                    self.assertEqual(hits[0].metadata["source"], f"manual#{expected[-1]}")


if __name__ == "__main__":
    unittest.main()
