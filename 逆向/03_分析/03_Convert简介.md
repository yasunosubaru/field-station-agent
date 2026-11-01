
## Summary 计数规则（2026-11-01 实测）

`Summary_<name>.txt` 的表格**跟着输出走，不跟输入走**。三条规则都是从套件自己的 Summary 反推出来的，
并用 b1/b2/b3 三份 golden 各验一遍：

1. **文本记录也计入表格**。b1 的 99 条文本记录让表格多出 `+39 BESTPOS`、`+26 RANGE`、
   `+24 SATVIS2`、`+6 RXSTATUS`、`+2 TIMESYNC`、`+2 HWMONITOR`。
2. **打不出行来的记录算输入、不算输出**：b1 的 `RXCONFIG 278 → 256`（那 22 条的内嵌报文不在字典里）；
   b2 的 `RANGECMP2 31 → 0`、`RANGECMP4 30 → 0`，而 `RANGE 638 → 699`（一条压缩记录展开成一条
   RANGE 记录，观测在它的数组里）。
3. **时间范围跳过参考历元**：`SATTIME`(200) 的记录带的是星历/历书的参考时刻。b2 的第一条是
   `ALMANAC 577140.000`，而套件的 Summary 从 `577758.950` 起算。时长是
   `floor(finish) - floor(start)`——b1 28 s、b2 34 s、b3 45 s（四舍五入会分别给 28/33/46）。

实现：`summary.ts` 跳过 `timeStatus === 200` 取首末；`convert-pipeline.ts#textLinesFor` 顺便记录
"每个 log id 出了几行"，`countLogs` 用它当 Output 列；文本记录由 `countTextRecords` 补进表格
（能渲染的算 1 进 1 出，只认名字渲染不出的算 1 进 0 出）。

复验（`--to ABBREV_ASCII` 后与 `golden-b{1,2,3,5}-20261101.ABBREV_Summary.txt` 逐行比）：

```
除下面两类，整份 Summary 逐行相同
  · 第 2/5/8 行：完成时刻、输入名与路径、输出路径（天然不同）
  · UNKNOWN 行：现在也打，数值与套件逐字节相同（见下）
```

### UNKNOWN 行（2026-11-01 反推完成）

套件打 `0 | UNKNOWN | <字节数> | 0`。这个数**不是** `.UNKNOWN` 文件的长度，两者来自**两遍不同的解析**：

| 输入 | `.UNKNOWN` 文件（`--unknown-bytes=file`） | Summary 的 UNKNOWN 行 |
|---|---:|---:|
| `b1-20261101.sbf` | 5386 B | 3695 |
| `b2-20261101.sbf` | 7056 B | 6875 |
| `b3-20261101.sbf` | 364 B | 224 |
| `b5-20261101.sbf` | 565 B | 350 |

**文件口径**（转换那一遍）：`= 捕获字节 − 能渲染出文本的记录 − 解析器认得的文本记录`。我们打出来的
`.UNKNOWN` 与套件的**逐字节相同**（四份 golden 都在 `00_来源/samples/live-20261031/golden-b*.UNKNOWN`）。
两条细节：

- 文本记录「认得」= `<NAME …` 头行**加它后面的续行**（`<     10 `、`<    `），不是只算头行；
- 「能渲染」是指这条记录能打出一行 ASCII。b1 有 22 条 `RXCONFIG`(128) 内嵌报文不在字典里、打不出行，
  它们的 **1616 B 仍然写进 `.UNKNOWN`**——对写出程序来说这些字节没被转换。所以 `.UNKNOWN` 与格式无关：
  `-a`、`--abbrev`、`-b` 三档在 b1 上都是 5386 B（实测）。

**Summary 口径**（预扫描 `readmessage` 那一遍）：预扫描**认得出**那 22 条 `RXCONFIG`（表格里的 `278`），
所以它们不算未知。剩下的字节按三条规则累加：

1. 一段无法归属的连续字节按**长度**计；
2. 但 `<OK…\r\n` / `<ERROR…\r\n` 是命令应答：一段里**只有应答**时按**每条 1 字节**计
   （`<OK\r\n` 单独 → 1），一段里**还有别的字节**时应答按 0 计、只数别的字节（`<OK\r\n[USB2]` → 8）。
   `<IGNORED\r\n`、`<OK\n`（只有 LF）、纯 ASCII 的 `<OK`（后面直接跟二进制）都不是应答，按字节计；
