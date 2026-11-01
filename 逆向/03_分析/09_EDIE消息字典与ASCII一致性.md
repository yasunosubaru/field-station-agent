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
  RAWGPSSUBFRAME / GLORAWEPHEM 覆盖。**→ §9.x.20 用合成 `#PASSCOM1A` / `<PASSCOM1` 记录补上了
  文本侧的 oracle（真机样本仍然没有）。**

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

## 9.x.12 B1 第四批（b4）：31 类 / 4100 行逐字节一致，**首次零改动**（2026-11-01）

前三批每批都要在 `ascii-log.ts` / `edie.ts` 里再修一条规则；这一批一行代码都没改，
31 个新类型的 ASCII 与 ABBREV 都一次对上。所以这节记的是**覆盖面**与**接收机实测**，
不是又一次修缺陷。

### 怎么抓的

`tools/remote/b4-probe.ps1`（探测）→ `tools/remote/b4-capture.ps1`（抓包）。探测共 97 个类型名，
一条 `LOG <名> ONCE`、单独一个 1.5 s 回复窗口，先分类再决定抓谁。

三条实测的运维事实，`b3-capture.ps1` 的注释里没有：

- **这个口的 20 Hz RANGE 流是永久的，`UNLOGALL` 清不掉。**
  `UNLOGALL`、`UNLOGALL USB2`、`UNLOG RANGEB` 之后各测 8 s，仍是 67.4 / 63.0 / 62.6 kB/s；
  2 s 窗口里稳定 41 条 RANGE、2 条 BESTPOS、1 条 RAWEPHEM，另外每 1.5 s 窗口各有 1 条
  RXSTATUS / PORTSTATS / HWMONITOR。
  之前记成"UNLOGALL 后还有 500 KB 积压"——其实不是积压，是每秒约 70 kB 的活流。
  后果有两条：探测时**不能**用"窗口里有没有字节"判断有没有数据（必须按报文 id 认，
  且要排除 41/42/43/93/72/963 这六个常在类型）；一个口 32 条 LOG 的预算也被它占掉几格，
  所以每次仍只挂 ≤10 条、每段前裸 `UNLOGALL`。第一版探测只排除了 41/42/43，
  于是 13 个"只有 93/72/963"的类型被误标成有数据，是逐条回看才纠正的。
- **PowerShell 里逐字节拼字符串会把探测拖死。** 第一版用 `$text += [char]$b` 做可打印化，
  170 KB 花了 17 s（O(n²)），69 条命令跑过 10 min 还没完，SSH 断了、远程进程还占着 COM10。
  现在先用 `[Text.Encoding]::GetEncoding(28591).GetString()` 一次性转成 1 字节 1 字符的串查
  `<OK` / `<ERROR`，再按字节扫长头。
- **`LOG` 名写错和"这款不支持"是两种错误**，接收机自己分得很清楚：
  `<ERROR:Invalid Message. Field = 2` = 名字根本不存在；`<ERROR:Message is invalid for this model`
  = 名字对、这台机器的固件选项没开。前一批把两者混在一起记，这批分开。

### 三类清单（97 个名字）

**收下并抓到（31 类，全部进 golden）**

| 类 | id | 条数 | | 类 | id | 条数 |
|---|---|---|---|---|---|---|
| LOGLIST | 5 | 1 | | SATVIS | 48 | 1 |
| DATUM | 160 | 1 | | AVEPOS | 172 | 1 |
| MAGVAR | 180 | 1 | | UNDULATION | 214 | 1 |
| MARKTIME | 231 | 1 | | GLOALMANAC | 718 | 1 |
| GALINAVRAWALMANAC | 1125 | 936 | | MARK1TIME | 1130 | 1 |
| TRACKSV | 1326 | 2 | | QZSSRAWSUBFRAME | 1330 | 36 |
| QZSSRAWEPHEM | 1331 | 180 | | QZSSEPHEMERIS | 1336 | 175 |
| QZSSRAWALMANAC | 1345 | 37 | | QZSSALMANAC | 1346 | 1 |
| QZSSIONUTC | 1347 | 1 | | AUTHCODES | 1348 | 1 |
| PPPPOS | 1538 | 1 | | PPPSATS | 1541 | 1 |
| PPPDOP2 | 1546 | 1 | | TERRASTARINFO | 1719 | 1 |
| VERIPOSINFO | 1728 | 1 | | RADARSTATUS | 1877 | 1 |
| PPPDOP | 1997 | 1 | | OCEANIXINFO | 2159 | 1 |
| BDSBCNAV2RAWMESSAGE | 2374 | 36 | | BDSBCNAV3RAWMESSAGE | 2411 | 35 |
| BDSBCNAV3EPHEMERIS | 2412 | 1050 | | PTPDELTATIME | 2465 | 1 |
| RXCONFIGUSER | 2474 | 244 | | | | |

另外 9 个名字是**已有类型**，只是用来复核探测链路（BESTXYZ / TRACKSTAT / IONUTC / GLOEPHEMERIS /
PSRPOS / PSRXYZ / TIME / CLOCKMODEL / ALMANAC），全部照常回数据。

**被拒（16 个，一个字节都没进 golden）**

- `<ERROR:Message is invalid for this model`（9 个，固件选项没开）：
  `RTKPOSB` `RTKVELB` `MATCHEDPOSB` `RTKXYZB` `RTKDOPB` `RTKSATSB` `RTKASSISTSTATUSB`
  `TILTSTATUSB` `MARK1PVAB`。RTK 系与 SPAN 系均属此列——这台 OEM729 没有对应授权。
- `<ERROR:Invalid Message. Field = 2`（7 个，名字不存在）：`GPSEPHEMERISB`（字典里的名字是
  `GPSEPHEMB`，b1 已有）、`SBASRAWB`、`NAVSSATBITSB`、`ABSSATEPHEMERISB`、`SBAS45B`、
  `LBANDINFOB`、`RAWLBANDFRAMEB`。**本批建议清单里的 GPSEPHEMERISB / SBASRAWB /
  NAVSSATBITSB / ABSSATEPHEMERISB 四个名字在这台接收机与字典里都不存在**，`SBASRAW` 对应的是
  `RAWSBASFRAME`，`ABSSATEPHEMERIS` / `NAVSSATBITS` 连字典都没有——不是没抓到，是没有这个日志。

**不出（41 个：`<OK` 收下，30 s 一条不来）**

- 缺输入条件：`MATCHEDXYZB` `MASTERPOSB` `ROVERPOSB` `HEADINGB` `HEADING2B` `HEADINGEXTB`
  `HEADINGRATEB` `MARK2TIMEB` `MARK3TIMEB` `MARK4TIMEB` `MARK2POSB` `MARK3POSB`
  `USERDATUMB` `THISANTENNATYPEB` `BASEANTENNATYPEB` `ANTENNATYPEB` `SAVEDSURVEYPOSITIONSB`
  `SURVEYPOSITIONB` `PROFILEB` `PROFILEINFOB` `NAVICALMANACB` `NAVICSYSCLOCKB` `NAVICEPHEMERISB`；
- 这台机器的固件不解这些信号：`GALFNAVEPHEMERISB` `BDSBCNAV1EPHEMERISB` `BDSBCNAV1RAWMESSAGEB`
  `GALINAVRAWWORDB` `GALFNAVRAWPAGEB` `GALFNAVRAWEPHEMERISB` `GALFNAVRAWALMANACB`
  `GALCNAVRAWPAGEB` `RAWCNAVFRAMEB` `GPSCNAVRAWMESSAGEB` `QZSSCNAVRAWMESSAGEB`；
- 没有 SBAS 星：`RAWSBASFRAMEB` `RAWSBASFRAME2B` `SBAS17B` `SBAS3B` `SBAS25B` `SBAS26B` `SBAS27B`。

其中 `GALFNAVEPHEMERISB` / `BDSBCNAV1EPHEMERISB` 仍挂在周期组里（一条 LOG 而已），
哪天真出数据就直接进 golden；测试里有一条断言"这两个 id 至今不在抓包里"。

### 结果：4100 / 4100，ABBREV 92397 / 92397，零改动

```
b4-20261101.sbf              4 140 243 B   4 210 条记录（4 119 二进制 + 91 条文本 / <OK 回显）
golden-b4-20261101.ASCII     7 646 463 B   4 100 行   SHA-256 DF40712F208FBA4B…D16DABCEB
  ours                       7 646 463 B   4 100 行   逐字节相同（cmp-lines：0 / 0）
golden-b4-20261101.ABBREV_ASCII  8 725 124 B  92 397 行  逐字节相同（0 / 0）
4119 - 19（RXCONFIGUSER 里裹二进制记录的那 19 条）= 4100
```

回归（`convert.ts --to ASCII` 后比 SHA-256）：六份老 golden 全部 IDENTICAL——
b1 5 088 882 / b2 4 931 973 / b3 6 137 463 / remote-23types 3 845 232 / live-nav 2 798 307 /
live-nav2 2 657 890。`node --test --test-force-exit "packages/*/test/*.test.ts"`：**704 / 704 全绿**
（本批新增 `live-b4.test.ts` 6 条 + `convert-pipeline.test.ts` 表里 b4 两行）。

### 这批新覆盖到的三个形状

1. **`%R`（嵌入记录）** —— `RXCONFIGUSER`（2474）的 payload 是一个 `VARIABLE_LENGTH_ARRAY`，
   里面裹一整套 `#...*crc` 命令记录。244 条里 **225 条**展开成一行
   `#RXCONFIGUSERA,…,18278;#LOGA,…,18278;USB1,RXSTATUSEVENTA,ONNEW,0.000000,0.000000,HOLD*27f1eda4*f5d880fe`
   —— **外层 CRC 覆盖展开后的内层记录**（`*f5d880fe` 不是内层的 `*27f1eda4`）。
   另外 **19 条** payload 开头是长头 `AA 44 12 1C`，里面**正好裹一条完整的二进制记录**
   （长度 `28 + payloadLen + 4` 全等），id 依次是 817 / 1436 / 1464 / 1524 / 1525 / 1552 /
   1555 / 1606 / 1790 / 1799 / 1856 / 1857 / 1860 / 1870 / 1871 / 229（4 条）——**这 19 个 id
   没有一个是 608 条消息字典里的**，它们是接收机的配置类报文，套件的字典不渲染，
   `%R` 打不出来就**整条丢弃**。套件自己的 Summary 写着 `RXCONFIGUSER 244 in / 225 out`，
   我们丢的正好是同 19 条——这一条是"丢对了才算一致"的样本。
2. **顶层 `VARIABLE_LENGTH_ARRAY` 长串** —— `LOGLIST`（5）一行 **3 174 字符 / 367 个逗号段**，
   把当时所有端口的 LOG 列表整个打出来；`GALINAVRAWALMANAC`（1125）一次 `ONCE` 回 26 条
   （每星一条），`BDSBCNAV3EPHEMERIS`（2412）1 Hz 时每秒 30 条。
3. **带引号 STRING 里的逗号** —— `AUTHCODES`（1348）第 4 个字段是
   `"R35JCN,BTG98D,R4DD6P,5PCR7N,9WPP25,PFNLYNTBN"`，按逗号切是 10 段而字段只有 4 个；
   `PTPDELTATIME`（2465）18 个字段混排 INT / ULONG / SHORT / DOUBLE / ENUM；
   `QZSSRAWSUBFRAME`（1330）的 30 字节 `%Z` 打 60 个十六进制字符。
   另有一处巧合可以当前后一致的探针：本包里 `MARKTIME`(231) 与 `MARK1TIME`(1130) 的 payload
   完全相同，两个布局若有一个偏移错了，值就会分叉。

### 为什么这批不需要改代码

上一批修的三条都是"总规则"，不是逐类型补丁：`pack(4)` 对齐（在 payload 长度证明时才启用）、
八种整数拼写（`SHORT`/`USHORT`/`INT`/`UINT`/`ULONG`/`ULONG64`/`LONGLONG`/`UCHAR`）、
三种数组形态（`FIELD_ARRAY` / `FIXED_LENGTH_ARRAY` / `VARIABLE_LENGTH_ARRAY`，含元素内变长字符串的
实际消耗续排）。这一批 31 个布局正好把这三条各踩了一遍（PTPDELTATIME 的混排宽度、
LOGLIST 的顶层变长数组、RXCONFIGUSER 的 `%R`），一条也没破——说明那三条是规则而非巧合。

### 剩余（无样本，不做硬凑）

- **41 个 `<OK` 但不出数据的类型**：RTK / SPAN / 双天线需要固件授权（被拒的那 9 个同理），
  GAL F/NAV、BDS B1C/B2a、NavIC、SBAS 页面这台机器不解码或不收星。要覆盖只能换机器或换固件。
- **`%R` 的多记录 payload**：本包的 244 条都是一条记录裹一条命令；如果哪天 payload 里裹多条
  （`#…` 之间用 `;` 连成一串也算一条），`renderSegments` 的 `%R` 分支还没被测到。
- **`USERDATUM` / `*ANTENNATYPE` / `SURVEYPOSITION`** 类"配置了才有内容"的日志，接收机是默认
  配置，永远回空——布局有、样本永远不会有。
- **USB2 那条 20 Hz RANGE 流为什么 `UNLOGALL` 清不掉，仍然不明**：不是本轮代码问题，
  但下次抓包前要么先接受它（像这次一样按 id 排除），要么先查接收机的 `LOGLIST` 输出确认
  这 41 条 RANGE 到底挂在哪个端口的日志表上（`LOGLIST` 本包已抓到，可离线看）。



## 9.x.13 B1 第五批（b5）：20 类新类型 + **三种压缩测距版本**，1478 行逐字节（2026-11-01）

这一批和前四批不一样：前四批是「加布局、加渲染」，这批撞上的是**套件对本项目还没解过的
三种报文做了转译**（`RANGECMP` v1 / v3 / v5 全部解压成 `RANGE` 行），外加两条此前记错的
规则（`PASSTHROUGH` 其实照常输出、ABBREV 里嵌套数组要多缩 5 列）。所以这篇记的是
**六条规则修正 + 覆盖面**。

### 怎么抓的

`tools/remote/b5-probe.ps1`（探测）→ `tools/remote/b5-capture.ps1`（抓包，五段、每段前裸
`UNLOGALL`）。探测名单不再靠猜，按「608 条字典 − 已进 golden 的 97 个名字」直接生成，
再按下面两条筛掉不值得占配额的名字：

