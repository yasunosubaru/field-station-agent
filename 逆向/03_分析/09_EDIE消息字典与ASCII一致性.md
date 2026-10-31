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

**端口分布**（顺带核实）：`0xA0`（SPECIAL，组首）只用来出星历；`0xBD`（SPECIAL_29）是这批抓包的
常规日志口（BESTPOS/RANGE/RXSTATUS/RAWEPHEM/HWMONITOR/PORTSTATS）。这与 payload 首字节无关，
纯粹是 SBF 长头第 7 字节的 port address。