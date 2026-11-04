# 20 条基准 SQL（E4 数据双引擎）

- 状态：**W0 冻结**（2026-11-05）
- 适用：DuckDB（默认）与 ClickHouse（随包）；同一份 Parquet，两个只读引擎
- 关联：ADR-009 §3、`docs/spec/2026-11-04-v4-实施基线.md` §6
- 一句话：**20 条查询覆盖分区裁剪、分位数、窗口、对账、元数据五类；每条给 SQL、预期形状、方言差异。**

---

## 0. 数据契约

### 0.1 逻辑视图

两个引擎都暴露同名逻辑视图；上层只写 DuckDB 兼容子集，方言由适配层翻译。

| 视图 | 粒度 | 分区 | 主要列 |
|---|---|---|---|
| `obs` | 一行 = 一个 system/sv/signal/历元 | `station/date/hour` | `station,receiver_id,epoch_utc,gps_week,gps_tow_s,system,sv,signal,freq_hz,psr_m,adr_cycles,doppler_hz,cn0_dbhz,elev_deg,azim_deg,quality_flag` |
| `tec` | 一行 = 一个 system/sv/历元 | `station/date/hour` | `station,system,sv,signal_pair,epoch_utc,sTEC_TECU,vTEC_TECU,deltaT_TECU,level_offset_TECU,arc_id,quality_flag,elev_deg,azim_deg,ipp_lat_deg,ipp_lon_deg` |
| `agg_hour` | 一行 = station/date/hour/system | `station/date` | `station,date,hour,system,n_obs,n_epochs,n_sv,mean_cn0,p50_cn0,p95_cn0,missing_rate,slip_epochs,qc_reject_rate` |
| `agg_daily` | 一行 = station/date | `station` | `station,date,n_obs,n_epochs,n_sv,mean_cn0,p95_cn0,missing_rate,slip_epochs,tec_mean,tec_p95,coverage_s` |

DuckDB 建视图：

```sql
CREATE VIEW obs AS
SELECT * FROM read_parquet('data/parquet/obs/**/*.parquet',
                           hive_partitioning = true, filename = true);
```

ClickHouse 建视图（适配层生成，`file` 的 `_path` 拆分区）：

```sql
CREATE VIEW obs AS
SELECT *, regexpExtract(_path, '/station=([^/]+)/', 1) AS station,
          toDate(regexpExtract(_path, '/date=([^/]+)/', 1)) AS date,
          toInt32(regexpExtract(_path, '/hour=([0-9]+)/', 1)) AS hour
FROM file('data/parquet/obs/**/*.parquet', 'Parquet');
```

### 0.2 基准集 `bench_v1`

| 项 | 值 |
|---|---|
| 台站 | `WUHN`、`BJFS`（两站同构） |
| 日期 | `2026-10-01`（UTC，单日） |
| 采样 | 1 Hz，86,400 历元/站 |
| 星座/卫星 | GPS 8 + GLONASS 6 + Galileo 5 = 19 SV |
| 信号 | 每 SV 3 路（L1/L2/L5 类） |
| `obs` 行数/站 | 19 × 3 × 86,400 = **4,924,800** |
| `obs` 两站合计 | **9,849,600** |
| `tec` 行数/站 | 19 × 86,400 = **1,641,600** |
| `agg_hour` 行数/站 | 24 × 3 系统 = **72** |
| `agg_daily` 行数/站 | **1** |
| 注入缺测 | `WUHN` 07:00 与 `BJFS` 18:00 的 `cn0_dbhz` 全为 NULL，`quality_flag=1` |
| 注入周跳 | `WUHN` 03:00:00–03:00:11 共 12 历元 × 57 行，`quality_flag=4` |
| 值域 | `cn0_dbhz` 20–60 dB-Hz；`vTEC_TECU` 5–35 TECU；`psr_m` 2.0e7–2.7e7 m |

辅助集：

| 数据集 | 内容 | 用于 |
|---|---|---|
| `fault_v1` | `bench_v1` 的 `WUHN` 删除 03:00:00、11:30:00、19:45:00 三个历元（4,924,797 行） | SQL-13 断档检测 |
| `bench_week_v1` | `agg_daily`，2 站 × 7 天（2026-09-25…2026-10-01）= 14 行 | SQL-18 趋势 |
| `bench_scale_v1` | 1 站 × 203 天 × 86,400 s × 57 序列 ≈ **9.99 亿行**（压测专用，只跑 SQL-01/03/04 的时延与 EV-23 的时延断言，不参与形状断言） | EV-23 亿级行时延 |