- **字典里没有的名字不探测。** 上一批的建议清单里，`FANSPEED` / `TEMPERATURE` / `PWRSTATUS` /
  `SUPERSWSTATUS` / `BLOBSTATUS` / `TIMEH` / `PPSTIME` / `PPSSTATUS` / `TRACKSTAT2` 九个
  **在 608 条 EDIE 字典里一条都没有**，接收机就算回数据也不可能进 golden（套件按字典渲染）。
  HWMONITOR（已有）本来就是这台机器的风扇/温度出口。这九个名字直接从名单里划掉，省下 9 个
  1.5 s 窗口。
- **上一批已被拒的名字不再重试**（b4 拒掉的 16 个：RTK 系 6 个、SPAN/双天线 3 个、
  名字根本不存在的 7 个），只留 `FILESTATUS`、`LBANDINFO` 这类「上批没单独试过」的。

最终 72 个名字，一条 `LOG <名> ONCE`、单独 1.5 s 窗口、按报文 id 判（41/42/43 与
93/72/963 一律不计，理由见 §9.x.12）。

### 三类清单（72 个名字）

**收下并抓到（25 个名字；20 类真的吐出 ASCII 行，5 类解压成 `RANGE` 行）**

| 类 | id | 条数 | | 类 | id | 条数 |
|---|---|---|---|---|---|---|
| CLOCKSTEERING | 26 | 1 | | RXSTATUSEVENT | 94 | 2 |
| VALIDMODELS | 206 | 1 | | COMCONFIG | 317 | 1 |
| **PDPPOS** | 469 | 9 | | **PDPVEL** | 470 | 9 |
| **PDPXYZ** | 471 | 9 | | RANGEGPSL1 | 631 | 12 |
| GALINAVRAWEPHEMERIS | 1126 | 216 | | CHANCONFIGLIST | 1148 | 1 |
| PDPSATS | 1234 | 9 | | SOFTLOADSTATUS | 1235 | 1 |
| **PASSTHROUGH** | 1342 | 1 | | VERIPOSSTATUS | 1730 | 1 |
| GEODETICDATUMS | 2296 | 1 | | DATUMTRANSFORMATIONS | 2298 | 1 |
| PSRDATUMINFO | 2300 | 1 | | BESTGNSSDATUMINFO | 2302 | 1 |
| BESTDATUMINFO | 2305 | 1 | | BDSBCNAV3RAWMESSAGE2 | 2520 | 8 |
| **RANGECMP**（v1） | 140 | 13 | | **RANGECMP2** | 1273 | 13 |
| **RANGECMP3** | 1734 | 12 | | **RANGECMP4** | 2050 | 12 |
| **RANGECMP5** | 2537 | 12 | | | | |

四种 `PDP*` 是这次最划算的一笔：`PPPPOS` 在上批就有，同一个 PPP 引擎的 PDP 系列一次性全回
（`PDPPOS` 21 字段、`PDPXYZ` 28、`PDPSATS` 105、`PDPVEL` 8），而 `PDPDOP` / `PDPDOP2` /
`PDPDATUMINFO` 三个是 `<OK` 但不出（见下）。

**被拒（26 个，一个字节都没进 golden）**

- `<ERROR:Message is invalid for this model`（25 个，固件选项没开）：
  `SATELSTATUSB` `SATEL4INFOB` `SATEL9INFOB` `FILELISTB` `FILESTATUSB`
  `FILESYSTEMSTATUSB` `FILESYSTEMCAPACITYB` `FILETRANSFERSTATUSB` `LUASTATUSB`
  `LUAFILELISTB` `LUAFILESYSTEMSTATUSB` `INSDATUMINFOB` `ITFILTTABLEB` `ITBANDPASSBANKB`
  `ITPROGFILTBANKB` `TSS1B` `INSVELXB` `INSPVAXB` `INSCONFIGB` `INSSTDEVB` `HEAVEB`
  `TILTDATAB` `WIFISTATUSB` `WIFINETLISTB` `EXTERNALPVASB`。
  两点值得记：**整个存储/文件系统族（FILE\*、LUAFILE\*）和整个 SPAN 族、整个 Wi-Fi 族都是
  模型级被拒**，不是名字写错；干扰检测族里 `ITDETECTSTATUS` 能用而 `ITFILTTABLE` /
  `ITBANDPASSBANK` / `ITPROGFILTBANK` 三个表被拒——这台机器的固件只输出检测结果，不输出
  滤波器表。
- `<ERROR:Invalid Message. Field = 2`（1 个，名字不存在）：`LBANDINFOB`。**`LBANDTRACKSTAT`
  能出、`LBANDINFO` 这个名字接收机不认**，尽管 EDIE 字典里有它——字典有 ≠ 接收机有
  （与上一批 `RAWLBANDFRAMEB` 同理）。

**不出（21 个：`<OK` 收下，1.5 s 窗口一条不来）**

`MODELB` `AUTHB` `PDPDATUMINFOB` `RTKDATUMINFOB` `USERANTENNAB` `USERDATUMB` `GALCLOCKB`
`GLORAWFRAMEB` `GLORAWSTRINGB` `REFSTATIONINFOB` `SAVEDSURVEYPOSITIONSB` `USERCANSTATUSB`
`USERCANDATAB` `QZSSCNAVRAWMESSAGEB` `GPSCNAVRAWMESSAGEB` `GALCNAVRAWPAGEB`
`GALHASRAWMTB` `PDPDOPB` `PDPDOP2B` `PROFILERESPONSEB` `HEADINGB`。

其中 `GALCLOCKB` / `GLORAWFRAMEB` 值得单独说：**Galileo 和 GLONASS 的星历这两批一直在进
golden（`GALEPHEMERIS`、`GLOEPHEMERIS`、`GLOALMANAC` 都有），但这两个时钟/原始帧日志就是
不出**——不是没星，是这台机器的固件不解这些信号。

### 这批逼出的五条规则（第一遍 38 行不对 → 0）

#### ① `RANGECMP`（v1，id 140）从来没有解压过（13 条 → 13 行 `RANGE`）

前两批只实现了 `RANGECMP2` / `RANGECMP4`，`RANGECMP` v1 一直当**自己的类型**打。这一批的
summary 直接暴露了它：`RANGE 1050 in / 1112 out`，多出的 **62 行正好等于 13+13+12+12+12**，
而五个 `RANGECMP*` 自己的输出列全写 `0`。也就是说 Convert 把**五个版本全部**解压。

v1 是五个版本里唯一「不压缩结构」的：`ULONG #obs` + 每条 **24 字节定长**记录（Table 186），
十个 RANGE 字段全在记录里，连 `c_status` 都是原文，不需要像 CMP2/4 那样合成状态字。两条
派生物是重点：

- **表头是「观测条数」不是「字节数」**。第一版照抄 CMP2/4 的 `declared` 当字节数切载荷，
  每条记录只剩 2 个观测（69 → 2），`#RANGEA` 行的第一个字段就露馅了。
- **`adr` 要按信号自己的波长做 roll 还原**。Table 186 的公式是
  `ADR_ROLLS = round((PSR / WAVELENGTH + ADR) / 8388608)`、`CORRECTED = ADR − 8388608 × ROLLS`。
  波长用错（把 L2 观测按 L1 波长算）时，同一颗星的两条记录的 roll 数会差 2~10 个，
  误差正好是 16 777 216 的整倍数——b5 的 897 个观测里，用对波长后 **897/897** 与 golden 相同
  （`-91298527.250000` 这种 6 位小数值逐个对上）。
- `sd_psr` 走 **Table 187**（0.050 / 0.075 / 0.113 …），不是 CMP2/4 的 Table 190/204：
  同一个观测 v1 打 `0.050`、CMP2 打 `0.045`，这是两张表，不是同一张表的两个舍入。

#### ② `RANGECMP3`（1734）的载荷与 `RANGECMP4`（2050）**逐字节相同**

OEM7 手册里没有 RANGECMP3 的表（§3.160/3.161/3.162/3.163 是 v1/v2/v4/v5），所以先做了
一条实测：把 b5 里 12 条 1734 与 12 条 2050 按 epoch 配对，**载荷 866 B × 12 全部
`Buffer.compare === 0`**，解码出来的观测值也全等。两者唯一的差别在**报文头的 reserved 字段**
（1734 是 `12097`、2050 是 `64270`），而 ASCII 行里那个位置正是 `<…,2f41,18278>` 与
`<…,fb0e,18278>` 的差别——也就是「同一行数据、不同的回显字段」。

结论：**1734 直接用 v4 的读取器**，这不是猜，是 12/12 的字节相等。风险写在 `rangecmp.ts`：
哪天遇到载荷不相等的 1734，就该退回来重新做表。

#### ③ `RANGECMP5`（2537）自成一派：5 bit 标准差 + m/s 多普勒（12 条 → 12 行的 828 个观测）

v5 不是 v4 的变体而是另一套结构（§3.163，Table 205–213）：16 bit GNSS 掩码 → 每系统
64 bit 卫星掩码 + 16 bit 信号掩码 + `m×n` 关联矩阵 → 每星一个 4 bit（GLONASS 9 bit）头 →
每信号一个主块（115 bit）或差块（86 bit）。三处和别的版本不同、且**都有实测**：

1. **多普勒是 m/s（0.0001），不是 Hz**；转成 RANGE 的 Hz 要除该信号自己的波长（与 v4 同一
   条公式），12 条记录 828 个观测的 `dop` 全对。
2. **`sd_psr` / `sd_adr` 是 5 bit**，走 Table 213 / Table 212 的指数式（不是查表）：
   `0.020·exp(0.4x)` / `(1/256)·exp(x/(3.65√3))`。所以同一观测 v5 打 `0.014`（x=8 → 0.01385）、
   v4 打 `0.016`（index 5）——**两张不同的标尺**，不是同一个 index 的两种舍入。
3. **差块的多普勒步长是 0.0001 m/s，手册写的是 0.0002**。按手册写时，460 个差块观测里
   424 个的 `dop` 差 0.002–0.13 Hz（例如 `1298.433` vs golden 的 `1298.359`）；按 0.0001
   写全对。手册那一栏的范围 `±6.554`（=2¹⁵×0.0002）与实测矛盾，实测优先。

`c_status` 与 v2/v4 一样是合成的（Table 182 的跟踪状态 4/11、分组位、信号类型码），
v5 的块里只有 parity / half-cycle 两个标志，其余沿用 v4 的合成规则，828 个观测的字全对。

#### ④ `ADR Std Dev` 的 index 0 是 **0.003**，不是 Table 203 的 0.0039

把 ①②③ 都接上后，整份文件只剩 **2 行**不对，而且是同一个观测（epoch 17142，BeiDou B2B_I，
两条压缩记录各一条）：`sd_adr` 我们打 `0.004`、golden 打 `0.003`。把 12 条 2050 记录里
`index → golden` 的对应全部统计出来是：

```
0→0.003  1→0.005  2→0.007  3→0.009  4→0.012  5→0.016  6→0.022  7→0.029  8→0.039
```

除 index 0 之外全部等于 Table 203 的印刷值（5、7 两个是 §9.x.11 已经订正过的
0.0165/0.02947）。index 0 的 Table 203 写的是「≤ 0.0039」——**它是上界，不是代表值**，
套件自己的表用了一个更小的数（打印 0.003）。改成 0.003 后整份文件 **0 / 0**。
这条只影响 index 0，b1–b4 里没有一条 v4 观测落在 index 0（改前改后四份 ASCII 全部逐字节不变，
见下面的回归）。

#### ⑤ `PASSTHROUGH`（1342）其实**照常输出**，之前的「写不出任何东西」是错的

前四批一直记着「`PASSTHROUGH` 不产出任何东西，连 BINARY 都不复制」，`convert-pipeline.ts`
里还有一条 `if (isPassthrough(frame)) return;`。这一批第一次抓到**真的** `PASSTHROUGH`
（epoch 17024.106，端口 COM3，80 字节），套件给出的行是：

```
#PASSTHROUGHA,SPECIAL,0,73.5,COARSESTEERING,2443,17024.106,03801800,5fa3,18278;COM3,80,_\x9f\xef\xff\xac…
```

即：端口名（enum，0 是 `NOPORT`）+ 字节数 + `%P` 转义载荷（可打印字节原样，其余 `\xnn`，
`\` 双写）。summary 里也照常记 `1342 … 1 in / 1 out`，BINARY 也复制它。

为确认这不是「只有真记录才输出」，又拿 b2 的 BESTPOS 载荷改 id 成 1342 造了一条合成记录
（端口 0、count = 载荷第 5 字节 = 16），本地套件 `-a` / `-b` 各跑一遍：**ASCII 与 BINARY 都
输出**（`#PASSTHROUGHA,…,;NOPORT,16,\xf8\xf8T];\x8a>@…`）。所以旧结论不是「形状特殊」，
就是记错了 —— 当时大概是看了 GUI 预览或 summary 的某一路，把"视图不解析"当成了"Convert 不写"。

改动：删掉 `isPassthrough` 的过滤，`converted` 回到「全部二进制记录」，summary 与 BINARY 都
跟着恢复；`passthrough` 字段留着只作统计用途（CLI 会打一行提示）。

#### ⑥ ABBREV 里**嵌套数组再多缩 5 列**

`CHANCONFIGLIST`（1148）是第一个把数组放在数组元素里的日志：外层 `chan_cfg_list_array`，
每个元素又是一个 `chan_cfg_list_sys_array`（`num_chans` + `signal_type`）。ASCII 一行打完，
ABBREV 却按层缩进：

```
<     1 5                                    ← 数据行：< + 4 空格
<          5                                 ← 第一层元素：9 空格
<               16 GPSL1L2PL5                ← 第二层元素：14 空格
<               7 QZSSL1CAL2CL5
```

原来的实现把每一层都固定用 9 空格，于是 25 行差 5 列。改成 `4 + 5 × 层数`
（第一层 9、第二层 14，数据行 4）后，81 561 行 ABBREV 一次对上。

### 结果：1478 / 1478，81561 / 81561

```
b5-20261101.sbf              3 357 697 B   1 565 条记录（1 478 二进制 + 87 文本 / <OK 回显）
golden-b5-20261101.ASCII     6 354 933 B   1 478 行   SHA-256 5F169C9032BAA621…315E81FB
  ours                       6 354 933 B   1 478 行   逐字节相同（cmp-lines：0 / 0，SHA 相同）
golden-b5-20261101.ABBREV_ASCII 7 372 489 B 81 561 行 逐字节相同（0 / 0，SHA 相同）
RANGE 1050 → 1112（62 条压缩记录各 +1 行）；五个 RANGECMP* 自己都是 N → 0
```

