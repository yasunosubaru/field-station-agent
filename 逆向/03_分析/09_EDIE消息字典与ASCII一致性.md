# EDIE 消息字典与 ASCII 一致性

> 结论：`app/Edie/messages_public.json` 是套件自己的消息字典（608 条报文 / 240 张枚举表 / 7.2 MB），
> 它同时定死了 **二进制布局** 和 **ASCII 打印格式**。按它实现的解码器在真机抓包上逐字段对齐
> 套件输出的 ASCII：**722 761 / 722 761 字段全等（100.00%）**，覆盖全部 12 类报文、每一条日志行、
> 每一个重复块。此前记录的「70.64%」是比对器只比第一条日志第一块造成的假象。

## 1. 为什么换字典

| 来源 | 能给出什么 | 问题 |
|---|---|---|
| `app/model/logparsers.js` | UI 面板真正用到的字段 | **只声明子集**：BESTVEL 只有 2 个字段（实际 8 个），RANGE 整条没有 |
| OEM7 手册 §3.x | 字段顺序、语义、枚举含义 | 没有 ASCII 格式串，枚举用的是手册写法（`SOL COMPUTED`），不是 ASCII 的 `SOL_COMPUTED` |
| **`app/Edie/messages_public.json`** | 字段顺序、字节宽度、4 字节计数前缀、ASCII 转换串（`%7.4lk`、`%08x`、`%02XB`、`%Z`）、枚举表（`SPECTRUMANALYSIS`） | 「最新变体」按 `latestMsgDefCrc` 取；多变体报文需按字段数挑选 |

套件的 Convert 就是用这份字典读二进制、写 ASCII，所以它天然是「1:1」的判据。

## 2. 布局模型（用真机 payload 长度验证过）

```
SIMPLE / ENUM      固定 dataType.length 字节        (USHORT 2, ULONG 4, FLOAT 4, DOUBLE 8, UCHAR 1)
FIELD_ARRAY        4 字节元素个数 + N × stride       (stride = 元素内字段宽度之和)
FIXED_LENGTH_ARRAY arrayLength × 元素宽度，无计数前缀
CHAR/UCHAR 定长数组 打成一个字符串（BESTPOS 的 base_id → `""`，RAWEPHEM 的 subframe → `%Z` 十六进制串）
```

| 报文 | payload 实测 | 由字典推出的结构 |
|---|---:|---|
| RANGE (43) | 2204 | 4 + 50×44（sv_prn 2 + sv_freq 2 + psr 8 + sd_psr 4 + adr 8 + sd_adr 4 + dop 4 + C/No 4 + locktime 4 + chan_status 4） |
| TRACKSTAT (83) | 7096 | 12 + 4 + 177×40 |
| RXSTATUS (93) | 88 | 4 + 4 + 5×16（status / priority / event set / event clear） |
| HWMONITOR (963) | 84 | 4 + 10×8（value / status） |
| BESTSATS (1194) | 292 | 4 + 18×16 |
| SATVIS2 (1043) | 1296 | 12 + 4 + 32×40 |
| PORTSTATS (72) | 1044 | 4 + 26×40 |
| BESTPOS (42) | 72 | 定长 72 |
| BESTVEL (99) | 44 | 定长 44 —— **z 是 8 字节 DOUBLE**，所以是 44 而不是 40 |
| TIME (101) | 44 | 定长 44 |

先前的 `manual-fields.csv` 把 BESTVEL 的 `vertSpeed` 当成 `FLOAT@32` + `reserved@36`，与 44 字节的
真实 payload 不符（读出来是 1.6e-35 这种垃圾值）；已按字典改回 `DOUBLE@32` + `INT_32@40`。

## 3. 实现

| 文件 | 作用 |
|---|---|
| `tools/gen_edie_layouts.js` | 读 `messages_public.json` → `packages/protocol/data/edie-layouts.json`（608 报文 / 240 枚举 / 496 KB），并打印与实测 payload 长度的自检 |
| `packages/protocol/src/edie.ts` | `decodeEdie()`：按字典解出 **打印顺序** 的字段序列（重复块先打元素个数），文本类字段直接给出 ASCII 渲染（枚举名、`%08x`、`%02XB`、`TRUE`、`%Z`） |
| `packages/protocol/src/ascii-diff.ts` | `diffAscii()`：把 ASCII 文件与抓包逐字段比对；同一时刻同名多行（每颗星的 RAWEPHEM）按出现顺序对齐 |
| `packages/cli/src/verify-ascii.ts` | 上面两者的命令行前端 |
| `packages/protocol/test/edie.test.ts` | 回归门禁：布局长度、重复块 stride、RANGE 第 50 个观测、BESTPOS 尾部掩码、RAWEPHEM 十六进制、以及全量 100% |

## 4. 验证结果（真机 OEM729，`broad-clean.gps` → 套件 ASCII）

解码侧逐字段：

```
message             lines   fields     ok    bad    shape   ok%
RANGE                1199   600699 600699      0       0  100.00
TRACKSTAT              59   104666 104666      0       0  100.00
PORTSTATS              18     4698   4698      0       0  100.00
BESTSATS               60     4380   4380      0       0  100.00
SATVIS2                40     3820   3820      0       0  100.00
HWMONITOR              65     1365   1365      0       0  100.00
BESTPOS                60     1260   1260      0       0  100.00
TIME                   60      660    660      0       0  100.00
RXSTATUS               22      484    484      0       0  100.00
BESTVEL                60      480    480      0       0  100.00
ITDETECTSTATUS         60      141    141      0       0  100.00
RAWEPHEM               18      108    108      0       0  100.00
------------------------------------------------------------------
fields: 722761/722761 matched  (100.00%)
```

写出侧整文件逐字节：

```
$ node packages/cli/src/convert-ascii.ts broad-clean.gps -o ours.ASCII
records: 1721   dropped (bad CRC): 1   dropped (no layout): 0
golden 5,567,000 bytes   ours 5,567,000 bytes   完全一致（含 CRLF、行头、CRC）
```

复现：`node packages/cli/src/verify-ascii.ts <golden.ASCII> <capture.bin>`（在工作区
`逆向\04_重实现` 下）。

结论的意义：ASCII 的数值、枚举名、十六进制字、布尔、字符串、每个重复块、行头里的
port/seq/idle/time status/week/ms/receiver status/报文定义 CRC/软件版本，以及行尾 CRC32，
全部与原版一致 —— 解码与 ASCII 写出都不存在「差不多」。

### 4.1 三条靠 golden 才钉死的规则

1. **行尾 CRC32** 是 NovAtel CRC-32（多项式 `0xEDB88320`、init 0、xorout 0），算的是
   `#` 之后、`*` 之前的整句；不是 zlib 的 CRC-32/ISO-HDLC。