3. **文件开头**那一段（offset 0 起）整段按长度计：解析器还没同步到任何记录，开头的文本全算垃圾
   （`\r\n<OK\r\n[USB2]` 在文件开头 → 13，而不是 8）。这一条正是 b1/b2 各差的那 5 字节。

四条实测数字与 golden 逐位相同：b1 3695 / b2 6875 / b3 224 / b5 350。实现见
`convert-pipeline.ts#unknownSpans` / `countUnknown`，测试 `unknown-bytes.test.ts` 同时钉住两个口径。
`clean-9600.gps` 一个未知字节都没有，所以它的 Summary**没有** UNKNOWN 行（套件也没有）。

### `--unknown-bytes=[file|interleave|ignore]`（CLI 第 4.5.5 节）

套件的映射是 `interleave`→`INTERLEAVE`、`file`→`SEPARATEFILE`、其它（含缺省）→`SKIP`
（`01_解包/app/view/convert/cli.js:161-164`），三档实测：

| 档位 | 产物 | 计数 |
|---|---|---|
| 缺省 / `ignore` | 不落盘，转换文件不变 | UNKNOWN 行照旧 |
| `file` | 格式目录下多一个 `<base>.UNKNOWN`，内容同套件逐字节 | 照旧 |
| `interleave` | 未知字节**原样插回**转换文件的对应位置（按捕获偏移排序），文件不再按行组织 | 照旧 |

`interleave` 的插入位置用三帧合成捕获实测过：`#BESTPOSA…\r\n` + `\r\n[USB2]\r\n<OK\r\n` +
下一条 `#BESTPOSA…`。我们与套件在 BINARY 上逐字节相同；ASCII/ABBREV 的记录行本身对这条**零填充短
payload** 的合成记录还有已知差异（`ascii-log.ts` 对截断 payload 的默认值，真实捕获 14 份 golden 全同），
拼接逻辑一致。

---

## 分片、抽稀与压缩记录展开（2026-11-01 实测，手册 4.5.3–4.5.6）

五个选项全部与本机套件 2.11.0 同参数跑同一抓包比对：**文件名集合、每片字节数、合计**三样对齐，
下面标「逐字节相同」的是连内容也比过（sha256 / `Buffer.compare`）。比对方式：套件自己跑一遍留下产物，
我们的 CLI 同参数再跑一遍，逐文件比 sha。

### 选哪个分片模式

`cli.js:182-183` 只认一个模式，优先级固定：

```
--limit-output-size > --limit-output-duration > --split > --daily-utc > 不分片
```

实测两份组合：b2 `-a --split --limit-output-size=1` 出来的是 5 个 `_PartN`（不是 20 个按日志文件），
`-a --split --daily-utc` 出来的是 20 个按日志文件（不是 `_Part0`）。

`--split` 走「每条日志一个文件」（`<base>_<LOGNAME>.<ext>`，已实现）；其余三种走
`<base>_Part<N>.<ext>`，**N 从 0**，按记录顺序编号。RINEX 与 KML 不分片——实测
`-r3.04 --limit-output-size=0.1` 仍然只写一个 5.8 MB 的 `.26O`，KML 的四个
`<base>_<LOGNAME>.KML` 与开关无关（那是 KML 自己的按位置日志分文件）。

### `--limit-output-size=<MB>`（4.5.3）

**「MB」是 Mebibyte：1 048 576 B。** 累加是**逐条记录**做，而且**写完这条再看**是否已到上限——
到就收片，所以每片都略微超过 1 MiB（超出的正好是最后一条记录）：

| 输入 / 格式 | 各片字节 |
|---|---|
| b2 `-a --limit-output-size=1` | 1 051 261 / 1 055 491 / 1 051 236 / 1 054 714 / 719 271（合计 4 931 973） |
| b2 `--abbrev --limit-output-size=1` | 1 050 148 / 1 053 039 / 1 054 247 / 1 054 335 / 1 052 900 / 459 144（合计 5 723 813） |
| b2 `-b --limit-output-size=1` | 1 051 424 / 1 049 358 / 632 556（合计 2 733 338） |
| b1 `-a --limit-output-size=1` | 1 052 486 / 1 050 024 / 1 053 879 / 1 053 933 / 878 560（合计 5 088 882） |