所有查询的"预期形状"以 `bench_v1` 为准；换数据集只允许改数字，不允许改列形状。

## 1. 索引

| 编号 | 主题 | 预期行数 | 主要方言差异 |
|---|---|---|---|
| SQL-01 | 单站单日行数/历元数 | 1 | 分区分词与去重函数 |
| SQL-02 | 按系统行数/卫星数 | 3 | `uniqExact` |
| SQL-03 | 每小时行数 | 24 | `toStartOfHour` |
| SQL-04 | CN0 分位数 | 1 | `quantile` vs `quantile_cont` |
| SQL-05 | 按卫星均值/缺测率 | 19 | `countIf` |
| SQL-06 | 质量旗标分布 | 3 | 位运算函数 |
| SQL-07 | 仰角分箱 | 9 | 整数除法 |
| SQL-08 | 周跳密度 | 24 | `bitAnd` |
| SQL-09 | TEC 每小时统计 | 24 | `toStartOfHour` |
| SQL-10 | TEC TopN 卫星 | 5 | `LIMIT BY` vs `QUALIFY` |
| SQL-11 | TEC 梯度超限 | 1 | `quantile` |
| SQL-12 | 两站同日对比 | 2 | `FULL JOIN` |
| SQL-13 | 断档检测 | 3 | `lagInFrame` |
| SQL-14 | 每小时卫星数 | 24 | `uniqExact` |
| SQL-15 | 按信号伪距统计 | 3 | `stddevSamp` |
| SQL-16 | 覆盖时长 | 1 | `dateDiff` |
| SQL-17 | 聚合表对账 | 72 | `FULL JOIN` |
| SQL-18 | 七日趋势 | 14 | 日期函数 |
| SQL-19 | 分区清单 | 48 | 元数据表 vs `_path` |
| SQL-20 | 异常小时 TopN | 10 | 排序 NULL 位置 |

## 2. 逐条

### SQL-01 单站单日行数与历元数

```sql
SELECT station,
       COUNT(*)                    AS rows,
       COUNT(DISTINCT epoch_utc)   AS epochs
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY station;
```

**预期形状**：1 行 × 3 列；`rows = 4,924,800`，`epochs = 86,400`。
**差异**：DuckDB 用 `read_parquet` 的 `hive_partitioning` 直接得到 `station/date`；ClickHouse 的 `file()`
没有 hive 分区推断，适配层从 `_path` 正则拆列。`COUNT(DISTINCT)` 两边同义，CH 大基数时用 `uniqExact`。

### SQL-02 按系统行数与卫星数

```sql
SELECT system,
       COUNT(*)              AS rows,
       COUNT(DISTINCT sv)    AS svs
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY system
ORDER BY system;
```

**预期形状**：3 行 × 3 列；`GAL 1,296,000/5`、`GLO 1,555,200/6`、`GPS 2,073,600/8`（按字典序）。
**差异**：CH 把 `COUNT(DISTINCT sv)` 翻成 `uniqExact(sv)`；`ORDER BY system` 的排序规则两边都是二进制序。

### SQL-03 每小时行数（分区裁剪）

```sql
SELECT hour, COUNT(*) AS rows
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY hour
ORDER BY hour;
```

**预期形状**：24 行 × 2 列；每小时 `205,200`（57 序列 × 3,600 s），合计 4,924,800。
**差异**：DuckDB 可直接 `GROUP BY hour`（分区列）；CH 分区列是适配层算出的，若要按真实时间分组用
`toStartOfHour(epoch_utc)`，二者结果一致。分区裁剪必须只扫 24 个文件，`EXPLAIN` 的行数上限见 SQL-19 校验。

### SQL-04 CN0 分位数

```sql
SELECT COUNT(cn0_dbhz)                            AS n,
       quantile_cont(cn0_dbhz, 0.50)              AS p50,
       quantile_cont(cn0_dbhz, 0.95)              AS p95,
       quantile_cont(cn0_dbhz, 0.99)              AS p99
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01';
```