2. **浮点按 `printf` 对二进制精确值四舍五入（半数取偶）**，不是 `Number.toFixed`。同一份数据里
   `-2491.5625` 原版打 `-2491.562`（`toFixed` 会给 `-2491.563`），`5.26e-4`（`%7.3k`）打 `0.001`
   而不是科学计数。`packages/protocol/src/ascii-log.ts` 的 `exactFixed()` 用
   `mantissa × 2^exp` 精确展开小数再取偶。
3. **`k/lk` 系列只有 `|v| < 1e-4` 才转科学计数**（`%g` 的指数门槛），与小数位数无关：
   `%7.9lk` 的 `5.22e-10` → `5.221136984e-10`，而 `%7.3k` 的 `5.26e-4` → `0.001`。

### 4.2 CRC 策略：Convert 与视图解析器不一致（实测）

抓包里 1722 帧，ASCII 只有 1721 行。缺的那一帧是 `RANGE @467920.650`，也是**唯一 CRC 不匹配**
的一帧：

| 子系统 | 行为 | 出处 |
|---|---|---|
| 视图解析器 | 只有 CRC 字段为 0 才丢帧，不校验 CRC 值 | `01_解包/app/view/js/genericparser.js:139-141` |
| Convert（EDIE） | **校验 CRC**，不匹配即丢 | golden 少一行这一事实 |

`framing.ts` 的 `crcMode` 因此有两个档：`mirror`（默认，复现视图）与 `validate`；
ASCII 写出默认 `requireValidCrc: true`（复现 Convert）。

## 5. 仍未完成的部分

1. **其它格式的写出**：ABBREV ASCII、BINARY、KML、RINEX 2.1/3.01–3.04 的 golden 已经在
   `samples/convert/golden-*`，但只有 ASCII 做到了逐字节相同。
2. **其余 596 条报文**：字典已全部生成（608 条），但只有抓包里出现的 12 类做过真机验证；
   `%B` / `%P` / `%T` / `%R` / `%m` / `%c` 这几种转换串的语义还没从原版里读出来。
3. **UI 仍走 `logparsers.js` 的字段表**：`message-specs.json` 与 `edie-layouts.json` 现在是两套
   （前者复现面板、后者复现 Convert）。若要让面板也能显示重复块的全部成员，需要把 UI 切到 EDIE
   布局，属于改动面较大的重构。

## 6. 外部参考

| 事实 | 出处 |
|---|---|
| 报文布局、ASCII 转换串、枚举词表 | `01_解包/app/Edie/messages_public.json`（`meta.subset = all`, `version 0.3.0`） |
| 字段语义与单位 | `00_来源/手册文本/OEM7-Commands-and-Logs-Reference-Manual.txt` §3.x |
| 真机输出 | `00_来源/samples/convert/golden-broad-ascii/broad-clean/Converted_On_20261030_T1800/ASCII/broad-clean.ASCII` |
| 原始抓包 | `00_来源/samples/convert/broad-clean.gps` |

---

## 9.x 无界面 oracle：套件自带的 convert CLI（2026-10-31）

**重要方法论**：原版套件的 exe 就是 Electron 运行时，且 `main.js` 里有一条 CLI 分支
（`checkIfCalledViaCLI(process.argv)` → `require("./view/convert/cli.js").executeCLI(...)`）。
所以**不打开 GUI 也能用原版 Edie 引擎做转换**，这就是逐字节比对最可靠的 oracle：

```powershell
& "C:\Program Files\NovAtel Inc\NovAtel Application Suite\NovAtelApplicationSuite.exe" `
    -a -o <纯 ASCII 输出目录> <纯 ASCII 输入文件>
```

实测：`clean-9600.gps` → `clean.gps.ASCII` = **489 205 B**，与仓库里的 golden 一致。

两个坑：

1. **参数里的路径必须纯 ASCII、无空格**。中文路径会让套件自己的参数解析读不到文件，
   报 `Please provide a file to convert` 而不是报错。先 copy 到临时 ASCII 目录再跑。
2. 它只认 `-a/-b/--abbrev/-k/-r3.0x` 这类短开关与位置参数；输出目录用 `-o`，
   产物落在 `<out>\<name>\Converted_On_<YYYYMMDD>_T<HHMM>\ASCII\<name>.ASCII`，另有 `Summary_<name>.txt`。

### 9.x.1 真机抓包第一次跑通（2026-10-31）

接收机 OEM729-2.03，USB 虚拟串口 COM13/14/15（COM13 被套件占用，**我们一口气读 COM14/COM15**
互不干扰，套件那边照常显示）。COM15 是 ASCII 模式，所以请求 `...B` 后缀的日志才能拿到二进制 SBF。

两份抓包（`逆向/00_来源/samples/live-20261031/`，含 oracle 输出的 golden）：

| 文件 | 大小 | 关键报文 |
|---|---:|---|
| `live-nav.sbf` | 1 643 003 | **GLOEPHEMERIS id 723 ×12**、RAWEPHEM ×8、BESTPOS/RANGE/RXSTATUS/PORTSTATS/HWMONITOR |
| `live-nav2.sbf` | 1 563 194 | **BDSEPHEMERIS id 1696 ×39**、RAWEPHEM ×9、同上 |

（报文名与 id 的对应取自套件自己的 `resources/app.asar.unpacked/Edie/messages_public.json`，
608 条定义；`1696` = BDSEPHEMERIS，`723` = GLOEPHEMERIS。）

### 9.x.2 比对结论

逐行多重集比对（脚本 `opencode/cmp-lines.cjs`、`cmp-ascii.cjs`）：

- **BESTPOSA / RANGEA / RXSTATUSA / PORTSTATSA / HWMONITORA / RAWEPHEMA / GLOEPHEMERISA / BDSEPHEMERISA
  的行数一致**，其中前六类**逐字节相同**。
- **GLOEPHEMERISA 12 行、BDSEPHEMERISA 39 行，修复后已逐字节一致**（原因与修法见 §9.x.3）。
- `SATVIS2A`（16 行）与 `TIMESYNCA`（2 行）**我们完全没有输出**——不是解码错，是
  **抓包里这两类只以 ASCII 文本形式出现**，而我们只解析二进制 SBF 帧，套件的 Edie 两种输入都吃。
  这条差异已在文档登记，属于"已知缺口"，不是静默失败。

### 9.x.3 星历 ASCII 的两处修正（2026-10-31）

**① 端口名**：原实现用 `address - 0xA0`，在 0xA0 处差一，打出 `SPECIAL_0`。真实规则在 Edie 字典的
`PortAddress` 枚举（1552 条）：每组占 32 个地址，`base+0` 是**组名本身**（`COM1`/`USB`/`SPECIAL`/`FILE`…），
`base+n` 才是 `组名_n`；`0..31` 与 `5824..5845` 是 `*_ALL` 聚合名。`portName()` 改为按枚举建表，
逐条比对 1552 条 0 处不一致。顺带修掉 `PORTSTATS`：`CommPort` 枚举只到 `SCOM4 = 52`，
超出时原版打 `UNKNOWN`，我们原来打数字。

**② 浮点**：原版按字段自带的 format 串走 C 的 `%e/%f`，宽度 W 决定定点窗口：

| format 形态 | 定点条件 | 例 |
|---|---|---|
| `%W.Nlk`，W>0 | `10^-W <= \|v\| <= 10^W` | `%9.1lk`：1e9 → `1000000000.0`，1e10 → `1.0e+10` |
| `%0.Nlk`（星历字段） | 窗口退化成 `\|v\| == 1`（只有 0 与 ±1 定点） | 1.5 → `1.5000000000e+00` |
| `%.17lk`（GLO 位置/速度） | 恒指数 | `-1.71685703125000000e+07` |

新增 `exactExponential()`：按精确二进制值做十进制展开 + round-half-even，指数强制 `e±NN` 两位，
并保留 `-0.0` 的负号（`toExponential` 会丢）。

诚实边界：原版拿 C 库 `pow(10,-W)` 比较，个别指数有 1 ulp 偏差（`1e-7`/`1e-9` 落在窗口外打指数、
`1e-2` 落在窗口内打定点），而 `Math.pow` 是正确舍入——**恰好等于 `10^-W` 的值**理论上可能差一位。
合成探针 104 行里只有这 2 行走在边界上，真实抓包与四份 golden 都没遇到。

### 9.x.4 结果

| 抓包 | oracle 行 | 我们 | 我们不在 oracle 里的行 |
|---|---:|---:|---:|
| live-nav | 617 | 538 | **14 → 0** |
| live-nav2 | 593 | 519 | **41 → 0** |

`GLOEPHEMERISA 12/12`、`BDSEPHEMERISA 39/39`、`PORTSTATSA 2/2`、`RAWEPHEMA 9/9` 逐字节相同。

**已知缺口**：oracle 多出的 79 / 74 行全部是抓包里夹带的**文本记录**（`<RANGE`、`<BESTPOS`、
`<SATVIS2`、`<TIMESYNC`、`#BESTPOSA`…）——同一物理口上同时开了二进制与文本 log，
套件两种输入都吃，我们只解析二进制 SBF 帧。要做需新增 `packages/protocol/src/text-log.ts`
（头行 10 个 token 换逗号、名字加 `A`、续行拼接、重算 CRC-32；`#…` 完整 ASCII 直接透传），
再把文本帧按帧顺序插进 `convert.ts` 的输出，估计 3–5 小时。

