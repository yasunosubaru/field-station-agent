# Graph 与原生计算进程的协议 / SQL / 原生模块

事实来源：
- `01_解包/Graph/out/renderer/assets/index-B86bHcCD.js`（`@` = 字节偏移）
- `01_解包/Graph/out/main/main.jsc`（bytenode 字节码，**ASCII 字符串抽取**，`@` = 文件内字节偏移）
- `01_解包/Graph/out/preload/preload.jsc`（同上）

## 1. 三进程结构

```
renderer (index-B86bHcCD.js)  --invoke-->  main (main.jsc)
                                              |
                                              +-- fork/exec --> 子进程 graphing_hidden.cjs
                                              |                   require(graph-node-wrapper.node)
                                              |                   new Edie.TabFileReader_api()
                                              +-- better-sqlite3-multiple-ciphers 直读 *.db
```

`[观察] main.jsc@31048` 出现 `graphing_hidden.cjs`；`@~73500` 出现
`graph-node-wrapper.node`、`windows`；渲染侧把二进制数据当文本分块接收（`buffer += data`），
所以子进程是 **stdout 管道**而非 IPC handle。

## 2. 子进程脚本（main.jsc 里以模板字符串硬编码，写盘后执行）

`[观察] main.jsc@~73.3k` 的完整脚本文本：

```js
const nativePath = process.env.NATIVE_MODULE_PATH;
const Edie = require(nativePath);
const enocder_obj = new Edie.TabFileReader_api();
process.on('message', (fileList_obj) => {
  const methodName = Object.values(fileList_obj)[0].name;
  if (typeof enocder_obj[methodName] === 'function') {
    enocder_obj[methodName](Object.values(fileList_obj)[0], (jsonobj) => { process.send(jsonobj) });
  } else { /* Method ... does not exist on enocder_obj */ }
  // 无 name 字段时：enocder_obj.filevalidation(fileList_obj, cb)
});
```

要点（复现必须照做）：
1. 原生模块是 **`graph-node-wrapper.node`**（`resources/native_modules/<platform>/`），由
   `process.env.NATIVE_MODULE_PATH` 传入。
2. 导出类 `TabFileReader_api`（拼写就带多的 `enocder_obj` 是变量名，别当成导出名）。
3. **方法名由消息里的 `name` 动态决定**，即 renderer 可以在不改原生模块的情况下调任意方法。
   已确认会被调用的：`filevalidation`、`GetEncryptionKey`、`StartProcess`、`ExportCSV`、
   `ExportKML`、`StopExport`、`stopfilevalidation`。
4. 回调只有一个参数 `jsonobj`，直接 `process.send` 回主进程。
5. 主进程把子进程输出以 `graphing:child-response` 推给渲染进程。

> `[观察] main.jsc@~57800` 另有 `../../resources/native_modules/windows/configurationfile.node`
> 与 `../../resources/native_modules/linux/configurationfile.node`。但解包产物里
> **只有 `graph-node-wrapper.node`，没有 `configurationfile.node`**。见 §7 影响。

## 3. 请求报文（renderer → 原生）

两种信封，靠有无 `id` 区分。

### 3.1 文件验证 / 阅读（一次处理一个文件）

`[观察] @540815 prepareGraphingRequest()`

```json
{
  "<tabUniqueId>": {
    "filePath": ["<输入日志绝对路径>"],
    "configfilePath": "<appPath>\\logger_config.toml",
    "isCropped": false,
    "tabUniqueId": "<10 字节随机 hex>",
    "projectDirectory": "<项目父目录>",
    "projectName": "<项目名>",
    "EncryptKeyInput": "<项目名>",
    "timeLine": { "starttime": 0, "endtime": 0 }     // 仅 isCropped=true 时出现
  }
}
```

- `tabUniqueId` 生成：`generateUniqueTabId(byteLength=10)` → `` `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, byteLength+2)}` ``；
  `byteLength` 必须是正整数且 ≤10，否则抛错 `@645549`（例：`m3k9x2a1-8fj2kq0d9z`）
- `configfilePath` 恒为 `<appPath>\logger_config.toml`（`getConfigFilePath()`）
- 时间戳单位 **毫秒**，起点见 §5

### 3.2 命令（带 id）