`#RANGEA` 行数 1 112，`#RANGEGPSL1A` 12 行（名字以 RANGE 开头但是另一条日志，别用
`grep '^#RANGE'` 数 RANGE）。

### 回归

七份老 golden（`convert.ts --to ASCII` 后比 SHA-256）全部 IDENTICAL：
b1 5 088 882 / b2 4 931 973 / b3 6 137 463 / b4 7 646 463 / remote-23types 3 845 232 /
live-nav 2 798 307 / live-nav2 2 657 890；b1–b4 的 `--abbrev` 四份也全部 IDENTICAL
（`PASSTHROUGH` 与 ABBREV 缩进两处改动**没有**动到老样本，因为老样本里既没有 1342，
也没有嵌套数组）。
`node --test --test-force-exit "packages/*/test/*.test.ts"`：**721 / 721 全绿**
（本批新增 `live-b5.test.ts` 9 条 + `convert-pipeline.test.ts` 表里 b5 两行；
`PASSTHROUGH` 的两条旧断言按新事实改写）。

### 这批的交叉验证（不用 oracle 也能自查）

五个压缩版本在 b5 里覆盖**同一批卫星、同一批 epoch**，所以解出来的观测集合应该一致：

| 版本 | 记录 | 观测 | 系统分布（Table 182 码） |
|---|---|---|---|
| v1 (140) | 13 | 897 | GPS 312 / BeiDou 468 / QZSS 117 |
| v2 (1273) | 13 | 897 | 同上 |
| v3 (1734) | 12 | 828 | GPS 288 / BeiDou 432 / QZSS 108 |
| v4 (2050) | 12 | 828 | 同上 |
| v5 (2537) | 12 | 828 | 同上 |

PRN 集合也完全一样（1,2,3,4,6,7,9,10,12,16,19,20,23,25,26,28,29,31,32,37,194,196,199）。
四个不同年代的压缩算法 + 两套不同的标尺给出同一批观测，任何一个偏移错半位都会立刻分叉 ——
这比逐字段比对更狠。

### 剩余（无样本，不做硬凑）

- **`RANGECMP4` / `RANGECMP5` 的差分块没用例**：b5 的 24 条 v4/v5 记录全部是 Reference
  （`Data format flag = 0`，整秒时刻），Table 199/200 的差分路径仍只有表、没有 golden。
- **v5 只走通 GPS / BeiDou / QZSS 三个系统**：2537 的 GNSS 掩码是 `0x00C1`，GLONASS、SBAS、
  Galileo 三支（含 GLONASS 的 9 bit 头）没有样本；v1 同理（它的 `c_status` 里也没出现 GLO/SBAS）。
- **被拒/静默的 47 个名字**（存储族、SPAN 族、Wi-Fi 族、NavIC 族、GAL F/NAV 与 BDS B1C 族）
  只能换机器或换固件；`SATEL*` 系列连这台机器都不支持。
- **ABBREV 里第三层嵌套**仍无样本：现在是按「每层 +5」外推的，`CHANCONFIGLIST` 只到第二层。
- **USB2 那条 20 Hz RANGE 活流为什么 `UNLOGALL` 清不掉，仍然不明**（同 §9.x.12），
  这一批继续按 id 排除（41/42/43）。
- 同一个合成 `PASSTHROUGH` 在**视图**里（GRIT/Playback 的报文列表）怎么显示，本轮没测；
  Convert 三路（ASCII / ABBREV / BINARY）都已对上。

## 9.x.14 残余六项：`pack(4)` 计数数组、`%Z` 变长数组、64 位整数、`#` 重打、`$`+`$` 合并、`<` 空体（2026-11-01）

这一节和前面所有节的区别：**没有任何真机样本**，也没有 COM 口可用（COM10 由别人占着）。
六件事全靠「合成帧 + 本机套件 2.11.0 的 Convert 当 oracle」逐字节反推。

做法固定：用 `packages/protocol/data/edie-layouts.json` 的布局拼 payload → `buildLongHeader` +
`appendCrcLe` 封成二进制帧 → 写成纯 ASCII 路径的 `.sbf` → 调

```
NovAtelApplicationSuite.exe -a        -o <纯ASCII目录> <输入>
NovAtelApplicationSuite.exe --abbrev  -o <纯ASCII目录> <输入>
```

→ 读它写的 `ASCII/<名>.ASCII`、`ABBREV_ASCII/<名>.ABBREV_ASCII` → 和我们 `convertFrames` 的输出
逐行比。Convert 对「从未见过的帧」一样照转，这就是 oracle。工具全在 `逆向/tools/`：

| 工具 | 作用 |
|---|---|
| `oracle.ts` | 造帧 / 跑套件 / 读输出（公共件） |
| `oracle-pack4.ts` / `oracle-pack4b.ts` | ①②：`USERI2CREAD` / `USERCANDATA` 的对齐与 `%Z` |
| `oracle-64bit.ts` | ③：`%llu` / `%lld` |
| `oracle-text.ts` / `oracle-hash.ts` | ④⑥：`#` 重打与 `<` 空体 |
| `oracle-nmea.ts` / `oracle-nmea2.ts` | ⑤：`$`+`$` 合并 |
| `oracle-strlen.ts` | 变长 `%s` 到底截不截断 |
| `oracle-sweep.ts` | 15 个「dense ≠ packed」的定长布局逐个过 oracle |
| `oracle-verify.ts` | 六项一次性端到端比对（退出码 0 = 全一致） |
| `oracle-regress.ts` | 任一份抓包 + 任一格式，套件 vs 我们，字节 + SHA |
| `golden-check.ts` | 8 份 ASCII + 6 份 ABBREV golden 的字节数与 SHA |

### ① `pack(4)` 不再「自证才启用」

旧规则：只有「布局 dense 尺寸 ≠ packed 尺寸」**且**「这一帧 payload 长度正好等于 packed 尺寸」时才
按 4 对齐改写偏移。那是拿样本当开关，不是规则——Convert 读字段用的是**固定偏移**，它没法因为
payload 长短换一套。

新规则（`edie.ts#segmentAlignment` / `packedSegmentSize` / `packedStructSize`，
`ascii-log.ts#wireFields`）：

| 成员 | 对齐 |
|---|---|
| `UCHAR`/`CHAR`/`HEXBYTE`（1 B） | 1 |
| `USHORT`/`SHORT`（2 B） | 2 |
| `ULONG`/`LONG`/`UINT`/`FLOAT`/`DOUBLE`/`ULONG64`/`LONGLONG`（≥4 B） | 4 |
| `STRING`（含 `%Z`） | **1** |
| 数组 | 有 `ULONG` 计数前缀→4；否则同首元素 |

**没有尾部补齐**：`GLOCLOCK` 的 payload 是 61 B（`sizeof` 若补尾部会是 64），`RAWEPHEM` 是 102 B
（它三个 `%Z` 是 `char[30]`，对齐 1，所以 dense 本来就对）。这两个长度与 §2 里用真机 payload
验证过的 61 / 102 一致，只是现在知道了原因。

改写只做「定长前缀」，遇到**宽度不可知**的段（带计数的数组、`variable` 字符串）就停：该段自己
仍按 4 对齐，它后面的段保持 dense 偏移，交给写者里的 `shift`/`cursor` 续排。原因是实测出来的：

```
USERI2CREAD：slave_device_address u8@0、寄存器数组（dense 说 count@1）、request_length dense@5
             套件读 count@4、元素@8、request_length@align4(8+n)、transaction_id 再 +4
SURVEYPOSITION：option@0、id(变长, 声明 5)@4、latitude dense@9
             id 里放 "abc\0"（4 B）→ 套件把 latitude 打在 8 = 9 + (4 − 5)
```

也就是说「对齐后的偏移」和「dense 偏移 + 实测漂移」是两套坐标，混用就会差一字节（我们第一版
先改成 `9 → 12` 再让 shift 减 1，读出 11，double 读歪）。所以分界线就是「第一个宽度不可知的段」。

**证据数字**（`oracle-verify.ts`，退出码 0）：

| 合成帧 | 套件与我们的同一行 |
|---|---|
| `USERI2CREAD`，256 个寄存器 | `…;42,256,<512 字符 hex>,2,287454020*c119ee8e` |
| `USERI2CREAD`，257 个寄存器（8+257=265→268） | `…;42,257,<514 字符 hex>,7,4660*2d992574` |
| `USERI2CREAD`，0 个寄存器 | `…;42,0,,7,4660*c47be5b5` |
| `USERCANDATA`，3 字节（16+3=19→20） | `…;UNKNOWN,UNKNOWN,00000123,3,deadbe,00000055,102*fad65d3b` |
| 同上，ABBREV | `<     UNKNOWN UNKNOWN 00000123 3 deadbe 00000055 102`（**一条数据行，不拆元素行**） |

**15 个定长布局逐个过 oracle**（`oracle-sweep.ts`：payload 用 `(i*37+11)&0xff` 的确定性图案，
长度取 packed 尺寸；`variable` 字符串位写 `abc\0` 终止）：

| id | 名字 | dense | packed |
|---|---|---|---|
| 25 | RAWGPSSUBFRAME | 46 | 48 |
| 259 | GPGGARTK | 53 | 56 |
| 477 | SOFTLOADSREC | 519 | 520 |
| 719 | GLOCLOCK | 57 | 61 |
| 973 | RAWSBASFRAME | 45 | 48 |
| 977 | SBAS1 | 35 | 36 |
| 981 | SBAS18 | 46 | 48 |
| 1132 | HEADINGEXT | 100 | 102 |
| 1330 | QZSSRAWSUBFRAME | 42 | 44 |
| 1889 | INSPVACMP | 44 | 48 |
| 1890 | INSPVASDCMP | 35 | 40 |
| 1952 | SURVEYPOSITION | 41 | 44 |
| 2093 | WIFIAPSETTINGS | 136 | 138 |
| 2213 | WIFINETCONFIG | 174 | 176 |
| 2528 | PROFILERESPONSE | 330 | 333 |

15/15 在 packed 长度上 ASCII 与 ABBREV 都逐字节一致。`live-b3.test.ts` 里原来那条
「只有 payload 自证时才补」的用例改成了「无论如何都补」，并保留 38 B 那种越界情形读 0 的断言。

### ② `%Z` 变长数组：一个 hex token

`VARIABLE_LENGTH_ARRAY` + `%Z`（`USERI2CREAD.slave_register_address`、`USERCANDATA.received_data`
一类）**打成一个 token**，不是每个元素一个十进制：

- 计数照打（`%u`），然后一个**小写** hex 串，每元素两字节；
- **计数为 0 时仍然打一个空 token** —— 于是行里出现 `,,`：`…;42,0,,7,4660*c47be5b5`；
- ABBREV 里同样是一条数据行：`<     42 0  7 4660`（空 token 留下两个空格）。

`decodeEdie`（视图 / RINEX 那一路）同步成一个 hex 值，不是 N 个字节。

### ③ `ULONG64` / `LONGLONG`：真的 64 位

宽度旧代码是对的（8 B），错的是**格式**：`Number(getBigUint64())` 过一遍 double，
`9007199254740993`（2^53+1）会打成 `9007199254740992`，`18446744073709551615` 会打成
`18446744073709552000`。现在 `readScalar` 对 `longlong`/`ulonglong` 直接返回 `bigint`，
`formatField` 对 `%llu`/`%lld` 走 `BigInt`（文本记录里的 token 也按 `BigInt()` 回读）。

顺带记一个坑：`parseFormat('%llu')` 的 `(l{0,2})` 抓的是 `ll`、`([A-Za-z]{1,2})` 抓的是 `u`，
所以 `spec` 永远是 `u`/`d`；判长度只能看 `length === 'll'`。老代码 switch 里的
`case 'llu': case 'lld':` 是**永远走不到**的死分支。

`FILESYSTEMCAPACITY`（真机拒发这条，oracle 照转）与 `INSPVACMP` 的实测：

```
5,USBSTICK,0,1,RAMDRIVE,1,2,DEFAULT_NO_STORAGE,4294967296,4294967297,
INTERNAL_FLASH,9007199254740993,9007199254740994,UNKNOWN,18446744073709551615,0     *f33c5611
…,0,0,0,-9007199254740993,1,-2,…                                                  *7fef7060
…,0,0,0,-9223372036854775808,1,-2,…                                               *4ff227fc
```

### ④ `#…*crc` 是**重打**，不是原样拷贝

把一条 `#BESTPOSA` 写成不规范形状（idle time `72.00`、`64.82390`、头里 `007`/`02442`/
`570228.0`/`3800800`/`CDBA`），套件回来的是**规范行**，CRC 也是新的：

| 输入 | 输出 |
|---|---|
| idle `72.00`、`30.539973063660`、`64.82390` | `72.0`、`30.53997306366`、`64.8239`，`*8820f06a` |
| 头 `007,72.00,02442,570228.0,3800800,CDBA` | `7,72.0,2442,570228.000,03800800,cdba`，`*eb08b1e3` |
| body 末尾多两个 token（`,99,88`） | 多出来的**不打印**，同一行 `*8820f06a` |
| body 少两个 token（`,30,03` 少 `0,03`） | **整条丢**，ASCII 与 ABBREV 都不出行 |

所以九个头部 token 也要按类型重打：端口名/时间状态名照抄（本来就是名字），sequence/week/
swVersion 取整，idle 是 `round(v*2)/2` 一位小数，毫秒是秒 + 三位小数，rxStatus 八位小写 hex，
msgDefCrc 四位小写 hex。ABBREV 那条 `<BESTPOS USB2 7 72.0 …` 用的是**同一套**重打后的头。

真机写的 `#` 记录本来就规范，重打是恒等：b1 的 13 条、live-nav 的 11 条、live-nav2 的 10 条
（全是 `#BESTPOSA`）都逐字节不变，三道 golden 全绿。

### ⑤ `$` + `$` 无 CRLF：一条记录，取**最后**一句

`framing.ts` 早就知道 `$…$…\r\n` 是一条文本记录（`textBoundary` 不把 `$` 当边界）。那条记录
打印哪一句，实测是**最后一个 `$` 起**的那一句，并且校验**它自己**的 `*hh`：

| 抓包里的一条记录 | 套件输出 |
|---|---|
| `$A*47$B*7A` | `$B…*7A` |
| `$A*47$B*00`（B 的校验和坏） | 什么都不出（**不回退**到 A） |
| `$00-A$B*7A`（A 坏 B 好） | `$B…*7A` |
| `$A*47$B*7A$R*78` | `$R…*78` |
| `$A*47$GPGGA,1,2`（末尾没 `*`） | 什么都不出 |
| `$A*47$B*7a`（小写校验和） | `$B…*7a`，原样回显，不重打 |
| `$A*47$GNZZZ,1*36`（最后一句不是已知 NMEA） | 什么都不出 |

