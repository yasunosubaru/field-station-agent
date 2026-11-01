
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