三条反证把「1 MiB」和「写完再看」都钉住：

- 阈值换成 1 000 000 B，b2 会切成另外五片（1 002 402 / 1 006 602 / 1 006 857 / 1 000 446 / 915 666）；
- 若改成「写之前看」，b2 只剩四片（每片都 ≲1 MiB）；
- 切点落在记录边界上：ASCII 是整行、ABBREV 是整条记录块（多行的 `<RANGE …` 块从不被切成两半，
  每片第一行都是 `<NAME …`）、BINARY 是整帧。

四份产物与套件**逐字节相同**；每片都是不分片输出的连续前缀，合起来正好是全量。

### `--limit-output-duration=<秒>`（4.5.5）

规则（合成捕获 + 真实抓包一起钉出来的）：

1. 每片的窗口从**这一片自己第一条记录**的时间起算，长度 = 间隔；
2. **两端闭区间**：恰好落在 `start + 间隔` 的那条记录仍写进本片——它是把本片标满的那条；
3. 下一条**超过**窗口的记录开新片，窗口起点重置为它的时间；
4. 在这两者之间到达的**迟到记录**（时间早于窗口起点，或已满片但没超过窗口）仍然写进本片。

实测（b2 `--limit-output-duration=5`，8 片，合计 4 931 973 B）：

| 片 | 行数 | 时间戳范围 |
|---|---:|---|
| Part0 | 2 | `577140.000`（`ALMANAC`，文件第一条）→ `577758.950` |
| Part1 | 109 | `577759.000` → `577764.000` |
| Part2 | 139 | `577764.050` → `577769.050` |
| Part3 | 142 | `577769.100` → `577774.100` |
| Part4 | 147 | `577774.150` → `577779.150` |
| Part5 | 143 | `577779.200` → `577784.200` |
| Part6 | 141 | `577784.250` → `577789.250`，末尾两条迟到的 `RAWEPHEM 577770` |
| Part7 | 82 | `577789.300` → `577792.050` |

- **Part0 只有 2 条却跨 618 s**：第一条记录（`ALMANAC 577140`）把窗口锚在 577140，第二条
  `577758.95` 早已超出窗口，但它还没「超过下一条要比较的界」——按第 3、4 条它归本片，
  接着 `577759.000` 才开 Part1。这和「按记录自身时间相对本片首条记录」的直觉完全一致，
  只是首条记录的窗口极小而已。
- **Part6 末尾的 `577770`**：那是两条迟到的 `RAWEPHEM`（日志在文件末才补发）。本片起点
  `577784.25`，窗口到 `577789.25`；`577770` 早于起点，不是「超过窗口」，所以留在本片，
  真正开 Part7 的是 `577789.300`。
- 其它间隔同样逐字节相同：`=2` 17 片、`=20` 3 片（12 758 / 2 898 358 / 2 020 857）、
  `=60` 2 片（12 758 / 4 919 215）；b1 `=5` 6 片（707 675 / 951 904 / 964 407 / 952 013 /
  970 615 / 542 268，99 条文本记录都在正确的位置）、b2 `--abbrev --limit-output-duration=5`
  8 片也逐字节相同。
- 这个模式**不跳过 `SATTIME`**：Part0 的锚点就是那条 `ALMANAC`。合成捕获验证过：只有
  `577760.00` 与 `577765.00` 两条记录时，`577765`（= start+5）留在 Part0。

### `--daily-utc`（4.5.4）

日界是**秒周 ≡ 0（mod 86400）**，**不减闰秒**：合成捕获在 518400 与 604800 两侧各放一条记录，
换片都发生在 `…400` 这一秒（若按 GPS−UTC=18 s 修正，界该在 `…418`）。

换片条件是「当前记录的 GPS 日 **大于** 上一条记录的日」，**不是**「大于本片起点的日」：

- 迟到记录（日更早）不换片，也不把日钟往回拨；
- 之后再来一条「日更大」的记录才换片——合成捕获
  `[604790, 604800, 604790.05, 604810, 604790.1, 604820]` 实测切成
  `{604790} / {604800, 604790.05} / {604810, 604790.1} / {604820}` 四片，正是这个规则。