旧实现用 `^…$` 贪婪匹配整条、校验和算在「第一个 `$` 到最后一个 `*`」上，于是行数比 oracle 少
一条（合并的那条被当成校验和错丢掉）。现在先 `lastIndexOf('$')` 再匹配，校验和与回显都落在
最后一句上。

### ⑥ `<` 只有头没有体：不输出

`<BESTPOS COM1 0 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n` 后面直接跟下一条
`<` 头时，套件**一行都不出**（不是出一条空 body 的 `#BESTPOSA,…;*crc`）。现在
`textLogLines` / `abbrevTextLogLines` 在 `record.tokens.length <= 9`（正好九个头部字段）时直接跳过。
有体的记录照旧，`<RAWALM …` + `<     2402 91818.000 0` 仍然出一条。

### 顺带测出来的一件（不在六项里，但会影响上面）

变长 `%s` 的 `arrayLength` **不封顶**：

```
SURVEYPOSITION，id 声明 5 B，payload 里放 "abcdefghij\0"
→ 套件打 "abcdefghij"（10 个字符），latitude 落在 4 + 12 = 16
```

所以 `stringWireSize` 改成「数到 NUL 为止」，`readString` 分流成
`readStringField`（定长字符串仍封顶在声明宽度，变长的不封顶）。真机记录一定在声明宽度内
NUL 终止，两种读法在八份 golden 上完全同解（`SETNAV` 的 `"FROM"`、`ICOMCONFIG` 的 `":3002"`、
`DNSCONFIG` 的 `"192.168.5.1"`、`ETHSTATUS` 的 MAC 都没变）。

### 回归（全部真跑，2026-11-01）

`node --test --test-force-exit "packages/*/test/*.test.ts"` → **754 项全绿**
（本轮新增 12 项，全在 `packages/protocol/test/oracle-residual.test.ts`；基线 721 项，余下的差额来自
同一仓库另一路并行工作新加的 `packages/app` 侧用例——本轮只碰了 `packages/protocol/src`、
`packages/protocol/test`、`逆向/tools` 和本文件）。

八份 ASCII golden：字节数与 SHA-256（`golden-check.ts`，全部 `OK`）

| golden | 字节 | sha256 前 16 位 |
|---|---|---|
| broad-clean.ASCII | 5 567 000 | `c1196c58cf9f633c` |
| clean-9600.ASCII | 489 205 | `9794cf614d3f9572` |
| golden-live-nav.ASCII | 2 798 307 | `ebbaa745e04839c9` |
| golden-live-nav2.ASCII | 2 657 890 | `1f0526440567fa93` |
| golden-remote-23types.ASCII | 3 845 232 | `893d135e3e548f92` |
| golden-b1-20261101.ASCII | 5 088 882 | `2d6f529f8829ed18` |
| golden-b2-20261101.ASCII | 4 931 973 | `11a27b7a98bc20b2` |
| golden-b3-20261101.ASCII | 6 137 463 | `c6a678cdf8da5631` |

五份 ABBREV golden：b1 / b2 / b3 在树上（`5 738 549` / `5 723 813` / `7 116 268` B，
sha `652d04cd…` / `adeb4417…` / `49c9c10b…`），live-nav / live-nav2 **不在树上**，用本机套件现场跑：

```
OK   live-nav.sbf   ABBREV_ASCII  suite 3248102 B 42f1468ec9883f8c   ours 3248102 B 42f1468ec9883f8c
OK   live-nav2.sbf  ABBREV_ASCII  suite 3084110 B 9b36c522bb176dd9   ours 3084110 B 9b36c522bb176dd9
```

（另有 b4 / b5 / clean-9600 三份 ABBREV 也一并复验：`8 725 124` / `7 372 489` / `567 576` B，全 `OK`。）

### 剩余（no sample, no fix —— 以及为什么不硬凑）

- **套件越界读 payload**：payload 比 packed 尺寸短时（例如 46 B 的 `RAWGPSSUBFRAME`），套件照样按
  packed 偏移读，读到自己的堆上，打出 `3515780199` 这种值。这既不可复现也没意义（真机不会发
  这个长度），我们读到 payload 外一律给 0。`live-b3.test.ts` 把这个「0」钉成断言。
- **同一条记录里变长字符串没有 NUL 时**：套件会一路读到 payload 之外（它的 buffer 含 4 B CRC），
  所以那种合成帧的最后几个字节对不上。真机记录不会这样；我们以 payload 结束为界。
- **数组元素内部的成员偏移**仍是 dense + `shift`（golden 证明过的那条路，`ETHSTATUS` count=1）。
  `SBAS17`(30→32)、`ETHSTATUS`(26→28)、`SAVEDSURVEYPOSITIONS`(29→32)、`WIFINETLIST`(63→68)
  这四个**元素结构体**在 count ≥ 2 时 stride 应该变，但这四条报文在任何抓包里都没出现，
  count=1 也证明不了 stride，故不动。`oracle-sweep.ts` 只扫定长布局，扫不到这里。
- **`USERI2CREAD` / `USERCANDATA` / `FILESYSTEMCAPACITY` 是 COMMAND 或固件拒发**，任何真机抓包
  都不会有这几行；本节给的是「套件对这样一个帧会打什么」，不是「接收机会发什么」。
- **`%` 短 ASCII** 仍然不实现（§9.x.6 已记：六种形状套件全丢）。


## 9.x.15 B1 第六批（b6）：9 类新类型 / 786 行逐字节；**这批的价值是一张「字典已探尽」的账**（2026-11-01）

前五批是「找名字 → 抓 → 对」。这一批把剩下能找的名字**全部找完了**：608 条字典里 323 个 LOG 名，
本批探了 126 个，出 9 类新数据；其余 197 个要么前批已经探过、要么已经在 golden 里、要么是
b5 证明过「解压成 `RANGE`、自己不出行」的压缩测距版本。所以这节记的第一件事是一个**探法错误**
（差一点就把这 9 类全判成「不出」），第二件才是覆盖面。

### 先说错误：`LOG <名>` 与 `LOG <名>B` 是两条完全不同的日志

第一版 `b6-probe.ps1` 照 b5 的形状写，但候选名直接从字典的 `name` 抄，于是发出的是

```
LOG LBANDTRACKSTAT ONCE          <- 这一条要的是 ASCII 日志
```

接收机照常回 `<OK`，端口上却一条二进制都没有——于是同一批 126 个名字**全部**落进
「被拒 / 不出」，DATA 为零。二十分钟后改用

```
LOG LBANDTRACKSTATB ONCE         <- 二进制日志
```

同样是这 126 个名字，立刻出 9 类。**b4 / b5 的探针一直是对的**（它们的候选表里写的就是
`VALIDMODELSB`、`INSVELXB`…），错的是这一批第一版自己「规范化」掉了那个后缀。

教训有两条，都写进 `b6-probe.ps1` 的注释里了：

- 二进制日志名 = 字典名 + `B`，ASCII 日志名 = 字典名。ASCII 日志回的是一行文本，
  `.sbf` 里永远不会有它，探测只看二进制头的人会把它记成「收下但不出」。
- **「`<OK` 但没数据」这个结论，只有在确认自己问对了日志之后才成立。** 判据要跟着方法走，
  不能只看接收机说了 `<OK`。

### 怎么抓的

`tools/remote/b6-probe.ps1`（探测）→ `tools/remote/b6-capture.ps1`（抓包，两段、段间裸
`UNLOGALL`）。候选表不是猜的，是算出来的：

| 口径 | 数 |
|---|---|
| 字典里的消息总数 | 608 |
| 其中 `type: LOG` | 323（另有 281 条 COMMAND；4 条没有 `type`：`BDSBCNAV3RAWMESSAGE2` 与 `RANGECMP5` 在 b5 已覆盖，`PROFILERESPONSE` 与 `GALHASRAWMT` 在 b5 的探针名单里已判定不出） |
| 名字已在 17 份 golden 里出现过 | 108 |
| **从未覆盖过** | **215** |
| 其中 b4 / b5 已探过（结论照旧） | 83 |
| 其中 b5 已证明「解压成 `RANGE`、自己不出行」 | 4（`RANGECMP` / `2` / `3` / `4`） |
| 其中属于 SPAN 家族、前批已用 `RAWIMUSX` / `INSSTDEV` 判定被拒 | 2（`RAWIMUX` / `SYNCRELINSPVA`） |
| **本批实际探测** | **126** |

探测口径同前五批：一条 `LOG <名>B ONCE`、单独 1.5 s 回复窗口、按**报文 id** 判，
41/42/43 与 93/72/963 一律不计（理由见 §9.x.12）。

另外做了一次**`ONTIME` 复核**（`b6-retry.ps1`）：`ONCE` 只会在该日志的下一个「该出」时刻出一次，
一个只在变化时输出的日志可能永远不出，于是把 44 个 `OK-NODATA` 的名字改成
`LOG <名>B ONTIME 1` 连续 25 s（两相，19 + 25 个名字）。结果**只有 `ETHSTATUS` 出了东西**，
其余一个 id 都没有。所以「`ONCE` 不出」这一条不是方法问题，是这台机器真的不出。

这条复核还顺带问出了**第三种拒绝**（前五批没见过）：

```
<ERROR:Trigger ONTIME not valid for this log
```

9 个 `ONTIME 1` 里有 **3 个**收到这一句，分别是 `PPPSEEDAPPLICATIONSTATUS`、`PPPSEEDSTORESTATUS`、
`TECTONICSCOMPENSATION`——它们的记录数因此停在 1（`ONCE` 的那一条），而另外 6 个是 15–17 条。
这三个日志**只能「变化时出」**，周期性触发器对它们非法。也就是说：对它们而言「`<OK` 但一条不出」
里的那个「一条」其实**出过**，只是状态没变就不会再出。这条不影响本批的 9 类（它们都有记录），
但它解释了上一批 41 个 `OK-NODATA` 里可能有一部分属于同一类「只在变化时出」的日志。

### 三类清单（126 个名字）

**收下并抓到（9 类，全部进 golden）**

| 类 | id | 条数 | | 类 | id | 条数 |
|---|---|---|---|---|---|---|
| `PASSCOM3` | 235 | 1 | | `LBANDTRACKSTAT` | 1201 | 17 |
| `SOURCETABLE` | 1344 | 17 | | `LBANDBEAMTABLE` | 1718 | 17 |
| `TERRASTARSTATUS` | 1729 | 17 | | `OCEANIXSTATUS` | 2160 | 16 |
| `PPPSEEDAPPLICATIONSTATUS` | 2250 | 1 | | `PPPSEEDSTORESTATUS` | 2251 | 1 |
| `TECTONICSCOMPENSATION` | 2291 | 1 | | | | |

这一批的形状比前几批**窄**：9 类里有 7 类只有 2–7 个字段，只有 `LBANDTRACKSTAT`
（1 个计数 + 5 个 16 字段块）和 `LBANDBEAMTABLE`（1 个计数 + 6 个 6 字段波束）是宽的。
值得单独记的三条：

- **`TECTONICSCOMPENSATION` 打出了这台机器配的负荷网格名**：`AVAILABLE,"Yangtze",-0.034,-0.008,-0.011`
  —— 一个带引号的字符串 + 三个三位小数的分量，和 `LBANDBEAMTABLE` 的 `"AORW"` / `"IOR"` / `"98W"`
  一样，都是「枚举字段其实是自由文本」的又一处。
- **`PASSCOM3` 是这台机器唯一真的在转发的透传口**：payload 8 B = 长度 4 + 4 B 数据，
  打出来是 `4,\xed\xff\xf7\xb9`（`%P` 转义）。`PASSCOM1` / `PASSCOM2` / `PASSCOM4..10` /
  `PASSUSB1..3` / `PASSICOM1..7` / `PASSNCOM1..3` / `PASSAUX` 全部 `<OK` 但不出——
  **不是名字错，是那些口上没有数据被转发**。
- **`LBANDTRACKSTAT` 的 5 个块全是零**（`"",0,0,0000,0003,0,0.000,…`）：这台机器没有 L-Band
  信号，`TERRASTARSTATUS` 也照实写着 `DISABLE,NO_SIGNAL`。布局能验的只有「字段数与偏移对」，
  值域验不了，所以本批没有一条断言依赖这些数值。

**被拒：`<ERROR:Message is invalid for this model`（50 个，固件选项没开）**

`BSLNXYZ` `RTKDOP2` `MATCHEDSATS` `DUALANTENNAHEADING` `GPHDTDUALANTENNA`
`RAWIMUSX` `INSSTDEVS` `INSATTX` `INSPOSX` `INSPVACMP` `INSPVASDCMP` `INSVELUSER`
`IMURATEPVA` `IMURATEPVAS` `IMURATECORRIMUS` `INSATTQS` `CORRIMUS` `INSATT` `INSPOS` `INSSPD`
`INSVEL` `INSPVA` `INSATTS` `INSPOSS` `INSSPDS` `INSVELS` `INSPVAS` `RAWIMU` `RAWIMUS`
`VARIABLELEVERARM` `GIMBALLEDPVA` `INSUPDATESTATUS` `INSCALSTATUS` `INSSEEDSTATUS` `SYNCHEAVE`
`DELAYEDHEAVE` `MARK2PVA` `MARK3PVA` `MARK4PVA` `TAGGEDMARK1PVA` `TAGGEDMARK2PVA`
`TAGGEDMARK3PVA` `TAGGEDMARK4PVA` `RELINSPVA` `SKCALIBRATESTATUS` `SPRINKLERDATA`
`SPRINKLERDATAH` `TRANSFERPORTSTATUS` `LUAOUTPUT` `WIFIAPSETTINGS`

这一批把**整个 SPAN/IMU 族**（含 `ONCE` 与 `ONTIME` 两轮）与**整个 RTK 授权族**探穿了，
结论和前两批一致且更完整：这台 OEM729 没有 SPAN、没有 RTK、没有双天线、没有 Wi-Fi AP 设置、
没有 LUA 输出、没有洒水器/传输口。**这不是「名字写错」**，接收机原话就是上面那一句。

**被拒：`<ERROR:Invalid Message. Field = 2`（18 个，名字根本不存在）**

