# Graph 列序分析：`_Mean` 与 `Signals_*` 两组列的顺序

> 目标：把 `GNSS Signal Strength.csv` 的 `_Mean` 列组、`Satellites and Signals.csv` 的 `Signals_*` 列组
> 的**列顺序**从数据里逼出来，或给出可证伪的否定结论。
>
> 结论（先给）：**未解**。两组顺序都无法用"枚举序 / 首次出现序 / 通道位序 / 计数或均值序 /
> 单一名称序"中的任何一条解释，也无法用 204 336 组哈希族模型（12 种键 × 11 种哈希 × 3 种插入序 ×
> 4 种桶迭代约定 × 129 种表长）同时解释两张图；逐笔证据与已排除清单见 §3、§4。
> 原生模块的符号表已把**容器类型**读了出来（`std::unordered_map<std::string, METRIC_MEAN>` 与
> `std::unordered_map<ALL_SIGNAL, signalinfo>`，见 §5.4），但列序仍不能由此闭合（§5.6）。
> `packages/graph/src/range-charts.ts` 因此**保持抄表**（`MEAN_ORDER` / `SIGNALS_ORDER`），换输入会退化。
>
> 复现：`node 逆向/tools/colorder-analysis.ts`（只读 golden + `clean-9600.gps`，无外部依赖；
> 四段输出依次为 ①实测列序 ②七种候选规则 ③哈希族穷举 ④`c_status` 位域）。

素材（全部为仓库内既有文件）：

| 用途 | 路径 |
|---|---|
| golden A | `00_来源/samples/graph/export/csv/GNSS Signal Strength.csv`（75 列） |
| golden B | `00_来源/samples/graph/export/csv/Satellites and Signals.csv`（20 列） |
| 输入抓包 | `00_来源/samples/convert/clean-9600.gps`（270 864 B，RANGE 100 条，60 obs/条） |
| 原生模块 | `01_解包/Graph/resources/native_modules/{windows,linux}/graph-node-wrapper.node` |

---

## 1. 实测列序（事实，与任何规则无关）

### 1.1 两组列在原文件里的位置

- `GNSS Signal Strength.csv`：表头 75 列 = `timestamp` + **60 列逐卫星** + **14 列 `_Mean`**（下标 61..74）。
- `Satellites and Signals.csv`：表头 20 列 = `timestamp` + 每组 14 个 `Signals_*` + 3 个 `Satellites_*`
  + `Signals_Total` + `Satellites_Total`（下标 1..17 是被讨论的两组）。

两组的顺序**互不相同**（这一点是排除"单一固定表"的最直接证据）：
同一份输入、同一批 14 个 `(system, signal)`，两张图的相对顺序不一样。

### 1.2 `_Mean` 组（`GNSS Signal Strength.csv`，下标 61..74）

| # | 列名 | system | signal（5 位） | 首次出现 block | 出现次数 | C/No 均值 | PRN 范围 |
|---:|---|---:|---:|---:|---:|---:|---|
| 61 | `GPS_L1_CA_Mean` | 0 | 0 | 0 | 900 | 47.219 | 2..31 |
| 62 | `GPS_L2_PY_Mean` | 0 | 9 | 1 | 900 | 46.445 | 2..31 |
| 63 | `GPS_L2_CM_Mean` | 0 | 17 | 2 | 700 | 47.882 | 4..31 |
| 64 | `GPS_L1_CP_Mean` | 0 | 16 | **27** | 100 | 52.341 | 4..4 |
| 65 | `GPS_L5_Q_Mean` | 0 | 14 | 8 | 500 | 52.392 | 4..27 |
| 66 | `BEIDOU_B2I_D1_Mean` | 4 | 1 | 40 | 100 | 51.190 | 10..10 |
| 67 | `BEIDOU_B1I_D2_Mean` | 4 | 4 | **45** | 400 | 49.222 | 1..4 |
| 68 | `BEIDOU_B3I_D2_Mean` | 4 | 6 | **46** | 400 | 44.319 | 1..4 |
| 69 | `BEIDOU_B1I_D1_Mean` | 4 | 0 | **39** | 800 | 48.781 | 7..29 |
| 70 | `BEIDOU_B3I_D1_Mean` | 4 | 2 | 41 | 400 | 45.352 | 7..14 |
| 71 | `QZSS_L1_CA_Mean` | 5 | 0 | 31 | 200 | 46.967 | 194..199 |
| 72 | `QZSS_L2_CM_Mean` | 5 | 17 | 32 | 200 | 53.475 | 194..199 |
| 73 | `QZSS_L1_CP_Mean` | 5 | 16 | **34** | 200 | 47.132 | 194..199 |
| 74 | `QZSS_L5_Q_Mean` | 5 | 14 | 33 | 200 | 53.163 | 194..199 |