**预期形状**：1 行 × 4 列；`n = 4,719,600`（去掉 07:00 的 205,200 个 NULL）；
`p50 ∈ [42, 48]`、`p95 ∈ [50, 56]`、`p99 ∈ [52, 59]` dB-Hz。
**差异**：DuckDB `quantile_cont` 是线性插值；CH 用 `quantile(0.95)(cn0_dbhz)`（同样跳过 NULL）。
要"近似即可"时 CH 用 `quantileTDigest`，DuckDB 用 `approx_quantile`，但基准必须用精确版。

### SQL-05 按卫星均值与缺测率

```sql
SELECT system, sv,
       COUNT(*)                                        AS rows,
       AVG(cn0_dbhz)                                   AS mean_cn0,
       COUNT(*) FILTER (WHERE cn0_dbhz IS NULL) * 1.0
         / COUNT(*)                                    AS missing_rate
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY system, sv
ORDER BY system, sv;
```

**预期形状**：19 行 × 5 列；每颗星 `rows = 259,200`；`missing_rate = 0.041667`（3,600/86,400，按行计）；
`mean_cn0 ∈ [35, 55]`。
**差异**：`FILTER` 是 DuckDB/PostgreSQL 语法；CH 翻成 `countIf(cn0_dbhz IS NULL)`。
`AVG` 两边都跳过 NULL，不能改写成 `SUM/COUNT(*)`，否则分母含义变了。

### SQL-06 质量旗标分布

```sql
SELECT quality_flag, COUNT(*) AS rows
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY quality_flag
ORDER BY quality_flag;
```

**预期形状**：3 行 × 2 列；`0 → 4,718,916`、`1 → 205,200`、`4 → 684`，合计 4,924,800。
**差异**：无实质差异；CH 的 `ORDER BY` 对整数同样升序。若旗标是位掩码，先 `bitAnd(flag, 4)` 再分组（见 SQL-08）。

### SQL-07 仰角分箱

```sql
SELECT CAST(FLOOR(elev_deg / 10) * 10 AS INTEGER) AS elev_bin,
       COUNT(*)                                   AS rows,
       AVG(cn0_dbhz)                              AS mean_cn0
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY elev_bin
ORDER BY elev_bin;
```

**预期形状**：9 行 × 3 列（0…80，步长 10）；各行 `rows` 之和 = 4,924,800；低仰角 `mean_cn0` 低于高仰角。
**差异**：`FLOOR` 两边都有；CH 的 `CAST(... AS Int32)` 与 DuckDB `INTEGER` 等价。
DuckDB 对 `GROUP BY` 别名友好，CH 也支持别名；都不需要重复表达式。

### SQL-08 周跳密度

```sql
SELECT hour,
       COUNT(*)                                                  AS rows,
       COUNT(*) FILTER (WHERE (quality_flag & 4) <> 0)           AS slip_rows,
       COUNT(*) FILTER (WHERE (quality_flag & 4) <> 0) * 1.0
         / COUNT(*)                                              AS slip_rate
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY hour
ORDER BY slip_rate DESC, hour
LIMIT 5;
```

**预期形状**：5 行 × 4 列；`hour = 3` 的 `slip_rows = 684`、`slip_rate = 0.003333`，其余 4 行 `slip_rows = 0`。
**差异**：DuckDB 位与用 `&`；CH 用 `bitAnd(quality_flag, 4)`，且 CH 的 `&` 也可用但适配层统一翻成函数。
`FILTER` → `countIf`；`LIMIT` 两边同义。

### SQL-09 TEC 每小时统计

```sql
SELECT hour,
       COUNT(*)          AS rows,
       AVG(vTEC_TECU)    AS mean_vtec,
       MAX(vTEC_TECU)    AS max_vtec,
       MIN(vTEC_TECU)    AS min_vtec
FROM tec
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY hour
ORDER BY hour;
```

**预期形状**：24 行 × 5 列；每小时 `rows = 68,400`（19 SV × 3,600 s）；`mean_vtec ∈ [10, 30]`；
`max_vtec - min_vtec ∈ [5, 30]`。
**差异**：与 SQL-03 相同，`hour` 是分区列；若按时间戳分组，DuckDB `date_trunc('hour', epoch_utc)`，
CH `toStartOfHour(epoch_utc)`。

### SQL-10 TEC TopN 卫星

```sql
SELECT sv, AVG(vTEC_TECU) AS mean_vtec, MAX(vTEC_TECU) AS max_vtec
FROM tec
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY sv
ORDER BY mean_vtec DESC
LIMIT 5;
```

