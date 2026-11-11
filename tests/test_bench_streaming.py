# -*- coding: utf-8 -*-
"""引-3 补收口：分块建表 + 亿级压测口径（TDD 先红）。

验收口径（交接文档 D 线 §引-3）：

* 分块建出来的数据集，与一次性建出来的**逐分区逐字节一致**（同一份数据，
  只是不把整表驻留内存）；
* 分块建表时内存占用与**块大小**成正比，与总量无关；
* 压测结果必须可回源：行数、p50/p95 由代码算出，不写死。

亿级压测本身不进单元测试（跑不动 1.9 小时），这里只钉住**让亿级可行的
机制**：流式写、块大小可控、行数与一次性构造一致。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import tools.bench_run as B  # noqa: E402


class StreamingBuildTest(unittest.TestCase):
    def test_chunked_and_oneshot_agree_byte_for_byte(self):
        """分块建表与一次性建表，产出的**数据**必须逐字节相同。

        这条是分块写法的**正确性根据**：只有数据本身相同，分块才是
        「同一份数据换种写法」，而不是「另造一份数据」。

        比对口径分两层：
          * NDJSON 分区：逐字节比（这是数据本体）；
          * Parquet 分区：比**表格内容**，不比容器字节。原因是
            `convert_partition` 会把源 NDJSON 的 `source_mtime_ns` 写进
            schema metadata（用于幂等判定），两次建表的 mtime 必然不同，
            比容器字节只会得到「同一份数据、不同时间戳」的假差异。
        """
        import shutil

        a_root = Path(tempfile.mkdtemp(prefix="fsa-bench-a-"))
        b_root = Path(tempfile.mkdtemp(prefix="fsa-bench-b-"))
        try:
            epochs = 600
            one = B.build_dataset(a_root, epochs=epochs, quiet=True)
            chunked = B.build_dataset(b_root, epochs=epochs, quiet=True,
                                      chunk_epochs=137)
            self.assertEqual(one.rows["obs"], chunked.rows["obs"])
            self.assertEqual(one.rows["tec"], chunked.rows["tec"])
            self.assertEqual(one.rows["agg_hour"], chunked.rows["agg_hour"])
            self.assertEqual(one.rows["agg_daily"], chunked.rows["agg_daily"])

            nd_a = sorted(p.relative_to(a_root).as_posix()
                          for p in a_root.rglob("*.ndjson"))
            nd_b = sorted(p.relative_to(b_root).as_posix()
                          for p in b_root.rglob("*.ndjson"))
            self.assertEqual(nd_a, nd_b)
            self.assertTrue(nd_a, "没有 NDJSON 分区，测试等于没跑")
            for rel in nd_a:
                self.assertEqual(
                    (a_root / rel).read_bytes(), (b_root / rel).read_bytes(),
                    f"{rel} 分块与一次性不一致")

            pq_a = sorted(p.relative_to(a_root).as_posix()
                          for p in a_root.rglob("*.parquet"))
            pq_b = sorted(p.relative_to(b_root).as_posix()
                          for p in b_root.rglob("*.parquet"))
            self.assertEqual(pq_a, pq_b)
            import pyarrow.parquet as pq
            for rel in pq_a:
                left = pq.read_table(a_root / rel)
                right = pq.read_table(b_root / rel)
                self.assertTrue(
                    left.equals(right),
                    f"{rel} 分块与一次性的 Parquet 内容不一致")
        finally:
            shutil.rmtree(a_root, ignore_errors=True)
            shutil.rmtree(b_root, ignore_errors=True)

    def test_chunk_epochs_must_be_positive_when_given(self):
        for bad in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                B.build_dataset(Path(tempfile.gettempdir()) / "fsa-never",
                                epochs=10, chunk_epochs=bad, quiet=True)

    def test_chunk_boundary_matches_prefix(self):
        """分块边界必须正好切开：第 k 块从 start_epoch 起，不重不漏。"""
        total = 250
        chunk = 100
        gathered = []
        for start in range(0, total, chunk):
            n = min(chunk, total - start)
            gathered.extend(B.iter_obs_rows("WUHN", epochs=n, start_epoch=start))
        whole = B.synthetic_obs_rows("WUHN", epochs=total)
        self.assertEqual(len(gathered), len(whole))
        self.assertEqual(gathered, whole)


class RowCountFormulaTest(unittest.TestCase):
    def test_obs_rows_per_epoch_is_stable(self):
        """每历元行数 = 卫星数 × 信号数；1e8 需要多少历元由它算出，不写死。"""
        per_epoch = len(B._sv_list()) * len(B.SIGNALS)
        self.assertEqual(per_epoch, 57)
        rows = B.synthetic_obs_rows("WUHN", epochs=10)
        self.assertEqual(len(rows), 10 * per_epoch)

    def test_epochs_for_target_rows_helper(self):
        """给出目标行数就能算需要的历元数（每站），可复算。"""
        self.assertTrue(hasattr(B, "epochs_for_target_rows"))
        # 2 站 × 57 行/历元
        n = B.epochs_for_target_rows(100_000_000)
        self.assertIsInstance(n, int)
        self.assertEqual(n * 57 * len(B.BENCH_STATIONS) >= 100_000_000, True)
        # 不能为了凑数多出半站：少一个历元就该不够
        self.assertLess((n - 1) * 57 * len(B.BENCH_STATIONS), 100_000_000)


if __name__ == "__main__":
    unittest.main()