| 命令 | 报文 | 依据 |
|---|---|---|
| 取密钥 | `{"id":{"name":"GetEncryptionKey","EncryptKeyInput":"<项目名>"}}` | `@599796` |
| 开始处理/裁剪重算 | `{"id":{"name":"StartProcess","filePath":[...],"configfilePath":"...","projectDirectory":"...","EncryptKeyInput":"<项目名>","timeLine":{"starttime":ms,"endtime":ms},"PlotSummary":{...}}}` | `@13851466` |
| 导出 CSV | `{"id":{"name":"ExportCSV","source":"<project>\\GDS","destination":"<out>\\csv","configfilePath":"...","timestamp_format":"GPS"\|"UTC","selectedPlots":[...],"projectInfo":{"projectname","projectDir","inputFileName","start","end","duration","projectdescription"?}}}` | `@16011633` |
| 导出 KML | `{"id":{"name":"ExportKML","KMLFileName":"<basename>","source":"<project>\\GDS","destination":"<out>","configfilePath":"...","timestamp_format":<number 或 "GPS"/"UTC">,"projectInfo":{...}}}` | `@16010683` |
| 停止导出 | `{"id":{"name":"StopExport"}}` | `@16011378` 之后 |
| 停止验证 | `{"id":{"name":"stopfilevalidation"}}` （**全小写**） | `@1344658` |

> `ExportKML` 的 `timestamp_format` 传的是 **TimeFormat 枚举值（数字）**，`ExportCSV` 传的是
> 字符串 `"GPS"/"UTC"`，两者不一致——复现时照抄。

## 4. 响应报文（原生 → renderer）

`[观察] @552074 parseGraphingResponseData()`

```js
const parsedData = JSON.parse(buffer.split("\n").at(-1));   // 只取最后一行
const tabId = Object.keys(parsedData)[0];
isReadMessageResponse = parsedData.hasOwnProperty(tabId)
                     && (!parsedData.api || parsedData.api === "FileValidation"
                                           || parsedData.api === "GetEncryptionKey");
```

字段全集（出现处）：

| 字段 | 含义 |
|---|---|
| `Percentage` | 0..100；`StartProcess` 时是 **按图组求平均** 的对象 `{group: n}` `@13851466` |
| `ValidationCode` | 0=成功, 1=NMEA 日志, 2=位置日志, -1=无 NMEA, -2=无位置日志, -3=数据损坏, -4=无有效位置 `@551948` |
| `Terminated` | 用户取消 → 渲染侧 `killGraphingProcess()` 并删除 `<project>\GDS` |
| `EncryptionKey` | 仅 `api==="GetEncryptionKey"` 时返回，写 sessionStorage |
| `api` | `"FileValidation"` / `"GetEncryptionKey"`；其他命令不带 |
| `PlotSummary` | 图组 → 子结构树，见 §6 |
| `DataInfo` | `{StartTime, EndTime}`（ms） |
| `Messages` | 缺失日志统计（`{messageName:{count,...}}`） |
| `ReceiverInfo` | `{version:{GPSCARD,ENCLOSURE,IMUCARD}}` |
| `filename` | 输入文件名 |
| `msg` | `"INVALID_GPF_FILE"` / `"READWRITE_PERMIT_ERROR"` / `"FILE_EXISTS_ERROR"` 等 |

渲染侧对 `msg` 的处理：`msg==="FILE_EXISTS_ERROR"` → 提示项目路径不存在；其他 `msg` →
`showErrorBanner(t("ERROR"), t(msg))`。

## 5. 时间基准（**单位/换算必读**）

`[观察] @538000 之后 10 行`

| 常量 | 值 | 用途 |
|---|---|---|
| `gpsStartTime_OEM` | `"1980-01-06T00:00:00.000Z"` | GPS 起点 |
| `MILLISECONDS_PER_WEEK` | `10080*60*1000 = 604_800_000` | 一周毫秒 |
| `GPS_UPPER_LIMIT` | `604800` | 一周秒数 |
| `UTC_DIFF_MSEC` | `18000` | **±18 s 闰秒差，硬编码**（2026 年构建时会话时 GPS-UTC=18 s） |
| `TIMESTAMP_COL_NAME` | `"timestamp"` | 所有图表 DB 的时间列名 |

换算（复算例）：

```
gpsWeek    = floor(ms / 604800000)
gpsSeconds = (ms % 604800000) / 1000
UTC        = new Date(1980-01-06T00:00:00Z + ms - 18000)
```

例：`ms = 1417276800000` → `week = 2343`、`gpsSeconds = 230400.000`；
UTC = `2024-12-03T15:59:42.000Z`（即 GPS 时间轴的 18 s 偏移在显示 UTC 时一次性扣除，
且该常量为**构建期硬编码**，2026 年后若闰秒更新需同步改，否则 UTC 列会偏 1 s）。

## 6. PlotSummary 结构（图表"可用性"的唯一依据）

`[观察] @1335532 @578411 @16162103`

```js
PlotSummary = {
  "Position View": { GNSS: { "<索引>": "BESTPOS", ... }, INS: { ... } },
  "PVT":           { GNSS: {...}, INS: {...} },
  "Heading_Attitude": { ... },
  "Tracking_Measurements": { ... },
  "Receiver_Status": { ... },
  "Receiver_Info": { version: {...} | null }
}
```