按星座切开（这就是需要解释的"靶序"）：

```
GPS    : (0,0) (0,9) (0,17) (0,16) (0,14)        signal 0 9 17 16 14
BEIDOU : (4,1) (4,4) (4,6)  (4,0)  (4,2)         signal 1 4 6 0 2
QZSS   : (5,0) (5,17) (5,16) (5,14)              signal 0 17 16 14
```

### 1.3 `Signals_*` 组（`Satellites and Signals.csv`，下标 1..17）

| # | 列名 | system | signal（5 位） | 首次出现 block | 出现次数 |
|---:|---|---:|---:|---:|---:|
| 1 | `Signals_GPS_L2_PY` | 0 | 9 | 1 | 900 |
| 2 | `Signals_GPS_L1_CA` | 0 | 0 | 0 | 900 |
| 3 | `Signals_GPS_L1_CP` | 0 | 16 | 27 | 100 |
| 4 | `Signals_GPS_L2_CM` | 0 | 17 | 2 | 700 |
| 5 | `Signals_GPS_L5_Q` | 0 | 14 | 8 | 500 |
| 6 | `Satellites_GPS` | — | — | — | — |
| 7 | `Signals_BEIDOU_B1I_D2` | 4 | 4 | 45 | 400 |
| 8 | `Signals_BEIDOU_B3I_D2` | 4 | 6 | 46 | 400 |
| 9 | `Signals_BEIDOU_B2I_D1` | 4 | 1 | 40 | 100 |
| 10 | `Signals_BEIDOU_B1I_D1` | 4 | 0 | 39 | 800 |
| 11 | `Signals_BEIDOU_B3I_D1` | 4 | 2 | 41 | 400 |
| 12 | `Satellites_BEIDOU` | — | — | — | — |
| 13 | `Signals_QZSS_L5_Q` | 5 | 14 | 33 | 200 |
| 14 | `Signals_QZSS_L1_CA` | 5 | 0 | 31 | 200 |
| 15 | `Signals_QZSS_L1_CP` | 5 | 16 | 34 | 200 |
| 16 | `Signals_QZSS_L2_CM` | 5 | 17 | 32 | 200 |
| 17 | `Satellites_QZSS` | — | — | — | — |

靶序：

```
GPS    : signal 9 0 16 17 14
BEIDOU : signal 4 6 1 0 2
QZSS   : signal 14 0 16 17
```

### 1.4 两组靶序的差异（逐星座）

| 星座 | `_Mean` | `Signals_*` | 差异 |
|---|---|---|---|
| GPS | `0 9 17 16 14` | `9 0 16 17 14` | 完全不同的置换（仅末位 `14` 相同） |
| BEIDOU | `1 4 6 0 2` | `4 6 1 0 2` | 前三位整体轮换，末两位 `0 2` 相同 |
| QZSS | `0 17 16 14` | `14 0 16 17` | 完全不同的置换 |

`14/14` 列一个不差地出现在两张图里，但顺序不同 → **列集合相同、排序机制不同**。
这排除了"存在一张全局固定的信号顺序表（两张图共用）"。

### 1.5 对照：逐卫星列（这条规则已解，作为正样本）

60 列逐卫星列的顺序是 `(system 升, PRN 升, 72 名字枚举位次升)`，60/60 完全成立
（`03_分析/06_Graph应用.md §11.3`）。即：**同一个文件里，"枚举位次"对逐卫星列有效，
对 `_Mean` / `Signals_*` 无效**——两条路径不是同一个排序函数。

### 1.6 `c_status` 位域实测（每个 `(system, signal)` 取首个观测）

供后续检验"通道号/频率号排序"用。列 `bits0-5` = `c_status & 0x3F`，`bits6-15` = `(c>>6)&0x3FF`。