> **2026-11-01 补记：这个缺口已闭合**（`text-log.ts` 已实现，79 / 74 → 0，两个文件逐字节一致）。
> 实现细节与两条反直觉的实测结论见下面 §9.x.6。

**端口分布**（顺带核实）：`0xA0`（SPECIAL，组首）只用来出星历；`0xBD`（SPECIAL_29）是这批抓包的
常规日志口（BESTPOS/RANGE/RXSTATUS/RAWEPHEM/HWMONITOR/PORTSTATS）。这与 payload 首字节无关，
纯粹是 SBF 长头第 7 字节的 port address。

---

## 9.x.5 23 类抓包的四个协议缺陷（2026-11-01 修完，189 行 → 0）

素材：`samples/live-20261031/remote-23types.sbf`（2 018 852 B，远程机 DESKTOP-9POIV0O 上抓）
+ `golden-remote-23types.ASCII`（3 845 232 B，套件 CLI 产出）。1208 行 / 23 类。

修复前 189 行不同（`cmp-lines.cjs` 多重集比对），分属四个根因，**四个都已闭合**：

| # | 类型 | 行数 | 根因 | 修法 |
|---|---|---:|---|---|
| 1 | `ITPSDFINALA` / `ITPSDDETECTA` | 149 | 字典里 `samples` 是 `VARIABLE_LENGTH_ARRAY`（`arrayLengthFieldSize` = 4、元素 `%hu` 2 字节），生成器不认识这个 `type`，按普通标量处理，1024 个采样被截成「计数」一个数 | `tools/gen_edie_layouts.js` 新增 VLA 分支；`ascii-log.ts` 的计数前缀按 1/2/4 字节读，无前缀的 VLA（`RXCONFIG`）跑到 payload 末尾 |
| 2 | `LOGLISTA` | 21 | `%m` 未实现，打的是裸数字 | `%m` 按 id 的高位标志位选后缀（见下） |
| 3 | `ITDETECTSTATUSA` | 15 | 字典写 `%08X`，原版打小写 | 十六进制一律小写 |
| 4 | `RXCONFIGA` | 4 | `%R` 未实现，打的是 payload 首字节 | `%R` = 内嵌二进制报文，按 ASCII 整行再输出一次 |

### ① `VARIABLE_LENGTH_ARRAY`

`messages_public.json` 里 ITPSDFINAL 只有 4 个字段，第 4 个是数组：

```json
{ "name": "samples", "type": "VARIABLE_LENGTH_ARRAY", "arrayLength": 1024,
  "arrayLengthFieldSize": 4, "conversionString": "%hu",
  "dataType": { "name": "USHORT", "length": 2 } }
```

实测 payload = **2064 B** = 4（状态字）+ 4（起始频率）+ 4（步进）+ 4（计数）+ 1024×2，
与「4 字节计数 + N×2」完全吻合。ASCII 行因此变成 **6267 字符**：
`...,1531.299,97656.250,1024,23511,22631,...,23039`（1024 个采样）。我们原来把 `samples`
当标量，读出低 2 字节正好也是 1024，所以只显出「少了一串数字」而不报错——**这种"碰巧对上"的
错误只有逐字节 oracle 才抓得住**。

全字典 61 个 VLA 字段（涉及 56 条报文），前缀只有两种：`arrayLengthFieldSize = 4`（59 个）
与完全没有前缀（2 个，`RXCONFIG` / `RXCONFIGUSER`，整个 payload 就是数据）。

**副产品（顺带核实，别当成已完成的 GRIT 功能）**：ASCII / Convert 这条线现在能拿到 ITPSD 的
1024 个采样。GRIT 频谱曲线走的是**另一条**解码路径——`data/repeat-layouts.json` 的 `1968` / `2063`
（`blockStart 16`、`blockSize 2`、计数取 `noofSamples`）——那条早就声明了 `sample`，所以画不出曲线
的原因**不是**这次修的数组展开，而是接收机上有没有实际开 ITPSD 日志、以及 app 有没有把帧喂进
`spectrumViewer.ingest()`。这里不宣称 GRIT 已解决。

