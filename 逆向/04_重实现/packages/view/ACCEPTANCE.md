# Manage 视图层独立验收

日期：2026-10-29  
范围：`packages/protocol`、`packages/session`、`packages/view`。验收只读
`01_解包/`、`02_证据/`；`03_分析/` 只追加了实现期事实 R67–R101。

## 1. 当前全量结果

| 套件 | 命令 | 结果 |
|---|---|---|
| protocol | `node --test "packages/protocol/test/*.test.ts"` | 66/66 |
| session | `node --test --test-force-exit "packages/session/test/*.test.ts"` | 10/10 |
| view | `node --test --test-force-exit "packages/view/test/*.test.ts"` | 280/280 |

合计 **356/356**；无 `skip`、`todo`、`only`。既有 38 项配置专项测试之外，本轮新增
`operations.test.ts` 38 项，覆盖设备管理、`.cfg`、Terminal、Events、专属页面和宿主边界。

空测试审计同时使用两种检查：

- `rg --pcre2` 搜索空测试、`skip/todo/only`、`assert.ok(true)` 和同变量自比较；
- 逐 `test(...)` 块检查是否至少调用一次 `assert.*`。

本次结果：空测试 **0**、自比较断言 **0**、skip/todo/only **0**。审计边界是静态结构检查；
“非空”不等于“证据充分”，证据强度另见第 2、4、5 节。

## 2. 指定 shipped 断言抽查

| 断言 | 结论 | shipped 证据 | 当前实现/测试证据 |
|---|---|---|---|
| R17 落点规则 | 成立 | `01_解包/app/jarvisInterface.js:1215-1233`：index 0 进 status-panel，page2 进 page2，其余进 page1 | `src/tiles.ts:202-207,245-247`；`test/tiles.test.ts:261-299` |
| R19 Packery 参数 | 成立 | `01_解包/app/view/dynamicTiles/dynamicTiles.js:309-328` | 初验漏 7 项；现 `src/layout.ts:94-104,326-334`，`test/layout.test.ts:157-183` |
| R22 持久化键 | 成立 | `dynamicTiles.js:99-108,765-777` 用 `getTileId(tab)`，即 `jarvisInterface.tabids[tab]` 的设备 tile id | `src/layout.ts:399-405`；`test/layout.test.ts:250-276` |
| R40 活动 tab 门禁 | 成立 | `01_解包/app/view/genericView.js:25-30`；`tabs-1`/空 tab 在 throttle 层放行 | `src/view.ts:121-130`；`src/throttle.ts:45-76`；`test/throttle-language.test.ts:35-78` |
| R60 tile 最终 class | 初验不成立，已修正 | statusBar=`tile receiverPanel`，普通 grid=`tile manage-tile status-tile`，MarinePak position 追加 `mPak-posTile`：`jarvisInterface.js:1482,1563-1566` | 初版顺序错；现 `src/ids.ts:64-80`，`test/manage.test.ts:221` |
| R61 Reset 语义 | 成立（按净观感） | `dynamicTiles.js:645-763` 的 `isLayoutDifferent()` 在偏离时返回 false，`:880` 又用 `=== false` 显示 Reset | `src/layout.ts:432-463`；`test/layout.test.ts:465-497` |

这些结论均来自 shipped 源码与当前测试双重核对；未发现仍不成立的指定项。

## 3. 默认镜像/显式修正检查

顶层约定见 `04_重实现/README.md:52-59`。当前 view 包已知的既存偏差已全部收敛到开关：

- `createView({mirrorDefects:true})` 是默认值：detached cache 继续写入、空值转为
  `"undefined"/"null"`、`removeDataLangAttr` 隔一漏一、`addDataLangAttr` 只增不删。
  显式 `mirrorDefects:false` 才启用四项修正。实现：
  `src/view.ts:175-200,277-303`；测试：
  `test/view.test.ts:71,78`（空值）、`:110,121`（detached cache）、
  `:190,209`（removeDataLangAttr）、`:220,230`（addDataLangAttr）；
  `ManageOptions` 透传见 `test/manage.test.ts:137`。
- `createTabRegistry({mirrorOpenState:true})` 默认查询原程序中不存在的
  `#setupMonitorConn_<tab>`，因此恒 false；`mirrorOpenState:false` 才查询 `#<tab>`。
  实现：`src/tabs.ts:64,109,127,263`；测试：`test/tabs.test.ts` 中 R45 两项。
  具体断言：`test/tabs.test.ts:224-236`。