| 组 | c_status | bits0-5 | bits6-15 | system | sig5 | bits26-31 |
|---|---|---:|---:|---:|---:|---:|
| GPS_L1_CA | `0x18109c04` | 4 | 624 | 0 | 0 | 6 |
| GPS_L2_PY | `0x11303c0b` | 11 | 240 | 0 | 9 | 4 |
| GPS_L2_CM | `0x02309c0b` | 11 | 624 | 0 | 17 | 0 |
| GPS_L5_Q | `0x01d03c44` | 4 | 241 | 0 | 14 | 0 |
| GPS_L1_CP | `0x42109da4` | 36 | 630 | 0 | 16 | 16 |
| QZSS_L1_CA | `0x18159e04` | 4 | 632 | 5 | 0 | 6 |
| QZSS_L2_CM | `0x02359e0b` | 11 | 632 | 5 | 17 | 0 |
| QZSS_L5_Q | `0x01d53e04` | 4 | 248 | 5 | 14 | 0 |
| QZSS_L1_CP | `0x42159e04` | 4 | 632 | 5 | 16 | 16 |
| BEIDOU_B1I_D1 | `0x08149f04` | 4 | 636 | 4 | 0 | 2 |
| BEIDOU_B2I_D1 | `0x00349f04` | 4 | 636 | 4 | 1 | 0 |
| BEIDOU_B3I_D1 | `0x50543f04` | 4 | 252 | 4 | 2 | 20 |
| BEIDOU_B1I_D2 | `0x18949fc4` | 4 | 639 | 4 | 4 | 6 |
| BEIDOU_B3I_D2 | `0x50d43fc4` | 4 | 255 | 4 | 6 | 20 |

低 5 位（`c_status & 0x1F`）实测恒为 `4`（GPS_L1_CP 也是 4；只有 `bits0-5` 在 GPS_L1_CP 上变成 36）
→ **低 5 位不是通道号**，也不可能是列序键（14 组里 14 组同值）。

---

## 2. RANGE 观测在帧内的真实顺序（供"首次出现序"用）

`RANGE` 每条记录 60 个 `obs[]`，记录内顺序**既不是 PRN 序也不是枚举序**，实测（第 1 条记录）：

```
i=0..2   GPS 7  : signal 0, 9, 17
i=3..4   GPS 16 : 0, 9
i=5..8   GPS 26 : 0, 9, 17, 14
i=9..10  GPS 2  : 0, 9
i=11..14 GPS 8  : 0, 9, 17, 14
i=15..18 GPS 9  : 0, 9, 17, 14
i=19..22 GPS 27 : 0, 9, 17, 14
i=23..27 GPS 4  : 0, 9, 17, 14, 16   ← L1_CP 在同一颗星里排在最后
i=28..30 GPS 31 : 0, 9, 17
i=31..34 QZSS 199: 0, 17, 14, 16
i=35..38 QZSS 194: 0, 17, 14, 16
i=39..41 BDS 10 : 0, 1, 2
i=42..44 BDS 29/26/21 : 0
i=45..46 BDS 4  : 4, 6
i=47     BDS 24 : 0
i=48..53 BDS 2/1/3 : 4, 6
i=54..55 BDS 8  : 0, 2
i=56..57 BDS 7  : 0, 2
i=58..59 BDS 14 : 0, 2
```

摊平 100 条记录得到的"首次出现 block"见 §1.2 表格那一列。

---

## 3. 三条最简假设：全部失配（逐条打印匹配数）

匹配口径：把候选规则排出的序列与靶序**逐位比较**（`逐位`）和**相邻对比较**（`相邻对`，长度 −1）。
完全成立必须是 `逐位 = n/n`。

### 3.1 假设 A：首次出现序（按摊平后的 block 序号升序）