`RAWLBANDPACKET` `SBAS32` `SBAS33` `SBAS34` `SBAS35` `GPGGARTK` `CORRIMUDATA`
`INSCOV` `INSCOVS` `IMUTOANTOFFSETS` `BESTLEVERARM` `BESTLEVERARM2` `PASSXCOM1`
`PASSXCOM2` `PASSXCOM3` `PASSETH1` `INSUPDATE` `CORRIMUDATAS`

值得单独记的一条：**试过的 13 个 `SBAS` 页名全部存在、`SBAS32/33/34/35` 却一个都不存在**
——同一个 `SBAS<n>` 家族里接收机只认一部分 PRN 的页名（4 个不在册的被拒原话就是
`<ERROR:Invalid Message. Field = 2`，不是「模型不支持」）。
`CORRIMUDATA` / `INSCOV` 也属此列（字典有、接收机没有），而 `CORRIMUS` / `INSCOVS` 是被
「模型不支持」拒的：**同一个概念，两个拼写，两种错误**。

**不出（49 个：`<OK` 收下，1.5 s 与 25 s 两轮都没有一条记录）**

- 没有 SBAS 星：`SBAS18` `SBASALMANAC` `SBAS0` `SBAS1` `SBAS2` `SBAS4` `SBAS5` `SBAS6` `SBAS7`
  `SBAS9` `SBAS10` `SBAS12` `SBAS24`（13 个页名全部接受、全部不出）；
- 配置了才有内容：`PPPDATUMINFO` `REFSTATION` `MARK4POS` `HEADINGSATS` `HEADINGEXT2`
  `ALIGNDOP` `ALIGNBSLNXYZ` `ALIGNBSLNENU` `GENERATEALIGNCORRECTIONS` `USERI2CRESPONSE`；
- 口上没有流量：`PASSCOM1` `PASSCOM2` `PASSCOM4` `PASSCOM5` `PASSCOM6` `PASSCOM7` `PASSCOM8`
  `PASSCOM9` `PASSCOM10` `PASSUSB1` `PASSUSB2` `PASSUSB3` `PASSICOM1` `PASSICOM2` `PASSICOM3`
  `PASSICOM4` `PASSICOM5` `PASSICOM6` `PASSICOM7` `PASSNCOM1` `PASSNCOM2` `PASSNCOM3` `PASSAUX`；
- 固件不解这些信号：`NAVICRAWSUBFRAME` `NAVICIONO` `QZSSRAWCNAVMESSAGE`。

### 顺手补的三个样本缺口：一个补上了、两个是「这台机器没有」

这三个是 §9.x.14 末尾挂着的 `pack(...)` 数组 stride 判据，本批用同一个 session 一起试了。

| 缺口 | 结果 | 依据 |
|---|---|---|
| `ETHSTATUS` count ≥ 2 | **拿不到**，但拿到了一条新证据 | 15 条记录全是 `count = 1`、payload 全是 32 B，且 15 条**逐字节相同**：`01 00 00 00` + `02 00 00 00` + MAC 串 20 B + `01 00 00 00`。也就是说**块长实测 28**（4 计数 + 28 块 = 32），而字典写的是 26——§9.x.14 里「`ETHSTATUS`(26→28)」这个猜测现在有了正面证据。但**stride 仍然证不了**：这台机器只有 `ETHA` 一块网口（枚举值 2、状态 `NOTCONNECT`），一块的时候「块长 28」和「块长 26 + 尾部 2 B」在字节上无法区分。 |
| `SAVEDSURVEYPOSITIONS` | **拿不到**：这台机器上没存过点 | `LOG SAVEDSURVEYPOSITIONSB ONCE` 与 `ONTIME 1` 25 s 都回 `<OK`、一条不出。**不是「该机型不出」**，是这个日志的内容就是「已保存的测点」，而接收机里一个都没有（`SURVEYPOSITION` 是写命令，我没有动它——那会改接收机的 NVM）。 |
| `SBAS17` / `SBAS18` | **没有 SBAS 星** | 两个名字都 `<OK`、都不出；顺手把 `SBAS0/1/2/4/5/6/7/9/10/12/24` 与 `SBASALMANAC` 一起试了，**13 个页名全部接受、全部不出**。所以不是某个 PRN 的问题，是没有 SBAS 信号可解。 |

顺带排除了一条猜想：想读回「SBAS 到底启用没有」「有几块网口」，于是发了裸的
`SBASCONTROL` 和 `ETHCONFIG`——两者都回 **`<ERROR:Message missing field`**。
在这版固件上它们是**只写**命令，读不回来（`b6-readback.ps1` 保留了这个实测）。

### 结果：786 / 786，46 354 / 46 354，零改动

```
b6-20261101.sbf              2 001 033 B   786 条二进制记录 + 57 条文本帧
                                            （29 条 `[USB2]` 端口标记 + 25 条 `<OK`
                                             + 3 条 `<ERROR:Trigger ONTIME not valid for this log`）
golden-b6-20261101.ASCII     3 599 999 B   786 行      逐字节相同（cmp-lines：0 / 0）
golden-b6-20261101.ABBREV_ASCII  4 179 807 B  46 354 行  逐字节相同（0 / 0）
```

**一行代码都没改。** 9 个新布局没有引出任何新规则，原因也直白：这一批撞到的三种形状
（计数 + 定长块数组、带引号的自由文本、`%P` 转义）在前五批里各自都已经被钉过，
`LBANDTRACKSTAT` 的「1 个计数 + 5 个 16 字段块」正是 `GEODETICDATUMS`（b5）那条路径的复写。
反过来说，这一批的意义不在「又修了什么」，而在**它证明了前五批那几条是规则**：
换 9 个从未见过的布局、零改动，一次对上。

### 套件 summary 的 `UNKNOWN` 行（b5 就有，本批才量出来）

套件的 `Summary_b6.txt` 有 17 行，我们只有 16 行，差的是这一行：

```
       0 | UNKNOWN                       |     230 |       0 |
```

b5 的 summary 里同样有一行，值是 **350**。而 b6 的输入文件里**一共只有 786 条二进制记录**
（`AA 44 12` 出现 786 次、长度字节全是 28）加 25 个 `<OK` 回显，字节数分毫不差——**这个 230
不可能是一条记录数**。所以它要么是套件自己的「未归类字节/未归类事件」计数器，要么是它把
`sbf` 里的文本记录也按某种口径折算了一遍。我们**不实现**它（`summary.ts` 不在本轮范围内，
而且照抄一个说不出含义的计数器没有意义），但把它记在这里，免得下次有人把它当成新的差异。

### 回归（全部真跑，2026-11-01）

`node --test --test-force-exit "packages/*/test/*.test.ts"` → **853 / 853 全绿**（17:52 的读数）。
本路 `packages/protocol` 单独跑是 **265 / 265 全绿**（17:55），这是本批改动所在的那一层。

本批的贡献是 **10 条 `live-b6.test.ts` + `convert-pipeline.test.ts` 的 b6 两行**。基线 777；
从 777 到 853 多出来的 66 项是**同一棵树上另一路并行工作**（`packages/app` 的配置页从 14 个加
到 18 个、`summary.ts` 开始实现上一节那个 `UNKNOWN` 行）在本轮期间落地的，不是本批的用例。
三分钟后整仓又变成 866 / 864（那一路新加的 `packages/app/test/graph-tabs.test.ts` 与
「Ports: the rate column…」两条红着）——**这就是取数的前提：整仓数字每几分钟就变一次。**

跑这串命令的过程中看到过两次噪声，都不在本批范围内，记下来免得下次误判：

- `packages/protocol/test/summary-counts.test.ts` 的「the only table row we still lack is the
  suite's UNKNOWN row」红过三分钟——那一路把代码改成会打印 `UNKNOWN` 行，而用例里的断言还写着
  「我们不打印」。他们改完即绿。
- `packages/session/test/session.test.ts` 的「heartbeat counts misses…」在整仓负载下偶尔
  `6 !== 2`（计时用例），单独跑 11/11、整仓重跑也绿。**不是回归。**

结论：这个仓库现在**不是单写者**，整仓读数要在两路都停下时取；本批的判据以
`packages/protocol/test/live-b6.test.ts` 与 `convert-pipeline.test.ts` 的 b6 两行为准。

`逆向/tools/golden-check.ts`：**14 份全部 `OK`**

| golden | 字节 | sha256 前 16 位 |
|---|---|---|
| broad-clean.ASCII | 5 567 000 | `c1196c58cf9f633c` |
| clean-9600.ASCII | 489 205 | `9794cf614d3f9572` |
| golden-live-nav.ASCII | 2 798 307 | `ebbaa745e04839c9` |
| golden-live-nav2.ASCII | 2 657 890 | `1f0526440567fa93` |
| golden-remote-23types.ASCII | 3 845 232 | `893d135e3e548f92` |
| golden-b1-20261101.ASCII | 5 088 882 | `2d6f529f8829ed18` |
| golden-b2-20261101.ASCII | 4 931 973 | `11a27b7a98bc20b2` |
| golden-b3-20261101.ASCII | 6 137 463 | `c6a678cdf8da5631` |
| golden-b4-20261101.ASCII | 7 646 463 | 由 `convert-pipeline.test.ts` 覆盖 |
| golden-b5-20261101.ASCII | 6 354 933 | 同上 |
| golden-b1/b2/b3/b4/b5.ABBREV_ASCII | 5 738 549 / 5 723 813 / 7 116 268 / 8 725 124 / 7 372 489 | `652d04cd…` / `adeb4417…` / `49c9c10b…` / `3d0d2314…` / `f0ae21ff…` |
| clean-9600.ABBREV_ASCII | 567 576 | `c59fbfae34cb4232` |

（`golden-check.ts` 的表里没有 b4 / b5 的 ASCII 两行，它们的字节数与逐字节比对由
`convert-pipeline.test.ts` 的表负责，本批新加的 b6 两行同理。）

### 剩余（为什么这批停在 9 类，没有凑到 10）

任务书写的是「本批再推 10–20 类」。本批只拿到 **9 类**，原因是可核的，不是没找：

- **字典里的 LOG 名已经被探尽了。** 323 个 LOG 名 = 108 个已有 golden + 83 个 b4/b5 已探 +
  6 个 b5 已用别的方式覆盖（`RANGECMP` / `2` / `3` / `4` 解压成 `RANGE`，`RAWIMUX` /
  `SYNCRELINSPVA` 属已判死的 SPAN 族）+ **本批 126 个**。没有第 127 个名字可探。
- **没拿到的名字归成 8 类硬件/授权缺口**：SPAN（无 IMU）、RTK（无授权）、双天线（无第二副）、
  Wi-Fi AP、LUA、SBAS（无星）、NavIC/CNAV（固件不解）、存储/文件系统（`FILE*` / `LUAFILE*`
  在 b5 已整族被拒）。这些换机器或换固件才有，不是再加一个探测窗口的问题。
- **三条 stride 判据里两条这条路走不通**：`ETHSTATUS` 需要一个有两块网口的接收机，
  `SAVEDSURVEYPOSITIONS` 需要先在接收机上存点（那是改 NVM，本轮没做）。第三条 `SBAS17`
  要等天上有一颗 SBAS 星。
- **不建议为了凑数去做的两件事**：① 给接收机加 `SBASCONTROL ENABLE` 或存一个测点，
  只为让两条日志出数据——这会改用户机器的配置；② 用合成帧造 `count ≥ 2` 的
  `ETHSTATUS` / `SAVEDSURVEYPOSITIONS`——套件对这种帧的输出我们已经知道（§9.x.14），
  但那就不是真机样本了，而本节所有的数字都要求真机。


## 9.x.16 B7：ITK / 事件 / 多频一包（2026-11-01），两处编码规则被真机改掉

样本 `b7-20261101.sbf`（943 486 B，69 s，178 条二进制记录 + 文本帧）。这是第一个**同一份抓包里
同时出现** `ITDETECTSTATUS`、`ITPSDFINAL`、`ITPSDDETECT`、`ITSPECTRALANALYSIS`、
`ITDETECTCONFIG`、`ITWARNINGCONFIG`、`CHANCONFIGLIST` 与 `RXCONFIGA` 的真实样本，四条新规则
都是它逼出来的（任务背景与场外结论见 `05_GRIT-Monitor.md` §13、`01_Manage主界面与视图层.md` §13）。

### ① 五种 ITK 日志的 `…B` 会回落成 ASCII

`LOG ITDETECTSTATUSB ONCE` 回 `<OK`，端口上来的却是 **`#ITDETECTSTATUSA,SPECIAL,…`**——不是
二进制。同样回落的有 `ITDETECTCONFIGB`、`ITSPECTRALANALYSISB`、`ITPSDDETECTB`、
`CHANCONFIGLISTB`，全部在 `b7` 里逐条试过：

| 请求 | 回来的记录 | 端口列 |
|---|---|---|
| `LOG ITDETECTSTATUSB ONCE` | `#ITDETECTSTATUSA,SPECIAL,0,77.5,…;1,L2,STATISTICANALYSIS,…` | `SPECIAL` |
| `LOG ITDETECTCONFIGB ONCE` | `#ITDETECTCONFIGA,SPECIAL,…;ALL,0,0,0` | `SPECIAL` |
| `LOG ITSPECTRALANALYSISB ONCE` | `#ITSPECTRALANALYSISA,SPECIAL,…;PREDECIMATION,GPSL1,200,2K,1,1` | `SPECIAL` |
| `LOG ITPSDDETECTB ONCE` | 两条 `#ITPSDDETECTA,SPECIAL`（1202.537 MHz、1277.537 MHz）| `SPECIAL` |
| `LOG CHANCONFIGLISTB ONCE` | `#CHANCONFIGLISTA,SPECIAL,…` | `SPECIAL` |
| `LOG ITFILTTABLEB ONCE` | `<ERROR:Message is invalid for this model` | — |

所以「`LOG <名>B` 一定出二进制」（§9.x.15 那条教训）要补半句：**这五种日志没有二进制形态，
`B` 请求回落成文本**。抓包按 `.sbf` 存，里面是文本行，`text-log.ts` 必须认——它认。

### ② 一条完整且 CRC 正确的 `#` 行不能被内层的 `#` 切断

`LOG RXCONFIGA ONCE` 的每一行都是**一条记录里套一条记录**：

```
#RXCONFIGA,USB2,268,76.5,SATTIME,0,0.000,03808800,f702,18278;
  #ELEVATIONCUTOFFA,USB2,268,76.5,SATTIME,0,0.000,03808800,50e0,18278;GLONASS,5.0,0
  *866b1c79 *2a0b9060
```

