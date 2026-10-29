# Graph 项目文件结构（.gpf / 目录布局 / 校验和 / 用户设置）

事实来源：`01_解包/Graph/out/renderer/assets/index-B86bHcCD.js`，行号为该压缩产物的行号，
`@` 后为文件内字节偏移。

## 1. 项目目录布局

`[观察] index-B86bHcCD.js:601 @595084`

```js
ProjectFilesAndFolders = { DATA_SUMMARY: "DataSummary.json", GOSDBFOLDER: "GOS", GDSDBFOLDER: "GDS" }
```

| 路径 | 内容 | 依据 |
|---|---|---|
| `<Project>\<ProjectName>.gpf` | 项目状态 JSON（见 §2），文件名 = 目录名 | `@538000` 附近 `getGpfFilePath()` = `join(projectDirectory, basename(projectDirectory) + ".gpf")` |
| `<Project>\DataSummary.json` | 数据摘要（`DataSummary` 字段指向它） | `@595084`、`@549423` 附近 `fetchDataSummary` |
| `<Project>\GOS\` | GOS（Overview/地图）数据库目录 | `@595084` |
| `<Project>\GDS\` | **图表/轨迹数据库目录**；导出 KML/CSV 时作为 `source` | `@16010683`（`pathJoin([dbPath,"GDS"])`）、`@599243`（取消时只删 `<Project>\GDS`） |
| `<Project>\html\<name>.html` | 报表 HTML（v2 导出中间产物，可反复重建） | `@16196283` |
| `<Project>\html\scripts\echarts.min.js` | 从 `resources\scripts\echarts.min.js` 复制 | `@16196283` |
| `<Project>\html\icons\` | 从 `resources\Icons\` 整目录复制（含 Flag_trk.svg / flagLine.svg / sel_flagg.svg） | `@16196283` |
| `<Project>\csv\` | `ExportCSV` 的目标目录 | `@16011633` |
| 导出文件夹（用户选） | `<selected>\<name>.pdf`、`<selected>\<name>.html` | `@16004406` |

## 2. `.gpf` 字段（全部来自写入点）

| 字段 | 类型 | 含义 / 写入点 |
|---|---|---|
| `filePath` | string | 原始输入日志路径（`Overview.handleProcessClick` 从 gpf 读出再回传） `@13851466` |
| `projectDirectory` | string | 项目父目录 |
| `projectName` / `projectDescription` | string | 向导第 2 步输入；描述上限 160 字符（`DESCRIPTION_MAX_LENGTH`） |
| `PageRoute` | `"/" \| "/overview" \| "/process"` | 上次所在页面，决定打开项目后跳到哪一页 `@13853344` |
| `updatedProjSummary` | object | `{DataInfo, PlotSummary, Messages}` 的增量快照（重新裁剪后回写） `@13851466` |
| `DataSummary` | string(path) | 指向 `DataSummary.json`；`updatedProjSummary` 不存在时才读它 `@549423` |
| `PersistenceInfo` | object | 图块布局/图例/配色持久化（同 sessionStorage 的 `PersistenceInfo`） `@16246025` |
| `FlagsInitialState` | `{allFlags:[], isFlagsPanelOpen:bool}` | 关闭窗口时回写 `@16246025` |
| `currentTimeStamp` / `isPlaying` / `editedStart` / `editedEnd` | number/bool | 播放位置与裁剪区间，关闭时回写 |
| `EncryptionKey` | string | 存在时**在校验和计算前被 delete**，不参与 SHA-256 `@549423` |
| `checksum` | string(hex 64) | 见 §3 |

## 3. 校验和算法（可复算）

`[观察] @549423`

```
data   = gpf 对象去掉 checksum 与 EncryptionKey
json   = JSON.stringify(data)                      // 键顺序 = 对象自有属性插入顺序
digest = SHA-256( UTF8(json + "GAA170P4468F1218") ) // 静态盐，硬编码
hex    = digest 每字节 toString(16).padStart(2,"0")  // 小写，无分隔
写盘   = JSON.stringify({...data, checksum: hex}, null, 2)   // 2 空格缩进
```

- 校验失败 → `{error:true, msg:"INVALID_GPF_FILE"}`，UI 显示 `INVALID_GPF_FILE` 文案
  （“Failed to read the file. Please ensure it is a valid .gpf file.”）
- **注意**：`JSON.stringify` 依赖属性顺序，复现时必须保持键序，否则校验和对不上。
- 移植注意：`window.crypto.subtle.digest("SHA-256", data)`（`@539995`）。在非浏览器环境用
  `crypto.createHash('sha256')` 等价。
- 算例：若 `data` 为 `{"a":1}`，则计算 `SHA-256('{"a":1}GAA170P4468F1218')`。用 PowerShell 复算：
  `[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('{"a":1}GAA170P4468F1218')))`。

## 4. 打开项目 / 恢复会话

`[观察] @551948 @552074`

1. `openFileDialogFilter([{name:"GPF Files", extensions:["gpf"]}])`
2. `validateGPF(path)`：
   - `fileExists` 返回串含 `EPERM`/`EACCES` → `READWRITE_PERMIT_ERROR`
   - 含 `ENOENT` → `FILE_EXISTS_ERROR`
   - `JSON.parse` 失败 → 原始异常对象直接作为 `msg` 返回
3. `verifyChecksum` → 失败 `INVALID_GPF_FILE`
4. `fetchDataSummary`：`updatedProjSummary` 优先，否则读 `DataSummary` 文件并把键**平铺合并**回 gpf 对象
5. `PageRoute` 决定跳 `/overview` 还是 `/process`

## 5. 用户设置 `userSettings.json`

`[观察] @547730 @548305 @549423`

- 路径：`path.getUserPath()` + `userSettings.json`（`getUserSettingsPath()`）
- 结构：`{ app:{theme:"light"|"dark", timeFormat:"gps"|"utc"}, recents:[{filePath, projectName, timestamp}], lastOpened:{...}, dismissedUpdate:"" }`
- `recents` 上限 **12**（`MAX_RECENT_ENTRIES=12`），新条目 `unshift` 到头部，去重按 `filePath`
- 主题优先级：`getUserSettingsJson().app.theme` → `file.getNASTheme()`（主程序下发的 NAS 主题）
- 时间格式默认 `"gps"`

## 6. sessionStorage / localStorage

| 键 | 用途 | 依据 |
|---|---|---|
| `sessionStorage["EncryptionKey"]` | 原生返回的 SQLCipher 密钥，注入到**每一次** DB 读请求的 `key` 字段 | `@1341680` |
| `sessionStorage["PersistenceInfo"]` | 每个图组的 tile 布局、隐藏 tile、图例配色 | `@16145758` |
| `sessionStorage.clear()` | 离开 `/process` 回首页时清空 | `@16246025` |
| `localStorage` | 只有 i18next-browser-languagedetector 的缓存写入（2 处 `setItem`） | `@357957` `@358400` |