| 靶序 | 逐位 | 相邻对 | 首个失配 |
|---|---:|---:|---|
| `_Mean` GPS | 3/5 | 2/4 | 第 4 位：规则给 `L5_Q`，靶是 `L1_CP` |
| `_Mean` BEIDOU | **0/5** | 0/4 | 第 1 位：规则给 `B1I_D1`，靶是 `B2I_D1` |
| `_Mean` QZSS | 2/4 | 1/3 | 第 3 位：规则给 `L5_Q`，靶是 `L1_CP` |
| `Signals_*` GPS | **0/5** | 0/4 | 第 1 位：规则给 `L1_CA`，靶是 `L2_PY` |
| `Signals_*` BEIDOU | **0/5** | 0/4 | 第 1 位：规则给 `B1I_D1`，靶是 `B1I_D2` |
| `Signals_*` QZSS | **0/4** | 0/3 | 第 1 位：规则给 `L1_CA`，靶是 `L5_Q` |

→ 失败。注意 `_Mean` GPS/QZSS 有 2..3 位巧合，**看起来像"首次出现序"，但都是末两位/第 4 位翻车**，
这正是容易被误判成"差一点"的地方：BEIDOU `_Mean` 与 `Signals_*` 三组则**第 1 位就错**，
说明它根本不是"插入序"。

### 3.2 假设 B：通道号序（`c_status & 0x1F`，以及 `& 0x3F`、`(c>>6)&0x3FF`）

`c_status & 0x1F` 14 组全为 `4` → 排序退化，**无法产生任何顺序**（0/14 组可区分）。
用 `& 0x3F`：GPS_L1_CP 为 36，其余 4/11 → 逐位 `_Mean` GPS 1/5、`Signals_*` GPS 1/5。
用 `(c>>6)&0x3FF`：逐位 0..2/n。
用 `bits26-31`：`_Mean` GPS 2/5、BEIDOU 1/5。

→ 失败。**"通道号序"这条假设在证据上就不成立**：低 5 位在本样本里是常量，
真正的通道号来自 RANGE 记录里的 `ch_info`（本样本 EDIE 布局里没有该字段），不是 `c_status`。

### 3.3 假设 C：72 名字枚举位次升序（同一 system 内）

| 星座 | `_Mean` 逐位 | `Signals_*` 逐位 |
|---|---:|---:|
| GPS | 2/5 | 2/5 |
| BEIDOU | 1/5 | 1/5 |
| QZSS | 2/4 | **0/4** |

→ 失败。（逐卫星列同一口径是 60/60，对照鲜明。）

### 3.4 顺带排除的"数值排序"（同一批数据，同一口径）

| 规则 | `_Mean` GPS / BDS / QZSS | `Signals_*` GPS / BDS / QZSS |
|---|---|---|
| `signal` 值升序 | 3/5, 0/5, 2/4 | 0/5, 0/5, 2/4 |
| 出现次数降序 | 3/5, 0/5, 2/4 | 0/5, 0/5, 2/4 |
| C/No 均值降序 | 1/5, 2/5, 1/4 | 0/5, 0/5, 1/4 |
| 最小 PRN 升序 | 3/5, 0/5, 2/4 | 0/5, 2/5, 0/4 |

全部失配，且没有任何一条同时在两个文件上成立。

### 3.5 假设 D：哈希族穷举（键 × 哈希 × 表长 × 桶迭代约定）

口径：把 6 组靶序（`_Mean` 3 个星座 + `Signals_*` 3 个星座）同时作为约束，
一个模型必须**6 组全部逐位命中**才算成立。组合总量 **153 252**：

| 维度 | 取值 |
|---|---|
| 键 | `signal`5 位 / `system*32+signal` / `(system<<16)\|signal` / `((signal<<21)\|(system<<16))` / `c_status` 首观测 / 列名 `GPS_L1_CA` / 短名 `L1_CA` / 枚举位次 / `system*64+枚举位次` / `ALL_SIGNAL`（.so 字符串表编号）/ 列名+`_Mean` / 短名+`_Mean` |
| 哈希 | identity / splitmix32 / FNV-1a 32 / FNV-1a 64 / djb2 / sdbm / Java31 / murmur3-32(seed 0) / murmur3-32(seed 0xc70f6907) / CRC32 / boost `hash_combine` |
| 插入序 | block 序 / 枚举序 / `signal` 升序 |
| 表长 | 2..127 全部，加 131 / 193 / 251 |
| 桶迭代 | ①bucket 升序+桶内插入序 ②bucket 升序+桶内逆插入序 ③桶按首次使用逆序+桶内逆插入序（**libstdc++ 实测行为**，见 §5.4）④全局单链表纯逆插入序 |

结果：

