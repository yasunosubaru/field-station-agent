# Convert 组件（含命令行模式）

> 本文覆盖 NovAtel Application Suite 2.11.0 解包产物中与 Convert 相关的**全部** JS/HTML/BAT/EXE 文件。
> 事实等级与引用格式遵循 `03_分析/_约定.md`。行号以 `01_解包/app/**` 原始文件为准。
>
> **已覆盖文件清单**（逐个读过，无遗漏）：
>
> | 文件 | 大小 | 角色 |
> |---|---|---|
> | `view/convert/convert.js` | 192 338 B / 3424 行 | GUI 主体（渲染进程） |
> | `view/convert/convert.html` | 32 900 B / 526 行 | GUI 片段（由 index.html `.load()` 注入） |
> | `view/convert/cli.js` | 43 184 B / 983 行 | **真正做转换的入口**，GUI 与 CLI 共用 |
> | `view/convert/edieConvertAPI.js` | 1 986 B / 52 行 | 子进程脚本，把 JSON 喂给原生模块 |
> | `main.js` | 16 321 B | 主进程；`checkIfCalledViaCLI` 分流 |
> | `package.json` / `Components.json` / `index.html` | — | 组件开关与脚本加载 |
> | `model/NovatelIdConstants.js` | — | `GPStoUTCcorrection`、同步字节、二进制头长度 |
> | `Edie/logger_config.toml`、`Edie/messages_public.json`、`Edie/waasg-III_messages.json` | 1.6 KB / 7.2 MB / 199 KB | 原生模块的日志定义与日志器配置 |
> | `Edie/windows/edie-node-wrappers.node`（3.5 MB）、`Edie/pimtpaddon.node`（5.9 MB） | — | 转换引擎本体（二进制） |
> | `Edie/hatanaka/windows/rnx2crx.exe` | 280 KB | Hatanaka 压缩外部工具 |
> | `shortcuts/Unzip/node.exe`（26 MB）、`node_modules.zip`、`createShortCuts.js/.cmd`、`decompose.js/.cmd` | — | 便携版部署脚本 + 子进程解释器 |
> | `tosrec.exe`（737 280 B）、`datablk.exe`（155 648 B）、`LoadConfig.bat`、`createHex.bat` | — | **不属于 Convert**，见 §4.7 / §5.5 |
>
> **实测方法说明**：`tosrec.exe` / `datablk.exe` 为闭源 PE，`rea inspect-binary-layout` 报
> `capability_unavailable`（仅支持 Linux ELF），因此改用「静态 strings 提取 + 在
> `%TEMP%\opencode\tosrec_probe` 里对两份 exe 做黑盒样本实验」的方法确定参数与输出格式。
> 下文所有 exe 行为均为**实测复现**，不是猜测。

---

## 1. 职责

Convert 把 NovAtel 接收机记录下来的日志文件（ASCII / 二进制 / 缩写 ASCII）在格式之间互转，
并可选择日志、时间窗、抽稀、拆分、未知字节处理、输出目录与前后缀。

- `[观察]` GUI 只做三件事：① 采集用户选择，拼成一份 JSON 请求；② 起子进程调用原生模块；
  ③ 轮询进度文件并渲染汇总。**真正的解析/编码一行 JS 都没有**。
  `01_解包/app/view/convert/convert.js:2185-2206`、`01_解包/app/view/convert/convert.js:3382-3416`
- `[观察]` CLI 走同一条链路：`cli.js` 自己 `require` 原生模块并**在进程内**调用
  `Convert()`，不经过 `edieConvertAPI.js` 子进程。
  `01_解包/app/view/convert/cli.js:16-19`、`01_解包/app/view/convert/cli.js:29-40`
- `[观察]` 组件开关：`Components.json` 中 `"convert":1`；
  `index.html` 在 `components.convert == 1` 时才注入 `convert.html`。
  `01_解包/app/Components.json:1`、`01_解包/app/view/html/index.html:1084-1087`、
  `01_解包/app/view/html/index.html:1125`

**一句话结论**：Convert 是一个「配置收集器 + 结果渲染器」，格式编解码 100% 在
`Edie/windows/edie-node-wrappers.node` 里，纯 JS 无法单独复现任何一条转换。

---

## 2. 入口与加载顺序

### 2.1 GUI 路径

```
index.html  <script src="../convert/convert.js">      index.html:173
   ↓ 用户点侧栏 Convert（convert App 的 landing 页）
$('.convert-landing-screen').load("./../convert/convert.html")   index.html:1125
   ↓ 用户拖入/选择文件
frameFileInfo()  → edieAPICall(readmessage)                      convert.js:1326-1356
   ↓ 选择日志 → 选择格式 → Convert 按钮
format-convert-button click → showConversionProgress()
                            → edieAPICall(convert)               convert.js:1876-1997
```

- `[观察]` `convert.js` 是 IIFE，末尾只导出 5 个符号：
  `processLanguage / resetData / getConvertObj / setConvertDataObj / conversionSummary`。
  `01_解包/app/view/convert/convert.js:3417-3424`

### 2.2 CLI 路径

```
NovAtelApplicationSuite.exe <file> [options]
   ↓ app.on('ready') → createWindow()                            main.js:156
   ↓ isCalledViaCLI = checkIfCalledViaCLI(process.argv)           main.js:79
   ↓ require("./view/convert/cli.js").executeCLI(process.argv)    main.js:85
   ↓ yargs(process.argv) 解析                                     cli.js:298-328
   ↓ validateOptions() 选输入文件、算 iConversionType              cli.js:65-125
   ↓ getInputFileData() → getLogCount(readmessage)                cli.js:402-412
   ↓ frameConversionObj() 拼请求                                  cli.js:173-293
   ↓ convertLogs() → Convert()                                   cli.js:29-40
   ↓ updateCmdInfo() + fileSummaryTxt() → process.exit()          cli.js:432-444
```

- `[观察]` CLI 分支**仍然创建 BrowserWindow**（`createWindow` 先 `new BrowserWindow`，
  后判断 CLI），只是不 `loadURL`。因此 CLI 跑起来会闪一个不可见窗口，
  且依赖 Electron 运行时（`cli.js:6` 就 `require('electron')`）。
  `01_解包/app/main.js:81-85`、`01_解包/app/view/convert/cli.js:6`
- `[观察]` `package.json` 的 `bin` 直接指向 `view/convert/cli.js`，但该文件 `require('electron')`
  与 `app-root-path`，用裸 `node` 执行会失败。`01_解包/app/package.json:7-8`

### 2.3 原生模块与资源路径（两套，Windows/Linux 不同）