- 选"用哪张位置表"：`getUsedPositionLog()` 取 `Position View.GNSS`，**若其中没有 `BESTPOS`
  就整组改用 `Position View.INS`**，然后取**数值最小的键**对应的日志名（`@1335532`）。
- 图是否画：`getAvailableGraphs()` 把 `PlotSummary.PVT.GNSS` 与 `.INS` 的**键名**（即消息名）
  和图表 `title` 做交集，并额外塞一个 `"Planimetric"`（`@578411`）。所以"图表存在"= 消息名与
  标题字符串相同，这是个**字符串耦合**，复现时必须用同一批标题。
- 分组显示名：`KEY.toUpperCase().trim()` 再 `t()`，跳过 `Position View`，且
  `Receiver_Info` 在 `ReceiverInfo.version===null` 时跳过（`@16162103`）。

## 7. SQLite 访问（main.jsc）

`[观察] main.jsc@39858..@39949`

```js
cipher = 'aes128cbc'      // PRAGMA cipher
key = '<32 字节十六进制?>'  // 运行时拼接，值不在字符串表里
query_only = ON           // 只读保护
// new Database(path, { readonly: true, fileMustExist: true })
```

- 加密算法：**AES-128-CBC**（SQLCipher 兼容选项，不是 `chacha20`/`sqlcipher` 默认）
- `key` 来源：renderer 从 `sessionStorage["EncryptionKey"]` 注入每次请求的 `key` 字段；
  该值由原生 `GetEncryptionKey` 以项目名派生（`EncryptKeyInput`），**派生算法在原生模块内，未解**
- DB 文件名常量 `DB_NAMES`（`main.jsc@73511`）：`position.db`、`events.db`、
  `EVENTS_V2 → event_v2.db`、`logginginterval.db`
- 图表 DB 名：`<tableName>.db`（如 `height.db` / `cno.db` / `rxstatus.db`）

### 7.1 位置查询（`app:get-positions`）

```sql
SELECT
  timestamp, CAST(timeStamp AS REAL) AS Time,
  latitude,  CAST(latitude  AS REAL) AS latitude,
  longitude, CAST(longitude AS REAL) AS longitude,
  height,    CAST(height    AS REAL) AS height,
  Position_Type, Position_Type AS positionType
FROM <tableName>
-- 请求参数：{folderPath, startTime, endTime, tableName, key}
```

另两条：
```sql
-- app:get-time-based-positions
SELECT ... FROM <table> ORDER BY ABS(timestamp - ?) ASC LIMIT 1     -- specificTimeEntry
-- app:get-table-row-count / app:get-distinct-column-values
SELECT COUNT(*) AS row_count FROM <table>
SELECT DISTINCT <colName> FROM <table>
```

### 7.2 图表查询（`app:get-chart-data` / `-column-names` / `-column-data`）

```sql
PRAGMA table_info(<table>)                                   -- 取列名
SELECT * FROM <table> WHERE rowid % <step> ORDER BY <col>     -- 抽稀
SELECT <cols> FROM <table> WHERE timestamp >= ? AND timestamp <= ? AND rowid IN (
  SELECT rowid FROM <table> WHERE rowid % <step>              -- 抽稀后再按 timestamp 排序
) ORDER BY timestamp
```

**抽稀是 SQL 层的 `rowid % step`**（不是 LTTB）。`step` 由 renderer 算好传下去：

```js
getDecimationStepSize(data) // data 每项 {start,end,min_diff(s)}
  intervals = ceil((end-start) / (min_diff*1000 || 1000))
  total     = Σ intervals
  step      = total > 100000 ? ceil(total / 100000) : 1      // MAX_DECIMATION_POINTS = 1e5
```

算例：某图 6 段，每段 30 min、`min_diff=1 s` → 每段 1800 个 interval，total=10800 < 1e5
→ step=1（不抽稀）。若 total=250000 → step=3（每 3 行取 1）。

## 8. 缺失 `main.js` 源码的影响

- `out/main/main.js` 只有 3 行：`require("./bytecode-loader.cjs"); require("./main.jsc");`
  → **全部逻辑在字节码里**，无法得到源码级实现。
- 可以确定的：通道名/常量/表名/SQL 片段/子进程脚本（见上文），因为 V8 字节码保留字符串常量。
- 无法确定的：加密 key 的派生、`GB`/`rowid % step` 之外的查询拼接细节、窗口创建参数的具体数值、
  以及 `configurationfile.node` 缺失时的降级路径。
- 复现影响：**这些 handler 必须重写**（Node 侧 ~1.5 k 行量级），不能靠"抄袭"字节码。