### ② `%m`：id → 名字，靠高位标志位选后缀

`LOGLISTA` 的 97 条日志里同一个数字要按上下文打印成不同后缀，实测三种：

| id | 二进制 | 打印 |
|---:|---|---|
| `41` | `0x29` | `RAWEPHEMB` |
| `2097246` | `0x20005E` | `RXSTATUSEVENTA` |
| `4194796` | `0x4001EC` | `TIMESYNC` |
| `2075` | `0x081B` | `UNKNOWNB`（字典里没有这条） |

规则：`1<<21` → ASCII 版加 `A`；`1<<22` → 不加后缀（`TIMESYNC`、`BESTPOS`、`RANGE`、
`RXSTATUS`、`SATVIS2`、`HWMONITOR`、`GLOEPHEMERIS` 这 7 条）；其余 → 二进制版加 `B`。
`0x400000` 这一档共 7 条，全部实测对上。

### ③ `%08X` 打小写

字典把 `ITDETECTSTATUS` 的三个 severity 字写成 `%08X`，原版却打 `00000000,00000000,0000000f`。
全字典只有 2 条报文用 `%08X`（另一条 `RADARSTATUS` 抓不到），`%02XB`/`%XB` 的字段至今只见过
纯数字，所以**这条只在 ITDETECTSTATUS 上被证明**，实现取「十六进制一律小写」并在注释里写明边界。

### ④ `%R`：内嵌报文 + 一个被取反的 CRC

`RXCONFIG` 的 payload **就是一整个 SBF 帧**（长头 28 + payload 32 + CRC 4 = 64 B），
`%R` 把它按 ASCII 再输出一次，放在外层的 body 里：

```
#RXCONFIGA,...,18278;#LOGA,SPECIAL_30,0,72.0,COARSESTEERING,2442,563598.156,03801800,92b2,18278;USB1,BESTPOSB,ONTIME,1.000000,0.000000,NOHOLD*8fbf58c8*18feb321
```

两处实测细节：

1. **内嵌帧自己的 CRC 字段是坏的**（4 条 RXCONFIG 全部 `crcOk=false`），但原版照样打印，
   说明它不校验、而是自己重算。
2. **内嵌行的 CRC 是取反的**：`~novatelCrc32(sentence)`，也就是 CRC-32/POSIX
   （poly `0xEDB88320`、init 0、**xorout `0xFFFFFFFF`**）。外层 CRC 仍是 NovAtel 原式。
   这条不是从内容推的，是拿 **8 条样本**拟合出来的：4 条真机行 + 4 条我合成后喂给套件 CLI
   的探针（`gen-rxconfig.ts`，改 `on_time`、改 `%m` 的 id、故意把内嵌 CRC 改坏），8/8 全中。
   顺带确认：内嵌 CRC 与内嵌帧里存的 CRC 值无关，只与打印出来的那行文字有关。

### 修完的复验数字

```
$ node packages/cli/src/convert.ts ../../00_来源/samples/live-20261031/remote-23types.sbf --to ASCII --out <tmp>
input     : remote-23types.sbf (2018852 bytes, 1208 records)
output    : .../remote-23types.ASCII (3845232 bytes)   ← 与 oracle 同字节数
dropped   : 0 (bad CRC)

$ node cmp-lines.cjs <oracle.ASCII> <ours.ASCII>
oracle 行 1208；ours 行 1208
ours 中不在 oracle 里的行: 0
oracle 多出的行: 0

SHA-256  893D135E3E548F92779B1C40C7552764B11539BE6270716C1723C4DF2901BCAB（两侧相同）
```

回归：四份老 golden（`broad-clean.ASCII` 5 567 000 B、`clean-9600.ASCII` 489 205 B、
`clean-9600.ABBREV_ASCII` 567 576 B、`clean-9600_BESTPOS.KML`、BINARY）**逐字节不变**；
RINEX 三版与 golden 的差别只剩写入时间戳（由 `--at` 决定），`APPROX POSITION XYZ` 也已逐字节
（取最后一条 BESTPOS，见 `10_RINEX输出规格.md` §2）。
测试 `node --test "packages/*/test/*.test.ts"` → **500 / 500**（新增
`packages/protocol/test/live-23types.test.ts` 5 项，把上面四件事逐条钉住）。

---

## 9.x.6 文本记录（A3）：79 / 74 行补齐，两条反直觉结论（2026-11-01）

`live-nav` / `live-nav2` 这两份抓包把同一台接收机的**两种输出混在一条流里**：二进制 SBF 走
SPECIAL_29，缩写 ASCII 走 USB2，另外还有 11 / 10 条完整的 `#BESTPOSA` 文本行。套件的 Convert
两种都吃，所以 oracle 比我们多 79 / 74 行。新增 `packages/protocol/src/text-log.ts`，按帧顺序把
文本记录插进 `convert.ts` / `convert-ascii.ts` 的输出。

### 三种形态

| 形态 | 例 | 处理 |
|---|---|---|
| `<NAME …` 头行 | `<RANGE USB2 0 75.5 COARSESTEERING 2442 555611.000 03801800 5103 18278` | 名字加 `A`，后面 9 个 token 原样用逗号连起来 |
| `<…` 续行 | `<     73 `、`<   4 0 20229880.713 …`、`<   SOL_COMPUTED SINGLE …`、`<   GPS TRUE TRUE 32` | 拼进 body |
| `#NAME,…*crc` | `#BESTPOSA,USB2,…*9aa75286` | **原样透传**（11/11 与 oracle 逐字节相同，抓包里的 CRC 已经是最终值） |

`<OK`（8 条）、`<?` 提示符、`[USB2]` 端口文本、裸 `<` 都**不产出日志行**——oracle 里对应 0 行。

### 结论一：body 不是字符串拼接，而是「回读成字段再按字典重打」

这是花了 21 行 diff 才发现的。HWMONITOR 的文本里 status 是 `100`、`f00`，oracle 打的却是
`00000100`、`00000f00`——因为那是 `%x` 字段，`100` 是**十六进制**，回读成 0x100 再按 `%08x` 打出。
完整规则：按布局顺序逐个 token 回读 → 枚举按名字反查值、十六进制字段按 16 进制解析、其余按十进制
/浮点解析 → 再用同一套 `formatField` 打印。

### 结论二：float32 字段回读后会被舍入，`75947.813` → `75947.812`

RANGE 的第 740 个 token（`lock_time`，字典里是 `FLOAT` + `%7.3k`）文本写 `75947.813`，
oracle 打 `75947.812`：`75947.813` 回读成 float32 恰好是 **75947.8125**，`printf` 对 3 位小数
按半数取偶 → `.812`。740 个 token 里只有这 1 个不同，**纯文本复制永远对不上**，这条只有逐字节
oracle 抓得住。f64 字段（如 RANGE 的 `adr` `%9.6lk`）回读无损，6 位小数原样保留。