**日钟只被「观测时间」状态的记录推动**——`FINE`(80)、`FINEADJUSTING`(100)、`DEGRADED`(120)、
`ALIGNING`(160)、`FINESTEERING`(180) 这五个；`COARSESTEERING`(60)、`APPROXIMATE`(20)、
`UNKNOWN`(0)、`SATTIME`(200) 都不算。一个状态一条合成记录实测
（`[2442:577759:180, 0:2.176:<status>, 2442:577760:180]`）：0/20/60/200 给 1 片，
80/100/120/160/180 给 2 片。日钟的**起点**取文件里第一条带时间戳的记录（不论状态），
所以 b1 开头那条 `status 20 / week 0` 的 `id 1246` 帧不会把它按到 0 日：

- b2 中间有一条 `GLORAWALM`（`week 2402, 93768.000`，2026-11 的捕获里混着 40 周前的老数据，
  `SATTIME`）——它既不推钟也不改钟，b2 仍是一片；合成捕获 `[577759:180, 2402:93768:200, 577760:180]`
  实测 **1 片**，把那条状态改成 180 就变成 **2 片**。
- 文本记录按它表头里的状态名折算成同一个码（`COARSESTEERING`→60 等），再套上面那张表。

实测（都**逐字节相同**）：b2 一片 `b2-20261101_Part0.ASCII`，905 行 / 4 931 973 B；
b1 一片 5 088 882 B；b3/b4/b6 各一片；b5 两片；live-nav 两片 5 139 + 2 793 168 B。

**未复刻：b7**（`--daily-utc`）。b7 是把三段不同 GPS 周的日志拼在一起的样本（文本记录里有
`week 0`（210 条）、`17100`、`17101` 三种日，状态 `UNKNOWN`/`COARSESTEERING`/`SATTIME` 混杂），
套件切成 3 片（233 / 24 / 352 行），我们只给 1 片（609 行）。试过的几种模型（全部记录推钟、
除 `SATTIME` 外全推、文本记录一律推钟）都给不出那三片，说明它还有我们没测到的一条规则；
这一份如实记为未实现，其余 7 份抓包都对上，合成捕获的逐条结论在
`protocol/test/convert-cli-options.test.ts` 里。

### `--decimate=<秒>`（4.5.6）

**保留「记录自身时间对齐到间隔」的记录，不是每 N 条取一条。** 判据是

```
header.milliseconds（周内毫秒） % (间隔 × 1000) == 0
```

对齐基准是**周内秒**，不是绝对 GPS 秒、也不是文件起点：

- 间隔 13 s（13 不整除 604 800，能区分两种口径）：b2 保留 `577759 / 577772 / 577785` 这些
  **周内秒**为 13 倍数的记录；若按绝对 GPS 秒算，week 2442 的绝对秒 ≡ 2 (mod 13)，保留的会是
  `577761 / 577774 / …`。实测是前者。
- 小数秒一律丢：`577760.000` 留、`577760.050` 丢、`577765.001` 丢。
- 文本记录用**自己表头**的时间：b1 的 99 条文本记录里恰好 46 条留下，留下的都在
  `570230 / 570235 / …`，丢掉的都在 `570231 / 570232 / …`——即使它前一条 SBF 记录是 `570229.85`。

实测（`-a`）：

| 输入 | 间隔 | 字节 | 行数 | 说明 |
|---|---:|---:|---:|---|
| b2 | 5 | 157 396 | 87 | BESTPOS 32→7、BESTGNSSVEL 30→6、MARKPOS 30→6、PSRPOS 30→6、PPPDOP 30→3、RANGE 638→7（+12 条压缩块正好落在对齐历元 → 输出 19） |
| b2 | 7 | 96 315 | 39 | |
| b2 | 13 | 51 232 | 20 | |
| b1 | 5 | 185 901 | 228 | 99 条文本记录留 46 条 |

b2/b1/live-nav 的 `-a --decimate=5`、b2 `--abbrev --decimate=5`、b2 `-b --decimate=5` 都**逐字节相同**。
Summary 的 Source 列跟着抽稀后的记录走（b1 `BESTPOS 17 → 17`，全量是 32），Output 列照旧跟着输出走。

未复刻的组合：`--decimate` + `--unknown-bytes=file`。b1 上套件写 4014 B 的 `.UNKNOWN`，我们写
5386 B（= 全量口径，逐字节等于 golden 那份）。套件那份从第 3612 字节起就不同：抽稀后凡是**打不出行**
的记录，其字节不再进 `.UNKNOWN`（那一段只剩 `[USB2]` 横幅与 `<OK` 应答），这一遍我们没有重现。
Summary 的 UNKNOWN 行不受影响（两边都是 3695）。

