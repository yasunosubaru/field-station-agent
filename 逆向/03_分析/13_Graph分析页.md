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
- Export ▸ PDF 传工程 key（`/api/graph/pdf?project=b1`），服务端按该工程出 PDF（b1 是 14 页：
  1 页信息 + 13 页图）。

## 5 实测

- 落地页：**2 张卡**（`b1` 2026-10-31、`clean` 2026-10-30），状态行
  `2 个工程 · 当前 clean · 12 份 CSV · 逆向/00_来源/samples/graph/export/csv`。
- 点 `b1` 后 Overview：`工程 b1 · 数据 b1-20261101.sbf · GPS 2442,570227.100 – 2442,570255.151 ·
  时长 00:00:28 · 530 行 · 98 列`，图例 `GPS_L1_CA_15` 30 点（该卫星只在 530 行里的 30 行出现，
  其余是空单元格），时间轴右端 28.05 s。
- 点 `clean` 后 Overview：`工程 clean · 数据 clean.gps · GPS 2442,463097.350 – 2442,463102.300 ·
  时长 00:00:04 · 99 行 · 75 列`，时间轴右端 4.95 s。
- PVT：**7 块图块**（图表目录的 7 张全在，含 `Velocity`）。`clean` 每图 5 行、`b1` 每图 51 行
  （`Height(m)` 曲线 64.82 → 64.76 m）；`b1` 的 `Velocity(m/s)` 25 行 5 条曲线，`clean` 的那块写
  `-- 导出目录里没有 Velocity.csv`，页脚点名 `Velocity.csv`（不拿别的列顶替）。
- `b1` 的 Tracking & Measurements / Receiver Status 页也能打开，控制台 0 error / 0 pageerror。
- 截图（`C:\Users\SunCh\AppData\Local\Temp\opencode\agent-projects\`）：
  `b10-01-recent-projects.png`、`b10-02-b1-overview.png`、`b10-03-b1-pvt.png`、
  `b10-04-clean-overview.png`、`b10-05-clean-pvt.png`；接口原文 `projects.json`。

## 6 没做到的 / 边界

1. **13 份 CSV，不是 16 份。** 图表目录（`06_Graph应用-附录/C_图表目录.json`）有 16 张图，
   导出层实现 13 张（缺 Heading & Attitude 的 `Azimuth` / `Roll and Pitch` / `SPAN Filter Updates`，
   那要 INS 报文做对照）；`clean` 的 golden 只有 12 份（没有 `BESTVEL`，所以没有 `Velocity.csv`）。
   所以"同一套 16 份"这一条仍无法满足——剩下的 3 张需要原版导出结果做逐字节对照，本轮没有。
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

用 `packages/graph/tools/export-sbf-project.ts --capture …/broad-clean.gps --name broad` 导出到临时目录，
逐行比对（`META-ONLY` = 数据行逐字节相同，只是 5 行项目信息不同）：

| 结果 | 文件 |
|---|---|
| **`META-ONLY`（数据行逐字节相同）9 份** | `2D Trajectory`、`CPU Usage`、`Position SD`、`Position Status`、`Position Type`、`Satellites and Signals`、`Solution Statistics`、`Tracking Time`、**`Velocity`** |
| `DATA-DIFF`（本轮之外就有的差异）4 份 | `GNSS Signal Strength`（表头尾部 3 个 `_Mean` 列顺序不同 → 1199 行全差，见 `13_Graph列序分析.md`）、`HW Monitor Status`（我方 65 行 vs 原版 59 行，行也错位）、`Height`（尾零：golden `65.931110`，我方 `65.93111`，60 行里 12 行）、`Receiver Status`（span 的 `end` 只等于 `start`，7 行里 5 行） |

- 这 4 份的差异**不是本轮引入的**：改动前的同一份代码（`CSV_CHARTS` 还没有 `Velocity`）对同样的
  oracle 就是这些差异；`clean` 的 golden 逐字节过（见 `06_Graph应用.md`），而 `broad` 的这 4 张本来就是
  已知未完成项。本轮只保证 12 份的字节不变，实际一份都没变。
- `Velocity` 是 `META-ONLY`：表头 + 60 行数据全部逐字节相同。
- 那 5 行项目信息为什么必然不同（我方没有 `.gpf`）：`#Project Directory:`（输出目录）、
  `#Data File Name:`（`broad-clean.gps` vs 原版的 `broad.gps`）、
  `#Start Time` / `#End Time` / `#Duration`（原版 `2442,467940.000 – 2442,468009.000 / 00:01:09`；
  我方按"实际画图的报文"取窗，得到 `2442,467949.100 – 2442,468009.001 / 00:00:59`）。
  `#Project Name:` 两边一致（都是 `broad`）。原版的 467940.000 来自 `.gpf` 里的会话起点，
  抓包第一帧是 `RANGE@467920.650`，从数据推不出这个数，所以不编。
- **`b1` 其实有 BESTVEL**（25 条，`2442 570231–570255`，全在时间窗内），所以任务书里
  "b1 没有 BESTVEL" 那条前提不成立：b1 重导后是 13 份，多出来的 `Velocity.csv` 是 25 行的真曲线，
  不是空文件。样本已按工具重铺（只新增 `Velocity.csv` + `project.json` 的两行数组）。

### 8.3 前端

- `graph.js#CHART_GROUPS` 的 `pvt.charts` 加 `{ id:'velocity', title:'Velocity', file:'Velocity.csv',
  kind:'line', units:'(m/s)' }`，于是 PVT **永远 7 块图块**（目录 7 张全有页签）；
- 工程没导出 `Velocity.csv` 时图块写 `-- 导出目录里没有 Velocity.csv`，`paintFoot()` 把
  "目录里没有页签的图"和"有页签但没 CSV 的图"分开说（以前只按"有没有页签"判断，会误称"都有 CSV"）；
- HTML / PDF 按 CSV 标题遍历，不用改调用方；`html.ts` 的段落表把 `Velocity` 归到 **PVT**（原来是
  落到无名 `Charts` 段）。

### 8.4 截图

`C:\Users\SunCh\AppData\Local\Temp\opencode\agent-velocity\`：
`pvt-seven-tiles.png`（b1 的 PVT 七块，含 `Velocity(m/s)` 五条曲线）、`velocity-tile.png`（该图块）、
`pvt-clean-velocity-empty.png`（clean 的 PVT：7 块，Velocity 留空并说明原因）、`pvt-full.png`
（整页）。控制台 **0 error / 0 pageerror**，1 条 warning 来自 Luciad/WebGPU 纹理（原有）。