### 复验

```
$ node packages/cli/src/convert.ts live-nav.sbf  --to ASCII -o <tmp>
$ node packages/cli/src/convert.ts live-nav2.sbf --to ASCII -o <tmp>
oracle 行 617 / 593，ours 行 617 / 593
ours 中不在 oracle 里的行: 0 / 0
oracle 多出的行: 0 / 0
SHA-256 两侧相同（2 798 307 B / 2 657 890 B）
```

文本行的构成（live-nav）：`RANGEA 22`、`BESTPOSA 22`、`SATVIS2A 16`、`RXSTATUSA 4`、
`TIMESYNCA 2`、`HWMONITORA 2`、`#` 透传 11。

测试：`packages/protocol/test/text-log.test.ts` 7 项（两份抓包整文件逐行比对 + 三条单测：
`%x` 补零、float32 舍入、`#` 透传、`<OK` 不产行）。全量 **507 / 507**。

**仍未覆盖**（写明而不是猜）：`%` 短 ASCII 与 `$` NMEA 文本记录没有样本，套件行为未测；
`ABBREV_ASCII` 输出里的文本记录也没接线（现有 abbrev golden 不含文本行）。

---

## 9.x.8 B1 第二批：21 类，暴露两条**新**缺口（2026-11-01）

抓包 `samples/live-20261031/b2-20261101.sbf`（2 581 390 B / 30 s），用
`tools/remote/b2-capture.ps1` 抓的，目标全是前两批没有的报文：
`MARKPOS`、`PSRPOS`、`PSRXYZ`、`PPPXYZ`、`BESTGNSSVEL`、`BESTGNSSPOS`、`BESTUTM`、
`RAIMSTATUS`、`ALMANAC`、`RAWALM`、`GLORAWALM`、`CLOCKMODEL`、`IPSTATUS`、`ETHSTATUS`、
以及 **`RANGECMP2` / `RANGECMP4`**（压缩测距，VLA + `%Z`/`%hu`）。
套件 CLI 出的 golden：`golden-b2-20261101.ASCII`（4 931 973 B / 905 行）。

### 结果：905 行全在，但 62 行内容不对

```
oracle 行 905；ours 行 905
ours 中不在 oracle 里的行: 62      oracle 多出的行: 62
按类型：RANGEA 61 / IPSTATUSA 1
```

**① `RANGECMP2` / `RANGECMP4` 原版解压成 `RANGEA` 输出（61 行）**

| 类型 | oracle 行数 | ours 行数 |
|---|---:|---:|
| `RANGEA` | **699** | 638 |
| `RANGECMP2A` | **0** | 31 |
| `RANGECMP4A` | **0** | 30 |

699 = 638 + 31 + 30。也就是说套件的 Convert **读 RANGECMP 的位打包数据、解压成标准 RANGE 行**
再打印，不是原样输出压缩块。我们目前把 RANGECMP 当自己的类型、把 VLA 当
`%Z`/`%hu` 逐元素打印，所以两边对不上。

要做的事：实现 RANGECMP2/3/4/5 的**解压**（位域打包：PRN/频率/伪距/载波相位/多普勒/CNo/
锁定时间/通道状态），再套 RANGE 的 ASCII 格式。这是 B1 里最大的一块，涉及字典里
`RANGECMP*` 五条报文。

**② `IPSTATUSA` 的可变长字符串数组（1 行）**

```
oracle: 1,ETHA,"192.168.5.10","255.255.255.0","192.168.5.1",1,"192.168.5.1"
ours  : 1,ETHA,"192.168.5.10","255.255.255.0","192.168.5.1",2,"192.168.5.10","255.255.255.0"
```

IPSTATUS 的条目是「类型 + 若干 `ustring`」，**字符串个数随类型变化**；我们按固定字段读，
于是把第二个条目的字符串也算进了第一条。要按字典里的条目类型分支（和 ICOMCONFIG 的
`ustring` 同一个毛病，但嵌套在数组里）。

### 顺带一条运维教训

`UNLOGALL <名字>` 里的名字是**接收机的端口名**（`USB1`、`COM2`…），不是 Windows 的 `COM10`。
所以 `b1-capture.ps1` 里那句 `UNLOGALL COM10` 其实**什么都没清**，日志会留在接收机上
（这也是 10/31 那批"残留 LOG"的来源）。现在改成**裸 `UNLOGALL`**（清当前口）——
`b2-capture.ps1` 已经这么写，`b1-capture.ps1` 同步改掉。

### 状态

- ✅ `b2` 抓包 + golden 入库；21 类里 19 类逐字节一致
- ✅ **RANGECMP2 / RANGECMP4 解压已实现并接线**（`packages/protocol/src/rangecmp.ts` +
  `convert.ts`）：b2 从 62 行差异降到 **1 行**，这 1 行是 IPSTATUSA（见上）
  - 61 条压缩记录 → 2 697 / 2 610 个观测，逐字节等于 oracle 的 61 条 `RANGEA` 行
  - 难点都在 `rangecmp.ts` 头部注释里：CMP2 卫星块是 80 bit 不是 96；LSB-first 位流；
    `adr` 除以波长；FLOAT 字段要 float32 舍入；CMP4 的 C/No 平局取"能印出与 double
    同一位"的那个 float32 邻居（`buildRangePayload` 的 `roundForPrint`）；
    `lock_time` 要跨记录进位（`lockTimeCarry`，否则饱和在 131.071）
  - 零覆盖但按表实现的：差分块（Table 199/200）、GLONASS/SBAS/Galileo/NavIC 信号
- ❌ IPSTATUSA 变长字符串未实现（1 行）
- 真机链路：Tailscale → `serial-bridge.ps1` → COM10 → OEM729，7 s 解出 291 条记录 / 16 类
  （2026-11-01 实测，桥已停、端口已释放）


---

## 9.x.7 B1 扩报文覆盖：25 类 / 1402 行逐字节一致（2026-11-01）

### 怎么抓的

接收机已在远程机，套件不在跑时 COM8/COM9/COM10 都空闲。新脚本 `tools/remote/b1-capture.ps1`
（纯 ASCII，坑照旧：写文件 → scp → 按路径执行）：

1. 打开空闲口（本次 COM10，115200）；
2. 先发 `LOG … ONCE`（一次性）再发 `LOG … ONTIME`（周期），共 24 条日志；
3. 抓 25 s；
4. 收尾 `UNLOGALL COM10` —— **只清我们自己那个口**，不碰套件用的 COM9。

样本 `samples/live-20261031/b1-20261101.sbf`（2 758 111 B），oracle 是本机套件 CLI
`NovAtelApplicationSuite.exe -a`，产出 `golden-b1-20261101.ASCII`（5 088 882 B / 1402 行）。