### `--expand-cmp` / `--no-expand-cmp`（4.5.3：压缩记录是否展开成 RANGE）

套件缺省就展开（`deCompressionType: options.expandCmp ?? true`，`cli.js:253`）。b2 三种跑法：

| 命令 | 字节 | 帧 |
|---|---:|---|
| `-b`（= `-b --expand-cmp`，两者**字节相同**） | 2 733 338 | 638 RANGE + 31+30 条压缩记录展开成 RANGE → **699 RANGE** |
| `-b --no-expand-cmp` | 2 574 334 | 638 RANGE + 31 `RANGECMP2` + 30 `RANGECMP4`（压缩记录原样） |
| `-a --no-expand-cmp` | 4 667 920 | 905 行，压缩记录按自己的字典布局各打一行 |

所以 BINARY 的规则是：**展开时一条压缩记录变成一条 RANGE 帧**——头沿用原记录（端口、序号、空闲、
时间状态、周、毫秒、接收机状态、软件版本），只改 message id 43 与 payload 长度，再重算 CRC；
`--no-expand-cmp` 才是逐字节复制。

展开出来的 payload 里，有四个字段**不是** `Math.fround(解码值)`（用套件自己的 `-b` 产物逐字段比出来的，
覆盖 b2 的 2 697 CMP2 + 2 610 CMP4 与 b5 的 897 CMP1 + 897 CMP2 + 828 CMP3 + 828 CMP4 + 828 CMP5）：

| 字段 | 版本 | 套件存的值 |
|---|---|---|
| `sd_psr` | CMP5 | 3 位小数的表值（`0.09906… → 0.099`） |
| `sd_adr` | CMP3/CMP4 | 3 位小数的表值（`0.02208… → 0.022`） |
| `sd_adr` | CMP5 | 原生自己的表，与我们按手册公式算的值在第 5 位就不同（`0.00390625` vs `0.00391`）。32 个索引全部实测出来写进实现（30/31 饱和在手册标注的「> 0.44940」） |
| `C_No` | CMP3/CMP4/CMP5 | `raw × 0.05f`（乘 float32 的 0.05），会让 2 610 条里的 553 条比 `fround(raw/20)` 高一档（`46.1 → 46.100002…`） |

`dop`、`lock_time`、`sd_psr`(CMP1–4)、`C_No`(CMP1/2) 就是普通 `Math.fround`。加上这些规则后，
b2/b3/b5 的 `-b` 产物与套件**逐字节相同**（b5 的 3 478 252 B 里连 CMP5 的 828 条 `sd_adr` 都对上）。

顺带纠正一条旧口径：**BINARY 不写打不出行来的记录**。套件 b1 的 `-b` 只有 256 条 `RXCONFIG`
（输入 278，22 条内嵌报文不在字典里），b4 的 `RXCONFIGUSER` 只有 225 条（输入 244）——BINARY 与
ASCII 一样，按「能否渲染」决定写不写。这条已实现，b4 的 `-b`（4 138 280 B）因此**逐字节相同**。

未复刻：**文本记录进 BINARY**。套件把文件里的 ASCII 日志重新编码成二进制帧再写：b1 的 `-b` 比它的
SBF 记录多出 39 条 `BESTPOS`、26 条 `RANGE`、24 条 `SATVIS2`……正好是那 99 条文本记录按名字的分布。
这需要一整套「字段 → 字节」的编码器（本项目只有解码方向），没有做：

| 输入 | 套件 | 我们 |
|---|---:|---:|
| b1 `-b` | 2 623 374 B | 2 498 494 B |
| b7 `-b` | 473 262 B | 227 860 B |
| b2/b3/b4/b5 `-b` | — | 逐字节相同（这几份没有可渲染的文本记录） |

### 实现与测试

