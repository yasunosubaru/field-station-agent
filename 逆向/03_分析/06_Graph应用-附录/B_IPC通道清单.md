# Graph 2.11.0 —— IPC 通道与 preload API 全表

事实来源：
- `01_解包/Graph/out/preload/preload.jsc`（V8 bytenode 字节码，**已用 ASCII 字符串抽取**，不是反编译；off 为该文件内字节偏移）
- `01_解包/Graph/out/main/main.jsc`（同上）
- `01_解包/Graph/out/renderer/assets/index-B86bHcCD.js`（renderer 侧调用点，`@偏移` 为文件内字节偏移）

> `.jsc` 没有行号概念，凡是引用 `.jsc` 的地方一律给「字节偏移」。renderer JS 是压缩产物（2386 行，第 1 行 10.6 MB），因此给「行 + 字节偏移」。

## 1. 通道常量表（preload 侧，`preload.jsc`）

preload 里成对出现「常量名 + 通道字符串」，常量名即 `CHANNELS` 对象的键。
（`preload.jsc@1179` 附近开始，到 `@12332` 结束；完整抽取见 `I2_preload_jsc_字符串.txt`）

| 常量 | 通道字符串 | 暴露到 `window` 的方法 |
|---|---|---|
| `READ` | `file:read` | `file.readFile` |
| `WRITE` | `file:write` | `file.writeFile` |
| `WRITE_BUFFER` | `file:write-buffer` | `file.writeAsBuffer` |
| `DELETE` | `file:delete` | `file.deleteFile` |
| `RENAME` | `file:rename` | `file.renameFile` |
| `EXISTS` | `file:exists` | `file.fileExists` |
| `INFO` | `file:info` | `file.getFileInfo` |
| `READ_DIR` | `file:read-dir` | `file.readDir` |
| `CREATE_DIR` | `file:createDir` | `file.createDirectory` |
| `DELETE_DIR` | `file:deleteDir` | `file.deleteDirectory` |
| `DIR_EXISTS` | `file:dir-exists` | `file.directoryExists` |
| `COPYFOLDER` | `file:copyfolder` | `file.copyFolder` |
| `COPY_FILE` | `file:copyfile` | `file.copyFile` |
| `GET_USER_SETTINGS` | `file:get-user-settings` | `file.getUserSettings` |
| `SAVE_USER_SETTINGS` | `file:save-user-settings` | `file.saveUserSettings` |
| `SAVE_NAS_USER_SETTINGS` | `file:save-nas-user-settings` | `file.saveNASUserSettings` |
| `OPEN_DIALOG` | `dialog:openFile` | `file.openFileDialog` |
| `OPEN_DIALOG_FILTER` | `dialog:openFileFilter` | `file.openFileDialogFilter` |
| `SAVE_DIALOG` | `dialog:saveFile` | `file.saveFileDialog` |
| `SELECT_FOLDER_DIALOG` | `dialog:openDirectory` | `file.selectDirectoryDialog` |
| `SELECT_EXPORT_FOLDER_DIALOG` | `dialog:exportDirectory` | `file.selectExportDirectoryDialog` |
| `OPEN_EXPORT_DESTINATION` | `dialogue:openExportDirectory` ⚠ 拼写是 `dialogue` | `file.openExportDestination` |
| `APP_PATH` | `app:path` | `file.getAppPath` |
| `GET_PATH` | `get-path` | （文件名→ `file.getFilePath`，配 `webUtils.getPathForFile`） |
| `GET_NAS_THEME` | `get-NAS-theme` | `file.getNASTheme` |
| `LOG_MESSAGE` | `log-message` | （日志） |
| — | `path:app-path` | `path.getAppPath` |
| — | `path:join` | `path.join` |
| `BASENAME` | `path:basename` | `path.basename` |
| `DIRNAME` | `path:dirname` | `path.dirname` |
| `USERPATH` | `path:userpath` | `path.getUserPath` |
| — | `path:ext` | `path.getExtension` |
| `REQUEST` | `graphing:request` | `graphing.requestGraphingData` |
| — | `graphing:kill-process` | `graphing.killChildProcess` |
| `RESPONSE` | `graphing:child-response` | `graphing.onGraphingResponse` |
| `OPEN_EXTERNAL` | `graphing:open-external` | `graphing.openExternal` |
| `GET_APP_SETTINGS` | `graphing:get-app-settings` | `graphing.getAppSettingsData` |
| `GET_CHART_DATA` | `app:get-chart-data` | `charts.getChartDBData` |
| `GET_DB_COLUMN_NAMES` | `app:get-db-column-names` | `charts.getChartDBColumnNames` |
| `GET_DB_COLUMN_DATA` | `app:get-db-column-data` | `charts.getChartDBColumnData` |
| `GET_POSITIONS` | `app:get-positions` | `positions.getPositionsData` |
| `GET_TIME_BASED_POSITIONS` | `app:get-time-based-positions` | `positions.getTimeBasedPositionsData` |
| `GET_DISTINCT_COLUMN_VALUES` | `app:get-distinct-column-values` | `positions.getDistinctColumnData` |
| `GET_TABLE_ROW_COUNT` | `app:get-table-row-count` | `positions.getTableRowCount` |
| `GET_SPACING` | `app:get-spacing` | `dataPreview.getSpacingData` |
| `GET_LOG_SPACING` | `app:get-log-spacing` | `dataPreview.getLogSpacingData` |
| `GET_EVENTS` | `app:get-events` | `eventsDB.getEventsData` |
| `GET_CROPPED_EVENTS` | `app:get-cropped-events` | `eventsDB.getCroppedEvents` |
| `CLIPBOARD`/`COPY_TO_CLIPBOARD` | `clipboard:copy-to-clipboard` | `clipboard.copyText` |
| `READ_FROM_CLIPBOARD` | `clipboard:read-from-clipboard` | `clipboard.readText` |
| `PDF_EXPORT`/`PRINT_TO_PDF` | `browser-window:print-to-pdf` | `browserWindow.generatePDF` |
| `APP_IS` | `app:is` | `app.appIs` |
| `QUIT_APP` | `app:quit` | `app.onQuitAPP` |
| `CLOSE_TABS_ON_APP_CLOSE` | `app:close-tabs-on-app-close` | `app.onTabsClose` |
| `GET_PLATFORM` | `app:get-platform` | `app.getPlatform` |
| `TMP_FOLDER` | `app:get-tmp` | `app.getTmpFolderPath` |
| `WINDOW_BLUR` | `window-blur` | `app.onWindowBlur` |
| — | `file:persistence-on-app-close` | `file.persistChangesOnClose` |
| — | `persist-state-complete` | `file.persistStateComplete` |