- 语言字典仍按 `jsIn.addDict` 叠加；隔离语言显式调用 `clearDictionary()`，不是默认修正。
- 通用弹窗在品牌修复开关为默认值时复现“按钮文案查不到语言 key → `dataLang.toLowerCase()`
  TypeError”；`mirrorDefects:false` 才保留按钮且不加错误 marker。实现：
  `src/view.ts:351`；测试：`test/config-pages.test.ts:945`。

结论：这一项由“未满足”更新为 **满足**。`resetButtonVisible` 不是纠正源 bug，而是文档
§6.5 原先没有按调用处的 `=== false` 取反；R61 已改为源码净效果。

## 4. status 组件验收

14 个组件都有真实 shipped HTML；数据路径优先使用
`message-specs.json → decodeMessage/decodeRepeated → deriveStatusFields`。新增
`decodedStatusRepeatedFixture()` 明确保留 ReceiverSession 会交给视图的 numeric row slots，
避免测试只拿到 `header + blocks` 而绕过 `logparsers` 派生。

本轮已验证的关键行为：

- `message-specs.json` 中 31 条 `repeat:true` 均有布局；26 条固定块由生成器校验
  块内越界，5 条变长/多级计数由 custom decoder 处理。测试：
  `packages/protocol/test/repeated.test.ts:103-520`。
- 副天线由 SBF message-type bit 0 选择，且 type 1 仍继续 log 解析：
  `session.ts:254-260,278-296`；`repeated.test.ts` / `session.test.ts` 对应测试。
- 分组 CHANCONFIG、BESTSATS constellation id、GLONASS +37、CARDSTATUS fans：
  `status-fields.ts:216-287,347-405,444-454`。
- AGC card 切换、详情弹窗、Plotly newPlot/react 复用：
  `agcStatus.ts:429`；`status-components.test.ts:1334,1374`。
- PPP 双列同步排序、details 显隐、断线进度条归零：
  `pppCorrections.ts`；`status-components.test.ts:378`。
- SatelliteTracking CHANCONFIG signal trace、lock-time scale、hover context menu、GIII
  MEASUREMENTDATA/SATPOS：`satelliteTracking.ts`；`status-components.test.ts:534-747`。
- SatelliteView 天空图标记与 Longhorn GSA/GSV 共用快照：
  `satelliteView.ts:73,292`、`longhornStatusUI.ts:486`；
  `status-components.test.ts:460,1153`。
- Longhorn CPU 5 s 延迟红色、温度立即红色、双 SD radio 单位/量程：
  `longhornStatusUI.ts`；`status-components.test.ts:1178,1204`。

## 5. 配置页与通用弹窗验收

共同骨架：

- 三态：`src/config/base.ts:211`、`src/config/state.ts:61`。`default/current/pending`
  分别对应默认值、当前值、待发送值；pending 与基线相等时删除，Apply 成功才合并并提交。
- 命令协调：`src/config/state.ts:225,283,349`。按 msgID 保存期望条数和响应值；
  UNKNOWN 不完成，期望窗口内 ERROR 短路，完成后清 feature 计数。
- 装配：`src/manage.ts:421` 的三态切换、`src/manage.ts:376` 的 session response 接线、
  `src/manage.ts:512` 的配置日志请求、`src/manage.ts:535` 的 300/800/100 ms reset。
- 通用弹窗：`src/view.ts:351,465,517,536,552`。标题/按钮按文案反查 key；内容按 16 个
  固定 key 整串映射；垂直位置为 `(windowHeight-190)` 规则；四类编辑弹窗在 dirty 时 veto
  `hide.bs.modal`。

字节与行为验收：

- Position/Port/SPAN/Logging 的 R24–R40 由 `config-pages.test.ts:495-785` 覆盖；
  期望 msgID/enum 在测试运行时从 `01_解包/app/model/NovatelIdConstants.js` 读取，
  命令字节走 production `buildBinaryCommand`。
- Align/Radio/GNSS/Networking/Spoofing 的 R41–R49 由
  `config-pages.test.ts:459,588,804,840,905` 覆盖。
- General/Language/Span Installation/Displays/Auto Updates 的 R81–R85 由
  `config-pages.test.ts:870,896` 覆盖。