| 位置 | 内容 |
|---|---|
| `cli/src/convert.ts` | 五个开关的解析 + 分片模式优先级（`splitMode`） |
| `convert-pipeline.ts#partitionBlocks` | `size` / `time` / `daily` 三种切法（按输出块切，块 = 一行 / 一个多行记录块 / 一帧） |
| `convert-pipeline.ts#decimateFrames` | 抽稀（记录 + 文本记录各自的时间） |
| `convert-pipeline.ts#buildRangeBinaryPayload` | BINARY 展开时的 float32 存储规则与 CMP5 `sd_adr` 表 |
| `convert-pipeline.ts#binaryBlocks` | BINARY 的块序列（展开、跳过打不出行的记录） |
| `protocol/test/convert-cli-options.test.ts` | 12 条新用例：四种 `--limit-output-size` 产物、五种 `--limit-output-duration` 边界（含合成捕获）、两种 `--daily-utc` 规则（含 `SATTIME`）、三种 `--decimate`（含对齐基准与文本记录）、`--expand-cmp` 两档 |

复验命令：

```powershell
cd 逆向\04_重实现
node --test --test-force-exit "packages/*/test/*.test.ts"   # protocol 310 全绿
node 逆向\tools\golden-check.ts                            # 14 份 golden 全字节相同
```

（另：`packages/app` 与 `packages/view` 里有 4 项配置页用例正被另一条并行任务改动而失败，
与 Convert 无关。）

---

## Output Settings 接线（2026-11-01，1:1 对标 B 类第 2 项）

界面第二步那 5 组控件原先全是 `disabled`，点 Convert 只发 `{capture, format, at}`。现在它们
按原版语义接线：页面的 Wire 字段 → `convertFrames` 的 `ConvertOptions`，Destination 由服务端
真的落盘。**所有数字都是套件 2.11.0 同参数跑同一份 b2 得到的**。

### 1. 五组控件各自的原版语义