**覆盖 25 类**（对比 23 类抓包新增 9 类）：
`VERSION(37)`、`GPSEPHEM(7)`、`GALEPHEMERIS(1122)`、`BESTVEL(99)`、`BESTXYZ(241)`、
`PSRDOP(174)`、`SERIALCONFIG(1246)`、`MODELFEATURES(1329)`、`IONUTC(8)`，
另有 RANGE / BESTPOS / SATVIS2 / TRACKSTAT / PORTSTATS / BESTSATS / HWMONITOR / TIME /
ITPSDFINAL / ITPSDDETECT / ITDETECTSTATUS / RXSTATUS / RAWEPHEM / GLO·BDS 星历 / RXCONFIG / LOGLIST。

### 又逼出四条规则（66 行 → 0）

| # | 现象 | 规则 |
|---|---|---|
| 1 | `J1939CONFIG` 的 `%02X` 我们打 `1c`，原版 `0000001c` | 十六进制声明的宽度是**下限**，ULONG 字段一律填满 8 位 |
| 2 | `BESTXYZ` 的 `char_as_int` 原版 `0`，我们 `00` | `%B`（CHAR 按十六进制）**不补零**；`%02XB` 才补 |
| 3 | `ICOMCONFIG`/`SETNAV`/`DNSCONFIG` 的字符串错位 | 字典的 `STRING` 类型：`arrayLength` 只是**上限**，线上是「读到 NUL + 补到 4 字节边界」。`":3002"` 占 8 字节（payload 20 = 4+4+8+4），`"FROM"` 声明 6 却占 8 |
| 4 | 4 条 RAWEPHEM 我们完全没有 | **CRC 校验失败的记录，原版不按长度字段跳过**，而是往后找下一个记录起点；一个 CRC 坏的 RANGE 声明了 3700 字节 payload，里面藏着 5 条 RAWEPHEM，原版捞回 4 条（第 5 条自身 CRC 也坏）。另有一条 `%R` 内嵌报文解析不了时，**整条记录丢弃**而不是打空 body（42 条 RXCONFIG 如此） |

第 4 条落在 `framing.ts`：`crcMode: 'validate'` 时拒绝后只向后移动一个头长，并且在恢复过程中
**只认二进制同步字**（否则坏 payload 里的 `<`/`#` 字节会被当成文本记录起点，一路吃到下一个换行，
把后面的真记录吞掉——`broad-clean.gps` 里正好吞掉 4 条 SATVIS2）。

### 结果

```
$ node packages/cli/src/convert.ts b1-20261101.sbf --to ASCII -o <tmp>
oracle 行 1402；ours 行 1402
ours 中不在 oracle 里的行: 0
oracle 多出的行: 0
5 088 882 B，SHA-256 = 2D6F529F…672CC361（两侧相同）
```

回归：`broad-clean.ASCII` 5 567 000 B **逐字节不变**，`clean-9600.ABBREV_ASCII`、KML、BINARY 同；
RINEX 仍只差已知两行。测试 **511 / 511**（新增 `live-b1.test.ts` 4 项）。

---

## 9.x.9 B1 第三批（b3）：30 类 / 1726 行逐字节一致，逼出两条**读字段**的规则（2026-11-01）

### 怎么抓的

脚本 `tools/remote/b3-capture.ps1`（纯 ASCII），样本 `samples/live-20261031/b3-20261101.sbf`
（3 375 904 B / 30 s），golden 是本机套件 CLI 出的 `golden-b3-20261101.ASCII`
（6 137 463 B / 1726 行）。

选型全部先**探测**再抓，不靠猜。脚本带 `-ProbeOnly`：一条一条发 `LOG … ONCE`，把回显的可打印
部分写进报告，`<OK` 是收下，`<ERROR:Message is invalid for this model` 是这台机器根本没有。

| 结论 | 报文 |
|---|---|
| 收下且**出了记录**（24 类，本批新增） | UPTIME、IPSTATS、J1939STATUS、SAFEMODESTATUS、TIMESYNC、GLOCLOCK、BDSCLOCK、GALALMANAC、BDSALMANAC、GALIONO、BDSIONO、GLORAWEPHEM、BDSRAWNAVSUBFRAME、RAWGPSSUBFRAME、RAWGPSWORD、PSRDOP2、PSRTIME、PSRSATS、PSRVEL、BESTVELX、SATXYZ2、NAVIGATE、BDSBCNAV2EPHEMERIS、GALINAVEPHEMERIS |
| 拒绝（7） | FILESYSTEMSTATUS、FILESYSTEMCAPACITY、FILESTATUS、FILETRANSFERSTATUS、RTKDOP、RTKDOP2、MATCHEDSATS |
| 收下但 30 s 内一条不出（9，ONCE/ONTIME/ONNEW 都试过） | GLORAWFRAME、GLORAWSTRING、GALCLOCK、REFSTATION、RXSTATUSEVENT、BDSBCNAV1EPHEMERIS、GALFNAVEPHEMERIS、GPSCNAVRAWMESSAGE、SBASALMANAC |

样本里最终 30 类：上面 24 类，加上接收机自己一直在发的 RANGE、BESTPOS、RAWEPHEM、PORTSTATS、
HWMONITOR、RXSTATUS（这 6 类是顺带回归，不是本批目标）。

**运维坑（新）**：一个口能挂的 LOG 有上限（约 32 条，那 6 条"别人留下"的也算），**超出的 LOG 命令
照样回 `<OK`，然后永不触发**。第一次 30 s 抓包里，第十二条之后的 ONCE 全部无声无息——不是模型
不支持，是槽位满了。现在脚本分三段：两组 ONCE 各配一次 `UNLOGALL`，再挂周期组。
判别方法很朴素：某类明明 `<OK` 却一条记录都没有，就去看它是不是排在列表尾部。

### 结果：1726 行全在，先 40 行内容不对，归成 2 条根因

第一轮（24 类）只差 1 行（GLOCLOCK）；扩到 30 类后 39 行（GALINAVEPHEMERIS 27 +
RAWGPSSUBFRAME 12）。两条根因都在**读字段**这一层，不在转换串：

**① 字典的整数拼写有八种，读字段的表只认识四种（27 行）**

字典把整数写成 `UCHAR / USHORT / SHORT / ULONG / INT / UINT / ULONG64 / LONGLONG`，
抽取出来的布局表原样保留了拼写，而 `readScalar` 只列了 `u8/u16/u32/i32`，其余全落到
`default: getUint8`——**只读 1 个字节**。偏移是绝对偏移，所以后面的字段不会跟着错位，只有
"值超出 1 字节"的字段才看得出：