`framing.ts` 原来有条实测规则：文本记录不得吞掉里面开始的记录，`textBoundary()` 见到内层 `#`
就在那里断开。这条对**被截断的残行**是对的（合成帧验过），但对上面这种**自己 CRC 就成立**的完整
行是错的——套件把它整行收下（`b7` 里 247 条）。修法很小：`textBoundary()` 先用 `completeHashLine()`
算这条行（到行尾 CR/LF 为止）的 CRC，成立就不切。回归：`live-b7.test.ts` 两条（一条正例
`…*866b1c79*2a0b9060` 整行保留，一条负例 CRC 全 0 仍在内层 `#` 处切断）。

### ③ ABBREV 里「可変长标量数组」与「字段数组」不是一回事

`ITPSDFINAL` / `ITPSDDETECT` 的 `samples` 是 `VARIABLE_LENGTH_ARRAY`（`countSize 4` +
**一个标量元素**），套件的 ABBREV 把它**全印在数据行上**：

```
<ITPSDFINAL USB2 0 77.0 COARSESTEERING 2443 35956.000 03808800 b79a 18278
<     04020920 1531.299 97656.250 1024 24301 23560 23484 …（1024 个值同一行）
```

而 `FIELD_ARRAY`（`RANGE` 的观测块、`CHANCONFIGLIST` 的通道组）才是**一个元素一行、缩进 9**。
`text-log.ts` 的 `walkAbbrev()` 原来对所有 `countSize` 数组都按元素分行，于是 137 条频谱记录
变成 113 478 行（2 522 481 B）；按 `arrayKind` 分开之后只算这一步是 5 973 行（1 124 916 B）
——加上 ④ 的 `#RXCONFIGA` 之后是 6 780 行（1 172 518 B）。
二进制那一路（`abbrev-log.ts`）本来就是这个规则，这次只是把文本那一路对齐。

### ④ `RXCONFIGA` 的内嵌报文：套件会重渲染，我们照抄

`b7` 的 ASCII 差 43 行、ABBREV 差 247 块，全部集中在这 247 条 `RXCONFIGA` 上：

| 现象 | 套件 | 我们 | 原因 |
|---|---|---|---|
| 条数 | 247 | 269 | 套件对 22 条**整行丢弃**（下面那条重渲染不成立时它就不打印）|
| 逐字节相同 | — | 226 | — |
| `INTERFACEMODE` 的端口名 | `UNKNOWN` | `LCOM1` | 套件把内嵌报文按字典重渲染，`LCOM1` 不在端口枚举里 → `UNKNOWN` |
| ABBREV 内嵌块末值 | `… HOLD` | `… HOLD*8b4f9350` | 套件重渲染后内层 CRC 不再出现；我们把收到的内层 CRC 留在最后一个值后面 |

三层 CRC 也对不上：内层记录收到的是 `*81750840`，套件打印的是 `*5633f5d1`，既不是原文 CRC
（`7e8af7bf`）也不是按重渲染正文算的 CRC（`a9cc0a2e`）。**重渲染后再算 CRC 用的是哪一段字节，
本轮没解出来**，所以这里停在「照抄原文」：226/269 条逐字节相同，剩下的是已知差异，写在
`05_GRIT-Monitor.md` §13.6，不猜。

> **→ 已解，见 §9.x.17**：内层 CRC 是「重渲染后 `NAME,<head>;<body>` 的 NovAtel CRC **取反**」，
> 247/247 全中；22 条丢弃是内嵌报文名不在字典里；两格式现在逐字节相同。

### 回归与数字（2026-11-01 19:4x）

```
b7-20261101.sbf                   943 486 B
golden-b7-20261101.ASCII        1 100 989 B   609 行   我们 631 行 / 1 104 413 B
golden-b7-20261101.ABBREV_ASCII 1 166 848 B  6 719 行   我们 6 780 行 / 1 172 518 B
```

除 `#RXCONFIGA` 那 43 行 / 247 块以外，**全部逐行相同**（`cmp-lines.cjs`：ours 不在 oracle 里的
行 43 条，全部是 `#RXCONFIGA`）。14 份既有 golden 在改动后仍逐字节相同（`golden-check.ts` 全 `OK`）。
`packages/protocol/test/live-b7.test.ts` 新增 15 项。


## 9.x.17 文本 `#RXCONFIGA` 的内嵌重渲染与内层 CRC：`~CRC32`，247/247（2026-11-01）

§9.x.16 ④ 留了一个「没解出来」：套件把内嵌报文按字典重渲染，可它打印的内层 CRC
`5633f5d1` 既不是收到的那一个，也不是重渲染正文的 NovAtel CRC。这一节把它量完。

### 结构

抓包与 golden 里都是同一个形状，**两个 `*` 字段**：

```
#RXCONFIGA,<outerHead>;#<INNER>,<innerHead>;<innerBody>*<innerCrc>*<outerCrc>
```

`b7-20261101.sbf` 上有 269 条这样的文本行，`golden-b7-20261101.ASCII` 里只剩 247 条。

### ① 内嵌报文会被**整条重渲染**

套件把 `%R` 里的那串文本当成一条**独立的 ASCII 记录**重新解析、再按字典打印一遍，不是照抄：

| 输入（抓包） | 输出（golden） |
|---|---|
| `…#INTERFACEMODEA,…;LCOM1,NOVATEL,NOVATEL,ON*81750840*5674ed4f` | `…#INTERFACEMODEA,…;UNKNOWN,NOVATEL,NOVATEL,ON*5633f5d1*b7ce43ba` |

重渲染的规则和顶层 `#` 记录完全一样（`renderHead` + `renderBody`）：

- **额部**九项照打印规则重排：`02442`→`2442`、`72.00`→`72.0`、`570228.0`→`570228.000`、
  `3800800`→`03800800`、`CDBA`→`cdba`；
- **正文**逐字段过一遍转换串，`f32` 先四舍五入到单精度；
- **枚举字段的 token 一律按「名字」读，数字不算名字**。这是本轮新量出来的规则：
  `CommPort` 里 `8` = `ALL`、`3` = `COM3`，但套件对 `;8,OFF` 和 `;3,OFF` 两条合成输入
  **都打印 `UNKNOWN,OFF`**（顶层 `#ECHOA` 与内嵌两种位置都试过，结果相同）。所以
  `parseToken` 的枚举分支不再接受数字，`renderScalar` 把「表里查不到」统一印成 `UNKNOWN`；
- `%m`（消息名）字段反过来要**按名字查回 id**：`LOGA` 的 `RXSTATUSEVENTA` 不能当成数字，
  否则会印成 `UNKNOWNB`。`messageId()` 就是 `messageName()` 的逆（`A` → `|0x200000`、
  `B` → 原值、无后缀 → `|0x400000`）。

### ② 内嵌报文名不在字典里 → **整条外层记录丢弃**

269 − 247 = 22 条。按内嵌名字统计（19 个不同的名字）：

```
AGCMODEA ×4   NMEARMCTIMEA   PRNMAPPINGA   RTKGLOBIASOPTIONA   RTKFIXEDSTDLIMITA
SETRELIABILITYPARAMETERSA   CLOCKSTEERINGBIASTOLERANCEA   CLOCKSTEERINGSOURCEA
GPRMCALTITUDEA   NMEAINCLUDESBASA   NMEASATELLITESOURCEA   PPPELEVMASKA
PPPINTEGRITYMONITORINGA   PPPPLUSA   PSRDIFFCONFIGA   RTKAGEA   SETIONOMODELA
SETRTCMFKPA   VERIPOSSTANDARDCONFIGA
```

一条都不打印，连空正文的行也没有——和二进制 `%R` 的「解析不了就丢整条」是同一条规则
（§9.x.16 ④、`ascii-log.ts` 的 `unresolvedEmbedded`）。

### ③ 内层 CRC = 重渲染正文 NovAtel CRC 的**反码**

用 247 行做全集校验，先试了这些口径，**没有一条命中**（`probe-rxconfiga.ts`）：

| # | 口径（对 golden 的重渲染正文计算） | 命中 |
|---|---|---|
| 1 | `INNER,<head>;<body>` | 0/247 |
| 2 | `#INNER,<head>;<body>` | 0/247 |
| 3 | `INNER,<head>;<body>*` | 0/247 |
| 4 | `#INNER,<head>;<body>*` | 0/247 |
| 5 | `<body>` | 0/247 |
| 6 | `<body>*` | 0/247 |
| 7 | `INNER;<body>` | 0/247 |
| 8 | `#INNER;<body>` | 0/247 |
| 9 | `<outerHead>;#INNER,…`（连外层头） | 0/247 |
| 10 | `#<outerHead>;#INNER,…` | 0/247 |
| 11 | 记录内**任意子串** `[i,j)` 全枚举 | 0 命中 |
| 12 | 记录 + 装饰：前缀 `''`/`#`/`\r\n` × 后缀 `''`/`*`/`\r\n`/`*\r\n`/`\n`/`\r`/`;` | 0 命中 |
| 13 | CRC-32 变体：poly `0xedb88320`/`0x04c11db7` × init `0`/`0xffffffff` × 反射 × 末异或 `0`/`0xffffffff` | **1 个命中** |

命中的那一个是 **poly `0xedb88320`、init `0`、反射、末异或 `0xffffffff`** —— 也就是 NovAtel CRC
**按位取反**（等价于 CRC-32/POSIX）。对 247 行全中：

```
内层 CRC = ~novatelCrc32("INNER,<head>;<body>")   // 不含 '#'，不含 '*'
```

拿 `INTERFACEMODE` 那条把三层数字摆在一起，链条就闭合了：

| 正文 | NovAtel CRC | 打印/携带的 CRC |
|---|---|---|
| 抓包原文 `;LCOM1,NOVATEL,NOVATEL,ON` | `7e8af7bf` | `81750840` = 取反 |
| 重渲染后 `;UNKNOWN,NOVATEL,NOVATEL,ON` | `a9cc0a2e` | `5633f5d1` = 取反 |

也就是说：**接收机自己写内嵌记录的 CRC 时也是取反的**，套件只是照同一规则重算了一遍 ——
§9.x.16 ④ 里「三类数字互不相等」正是漏掉了这一步取反。

**携带的那个内层 CRC 完全不被校验**：把 `*81750840` 换成 `*00000000`、换成 `7e8af7bf`（正向）、
换成 `a9cc0a2e`，套件打印的都是同一个 `5633f5d1`（三条合成抓包，`oracle-rxconfiga3.ts`）。

### ④ 外层 CRC 覆盖内层整条（含内层 CRC）

```
外层 CRC = novatelCrc32("RXCONFIGA,<outerHead>;#INNER,<head>;<body>*<innerCrc>")
```

正向、不取反，且**包含**内层那 8 个十六进制字符。247 行逐行验证（新测试里对每一行都断言）。

### ⑤ ABBREV：内嵌块是「五空格行 + 九空格数组行」

```
<RXCONFIG USB2 251 76.5 SATTIME 0 0.000 03808800 f702 18278
<     SETTIMESOURCE USB2 251 76.5 SATTIME 0 0.000 03808800 8aba 18278 
<     3 
<          GPS 
<          BEIDOU 
<          GALILEO
```

- 第 1 行外层头，**不带**尾随空格；
- 第 2 行内嵌头，缩进 **5** 空格，版本字母去掉（`SETTIMESOURCEA`→`SETTIMESOURCE`），尾部留一个空格；
- 之后是内嵌正文，走和普通 `#` 记录一样的 ABBREV 布局（标量一行 `<    `，`FIELD_ARRAY`
  每个元素一行 `<         `）。247 块里 244 块是 3 行，`SETTIMESOURCE` 是 6 行，
  `SETTIMEBASE`/`DNSCONFIG` 各 4 行 —— 这三块正是唯一带数组的。

### ⑥ 合成输入量出来的三条边角（b7 打不到）

| 输入（`#RXCONFIGA` 包一条 `#ECHOA`） | 套件 | 我们 |
|---|---|---|
| 正文少一个 token（`;COM2`） | 打印 `;COM2`（有几个印几个） | 同 |
| 正文多一个 token（`;COM2,OFF,99`） | 打印 `;COM2,OFF`（多余的丢） | 同 |
| 正文空（`;`） | 整条丢 | 同 |
| 内嵌名不在字典（`#FOOBARA,…`） | 整条丢 | 同 |
| 额部时间状态写成数字 `20` | **整条丢** | 未实现（见「剩余」） |

「正文少 token 保留」和顶层 `#` 记录相反（顶层少 token 是**整条丢**，`live-b7.test.ts` 里那条
`#BESTPOSA` 用例仍然是这个结论），所以内嵌这条路单独走 `renderBody` 的宽松返回值。

### 代码（只动了 `text-log.ts`）

```
parseEmbeddedRecord()   %R 里的文本 → {rawName,name,layout,head,body}
embeddedCrc()           ~novatelCrc32("NAME,<head>;<body>")
encodeEmbeddedAscii()   ASCII 侧：重渲染 + 重封内层 CRC
embeddedAbbrevBlock()   ABBREV 侧：5 空格头 + walkAbbrev 的正文行
renderScalar()          枚举名查不到 → UNKNOWN
messageId()             %m 的 token → id
```

### 回归（全部真跑，2026-11-01）

```
b7-20261101.sbf   --to ASCII         1 100 989 B   609 行   逐字节相同
b7-20261101.sbf   --to ABBREV_ASCII  1 166 848 B  6 719 行   逐字节相同
14 份既有 golden（b1–b6、live-nav、live-nav2、remote-23types、broad-clean、clean-9600）
                                      golden-check.ts  14/14 OK
packages/protocol/test/*.test.ts      298 项全绿
```

新增 `packages/protocol/test/rxconfig-text-embedded.test.ts`（10 项：两格式整文件逐字节、
247/22 的丢弃账、`LCOM1→UNKNOWN`、247 行内层/外层 CRC 的逐行不变量、`5633f5d1`/`a9cc0a2e`/
`81750840` 三个具体值、合成边角的四条、ABBREV 六行块），并改写 `live-b7.test.ts` 里
两条以旧行为为准的用例（269→247、内层 CRC 不再粘在末值后面）。

### 剩余（为什么这里就停）

- **额部时间状态写成数字 `20` 会让整条消失**，这一条只量到现象，没量到规则：我们没有模型解释
  为什么正文的枚举接受数字（印 `UNKNOWN`）而额部的时间状态遇到数字直接丢记录。b7 的 269 条
  额部全都写名字（`SATTIME` / `UNKNOWN`），goldens 里也没有数字型的时间状态，所以按「不猜」
  停在现状；真要碰它得再造十几条合成帧把额部九个字段逐个试一遍。
