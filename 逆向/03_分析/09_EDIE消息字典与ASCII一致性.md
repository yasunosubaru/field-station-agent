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