| 控件 | 原版字段（`01_解包/app/view/convert/`） | 行号 | 语义 |
|---|---|---|---|
| **Sample Rate (Hz)** | `decimationFilter = 1 / sampleRate` | `convert.js:1922` | 单位是**秒**的抽稀周期。`100` Hz → `0.01`；`0.5` Hz → `2` 秒（小数不截断）。`""` 或字面 `0` → 不抽稀。校验在 `:1852-1859`：`parseInt` 后必须 0..999.99——**它先把 `0.5` 截成 `0` 再放行**，所以原版对小数是宽松的（我们按同一区间判，但不截断）。CLI 的 `--decimate` 就是这同一个字段（`cli.js:220`，注释写着 "sample rate in UI"），所以 `--decimate=0.5` ≡ Sample Rate 2 Hz。 |
| **Unknown Data** | `unconvertedBytes` | `convert.html:340-341`（`type="SEPARATEFILE"` / `"INTERLEAVE"`）、`convert.js:1547`、`:1923` | `SEPARATE` → `--unknown-bytes=file`，`INTERLEAVE` → `--unknown-bytes=interleave`（`cli.js:161-164` 的映射，`SEPARATEFILE`/`INTERLEAVE` 是原生自己的名字）。 |
| **Destination** | `outputPath`，以及 `destinationType` | `:1924-1934`、`:166`、`:1580-1599` | 「Source file folder」= `path.dirname(输入文件)`；「Select folder」= `selectedDestinationPath`（Electron 的 `remote.dialog.showOpenDialog`）。**目录不存在就 `mkdirp`**（`:1929-1933`）。落盘结构见手册 4.3.2.5：`<目标>/<源文件名>/<时间戳>/<格式>/<文件名>`。 |
| **Prefix/Suffix** | `outputFileName = {valid, name, type}` | `:1937-1941`、`:1862-1873` | `valid = (name != "")`；`type` 是 `PREFIX`/`SUFFIX`；最多 **18** 字符（`convert.html` 的 `maxlength="18"`），禁 `/ : * ? " < > \| \`。 |
| **Time Interval** | `timeInterval = {startTime, endTime}`，每项 `{week, msec}` | `:1889-1893`、`:1094-1112`、`:1250`/`:1261` | 两端都进；`msec` **不是毫秒，是周内秒**（`getGPSTimeFromUTC` 里 `parseInt((time%一周)/1000)`）。只有用户编辑过才发（`isTimeIntervalEdited`），Reset 撤回——否则会把整段 span 当成一次显式裁剪。 |

Prefix/Suffix 的**落点**没有 CLI 开关可测（`cli.js:228-232` 恒发 `{valid:true, name:""}`），改用原生
`Edie/edie-node-wrappers.node` 的 `Convert` 直接量（用套件自带的 `node.exe` v10.19.0，GUI 的
`fileList_obj` 原样构造）：

| `outputFileName` | 产物 |
|---|---|
| `{valid:true, name:"abc", type:"PREFIX"}` | `abcclean-9600.ASCII`（附在**去扩展名的基名**前） |
| `{valid:true, name:"abc", type:"SUFFIX"}` | `clean-9600abc.ASCII`（在扩展名**前**，不是文件尾） |
| `{valid:false, name:"abc", type:"PREFIX"}` | `clean-9600.ASCII`（忽略） |
| PREFIX + `splitBy:"LOGS"`（b2） | `abcb2-20261101_RANGE.ASCII`、…、`abcb2-20261101_UNKNOWN.ASCII`——切分名、`.UNKNOWN` 都带前缀 |

### 2. 与套件同参数实测（b2-20261101.sbf，`-a`）

| 参数 | 套件产物 | 我们 | 结论 |
|---|---|---|---|
| `--decimate=0.5`（Sample Rate 2 Hz） | 916 189 B / 327 行 | 916 189 B / 327 行 | 相同 |
| `--decimate=2.5` | 199 291 B | 199 291 B | 相同 |
| `decimationFilter=2`（Sample Rate **0.5** Hz，原生直调） | 364 859 B / 171 行 | 364 859 B / 171 行 | 相同 |
| `--unknown-bytes=file` | 4 931 973 B + `b2-20261101.UNKNOWN` 7 056 B | 同 | `.UNKNOWN` 逐字节相同（既有 golden） |
| `--start-time=2442,577760 --finish-time=2442,577770` | 1 362 914 B / 262 行 | 1 362 914 B / 262 行 | 相同 |
| **四项叠加**：`--decimate=2 --unknown-bytes=file --start-time=2442,577760 --finish-time=2442,577770` | 109 239 B（61 行）+ `.UNKNOWN` 7 056 B | GUI 落盘的 `abcb2-20261101.ASCII` 109 239 B、`abcb2-20261101.UNKNOWN` 7 056 B | **两个文件 sha256 都相同**（`8966726D…` / `6765898E…`） |

顺带纠正一条旧口径：**时间窗不缩小未知字节的账**。套件带 `--start-time/--finish-time` 跑
`--unknown-bytes=file` 时照样写完整的 7 056 B `.UNKNOWN`，Summary 的 UNKNOWN 行照样 6 875；
以前实现里「窗口一开就不报未知字节」是把未测的组合按保守值处理，现在按实测改成整份捕获口径
（`unknownSpans` 走**未裁剪**的帧表）。`interleave` + 窗口仍未测，所以这条组合保持关闭。

### 3. GUI 里**没有**的东西（没有加控件）

- **split / limit-output-size / limit-output-duration / daily-utc**：`convert.html` 的第二步页面
  上确实没有；它们藏在**每个格式右侧齿轮弹出的设置窗**里，那个窗的 DOM 是 `convert.js:400-510`
  拼出来的模板串，默认值 `ASCII: {fileSplitting:true, splitBy:"LOGS"}`、`ABBREV_ASCII` 同
  （`:62-79`，`:985` 的 `$.extend(true,{},formatDefaultSettings)`）。本仓库的 Web 版把这个齿轮
  继续保持装饰（HTTP 层也还没有这些字段），所以 **GUI 不切分、CLI 有 9 个开关**，这次没有加控件。
- **"Open output folder"**：原版是 Electron 的 `shell.openPath`；网页没有文件管理器，我们的
  summary 里给出**真实落盘路径**，并明写「Source file folder 时只在内存里，选 Select folder 才写盘」。

### 4. 实现位置

| 位置 | 内容 |
|---|---|
| `protocol/src/convert-pipeline.ts` | `ConvertOptions.startTime/finishTime/limitDuration/affix`；`applyTimeWindow` 从 CLI 搬进来（GUI 与 CLI 共用一条规则）；`affixedBase` 把 Prefix/Suffix 套到**输出基名**上，切分名/`.UNKNOWN`/RINEX/KML 自然跟着 |
| `cli/src/convert.ts` | 只负责解析参数，时间窗交给 pipeline（行为不变，四条既有测试仍逐字节过） |
| `app/src/convert.ts` | `ConvertSettings`（decimate / unknownBytes / startTime / finishTime / affix / source）；`ConvertArtifact` 加 `files[]`（含每份字节）、`base`、`unknownBytes`、`unknownFileName`、`unConvertedBytes`、`directory`、`path` |
| `app/src/server.ts` | `/api/convert` 解析 5 组参数并校验（decimate>0、未知字节枚举、affix 18 字符 + 禁用字符、绝对路径 + 拒绝 `..` + 自动创建）；Destination 有值时按手册 4.3.2.5 布局落盘并回报 `directory`/`path`；`/api/captures` 多给 `samplesAbsolute`，供 Destination 文本框预填 |
| `app/src/web/panels/convert.js` | 解除 disabled；`outputSettings()`（纯函数）做 5 组映射与可读报错；Unknown 两个说明文案随选择切换；Prefix 为空时那一对 radio 才灰；结果区显示**每份文件名/字节**、落盘目录、未知字节数 |

### 5. 测试与端到端

- `packages/app/test/convert-gui.test.ts`（13 条）：`outputSettings()` 的 5 组映射与非法值（空/0/`abc`/负/
  >999.99/19 字符/路径字符/倒置窗口），以及 `/api/convert` 的实测字节、`.UNKNOWN`、Destination
  落盘（文件真的在盘上、`directory`/`path` 对得上）、12 类非法字段的 400 文案。
- `packages/protocol/test/convert-gui-options.test.ts`（9 条）：affix 在 ASCII/BINARY/KML/RINEX/切分/`.UNKNOWN`
  上的落点、`valid:false` 与空名、窗口两端/单端、`--limit-duration`、窗口不缩小未知字节账、
  三个小数抽稀间隔。
- GUI 端到端（Playwright，真实 `node packages/app/src/server.ts --port 7862`）：选 b2 → Convert →
  Sample Rate `0.5`、Unknown 点过 Interleave 再回 SEPARATE、Prefix `abc`、Time Interval
  `2026-10-31 16:29:02 → 16:29:12` → Convert：结果行 `abcb2-20261101.ASCII +1 · 109,239 B · 61 lines`，
  Files 列出 `abcb2-20261101.UNKNOWN (7,056 B)`，Unknown bytes 行 7,056 B，预览 61 行且首行
  `…,2442,577760.000,…`；**0 console / 0 pageerror**。另跑一遍 Select folder →
  `…\agent-convertgui\gui-dest`，落盘 `…\b2-20261101\Converted_On_20261031_T1629\ASCII\` 两个文件，
  与套件同参数产物 sha256 相同；Sample Rate 填 `abc` 时字段旁出
  `Sample Rate must be a number in Hz.` 且不发请求。
  截图：`C:\Users\SunCh\AppData\Local\Temp\opencode\agent-convertgui\gui-convert.png`（SOURCE 模式）、
  `gui-convert-destination.png`（落盘）、`gui-convert-error.png`（非法 Sample Rate）。

### 6. 未做到的 / 未确认的

- **原生直调 `readmessage` 会崩**（`FATAL ERROR: Error::New napi_get_last_error_info`，进程 0xC0000409），
  所以 `InternalMap` 这条 GUI 路径没走通；Prefix/Suffix 与抽稀是用 `Convert` 直接量的（SBF 不需要
  `InternalMap`）。SDK 里也没有 `--prefix` 之类的开关。
- **原生直调 `timeInterval` 会抛 C++ 异常**（`0xE06D7363`，试过 `{week,msec}`、字符串周、加
  `messageIdFilter` 等写法都崩），所以时间窗的 oracle 用的是**套件 CLI** 同参数（`cli.js:276-289`
  把 `--start-time/--finish-time` 原样写进同一个 `timeInterval` 字段），并附上 `1 362 914 B` 的
  逐字节产物。
- 既有未复刻项未动：`--decimate` + `--unknown-bytes=file` 在 b1 上仍是 5386 B（套件 4014 B）；
  **文本记录进 BINARY**、`--daily-utc` 的 b7 三片。窗口 + `interleave` 组合未测，保持关闭。
- 面板的点击交互（radio 走 `click` 委派，因为弹窗里套了一层 `<label>`，点文字不触发外层 input）
  只有 Playwright 端到端覆盖，没有 DOM 单测——`packages/view` 的 minidom 不属于本条任务的改动范围。



