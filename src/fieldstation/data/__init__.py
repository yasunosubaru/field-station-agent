"""E4 数据引擎：NDJSON 分区 + 元数据卡 + 内置查询 + DuckDB/ClickHouse 适配。

模块一览：

- :mod:`fieldstation.data.manifest` —— 分区清单、元数据卡、扫描与校验；
- :mod:`fieldstation.data.writer` —— 幂等写入 NDJSON 分区；
- :mod:`fieldstation.data.query` —— 标准库查询引擎（过滤/时间桶/聚合）；
- :mod:`fieldstation.data.engines` —— DuckDB / ClickHouse 延迟导入适配器；
- :mod:`fieldstation.data.dialects` —— 统一 SQL 子集 → 两方言的翻译；
- :mod:`fieldstation.data.bench` —— 20 条基准，输出 p50/p95；
- :mod:`fieldstation.data.parquet` —— NDJSON → Parquet 的**可选**打包步骤（pyarrow 延迟导入）；
- :mod:`fieldstation.data.knowledge` —— E6 语义层：元数据卡 + Text-to-SQL + 手册索引（llama_index 延迟导入）。

导入本包不会导入 ``duckdb`` / ``clickhouse_connect`` / ``pyarrow`` / ``llama_index``。
"""