- `[观察]` Windows：
  - 日志定义 `${app.asar.unpacked}/Edie/messages_public.json`（OEM）或
    `Edie/waasg-III_messages.json`（G-III）
  - 日志器配置 `Edie/logger_config.toml`
  - 原生模块 `Edie/windows/edie-node-wrappers.node`
  - 子进程解释器 `shortcuts/Unzip/node.exe`
  - `convertObj.json` / `convertProgress.txt` 固定写 `%APPDATA%\NovAtelApplicationSuite\`
  `01_解包/app/view/convert/convert.js:10`、`:24-28`、`cli.js:10-19`
- `[观察]` Linux：改用 `app.getPath('userData')`，并**真正使用 argv 传路径**
  （`edieConvertAPI.js:21-23`）；Windows 分支完全忽略 argv，只认 APPDATA 里的固定文件。
  `01_解包/app/view/convert/edieConvertAPI.js:13-24`

---

## 3. 数据结构

### 3.1 转换请求 `fileList_obj`（交给原生 `Convert()` 的唯一输入）

字段来自 `frameConversionObj()` 与 GUI 的按钮处理器，两者字段集合略有差异（下表标注）。

| 字段 | 类型 | 单位/取值 | 来源 | GUI | CLI |
|---|---|---|---|---|---|
| `decimationFilter` | string \| number | **秒**（抽稀周期） | GUI 传 `1/采样率Hz`；CLI 传 `--decimate` 原值 | ✔ `:1922` | ✔ `:220` |
| `unconvertedBytes` | string | `SEPARATEFILE`\|`INTERLEAVE`\|`SKIP` | UI 选项/`--unknown-bytes` | ✔ | ✔ `:161-164` |
| `outputPath` | string | 绝对路径 | 目标目录 | ✔ | ✔ |
| `isCLIEnabled` | bool | 有 `--exclude` 时 **false** | CLI 特有 | ✘ | ✔ `:223` |
| `isCLI` | bool | 有 `--dd/--md/--dm` 时 true，「不建 format_timestamp 目录」 | CLI 特有 | ✘ | ✔ `:216-217` |
| `logDefPath` | string | messages_public.json | 常量 | ✔ | ✔ |
| `configfilePath` | string | logger_config.toml | 常量 | ✔ | ✔ |
| `Logfiletype` | string | `OEM` \| `G-III` | 接收机类型 | ✔ | ✔ |
| `outputFileName.valid` | bool | 前缀/后缀是否非空 | UI | ✔ | 恒 true（CLI） |
| `outputFileName.name` | string | 最多 18 字符 | UI | ✔ | 恒 "" |
| `outputFileName.type` | string | `PREFIX`\|`SUFFIX` | UI | ✔ | 恒 PREFIX |
| `fileList` | map | 键=**文件名（含扩展名）** | 每个输入文件一项 | ✔ | ✔ |
| `outputFormat` | map | 键=格式名，值=该格式参数 | 可多选 | ✔ | 恒 1 项 |

`fileList[<basename>]` 的子字段：

| 字段 | 类型 | 说明 | 引用 |
|---|---|---|---|
| `rangeSettings.CompressionType` | string | 恒 `NONE` | `cli.js:243-246` |
| `rangeSettings.deCompressionType` | bool | RANGECMP*→RANGE 展开开关；**GUI 默认 true、CLI 默认 true** | `cli.js:245`、`convert.js:59` |
| `outputFileName` | string | 输出基名（去扩展名） | `cli.js:247` |
| `InternalMap` | object | 由 `readmessage` 返回并原样回传（用途见 §9） | `cli.js:248`、`convert.js:1895-1898` |
| `filepath` | string | 输入绝对路径 | `cli.js:249` |
| `messageFilter` | string[] | 日志**名字**列表 | `cli.js:250` |
| `messageIdFilter` | string[] | 日志**编号**列表（字符串） | `cli.js:251` |
| `messageIdFilterInversion` | bool | **true = 该列表是要排除的** | `cli.js:252` |
| `messageNameFilterInversion` | bool | 同上（名字维度） | `cli.js:253` |
| `timeInterval` | `{startTime,endTime}` | 每项 `{week:int, msec:int}`，**msec 实为秒** | `cli.js:276-289` |
| `firstLogStartTime` | string(2) | RINEX 专用，`getUTCYear()` 的两位年份 | `cli.js:417-418`、`convert.js:1964-1969` |

`outputFormat[<FMT>]`：

- 非 RINEX：`{fileSplitting: bool, splitBy: "LOGS"|"SIZE"|"TIME"|"DAILY"|"NONE", splitFreq: number}`
  `01_解包/app/view/convert/cli.js:236-240`、`convert.js:1950-1961`
- RINEX（合并写一次）：`{forceKinematicFlag, useHatanakaComp, utcOffset(秒,字符串), headerInfo{companyName,comments,markerName,markerNumber,observer,agency,receiverName,receiverVersion,antennaNumber,antennaType}}`
  `01_解包/app/view/convert/convert.js:880-896`、`cli.js:256-273`

> ⚠ `[观察]` GUI 里 **11 个 RINEX 版本共用同一份 `RINEX` 设置对象**（键名 `RINEX` 只在
> `userChangedData` 里存在一份），而提交时把同一对象复制给每个选中的 `RINEXv*` 键。
> `01_解包/app/view/convert/convert.js:1950-1954`

### 3.2 `readmessage` 返回

```
{ Filename, TimeInterval:{FirstLog:{week,msec}, LastLog:{week,msec}},
  Message:{ <LOGNAME>: {ID:int, COUNT:int}, ... }, InternalMap }
```
- `[观察]` 用到的键：`Filename`、`TimeInterval`、`InternalMap`、`Message[*].ID/.COUNT`。
  `01_解包/app/view/convert/convert.js:414`、`:1896-1898`、`cli.js:414`、`:248`
- `[观察]` 一次调用返回**多文件**：`Object.values(fileInfo)` 的长度必须等于送进去的文件数，
  否则不进入校验。`01_解包/app/view/convert/convert.js:1344-1348`

### 3.3 `Convert` 返回（每次回调一个 `(文件, 格式)` 组合）

```
{ Filename, Format, Message:{ <LOG>: {ID, COUNT} },
  ConvertedBytes, UnConvertedBytes, TimeStampInfo,
  TimeFilterStatus?: { <LOG>: {COUNT} } }