- `RXCONFIGUSER` 的 `%R` 载荷是**二进制**帧，不是文本；文本形式的 `#RXCONFIGUSERA` 在任何
  抓包里都没出现过。现在这条路会把它当文本解析、解析不出就丢；二进制形式走的是
  `convert-pipeline`/`ascii-log.ts` 那条 `%R` 路（§9.x.16 ④），两条互不影响。


## 9.x.18 四条计数数组的元素 stride：30→32 / 26→28 / 29→32 / 63→68（2026-11-01）

这是 A3–A8 最后一项。§9.x.14 的「剩余」里留着它：

```
SBAS17(30→32)、ETHSTATUS(26→28)、SAVEDSURVEYPOSITIONS(29→32)、WIFINETLIST(63→68)
这四个**元素结构体**在 count ≥ 2 时 stride 应该变，但这四条报文在任何抓包里都没出现，
count=1 也证明不了 stride，故不动。
```

### 为什么只能靠合成帧

四条报文在 `00_来源/samples` 的 14 份 golden 里**一行都没有**（`SBAS17A` / `SAVEDSURVEYPOSITIONSA` /
`WIFINETLISTA` 全零命中；`ETHSTATUS` 有 15 条，全部 `count=1`、payload 全 32 B、逐字节相同）。
一个元素分不出「28 字节的结构体」和「26 字节 + 2 字节余量」，所以只能造 `count ≥ 2` 的帧。

做法同 §9.x.14：按 `edie-layouts.json` 拼 payload → `buildLongHeader` + `appendCrcLe` 封帧 → 写到
纯 ASCII 路径 → 调

```
NovAtelApplicationSuite.exe -a       -o <纯ASCII目录> <输入>
NovAtelApplicationSuite.exe --abbrev -o <纯ASCII目录> <输入>
```

→ 套件写的 `ASCII/*.ASCII`、`ABBREV_ASCII/*.ABBREV_ASCII` 与 `convertFrames` 的输出逐字节比。
**这里比对的是套件自己的转换结果，不是我们自己编的期望值。**

| 工具 | 作用 |
|---|---|
| `逆向/tools/oracle-stride.ts` | 同一条报文造两份：一份按「成员 pack(4)、元素 packedStructSize 间隔」，一份按「成员 dense、元素仍 packed 间隔」，看套件跟哪一份 |
| `逆向/tools/oracle-stride-sentinels.ts` | 10 个用例（`count=1/2/3`、长/短字符串、双字符串），两边行都打出来，退出码 0 = 全一致 |

payload 里的值就是「自我描述」的：`SBAS17` 每个值写成 `1000 * 元素 + 10 * 成员`，所以行里出现
`1010…1090,2010…2090` 就说明两个元素分别在 8 和 40；字符串用例则让**短**串去分开两种规则
（字符串占满声明宽度时两种规则给出同一个偏移，这正是真机那 15 条 ETHSTATUS 两种读法都成立的原因）。

### ① `SBAS17`（#980）：固定元素 = C 结构体，`pack(4)`，元素 32 字节

```
成员  data_id  prn_3  health   x    y    z  x_vel y_vel z_vel   元素
dense    0       2      4      6   10   14   18    22    26      30
pack(4)  0       2      4      8   12   16   20    24    28      32
```

`x` 从 6 挪到 8，是因为 `LONG` 在 `#pragma pack(4)` 下要 4 对齐；`t0` 是 `dynamicOffset`，落在
`8 + count * 32`。三个用例（payload 44 / 76 / 108 B）：

```
套件 #SBAS17A,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;20907,2,1010,1020,1030,1040,1050,1060,1070,1080,1090,2010,2020,2030,2040,2050,2060,2070,2080,2090,20907*45a3c929
我们 #SBAS17A,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;20907,2,1010,1020,1030,1040,1050,1060,1070,1080,1090,2010,2020,2030,2040,2050,2060,2070,2080,2090,20907*45a3c929
```

`count=1` 那一条（`…*dd56e7e3`）就已经证明「成员是 pack(4)」——`x` 读在 8 才拿到 1040；`count=3`
（`…*932cf54c`）证明间隔重复、`t0` 在 8 + 96。ABBREV 同解（一个元素一行、缩进 10）。

### ② `ETHSTATUS`（#1288）：元素里带 `variable` `STRING`，**按内容重走**

```
interface(enum)  mac_address(STRING 18, variable)  interface_config(enum)
dense    0                 4                            22         (26)
pack(4)  0                 4                            24         (28)
```

17 字符 MAC（真机的形状 `"00-21-66-08-6A-79"`）时字符串吃 20 B（17 字符 + NUL = 18 B，补到 20），
所以 `interface_config` 在 +24、元素 28 B —— 与字典 26 的差正好是那 2 字节，32 B 的真机记录
（4 计数 + 28）就是这么来的。**但 28 不是常量**：2 字符 MAC 时字符串只吃 4 B，套件把
`interface_config` 打在 +8、下一个元素打在 +12：

```
套件（17 字符 MAC）#ETHSTATUSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,ETHA,"AA-BB-CC-DD-EE-FF",100_FULL,ETHB,"11-22-33-44-55-66",100_HALF*fc03a1c2
我们（17 字符 MAC）#ETHSTATUSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,ETHA,"AA-BB-CC-DD-EE-FF",100_FULL,ETHB,"11-22-33-44-55-66",100_HALF*fc03a1c2

套件（2 字符 MAC） #ETHSTATUSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,ETHA,"a0",100_FULL,ETHB,"b0",100_HALF*6b5e7bd1
我们（2 字符 MAC） #ETHSTATUSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,ETHA,"a0",100_FULL,ETHB,"b0",100_HALF*6b5e7bd1
```

第二个元素在 2 字符那条里读出来是 `ETHB,"b0",100_HALF`，即元素起点 = 4 + 12 = 16 —— 内容长度，
不是 28。

### ③ `SAVEDSURVEYPOSITIONS`（#1951）：`id` 重走，4 字符 id 才凑成 32

```
id(STRING 5, variable)  latitude  longitude  height   元素
dense   0                  5         13        21      29
pack(4) 0                  8         16        24      32
```

`id` 声明 5 B，4 字符 + NUL = 5 → 补到 8，`f64` 在 8（`pack(4)` 只要求 4 对齐，所以是 8 而不是 12），
元素 32 B；1 字符 id 只吃 4 B，`latitude` 就在 +4，元素 28 B：

```
套件（4 字符 id）#SAVEDSURVEYPOSITIONSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"abcd",11.50000000000,12.50000000000,13.5000,"ABCd",21.50000000000,22.50000000000,23.5000*59fc4c74
我们（4 字符 id）#SAVEDSURVEYPOSITIONSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"abcd",11.50000000000,12.50000000000,13.5000,"ABCd",21.50000000000,22.50000000000,23.5000*59fc4c74

套件（1 字符 id）#SAVEDSURVEYPOSITIONSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"a",11.50000000000,12.50000000000,13.5000,"a",21.50000000000,22.50000000000,23.5000*014ce30c
我们（1 字符 id）#SAVEDSURVEYPOSITIONSA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"a",11.50000000000,12.50000000000,13.5000,"a",21.50000000000,22.50000000000,23.5000*014ce30c
```

### ④ `WIFINETLIST`（#2210）：**两个**字符串，旧代码在这里是错的

```
ssid(STRING 33, variable)  rssi  channel  bssid(STRING 18, variable)  security   元素
dense   0                    33      37          41                      59       63
pack(4) 0                    36      40          44                      64       68
```

32 字符 SSID + 17 字符 BSSID 时：36 + 4 + 4 + 20 + 4 = 68（字典 63 + 5），这就是「63→68」；
SSID 短、BSSID 也短时元素只剩 24 B：

```
套件（32 字符 SSID / 17 字符 BSSID）#WIFINETLISTA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"01234567890123456789012345678901",4096,8192,"AA-BB-CC-DD-EE-FF",OPEN,"0123456789012345678901234567890Z",4097,8193,"AA-BB-CC-DD-EE-F@",WPA*381b8957
我们（同上）                        #WIFINETLISTA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"01234567890123456789012345678901",4096,8192,"AA-BB-CC-DD-EE-FF",OPEN,"0123456789012345678901234567890Z",4097,8193,"AA-BB-CC-DD-EE-F@",WPA*381b8957

套件（2 字符 SSID / 5 字符 BSSID）#WIFINETLISTA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"n0",4096,8192,"zz-yy",OPEN,"nZ",4097,8193,"zz-y@",WPA*453c5e3f
我们（同上）                       #WIFINETLISTA,COM1,1,0.0,FINESTEERING,2402,577759.000,03800800,cdba,18278;2,"n0",4096,8192,"zz-yy",OPEN,"nZ",4097,8193,"zz-y@",WPA*453c5e3f
```

第三个用例（32 字符 SSID + **1** 字符 BSSID，元素 52 B，`…*6d426e2a`）是这条报文的关键：第二个
字符串的漂移必须**从第一个字符串真正结束的位置**算起。旧实现 `segmentsWireSize` 里写的是

```
shift += at + size - (base + segment.offset + denseSegmentSize(segment));
```

而 `at` 本身已经含 `shift`，于是每过一个变长成员就把漂移**再加一遍**——一个字符串看不出来，
两个就错位。

### 结论：这四条不是「stride 变大」，而是「stride 不是常量」

| 报文 | 字典 dense | 元素真正的规则 | 满宽时 | 短字符串时 |
|---|---|---|---|---|
| `SBAS17` | 30 | 固定结构体，成员 `pack(4)`，间隔 `packedStructSize` | 32 | 32（无字符串） |
| `ETHSTATUS` | 26 | 变长 MAC 重走，`interface_config` 紧跟其后 | 28（17 字符 MAC） | 12（2 字符） |
| `SAVEDSURVEYPOSITIONS` | 29 | 变长 `id` 重走 | 32（≥4 字符 id） | 28（1 字符） |
| `WIFINETLIST` | 63 | 两个变长字符串都重走 | 68（32+17 字符） | 52 / 24 |

所以「`ETHSTATUS` 是 28」「`WIFINETLIST` 是 68」只在真机那种满宽字符串下成立；把它写成常量会
在短字符串的合成帧上立刻露馅（上面两张短串行就是证据）。**固定元素列表**（`SBAS17`）才是真正的
`packedStructSize`，且与 `count` 无关——`count=1` 时成员偏移就已经是 8，`count≥2` 只是让间隔看得见。

### 代码（只动了 `edie.ts`）

| 改动 | 内容 |
|---|---|
| 新增 `wireElementSegments()` | 元素列表里**没有**变长成员时，把成员偏移就地改成 `pack(4)`（`WeakSet` 记住，只改一次，幂等）；有变长成员的列表保持 dense 偏移 |
| `walkArray()` | `stride` 由 `array.stride` 改为 `variable ? 内容 : packedStructSize()`；定长元素先过 `wireElementSegments()` |
| `segmentsWireSize()` | `shift` 由 `+=` 改为赋值（累计漂移），`dynamicOffset` 段保留增量形式 |

就地改写的理由：`ascii-log.ts` / `abbrev-log.ts` 是拿 `array.elements` 直接取成员偏移的，而本轮
的边界不许碰这两个文件。改写只发生一次、且改的是「线上真实布局」，不是按样本开关。

### 回归（全部真跑，2026-11-01）

```
packages/protocol/test/*.test.ts   298 项全绿（含本轮新增 8 项）
全仓 packages/*/test/*.test.ts     935 项：929 绿 / 6 红
```

6 条红全在 `packages/app`、`packages/session`、`packages/view`（配置页 pill 数 19≠18、15≠14、
`interferenceToolkit` 待改值一类），是同一仓库另一路并行工作正在改的地方。已用 **HEAD 版
`edie.ts`** 复跑同一批文件，红的是同 3 条（当时另外 3 条还没被那一路加进来）——与本节改动无关。

14 份 golden：字节数与 SHA-256 全部不变，`golden-check.ts` 全 `OK`
（`broad-clean` 5 567 000 B / `c1196c58cf9f633c` … `clean-9600.ABBREV` 567 576 B / `c59fbfae34cb4232`）。

### 新增测试

`packages/protocol/test/stride-counted-arrays.test.ts`（8 项）：四条各自断言「字典 stride」与
「`packedStructSize`」，`walkArray` 的元素起点（`SBAS17` 1/2/3 个元素、`ETHSTATUS` 长/短 MAC、
`SAVEDSURVEYPOSITIONS` 4/1 字符 id、`WIFINETLIST` 24/52/68），以及上面那些**套件行原文**
（ASCII 逐字节 + 4 条 ABBREV 块）。

### 剩余（为什么这里就停）

- **没有真机样本**：这四条报文这台机器抓不到（`SBAS17` 是 ASYNCH，另三条在这套固件/配置下不出），
  全部结论来自套件对合成帧的转换。真机一旦出现 `count ≥ 2`，应当拿它再验一遍——尤其是 MAC / SSID
  的满宽形状，本节只是证明「满宽时是 28 / 68」和「不满宽时按内容」。
- **`ANTENNATYPE` / `USERANTENNA` 的 `pc_cs`**（dense stride 16，`packedStructSize` 92）现在也会
  按 92 走：这两条是配置报文，14 份抓包里没有，合成帧也没做（它们的 `pcv` 是 19 个定长元素，
  套件是否真的按 92 读没有证据）。规则是对的（固定元素 = 结构体），但**没有 oracle 背书**，
  记为已知缺口。**→ §9.x.20 已用合成 `count = 1/2` 帧补上 oracle：92 字节元素、`pco` +4、
  `pcv` +16、尾部无字段。**
- `%` 短 ASCII、越界读这些既有差异不变（§9.x.14「剩余」）。

## 9.x.19 文本 → 二进制：`-b` 把 ASCII 记录重新编码成帧（2026-11-02）

`Convert -b` 不是「复制 SBF 帧」：它把每条**打得出文本的**记录重新序列化。b1 的 `-b` 因此比它的
SBF 记录多出 99 条帧，b7 多出 431 条。逆推方法是拿套件自己的 `-b` 产物当 oracle：我们现有的
BINARY 产物是它的**子序列**，按顺序对齐后剩下的就是文本记录的编码结果
（`逆向/tools/probe-binary-text.ts`），再逐帧、逐字段比。

### ① 头部：九个 token → 28 字节长头