```
  combinations: 204336
  combos matching all 6 targets: 0
  best combo: 3/6  key=short name + "_Mean" hash=fnv1a64 insert=block-order size=93 conv=bucket asc + in-bucket insertion
      missed: Mean/sys4, Signals/sys0, Signals/sys5
  -> no hash-family member explains all 6 orderings (0 combos)
```

→ 失败。**没有任何哈希族成员能同时解释两张图的 6 组顺序**，最好的组合只有 3/6。
这条结论比"单看一组"强得多：6 组约束下，桶序模型即使有一组凑巧命中也会在其它组上暴露。

---

## 4. 已排除清单（含上一轮，全部有脚本或可复算的算术支撑）

| # | 模型 | 结论 | 依据 |
|---|---|---|---|
| 1 | 枚举序（72 名字枚举位次） | ✘ | §3.3，GPS 2/5 |
| 2 | PRN 序（按组内最小/最大 PRN） | ✘ | §3.4 |
| 3 | 首次出现序（RANGE obs 摊平后） | ✘ | §3.1，BEIDOU 与 `Signals_*` 第 1 位即错 |
| 4 | 计数 / C/No 均值排序 | ✘ | §3.4 |
| 5 | `signal` 5 位数值升序 | ✘ | §3.4 |
| 6 | 通道号序（`c_status & 0x1F`） | ✘（不可用） | 低 5 位 14 组恒为 4，§1.6 |
| 7 | 单一固定表（两图共用一张信号顺序表） | ✘ | 列集合相同但顺序不同，§1.4 |
| 8 | `std::map`（字典序） | ✘ | BEIDOU 若按名字字典序应为 `B1I_D1 B1I_D2 B2I_D1 B3I_D1 B3I_D2`，实测不是 |
| 9 | FNV-1a(32/64) / libstdc++ `_Hash_bytes`，键 = 列名 / 信号后缀 / 5 位信号号 / 枚举位次，bucket 2..97 × 两种桶迭代约定 | ✘ | 上一轮脚本（`06_Graph应用.md §11.6`） |
| 9b | 扩大到 12 种键 × 11 种哈希（含 murmur3-32 两 seed、CRC32、boost `hash_combine`、splitmix32）× 3 种插入序 × 4 种桶迭代约定 × 129 种表长 = 204 336 组合 | ✘ | §3.5，0/6 命中，最好 3/6 |
| 9c | 低 5 位当通道号 | ✘（不可用） | 14 组恒为 4，§1.6 |
| 9d | libstdc++ 真行为 `unordered_map<ALL_SIGNAL, …>`（键 = .so 里的 `ALL_SIGNAL` 编号，identity 哈希，13 桶，逆首次使用序） | ✘（自相矛盾） | §5.5：`L1_CA` 与 `L5_Q` 会落在同一桶、必相邻，golden 里它们隔了 3 列 |
| 10 | "两张图各用一张固定表"（即两张表互不相同但都固定） | **未排除，且不可判定** | 本样本每个星座只有 4..5 个信号，任何 4..5 元置换都能被"固定表"解释；要判定必须换输入（见 §5） |

---

## 5. 关键新事实：列序由原生模块决定，且现在**不能**靠换输入验证

这一节是给后来者的路线图，避免重复劳动。

### 5.1 列名字面量在 `graph-node-wrapper.node` 里，不在 renderer

全仓扫描（`逆向/01_解包/Graph/` 递归按字节匹配）结果：`Signals_`、`Satellites_`、
`Signals_Total`、`Satellites_Total`、`_Mean`、`cno`、`satellitestracked`、`locktime.db`
**只出现在两个 `.node` 里**，renderer 的 16 MB bundle（`index-B86bHcCD.js`）一个都没有。
renderer 只有图表声明（`chartFilename:"cno.db"` / `"satellitestracked.db"`）。

Windows 模块里的相邻字面量（`@7 391 344` 起）能读出生成列名的代码骨架：

```
"timestamp" "UNKNOWN_SYSTEM" "INVALID_VALUE" "LBAND" "GLONASS_SLOT" "GLONASS_FREQ"
"GLONASS" "UNKNOWN" "LBAND" "Signals_" "satellitestracked" "TEXT" "Satellites_"
"satellitestracked" "TEXT" "Signals_Total" … "Satellites_Total"
```