依据：`preload.jsc@2382`（`graphing:request`）、`@2992`（`app:get-chart-data`）、`@3356`（`app:close-tabs-on-app-close`）、`@4300`（`browser-window:print-to-pdf`）、`@12332`（`file:persistence-on-app-close`）、`@25593`/`@25621`（`contextBridge` / `exposeInMainWorld`）。

## 2. 暴露的 namespace

`preload.jsc@~25.5k` 之后依次出现命名空间名：
`electronAPI`、`config`、`graphing`、`eventsDB`、`clipboard`、`browserWindow`、`dataPreview`、`charts`、`positions`、`file`、`path`、`app`，以及错误串 `Failed to expose APIs: `。

renderer 侧实测使用（`J_Window_API.tsv`，共 72 个 `window.<ns>.<method>` 组合，其中 app 自己的 41 个）：

```
graphing.onGraphingResponse   ×6
graphing.requestGraphingData  ×1
graphing.killChildProcess     ×1
file.*                        ×24（readFile/writeFile/writeAsBuffer/deleteFile/readDir/…）
path.*                        ×7
charts.*                      ×3
positions.*                   ×4
eventsDB.getEventsData        ×1
clipboard.copyText            ×1
crypto.subtle.digest          ×1（SHA-256，用于 GPF 校验和）
app.onQuitAPP                 ×1
browserWindow.generatePDF     ×1
```

## 3. main 侧的处理函数名（main.jsc）

`main.jsc` 内有一批 `handler XXX : CHANNEL` 形式的日志串，可与上表一一对照，例如
`handler FOH : SELECT_EXPORT_FOLDER_DIALOG`、`handler FOH : OPEN_DIALOG_FILTER`、
`handler GOH : OPEN_EXTERNAL`、`handler POH : JOIN`、`handler ALH : SECOND_INSTANCE`、
`handler COH : LOAD_CONFIG_MODULE`、`handler FOH : nasSettings`。
`handler` 前缀按模块分组：`FOH`=fileOps、`GOH`=graphingOps、`POH`=pathOps、`ALH`=app lifecycle、
`COH`=config——说明 main 进程按这 5 个 handler 模块注册通道（`main.jsc` 的常量表里也有
`fileOpsHandlers`、`graphingOpsHandlers`、`pathOpsHandlers`、`chartOpsHandlers`、`postionsHandler`、
`eventsHandler`、`clipboardHandlers`、`dataPreviewHandler`、`browserWindowHandlers`）。

## 4. 事件（非 invoke）通道

只有两个是「主进程 → 渲染进程」推送：
- `graphing:child-response` —— 原生子进程 stdout 的每一块数据（`main.jsc` 的
  `graphingChildWorkerScript` / `createGraphingProcess` 负责转发）
- `window-blur`

其余全部是 `ipcRenderer.invoke`（`preload.jsc@~26.4k` 有 `ipcRenderer` + `invoke` 两个字符串，
无 `ipcRenderer.send`，说明**没有单向 fire-and-forget 通道**；`persistChangesOnClose` 也是
`invoke` + 回调 + 再回一次 `persist-state-complete` 的握手）。
