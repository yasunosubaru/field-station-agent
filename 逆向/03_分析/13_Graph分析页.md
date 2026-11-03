# 13 Graph 分析页：Recent Projects 与多工程（B10）

> 文件名为本轮任务指定；Graph 的其余分析仍是 `06_Graph应用.md`（应用本体）、
> `13_Graph列序分析.md`（`_Mean` / `Signals_*` 列序）、`14_Graph第二份样本.md`（broad 样本）。
> 本文只记 B10：**落地页列出多个工程、点进去按工程取数**，以及为验证它而**真造出来的第二个工程**。

## 1 结论

| 项 | 状态 |
|---|---|
| `GET /api/graph/projects` | 新增。扫 `samples/graph/export/` 的**目录**，不写死工程名 |
| `/api/graph/files`、`/api/graph/data`、`/api/graph/pdf` 的 `?project=` | 新增，兼容工程目录名（`csv`/`b1`）与 CSV 里的 `#Project Name:`（`clean`/`b1`） |
| 落地页 Recent Projects | 一个工程一张卡，卡上日期/名称/CSV 份数来自接口，点击切换工程 |
| 第二个工程 | **`samples/graph/export/b1/`，由 `b1-20261101.sbf` 经 `packages/graph` 的导出逻辑转出**，13 份 CSV（`Velocity.csv` 是后补的第 13 张，见 §7），可重跑复现 |
| 切换实测 | Overview：`clean` 99 行/75 列/4 s ↔ `b1` 530 行/98 列/28 s；PVT 各图 5 行 ↔ 51 行 |
| 测试 | `packages/app/test/graph-projects.test.ts` 10 项；全套原有项未受影响（见 §7） |

## 2 工程 = 一个导出目录

Graph 自己的模型是 `.gpf` + `DataSummary.json` → *Export → CSV* 写 `<project>/csv/<图>.csv`。
仓库里随样本发布的那一套把 CSV 直接放在 `export/csv/`，所以两种形状都认：

```
export/csv/*.csv       ← 目录自身就是 CSV 目录（工程 key = csv，显示名 clean）
export/b1/csv/*.csv    ← Graph 的嵌套形状（工程 key = b1）
```

规则（`packages/graph/src/export-projects.ts`）：

- 遍历 `export/` 的**直接子目录**；子目录里有 `csv/` 且其中有 CSV 用它，否则它自己有 CSV 就用它自己；
  两处都没有 CSV 的目录（例如将来的 `export/scripts/`）不是工程；
- 显示名取 CSV 注释头 `#Project Name:`，缺了才退回目录名；时间范围取 `#Start/#End Time(GPS):`、
  时长取 `#Duration:`，数据文件名取 `#Data File Name:`；
- 排序按 CSV 最新 mtime 倒序（"Recent"），同刻再按 key；
- 一条 CSV 都没有 → 不出现，不会造出空卡片。

`GET /api/graph/projects` 的形状（`b1` 与 `clean`，路径相对仓库根）：

```json
{
  "ok": true,
  "root": "逆向/00_来源/samples/graph/export",
  "count": 2,
  "default": "csv",
  "projects": [
    { "key": "b1", "name": "b1",
      "directory": "逆向/00_来源/samples/graph/export/b1",
      "csvDirectory": "逆向/00_来源/samples/graph/export/b1/csv",
      "csvCount": 12, "bytes": 1130288,
      "startTime": "2442,570227.100", "endTime": "2442,570255.151", "duration": "00:00:28",
      "dataFileName": "b1-20261101.sbf", "modified": "2026-11-01T13:27:48.941Z" },
    { "key": "csv", "name": "clean",
      "directory": "逆向/00_来源/samples/graph/export/csv",
      "csvDirectory": "逆向/00_来源/samples/graph/export/csv",
      "csvCount": 12, "bytes": 161299,
      "startTime": "2442,463097.350", "endTime": "2442,463102.300", "duration": "00:00:04",
      "dataFileName": "clean.gps", "modified": "2026-10-30T12:01:36.952Z" }
  ]
}
```

`?project=` 的取值：目录名（`csv`、`b1`）或 `#Project Name:`（`clean`、`b1`），大小写不敏感；
空串 → 400，带 `/`、`\`、盘符或 `..` → 400，不存在的名字 → 404 并列出已有的工程。
不带 `?project=` 时**保持原样**：仍是 `export/csv/` 那一套（`graphcsv.ts`），
所以既有测试与既有 URL 的语义没变。

## 3 第二个工程：怎么造的

`b1-20261101.sbf` 是接收机自己写的抓包（2 758 111 B，`00_来源/samples/live-20261031/`），
没有 `.gpf`，所以用 `packages/graph` 的导出层直接转：

```powershell
cd "逆向\04_重实现"
node packages/graph/tools/export-sbf-project.ts `
  --capture "../00_来源/samples/live-20261031/b1-20261101.sbf" `
  --out     "../00_来源/samples/graph/export/b1" `
  --name    b1
```

工具做的事（`packages/graph/tools/export-sbf-project.ts`）：

1. `loadCapture()` 照样例逐帧解 SBF（复用 `packages/protocol` 的 deframer + EDIE 字典）；
2. 丢掉**损坏帧**（见下），其余帧重建计数；
3. 用导出层真正会画的报文（`CSV_CHARTS` 的 `BESTPOS` / `RANGE` / `HWMONITOR` / `RXSTATUS`）算时间窗
   —— 整包 `RXCONFIG`/`SERIALCONFIG` 带 week 0、少数星历帧带 2235/2399/2402 的旧周，
   按"所有帧"取窗口会得到 7100 天；
4. 由数据本身造 `PlotSummary`：某个图的报文出现了才有这张图（与 `.gpf` 的 R17 同一判据）；
5. 调 `writeCsv()`（就是 golden 逐字节比对用的那个函数）写 `<out>/csv/<图>.csv`；
6. 写 `<out>/project.json` 记录来源、窗口、报文计数、被丢的帧、以及上面这条命令本身。

产物：**13 份 CSV**（`clean` 只有 12 份——它的采集里一条 `BESTVEL` 都没有，所以不写
`Velocity.csv`；导出层实现的是图表目录 16 张里的 13 张，见 §6），
时间窗 `2442,570227.100 – 2442,570255.151`，`00:00:28`，
`Height.csv` 51 行、`Velocity.csv` 25 行、`Tracking Time.csv` / `GNSS Signal Strength.csv` 530 行。

`packages/app/test/graph-projects.test.ts` 会把上面的命令**重跑一遍**到临时目录，
逐份比对 13 个文件（只归一化 `#Project Directory:` 这一行，它本来就写着输出目录），
所以这份样本不是手写数据，删掉也能原样再生。

### 3.1 为跑通真抓包而修的三处（`packages/graph`）

| 问题 | 现象 | 处理 |
|---|---|---|
| 信号表只有 golden 里那 12 个 `(system, signal)` | `b1` 直接抛 `unknown RANGE signal system=5 signal=24`（QZSS L1C/B），三张 RANGE 图整张导出失败 | 按 OEM7 *Commands and Logs Reference Manual* Table 182（bits 21-25）补齐 GPS/GLONASS/SBAS/Galileo/BeiDou/QZSS/NavIC/Other 的编号，rank 仍按 72 名字枚举的位置；表里没有的组合退化成 `<系统>_S<编号>` 排末尾，不再抛错 |
| 某颗卫星某一时刻不在 `obs[]` 里 | `Tracking Time` / `GNSS Signal Strength` 的取值函数遇缺就抛，真抓包里卫星会升落，导出必炸 | 缺样本 → **空单元格**（`CsvColumn.value` 允许返回 `null`，`renderValue` 输出空串）；golden 每行都齐，字节不变 |
| 一帧 RANGE 的 `obs[]` 解码出 16 个不可能的观测（PRN 2573/44671/43891、C/No 1e-39、负 lock time） | 会凭空造出卫星 | 导出工具整帧丢弃并记进 `project.json` 的 `droppedFrames`（本样本 1 帧，`RANGE@1477491828250`），其余 530 条 RANGE 原样导出 |

## 4 前端落地页

`packages/app/src/web/panels/graph.js`：

- `mount()` 先 `loadProjects()`（`/api/graph/projects`）再 `loadFiles()`（默认工程）；
- `renderCards()` 一个工程一张卡：第一行 GPS 起始时间换算成的日期（`gpsDateLabel`），
  第二行 `<名字> · N 份 CSV`；`title` 里带时长 / 数据文件 / CSV 目录；当前工程 `aria-current="true"`；
- 点卡片 → `openProject(key)`：**清空** `payloads` / `models` / `started` / `chipOff` 与当前载荷，
  再按该工程重取文件列表与默认 CSV，然后进工作区；
  不清缓存的话，PVT 会拿"同名文件"的旧缓存继续画上一套数据（两个工程的 12 个文件名完全相同）；
- `fetchData()` 的缓存键与请求都带工程：`/api/graph/data?file=…&project=…`；
- Export ▸ PDF 传工程 key（`/api/graph/pdf?project=b1`），服务端按该工程出 PDF（b1 是 9 页：
  1 页信息 + 1 页 `Trajectory Plot` + 13 张图两两一页；两图一页的版式见 §13）。

## 5 实测

- 落地页：**3 张卡**（`heading` 合成抓包、`b1` 2026-10-31、`clean` 2026-10-30），状态行
  `3 个工程 · 当前 clean · 12 份 CSV · 逆向/00_来源/samples/graph/export/csv`。
- 点 `b1` 后 Overview：`工程 b1 · 数据 b1-20261101.sbf · GPS 2442,570227.100 – 2442,570255.151 ·
  时长 00:00:28 · 530 行 · 98 列`，图例 `GPS_L1_CA_15` 30 点（该卫星只在 530 行里的 30 行出现，
  其余是空单元格），时间轴右端 28.05 s。
- 点 `clean` 后 Overview：`工程 clean · 数据 clean.gps · GPS 2442,463097.350 – 2442,463102.300 ·
  时长 00:00:04 · 99 行 · 75 列`，时间轴右端 4.95 s。
- PVT：**7 块图块**（图表目录的 7 张全在，含 `Velocity`）。`clean` 每图 5 行、`b1` 每图 51 行
  （`Height(m)` 曲线 64.82 → 64.76 m）；`b1` 的 `Velocity(m/s)` 25 行 5 条曲线，`clean` 的那块写
  `-- 导出目录里没有 Velocity.csv`，页脚点名 `Velocity.csv`（不拿别的列顶替）。