**预期形状**：5 行 × 3 列；`mean_vtec` 降序；每行 `max_vtec >= mean_vtec`。
**差异**：单站 TopN 两边都用 `ORDER BY ... LIMIT 5`。若要"每站 TopN"，DuckDB 用
`QUALIFY row_number() OVER (PARTITION BY station ORDER BY mean_vtec DESC) <= 5`；
CH 用 `ORDER BY mean_vtec DESC LIMIT 5 BY station`（`LIMIT BY` 是 CH 专有）。

### SQL-11 TEC 梯度超限计数

```sql
SELECT COUNT(*)                                              AS n,
       COUNT(*) FILTER (WHERE ABS(deltaT_TECU) > 0.5)        AS n_exceed,
       quantile_cont(ABS(deltaT_TECU), 0.95)                 AS p95_abs_delta
FROM tec
WHERE station = 'WUHN' AND date = DATE '2026-10-01';
```

**预期形状**：1 行 × 3 列；`n = 1,641,600`；`n_exceed ∈ [4000, 6000]`；`p95_abs_delta ∈ [0.20, 0.50]` TECU。
**差异**：`FILTER` → `countIf`；`quantile_cont` → `quantile(0.95)`；`ABS` 两边同名。

### SQL-12 两站同日对比

```sql
SELECT station,
       COUNT(*)               AS rows,
       AVG(cn0_dbhz)          AS mean_cn0,
       COUNT(*) FILTER (WHERE cn0_dbhz IS NULL) * 1.0 / COUNT(*) AS missing_rate
FROM obs
WHERE date = DATE '2026-10-01' AND station IN ('WUHN','BJFS')
GROUP BY station
ORDER BY station;
```

**预期形状**：2 行 × 4 列；两站 `rows = 4,924,800`；`missing_rate` 都 ≈ 0.041667；`mean_cn0` 两站差值 ≤ 2 dB-Hz。
**差异**：无；若要"宽表对比"（一行两站），DuckDB/CH 都支持 `FULL OUTER JOIN` + `COALESCE`，
CH 的 `FULL JOIN` 需要 `SET join_use_nulls = 1` 才能得到 NULL 而不是默认值。

### SQL-13 断档检测（`fault_v1`）

```sql
WITH epochs AS (
  SELECT epoch_utc,
         LAG(epoch_utc) OVER (ORDER BY epoch_utc) AS prev_utc
  FROM obs
  WHERE station = 'WUHN' AND date = DATE '2026-10-01'
  GROUP BY epoch_utc
)
SELECT prev_utc, epoch_utc,
       date_diff('second', prev_utc, epoch_utc) AS gap_s
FROM epochs
WHERE prev_utc IS NOT NULL
  AND date_diff('second', prev_utc, epoch_utc) > 1
ORDER BY epoch_utc;
```

**预期形状**：3 行 × 3 列；三处 `gap_s = 2`（03:00:00、11:30:00、19:45:00 各缺 1 个历元）。
**差异**：DuckDB `date_diff('second', a, b)`；CH `dateDiff('second', a, b)`（大小写不同）。
CH 的窗口 `lag` 默认只看当前块；跨分区要 `lagInFrame(epoch_utc, 1) OVER (ORDER BY epoch_utc
ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)`。`GROUP BY epoch_utc` 先用 `WHERE` 裁到单站单日。

### SQL-14 每小时卫星数

```sql
SELECT hour, COUNT(DISTINCT sv) AS n_sv, COUNT(DISTINCT system) AS n_system
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY hour
ORDER BY hour;
```

**预期形状**：24 行 × 3 列；`n_sv = 19`、`n_system = 3` 每行恒定（基准集无遮挡）。
**差异**：CH 用 `uniqExact(sv)`；若允许近似，CH `uniq`、DuckDB `approx_count_distinct` 会给出
可能小于 19 的值，基准**不许**用近似。

### SQL-15 按信号伪距统计

```sql
SELECT signal,
       COUNT(*)             AS rows,
       AVG(psr_m)           AS mean_psr,
       STDDEV_SAMP(psr_m)   AS sd_psr
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01'
GROUP BY signal
ORDER BY signal;
```

**预期形状**：3 行 × 4 列；每行 `rows = 1,641,600`；`mean_psr ∈ [2.0e7, 2.7e7]`；`sd_psr > 0`。
**差异**：`STDDEV_SAMP` → CH `stddevSamp`（无下划线）。样本标准差两边都是 n-1；不要改成总体标准差。