```
- `[观察]` `TimeStampInfo` 是「转换时间戳目录名」，用于拼摘要路径。
  `01_解包/app/view/convert/convert.js:2027`、`cli.js:713`
- `[观察]` `TimeFilterStatus` 仅在用了时间窗时出现，表示**窗内**的源计数。
  `01_解包/app/view/convert/cli.js:556-563`
- `[观察]` 累加口径：`successBytes += ConvertedBytes`，`failedBytes += UnConvertedBytes`。
  `01_解包/app/view/convert/convert.js:2351-2365`

### 3.4 进度文件 `convertProgress.txt`

```
{ "<Filename>": { "<FORMAT>": { "Percentage": <0..100> }, ... }, ... }
```
- `[观察]` 缺 `Percentage` 即视为 100%。进度条取**所有 (文件,格式) 键的算术平均**，
  `parseInt(sum / n)`。`01_解包/app/view/convert/convert.js:2185-2193`、`:3399-3409`

### 3.5 GUI 设置对象 `formatDefaultSettings`（全量默认值）

`[观察] 01_解包/app/view/convert/convert.js:50-103`

| 键 | 默认 |
|---|---|
| `sampleRate` | `""`（=不抽稀） |
| `unconvertedBytes` | `SEPARATEFILE` |
| `destinationType` | `SOURCE` |
| `prefixSuffixName` / `prefixSuffixType` | `""` / `PREFIX` |
| `rangeProperties.decompression` | `true`，`perFile:{}` |
| `ASCII.fileSplitting` / `splitBy` | `true` / `LOGS` |
| `BINARY.fileSplitting` | `false` |
| `ABBREV_ASCII.fileSplitting` | `true`（**G-III 时被重置为 false**，`convert.js:984`） |
| `KML.fileSplitting` | `false`，且 UI 上开关被强制禁用 `convert.js:569-571` |
| `RINEX.*` | `forceKinematicFlag:false, useHatanakaComp:false, utcOffset:'0'`，10 个表头字段全 `""` |

### 3.6 `Edie/messages_public.json`（日志定义库）

`[观察]` 顶层三个键：`enums`（240 条）、`messages`（608 条）、`meta`。
`[观察]` 每条 message 形如
`{_id, name, messageID, messageStyle:"OEM4_MESSAGE_STYLE", messageType:"LOG", latestMsgDefCrc,
  fields:{ "<headerCrc>": [ field... ] }, path, rateRestriction, throttled, saveconfigable}`；
每个 field 关键字段：`name`、`type`（`SIMPLE`/`ENUM`/`FIXED_LENGTH_ARRAY`/…）、
`dataType{name,length}`、`conversionString`、`enumID`、`arrayLength`、`bitMasks`、`path`。
例：BESTPOS 的 `latitude` → `dataType{name:DOUBLE,length:8}, conversionString:"%7.11lk"`。
`01_解包/app/Edie/messages_public.json:1`（单行，7 234 808 B）

> 这张表就是 **ASCII / 缩写 ASCII 的输出格式规则来源**：`conversionString` 是类 printf 模板，
> `dataType.length` 是二进制字段宽度，`enumID` 指向 `enums[]` 做数值→枚举名映射。
> `[推断]` 因此「四舍五入规则」由 `conversionString` 的小数位决定（`%7.11`=11 位、`%.4`=4 位），
> 不是全局统一规则。推理链：字段级模板 + 每个字段模板不同 + 原生模块只拿到这张表。

### 3.7 摘要文件 `Summary_<文件名>.txt`

`[观察]` 纯文本、`\n` 换行、UTF-8 无 BOM，结构为
`转换时间 / 输入文件+字节数+目录 / 输出目录 / GNSS 时间(week,秒) / UTC 时间(ISO) / 总时长 /
每格式一张定宽表 (ID|Name|Source #|Output #) / "N bytes could not be converted."`。
`01_解包/app/view/convert/cli.js:757-768`、`:770-855`、`convert.js:2068-2174`

### 3.8 `datablk.exe` 数据块头（Header Version 2，140 字节）— 实测所得

| 偏移 | 长度 | 含义 | 证据 |
|---|---|---|---|
| 0 | 2 | `ComponentEnum`，u16 LE（`LoadConfig.bat` 传 11） | 传 12 时该处变 0x000C |
| 2 | 2 | 常量 `0x3A7A`，改动 block#/align/name 均不变 | 见 §9 未解 |
| 4 | 4 | **存储**的数据长度 u32 LE（压缩时为压缩后长度） | raw=40 / compress=48 |
| 8 | 4 | 存储数据的 CRC32（算法见 §5.5），压缩时算**压缩后**字节 | 已复算一致 |
| 12 | 4 | **原始**数据长度 u32 LE | raw/compress 均为 40 |
| 16 | 2 | Header Version = 2 | `datablk` 自报 "Header Version: 2" |
| 18 | 4 | Header 长度 = 140（**不随 Align 变**） | align=512/4096 时仍为 140 |
| 22 | 2 | 保留 0 | — |
| 24 | 4 | 头部 CRC32（0..140，**计算时本字段置 0**） | 已复算一致 |
| 28 | 16 | `Name`（≤15 可见字符 + NUL 补齐） | 传 `OTHER` 时此处变 |
| 44 | 16 | `Version` | 传 `9.9.9` 时此处变 |
| 60 | 16 | `SNKey` | 传 `ABC123` 时此处变 |
| 76 | 32 | 全 0，**`Platform` 参数不写入头部** | 传 `OEM719` 后头部逐字节相同 |
| 108 | 12 | `CompileDate` `yyyy/Mmm/dd`（**仅校验格式，不校验范围**：`2024/13/01` 原样写入） | 实测 |
| 120 | 9 | `CompileTime` `HH:MM:SS`（`25:61:61` 原样写入） | 实测 |
| 129 | 11 | 0 | — |

数据区起点 = `max(140, Align)`；`Align > 140` 时用 `0xFF` 填充（实测 512→偏移 512，填充 0xFF；
64/100/128/139/140 均不产生填充）。

---

## 4. 接口清单

### 4.1 `main.js: checkIfCalledViaCLI(args)` → bool

`[观察] 01_解包/app/main.js:24-32`

```
args 存在 && args.length > 1
  && args[0].toLowerCase().includes("novatelapplicationsuite")
```

- 只看 **argv[0]（exe 全路径）**是否含产品名，**不看** `args[1]` 内容。
- 因此：① exe 被改名/被复制成别的名字 → CLI 模式静默失效，弹出 GUI；
  ② `NovAtelApplicationSuite.exe --help` 也算「CLI 调用」，正常；
  ③ 从源码目录 `electron .` 启动时 argv[0] 是 electron.exe → 永远走 GUI。
- 返回 false 时走 GUI；true 时 `executeCLI(process.argv)`（注意传的是**含 argv[0] 的完整数组**）。
  `01_解包/app/main.js:84-85`

### 4.2 `cli.js: executeCLI(argv)` → void（Promise 未 await）

`[观察] 01_解包/app/view/convert/cli.js:294-391`

声明式选项（`.strict(false)`、`.help(false)`、`.version(pkg.version)`）：

| 声明 | 别名 | 类型 | 默认 | 语义/去向 |
|---|---|---|---|---|
| `format` | `f` | string | `ASCII` | 大写后与固定串比对 |
| `r3.04` | `rin`,`rinex`,`rin3.04`,`rinex3.04` | flag | — | → `RINEX3.04`（type 8） |
| `r3.03` | `rin3.03`,`rinex3.03` | flag | — | → `RINEX3.03`（type 7） |
| `kml` | `k` | flag | — | → `KML`（type 3） |
| `b` | `binary`,`bin` | flag | — | → `BINARY`（type 1） |
| `abbrev` | `abbrev` | flag | — | → `ABBREV`（type 2） |
| `decimate` | — | string | — | 直接作为 `decimationFilter` |
| `exclude` | `e` | string | — | 排除列表（逗号分隔，名字或ID） |
| `convert` | `c` | string | — | 只转列表 |
| `l` | `l`,`limit-output-size` | string | — | 按大小拆分（MB） |
| `dm` / `md` / `dd` | 同名 | flag | — | 输出目录布局 |
| `o` | `output` | string | — | 输出目录 |
| `split` | `split` | string | — | 按日志类型拆分 |
| `start-time` / `finish-time` | — | string | — | `WEEK,SECONDS` |
| `limit-duration` | — | string | — | 秒 |
| `daily-utc` | — | flag | — | 按 UTC 日切分 |
| `expand-cmp` / `no-expand-cmp` | — | flag | 展开=true | RANGECMP→RANGE |
| `verbose` | — | flag | — | 打印请求 JSON |
| `receiver-type` | — | string | `OEM` | 只接受 `oem` / `giii`（大小写无关） |

未在 yargs 里声明但被代码/别名校验接受的键（`.strict(false)` 下按未知 flag 解析）：
`r`、`a`、`h`、`help`、`rin3.*`/`rinex3.*`/`rin2.*`/`rinex2.*`、`unknown-bytes`、
`forcekinematicdataflag`、`version`。`01_解包/app/view/convert/cli.js:126-139`

**格式解析优先级**（后者覆盖前者，`cli.js:84-94`）：
`format` → `a`→ASCII → `b`→BINARY → `abbrev`→ABBREV → `r`(true→RINEX3.04, 否则 `"RINEX"+r`) →
`rin3`/`rinex3`→`RINEX3.<子键>` → `rin2`/`rinex2`→`RINEX2.<子键>` → `k|kml`→KML。
互斥性：**PDF 未定义互斥，代码是「最后命中者胜」，且 `k/kml` 优先级最高**。

**格式串 → `iConversionType` 映射**（`cli.js:97-98`）：

| 串 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| 含义 | ASCII | BINARY | ABBREV | KML | RINEX2.1 | RINEX3.01 | RINEX3.02 | RINEX3.03 | RINEX3.04 |
| 原生 `outputFormat` 键 | `ASCII` | `BINARY` | `ABBREV_ASCII` | `KML` | `RINEXv2_1` | `RINEXv3_01` | `RINEXv3_02` | `RINEXv3_03` | `RINEXv3_04` |

**任何未命中的格式串都落到 8（RINEX 3.04）**，例如 `-f rinex`（无版本号）。

**退出码**：所有错误分支都是裸 `process.exit()` → **退出码 0**（`cli.js:82,122,206,334,339,349,354,370,378,384,426,443`）。
成功路径也是 `process.exit()` → 0。真正非零只有未捕获异常（`JSON.parse("")` 等）。
`datablk/tosrec` 才有 0/1/1000 的区分，见 §4.7。

### 4.3 `cli.js: validateOptions(options)` → filePath:string

`[观察] 01_解包/app/view/convert/cli.js:65-125`

1. `isVerbose = hasOwnProperty("verbose")`。
2. **未知开关检测**：`if (typeof (options[a]) != Object && listOfSwitches.indexOf(a) == -1)`。
   注意 `typeof x != Object` 恒为 `true`（右侧是函数 `Object`，不是字符串 `"object"`），
   所以该判断退化为「键不在白名单就报错」。→ 打印 `Invald option X` 并 `exit()`。
3. `expandCmp` 与 `noExpandCmp` 同时为假 → 报 `Invalid option NO-EXPAND-CMP` 并退出。
4. 输入文件选择（两条通道）：
   - 先扫 `options._`：存在且 basename 不含 `NOVATELAPPLICATIONSUITE` → 记为输入（`cli.js:100-104`）；
   - 再扫所有非 `_/$0/o/output` 的**值**：`fs.existsSync(arg)` 即视为输入（`cli.js:106-114`）。
     ⇒ `-c BESTPOS` 里若 `BESTPOS` 恰好是同名文件，会被当成输入文件。
   - 都失败时，退化为 `rin3/rinex3/rin2/rinex2` 的**值**（`cli.js:116-118`）。
   - 仍为空 → `Please provide a file to convert` + `exit()`。
5. **只取最后一个命中的路径**：多文件输入时 CLI 只转 1 个文件。

### 4.4 `cli.js: frameConversionObj(inputFilePath, res)` → 请求对象

`[观察] 01_解包/app/view/convert/cli.js:173-293`。要点：
- `inputPath` 为 `"."` 时改写成 `process.cwd()`（`cli.js:176-179`）。
- `splitOption` 判别顺序：`limit-output-size`→`SIZE`，`limit-output-duration`→`TIME`，
  `split`→`LOGS`，`daily-utc`→`DAILY`，否则 `NONE`（`cli.js:182-183`）。
- `--output` 存在时：不存在则 `mkRecursiveDir` 递归创建，失败打印
  `Please provide valid output path to the directory` 并退出（`cli.js:199-213`）。
- `--convert`/`--exclude` 的值按 `,` 拆分，**纯数字进 `messageIdFilter`，其余进
  `messageFilter` 并转大写**（`cli.js:191-193`）。
- 时间窗：`start-time`/`finish-time` 形如 `W,S`；`W != 0 ? W : firstLogWeek`；
  `--limit-duration` 直接 `start.msec + 秒`（**不处理跨周**，`cli.js:280-282`）。
  三者任一存在才写 `timeInterval`（`cli.js:284-289`）。

### 4.5 `cli.js: updateCmdInfo()` / `fileSummaryTxt()` — 两套输出

- `updateCmdInfo()`：同步表打印到 stdout，列头 `Id | Name | count | CONVERTED`（`cli.js:483-657`）。
- `fileSummaryTxt()`：写盘 `Summary_<name>.txt`（`cli.js:688-866`）。
- `cli.js` 只导出 `executeCLI` 与 `fileSummaryTxt`（`cli.js:982-983`）。

### 4.6 原生模块 API（`edie-node-wrappers.node`）

| 导出 | 用法 | 回调语义 |
|---|---|---|
| `convertfileobject_api` | `new Edie.convertfileobject_api()` | — |
| `.readmessage(obj, cb)` | 统计日志数 | `cb(jsonString)`，**一次**，整体结果 |
| `.Convert(obj, cb)` | 执行转换 | `cb(jsonString)`，**每个 (文件,格式) 一次** |
| `inputstream_api` / `pimtpframer_api` | 不在 Convert 内使用 | 见 `view/positionConfig` |

- `[观察]` 回调参数是**字符串**，JS 侧 `JSON.parse`。`01_解包/app/view/convert/cli.js:32-33`、`:55-56`
- `[观察]` 两个 Promise 包装器**都没有 reject 分支**：原生模块不回调就永久挂起（无超时）。
  `01_解包/app/view/convert/cli.js:29-40`、`:51-63`

### 4.7 `tosrec.exe` / `datablk.exe`（**不属于 Convert**）

- `[观察]` 全仓库中唯一调用点是 `LoadConfig.bat`，而 `LoadConfig.bat` 只被
  `createHex.bat` 调用（内容就一行 `.\LoadConfig.bat %1 %2`），后者只被
  `view/positionConfig/lghn-positionConfig .js:1464` 的 `exec(...)` 调用。
  `01_解包/app/LoadConfig.bat:43`、`:51`、`01_解包/app/createHex.bat:1`、
  `01_解包/app/view/positionConfig/lghn-positionConfig .js:1464`
- `[观察]` `Convert` 的任何代码路径都没有出现 `tosrec`/`datablk`/`LoadConfig`（全仓 grep 无命中）。
- 结论：这两份 exe 属于 **Longhorn 位置配置下发**功能（生成 NovAtel DATABLOCK 固件块，
  再由 PIM 通道下发），与 Convert 无耦合。详见 §5.5。

**`tosrec.exe` 实测 CLI**（`tosrec.exe -h`，usage 打到 stderr，退出码 **1000**）：

```
tosrec.exe [infile] [-o outfile] [-s4c] [-nocomments] [-seekok] [-baseaddr]
           [-printbase] [-noprintbase] [-nobadlines] [-allbadlines] [-nolength]
```

- `[观察]` 该 usage 文本说「Converts a Motorola SRec file to a **binary** file」，**与实际行为相反**：
  实测 `tosrec in.txt -o out.hex` 是把任意字节流编码成 SREC。usage 是陈旧的。
- `[观察]` 实测**只有** `-o` / `-baseaddr <值>` / `-s4c` / `-nolength` 被接受；
  其余 `-nocomments`、`-seekok`、`-printbase`、`-noprintbase`、`-nobadlines`、
  `-allbadlines` 以及任意未知开关一律打印 usage 并退出码 1000。
- `[观察]` 无 `-o` 时 SREC 写 stdout；`-nolength` 与否在**当前实现中没有可观察差异**。
- `[观察]` 输入文件不存在 → **退出码 0**，仍创建一个只含终止记录的输出文件。
  ⇒ `LoadConfig.bat:45-48` 的 `if %ERRORLEVEL% NEQ 0` 检查永远不触发。

**`datablk.exe` 实测 CLI**（无参运行，banner+usage 打到 stderr，退出码 **1**）：

```
datablk <In SREC File> <Out SREC File> <Compress> <Block #> <ComponentEnum #>
        <Name> <Version> <SNKey> <Platform> <Align> [CompileDate] [CompileTime]
   Compress : compress | raw
   Block #  : 0..7
   Name/Version/SNKey : ≤15 非空字符
   Platform  : ≤15 非空字符（实测不写入头部，只进 S0 注释）
   Align     : 0..4096
   CompileDate: yyyy/Mmm/dd (可选)   CompileTime: HH:MM:SS (可选)
```
自报 `Executable Version: 2.29`、`Header Version: 2`；成功时 stdout 打印 banner +
`Processing <in> to <out>`，退出码 0；参数非法时打印 `<项> setting (%s) not valid` 并退出码 1。

---

## 5. 报文/协议细节

### 5.1 支持的输入形态

| 输入 | 判定依据 | 证据 |
|---|---|---|
| NovAtel **二进制**日志 | 同步字节 `0xAA 0x44 0x12`，头部 28 字节 | `NovatelIdConstants.js:442-447`、`:13` |
| NovAtel **ASCII** 日志 | 头行 `#<NAME>A <port> <seq> <week> <秒> ...` 后跟 `;` 结尾 | `[推断]` 由 `messages_public.json` 的 `messageStyle:"OEM4_MESSAGE_STYLE"` + ASCII 字段模板推得 |
| **缩写 ASCII** | 头行 `%<NAME>` + 逗号分隔字段 | `[推断]` 同上（`messageStyle` 另含缩写式） |
| G-III 二进制 | 独立定义库 `waasg-III_messages.json`，日志名带 `B` 后缀（`MEASUREMENTDATAB` 等） | `convert.js:124`、PDF p.141 |

- `[观察]` **不支持 Septentrio SBF，也不支持 RINEX/GPX/CSV 作为输入**：全仓（`*.js` 递归）
  `septentrio`、`.sbf` 均 0 命中；`readmessage` 只认 `messages_public.json` / `waasg-III_messages.json`
  两个定义库，请求里也只传这二者之一。`01_解包/app/view/convert/cli.js:10-11`、`:364-367`
- `[观察]` 输入文件必须**有扩展名**，否则弹 `... has no extension ... valid extension (e.g., .LOG, .GPS, .BIN)`
  并拒绝继续（2.11.0 新行为）。`01_解包/app/view/convert/convert.js:1769-1789`
  ⇒ 但代码**只检查有无扩展名，不检查扩展名内容**（`.txt`/`.foo` 照样能过）。

### 5.2 支持的输出形态（逐个枚举）

| UI 标签 | 请求里的 `outputFormat` 键 | 内容形态 | 备注 |
|---|---|---|---|
| ASCII | `ASCII` | NovAtel ASCII 日志（`#NAMEA ... ;`） | 默认格式 |
| Binary | `BINARY` | NovAtel 二进制日志（28 字节头） | G-III 下被禁用 |
| Abbreviated ASCII | `ABBREV_ASCII` | `%NAME,...` 缩写式 | G-III 下被禁用 |
| KML - Google Earth | `KML` | **KML（XML 文本）**，含 `<Placemark>`、`<LineString>`、`<coordinates>`、`<altitudeMode>`、图标 `placemark_circle.png` | 不是 KMZ（见下） |
| RINEX v2.1 | `RINEXv2_1` | RINEX 2.01/2.1 观测+导航 | G-III 下被禁用 |
| RINEX v3.01/02/03/04 | `RINEXv3_01…04` | RINEX 3.x 观测+导航 | 同上 |

证据：
- `[观察]` 九个复选框：`convert.html:243-316`（值 `ascii/binary/abbreviatedascii/kml/rinex` × 9 个 `select-device-btn value`）。
- `[观察]` 格式键枚举（`formatsKeyValuePair`）：`ASCII/BINARY/ABBREV_ASCII/RINEXv2_1/RINEXv3_01..04/KML`
  `01_解包/app/view/convert/convert.js:2721-2731`
- `[观察]` 原生模块内可见字符串：`.KML`（UTF-16）、`Placemark`、`LineString`、`coordinates`、
  `altitudeMode`、`http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png`
  （`Edie/windows/edie-node-wrappers.node` strings 提取，偏移见 `%TEMP%\opencode\edie.strings.txt` /
  `edie.u16.txt`）。
- `[推断]` 上述标签串属于 KML 生成器（推理链：这组标签是 KML 命名空间专有的，
  且原生模块同时只出现 `.KML` 一种地理输出扩展名）。**具体 XML 层级仍未验证**，见 §9-5。
- `[观察]` **没有 KMZ 容器、也没有 GPX/CSV 输出**：原生模块 strings 里 `.kmz`/`.gpx`/`.csv`
  命中数为 **0**；Convert 的四个 JS 文件同样 0 命中（全仓唯一的 `.csv` 出现在第三方 plotly
  打包文件里，与 Convert 无关）。⇒ 验收标准里提到的 KMZ / CSV / GPX **在本版本不存在**，
  KML 是纯文本 `.KML` 文件。
- `[观察]` RINEX v4.00 复选框被注释掉（`convert.html:317-324`）。

### 5.3 RINEX / KML 的日志白名单（决定「格式可选项」是否可点）

- `[观察]` `rinexSupportedLogs`（45 项）：`VERSION, IONUTC, BESTPOS, PSRPOS, RTKPOS, MARKPOS,
  MARK2POS, MARK3POS, MARK4POS, MARKTIME, MARK2TIME, MARK3TIME, MARK4TIME, SITEDEF, RANGE,
  RANGE_1, RANGECMP, RANGECMP_1, RANGECMP2..5(_1), GPSEPHEM, RAWEPHEM, GLOCLOCK,
  GLORAWEPHEM, GLOEPHEMERIS, GALCLOCK, GALIONO, GALEPHEMERIS, GALINAVEPHEMERIS,
  GALFNAVEPHEMERIS, QZSSIONUTC, QZSSEPHEMERIS, QZSSRAWEPHEM, BDSIONO, BDSCLOCK,
  BDSEPHEMERIS, NAVICIONO, NAVICSYSCLOCK, NAVICEPHEMERIS, SBAS9, SBAS12`
  `01_解包/app/view/convert/convert.js:117-121`
- `[观察]` `kmlSupportedLogs`（18 项）：`BESTPOS, BESTVEL, MATCHEDPOS, RTKPOS, MARKPOS,
  MARK2POS, MARK3POS, MARK4POS, PSRPOS, PPPPOS, PDPPOS, ROVERPOS, BESTGNSSPOS, MASTERPOS,
  INSPOSX, INSPOS, INSPOSS`　`convert.js:122-123`
  （PDF p.145 的清单少了 `INSPOS`/`INSPOSS`，代码比手册多两项。）
- `[观察]` `rinexSupportedGIIILogs`：`VERSION, MEASUREMENTDATA, RXCOMMANDS`　`convert.js:124`
- `[观察]` 判定逻辑：对**已勾选的日志名**与白名单求交集，交集为空则给该格式条目加
  `customDisableButton` 并取消其选中。`convert.js:1681-1716`

### 5.4 时间系统（GPS 周/秒 → UTC/本地）与坐标基准

**常量**
- `[观察]` `GPStoUTCcorrection = 18000`（毫秒 ⇒ 18 s）。`01_解包/app/model/NovatelIdConstants.js:12`
- `[观察]` 两个「GPS 起点」串：OEM `'January 6, 1980 00:00:00'`、G-III `'April 6, 2019 23:59:42'`。
  `convert.js:38-41`、`cli.js:24-27`

**GUI 显示 UTC**（`getUTCTimeFormat`，`convert.js:1016-1037`）：
```
t = new Date('January 6, 1980 00:00:00')     // ← 按「本地时区」解析，不是 UTC
t.setHours(week*7*24 + t.getHours())
t.setMilliseconds(msec*1000 - utcCorrectionMs + secs/1000)   // secs=0
显示 = `${dd} ${Mon} ${yyyy} ${HH}:${mm}:${ss} UTC`
```
- `[观察]` G-III 或 `utcCorrection=false` 时 `utcCorrectionMs = 0`。
- `[观察]` 同一文件里存在一个**未被使用**的 UTC 起点常量
  `gpsStartTime_OEM = "1980-01-06T00:00:00.000Z"`（`convert.js:18`），说明修正未落地。
- `[推断]` **缺陷**：因为起点串按本地时区解析，输出串实际是「本地时区的 GPS 时间 −18 s」。
  在 UTC+8 机器上显示的 UTC 比真 UTC 快 8 小时；且 `setHours` 走本地夏令时规则，
  跨 DST 边界还会再多/少 1 小时。推理链：`new Date('...')` 无 `Z` 后缀 → 本地时间
  （ECMAScript Date Time String Format 之外由实现解析，V8 按本地时间）。
  **算例**（机器时区 UTC+8）：`week=2345, msec=123456` →
  真 UTC = `1980-01-06T00:00:00Z + 2345*604800 s + 123456 s − 18 s = 2024-12-16T10:17:18Z`，
  而本函数在 UTC+8 机器上打印 `16 Dec 2024 18:17:18 UTC`。

**UTC 输入 → GPS 周/秒**（`getGPSTimeFromUTC`，`convert.js:1094-1112`）：
```
time = Date.parse(utcStr) - Date.parse(gpsStartTime[type])   // ms
if (本机有 DST) { time += getDST(parsedUTC);  若 IANA 时区=="America/Anchorage" 则 *=2 }
time += 18000                                                 // +18 s（ms）
week = parseInt(time / 604800000)
msec = parseInt((time % 604800000) / 1000)                    // ← 单位是「秒」
```
- `[观察]` 这里的 `+18000` 是**加**方向，与显示路径的**减**方向相反且量级一致（18000 ms = 18 s），
  两条路径在「18 s」这一点上互逆，但因为起点串一处本地一处 UTC 语义混用，并不严格互逆。
- `[观察]` 字段名叫 `msec`，**实际单位是秒**（`time%week/1000`，且 `setMilliseconds(msec*1000)` 反推一致）。

**RINEX 年份**（`getUTCYear`，`convert.js:1066-1075` / `cli.js:392-401`）：
`week==0 && msec==0` → 返回 `"00"`；否则取计算后年份的后两位。

**坐标基准**：`[观察]` 代码不碰坐标，全部透传。`BESTPOS` 的 `latitude/longitude/height/datum_id`
由 `conversionString` 决定 ASCII 输出（`%(7.11)` 度、`%.4` 米），`datum_id` 枚举默认 61=WGS84
（`NovatelIdConstants.datumId`，`NovatelIdConstants.js:277-281`）。KML 走原生模块，`[未知]` 是否有
弧度→度转换（`messages_public.json` 内 BESTPOSXYZ 类日志的 `latitude` 是**弧度**，
`minValue=-1.570796326794897`），见 §9。

**单位与四舍五入**：
- `[观察]` 数字格式来自 `conversionString`（printf 风格），**每个字段各自指定小数位**，
  不是全局规则。例：`latitude "%7.11lk"`、`height "%.4lf"`、`solution_age "%7.3k"`、
  `num_svs "%UB"`、`ext_sol_stat "%02XB"`。
- `[观察]` 字节数统计（`ConvertedBytes`/`UnConvertedBytes`）是**字节**，不是日志条数；
  摘要把 `UnConvertedBytes` 求和后扣掉 `UNKNOWN` 的 COUNT（`convert.js:2162`）。
- `[观察]` 采样率与抽稀互相换算：GUI 传 `1/sampleRate`（Hz→秒），CLI 传 `--decimate` 原值（秒）。
  `convert.js:1922`、`cli.js:220`

### 5.5 SREC 与 DATABLOCK 字节级格式（`tosrec.exe` + `datablk.exe`，实测）

**SREC 记录（`tosrec` 输出）**
- 每条 = `S3` + `len`（1 B 十六进制）+ `addr`（4 B）+ `data`（≤**28** B）+ `cksum`（1 B）。
  `cksum = ~(len + addr 四字节 + data 全部字节) & 0xFF`。
- 数据按 28 字节切块，地址从 `-baseaddr`（默认 0）起，每块 +28。
- 终止记录固定 `S7 05 00100000 EA`（起始地址 0x00100000，**与 baseaddr 无关**）。
- 行尾 **CRLF**（含最后一行）。
- `-s4c` 在终止记录后再追加一行 `S0 S4 Checksum: 0x%08X`，值为**全部数据字节的 32 位算术和**。

**可复算算例**（输入 40 字节 = 0x00..0x27）：
```
S3 21 00000000 000102...1A1B 64
S3 11 0000001C 1C1D1E1F2021222324252627 40
S7 05 00100000 EA
```
- 第 1 条 `len=0x21=33 = 4+28+1`；`cksum`: `0x21 + Σ(4B addr=0) + Σ(img[0..27])`，
  `Σ(0..27)=378=0x17A`，`0x21+0x17A=0x19B`，取低字节 `0x9B`，补码 `0x64` ✔
- 第 2 条 `len=0x11=17 = 4+12+1`，数据 12 字节 0x1C..0x27 ✔
- `-s4c` 算例：40 字节 → `Σ(0..39)=780=0x30C` → `S0 S4 Checksum: 0x0000030C` ✔

**DATABLOCK（`datablk` 输出）**
- 头部 140 字节（表见 §3.8），数据区从 `max(140, Align)` 开始，中间用 `0xFF` 填充。
- `Compress=compress` ⇒ 数据区为 **zlib 流**（实测 `78 DA ...`，`zlib.decompress` 可还原原字节）。
- `8..11` = CRC32(存储的数据字节)；`24..27` = CRC32(头部 0..140，本字段置 0)。
- **CRC 算法（实测确定）**：`zlib.crc32(data, 0xFFFFFFFF) ^ 0xFFFFFFFF`
  （即 CRC-32 反射多项式、初值 0xFFFFFFFF、**无最终异或**；与标准 zlib CRC 差一个最终取反）。
  可复算算例：`payload = 01 02 03 04 05` →
  `zlib.crc32(b'\x01\x02\x03\x04\x05', 0xFFFFFFFF) ^ 0xFFFFFFFF = 0x81296EE9`，
  实测头部 `8..11` = `E9 6E 29 81` ✔
- S0 注释记录（文本，非二进制头）：`S0~P~<Platform>`、`S0~V~DEV-LOAD`、`S0~T~DATA<Block#>`；
  文件尾为 `S5 0000` + `S7 0000`。
- `Block #` **只影响** `S0~T~DATA<n>`，不影响 140 字节头（实测 block 0/1 头部逐字节相同）。
- `-C_TYPE=11`、`NAME=CONFIG_FILE`、`VERSION=1.0.0`、`SN=SN`、`PLATFORM=PIM222`、`ALIGN=0`
  是 `LoadConfig.bat` 的硬编码组合（`LoadConfig.bat:33-40`）。

### 5.6 未知字节（UNKNOWN）处理

- `[观察]` 三种取值，映射到协议字符串：`interleave`→`INTERLEAVE`、`file`→`SEPARATEFILE`、
  其它（含 `ignore`/缺省）→`SKIP`。`01_解包/app/view/convert/cli.js:161-164`
- `[观察]` **GUI 只提供 `SEPARATEFILE` 与 `INTERLEAVE` 两个选项**，`SKIP` 的 `<li>` 被注释掉，
  默认 `SEPARATEFILE`。`convert.html:336-345`、`convert.js:52`
- `[观察]` 该组选项仅在 `UNKNOWN` 日志被选中且输出格式含 ASCII/BINARY/ABBREV 时可用。
  `convert.js:3298-3317`

---

## 6. 状态机与事件流

### 6.1 GUI 状态机

```
[Get Started]  ──(拖入/浏览/清空)──►  frameFileInfo()
      │                                  │  过滤 size>0 且 exists
      │                                  ▼
      │                          edieAPICall("readmessage") ──► 子进程 node.exe
      │                                  │                        └─ 写 convertProgress.txt
      │                                  ▼
      │                          fileValidation()
      │      ┌───────────────┬───────────┴────────────┐
      │  全无效           部分无效                  全有效
      ▼      ▼                ▼                       ▼
 [invalid-files 5 s 后自动隐藏] [partial-invalid-files-layout
                                提供 Start over / Continue]   [convert-settings]
                                                                  │ Messages 页
                                                                  │ Next（校验扩展名/RINEX/KML 白名单）
                                                                  ▼ Format 页
                                                          Convert 按钮（至少 1 个格式）
                                                                  ▼
                                                        [convert-progress] 300 ms 轮询
                                                                  ▼
                                                        [convert-summary] → Done → resetData()
```

- `[观察]` 全无效时 `resetData()` + 显示 5 秒后自动消失。`convert.js:3068-3075`
- `[观察]` 部分无效时逐文件标 `FILE_CANNOT_LOAD`；`Continue` 会把无效文件从
  `uploadedFileInfo` 里 `splice` 掉。`convert.js:3083-3103`、`:3011-3042`
- `[观察]` 「无效」判定：`Object.keys(Message).length == 0` 或**只有 `UNKNOWN` 一项**。
  `convert.js:3060-3066`
- `[观察]` `Next` 前还会 `checkFileExists()`（文件被删则弹窗）。`convert.js:1749-1767`

### 6.2 转换进度与「取消」

- `[观察]` 进度实现是**文件轮询**：父进程 `setInterval(300 ms)` 读
  `%APPDATA%\NovAtelApplicationSuite\convertProgress.txt`，`JSON.parse` 失败就吞掉。
  `convert.js:3394-3414`
- `[观察]` 进度条宽度 = 所有 `文件_格式` 键 `Percentage` 的算术平均（缺键按 100）。
  `convert.js:2185-2193`
- `[观察]` **没有取消按钮，也没有任何 kill 路径**：`child` 是 `execFile` 的局部变量，
  从不保存、不监听 `exit`、不 `kill`；`resetData()` 只清 UI 和 `summaryInterval`。
  `convert.js:3382-3416`、`:958-1002`
  ⇒ 转换一旦开始只能等它跑完或杀掉整个应用；应用退出也不会连带杀掉子进程。
- `[观察]` 「读文件」阶段有软互斥：加载动画可见时拖入被忽略（`dropEffect="none"`）。
  `convert.js:3326-3346`

### 6.3 关键时序
- `[观察]` 选择日志后 100 ms 才重算「下一步/转换」按钮可用性（防抖）。
  `convert.js:1371-1380`、`:3318-3324`
- `[观察]` 点 Convert 后先 `showConversionProgress()`，再 `setTimeout(50 ms)` 才真正调用
  `edieAPICall`（让 0% 的进度条先画出来）。`convert.js:1974-1993`
- `[观察]` 进度轮询间隔 300 ms；`summaryInterval` 200 ms（只用于「回到顶部」按钮显隐）。
  `convert.js:2275-2278`

---

## 7. 与其它子系统的耦合点

| 耦合对象 | 方向 | 具体接口 | 引用 |
|---|---|---|---|
| `index.html` / 侧栏 | 宿主 | `components.convert==1` 才注入；`.load("../convert/convert.html")` | `index.html:1084-1087`、`:1125` |
| `jarvisInterface` / `userStore` / `Language` | 依赖 | `__(key)`、`jarvisInterface.userLanguage[...]`、`userStore.userStoreJSON.language`（`processLanguage` 全量重刷文案） | `convert.js:3125-3290` |
| `genericView` | 依赖 | `formatToSystemLocale`、`removeDataLangAttr`、`showLoadingScreen` | `convert.js:2931`、`:321-322` |
| `deviceManagement` | 写出 | 转换完成后把结果塞进 `getDevicesList()` 的 recent 列表（`groups:['convert']`） | `convert.js:1982-1991` |
| `NovatelIdConstants` | 依赖 | `GPStoUTCcorrection` | `convert.js:1017`、`:1108` |
| `@electron/remote` | 依赖 | 只在 Linux 分支取 `userData`；`remote.dialog` 选文件/选目录 | `convert.js:7`、`:1582`、`:2979` |
| `Edie/windows/edie-node-wrappers.node` | **强依赖** | `convertfileobject_api.readmessage/Convert` | `cli.js:16-19`、`edieConvertAPI.js:18` |
| `Edie/hatanaka/windows/rnx2crx.exe` | 弱依赖 | 原生模块内字符串 `\hatanaka\windows\RNX2CRX.exe`；`[推断]` 仅在勾选 Hatanaka 压缩时被 fork | 见 §9-4 |
| `Edie/pimtpaddon.node` | **无耦合** | Convert 的任何路径都不 require 它；`pimtpaddon` 只出现在 `communication.js`、`terminalConsole`、`deviceRestart`、`deviceUpdate`、`positionConfig` | 全仓 grep |
| `shortcuts/Unzip/node.exe` | 运行期依赖 | GUI 用它跑 `edieConvertAPI.js`；不存在则回退到 PATH 里的 `node` | `convert.js:28`、`:3385` |
| `view/positionConfig` + `LoadConfig.bat` + `tosrec/datablk` | **无耦合** | 仅共享 app 根目录下的 exe | `lghn-positionConfig .js:1464` |

### 7.1 原生 vs 纯 JS 的边界（验收项 7）

| 环节 | 实现 | 依据 |
|---|---|---|
| 文件字节扫描、日志识别、二进制解码 | **原生**（`edie-node-wrappers.node`） | 无 JS 解析代码 |
| ASCII / 缩写 ASCII 生成（含小数位、枚举名） | **原生**，读 `messages_public.json` 的 `conversionString` | `messages_public.json` 结构 + 请求里只有 `logDefPath` |
| RINEX 2.1/3.01–3.04 生成 | **原生** | 同上 |
| Hatanaka 压缩 | **原生**，`[推断]` 由它 fork `RNX2CRX.exe` | 原生模块内只有路径字符串 `\hatanaka\windows\RNX2CRX.exe`，无命令行模板 |
| KML 生成 | **原生**（`[推断]` 构造含 `Placemark`/`LineString` 的 XML） | 原生模块内标签字符串 |
| RANGECMP→RANGE 展开 | **原生**（请求里只给布尔开关） | `deCompressionType` |
| 抽稀/时间窗/拆分 | **原生**（请求里只给参数） | `decimationFilter`/`timeInterval`/`splitBy` |
| GPS↔UTC 换算、时长格式化 | **纯 JS** | `convert.js:1003-1112` |
| 摘要表生成、命令行表格、进度聚合 | **纯 JS** | `cli.js:483-866`、`convert.js:2185-2206` |
| 目录创建、`InternalMap` 透传、进度文件 I/O | **纯 JS** | `convert.js:2179-2184`、`:3382-3416` |

⇒ **只有纯统计逻辑（计时、进度聚合、摘要排版、目录创建）能用 JS 复现；
任何一条格式转换都必须带着 `edie-node-wrappers.node` 一起走。**

### 7.2 文件写入策略（验收项 4）

| 写什么 | 何时 | 方式 | 编码/换行 | 原子性 |
|---|---|---|---|---|
| `convertObj.json` | 每次 `edieAPICall` | `fs.writeFileSync` 全量覆盖 | UTF-8 无 BOM，单行 JSON | **非原子**，无临时文件 |
| `convertProgress.txt` | 先置空，再由子进程每次回调全量重写 | `writeFileSync("")` / `writeFileSync(JSON)` | UTF-8 无 BOM | **非原子**，读者可能读到半个 JSON |
| `Summary_*.txt`（GUI） | 转换完成 | `fs.writeFileSync` | UTF-8 无 BOM，`\n` | 直接覆盖同名，**不提示** |
| `Summary_*.txt`（CLI） | 转换完成 | 同上，但先 `while(existsSync)` 追加 `(1)` | 同 | 不覆盖，改名为 `(1)(1)...` |
| 输出数据文件 | 原生模块写 | 不经过 JS | 由原生决定 | 每次转换生成新 `TimeStamp` 目录 ⇒ **不会覆盖旧结果** |
| 输出目录 | 请求前 | `fs.mkdirSync(recursive)` / 手写 `mkdirp` | — | 已存在则跳过 |

- `[观察]` `require('fs')` 在 `getInputFileData` 里又 require 了一次并**遮蔽了同名变量**（`cli.js:419`）。
- `[观察]` CLI 的 `fileSummaryTxt` 在 `isCLI` 为真时把摘要目录改成 `outputPath`（不再拼子目录），
  见 `cli.js:714-718`。
- `[观察]` `writeFileSync(path, data, callback)` 的第三个参数传的是回调，**不是编码**——被忽略，
  因此实际是默认 UTF-8（无 BOM）。`cli.js:863`、`convert.js:2175`
- `[观察]` 覆盖提示：**只有**「格式设置/解压设置弹窗」有未保存确认，文件级覆盖无任何提示。

---

## 8. 复现清单

> 每条都是可验收断言。带 `[观察]` 的可直接对着源码核对；带 `[实测]` 的是对 exe 跑过样本得到的。

**A. 入口与分流**

- `R1` `checkIfCalledViaCLI` 仅在 `argv.length>1` **且** `argv[0]` 小写包含
  `novatelapplicationsuite` 时返回 true；把 exe 改名即退回 GUI。`[观察] 01_解包/app/main.js:24-32`
- `R2` CLI 分支必须**先创建 BrowserWindow 再调用** `executeCLI(process.argv)`，且不 `loadURL`。`[观察] main.js:81-85`
- `R3` `executeCLI` 收到的是**含 argv[0] 的完整数组**；输入文件由 `options._` 中「存在且 basename 不含
  NOVATELAPPLICATIONSUITE」的项决定。`[观察] cli.js:100-104`
- `R4` CLI 单次只能转 **1 个输入文件 × 1 种输出格式**（`outputFormat` 只写一个键）。`[观察] cli.js:236-240`

**B. 命令行解析**

- `R5` 13 个错误分支全部 `process.exit()`（退出码 **0**），包括「没给文件」「输出路径非法」
  「receiver-type 非法」「G-III 不支持该格式」。`[观察] cli.js:82,122,206,334,339,349,354,370,378,384,426,443`
- `R6` 未在白名单 `listOfSwitches` 里的任何开关 → 打印 `Invald option <大写键名>` 并退出码 0；
  该检测的 `typeof(x) != Object` 恒真，等价于「白名单外即报错」。`[观察] cli.js:69-82`
- `R7` `--expand-cmp` 与 `--no-expand-cmp` 同时给出且都为假 → 额外报 `Invalid option NO-EXPAND-CMP` 并退出。`[观察] cli.js:76-80`
- `R8` 格式解析顺序为 `format→a→b→abbrev→r→rin3/rinex3→rin2/rinex2→k|kml`，**后者覆盖前者**；
  `-r` 为 true 时等于 `RINEX3.04`，否则等于 `"RINEX"+r`。`[观察] cli.js:84-94`
- `R9` 格式串→编号表必须与 §4.2 的 9 项完全一致，且**任何未命中串都落到 8（RINEX 3.04）**。`[观察] cli.js:97-98`
- `R10` `--receiver-type` 只接受 `oem`/`giii`（大小写无关，转成 `OEM`/`G-III`），缺省 `OEM`。`[观察] cli.js:342-360`
- `R11` `G-III` + (`-b`|`--kml`) → `Not supported with this log type` + 退出；
  `G-III` + 任一 RINEX 选择 + `--forcekinematicdataflag` → `Not supported for this product` + 退出。`[观察] cli.js:368-379`
- `R12` `-c/--convert` 与 `-e/--exclude` 同时给时，**`--exclude` 优先**（`logFilter` 取 exclude）。`[观察] cli.js:188`
- `R13` 过滤串按 `,` 拆分，`isNaN` 为真进 `messageFilter` 并 `toUpperCase()`，否则进 `messageIdFilter`（字符串）。`[观察] cli.js:191-193`
- `R14` `-c`（非 exclude）时 `messageIdFilterInversion=false`；`-e` 时两个 inversion 均为 `true`。`[观察] cli.js:252-253`
  （注意 GUI 相反：GUI 恒传 `true` 且列表是「未选中」的日志，见 `convert.js:1921` + `1820-1832`。）
- `R15` `--unknown-bytes` 映射：`interleave`→`INTERLEAVE`、`file`→`SEPARATEFILE`、其它→`SKIP`，缺省 `SKIP`。`[观察] cli.js:161-164`
- `R16` `--decimate` 的**原值**直接进 `decimationFilter`；而 GUI 传的是 `1/采样率`。两者单位统一为「秒」。`[观察] cli.js:220`、`convert.js:1922`

**C. 时间与数值**

- `R17` GPS→UTC 的偏移常量必须是 **18000 ms（18 s）**，G-III 与 `utcCorrection=false` 时取 0。`[观察] NovatelIdConstants.js:12`、`convert.js:1016-1020`
- `R18` 起点常量：OEM `January 6, 1980 00:00:00`、G-III `April 6, 2019 23:59:42`（**按本地时区解析**）。`[观察] convert.js:38-41`、`cli.js:24-27`
- `R19` 时间字段 `msec` 的**单位是秒**；`week*7*24` 小时 + `msec*1000` 毫秒的算法必须保留。`[观察] convert.js:1024-1027`
- `R20` UTC→GPS 反向换算必须先把 DST 偏移加回（`America/Anchorage` 加两倍），再 `+18000 ms`，
  然后 `week=parseInt(ms/604800000)`、`msec=parseInt(ms%604800000/1000)`。`[观察] convert.js:1094-1112`
- `R21` `--start-time`/`--finish-time` 为 `W,S`；`W==0` 时用首日志周；`--limit-duration` 直接
  `start.msec + 秒` 且**不处理跨周**。`[观察] cli.js:277-289`
- `R22` RINEX 的 `firstLogStartTime` 是两位年份字符串，`week==0&&msec==0` 时返回 `"00"`。`[观察] cli.js:392-401`、`convert.js:1066-1075`

**D. 校验与约束（GUI）**

- `R23` 无扩展名的文件必须被拒绝，弹窗文案点明 `.LOG/.GPS/.BIN`；但**不校验扩展名内容**。`[观察] convert.js:1769-1789`
- `R24` 文件「无效」的判定是 `Message` 为空或只有 `UNKNOWN` 一项；全无效 5 s 后自动隐藏提示。`[观察] convert.js:3060-3075`
- `R25` 数值范围：拆分大小 `0..9999` MB、拆分时间 `0..99999` s、`utcOffset` `0..99` s、
  采样率 `0..999.99` Hz。`[观察] convert.js:734-742`、`:829`、`:1854`
- `R26` 前缀/后缀禁止 `/:*?"<>|\` 且 `maxlength=18`。`[观察] convert.js:1862-1873`、`convert.html:362`
- `R27` RINEX header 的 Comments 输入实时剔除非 ASCII（`[^\x00-\x7F]`）。`[观察] convert.js:521-524`
- `R28` 路径长度预估 > **259** 时显示长路径警告（Windows 专用；Linux 直接跳过）。`[观察] convert.js:1646-1668`
- `R29` 至少勾选 1 个格式时 Convert 按钮才可用；日志选择变化后 100 ms 重算。`[观察] convert.js:3291-3297`、`:3318-3324`

**E. 格式白名单**

- `R30` RINEX 可选项当且仅当已选日志与 `rinexSupportedLogs`（45 项）有交集；KML 用
  `kmlSupportedLogs`（18 项）；G-III 用 `rinexSupportedGIIILogs`（3 项）。`[观察] convert.js:117-124`、`:1681-1716`
- `R31` GUI 必须提供 9 个格式复选框（ASCII/Binary/Abbrev ASCII/KML/RINEX v2.1/3.01/3.02/3.03/3.04），
  RINEX v4.00 保持注释状态。`[观察] convert.html:243-324`
- `R32` G-III 下必须禁用 KML/Binary/Abbrev ASCII，并把 `ABBREV_ASCII.fileSplitting` 默认置 false。`[观察] convert.js:1797-1802`、`:984`

**F. 输出布局与写盘**

- `R33` 默认输出布局 `<源目录>/<源文件名>/<TimeStamp>/<格式>/<文件名>.<ext>`；`--dd` 加一层源文件名，
  `--md` → `<in>/<name>/convert`，`--dm` → `<in>/convert/<name>`。`[观察] cli.js:144-159`、`convert.js:2027-2029`
- `R34` CLI 摘要名 `Summary_<file>.txt`；同名已存在时循环追加 `(1)`（`Summary_x(1)(1).txt` 这种累加形态）。`[观察] cli.js:856-862`
- `R35` GUI 摘要直接覆盖同名文件，**不做** `(1)` 去重。`[观察] convert.js:2030`、`:2175`
- `R36` 转换请求必须经 `%APPDATA%\NovAtelApplicationSuite\convertObj.json`（Windows），
  并先把 `convertProgress.txt` 清空；Linux 才用 argv 传路径。`[观察] convert.js:3386-3388`、`edieConvertAPI.js:13-24`
- `R37` 进度条 = `parseInt(ΣPercentage / 键数)`，键为 `文件_格式`，缺 `Percentage` 记 100，轮询 300 ms。`[观察] convert.js:2185-2193`、`:3394-3414`
- `R38` 转换**不提供取消**：不得保存 child 句柄，不得 kill；`resetData()` 只清 UI 与定时器。`[观察] convert.js:3382-3416`、`:958-1002`
- `R39` 读文件阶段加载动画可见时必须忽略拖入（`dropEffect="none"`）。`[观察] convert.js:3326-3346`

**G. `tosrec` / `datablk`**

- `R40` `tosrec <in> -o <out>` 把任意字节流编码为 SREC：每记录 **28** 数据字节、`S3` 记录、
  行尾 **CRLF**、终止记录恒为 `S70500100000EA`。`[实测]`
- `R41` `tosrec` 校验和 = `~(len+addr(4B)+data) & 0xFF`；`-s4c` 追加
  `S0 S4 Checksum: 0x%08X` = 全部数据字节的 32 位算术和。`[实测]`
- `R42` `tosrec` 仅接受 `-o`/`-baseaddr`/`-s4c`/`-nolength`，未知名与 usage 其余开关一律
  exit **1000**；输入文件不存在时 exit **0** 且只写出终止记录。`[实测]`
- `R43` `datablk` 头部固定 140 字节：`[0..1]`ComponentEnum、`[4..7]`存储长度、`[8..11]`存储数据
  CRC32、`[12..15]`原始长度、`[16..17]`HeaderVersion=2、`[18..21]`=140、`[24..27]`头部 CRC32、
  `[28..43]`Name、`[44..59]`Version、`[60..75]`SNKey、`[108..119]`CompileDate、`[120..128]`CompileTime。`[实测]`
- `R44` `datablk` 的 CRC32 = `zlib.crc32(d,0xFFFFFFFF)^0xFFFFFFFF`；头部 CRC 计算时把 `[24..27]` 置 0；
  压缩模式下 `[8..11]` 算的是**压缩后**字节。`[实测]`
- `R45` `datablk` 数据区起点 = `max(140, Align)`，`Align>140` 时用 `0xFF` 填充；
  `Align` 上限 4096，越界报 `Align value not valid` 且 exit **1**。`[实测]`
- `R46` `datablk` 的 `Block #`（0..7）**只**改 `S0~T~DATA<n>`，不改头部；`Platform` 只进
  `S0~P~<Platform>`，不进头部。`[实测]`
- `R47` `CompileDate`/`CompileTime` 只校验**格式**不校验范围（`2024/13/01`、`25:61:61` 原样写入）。`[实测]`
- `R48` 这两份 exe 只能被 `createHex.bat`→`LoadConfig.bat` 触达，不得出现在任何 Convert 代码路径里。`[观察] createHex.bat:1`、`LoadConfig.bat:43,51`、`lghn-positionConfig .js:1464`

**H. 语义陷阱（复现时必须刻意保留或刻意修掉）**

- `R49` `edieConvertAPI.js` 的 `else if ([apiName == "convert"])` 是**单元素数组**（恒真）；
  依赖前置 `readmessage` 分支短路才不出错。`[观察] edieConvertAPI.js:43-51`
- `R50` `readmessage`/`Convert` 的 Promise 包装**无 reject、无超时**；原生不回调即永久挂起。`[观察] cli.js:29-63`
- `R51` `execFile` 完成回调里的 `JSON.parse(fileData)` **没有** try/catch（进度轮询里有），
  子进程异常退出会让摘要整体不生成。`[观察] convert.js:3388-3393`

---

## 9. 未解之处

1. **格式编解码的字节级实现**——全部在 `edie-node-wrappers.node`（3.5 MB 闭源）。
   缺什么证据才能确定：需要对该 `.node` 做反汇编/符号恢复（本次只做了 strings），
   或抓到原生模块的中间产物。当前只能确定「读写哪些字段、用什么模板」。
2. **`datablk` 头 `[2..3]` 的常量 `0x3A7A`** 语义未知（改动 Block#/Align/Name/Version/SN/
   Platform/Compress 均不变；只有 ComponentEnum 变化时 CRC 才连带变）。
   缺什么证据：需要一份已知固件块样本做对照，或反汇编 `datablk` 的写入路径。
3. **`InternalMap` 的真实类型与用途**。请求里把 `readmessage` 返回的 `InternalMap` 原样回传，
   JS 从不读它。可能是「日志定义内部哈希映射」的句柄/序列化快照。
   缺什么证据：需要在原生侧打印该 JSON（可用 `--verbose` 打印请求体观察其结构）。
4. **Hatanaka 的具体调用方式**：原生模块里只有 `\hatanaka\windows\RNX2CRX.exe` 路径字符串，
   没有命令行模板。是否传 `-` / 临时文件名未知。缺什么证据：`procmon` 观察或用
   `--forcekinematicdataflag` 之外的 Hatanaka 路径跑一次并监视进程创建。
5. **KML 的坐标单位与轨迹组织**：只知道生成 `Placemark`/`LineString`/`coordinates`/`altitudeMode`，
   不知道是否做弧度→度、是否按时间分文件。缺什么证据：跑一次 KML 转换并读输出 XML。
6. **`--r3.02` / `--r3.01` / `--r2.1` 是否真的生效**：yargs 只注册了 `r3.04`、`r3.03`
   （`cli.js:300-301`），其余仅见于帮助文本；`--rin3.02` 这类带 `rin3` 前缀的写法能落到
   `options.rin3`（点号展开），而 `--r3.02` 很可能落到 `options.r3` 从而**静默退化为 ASCII**。
   缺什么证据：需要 `yargs@17.7` 实际跑一次 `--r3.02` 观察 argv 解析结果（本次环境无该依赖）。
7. **PDF 与代码的一致性缺口**：手册 p.152 说 `--expand-cmp` 默认「不展开」，
   代码默认 `deCompressionType = true`（展开）。缺什么证据：需要 1.15 版的 exe 做对照，
   判断是文档错还是 2.11 的行为变更。
8. **`-l` 与 `--limit-output-size` 同时给出的取舍**、以及 `--split` 带值时值被忽略
   （`splitFreq` 恒取 `--limit-output-*` 的值，否则 1）。缺什么证据：需要跑一次带 `--split 3` 的转换看是否真按 3 拆分。

---

## 10. 外部参考

> 以下仅作「外部知识」标注，不得用于补全代码里没有的行为。

1. `NovAtel-Application-Suite-1.15-Legacy-User-Manual.pdf`
   - **Chapter 4 Convert**，p.135–153。
   - `4`（p.135）：OEM6/OEM7 接受 ASCII/BINARY/ABBREVIATED ASCII → 输出 ASCII/BINARY/
     ABBREVIATED ASCII/RINEX/KML；**G-III 只接受 ASCII/BINARY，只输出 ASCII**。
     （与本版代码不一致：代码允许 G-III 输出 RINEX，见 `convert.js:1702-1716`。）
   - `4.2.1 Invalid Files`（p.136）、`4.3.1 Messages`（p.141，含 G-III 支持日志清单）、
     `4.3.2.2 Format`（p.145–146，KML 支持日志清单只列 16 项）、`4.3.2.3 Sample Rate`（p.146–147）、
     `4.3.2.4 Unknown Data`（p.147）、`4.3.2.5 Destination`（p.147–148）、`4.3.2.6 Prefix/Suffix`（p.148）。
   - `4.5 Convert Command Line Interface`（p.150–153）：CLI 选项表，与 `cli.js:869-980`
     的 `helpContent()` 文本逐条对应（写盘的是同一份文案，代码里额外多了
     `--daily-utc`、`--no-expand-cmp`、`--receiver-type`）。
   - p.152 `--expand-cmp`：「The default is do not expand …」— 与代码默认值相反（见 §9-7）。
2. `NovAtel-Application-Suite-2.11.0-ReleaseNotes.pdf`
   - p.2「Convert」段：短头日志二进制→ASCII 修正、RANGECMP5 载波相位标准差、
     带偏移字段数据卡死、短头日志时禁用时间区间过滤、RINEX 设置解码、
     PASSTHROUGH 计数、**无扩展名/非法扩展名文件报错**、Linux 下删除占用源文件提示。
     其中「无扩展名报错」在 `convert.js:1769-1789` 可对上。
   - p.3 Known Issues：「Ubuntu 24.04 … Electron sandbox … prevents successful execution from the
     command line when using the convert」，规避办法 `ELECTRON_DISABLE_SANDBOX=1 ./…AppImage <file>`
     —— 解释了为什么 CLI 路径强制依赖 Electron 运行时。
   - p.3 Supported Products：All OEM7 based products / All WAAS G-III / PIM7500 based；
     Windows 10/11 64-bit、Ubuntu 22.04/24.04。
3. `01_解包/app/Edie/logger_config.toml`：spdlog 配置，`console` sink `level="off"`，
   `file` sink 被注释 ⇒ 默认**不落任何日志文件**。这解释了为什么排障只能靠
   `convertProgress.txt` 与 `--verbose` 的 stdout。