```
#GALINAVEPHEMERISA,…;…,81600,…     ← oracle（toe，UINT，4 字节）
#GALINAVEPHEMERISA,…;…,192,…       ← ours（0x81600 的低字节 0xC0）
```

BDSCLOCK 的 `SHORT` 也在同一张表里，但它的时差是小数值，1 字节读出来照样对，所以上一轮没暴露。
修法：`readScalar` / `decodeEdie` 按拼写给宽度（`char`/`hexbyte` 1、`short`/`ushort` 2、
`int`/`uint`/`ulong`/`long` 4、`longlong`/`ulonglong` 8）。

**② 布局表是"紧排"的，线上是 `pack(4)`（13 行）**

`edie-layouts.json` 的偏移是生成器**按字段宽度累加**出来的，而 SBF 结构体按 4 字节对齐：
`USHORT` 落 2 字节边界，`ULONG`/`DOUBLE`/`ULONG64` 落 4 字节边界。两处实测：

| 报文 | 现象 | 线上布局 |
|---|---|---|
| GLOCLOCK（1 行） | `tau_gps` 打印 `0.000000000`，oracle 是 `3.725290298e-09`（= 2⁻²⁸） | `n4` 收在 22 → `tau_gps` 24（不是 22）、`na` 32、`tau_c` 36…`kp` 60，**payload 61 而不是 57** |
| RAWGPSSUBFRAME（12 行） | `signal_channel_number` 打印 `1179648`（0x00120000），oracle 是 `18` | 30 字节 `%Z` 收在 42 → `ULONG` 44，**payload 48 而不是 46** |

难点是**不能无脑套对齐**：把 `pack(4)` 规则一股脑套到全部 608 条布局上，会有 28 条偏移变化，
而其中 RAWEPHEM、SETNAV、GPGGARTK 等在诚实样本里明明是紧排的（payload = 紧排长度，逐字节一致）。
所以规则写成"**只在记录自己证明时才用**"：算出该布局的紧排长度与对齐长度，**当 payload 恰好等于
对齐长度（且两者不等）**才改偏移，否则原样不动。GLOCLOCK 61、RAWGPSSUBFRAME 48 正好落进条件；
其余报文 payload 都等于紧排长度，一条都不动——六份老 golden 因此逐字节不变。

### 修完的复验数字

```
$ node packages/cli/src/convert.ts b3-20261101.sbf --to ASCII -o <tmp>
oracle 行 1726；ours 行 1726
ours 中不在 oracle 里的行: 0
oracle 多出的行: 0
6 137 463 B，SHA-256 = C6A678CD…4F94F4B8（两侧相同）
```

六份老 golden 复跑（直接 `convert.ts` + SHA-256 比对）：

```
broad-clean    IDENTICAL 5 567 000 B
clean-9600     IDENTICAL   489 205 B
live-nav       IDENTICAL 2 798 307 B
live-nav2      IDENTICAL 2 657 890 B
remote-23types IDENTICAL 3 845 232 B
b1             IDENTICAL 5 088 882 B
b2             DIFFERENT 4 931 973 → 4 931 990（仍只有 IPSTATUSA 那 1 行）
```

测试 **599 / 599**（新增 `live-b3.test.ts` 5 项：整份 golden 逐字节、30 类清单、整数宽度、
对齐只在 payload 证明时生效、两处实测 payload 长度）。

### 剩余

- ❌ **IPSTATUSA 变长字符串数组（b2 的 1 行，仍旧）**：`IPSTATUS` 的第二个数组
  `dns_server` 在布局表里被放在 `off=4`（生成器不知道前面那个"变长字符串数组"到底占多少），
  而条目里是三条 `STRING`，实际长度随内容变。要修得让渲染器在**变长数组之后**按实际消耗的
  字节续排后续字段，属于布局模型改造，牵动 ICOMCONFIG / SETNAV / DNSCONFIG 等已逐字节一致的报文，
  没有样本逼迫之前不动。
- ❌ **ULONG64 / LONGLONG 仍无样本**：唯一用到 `%llu` 的 FILESYSTEMCAPACITY 被这台模型拒绝，
  `%lld` 只在 INSPVACMP（SPAN，无 IMU）里。宽度表已按声明实现，但没有真机数据背书。
- ⚠️ `%P`（29 条 PASS*）依旧无样本：需要外部串口往接收机灌数据；本轮 `%Z` + 数组的组合只能靠
  RAWGPSSUBFRAME / GLORAWEPHEM 覆盖。

## 9.x.10 ABBREV 渲染重写 + IPSTATUSA 动态偏移（2026-11-01）

上一节留下的两条"只能报不能改"都做完了：ABBREV 的 23 万行偏差，与 b2 最后那 1 行。

### ① `framing.ts`：没有终止符的 `$` 不许吃掉后面的帧

先用套件自己的 CLI 做了 12 个合成抓包（`--abbrev` 与 `--format ASCII` 各跑一遍）定位规则：

| 合成抓包 | 套件输出 |
|---|---|
| `$GGA*47` 无 CRLF + 2 个 BESTPOS + CRLF | 两条 BESTPOS **都在**，句子本身无输出 |
| `$GGA*47` + `#BESTPOSA,…*crc\r\n` | `#` 记录出来，句子没有 |
| `$GGA*47` + `$GGA*47\r\n` | 打印一行**合并**的 NMEA（`$` 不是边界） |
| `$GGA*47` + `<BESTPOS …\r\n` | 两边都没有输出（`<` 也不是边界） |
| 只有 CR 没有 LF | 丢弃 |

结论：文本记录的跨度只在遇到**二进制同步（`0xAA ?? 0x12/0x13`）**或 `#` 时截断，别的都不截。
实现 `textBoundary()`：在 `[i+1, 行尾)` 里找边界，找到就丢掉这段（`onDrop('record-start-inside-text')`）
并从边界继续扫；没找到才按原来的"等 LF / 缓冲"。m5 少的那条 BESTPOS 由此补回。

### ② `abbrev-log.ts`：按实测重写二进制帧的 ABBREV 渲染

七条规则，每条都有套件对照：

1. 缩进与空行：数据行 `<` + 4 空格 + **有值才加分隔空格**（空行是 `<    `）；元素行 `<` + 9 空格
   （空行 `<         `，b1 里 SATVIS2 0 颗星就是这一行）。
2. 0 元素 `FIELD_ARRAY` 仍留一行空元素行（`max(1,count)`，与 `text-log.ts` 同源）。
3. `VARIABLE_LENGTH_ARRAY` **不换行**：ITPSDFINAL/ITPSDDETECT 的 1024 个采样挤在一条数据行上
   —— 这是 23 万行偏差的主因（原来一条一个元素）。