### SQL-16 覆盖时长

```sql
SELECT MIN(epoch_utc) AS first_utc,
       MAX(epoch_utc) AS last_utc,
       COUNT(DISTINCT epoch_utc) AS epochs,
       date_diff('second', MIN(epoch_utc), MAX(epoch_utc)) AS coverage_s
FROM obs
WHERE station = 'WUHN' AND date = DATE '2026-10-01';
```

**预期形状**：1 行 × 4 列；`first_utc = 2026-10-01 00:00:00`、`last_utc = 23:59:59`、
`epochs = 86,400`、`coverage_s = 86,399`；覆盖率 `epochs / 86400 = 1.0`。
**差异**：`date_diff` → CH `dateDiff`；时间类型：DuckDB `TIMESTAMP`（无时区），CH `DateTime`（时区在服务端）。
基准统一按 UTC 存，CH 会话设 `timezone='UTC'`，否则 `MIN/MAX` 会偏 8 小时。

### SQL-17 聚合表对账

```sql
WITH hourly AS (
  SELECT station, date, hour, system, COUNT(*) AS n_obs
  FROM obs
  WHERE station = 'WUHN' AND date = DATE '2026-10-01'
  GROUP BY station, date, hour, system
)
SELECT h.hour, h.system, h.n_obs, a.n_obs AS agg_n_obs,
       COALESCE(h.n_obs, -1) - COALESCE(a.n_obs, -1) AS diff
FROM hourly h
FULL OUTER JOIN agg_hour a
  ON a.station = h.station AND a.date = h.date
 AND a.hour = h.hour AND a.system = h.system
ORDER BY h.hour, h.system;
```

**预期形状**：72 行 × 5 列（24 小时 × 3 系统），`diff` 全为 0。加
`WHERE COALESCE(h.n_obs, -1) <> COALESCE(a.n_obs, -1)` 后应为 0 行；非 0 即对账失败。
**差异**：`FULL OUTER JOIN` 两边都支持；CH 需 `join_use_nulls=1` 才能让缺失侧为 NULL。
`COALESCE` 同义。DuckDB 的 `date` 是 DATE，CH 是 Date，比较前不用转。

### SQL-18 七日趋势（`bench_week_v1`）

```sql
SELECT date, station, n_obs, mean_cn0, missing_rate
FROM agg_daily
WHERE station IN ('WUHN','BJFS')
  AND date BETWEEN DATE '2026-09-25' AND DATE '2026-10-01'
ORDER BY date, station;
```

**预期形状**：14 行 × 5 列（2 站 × 7 天）；每天每站 1 行；`n_obs` 单调不降（数据完整）。
**差异**：日期字面量 `DATE '...'` 两边都认；CH 的 `Date` 范围查询会走分区裁剪，DuckDB 走
`station/date` hive 分区。不要用 `BETWEEN` 包字符串，CH 会按本地时区解析。

### SQL-19 分区清单与行数

```sql
SELECT regexp_extract(filename, '/station=([^/]+)/', 1) AS station,
       regexp_extract(filename, '/date=([^/]+)/', 1)    AS date,
       CAST(regexp_extract(filename, '/hour=([0-9]+)/', 1) AS INTEGER) AS hour,
       COUNT(*) AS rows
FROM read_parquet('data/parquet/obs/**/*.parquet',
                  hive_partitioning = true, filename = true)
GROUP BY station, date, hour
ORDER BY station, hour;
```

**预期形状**：48 行 × 4 列（2 站 × 24 小时）；每行 `rows = 205,200`；合计 9,849,600。
**差异**：这是差异最大的一条。DuckDB 用 `filename=true` + `regexp_extract`；
CH 的 `file()` 暴露 `_path` 虚拟列，用 `regexpExtract(_path, ...)`；若数据已灌入 MergeTree，
则查 `system.parts` 的 `path/rows/partition`，不再读 Parquet。适配层必须把三种写法统一成同一结果形状。

### SQL-20 异常小时 TopN

```sql
SELECT station, hour,
       n_obs, missing_rate, slip_epochs,
       ROUND(missing_rate * 100, 2) AS missing_pct
FROM agg_hour
WHERE date = DATE '2026-10-01'
ORDER BY missing_rate DESC, slip_epochs DESC, station, hour
LIMIT 10;
```