以及 `@7 383 452` 处的 `"cno" "TEXT" "UNKNOWN_SIGNAL" "_" "LBAND" "timestamp" "TEXT" "_Mean" "TEXT"`。
即：**`cno` 表（`_Mean`）与 `satellitestracked` 表（`Signals_*`）是两条独立的建表路径**，
各自 `拼接前缀 + "_" + 信号名 (+ "_Mean")` 并 `ALTER TABLE`/建列。这解释了 §1.4 的顺序差异，
也说明"顺序"是这两条路径各自容器/循环的产物，而不是某张全局表。

同一模块里还有 `TrackingFacade: preprocess did not gather satellites properly`、
`TrackingFacade: No Satellite Index`、`Obs string not created yet, Index: %d`、
`Requested SV index is not in the All Signal List` / `Satellite Signal List`，
以及 `TrackingFacade::GetSignal / GetSVChannel / GetChannel …-- Accessing Invalid index`
——说明原生侧同时维护 "All Signal List" 与 "Satellite Signal List" 两个索引，
列序很可能是其中某个列表的遍历序。

### 5.2 无头调用原生模块：**filevalidation 可行，StartProcess 崩溃**

**这是本轮最有复用价值的发现**，也是"换输入验证"目前卡住的唯一原因：

```js
// 纯 Node 24 即可，不需要 Electron：NAPI 模块，导出只有 TabFileReader_api
const Edie = require('./graph-node-wrapper.node');
const enc = new Edie.TabFileReader_api();
enc.filevalidation({ '<tab>': { filePath:[log], configfilePath: <安装目录>\Edie\logger_config.toml,
  isCropped:false, tabUniqueId:'<tab>', projectDirectory:<父目录>, projectName:'<名>',
  EncryptKeyInput:'<名>' } }, cb);            // ✔ 逐 12% 回调，最后给 DataInfo / PlotSummary / Messages
enc.GetEncryptionKey({ name:'GetEncryptionKey', EncryptKeyInput:'probe' }, cb);  // ✔ 返回 64 位 hex
enc.StartProcess({ name:'StartProcess', filePath, configfilePath, projectDirectory,
  EncryptKeyInput, timeLine:{starttime,endtime}, PlotSummary }, cb);             // ✘ 进程 fastfail
```

