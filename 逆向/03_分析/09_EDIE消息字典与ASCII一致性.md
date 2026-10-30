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

复现：`node packages/cli/src/verify-ascii.ts <golden.ASCII> <capture.bin>`（在工作区
`逆向\04_重实现` 下）。

结论的意义：ASCII 侧数值、枚举名、十六进制字、布尔、字符串、以及每条日志的全部重复块都与原版
逐字段一致 —— 解码不存在「差不多」。

## 5. 仍未完成的部分

1. **浮点文本尚未逐字节相同**。比对器按「四舍五入到同样位数」判定（`%7.4lk` → 0.0124），
   因为 `k/lk` 系列的写法在原版里是 `%f`-取位数 + 极小值转科学计数的混合（`%7.9lk` 打
   `5.221136984e-10`），尚未从二进制里读出确切规则。要产出 **字节级相同** 的 ASCII 文件，
   还差这一层格式化规则。
2. **ASCII 行头与 CRC**：`#NAME,port,seq,idle,timeStatus,week,ms,status,crc` 已有 `ascii.ts` /
   `crc.ts` 的实现，但尚未用 golden 做整行比对。
3. **其余 596 条报文**：字典已全部生成，只有抓包里出现的 12 类做过真机验证。

## 6. 外部参考

| 事实 | 出处 |
|---|---|
| 报文布局、ASCII 转换串、枚举词表 | `01_解包/app/Edie/messages_public.json`（`meta.subset = all`, `version 0.3.0`） |
| 字段语义与单位 | `00_来源/手册文本/OEM7-Commands-and-Logs-Reference-Manual.txt` §3.x |
| 真机输出 | `00_来源/samples/convert/golden-broad-ascii/broad-clean/Converted_On_20261030_T1800/ASCII/broad-clean.ASCII` |
| 原始抓包 | `00_来源/samples/convert/broad-clean.gps` |