**预期形状**：10 行 × 6 列；前两行 `missing_rate = 1.0`（`WUHN/07`、`BJFS/18`），
第三行 `WUHN/03` 的 `slip_epochs = 684`、`missing_rate = 0`。
**差异**：排序默认 NULL 位置不同：DuckDB `DESC` 默认 NULLS FIRST，CH 默认 NULLS LAST。
适配层必须显式写 `NULLS LAST`（或 `ORDER BY ... DESC NULLS LAST`），否则同一 SQL 两边 TopN 不一致。
`ROUND` 两边同义，但 CH 返回 `Float64`，DuckDB 返回 `DOUBLE`，序列化都按数值处理。

## 3. 基准执行协议

1. **同一份 Parquet**：两引擎读同一个 `data/parquet/`，不复制、不转换中间表（CH 原生表只用于对照，不作为真相）。
2. **每条第 3 次运行取中位数**：冷启动不计；缓存策略两边一致（DuckDB `PRAGMA enable_object_cache`，CH `USE_CACHE` 不影响正确性）。
3. **通过条件**：结果形状一致（列名/列数/行数），数值差 ≤ 1e-6（浮点）或完全相等（计数）；
   单站单日 ≤ 1.5 s，聚合表 ≤ 200 ms（ADR-009 §3）。
4. **不允许**：为了跑通改 SQL 语义；只允许适配层做方言翻译（`quantile_cont→quantile`、`FILTER→countIf`、
   `date_diff→dateDiff`、`STDDEV_SAMP→stddevSamp`、`&→bitAnd`、`LIMIT BY` 的等价改写）。
5. **失败处置**：任一引擎结果不一致，先判"方言翻译错"还是"数据/聚合错"；后者回 W8 重建聚合，
   前者补翻译用例。两边都不许静默回落到另一引擎的结果。

## 4. 与实现侧 `src/fieldstation/data/` 的对齐

共享检出里已有一组 W8 的可执行基准 `src/fieldstation/data/bench.py`（`B01`–`B20`，面向
`synthetic_records()` 的 960 行小样本）与方言翻译 `src/fieldstation/data/dialects.py`。
它们与本契约的关系必须写死，避免出现两套都叫"20 条基准"：

| 项 | 现状 | W8 处置 |
|---|---|---|
| 基准编号 | 实现侧 `B01`–`B20`；本契约 `SQL-01`–`SQL-20` | 二选一：把 `BENCHMARKS` 重写为本契约 20 条（推荐），或保留 `B01`–`B20` 作冒烟集、另建 `bench_v1` 跑本契约 |
| 样本 | 实现侧 4 站 × 6 小时 × 40 行/小时 = 960 行 | `bench_v1` 按 §0.2 生成；行数用于断言，不用小样本代替 |
| 站名 | 实现侧默认 `WUHN/BJFS/SHAO/URUM` | 本契约用 `WUHN/BJFS`，与默认站名一致 |
| 时间桶 | `dialects.py` 已支持 `time_bucket` / `date_trunc` → `toStartOf*` | 直接复用 |
| 其余方言 | `dialects.py` 目前不翻译 `FILTER`、`quantile_cont`、`date_diff`、`STDDEV_SAMP`、`&` | W8 必须补这五类改写，或为每条查询维护 CH 变体；不许让 CH 静默跑错 |

补翻译的最小清单（对应本契约用到的写法）：

| 上游（DuckDB 子集） | ClickHouse | 备注 |
|---|---|---|
| `COUNT(*) FILTER (WHERE p)` | `countIf(p)` | 只支持单条件；多条件用 `countIf(p1 AND p2)` |
| `quantile_cont(x, q)` | `quantile(q)(x)` | 精确分位；近似另用 `quantileTDigest` |
| `date_diff('second', a, b)` | `dateDiff('second', a, b)` | 大小写 |
| `STDDEV_SAMP(x)` | `stddevSamp(x)` | 样本标准差 |
| `quality_flag & 4` | `bitAnd(quality_flag, 4)` | 位掩码 |
| `LIMIT n` / `LIMIT o, n` | `LIMIT n` / `LIMIT n OFFSET o` | 已实现 |

对齐完成前，`python -m fieldstation.data.bench` 的通过**不能**当作"20 条基准 SQL 通过"的证据；
报告里必须写清跑的是哪一组（`B*` 还是 `SQL-*`）以及数据集（`synthetic_records` 还是 `bench_v1`）。