- `filevalidation` 实测正常：对 `clean-9600.gps` 返回
  `DataInfo{StartTime:1477384697350,EndTime:1477384702300,Duration:4950,FileSize:270864}`、
  `Messages{RANGE:100,BESTPOS:5,RXSTATUS:4,…}`、完整 `PlotSummary`，并在
  `<projectDirectory>\<projectName>\GOS\` 落 `position.db` / `events.db`（24 576 B，加密）。
  → **EDIE 解析、工程建库、加密都能无头复现**。
- `StartProcess`（也就是真正建 `GDS\cno.db` / `satellitestracked.db` 的那一步）在纯 Node 下
  调用后 **`0xC0000409`（STATUS_STACK_BUFFER_OVERRUN / fastfail）**，不管
  `projectDirectory` 传父目录还是工程目录、`timeLine` 传真实区间还是 `{0,0}`、是否复用
  `filevalidation` 的实例，全部同样崩；崩溃前只打出一行 `[root] [info] Logger initialized.`。
  `ExportCSV` 依赖 `StartProcess` 建出的 `GDS\*.db`，所以也走不通。
- 猜测（未验证）：`StartProcess` 需要 `resources/native_modules/*/configurationfile.node`
  （本包**缺失**，`06_Graph应用.md` U3 已记录），或需要 Electron 主进程侧的某个全局状态。

**结论：想拿"第二份输入"的列序，只能走完整 GUI**（`tools/graph-export.cjs` 的 Playwright 路线，
`06_Graph应用.md §9.2`）：造一份信号集合不同的 `.gps` → New Project → 等校验 100% →
Export 面板勾 CSV → 读 `csv/GNSS Signal Strength.csv`。这条路线未被本轮走通（时间原因），
但它**不需要**先知道规则，是唯一能证伪 §4 第 10 项的实验。

### 5.3 造"不同信号集合"的输入不需要新写编码器

`RANGE` 的 `obs[]` 直接携带 `c_status`，而列序只依赖 `(system, signal)` 集合，
因此第二份输入只要**改写现有 100 条 RANGE 的 `c_status`/`sv_prn`**（同一帧长、同一 CRC 算法，
`packages/protocol/src/framing.ts` 已有 deframer 可反查 CRC）+ 重算帧 CRC 即可，
不必合成全新日志。这份输入应当至少覆盖：GPS 只留 `{0,9}`、只留 `{0,17}`、加入 `{0,12,13}`
（样本里没有的信号）、以及让 5 个信号的出现先后与现样本相反。

判据写法（第二份输入到手后即可判定）：

| 第二份输入的现象 | 结论 |
|---|---|
| 每个星座内的相对顺序**不随输入变化**，与子集一致 | 固定表（§4 #10），此时可把两张表写死为"信号全集的部分序"，并给出对未见信号的插入位置 |
| 相对顺序随"出现先后/出现次数"变化 | 插入序或哈希桶序，需继续按 §4 #9 的框架扩大哈希族 |
| 同一集合、只改出现先后，顺序**不变** | 排除"插入序"，锁定为"集合的函数"（哈希或固定表） |

---

### 5.4 新证据：两组列分别来自**两种不同键类型**的 `unordered_map`（符号表直读）

linux 版 `graph-node-wrapper.node` **保留了函数的动态符号名**（`.dynsym` 里有定义体符号
`…@@Base`，`objdump -d` 每一行都带函数名），因此容器类型是直接读出来的，不是猜的：

| 符号（还原后） | 说明 |
|---|---|
| `CNO::addMeanPoint(std::string)` | 在字符串尾部拼 `"_Mean"`（`0x2fab98` 处 `_M_mutate` 的字面量就是 `"_Mean"`，长度 5） |
| `CNO::addPoint(int, TrackingFacade*, std::string)` / `CNO::addPoint(Tracking_Metrics, std::string)` | `cno` 表（`GNSS Signal Strength`）的取点 |
| `std::unordered_map<std::string, METRIC_MEAN>` | `_Mean` 的内层容器，**键是字符串** |
| `std::unordered_map<SATELLITE_SYSTEM, std::unordered_map<std::string, METRIC_MEAN>>` | 外层按系统分组 |
| `SATELLITESTRACKED::addPoint(std::unordered_map<SATELLITE_SYSTEM, std::unordered_map<ALL_SIGNAL, signalinfo>> &, …)` | `satellitestracked` 表（`Satellites and Signals`）的内层容器，**键是 `ALL_SIGNAL` 枚举（int）** |
| `std::unordered_map<ALL_SIGNAL, std::string>` | 信号枚举 → 名字 |
| `SqliteWriter::createTable(vector<pair<string,string>>, vector<string>)` | 建表：列序 = 传进来的那个 `vector` 的顺序 |
| `SqliteWriter::addColumnIfNotExists` / `appendMissingColumns` / `getTableColumns` / `mergeTables` / `createTable` | 后续补列、合并分块表 |
| `SqliteWriter::insertIfNotExists(const std::map<string,string>&)` | 插行（行是 `std::map`，与列序无关） |
| `SystemCount::GetSystemIndex` / `GetAllSignalIndex`、`nTrStat::szSignalLong` / `vLongSystemSvSignal` | 系统/信号编号与命名 |
| `TrackingFacade::preprocess / GetSignal / GetSVChannel / GetChannel …` | 取点侧 |

**这条证据同时解释了 §1.4 的"两张图顺序不同"**：两边的键类型不同（`std::string` vs `ALL_SIGNAL`），
哈希与桶落点当然不同。§11.6 当时只能推测"像是两个不同键类型的 `unordered_map` 的迭代序"，
现在**是读出来的事实**。

### 5.5 libstdc++ 迭代序实测（本机 g++ 15.2 当判据）

因为容器确定是 libstdc++ 的 `unordered_map`，迭代序不再是猜的：本机 `V:\mingw64\bin\g++.exe`
编一个小程序直接打印迭代序即可（`unordered_map<int,int>`，按给定顺序插入）：

| 插入序 | 桶数 | 迭代序 |
|---|---:|---|
| `0 8 9 12 2` | 13 | `2 12 9 8 0` |
| `0 8 9 13 2` | 13 | `2 9 8 13 0` |
| `35 43 46 36 47` | 13 | `47 36 46 43 35` |
| `48 52 56 50` | 13 | `50 56 52 48` |

即：5 个元素、13 桶时**迭代序 = "桶按首次使用逆序，桶内逆插入"**；一旦出现同桶（`0` 与 `13` 都
`%13==0`），同桶两个键会**紧挨着**出现在该桶段里（第二行 `2 9 8 13 0` 就是 `13`、`0` 相邻）。

复现用的 10 行小程序（纯 libstdc++，无第三方依赖；`g++ -O2 -o umap.exe umap.cpp`）：

```cpp
#include <unordered_map>
#include <cstdio>
#include <cstdlib>
int main(int argc, char** argv) {
    std::unordered_map<int, int> m;
    for (int i = 1; i < argc; i++) m[atoi(argv[i])] = i;   // 按命令行顺序插入
    printf("buckets=%zu :: ", m.bucket_count());
    for (auto& kv : m) printf("%d ", kv.first);            // 打印迭代序
    printf("\n");
}
```

### 5.6 由 5.5 得到的**可证伪矛盾**（为什么这条模型也不成立）

`.so` 里 `ALL_SIGNAL` 的字符串表顺序（`@0x8c49xx`，`GPS_L1_CA` 起、`UNKNOWN_SIGNAL` 止）给出
`GPS_L1_CA=0`、`GPS_L1_CP=2`、`GPS_L2_PY=8`、`GPS_L2_CM=9`、`GPS_L5_I=12`、`GPS_L5_Q=13`。
若 `Signals_*` 的列序就是这张表的迭代序，则 `0` 与 `13` 同桶、**必然相邻**；而 golden 里
`Signals_GPS_L1_CA` 在第 2 位、`Signals_GPS_L5_Q` 在第 5 位，中间隔着 `L1_CP`、`L2_CM`。

→ 二者至少有一个不成立：**要么 `ALL_SIGNAL` 的实际编号不是字符串表顺序**（很可能——枚举里
`GLONASS_*` 有 6 个名字但编号可能留空位，见 §5.5 表里 `15..19` 的 6 项占了 5 个不同编号），
**要么列序不是这张 map 的迭代序**，而是 `SqliteWriter::createTable` 的入参 `vector` 在别处被排好序。

这就是下一步唯一值得做的实验（§5.2 的第二份输入）：它能把这两条分开。
判据：造一份输入，让 GPS 只剩 `{L1_CA, L5_Q}` 两个信号。若列序里 `L1_CA` 与 `L5_Q` 相邻 →
编号使它们同桶（哈希模型成立）；若不相邻 → 列序来自别处（`createTable` 的入参）。


## 6. 结论

1. **未解**。`_Mean`（14 列）与 `Signals_*`（14 列）的顺序都无法由本样本的数据推出规则；
   已排除 §4 的 1–9d 项，剩余"两张互不相同的固定表 / `createTable` 的入参 vector"（第 10 项）
   **在本样本内不可判定**。
   已知但不够用的结构事实（§5.4–5.6）：`_Mean` 来自 `unordered_map<string, METRIC_MEAN>`，
   `Signals_*` 来自 `unordered_map<ALL_SIGNAL, signalinfo>`；libstdc++ 的迭代序已实测（§5.5），
   但按 `.so` 里的 `ALL_SIGNAL` 编号会得出"`L1_CA` 与 `L5_Q` 必然相邻"的预测，与 golden 矛盾。
2. **`packages/graph/src/range-charts.ts` 未改动**：`MEAN_ORDER` / `SIGNALS_ORDER` 继续抄表，
   代码注释已指向本文。**换输入会退化**：本样本没出现的星座/信号会按枚举位次追加到末尾，
   而原版大概率不是这个位置。
   （`node --test "packages/graph/test/*.test.ts"` 实测 29/29 通过、12 份 CSV 仍逐字节相同；
   测试数比 §11.5 记的 21 多，是因为期间别的任务补了 HTML 报告相关用例，与本任务无关。）
3. 唯一能继续推进的实验是 §5.2 的 GUI 路线（造第二份输入 → 导出 → 对比），
   本轮已把"无头调用到哪一步为止"探明并写在这里，后续不需要再试 `StartProcess`。