4. `FIXED_LENGTH_ARRAY` **不打计数也不换行**：CLOCKMODEL 的 `par`/`data` 留在数据行。
5. `%R`（RXCONFIG 嵌入记录）渲染成内嵌记录的 ABBREV：header 作为数据行上的值，body 行跟在后面；
   嵌入消息字典里没有的整条丢弃（b1 的 278 条 RXCONFIG 丢 22 条）。
6. **第二个计数数组另起一条数据行**（IPSTATUS：`<     1 ` / `<          ETHA …` / `<     1 ` / `<          "192.168.5.1"`）。
7. `%P`：计数 + 一个转义 token（合成 PASSCOM1 实测 `<     8 a,b*\\\x0d\x0a\x9c`）。

为此布局表加了 `arrayKind`（`field`/`fixed`/`variable`）——原来 JSON 分不出 `FIELD_ARRAY` 与
`VARIABLE_LENGTH_ARRAY`（两者都只是 `countSize:4`）。

### ③ D1：变长数组之后的段按实际消耗续排

`gen_edie_layouts.js` 新增 `dynamicOffset`：紧跟"长度要上线路才知道"的数组之后的段
（74 个 `FIELD_ARRAY`、57 个 `VARIABLE_LENGTH_ARRAY`、元素里带变长字符串的定长数组）打标，
`offset` 只保留旧的猜测值。实际打标 15 个段：`IPSTATUS.dns_server`、`INSCONFIG.ins_rotations`、
`SBAS17/26/27`、`USERI2C*` / `USERCAN*`。

`edie.ts` 抽出共享的"线路几何"：`stringWireSize`（变长字符串 = 文本 + NUL 补齐 4 字节，最少 4）、
`walkArray`（读计数、按**实际消耗**排下一个元素）、`segmentsWireSize` / `segmentWireSize`、
`denseSegmentSize`。`ascii-log.ts` 与 `abbrev-log.ts` 都用 `shift`（存储偏移漂移）+ `cursor`
（上一段真实结束处）两套指针，`dynamicOffset` 的段从 `cursor` 起排。

`IPSTATUSA` 因此读在 52 而不是 4。**已一致的三条没动**：ICOMCONFIG / SETNAV / DNSCONFIG 的变长
字符串都在顶层，仍走"存储偏移 + shift"，并加了测试断言这三张表 `dynamicOffset` 计数为 0。

### 复验（全部真跑，2026-11-01）

```
b2  ASCII         0 / 0 差异（905 行，4 931 973 B）
b2  ABBREV_ASCII  IDENTICAL 5 723 813 B   （修前 62 930 行 golden vs 57 623 行 ours）
b1  ABBREV_ASCII  IDENTICAL 5 738 549 B   （oracle 53 417 行；修前 229 605 行不同）
remote-23types ABBREV  IDENTICAL 4 357 514 B（42 106 行；用本机套件 --abbrev 现生成的 oracle 比对）
七份老 golden ASCII 全部 IDENTICAL：broad-clean 5 567 000 / clean-9600 489 205 /
  live-nav 2 798 307 / live-nav2 2 657 890 / remote-23types 3 845 232 / b1 5 088 882 / b3 6 137 463
测试 623 / 624（唯一失败是 graph-map.test.ts 期望的"本构建不是 Luciad"这句，属第 13 条正在改的
  并行工作，与本节协议改动无关）
```

### 剩余（都无样本，不做硬凑）

- **4 字节对齐没建模**：合成 `USERI2CREAD` 实测套件把 u32 计数放在 off=4、数组后的
  `request_length` 放到 12；我们的 dense 偏移 + `cursor` 会给 1 / 11。没有任何抓包含
  `USERI2C*` / `USERCAN*`，不影响任何 golden。
- **`%Z` 的变长数组**：`USERI2CREAD.slave_register_address` 套件打成一个 hex token
  （`deadbe`），我们现在一个元素一个十进制数。同样无抓包覆盖。
- **`#` 文本记录**：套件是"解析后按转换串重打"，我们是"CRC 校验后原样拷贝"；接收机自己写的
  记录两者相同（六份 golden 已证），只有人工构造的非规范格式才会分叉。
- **`$` + `$` 无 CRLF**：套件打印合并行（校验和对**第一个** `*` 算），我们到最后一个 `*`。
- **`<` 只有 header 没有 body** 时套件不输出，我们会打印一条空 body 记录。

## 9.x.11 ABBREV 也吃 pack(4) 与八种整数、`#…*crc` 按字节算（2026-11-01）

上一节把 ASCII 侧修好了，ABBREV 侧还留着同一批缺陷：b3 的 ABBREV 仍有 40 行不同
（GLOCLOCK 1、GALINAVEPHEMERIS 27、RAWGPSSUBFRAME 12），根因是 `abbrev-log.ts` 自己那份
`readScalar` 只认 4 种拼写、且没有 `wireFields` 的对齐修正。

- `ascii-log.ts` 的 `wireFields` 改为导出，`abbrev-log.ts` 在顶层
  `renderSegments(payload, wireFields(layout, payload.length), …)` 用它；
- `abbrev-log.ts#readScalar` 补齐 8 种整数拼写与 `int16/int32/bigint64/biguint64`，
  与 `edie.ts#readScalar` 同一张宽度表。

**复验**：b3 ABBREV `--abbrev` 现生成 oracle 79 143 行 / 7 116 268 B，与 ours **逐字节相同**
（修前 40 行不同）。b1/b2/live-nav/live-nav2 的 ABBREV 亦逐字节相同；八份 ASCII golden 全同。
golden-b3-20261101.ABBREV_ASCII 已入库，并加了一条测试断言整份文件。

### `#…*crc` 的校验和算在 UTF-8 上是错的

`novatelCrc32(new TextEncoder().encode(sentence))` 会把 `%c ≥ 0x80` 的一个字节编成两字节：
BESTUTM 的区字母 0xC8 应算 `C8`，实际算了 `C3 88`。套件对同一条记录给 `*a59003d5`，
`TextEncoder` 给 `4d302fbb`。

新增 `ascii-log.ts#latin1Bytes`（< U+0100 一字符一字节，≥ U+0100 退回 UTF-8），替换
`ascii-log.ts` 与 `text-log.ts` 里三处 `TextEncoder`。

**复验**（本机套件 `-a` 与我们的 CLI 对同一份合成抓包）：

```
3 条 BESTUTM，区字母 C8 / FF / 41
oracle 654 B  ours 654 B  两侧 SHA-256 相同
逐行 CRC  a59003d5 / 375f19a2 / c4355cf5  三行全 MATCH
```

仍有的同类问题：`packages/app/src/convert.ts`（GUI 的 Convert 预览）还按 UTF-8 写字符串、
不过滤 PASSTHROUGH(1342)，且不接文本记录与 RANGECMP 展开——它与 CLI 已经漂移，
是一条独立待办。
