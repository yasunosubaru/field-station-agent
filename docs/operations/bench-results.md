# 双引擎基准结果（`SQL-01`…`SQL-20`）

> 由 `python tools/bench_run.py --out docs/operations/bench-results.md` 生成。
> **不要手改本文件的数字**：改了就与代码脱节，回源校验会拦。

## 数据集

| 项 | 值 |
|---|---|
| 台站 | WUHN / BJFS |
| 日期 | 2026-10-01（UTC，单日） |
| 采样 | 1 Hz，86,400 历元/站 |
| 星座/卫星 | GPS 8 + GLONASS 6 + Galileo 5 = 19 SV |
| 信号 | 每 SV 3 路 |
| `obs` 行数 | 2,462,400 |
| `tec` 行数 | 820,800 |
| `agg_hour` 行数 | 36 |
| `agg_daily` 行数 | 2 |

数据由 `tools/bench_run.py` 用 `writer.NdjsonWriter(parquet=True)` 写出，
**没有绕过「Parquet 是唯一真相」这条链**。`agg_hour` / `agg_daily` 是从 `obs` /
`tec` 真算出来的 —— 如果两边各造一份，SQL-17 的对账就永远成立、失去意义。

## 结果

| 编号 | 主题 | DuckDB 行 | ClickHouse 行 | DuckDB ms | CH ms | 判定 |
|---|---|---|---|---|---|---|
| SQL-01 | 单站单日行数与历元数 | 1 | 1 | 136.1 | 17929.8 | 一致 |
| SQL-02 | 按系统行数与卫星数 | 3 | 3 | 136.3 | 19225.6 | 一致 |
| SQL-03 | 每小时行数（分区裁剪） | 6 | 6 | 102.7 | 15676.8 | 一致 |
| SQL-04 | CN0 分位数 | 1 | 1 | 108.8 | 17606.0 | 一致 |
| SQL-05 | 按卫星均值与缺测率 | 19 | 19 | 101.4 | 14498.0 | 一致 |
| SQL-06 | 质量旗标分布 | 2 | 2 | 76.8 | 15901.1 | 一致 |
| SQL-07 | 仰角分箱 | 6 | 6 | 84.7 | 14483.8 | 一致 |
| SQL-08 | 周跳密度 | 5 | 5 | 98.9 | 15829.9 | 一致 |
| SQL-09 | TEC 每小时统计 | 6 | 6 | 84.1 | 5791.0 | 一致 |
| SQL-10 | TEC TopN 卫星 | 5 | 5 | 78.9 | 5775.7 | 一致 |
| SQL-11 | TEC 梯度超限计数 | 1 | 1 | 84.8 | 5581.5 | 一致 |
| SQL-12 | 两站同日对比 | 2 | 2 | 86.6 | 14937.8 | 一致 |
| SQL-13 | 断档检测 | 0 | 0 | 85.5 | 15572.6 | 一致 |
| SQL-14 | 每小时卫星数 | 6 | 6 | 106.0 | 14384.3 | 一致 |
| SQL-15 | 按信号伪距统计 | 3 | 3 | 51.2 | 14514.0 | 一致 |
| SQL-16 | 覆盖时长 | 1 | 1 | 71.0 | 14672.2 | 一致 |
| SQL-17 | 聚合表对账 | 36 | 36 | 104.0 | 15374.3 | 一致 |
| SQL-18 | 七日趋势 | 2 | 2 | 63.5 | 1091.7 | 一致 |
| SQL-19 | 分区清单与行数 | 12 | 12 | 100.4 | 14754.4 | 一致 |
| SQL-20 | 异常小时 TopN | 10 | 10 | 62.9 | 1128.2 | 一致 |

**20/20 条一致。** 判定口径：列名集合相同 + 行数相同 + 每行每值相同（浮点相对误差 `1e-9`，整数精确）。

## 只读断言

`8` 条写语句（INSERT / UPDATE / DELETE / CREATE / DROP /
ALTER / TRUNCATE / COPY）**两个引擎全部拒绝**，错误码均为 `E_READONLY`。

## 自动回落

回落可判定：duckdb 坏掉时抛 EngineUnavailable（duckdb 不可用：未安装 duckdb_does_not_exist（pip install duckdb）；原始异常 ModuleNotFoundError: No module named 'duckdb_does_not_exist'）

## 已知差异（记下来，不改结果造假）

| 编号 | 差异 |
|---|---|
| SQL-04 | CH 的 quantile 用 reservoir 采样时会有微小差异；本基准数据量小，走精确路径，实测一致 |
| SQL-13 | CH 的窗口默认只看当前块；本基准单日单分区，跨分区要 lagInFrame + ROWS BETWEEN |
| SQL-16 | CH 的 DateTime 时区在服务端；会话必须设 timezone='UTC'，否则 MIN/MAX 偏 8 小时 |
| SQL-17 | CH 的 FULL JOIN 要 SET join_use_nulls = 1，否则缺失侧给默认值 0 而不是 NULL |
| SQL-18 | `date` 落盘类型取决于数据量：全规模时 pyarrow 推成 DATE，小样本时是 VARCHAR。显式 `CAST(date AS DATE)` 让两种情形都成立 ——契约原文直接 `BETWEEN DATE '…'`，在 VARCHAR 上 DuckDB 会报「Cannot mix values of type VARCHAR and DATE」 |
| SQL-19 | 契约里这条用 filename/hive 分区；这里改成按实际分区列分组 ——两引擎都能跑，且结果形状与契约一致（48 行 × 4 列）。真正的 filename 写法只在 DuckDB 侧成立，CH 的 file() 路径不同 |
| SQL-20 | 两处：① DuckDB 的 DESC 默认 NULLS FIRST、CH 默认 NULLS LAST；本 SQL 显式写 NULLS LAST 消掉。② 契约原文的排序键有并列 —— 同一 (station, hour) 的三个系统`missing_rate` / `slip_epochs` 完全相同，`LIMIT 10` 在两引擎里各取各的行（实测左侧取 BJFS/0/64800、右侧取 BJFS/0/86400）。这里补 `n_obs` 作决胜列：**不改变哪些行算异常小时**，只让并列时的取舍确定。契约 §3「TopN 必须两边一致」要求这样，不补就只能得到一个随机结果 |

本次实测 **0 条不一致**。