- `b1` 的 Tracking & Measurements / Receiver Status 页也能打开，控制台 0 error / 0 pageerror。
- 截图（`%USERPROFILE%\AppData\Local\Temp\opencode\agent-projects\`）：
  `b10-01-recent-projects.png`、`b10-02-b1-overview.png`、`b10-03-b1-pvt.png`、
  `b10-04-clean-overview.png`、`b10-05-clean-pvt.png`；接口原文 `projects.json`。

## 6 没做到的 / 边界

1. **16 份 CSV 已齐，但只有 12 张有 golden 逐字节对照。** 图表目录
   （`06_Graph应用-附录/C_图表目录.json`）有 16 张图，导出层现在都实现（§12 补了 Heading &
   Attitude 的 `Azimuth` / `Roll and Pitch` / `SPAN Filter Updates`）。其中有原版 CSV 可比的仍是
   12 张（`clean`）+ `Velocity`（`broad`）；Heading & Attitude 那三张**本机造不出来**（无 INS /
   ALIGN 授权），只能用原生模块里的表结构/字段/优先级做依据、用合成抓包验证数值来源，
   没有逐字节 oracle。`clean` 的 golden 也只有 12 份（没有 `BESTVEL`）。
2. **`export-broad/` 仍然不在 `export/` 下。** 它是原版 Graph 对 `broad-clean.gps` 的另一份真导出
   （13 份 CSV，含 `Velocity.csv`），本轮把它当 `Velocity` 的 oracle 用（§7），但工程模型只扫
   `export/` 的直接子目录，按边界没有把样本搬进来。
3. **工作区没有"回落地页"的按钮。** 原版有返回入口；本构建的 Tab 栏只列 5 个页签，
   换工程要么刷新页面，要么用 New/Open Project。加返回按钮要动 `graph.css` / 菜单栏结构，本轮没做。
4. **`b1` 是同一个接收机 28 s 的抓包**，第二个工程证明了"多工程可列、可切、数据确实不同"，
   不代表任意 SBF 都能导出：图表仍然只出那 13 张，未知信号退化成 `<系统>_S<编号>` 的列名。
5. `packages/app/src/graphcsv.ts` 仍是默认工程的读取器（本任务边界不允许改它）；
   `graph-projects.test.ts` 逐字段比对默认路径与 `?project=csv`，两套读法必须一致。

## 7 测试与回归（本轮）

- `node --test --test-force-exit "packages/*/test/*.test.ts"`：**986 项，986 通过，0 红**（最后一次
  全量）。同一套代码此前有一次全量只红 `packages/session/test/session.test.ts` 的
  `heartbeat counts misses and any inbound data resets the counter`（`6 !== 2`）——任务开始前就存在
  的负载相关偶发，单跑该文件 11/11 全过，与 Graph 无关。并行任务还在加测试，总数在 964→986 之间浮动。
  Graph 包单跑 `packages/graph/test/*.test.ts`：**44/44**。
- 新增 `packages/graph/test/velocity-chart.test.ts`（6 项）：列换算逐行对 golden、关键行逐字节、
  `clean` 不产出 `Velocity.csv`、`b1` 产出 25 行真数据、HTML/PDF 自动多一段。
- `packages/app/test/graph-tabs.test.ts` 的图块数 6 → 7，并断言 `Velocity` 的 `kind: 'line'`、
  `units: '(m/s)'`、`file: 'Velocity.csv'`（单位逐字来自 `C_图表目录.json`，没有编）。
- `packages/app/test/graph-projects.test.ts` 里 b1 的 CSV 份数 12 → 13（PDF 13 → 14 页）。

## 8 Velocity：第 13 张图（B 类第 3 项）

**oracle 是原版导出，不是我方生成**：`00_来源/samples/graph/export-broad/csv/Velocity.csv`
（Graph 2.11.0，工程 `broad`，4193 B，60 行，`2442 467950.000` – `2442 468009.000`）。
数据源 `00_来源/samples/convert/broad-clean.gps`（3 199 316 B）**其实是二进制 SBF**（扩展名骗人），
`packages/graph/src/capture.ts#loadCapture` 直接能读，里面正好 60 条 `BESTVEL`（SBF 消息号 99）。

### 8.1 列映射与舍入（`packages/graph/src/csv.ts`）

Graph 并不直接画 `BESTVEL` 的字段，而是把 `horizontal_speed` + `ground_track` 拆成南北/东西：

| 列 | 来源 | 公式 |
|---|---|---|
| `North Vel` | `horizontal_speed`, `ground_track` | `horizontal_speed · cos(ground_track°)` |
| `East Vel` | 同上 | `horizontal_speed · sin(ground_track°)` |
| `Up Vel` | `z` | 直接取值（`BESTVEL` 自己的垂直速度，m/s） |
| `Horizontal Speed` | 前两列 | `hypot(North, East)`（重算，等于 `horizontal_speed`） |
| `3D Speed` | 前三列 | `hypot(Horizontal, Up)` |

- **`ground_track` 是度不是弧度**（SBF 字段说明 `0…360`，从北顺时针）。按度代入后 60 行 × 5 列
  = **300 个数字格全部对上**；试用 2π 归一化的弧度假设一行都对不上。
- **舍入是 `printf("%.6f")`**：一律六位小数、**不裁尾零**（60 行 300 格全是六位），用的是
  `format.ts` 里已有的 `formatFixedHalfEven()`（列格式 `fixed6`），与 RANGE 那两张图同一套。
  这里若用 `formatTrimmed`（`Height` 用的那套）在 golden 上也不会红——本文件没有一格的第六位是 0——
  但 `%.6f` 才是原版的写法，所以按它来。

### 8.2 13 份全量对比（我方重导 vs `export-broad/csv/`）

用 `packages/graph/tools/export-sbf-project.ts --capture …/broad-clean.gps --name broad --mean-order=0,17,16,9,14`
导出到临时目录，逐行比对（`META-ONLY` = 数据行逐字节相同，只是 5 行项目信息不同）：

| 结果 | 文件 |
|---|---|
| **`META-ONLY`（数据行逐字节相同）13 份** | `2D Trajectory`、`CPU Usage`、`Position SD`、`Position Status`、`Position Type`、`Satellites and Signals`、`Solution Statistics`、`Tracking Time`、`Velocity`、`Height`、`HW Monitor Status`、`Receiver Status`、**`GNSS Signal Strength`** |
| `DATA-DIFF` **0 份** | —（`GNSS Signal Strength` 的 3 个 `_Mean` 列靠显式记录的 `meanOrder` 归位，见 §8.2.4） |

- 这 5 行项目信息为什么必然不同（我方没有 `.gpf`）：`#Project Directory:`（输出目录）、
  `#Data File Name:`（`broad-clean.gps` vs 原版的 `broad.gps`）、
  `#Start Time` / `#End Time` / `#Duration`（原版 `2442,467940.000 – 2442,468009.000 / 00:01:09`；
  我方按"实际画图的报文"取窗，得到 `2442,467949.100 – 2442,468009.001 / 00:00:59`）。
  `#Project Name:` 两边一致（都是 `broad`）。原版的 467940.000 来自 `.gpf` 里的会话起点，
  抓包第一帧是 `RANGE@467920.650`，从数据推不出这个数，所以不编。
- **`b1` 其实有 BESTVEL**（25 条，`2442 570231–570255`，全在时间窗内），所以任务书里
  "b1 没有 BESTVEL" 那条前提不成立：b1 重导后是 13 份，多出来的 `Velocity.csv` 是 25 行的真曲线，
  不是空文件。样本已按工具重铺（只新增 `Velocity.csv` + `project.json` 的两行数组）。

#### 8.2.1 `Height`：六位小数不裁尾零（`format: 'fixed6'`）

oracle 60 行里 **12 行**的第六位是 `0`（`65.931110`、`65.922480`…），我方原来按 `Latitude` /
`Position SD` 那套 `trim6` 写成 `65.93111`。改成 `fixed6`（`formatFixedHalfEven`，与 `Tracking Time`
同一套 `%.6f`）后 60 行逐字节相同。

逐列量了 oracle 的格式（每张图每个数字列统计"六位小数 / 被裁短 / 尾零"）：`Position SD` 三列确实
有 5/9/6 个格子是裁短的 → `trim6`；`2D Trajectory` 的 `Latitude`/`Longitude` 60 格全是六位且没有一格
尾零 → `trim6` 与 `fixed6` 输出相同，保留 `trim6` 并把"测不出"记在这里；`Solution Statistics` 的两列
是 `0.000000`、`Velocity` 五列、`Tracking Time`/`GNSS Signal Strength` 全部 `fixed6`（本来就是）。
**没有**顺手改别的图。

#### 8.2.2 `HW Monitor Status`：65 帧 → 59 行，因为同一 payload 记了两个端口

`broad-clean.gps` 里 65 条 `HWMONITOR`，但只有 **59 个时间戳**：多出的 6 条是**成对**的
（`gpsMs` 相同、payload 逐字节相同、`portAddress` 一个 189 一个 188），位置正好在每 10 s 边界
（467950/467960/…/468000）。`USBT` 的 60 s 抓包 `samples/raw/usb1-broad-60s.bin` 里也是这样，
所以不是 `broad-clean.gps` 被谁拷坏了，而是接收机把同一条 `HWMONITOR` 同时记到两个口
（1 s 的 189 + 10 s 的 188）。

原版的 CSV 是 **59 行** = 时间戳个数。`graph-node-wrapper.node` 里能直接读到建表与插行方式：

```
CREATE TABLE IF NOT EXISTS navigation (timestamp INTEGER PRIMARY KEY, …);
INSERT OR IGNORE INTO "…
```

即每条曲线的表主键是 `timestamp`、插入是 `OR IGNORE`，重复时间戳的第二条被丢掉（第一条赢）。
`csv.ts` 因此加了 `ChartCsvSpec.oneRowPerTimestamp`，只挂在 `HW Monitor Status` 上：**只有这一张图
有 oracle 证明**这个折叠；`BESTPOS` / `RANGE` 在 `broad-clean.gps` 里没有重复时间戳，没有证据，
所以一行都没动（`b1` 的 `BESTPOS` 有 25 对重复，也没有跟着改）。

#### 8.2.3 `Receiver Status`：`end` 是"把条件清成假的那条记录"

原版 7 行里 5 行曾经被我方写成 `end == start`。实测 `broad` 的 RXSTATUS 时间轴（11 个时间戳）后，
规则是：

- span 从第一条条件为真的记录开始，到**第一条条件转假的记录**结束（那条记录的 `timestamp`，
  不是"最后一条仍为真"的记录）：`Antenna 1 Gain High` `…562896 → …564995`（bit 14 在 564995 清零）、
  `Jamming Detected` `…552895→…556995`、`…575910→…582009`、`…583896→…588995`；
- 到窗口最后一条仍为真、没有清零记录的，`end` = 窗口内**最后一条 RXSTATUS 的 `timestamp`**：
  `Ethernet Not Connected` / `RF Calibration Data Present` 都到 `…604996`。`clean` 的 5 行全是这种
  （都到 `1477384700900`），所以旧规则在 `clean` 上看不出错。

#### 8.2.4 `GNSS Signal Strength` 的 3 个 `_Mean` 列：**推不出规则，改为显式记录**

| 数据集 | GPS `_Mean` 顺序（signal 号） |
|---|---|
| `clean`（第一份 oracle） | `0 9 17 16 14` = `L1_CA, L2_PY, L2_CM, L1_CP, L5_Q` |
| `broad`（第二份 oracle） | `0 17 16 9 14` = `L1_CA, L2_CM, L1_CP, L2_PY, L5_Q` |

两份输入在这件事上**没有可区分的输入差异**，实测：

- 键集合完全相同：GPS 都是 `{0,9,17,16,14}`（`14_Graph第二份样本.md §1.3`）；
- 首次出现序完全相同：都是 `0@0 → 9@1 → 17@2 → 14@8 → 16@15/27`；
- **每一条 RANGE 记录内部的 `obs[]` 顺序也完全相同**：`L1_CA, L2_PY, L2_CM, L5_Q, L1_CP`，
  1199 条与 100 条逐条一致（每条记录的第一批 GPS 观测把 5 个信号全部走一遍，两种输入各只有一种
  顺序；本轮探针逐记录统计过）。

也就是说：`_Mean` 的列序**不是这份抓包的函数**。任何"按数据算"的规则（枚举序、保留序/首现序、
PRN 序、计数/均值序、哈希桶序）在两份输入上都会给出同样的 gps 顺序，而 oracle 不同 —— 这与
`13_Graph列序分析.md`、`14_Graph第二份样本.md §5.2` 的结论一致，本轮又补了两条可复算的证据：

1. **嵌套 `unordered_map<string, METRIC_MEAN>` 模型不可能**：`GPS` 内层键集合与插入序都相同，
   同一容器只能给出同一个迭代序；要不同只能靠不同的桶数。把 5 种字符串哈希（libstdc++
   `_Hash_bytes`/murmur64、FNV-1a 32/64、djb2、sdbm）× 3 种键形（全名 / 去星座前缀 / `+_Mean`）×
   6 种迭代约定 × 桶数 2..97 全试，**两个数据集各自的 3 组靶序一组都命中不了**（更不用说同时）。
2. **扁平（带星座前缀的 key）模型**也不成立：桶数会随键数（宽 10 / clean 14）变（13 vs 29），
   但上面同一批哈希/约定/桶数组合里，**没有任何一组能同时命中两份的 10/14 列靶序**。

最可能的解释是原版在 `_Mean` 这一侧的插入序不来自数据（并行/分块建表），属于**跨会话不可复现的
观测**；`Signals_*` 侧两份输入顺序恒定，不受影响。

因此 `_Mean` 顺序在重实现里是**显式元数据**，不是推导出来的规则：

| 层 | 形状 | 说明 |
|---|---|---|
| `GraphProject` | `meanOrder?: number[]` | `(system, signal)` 编码成 `system*32+signal`，按**观测到的列序**排；GPS 是 system 0，所以 GPS 部分读起来就是 signal 号 |
| CLI | `--mean-order=0,17,16,9,14` | `packages/graph/tools/export-sbf-project.ts`；写进 `<out>/project.json` 的 `meanOrder` 与 `command`，重导时不带参数也会从 sidecar 读回 |
| 渲染 | `range-charts.ts#signalGroups` | 有 `meanOrder` 时按它排（列出的组在前、其余组保持内置顺序），无则完全走原来的 `MEAN_ORDER`（= `clean` 的观测序） |

`broad` 那次导出记录的是 `0,17,16,9,14`，于是 **13/13 逐字节相同**（此前只有 12/13）。这不是"把规则
猜出来了"：同一份 `broad` 输入**不传** `meanOrder` 仍然给出 `clean` 的顺序，`GNSS Signal Strength`
仍只差那 3 个列名——两个方向都在 `packages/graph/test/broad-parity.test.ts` 里钉住，另有
`packages/graph/test/mean-order.test.ts` 覆盖编码、CLI、sidecar 往返与"只换列不动值"。

`clean` / `b1` 的导出不带 `meanOrder`，行为与改动前逐字节相同；`MEAN_ORDER` 表本身没有为 `broad`
改动过一行。文档口径：**这是"记录某一次导出的观测序"，不是通用规则**，换输入不会自动变对。

#### 8.2.5 `clean` / `b1` 的回归

- `clean`：12 份 oracle 仍逐字节相同（`_probe-regress.ts` 实跑）。
- `b1`：重导后 13 份仍与样本逐字节相同，但**样本里两份 CSV 按新规则重铺过**（它们是我方产物，
  不是 oracle）：`HW Monitor Status.csv` 7 → 5 行（去掉 2 条重复端口帧）、`Height.csv` 6 个格子补上
  尾零（`64.81725` → `64.817250` 等）。其余 11 份一字未动。`b1-20261101.sbf` 里 `BESTPOS` 也有 25 对
  同 payload 重复，但**没有**跟着折叠（没有 oracle 证明 `BESTPOS` 的折叠方式）。


### 8.3 前端

- `graph.js#CHART_GROUPS` 的 `pvt.charts` 加 `{ id:'velocity', title:'Velocity', file:'Velocity.csv',
  kind:'line', units:'(m/s)' }`，于是 PVT **永远 7 块图块**（目录 7 张全有页签）；
- 工程没导出 `Velocity.csv` 时图块写 `-- 导出目录里没有 Velocity.csv`，`paintFoot()` 把
  "目录里没有页签的图"和"有页签但没 CSV 的图"分开说（以前只按"有没有页签"判断，会误称"都有 CSV"）；
- HTML / PDF 按 CSV 标题遍历，不用改调用方；`html.ts` 的段落表把 `Velocity` 归到 **PVT**（原来是
  落到无名 `Charts` 段）。

### 8.4 截图

`%USERPROFILE%\AppData\Local\Temp\opencode\agent-velocity\`：
`pvt-seven-tiles.png`（b1 的 PVT 七块，含 `Velocity(m/s)` 五条曲线）、`velocity-tile.png`（该图块）、
`pvt-clean-velocity-empty.png`（clean 的 PVT：7 块，Velocity 留空并说明原因）、`pvt-full.png`
（整页）。控制台 **0 error / 0 pageerror**，1 条 warning 来自 Luciad/WebGPU 纹理（原有）。

## 9 PDF 报告里的中文：按需嵌入 SimHei（B 类第 9 项）

**问题**：`packages/graph/src/pdf.ts` 是手写 PDF 1.4，字体只按名字引用 base-14 `Helvetica`
（`/Encoding /WinAnsiEncoding`），`text()` 只接受可打印 ASCII，超出的一律写成 `?`。
`#Project Directory:` 是本机路径（`<仓库上级>\…`），于是 b1 的 PDF 里整条路径变成
`<仓库上级>\...`（改动前实测）。

| 项 | 状态 |
|---|---|
| 非 ASCII 文本 | **正常显示**：按需嵌入系统 `simhei.ttf`，`pdftotext` 能原样取回中文 |
| 纯 ASCII 文档 | **逐字节不变**：clean 报告 330 802 B，SHA-256 `ad491e922ed1ccdc4ae4aedf2ad251f7fc11f331be489b8589f8780cdb0fa886`，与改动前完全相同 |
| 粗体 | SimHei 只有一个字重，粗体 run 回退到同一字体（**不做**合成粗体） |
| 降级 | 字体缺失 / 解析失败 / `.ttc` → 旧行为（ASCII + `?`），信息页脚注与 `pdfCjkFontStatus()` 都说明原因 |
| 测试 | 新增 `packages/graph/test/pdf-unicode.test.ts` 7 项；全量 **1023/1023** |

### 9.1 TTF 解析（`pdf.ts` 内，无依赖）

只读 PDF 字体字典与排版必须一致的那几张表，**不做 subset**、不碰 `glyf`/`loca`：

| 表 | 取什么 | 用途 |
|---|---|---|
| `head` | `unitsPerEm`、`xMin/yMin/xMax/yMax` | `/FontBBox`、所有 1/1000 em 换算的分母 |
| `hhea` | `ascender`、`descender`、`numberOfHMetrics` | `/Ascent`、`/Descent`；`hmtx` 的条目数 |
| `maxp` | `numGlyphs` | `advances` 数组长度 |
| `hmtx` | 每个 gid 的 advance（末项重复到 `numGlyphs`） | `/W` 与排版宽度 |
| `cmap` | format 12（优先，出 BMP）→ format 4 | Unicode → gid |
| `OS/2` | `fsType`、`sTypoAscender/Descender`、`sCapHeight` | 度量优先于 `hhea`；`fsType=8` 记下但不强校验 |
| `name` | id 6（Windows/Unicode 优先） | `/BaseFont /SimHei` |

拒绝的输入各有明确理由，不靠猜：`ttcf`（`.ttc` 集合，需走集合头）、`OTTO`（CFF 轮廓，得用 `/FontFile3`）、
缺表、`unitsPerEm=0`、`numberOfHMetrics` 越界。

### 9.2 PDF 字体对象（整份嵌入，5 个对象）

对象编号接在页面之后（**纯 ASCII 文档不会走到这里，因此对象号与字节都不变**）：

```
34 0 obj  << /Length 4983830 /Length1 9745792 /Filter /FlateDecode >>   FontFile2（整份 TTF）
35 0 obj  /Type /FontDescriptor /FontName /SimHei /Flags 4
          /FontBBox [-12 -156 996 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 688
          /StemV 80 /FontFile2 34 0 R
36 0 obj  /Type /Font /Subtype /CIDFontType2 /BaseFont /SimHei
          /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
          /FontDescriptor 35 0 R /DW 1000 /W [3 [500] 29 [500] 38 [500] 82 [500 500] … 2598 [1000] …]
          /CIDToGIDMap /Identity
37 0 obj  /Type /Font /Subtype /Type0 /BaseFont /SimHei /Encoding /Identity-H
          /DescendantFonts [36 0 R] /ToUnicode 38 0 R
38 0 obj  /Length 577   ToUnicode CMap（只列本篇用到的 gid，不铺 2 万条）
```

- 文本写成 UTF-16BE **glyph id** 的十六进制串：`BT /F3 9.5 Tf … Tm <91CE5B166D4B8BD5> Tj ET`；
- `ToUnicode` 逐 gid 反查（`<0A26> <53F0>`），`pdftotext -enc UTF-8` 因此还原中文而不是画符；
- `/W` 按 gid 连续段合并（`82 [500 500]`），宽度与排版同源，右对齐的表格列不错位；
- `DW 1000` 兜底，`CIDToGIDMap /Identity` 让 CID 就是 gid；
- `Flags 4`（Symbolic）：编码是我们自己的 `Identity-H`，不是某个 Latin 编码。

### 9.3 混排与「只有需要时才切换」

`text()` 逐字符串选字体：**纯 ASCII → 原来的 `F1`/`F2`，含非 ASCII → `F3`**。宽度也逐字符串选
（ASCII 走 Helvetica AFM，其余走 TTF advance），所以
`<仓库上级>\...` 与 `文件夹 老版` 在同一条路径里各用各的字号宽度，右对齐仍对得上。
粗体请求（`F2`）遇到中文仍落到同一 `F3`——SimHei 没有第二个字重，宁可少一层强调也不伪造。

信息页脚注会随状态改写（这也是 ASCII 文档唯一会变的地方——而它对 ASCII 文档不变）：
`base-14 Helvetica, no embedded fonts` → `Helvetica for ASCII, embedded SimHei TrueType for non-ASCII text`；
降级时 → `… no usable CJK TrueType face found: non-ASCII text is drawn as ?`。
`/Title` 等文档信息用 UTF-16BE + `FEFF` BOM，`pdfinfo` 也显示中文标题。

字体来源：`options.cjkFontPath` → `GRAPH_PDF_CJK_FONT`（`off` 关闭）→ `%WINDIR%\Fonts\simhei.ttf`
→ `Deng.ttf` → 若干 Linux 单体 CJK TTF。**不往仓库拷字体**，运行时读系统文件；读不到就降级。

### 9.4 纯 ASCII 回归：逐字节相同

| 文档 | 改动前 | 改动后 |
|---|---|---|
| clean（12 图，全 ASCII 元数据） | 330 802 B | **330 802 B，SHA-256 相同**（`ad491e922ed1ccdc4ae4aedf2ad251f7fc11f331be489b8589f8780cdb0fa886`） |
| b1（13 图，中文路径） | 1 682 344 B，路径是 `???` | **6 668 948 B**，路径正确 |

`buildPdfReport` 只在「有字符串真的走了嵌入字体」时才追加那 5 个对象；字体本身可用与否不影响
ASCII 文档（测试里同一份输入分别带字体/强制 `cjkFontPath: null` 生成，字节相同）。
`packages/graph/test/pdf.test.ts` 9 项全过，`pdf-unicode.test.ts` 另把 clean 的 SHA-256 钉死。

### 9.5 中文实测（真导出，不是手写 CSV）

```powershell
node packages/graph/tools/export-sbf-project.ts `
  --capture "../00_来源/samples/live-20261031/b1-20261101.sbf" `
  --out "%USERPROFILE%\AppData\Local\Temp\opencode\agent-pdfcjk\proj\b1" --name b1
# 再把 13 份 CSV 的 #Project Name: / #Project Directory: 改成「野外台站」/「<盘>:\测试\项目」
```

- `pdfinfo`：`Pages: 14`（1 页信息 + 13 页图），`Title: 野外台站 Report`，
  `Producer: … embedded SimHei for non-ASCII text`，无 xref 警告；
- `pdftotext -enc UTF-8 -f 1 -l 1`：`野外台站 Report` / `野外台站` / `<盘>:\测试\项目` 全部逐字还原，
  页面里没有一个残留的 `?`；
- `pdftoppm -r 110 -png` 第一页目视：标题、Project Name、Project Directory 都是正常汉字，
  不是方块也不是问号 —— `%USERPROFILE%\AppData\Local\Temp\opencode\agent-pdfcjk\render-01.png`；
- 同一份 b1（仓库里的样本 CSV，路径本身就是中文）改前/改后 `pdftotext` 全文比对：
  **2024 行里只有 2 行不同**——那条路径，和脚注那句说明，其余 2022 行一字不差。

### 9.6 体积

`simhei.ttf` 9 745 792 B；`deflate level 9` 后 4 983 830 B（0.511），PDF 净增约 **4.98 MB**
（不做子集）。任务书给的预算是 +9.7 MB，压缩后约为一半；`pyftsubset` 子集能到几十 KB，本轮没做。

### 9.7 没做到的

1. **不做子集**：整份 SimHei 进文件，所以每份含中文的报告都是 ~6.7 MB。子集要改 `glyf`/`loca`/
   `cmap` 并与 `/W`、`ToUnicode` 同步，风险与收益不划算（这些 PDF 是给人看的报告，不是分发件）。
2. **只认单体 `.ttf`**：`.ttc`（`Deng.ttc`、`msyh.ttc`）与 CFF 轮廓（`OTTO`）都不解析，直接降级并在
   信息页说明；Windows 上默认的 `simhei.ttf` 是单体，够用。
3. **非 BMP 字符**看字体覆盖：`ToUnicode` 支持代理对，但 SimHei 里没有 emoji，这类字符落成
   `.notdef`（`ToUnicode` 里记作 `<0000> <FFFD>`），不会变成错字。
4. **首次构建多 ~15 ms**（读 9.7 MB + 解析 cmap，之后按路径缓存）；纯 ASCII 文档也付这一笔，
   因为它无法预知后面有没有中文。
5. **混排 run 整体用 SimHei**：`<盘>:\测试\项目` 这条字符串里的 ASCII 也是 SimHei 的字形
   （SimHei 的拉丁是 500/1000 em 等宽），不是 Helvetica——这是「按字符串选字体」的直接结果，
   宽度与渲染一致，只是字形风格略有差别。

## 10 Web 端 PDF 也有中文了（B 类第 9 项续）

`/api/graph/pdf` 用的是**另一个** writer（`packages/app/src/pdf.ts`，46 KB，版式与 graph 那套
不同：页眉页脚 chrome、封面 Chart Summary 表、一图一页）。它原来也是 base-14 Helvetica +
`?`。本轮把字体能力**抽成公共模块**并接到 app 上，graph 的输出一个字节没动。

| 项 | 状态 |
|---|---|
| 公共模块 | 新增 `packages/graph/src/pdf-font.ts`（TTF 解析 + PDF 字体对象 + ToUnicode + 宽度 + 降级）；两个 writer 共用 |
| graph 回归 | `pdf.ts` 只是改为 import 公共模块：clean **330 802 B / SHA 不变**，b1 含中文 **6 668 948 B / SHA 不变** |
| app ASCII | **逐字节不变**：137 644 B，SHA-256 `b19c81b0f69b4744454b068abf35b438dfa1622bbfe1673bda7cdf3ba116983b`（与 git HEAD 的 writer 相同） |
| app 中文 | `/FontFile2` + `/Identity-H` + `/ToUnicode` + `/W`，`pdftotext` 取回 `野外台站` / `<盘>:\测试\项目` |
| Web 实测 | `GET /api/graph/pdf?project=_cjkweb` → **200**，14 页，5 168 121 B，渲染正常 |
| 测试 | 新增 `packages/app/test/pdf-unicode.test.ts` 7 项；app 包 **313/313**；全量 **1042/1042**（并行任务还在加测试，总数会浮动） |

### 10.1 公共模块怎么切

`pdf-font.ts` 导出：`beginPdfFont/endPdfFont`（一篇文档一份状态）、`embeddedFace()`、
`hasNonAscii()`、`cjkTextWidth()`（返回 `null` 表示「用调用方自己的 ASCII 度量」）、
`encodeCjkText()`、`markCjkDegraded()`、`cjkUsedEmbedded()/cjkUsedDegraded()`、
`pdfUnicodeString()`（信息字典用，ASCII 返回 `null`）、`buildCjkFontObjects(face, first)`（返回
5 个对象 + Type0 的编号）、`pdfCjkFontStatus()` / `resetPdfFontCache()`。

两个 writer 的接法一致：

- **度量**：`textWidth` / `advance` 第一行先问 `cjkTextWidth`，非 `null` 就用 TTF advance；
- **选字体**：含非 ASCII 的字符串用 `/F3` + `<hex> Tj`，纯 ASCII 仍走 `F1`/`F2` + `(literal) Tj`；
- **对象**：字体对象挂在页面之后编号，纯 ASCII 文档根本走不到那个分支，所以对象号与字节都不变；
- **封面脚注**：`base-14 Helvetica, no embedded fonts` → `… for ASCII, embedded SimHei TrueType
  for non-ASCII text`；降级时 → `… no usable CJK TrueType face found: non-ASCII text is drawn as ?`。
  为了知道该说哪句，封面先渲染一遍探测、再按结论渲染一遍（只多算一页字符串，字节可复现）。

### 10.2 顺手修掉的两个 500（app 端发现的既有缺陷）

两个响应头都由 `#Project Name:` 拼出来，而 **HTTP 头值只能是 ASCII**，Node 直接抛
`ERR_INVALID_CHAR`：

```
Content-Disposition: attachment; filename="野外台站.pdf"   → 500
X-PDF-Project: 野外台站                                     → 500
```

实测（起服务打 `?project=_cjkweb`）：先炸 `Content-Disposition`，修好后接着炸 `X-PDF-Project`。
修法留在 `packages/app/src/pdf.ts`（本任务允许的文件，没碰 `server.ts`）：`graphPdfFileName()`
与 `GraphPdfReport.project` 都走 `asciiHeaderValue()`，非 ASCII 按 UTF-8 转 `%XX`
（`野外台站` → `%E9%87%8E%E5%A4%96%E5%8F%B0%E7%AB%99`，可逆、确定）。PDF 自己的 `/Title`
仍是 `野外台站 Report`。

> 代价：下载文件名变成 `%E9%87%8E%E5%A4%96%E5%8F%B0%E7%AB%99.pdf`。更体面的做法是响应头写
> `filename*=UTF-8''…`（RFC 5987），但那要改 `server.ts` 的 header 构造，超出本轮边界，
> 留作后续。

### 10.3 实测

```powershell
# 临时工程：把 b1 的 13 份 CSV 拷进 export/_cjkweb/csv 并改两行注释（仓库样本没动，跑完即删）
node packages/app/src/server.ts --port 7872
curl "http://127.0.0.1:7872/api/graph/pdf?project=_cjkweb" -o web-cjk.pdf
```

- `HTTP 200`，`Content-Type: application/pdf`，`X-PDF-Pages: 14`（1 封面 + 13 图）；
- `pdfinfo`：14 页、A4 横向、`Title: 野外台站 Report`、
  `Producer: packages/app hand-written PDF 1.4, embedded SimHei for non-ASCII text`；
- `pdftotext -enc UTF-8 -f 1 -l 1`：`野外台站`（页眉与标题）、`<盘>:\测试\项目` 全部逐字还原，
  页面里没有残留 `?`；
- `pdftoppm -r 110 -png` 第一页目视正常（页眉、标题、Project Name/Directory、Chart Summary 表
  都对得上）：`%USERPROFILE%\AppData\Local\Temp\opencode\agent-pdfcjk-web\web-page1-01.png`；
- 同一份 CSV 用固定时钟本地构建（不经 HTTP）：5 126 085 B / 13 页，
  `web-render-01.png`；`?project=clean` 的 ASCII 文档仍是 137 552 B（页码/时钟与固定时钟构建不同，
  逐字节比对用的是 `generatedAt` 固定的那两份）。

### 10.4 没做到的

1. **下载文件名是转义形式**（见 10.2），要变成真中文名需要 RFC 5987 的 `filename*`，得改 server。
2. 与 graph 一样**不做子集**：含中文的 app 报告 ~5 MB（整份 SimHei，Flate 后 ≈4.98 MB）。
3. app 的 `advance()` 里 ASCII 仍用经验宽度（0.278/0.64/0.53 em 的估算），只有中文 run 用真实
   TTF advance；这是原文件的既有取舍，本轮没改。

## 11 Flags：Pre-process 时间轴标记（A3）

> 本节是本轮新增。`packages/app/src/web/panels/graph.js` 里的 `Flags (0/10)` 原来只是字面量
> （文件里自己写着 “no flag store exists in this build”），现在接上了真正的 flag store。
> 原版语义逐条从 `逆向/01_解包/Graph/out/renderer/assets/index-B86bHcCD.js` 量出，`@` 后是
> bundle 的**字节偏移**；`06_Graph应用.md §3.4/§6.6/R32` 是早先的记录，可互相核对。

### 11.1 原版量到的语义

| 项 | 原版行为 | 证据 |
|---|---|---|
| 上限 | 10 个 | `MAX_FLAGS = 10` `@1410884`；`N0_FLAGS_TEXT` “You can add up to 10 flags” `@366399` |
| 计数口径 | `allFlags` 去掉 `trashFlag` | `getTotalFlags` `@1414959`；`TimelineFlagsInfo` 的 `(n/10)` `@13839509` |
| 存储 | 工程 `.gpf` 的 `FlagsInitialState: {allFlags,isFlagsPanelOpen}`，关窗时回写 | `@16246801`、`@16247254`；`06_Graph应用.md §6.6` |
| 恢复 | `newFlagId = max(id) + 1` | `setStoreDefaults` `@554660` |
| 标记对象 | `{id, timeCaptured(ms), color, latitude, longitude, height, description, state}` | `addFlag` payload `@1424990`、slice `@191629` |
| 状态 | `activeFlag / hiddenFlag / hoverFlag / trashFlag / selectedFlag` | `FlagsStatus` `@191150` |
| 怎么加 | 地图轨迹单击（裁剪区内，先过 `canAddFlag`）`@13681498`；图/时间轴右键 `@15708071`（取 `globalHover` 的时间）；弹窗 **Apply** 才落库 | `AddFlagFooter` `@1423811` |
| 重复 | `abs(timeCaptured − t) < 1000 ms` 且不在回收站 | `@1424277`；`HAS_ALREADY_DUPLICATEACTIVE_FLAG` |
| 标签 | `description`（弹窗 “Type a comment (optional)”） | addFlag payload `@1424990` |
| 跳转 | 时间轴/面板点击 = **选中并打开编辑**（`selectedFlag`），**不移动播放头**；时间轴标记可拖拽改时间 | `handleFlagClick` `@13822690`、`@15707363`；拖拽 `@13846897` |
| 删除 | **软删**：`state = trashFlag`；回收站可 Restore / Empty trash；恢复同样守 10 个与重复时间点 | `handleEditDelete` `@1425006`（按钮绑定 `@1424380`）；eye tooltip `@1454591`；`deleteTrash` `@191920` |
| 隐藏 | 眼睛在 `activeFlag ↔ hiddenFlag`，隐藏的不画在时间轴 | `@1454591`；`FlagsList` `@13821924` |
| 颜色 | 每个 flag 一个 `ColorPicker`，默认 `#F95B61` | `@1410884`、`@1455340` |
| 取消 | Add 弹窗 Cancel 不入库 | `handleClose('cancel')` `@1424056` |

### 11.2 本重实现（`graph.js`）

- **纯函数 store**：`addFlag / updateFlag / trashFlag / restoreFlag / emptyTrash /
  toggleFlagVisibility / selectFlag / clearFlagSelection`，判定用 `canAddFlag / flagAtTime /
  nextFlagId / flagTotal`；state 形状与原版 slice 一致
  （`{allFlags, editFlagId, newFlagId, isFlagsPanelOpen}`），可以直接被 Node 单测。
- **时间**：`timeCaptured` 保持原版的**毫秒时间戳**。CSV 有 `#Start Time(GPS)` 时用
  `parseGpsStamp` + `gpsSecondsToMs` 换成 epoch ms（`timeBase: 'gps'`）；没有 GPS 头的 CSV
  退回本文件 elapsed 毫秒（`timeBase: 'elapsed'`）。`timeBase` 是**本地补的字段**——原版只有
  工程绝对时间，没有“文件无 GPS 头”这种情况。
- **交互**：右键时间轴 → 该 x 的草稿时间 + 评论框，Add Flag / Enter 落库；`Flags (n/10)`
  打开面板；列表可点击跳转、隐藏/显示、移入回收站、改色，回收站里 Restore / Empty trash；
  时间轴标记悬停出 tooltip（`flag #n`、GPS 时间、lat/lon/高度、评论），与原版 tooltip 的三行
  一致（`FlagsList` `@13821924`）。
- **持久化**：工程目录里有 `.gpf` 时读/写它的 `FlagsInitialState`（`packages/graph/src/
  export-projects.ts` 的 `readProjectFlags` / `writeProjectFlags`：只动这一个键，其它键、键序、
  缩进、换行、BOM、结尾换行与 `checksum` 全部原样保留；坏 JSON 只报告、绝不覆盖）；没有 `.gpf`
  时回退 `localStorage`，键 `nas.graph.flags.v1::<projectKey>`，切工程换桶。面板侧
  `createFlagStore({storage, api})` 先用 `localStorage` 出首屏，再异步做一次能力探测
  （`/api/health` 的 `endpoints` 里有没有 `/api/graph/flags`；直接打一个不存在的路由会在浏览器
  里留下 404 console error，所以不用"试错"），有则 `GET /graph/flags?project=` 换成 `.gpf` 的
  `FlagsInitialState` 并改由 `POST` 保存；等待期间用户若改过 flags，以本地为准回写 `.gpf`。
- **上限/重复/回收站/恢复限制**与原版同一条判定：`FLAG_LIMIT = 10`、
  `FLAG_DUPLICATE_WINDOW_MS = 1000`；恢复先查上限、再查重复（顺序同原版 tooltip）。

### 11.3 与原版不一致 / 本地实现（不声称 1:1）

1. **持久化介质**：原版写工程 `.gpf`（`FlagsInitialState`，关窗握手 `@16246025`）。本构建两半都实现
   并接上了：文件读写在本仓库 Node 侧（`readProjectFlags` / `writeProjectFlags`，见 11.2），面板通过
   `/api/graph/flags` 读写它；工程目录没有 `.gpf` 时，**第一次保存会按 §11.5 的规则生成一个**，
   之后由它接管。字段名、形状、恢复规则（`newFlagId = max(id)+1`）与原版一致。
2. **点击跳转**：原版点击标记/列表行是选中并打开编辑，**不移动播放头**；这里“点击跳到该时间”
   是本地加的（任务要求），列表按钮 `title` 与本节都标了“本地”。
3. **“在当前 playhead 加”**：原版只有右键 / 地图点选 / 弹窗；`ADD_FLAG_TS` 文案在包里定义但
   **没有任何调用点**（只出现在 i18n 表 `@367735`、`@378006`）。面板的 Add Flag 用 playhead
   是本地实现（草稿时间在标签里可见，右键会改成那个点）。
4. **拖拽标记改时间**：原版时间轴标记可拖动（`calculateFlagTimeFromMouse` `@13846849`，落到
   最近定位点）；本实现**没做拖拽**。
5. **地图侧 flag**：原版在地图 `flagsLayer` 上也画/加 flag（`flagsLayer` 图层名见
   `06_Graph应用.md §6.7`；地图单击入口 `@13681498`）；这里只有时间轴与面板，地图上没有标记。
6. **单条永久删除**：原版只有 Empty trash（没有单条永久删），本实现相同。
7. **颜色**：默认值与原版一致；颜色只影响时间轴标记与列表色块，地图不渲染 flag，所以看不出
   差别。

### 11.4 测试与截图

`packages/app/test/graph-flags.test.ts` **18 项**：上限（10 个后第 11 个 `limit`）、1 s 重复
窗口（999 / 1000 ms 边界）、增删/回收站/恢复（含恢复时 `limit` 与 `duplicate`）、隐藏、单选中、
GPS↔ms 往返、`flagOffsetSeconds`（无 GPS 头返回 `null`）、每工程一桶 + save/load + 切工程不串 +
坏 JSON/无 storage、`.gpf` 形状读取 + `newFlagId = max(id)+1`。

`.gpf` 持久化（D5 + B/E1）另有 **31 项**：

- `packages/graph/test/gpf-flags.test.ts`（16 项）：`<key>.gpf` → `<name>.gpf` → 目录里唯一
  `.gpf` 的解析；复制 `clean.gpf` 后写→读回、去掉 `FlagsInitialState` 与原文件**逐字节相同**、
  二次写入不变；2 空格/LF/CRLF/BOM/四空格/结尾换行都照原样；坏 JSON/坏 `FlagsInitialState`
  只报告不改写；两个工程互不影响；非对象文本 `mergeGpfFlags` 返回 `null`；**§11.5 的创建规则**
  （checksum 算法在 `clean.gpf` 上复算一致、字段来源、键集合是 `clean.gpf` 的子集、
  `PlotSummary` 按页签分组、空列表 / 无时间窗 / 目录里已有认不出的 `.gpf` 都不建、
  坏 `project.json` 不改写）。
- `packages/app/test/graph-gpf.test.ts`（15 项）：浏览器侧与 Node 侧 `mergeGpfFlags` 在
  `clean.gpf` 与 5 种文件形态上**逐字节一致**；临时工程写 flags 后经 `createFlagStore`
  "重开"恢复、其它键逐字不变、保存 POST 到 `/graph/flags`；没有 `.gpf` 时第一次**带标记**的保存
  问一次"要不要建"（服务端拒了就只留 `localStorage`，不重复问；空列表的保存不消耗这一次机会）；**
  真起 `server.ts` 走 HTTP**：`GET` 报 `gpf:false` → `POST` 一个标记 → `created:true` + 文件落盘 +
  checksum 可复算 → `GET` 读回同一份标记 → 再 `POST` 字节不变 → 清空列表仍写文件（不删）；
  未装样本的工程（`csv`）投空列表不会生成文件；不存在的工程 404。切工程不串、坏 JSON/无 storage 不炸。

实测（Playwright，1600×1000，`node packages/app/src/server.ts --port 7799`，b1 的
`2D Trajectory.csv`，28 s）：

- 右键加 5 个 → `(5/10)`、时间轴 5 个标记；补到 10 → 第 11 个提示
  `Maximum number of flags reached`；空出一个后右键同一点 → `There's already a flag at this timestamp`；
- 点 `flag #1` → 时钟 `00:00:00` → `00:00:03`；
- 隐藏 → 计数仍 `(10/10)`、标记 9；删除 → `(9/10)`、标记 8、提示 `Flag moved to trash`；
  Restore → `(10/10)`、`Flag restored successfully`；Empty trash → 回收站空；
- 刷新后 b1 仍是 9 个；切到 `csv` 工程 `(0/10)`，切回 b1 恢复 —— 不串；
- console errors **0**，无 pageerror（唯一 warning 是 Luciad/WebGPU 的
  `ValidateTextureDescriptor`，与本改动无关）。

截图（`%USERPROFILE%\AppData\Local\Temp\opencode\agent-flags\`）：
`flags-timeline-tooltip.png`（4 个标记 + tooltip + `(4/10)`）、`flags-panel-list.png`
（面板列表：时间/偏移/坐标/评论/颜色/眼睛/垃圾桶）、`flags-panel-full.png`（整页）。

D5 复跑（2026-11-02，`%USERPROFILE%\AppData\Local\Temp\opencode\agent-graphmeta\`，
独立 Chromium、`?map=canvas` 绕开 headless 无 WebGPU 的 Luciad 报错）：

- 右键时间轴 4 个点 + Add Flag → `(4/10)`、时间轴 4 个标记，`flag #1` 带评论
  `antenna moved — check cabling`；刷新后仍 `(4/10)`（`nas.graph.flags.v1::b1` 782 B）；
  切到 `clean` 为 `(0/10)`，切回 b1 仍 4 个 —— 不串；
- console errors **0**、pageerror **0**；
- 截图：`flags-panel-tooltip.png`（面板列表 + 标记 tooltip）、`flags-panel-full.png`（整页，
  面板含时间/偏移/坐标/评论/颜色/眼睛/垃圾桶）、`flags-switch-clean.png`（切工程后 `(0/10)`）。



截图（`%USERPROFILE%\AppData\Local\Temp\opencode\agent-gpfcreate\`，1600×1000）：
`gpf-created-b1.png`（b1 加第一个标记，`Flags (1/10)`，此前的 `GET` 是 `gpf:false`）、
`gpf-after-refresh.png`（**清空 localStorage 后**刷新：标记与评论从新建的 `b1.gpf` 读回来）、
`gpf-other-project-clean.png`（切到 clean 仍是 `(0/10)`，没有串）。

### 11.5 工程没有 `.gpf` 时：第一次保存创建它（B/E1）

D5 只做到"有 `.gpf` 就读写，没有就 `localStorage`"，而三个 export 目录（`csv` / `b1` /
`heading`）都没有 `.gpf`，所以标记一直没落到工程文件上。现在补上创建。两条路里选的是**前者**：
**照 `clean.gpf` 的骨架写一份真文件**，而不是"只写 flags 的私有记录"。

**创建规则**

- **骨架**：键与键序照 `00_来源/samples/graph/project/clean.gpf`（一份真能打开的工程文件），
  代码里是常量，不依赖运行时能不能找到样本目录。创建出来的顶层键是 `clean.gpf` 的**子集** +
  `FlagsInitialState`——测试直接钉住"不发明字段"。
- **文件名**：`<projectDirectory>/<basename(projectDirectory)>.gpf`，原版 `getGpfFilePath()`
  `@538881` 的原式；也就是 `export/b1/` → `b1.gpf`，`export/csv/` → `csv.gpf`。
- **写盘形态**：`JSON.stringify(data, null, 2)`，LF，无结尾换行（原版 `writeFile`
  `JSON.stringify({...data, checksum}, null, 2)` 同形）。

| 字段 | 值从哪来 | 依据 |
|---|---|---|
| `PageRoute` | `"/process"` | 打开后直接进 Pre-process 页 |
| `projectDirectory` | 工程目录（绝对路径） | — |
| `filePath` | `project.json` 的 `capture`；没有就 `""` | 原版是原始日志路径 |
| `filename` | CSV 的 `#Data File Name:` → `project.json.dataFileName` → `""` | — |
| `fileTimeline.StartTime/EndTime` | CSV 的 `#Start Time(GPS)` / `#End Time(GPS)`，按 **GPS 毫秒** `(week*604800 + s)*1000` | `clean.gpf` 的 `1477384697350` 正是 `2442,463097.350` 的 GPS 毫秒（不是 epoch ms） |
| `updatedProjSummary.DataInfo` | `{Duration: End−Start, EndTime, FileSize, StartTime}` | `DataInfo.StartTime/EndTime` 驱动播放头 `@554827` |
| `DataInfo.FileSize` | `stat(capture)` 的真实字节数；读不到就 `0` | `clean.gpf` 的 `270864` = `convert\clean-9600.gps` 的大小 |
| `updatedProjSummary.Messages` | `project.json` 的 `messages`（导出工具自己解出的帧计数），按名字排序 | — |
| `TotalLogInstances` | `Messages` 之和 | `clean.gpf`：`5+1+1+100+8+4 = 119` |
| `updatedProjSummary.PlotSummary` | 只列**本工程真的有的 CSV**，`{图表名: {消息: 1}}`；分组按**页签**（`CPU Usage` 归 `Receiver_Status`，虽然它画的是 `BESTPOS`） | `clean.gpf` 里每张图的值都是 `1`（"这张图有序列"，不是记录数）；页签归属同 `html.ts#SECTIONS` |
| `InputValidation` / `Percentage` / `ValidationCode` / `api` | `0` / `100` / `0` / `"FileValidation"` | 原版"处理完成、校验通过"的状态（`validateGpsDataInFile`，`ValidationCode 0 = SUCCESS`） |
| `currentTimeStamp` / `isPlaying` / `editedStart` / `editedEnd` | `0` / `false` / `0` / `0` | 播放位置与裁剪区间的默认值 |
| `FlagsInitialState` | 这次保存的 `{allFlags, isFlagsPanelOpen}` | — |
| `checksum` | 见下 | — |

**故意不写的字段**（写了就是编）：

- `DataSummary` / `GOSMetaPath`：它们指向的 `DataSummary.json`、`GOS/*.db` 在 export 目录里
  根本不存在；而 `updatedProjSummary` 已经让 `fetchDataSummary` `@549299` 不走 `DataSummary`。
- `PersistenceInfo`：这是**用户**的图块布局；`@602242` 显示没有它时 Graph 会用
  `getSupportedChartsList(PlotSummary)` + `frameNewPersistenceObj` 自己搭一份。
- `projectName` / `projectDescription`：`clean.gpf` 里没有这两个键；Graph 的工程名就是
  `basename(projectDirectory)`（`updateGPFRecentActivity` `@550800`）。

**校验和不是猜的**：`addChecksum` / `verifyChecksum` `@549299` ——
`SHA-256(JSON.stringify(去掉 checksum 的对象) + "GAA170P4468F1218")`，小写 hex；**键序参与哈希**，
所以写入永远不重排键。对 `clean.gpf` 复算得到它自己存着的
`8827df04…9e6fff`（测试里独立写了一遍算法，不是拿自己的输出自证）。已有 `.gpf` 的写入也
**re-sign**（`writeProjectFlags(..., {resign: true})`），否则原版打开会判 `INVALID_GPF_FILE`
——这是 D5 留下的一个真缺陷，本轮一并修掉；纯 `mergeGpfFlags` 的默认行为不变（只动那一个块）。

**什么时候写、什么时候不写**

| 情况 | 行为 |
|---|---|
| 目录里没有 `.gpf`，这次保存**带标记** | 创建，返回 `created: true` / `gpf: true` |
| 目录里没有 `.gpf`，这次保存是空列表 | 不创建（`no-gpf`）；面板自己也会存 `isFlagsPanelOpen`，那次保存不算"第一次" |
| CSV 里读不到任何可用时间窗（没有 `#Start/#End`、没有带 GPS 时间的行、`project.json` 也没有） | 不创建（`no-data`），路由回 `gpf:false`，前端继续 `localStorage` |
| 目录里已有两个及以上认不出的 `.gpf` | 不猜、不建第三个（`no-gpf`） |
| 已有 `.gpf` 但 JSON 坏了 | 一律不覆盖（`bad-json`），前端回退 `localStorage` |
| 写盘 | 先写临时文件再 `rename`，崩了也不会留半个文件 |

**顺手修的两处（都在 `/api/graph/flags`）**

1. POST 原来只读 `?project=`，而面板的 `api.post(path, body)` **带不了查询串**（`web/index.html`）
   ——于是所有工程的标记都会被写进**默认**工程（`csv`）的 `.gpf`。现在 `body.project` 生效，
   `?project=` 仍然优先。
2. `GET /api/graph/flags?project=`（空值）原来落到 500 分支（`GraphCsvError` 没被转成
   `HttpError`）：现在返回 `{ok:true, gpf:false}`（"面板还没选工程"），POST 空 `project` 返回 400。

**边界（明说）**：这**不是**"原版能画出图"的工程。export 目录里只有 CSV，没有 Process 页要读的
`GDS`/`GOS` 数据库，所以 12 张图无法重建。这里保证的是**工程文件本身**：结构、时间窗、
消息计数、图表清单、标记与 checksum 都是真的，`validateGPF`（JSON + 校验和）能通过；
"原版打开后能画出那 12 张图"没有验证，也不声称。

**实测**（`node packages/app/src/server.ts --port 7811`，Playwright 1600×1000，`?map=canvas`）：

- b1 加第一个标记 → `POST /api/graph/flags` `200` `{ok:true, gpf:true, created:true,
  path: …/export/b1/b1.gpf}`；磁盘上 3021 B，`checksum` 复算一致，`DataInfo`
  `{StartTime:1477491827100, EndTime:1477491855151, Duration:28051, FileSize:2758111}`，
  `Messages` 25 条 / `TotalLogInstances 1321`，`PlotSummary` 三组（PVT 7 张、接收机 3 张、
  跟踪 3 张）；
- **清空 `localStorage`** 再刷新 → `GET ?project=b1` → `gpf:true`，标记与评论原样回到面板
  （`Flags (1/10)`，tooltip 带评论），刷新后 `localStorage` 仍是 `null`——即恢复来自 `.gpf`；
- 切到 clean（`csv`）仍是 `(0/10)`，`GET ?project=csv` 是 `gpf:false`（没有顺手给 clean 造文件）；
- console errors **0**、pageerror **0**。
- 截图：`gpf-created-b1.png`、`gpf-after-refresh.png`、`gpf-other-project-clean.png`
  （`%USERPROFILE%\AppData\Local\Temp\opencode\agent-gpfcreate\`）。跑完把生成的
  `export/b1/b1.gpf` 删掉，样本目录保持原样（`git status` 里不留文件）。



## 12 Heading & Attitude：第 14–16 张图（合成帧验证，**未实机验证**）

原版 Graph 的页签顺序是 Overview → PVT → **Heading & Attitude** → Tracking & Measurements →
Receiver Status → Project Information；本构建此前只有 4 个图表页签，这一节把缺的那一组补齐。

**先说清楚边界**：本机接收机 `ANTENNA=SINGLE`、无 IMU、IMU/INS `UNAUTHORIZED`，所以
**没有任何原版 Heading & Attitude CSV** 可做逐字节对照（`export/`、`export-broad/` 里也都没有）。
下面的"列名 / 列序 / 字段 / 消息优先级"全部读自原版程序本身，"数值"来自合成抓包，两者不混用。

### 12.1 页签与图表目录（`C_图表目录.json` / renderer bundle）

`index-B86bHcCD.js` 与 `C_图表目录.json` 里这一组是：

| 页签 | 图表标题 | 图表类型 | y 轴单位 | PlotSummary 键 |
|---|---|---|---|---|
| Heading & Attitude | `Azimuth` | line | `(degrees)` | `INS Orientation Azimuth` |
| Heading & Attitude | `Roll and Pitch` | line | `(degrees)` | `INS Orientation Pitch` |
| Heading & Attitude | `SPAN Filter Updates` | bar | 无 | `SPAN Filter Updates` |

- `GRAPH_GROUPS.HEADING_ATTITUDE = "Heading & Attitude"`、`GRAPH_GROUPS_TABS` 里是
  `Heading_Attitude`（@564742 起）；`HAGraphs` 三项的 `table` 分别是 `insattitude_azimuth` /
  `insattitude_pitch` / `insupdate`。
- **PlotSummary 的键与 CSV 标题不同**：原生模块 `HAEdieLogParser` 那一段字符串
  （windows `.node` @4365152–4365360）依次是 `insattitude_pitch` `insattitude_azimuth`
  `insUpdatestatus` / `INS Orientation Pitch` `insattitude_pitch` / `INS Orientation Azimuth`
  `insattitude_azimuth` / `SPAN Filter Updates` `insUpdatestatus` `count` `count`。
  所以代码里用 `ChartCsvSpec.plot = { title, message }` 做别名，而不是把 CSV 标题硬塞进
  `PlotSummary`。

### 12.2 列名与列序（原生模块的 CREATE TABLE，不是猜的）

linux `graph-node-wrapper.node` 保留动态符号，可直接反汇编构造函数
（`objdump -d --start-address=0x30ea60`，VMA 与 .rodata 文件偏移相同）：

- `INSATTITUDE::INSATTITUDE` 建两张表：
  `createTable({timestamp,TEXT},{[INS Azimuth],REAL})` 与
  `createTable({timestamp,TEXT},{[INS Pitch],REAL},{[INS Roll],REAL})`。
  立即数 `0x6d617473656d6974`="timestamp"、`0x54584554`="TEXT"、`0x4c414552`="REAL"、
  `0x6d697a4120534e49`="INS Azi"+`muth]`、`0x74695020534e495b`="[INS Pit"+`ch]`、
  `0x6c6f5220534e495b`="[INS Rol"+`l]`。
  → **`Roll and Pitch.csv` 的列序是 `INS Pitch` 在前、`INS Roll` 在后**（不是按标题顺序）。
- `INSATTITUDE::addPoint(INSBaseData*)`（@0x310130）：三个值都用 `printf("%f")` 写字符串
  （格式串 `%f` @0x5fa985、时间乘 1000.0 @0x5f4f80），并映射到
  `+0x60 → INS Roll`、`+0x70 → INS Pitch`、`+0x80 → INS Azimuth`（0x3106f9 赋 `0x100` 给
  "INS Pitch"，0x310816 赋 `0x120` 给 "INS Roll"）。
- `INSLogDecoder::SetData`（@0x2c0530）决定这三个偏移来自报文的哪一段：INSPVA(#507)
  取 payload +0x3c / +0x44 / +0x4c，INSPVAX(#1465) 取 +0x3c / +0x44 / +0x4c，
  与 `edie-layouts.json` 的 `roll` / `pitch` / `azimuth` 偏移一致。
- `INSUPDATE::INSUPDATE`（@0x306d00）建跨度表：
  `createTable({name,TEXT},{start,TEXT},{end,TEXT},{value,TEXT},{min_diff,TEXT})`。
  → `SPAN Filter Updates.csv` 的表头是 `name,start,end,value,min_diff`。
- CSV 文件名来自 `DbToCsvConverter` 的 `kDbBaseNames`（windows `.node` @7308656 起）：
  `Roll and Pitch → insattitude_pitch`、`Azimuth → insattitude_azimuth`、
  `SPAN Filter Updates → insupdate`。
- `SPAN Filter Updates` 的条件名是同一模块 @7396664 起的 33 个字面量（位序）：
  `Position update` / `Phase update` / `Zero velocity update` / `Wheel sensor update` /
  `ALIGN (heading) update` / `External position update` / `INS solution convergence flag` /
  `Doppler update` / `Pseudorange update` / `Velocity update` / `Reserved_10` / … / `Reserved`。

### 12.3 消息来源与优先级（为什么 HEADING2 不进这张图）

原生模块里有一张"每个 log → 每张图优先级"的表（windows `.node` @7450491 起），
Heading & Attitude 相关项：

```
1465 INSPVAX    Roll and Pitch 1  Azimuth 1  SPAN Filter Updates 1
507  INSPVA      2                 2           —
508  INSPVAS     3                 3           —
1457 INSATTX     4                 4           3
263  INSATT     5                 5           —
1889 INSPVACMP   6                 6           —
1459 INSPOSX     —                 —           2
1458 INSVELX     —                 —           4
```

**`1335 HEADING2` 与 `1761 DUALANTENNAALIGN` 不在这张表里**（全表 46 条，逐条查过）。
也就是说原版的双天线航向**不喂任何一张 Graph 图表**：一台只有 `HEADING2` 的接收机，
Heading & Attitude 页签是空的。本构建照此办理，`sourceMessages` 里没有这两个消息号。

### 12.4 合成抓包与实测（`packages/graph/tools/make-heading-capture.ts`）

`headingCapture()` 用 `逆向/tools/oracle.ts` 的 `frame()` 造 1231 B：

| 帧 | 数量 | 内容（可辨认的序列） |
|---|---|---|
| INSPVAX #1465 | 6 @1 Hz，week 2442 / 470000.000 s 起 | roll `1.5…6.5`、pitch `-0.75…-5.75`、azimuth `100.125…105.125`；`extended_sol_stat` 位 0 每帧、位 4 第 3–4 帧、位 25 第 5–6 帧 |
| HEADING2 #1335 | 3 | heading `45/46/47`（**诱饵**，必须不出现在任何 CSV 里） |
| DUALANTENNAALIGN | 1 行 ASCII | 第二个诱饵（文本命令，解码器不认，消息计数里也没有） |

`node packages/graph/tools/make-heading-capture.ts --out …` 之后
`node packages/graph/tools/export-sbf-project.ts --capture … --out … --name heading` 实测：

```
#Start Time(GPS):      2442,470000.000
#End Time(GPS):       2442,470005.001
#Duration:                   00:00:05
timestamp (GPS week sec),INS Azimuth
2442  470000.000,100.125000
2442  470001.000,101.125000
…

timestamp (GPS week sec),INS Pitch,INS Roll
2442  470000.000,-0.750000,1.500000
2442  470001.000,-1.750000,2.500000
…

name,start,end,value,min_diff
ALIGN (heading) update,1477391602000.000000,1477391604000.000000,1,1.000000
Alignment direction verified,1477391604000.000000,1477391605000.000000,1,1.000000
Position update,1477391600000.000000,1477391605000.000000,1,1.000000
```

**数值来源已核对**：`100.125` 来自 `azimuth`、`-0.75` 来自 `pitch`、`1.5` 来自 `roll`；
若列接错会看到 `45/46/47`（HEADING2）或 pitch/roll 互换，测试对此逐行断言。

### 12.5 唯一"推断"的地方

`SPAN Filter Updates` 的**区间规则**没有原版导出可证：代码复用了同族跨度表
`Receiver Status.csv` 上已被 golden 证死的规则（位首次置位处开、清位的那一帧收，
窗口末帧仍未清则收在末帧），`value` 恒为 `1`（golden 里 `value` 就是这个常数），
`min_diff` 取该位相邻两次置位的最小间隔（秒，`%f`；渲染器乘 1000 后用它步进）。
这三条只有**合成帧**验证，**没有**逐字节对照 —— 报告与测试里都标了"未实机验证"。

### 12.6 代码落点

- `packages/graph/src/csv.ts`：`ChartCsvSpec.sourceMessages` / `plot` 两个可选字段、
  `plotTitlesOf()`、`chartRecords()` 的多源按时间取最优、`AZIMUTH_COLUMNS`、
  `ROLL_AND_PITCH_COLUMNS`、`INS_UPDATE_NAMES`、`spanFilterUpdateSpans()`、
  `renderSpanFilterUpdates()`，以及 `CSV_CHARTS` 里的三条（现在的总数是 16）。
- `packages/graph/tools/export-sbf-project.ts`：`sectionOf()` 认得 INS 消息 →
  `Heading_Attitude`；`plotSummaryOf()` 用 `plot.title` / `plot.message` 写原版那三个键；
  `dataInfoOf()` 的时间窗也把 `sourceMessages` 算进去。
- `packages/app/src/web/panels/graph.js`：`TABS` / `CHART_GROUPS` 加 `heading` 页签与 3 块图块，
  `rowsAsSeries` 支持 `valueColumn`（跨度表最后一列是 `min_diff`，不能按位置取）。
- `packages/graph/test/heading-attitude.test.ts`（10 项）+ `packages/app/test/graph-tabs.test.ts`
  的两项（列名对齐、曲线数值）。
- `export-sbf-project.ts#plotSummaryOf`：多源图表的计数按**不同时间戳**算（与原版
  `INSERT OR IGNORE` 于 timestamp 一致），不是把各消息帧数相加。
- 样本：`00_来源/samples/graph/synthetic/heading.sbf` → `00_来源/samples/graph/export/heading/`
  （落地页第 3 张卡）。

### 12.7 实测与回归

- `node --test --test-force-exit "packages/*/test/*.test.ts"`：**1100 项，1099 通过**；
  唯一红的是 `packages/session/test/session.test.ts` 的 heartbeat 偶发（负载相关，改动前就存在，
  单跑 11/11 全过），与本任务无关。Graph 包单跑 **67/67**，app 的 `graph-*` 单跑 **74/74**。
- `node ..\tools\golden-check.ts`：**14 份 golden 全字节相同**。
- Playwright（1440×1000，`node packages/app/src/server.ts --port 7845`）：点 `heading` 卡 →
  Heading & Attitude 页签 → 3 块图块都出 SVG，页脚"3 张图的 CSV 都在，全部画出来了"；
  console **0 error**，无 pageerror（唯一 warning 仍是 Luciad/WebGPU 的
  `ValidateTextureDescriptor`，与本改动无关）。
- 截图：`%USERPROFILE%\AppData\Local\Temp\opencode\agent-heading\heading-tab.png`。

### 12.8 仍然没做到的

1. **没有原版 CSV**：三张图的值只能说"来自正确的字段"，不能说"与原版逐字节相同"。
   `SPAN Filter Updates` 的区间规则是推断（§12.5）。
2. **PDF 的页序表没改**（`packages/app/src/pdf.ts` 的 `CHART_SPECS` 不在本任务边界内）：
   三份新 CSV 仍会各出一页，但按"未知文件"走兜底（标题=文件名、折线），
   排在已知图表之后，不是原版 Heading & Attitude 的位置。
   （§13 之后它们不再"各出一页"，而是按两图一页排版，但兜底路径与标题不变。）
3. `HEADING2` / `DUALANTENNAALIGN` 不进图是**照原版照抄**的结果；哪天原版给它们加了图，
   这里要跟着改（证据表在 §12.3）。

## 13 PDF 版式对齐原版：信息页 + 两图一页（D6）

**问题**：`packages/app/src/pdf.ts` 原来**一份 CSV 一页**（`1 + N`）。原版
`00_来源/samples/graph/export/clean.pdf` 是 **8 页**，页脚 `1/8 … 8/8`；一比一对照时页码、
页内图数、分节位置全都对不上。

### 13.1 先量原版（`pdftotext -layout` + `pdftoppm`）

`pdfinfo`：`Pages: 8`、`Page size: 841.92 x 594.96 pts (A4)` 横向、`Creator: Chromium`、
`Producer: Skia/PDF m146`。逐页（`\f` 分页符）量到的分组：

| 页 | 分节标题（蓝色） | 页内图表（自上而下） | 图数 |
|---|---|---|---|
| 1 | — | 信息页：`Report Information` / `Project Information` / `Message Summary` | 0 |
| 2 | `Trajectory Plot` | Trajectory Plot（整幅地图卡） | **1** |
| 3 | `PVT` | Position Type / Position Status | 2 |
| 4 | — | Position SD / Solution Statistics | 2 |
| 5 | — | 2D Trajectory / Height | 2 |
| 6 | `Tracking & Measurements` | GNSS Signal Strength / Satellites and Signals | 2 |
| 7 | `Receiver Status`（**印在两张卡之间**） | Tracking Time / Receiver Status | 2 |
| 8 | — | CPU Usage / HW Monitor Status | 2 |

13 张图 = 1 + 2×6。所以原版**不是严格两图一页**：第 2 页只有一张，而且那张是 Overview 的
`Trajectory Plot`（Leaflet 地图，导出时瓦片没加载，印出来是一整块黑底 + 一个蓝色定位点 +
`Single Point` 图例）。第 7 页是"分节标题落在页中间"的实例：`Tracking Time` 属
`Tracking & Measurements`，`Receiver Status` 另起一节，标题紧贴在第二张卡上方。

页面几何：页眉 `Graph` 左、右侧项目/日期/GPS 区间；页脚左边 `source:`、右边 `N/8`；
每张图外面一个浅蓝灰边框的卡片，卡片内是标题 + 绘图区 + 图例（`All` 复选框 + 彩块 + 列名，
换行继续）。第 6–8 页的图例要换到第二行（`GNSS Signal Strength` 12 项、`HW Monitor Status`
10 项），卡片高度得固定留出两行图例的位置。

### 13.2 本重实现（`packages/app/src/pdf.ts`）

| 改动 | 落点 |
|---|---|
| 新增 `TRAJECTORY_PLOT`（`section`/`title` 都是 `Trajectory Plot`，`overview: true`），由 `2D Trajectory.csv` 现算，**独占第 2 页** | `TRAJECTORY_PLOT`、`chartsOf()`、`paginate()`、`PDF_CHARTS_PER_PAGE = 2` |
| 每页最多两张卡：高度 = `(556 − 44 − 分节标题 × 20 − 卡间距) / 卡数`，所以一张卡的页（第 2 页、`?file=` 单图）自动占满整页 | `sheetPage()` |
| 卡片：`strokeRect()` 边框 + 13 pt 标题 + 右上角行数/序列/最小最大均值 + 绘图区 + 图例（最多两行）+ 底部说明 | `card()`、`cardHeading()` |
| 分节标题全篇只印一次，且允许落在两张卡之间 | `sheetPage()` 的 `headings[]` + 传入传出的 `section` |
| 页脚 `source:` 列出该页全部 CSV（`a.csv + b.csv`） | `sheetPage()` |
| 封面的 `Chart Summary` 的 `Page` 列改成**图实际所在页**（不再是 `行号 + 1`），并加一行说明第 2 页是哪张 | `infoPage()` / `pageOf` |
| 封面的 `Message Summary`：读 `samples/graph/project/DataSummary.json`，按原版算法只列"图表真的用到"的报文，`Message Name / Message Count` 两列，顺序与原版一致 | `messageSummaryRows()`、`resolveMessageSummary()`、`infoPage()` |
| 第 2 页底图：Esri World Imagery 瓦片（JPEG `/DCTDecode` XObject，裁到绘图框内，画在轨迹之下），磁盘缓存 | `planBasemap()`、`basemapLayer()`、`fetchTile()`、`assemble()` |
| 瓦片拉不到 / `basemap: 'vector'`：回退经纬度矢量框，卡片底部写明原因 | `card()` 的 `notes`、`report.basemapNote` |
| 报告头 `pages = 1 + 1 + ceil(其余 / 2)`，`charts = 1 + N` | `graphPdfReport()` |

图表仍然**矢量绘制**（折线 / 色带 / 方块 / 区间条），没有一处截图；坐标轴、图例、点数预算
（`PDF_POINT_BUDGET`）、中文按需嵌入（`pdf-font.ts`）全部沿用。

`Trajectory Plot` 的取法：底下是**真瓦片**（不是截图）。按 `2D Trajectory.csv` 的 bbox 选 zoom
（干净样本 5 个点不动，窗口补到 0.0022°≈240 m），从
`server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
用 `curl` 同步取、按 `{z}/{x}/{y}.jpg` 缓存在 `<os temp>/nas-pdf-tiles`（`NAS_PDF_TILE_CACHE`
可改），以 JPEG `/DCTDecode` 嵌进 PDF；轨迹线与定位点画在瓦片之上，右下角印
`Imagery © Esri, Maxar, Earthstar Geographics`（`©` 走 WinAnsi 0xA9 的八进制 `\251`，
仍用 base-14，不会为这一个字拉进 CJK 字体）。任一瓦片失败 → 整层放弃、回退矢量框，
卡片底部写 `tile … failed (curl exit N)`（或 `basemap off - vector track only`），不贴假图。

### 13.3 实测

```
node --test --test-force-exit "packages/*/test/*.test.ts"   # 1216 / 1217；另一次全量 1215/1215
# 唯一红的是 packages/session 的 heartbeat 计时用例（并行负载下偶发），单跑 11/11 过，与 PDF 无关
```

固定时钟（`generatedAt: '2026/10/30 21:00:00'`）构建 clean：

| 项 | 结果 |
|---|---|
| `pdfinfo` | `Pages: 8`、842 × 595 pt、`Title: clean Report` |
| `pdftotext -layout` 逐页 | 与原版 13.1 表**逐页一致**：p2 `Trajectory Plot`；p3 `Position Type, Position Status`；p4 `Position SD, Solution Statistics`；p5 `2D Trajectory, Height`；p6 `GNSS Signal Strength, Satellites and Signals`；p7 `Tracking Time, Receiver Status`；p8 `CPU Usage, HW Monitor Status` |
| 分节标题 | p2 `Trajectory Plot`、p3 `PVT`、p6 `Tracking & Measurements`、p7 `Receiver Status`（在两张卡之间），其余页无 |
| 封面 `Message Summary` | `Message Name / Message Count`，四行 `BESTPOS 5 / RANGE 100 / HWMONITOR 1 / RXSTATUS 4` — 与原版逐行同序；`PORTSTATS`、`RAWEPHEM` 有计数但不进图，原版不印，这里也不印 |
| 第 2 页底图 | Esri World Imagery，**zoom 18，9 块 256×256 JPEG**，`pdfimages -list` 9 行 `jpeg rgb`，`x-ppi 47 / y-ppi 101`；右下角署名 `Imagery © Esri, Maxar, Earthstar Geographics`（`pdftotext -enc UTF-8` 原样取回） |
| 字节 | **269 575 B**（其中瓦片 ≈126 KB；矢量回退 137 375 B；原版 348 419 B）。**旧的纯 ASCII 字节变了，这是本次预期的改动** |
| b1（13 份 CSV） | `X-PDF-Pages: 9`、`X-PDF-Charts: 14`（1 信息 + 1 轨迹 + 7 页两图），5 299 367 B（含 SimHei 字体），第 2 页同样有 9 块 z18 瓦片 |

瓦片缓存：`%USERPROFILE%\AppData\Local\Temp\nas-pdf-tiles\{z}\{x}\{y}.jpg`；`NAS_PDF_TILE_CACHE`
改目录，`options.tileCacheDir` 优先。缓存命中时同一份输入两次构建字节相同（有测试钉住）。

测试（都在 `packages/app/test/`）：

- `graph-pdf.test.ts`（21 项，新增 6 项）：页数按 `1 + 1 + ceil(N/2)` 算并等于 8；用 13 pt
  粗体的内容流读出**每页图表标题序列**，逐页 `deepEqual` 原版分组；9 pt 粗体读出分节标题；
  封面 `Page` 列 = 真实页；封面 `Message Summary` 逐行同序且不含未进图报文；`dataSummary: null`
  时整表省略并写明原因；第 2 页有瓦片（`/DCTDecode` 数量 = 瓦片数、`/ImN Do` 逐个画、署名）
  或明确回退；`basemap: 'vector'` 不碰网络；真实失败路径（缓存目录指向一个文件 → `mkdir`
  失败）回退并把原因印在卡片上；缓存默认在 OS 临时目录、环境变量与 option 都可改。另外**真跑
  `pdftotext -layout`** 对照原版逐页标题顺序，`pdfinfo` 也是 8 页（没装 poppler 时 skip）。
- `pdf-unicode.test.ts`（7 项）：纯 ASCII 不嵌字体 + 8 页 / 13 图 / p2 是轨迹页 / p3 两张卡，
  封面 `Message Summary` 四行齐全，第 2 页有瓦片或有回退说明；中文嵌入、`pdftotext` 取回
  `野外台站` / `<盘>:\测试\项目`、降级路径照旧。
- `graph-projects.test.ts`：b1 的两行数字 13/14 → 14/9（**边界外的一处改动**，见 §13.6）。

截图（`%USERPROFILE%\AppData\Local\Temp\opencode\agent-pdfmap\`）：`clean-page-1.png`（封面，
含 Message Summary）、`clean-page-2.png`（z18 底图 + 轨迹点 + 署名）、`b1-ours.pdf`、
`clean-vector.pdf`（回退样本）。

### 13.4 与原版仍不一致（明说）

1. **底图是静态瓦片**：没有 Leaflet 的缩放控件、比例尺和 `Legend / Single Point` 面板；
   zoom 是按轨迹 bbox 算的（clean 与 b1 都是 z18），原版导出时瓦片根本没加载（印出来是
   一整块黑底 + 蓝点）。瓦片按 1:1 嵌入、绘图框裁剪，不重采样。
2. **卡片内装潢简化**：原版图例前有勾选框（`☑`）、页眉有 HEXAGON / NovAtel 商标、卡片是
   圆角 + 阴影；本文件只有直角边框、彩块图例、纯文字页眉。
3. **坐标轴范围不同**：原版 `2D Trajectory` 固定 40–180°E / 15–50°N，本实现按数据自适应
   （`114.3527…` 那一小段；轨迹不动时补到 ≈240 m），所以点/线的位置不可逐像素比。
4. **署名里的 `©` 是 WinAnsi 单字节**（`\251`），不走 CJK 嵌入字体：这份文档仍是
   `base-14 Helvetica, no embedded fonts`。三个版权方名字完整。
5. **`Message Summary` 放在封面右栏**（原版在 `Project Information` 下方）：本 writer 还多印
   一张原版没有的 `Chart Summary`，右栏让两张表都留在同一页。**字段（`Message Name` /
   `Message Count`）与行序（BESTPOS / RANGE / HWMONITOR / RXSTATUS）与原版一致。**
6. **页数跟着数据走**：原版 8 页是因为它只有 12 张 CSV 图 + 1 张轨迹；b1 有 13 张，于是 9 页。
   想永远 8 页只能丢图，不做。

### 13.5 `Message Summary` 的行是怎么选出来的

原版不是把 `DataSummary.json` 的 `Messages` 全表印上去，而是只印**图表真的用到**的报文。
`01_解包/Graph/out/renderer/assets/index-*.js` 里那段瓦片代码是：

```
plotLogs = getPlotUsedLogInstances(PlotSummary, Messages)
        = filterByPriority(PlotSummary, getUsedLogsForCharts(PlotSummary))
            .filter(log => Messages[log] !== undefined)
```

- `getUsedLogsForCharts` 只遍历 `GRAPH_GROUPS_TABS = [GOS, PVT, Heading_Attitude,
  Tracking_Measurements, Receiver_Status]`，按首次出现收集报文名（`Position View` 不在其中）；
- `filterByPriority` 再按“每个 section 里计数最小的那个报文优先”剔除被兄弟掩盖的条目；
- 最后只保留 `Messages` 里有计数的。

`clean` 的 `DataSummary.json` 里 `Messages` 有 6 条，但 `PORTSTATS`、`RAWEPHEM` 没进任何图，
所以原版只印 4 行。本实现逐函数移植（`usedLogsForCharts` / `topNames` /
`collectGnssLogs` / `collectRemainingLogs` / `filterByPriority` / `messageSummaryRows`），
用同一份 `DataSummary.json` 得到 **BESTPOS 5 / RANGE 100 / HWMONITOR 1 / RXSTATUS 4**，
行序也与原版一致（测试 `deepEqual` 钉住）。

数据从哪来：`options.dataSummary` → CSV 注释里的 `Project Directory` →
`export/<project>/DataSummary.json` → `samples/graph/project/DataSummary.json`
（仅当旁边有 `<project>.gpf`，`clean` 就是这种布局）。**找不到就不印表**：封面右栏写
`no DataSummary.json for this project - Message Summary omitted, no counts are shown`，
绝不从 CSV 里反推计数。b1 没有 `DataSummary.json`（只有 `export/b1/project.json`，
不在本任务的数据源里），所以 b1 的封面就是这条省略说明。

### 13.6 边界

只改了 `packages/app/src/pdf.ts`、`packages/app/test/graph-pdf.test.ts`、
`packages/app/test/pdf-unicode.test.ts` 与本文；`packages/graph/**`、`packages/protocol/**`、
`packages/view/**`、`packages/app/src/web/**`、`server.ts` 未动。

**一处越界**：`packages/app/test/graph-projects.test.ts` 里 b1 的
`X-PDF-Pages / X-PDF-Charts` 两行（14 → 9、13 → 14）。它断言的就是本任务的产物，不改必然红；
只动这两行数字，别的没碰。