- 真实 response 帧与注入 session 事件：`config-pages.test.ts:407,430`。
- GIII 单 Logging/restart notice、Longhorn Positioning/Logging：
  `config-pages.test.ts:230,256`；Longhorn 文本语法：`:925`。

设备管理、配置交换、终端与事件（`operations.test.ts`）：

- 挂载与请求：六类操作页读取真实 HTML；Device Details/Export/Update/Events 的入站请求逐项
  与 shipped `compLogsRegister` 比较（`:214-248`）。
- Device Details：R50/R51 与 GIII 专属 4108/4101 动态表、真实 VERSION、ETHSTATUS、频段和
  MODELFEATURES 分支（`:250-478`）；TerraStar HTTP 缺宿主时不伪造成功，明确进入原生依赖清单。
- Device Export：R52/R53、真实文件列表、两位小数/`0 KB`、USB `MOUNTED` 门禁、FTP service/IP
  门禁和宿主失败边界（`:479-670`）。
- Device Update/Restart：R54–R56、production SOFTLOADRESET/SREC/DATA/COMMIT、状态 16–35、
  MarinePak Lua 分支和 Longhorn reset 原生边界（`:671-896`）。
- `.cfg`：R57–R65、R94/R99；抓取时序、逐行去重、追加写、文件选择后的可选 FRESET、逐命令
  30 s、重试/SAVECONFIG/RESET、OK/ERROR/UNKNOWN 报告（`:897-1147`）。
- Terminal：R66–R70、R97；OEM/GIII/Longhorn 真实片段、LOGR、一文件一行/1 s、GIII Apply、
  特殊 OEM6/OEMSTAR 引号与 Longhorn PIMTP 边界（`:1148-1257`）。
- Events：R71–R73、R98；100 条历史、过滤/限制/清空/暂停、`.esl`、TRACKSTAT used-in-solution、
  Longhorn 2353 三类消息和 223 GSV 发布（`:1258-1552`）。
- R93 的导出时间勘误由测试明确断言：非 Longhorn 保留 `UTC`，Longhorn 省略后缀，
  两者都不产生源码分析曾误判的 `"undefined"`。

## 6. 完成度与剩余项（不能宣称整个 P1 像素/事件级 1:1）

`ACCEPTANCE.md §6` 原第 1 条所列页面已经实现到可验证核心路径：

- Device Details（OEM 与 GIII）完成；Longhorn 无单独细节 HTML，沿用 OEM 页面与 Longhorn
  NMEA 事件通道。
- Device Export 的列表、删除、USB COPY、FTP 宿主调用与状态门禁完成；圆形进度画的像素外观
  未做 Electron 截图差分。
- Device Update 的标准 OEM S-record/raw-data 路径完成；Longhorn PIMTP 专属 HTML、文件类型
  校验和原生依赖边界已接入，但完整上传状态机未实现。
- Device Restart、标准 OEM `.cfg` 保存/加载、Terminal、Events 的核心路径完成；GIII/Longhorn
  不支持标准 `.cfg` 抓取/加载时保持 shipped 警告。
- 真实 FTP、TerraStar HTTP/认证、Longhorn PIMTP 和 Winload 链均只接受显式宿主实现；
  缺宿主时记录依赖，不伪造网络或更新成功。

剩余工作按后续实现顺序：

1. GRIT 专属 status panel。
2. Plotly 像素级 layout、全部 shape/hover/relayout 的真实 Electron 窗口对照。
3. Longhorn update/config 完整状态机，包括 PIMTP ACK、`LoadConfig.bat` 的
   `tosrec`/`datablk`/Winload 链、真实超时与失败恢复。
4. 非 status 消息的完整枚举与展示派生，包括 GIII 各 RxType、GIII AGC 弹窗后半段、
   PPP 全组合矩阵。

另有非阻塞保真项：R50 MarinePak 间距、R48 设备卡片墙排序、下拉滚动/移动端 accordion、
每页控件的完整 CSS 和事件级截图差分。

因此验收状态是：**既有 318 项无回归；当前 356 项全绿；31 条 repeat:true 布局完整；
指定 R17/R19/R22/R40/R60/R61 证据成立；默认镜像约定已满足；14 个 status 组件首屏数值、
14 个配置页核心路径、7 类设备操作页可运行；但上述四项后续工作仍未完成。**