| 头字段 | 文本 | 规则 | 实测 |
|---|---|---|---|
| `messageId` | 名字（去版本字母） | 字典 id | `#BESTPOSA` → 42，`#ITDETECTSTATUSA` → 2065 |
| `messageType` | — | 固定 **0** | 全部插入帧都是 0 |
| `portAddress` | 端口名 | 套件 `nameToAddressForLog` 的地址 **& 0xFF** | `USB2` = 1696 → **160**；`USB1/USB3/NCOM1` 也都是 160；`COM1` → 32；`THISPORT` → 192；`FILE` → 224；`USB2_29` → 189；未知名 → 192（`probe-text-port.ts`） |
| `sequence` | 第 2 个 token | 十进制 | 原样 |
| `idleTimeRaw` | 第 3 个 token | `round(打印值 × 2)` | `76.5` → 153 |
| `timeStatus` | 第 4 个 token | `GPSTimeStatus` 枚举反查 | `COARSESTEERING` → 120、`SATTIME` → 200、`UNKNOWN` → 20 |
| `week` | 第 5 个 | 十进制 | 原样 |
| `milliseconds` | 第 6 个 | **截断** `double × 1000` | `2.018` → **2017**、`2.022` → 2021（不是四舍五入） |
| `receiverStatus` | 第 7 个 | 8 位 hex | `03801800` → `0x03801800` |
| `reserved`（报文定义 CRC） | 第 8 个 | 4 位 hex | `cdba` → `0xcdba` |
| `softwareVersion` | 第 9 个 | 十进制 | 18278 |

端口 160 回读时打印成 `SPECIAL`（不是 `USB2`）：b1 的 golden 里 51 行 `#BESTPOSA,SPECIAL` 是
**二进制**帧，39 行 `USB2` 才是文本记录——地址只有一个字节，`USB2` 的 1696 被截掉了。

### ② 正文：按字段类型回写，`pack(4)`

- `f64` = 打印十进制**最近的 double**；`f32` = 该 double 再 `Math.fround`。这不是「复制相邻帧」：
  b1 的 `#BESTPOSA` 打印 `30.53997306366`，编码出 `0024b9ac3b8a3e40`；同一测量值的接收机二进制帧
  是 `cc20b9ac3b8a3e40`（低 3 位不同）。文本记录独立编码时（`probe-oracle-binary-text`）套件也给
  `0024…`，证实它读的是文本。
- 枚举按**名字**查表；查不到的名字写 **`max + 1`**（表的非法哨兵）：`CommPort` 的 `LCOM1/LCOM4/
  BOGUSNAME` → 53（表最大 52），`InterfaceMode` 的未知名 → 69（最大 68）；`COM5` → 31、
  `UNKNOWN` → 5（`probe-text-enum.ts`）。
- `bool`：`TRUE/FALSE` → 1/0；`%m`：名字 → id（`A` 后缀带 `0x200000`、`B` 后缀不带、无后缀带
  `0x400000`）；`%T`：秒 → 毫秒；`%c`：字符 → 码点；`%x/%X/%XB/%B` 按 hex，其余十进制。
- `STRING`：NUL 结尾、零填充。固定宽度的装不下 → 套件**整条丢弃**（`base_id` 写 `"ABCDEF"` 无
  输出），我们同样失败上报；`variable` 的按 4 字节对齐（`SETNAV` 的 `"FROM"` 占 8 字节，`"TO"`
  占 4 字节，payload 52 B）。
- 数组：先写 count 前缀（u8/u16/u32），元素从 `at + countSize` 开始，固定元素按 `pack(4)` 结构体
  步长（RANGE 44 B/元素），含 `variable` 字符串的按内容重走。`%Z` 是一个小写 hex token，`%P` 是
  一个转义 token（`\xNN`、`\\`），两者都只占一个 token。
- 正文 token 不够时套件丢掉整条记录（与 ASCII 输出同一闸门），我们同样不写，并记一条失败。

### ③ `%R`：`RXCONFIG` 的 payload 是内嵌报文的整帧

b7 的 `#RXCONFIGA` 正文是一条 `#ELEVATIONCUTOFFA,…*crc`。套件把它编码成 44 B 的 SBF 帧，连头带
CRC 一起放进外层 payload（`aa44121c c70600a0 …`），外层帧头用外层表头。

**内层帧的 CRC 是按位取反的**：内层 plain CRC 是 `b916e5b3`，套件写 `46e91a4c`；外层 `RXCONFIG`
的 CRC 仍是 plain。这与 ASCII 里内嵌 `*crc` 用 `~CRC32` 是同一规则（§9.x.17③）。

### ④ 数字

| 输入 | 套件 | 我们 |
|---|---:|---:|
| b1 `-b` | 2 623 374 B | **2 623 374 B**，sha256 `b40f10277c72403d…` |
| b7 `-b` | 473 262 B | **473 262 B**，sha256 `55074c977f67bd6c…` |
| b2/b3/b4/b5/b6 `-b` | — | 逐字节相同（这几份没有可渲染的文本记录） |
| `live-nav` / `live-nav2` / `remote-23types` `-b` | — | 逐字节相同（1 546 904 / 1 472 250 / 2 018 742 B） |

文本记录的分布（= 插入帧的分布）：b1 `BESTPOS 39 / RANGE 26 / SATVIS2 24 / RXSTATUS 6 /
TIMESYNC 2 / HWMONITOR 2`；b7 `RXCONFIG 247 / ITPSDDETECT 90 / ITDETECTSTATUS 47 /
ITPSDFINAL 47`。b7 另有 22 条 `#RXCONFIGA` 的内嵌报文名不在字典里，ASCII 与 BINARY 都丢弃，
Summary 记 `269 → 247`。

### ⑤ 代码与测试

- `packages/protocol/src/binary-log.ts`：`encodeRecord` / `collectBinaryRecords`（后者在
  `text-log.ts`，与 `textLogLines` 共用同一套闸门）。
- `convert-pipeline.ts#binaryBlocks` 在帧序里把文本记录编码回原位；`unencodedText` 汇报失败。
- `packages/protocol/test/text-to-binary.test.ts`（12 项）：两个整文件 sha256、`--decimate=5` 的
  130 048 B、七类记录逐字段头部、BESTPOS/RANGE/SATVIS2/RXSTATUS/TIMESYNC/HWMONITOR 正文字节、
  固定与变长字符串、`%R` 内嵌帧与取反 CRC、三条失败路径。
- 探针：`probe-binary-blocks.ts`（逐帧定位差异，并打印该帧来自哪条文本记录）、
  `probe-binary-captures.ts`（一键跑套件比 sha）、`oracle-binary-text.ts`、`probe-binary-lookup.ts`
  （证明套件读文本而不是抄相邻帧）、`probe-text-{port,enum,string,layouts}.ts`。

### ⑥ 剩余 / 未确认

- 目录里没有的文本记录类型（如 `RAWALM`、`CLOCKMODEL`、`LOGLIST` 的 `%m`、`SETNAV` 的变长
  字符串）用**合成文本捕获**逐字节量过（`probe-text-layouts.ts` 六种全等），但没有真机样本。
- `%P` 的 count 前缀：合成 `PASSCOM1` 里套件写的是**转义后 payload 的长度**（5），我们跟它；没有
  真机 `PASSTHROUGH` 文本记录可验。
- 未知端口名的回退（192）来自一次合成探测；套件是否对某些名字另有规则没有穷举。
- 一条正文里有两个 `%R` 时套件只转第一个（ASCII 侧已如此），编码器沿用这个上限。

## 9.x.20 台账 A5 的两条：`%P` 的**文本侧**与 `pc_cs` 的 92 字节元素（2026-11-02）

台账 `18_1比1差距台账.md` 的 A5/J5 记着两条"没有 oracle"的边角。这一轮不再靠推断：两处都改为
**合成记录喂本机套件**，逐字节对。探针两个，都可以直接跑：

```
node 逆向/tools/oracle-pc-cs.ts            # 6 例，exit 0 = 全部与套件逐字节
node 逆向/tools/oracle-passthrough-text.ts # 27 例，同一份抓包跑 -a / --abbrev / -b
```

### ① `pc_cs`（`ANTENNATYPE` #2281 / `USERANTENNA` #2282）：92 是对的

字典给这个数组标的 `stride` 是 **16**，而成员加起来是 **92**（`frequency` 0..4、`pco` 4..16、
`pcv` 16..92）。这两条配置日志在 14 份抓包里一条都没有，`count = 1` 又分不出"16 字节元素"
和"92 字节结构体"，所以 §9.x.18 只把 92 记为"规则对、无背书"。

合成 `count = 1 / 2` 帧，每个元素每个成员写 `1000 × (元素号+1) + 10 × 成员号`，套件的行是：

```
ANTENNATYPE count=1  …;ADD,USER,"ANTENNA-ONE",1,GPSL1,1010.00,…,1220.00*3b98918c
ANTENNATYPE count=2  …;…,2,GPSL1,1010.00,…,1220.00,GPSL2,2010.00,…,2220.00*4a613aef
USERANTENNA count=1  …;USER,"USER-ANT-ONE",1,GPSL1,1010.00,…,1220.00*409aa1b3
USERANTENNA count=2  …;…,2,GPSL1,…,1220.00,GPSL2,2010.00,…,2220.00*c83da631
```

- 第二个元素在 `28 + 92 = 120`（ANTENNATYPE）/ `24 + 92 = 116`（USERANTENNA）才开始读；若按字典的
  16 走，`GPSL2` 那一段会读到第一个元素的中段，值全错——所以这不是"两种读法碰巧一样"。
- `pco` 读在 +4、`pcv` 在 +16，最后一个成员（`pcv[18]`）在 +88：上面 `1220.00 / 2220.00` 就是它。
- `pc_cs` 是最后一段，**尾部没有字段**：在最后一个元素后塞 4 字节哨兵（`0x51ab`），套件输出与
  不塞时逐字节相同。所以"尾部 `t0`"这一项在两条报文里不成立（没有尾字段），不是漏读。
- ABBREV 侧同样是每个元素一行（`<          GPSL1 …` / `<          GPSL2 …`），两个定长数组
  （`pco` / `pcv`）留在元素行上。

结论：**`pack(4)` 92 字节的读法正确，`edie.ts` 不需要改**；`pc-cs-geometry.test.ts`（6 项）把
上面四行、ABBREV 块、元素起点和尾部哨兵钉住。

### ② `%P`：文本侧是"按字节数读 + 重新转义"，不是"复制一个 token"

`%P` 的**二进制 → 文本**方向早就有 oracle（一个 `PASSCOM1` 帧装下全部 256 个字节值，
`ascii-log.ts#escapePassThrough`）。缺的是**文本 → 文本 / 文本 → 二进制**：接收机自己写出来的
`#PASSCOM1A,…` 长什么样没人见过，而套件对文本记录是"解析后重打"，不是原样拷贝。

手写 27 条 `#PASSCOM1A` / `#PASSTHROUGH` / `<PASSCOM1` 记录（CRC 按 `#` 后全部字节算），
每条都跑套件 `-a`、`--abbrev`、`-b`，结论一条一条是测出来的：

| 输入字段 | 套件输出 | 说明 |
|---|---|---|
| `4,\xED\xFF\xF7\xB9` | `4,\xed\xff\xf7\xb9` | 大小写归一 |
| `2,\q` | `2,\\q`（字节 `5c 71`） | 不认识的转义 = 字面反斜杠 + 下一个字符 |
| `3,a,b` | `3,a,b`（字节 `61 2c 62`） | **逗号是 payload 字节**，不是分隔符 |
| `3,a*b` | `3,a*b` | `*` 也不是分隔符 |
| `3,a b`（`<` 形式） | `3,a b`（`61 20 62`） | 空格同样是 payload 字节 |
| `2,abcd` | `2,ab` | 按 count 截断，多出来的丢弃 |
| `0,abc` | `0,` | count = 0 时后面的 token 被吞掉 |
| `8,abc*19fc1fdc` | `8,abc*19fc*6ce17c80` | 越过正文继续读**记录自己的 CRC 串**，再重算 CRC |
| `1,<裸 0x09>` / `0x7F` | `1,\x09` / `1,\x7f` | 裸控制字节重新转义 |
| 任意位置出现裸 ≥ 0x80 | **整条不输出**（三种格式都没有） | 0x80 / 0xE9 / 合法 UTF-8 的 `C3 A9` 一样；同包里好的那条照常输出 |

即：payload 是**「count 个字节」**，从 count 后面的原文开始读，`\xNN`/`\\` 边读边解码，读完
`count` 个字节停；打印时再走一遍 `escapePassThrough`。所以反斜杠、控制字节、大小写都被规范化，
而逗号/空格/`*` 原样保留。

`<` 形式（`<PASSCOM1 <9 个头>\r\n<     4 \xED…`）规则完全一样：ASCII 重打成 `#PASSCOM1A,…`，
ABBREV 重打成同样的两行，`-b` 也按同一段字节编码。

实现（只在 `text-log.ts`，`binary-log.ts` 一行没动）：

- `TextBodySource`：给每条记录留下**原文**与每个 token 的字符偏移（`#` 的原文从 `;` 后开始、
  含 `*crc`；`<` 是多行用 `\n` 连起来），`passThroughField()` 就靠它按字节数读；
- `renderBody`（ASCII）、`walkAbbrev`（ABBREV）、`encodeHashLog` / `encodeTextLog` 共用这一个读法；
- `collectBinaryRecords` 把 `%P` 的 payload token 换成 `passThroughField` 的单个转义串
  （`rewritePassThroughBody`），`binary-log.ts` 的编码器因此写出的正是套件那串字节；
- `#` 与 `<` 各加一道 ASCII 闸门（`passThroughAscii` / `collectTextLogs`），裸 ≥ 0x80 的整条
  丢弃，与套件一致——接收机自己写记录时会把这类字节转义，所以真机样本永远不会撞上。

测试：`passthrough-text.test.ts`（9 项）钉住上表每一行、`<` 形式的三种形状、`PASSTHROUGH`
的端口枚举，以及"高字节整条丢弃 / 好记录照常"。

### 仍然没做到的

- **count 大到越过整行**：`13,abc` 这种，套件把行尾的 `\r` 也当成第 13 个字节
  （`13,abc*ec5b0c61\x0d`），我们读到记录文本末尾就停（少一个 `\x0d`）。这需要把行终止符也
  纳入读取缓冲，而接收机不会写出 count 超过 payload 的记录，故意没做。
- **真机 `PASS*` 样本依旧没有**：29 条 `PASS*` 里这台 OEM729 只有 `PASSCOM3` 真在转发
  （b5，一条，走的是二进制帧那条已验的路）。文本形态的结论全部来自合成记录。



