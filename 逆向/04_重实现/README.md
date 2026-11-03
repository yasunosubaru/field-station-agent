# 重实现

原套件是 Electron + jQuery + Node（`nodeIntegration: true`，全局变量满天飞）。这里把它的
**可观察行为**重新组织成有类型、可测试、无全局状态的模块，但**不擅自改变行为**。

是 [`../03_分析/`](../03_分析/) 那套文档的可执行版本：文档说「哪里是什么行为」，这里就是那份行为的代码。

## 结构

```
packages/
  protocol/          纯函数层，零 I/O、零依赖
    src/crc.ts       NovAtel CRC-32（反射 0xEDB88320、初值 0、无末尾异或）
    src/header.ts    SBF 长头 28 B / 短头 12 B 的解析与序列化
    src/framing.ts   有状态解帧器（半包、六种记录起点、CRC 策略）
    src/ascii.ts     ASCII 命令改造（端口插入 + CRC 帧）
    src/ascii-log.ts / abbrev-log.ts / binary-log.ts / text-log.ts  四种文本/二进制日志形态
    src/command.ts   二进制命令构造（LOG / UNLOG / 任意命令 + 字符串 4 字节对齐）
    src/decode.ts    字段解码（ENUM/DOUBLE/…/ustringvariable，越界返回 0）
    src/edie.ts      Edie 原生解码层
    src/rinex21.ts / rinex3.ts / *-nav.ts   RINEX 2.11 / 3.0x 输出与导航电文
    src/convert-pipeline.ts / kml.ts / summary.ts  转换流水线与摘要
    src/time.ts      GPS 周/秒 ↔ UTC（保留原实现的缺陷版本供对照）
    src/status-fields.ts / generated-status-tables.ts  状态字段与生成表
    data/            由应用自身数据表生成的目录（勿手改，见 tools/gen_*.js）
  session/           有 I/O 的会话层
    src/transport.ts TCP / UDP / 串口（串口工厂注入，不硬依赖 serialport）
    src/session.ts   ReceiverSession：状态机、心跳、日志订阅、命令下发
  view/              Manage 视图层（详见 packages/view/ACCEPTANCE.md）
    src/minidom.ts   零依赖 DOM 子集（Node 里跑真实 shipped 片段）
    src/tabs.ts / containers.ts / tiles.ts / layout.ts   页签、16 步容器、瓦片计划、Packery 等价布局
    src/connection.ts / throttle.ts / language.ts        35 s 守卫与 VERSIONB 门闩、节流、字典
    src/view.ts      updateView 契约（selector/缓存/RAG/格式化）
    src/status/      14 个 status 组件的状态、RAG、数值格式化与图表适配
    src/config/      19 个配置页（三态字典、命令组帧/应答计数、Longhorn 文本配置、终端与事件）
    src/grit/        GRIT 的组件注册、寄存器数据与外壳
    src/manage.ts    唯一装配点（实现 ManageRuntime）
  app/               可运行的网页版控制台（无外壳时的宿主）
    src/server.ts    HTTP 服务与 API（/api/ports、/api/live/*、/api/config/*、/api/graph/*…）
    src/live.ts      实时会话与状态推送
    src/config-host.ts / config-http.ts / config-feed.ts   配置抽屉与 20 个配置页
    src/playback.ts / convert.ts / graphcsv.ts / pdf.ts / capture.ts / logs.ts  各应用的服务端
    src/web/         shell / home / 各面板的 HTML、CSS、JS（含暗色主题与 panels/*）
    src/web/geo/     Luciad 地图舞台的薄封装
  graph/             Graph 应用的纯逻辑：CSV / KML / HTML / PDF（含字体嵌入）/ 工程文件
  playback/          Playback 的回放模型、时间轴与导出
  desktop/           桌面启动器（Electron 等价物的最小实现）
  cli/               无界面验证工具
    src/probe.ts     --list 查字段；--host/--serial 连真机打印日志
    src/convert.ts / graph.ts / playback.ts / offline.ts / verify-ascii.ts  离线跑各应用
```

## 运行

Node ≥ 22.6 直接执行 `.ts`（原生类型擦除），**不需要编译、不需要 npm install**。

```powershell
node --test "packages/protocol/test/*.test.ts"                    # 协议层
node --test --test-force-exit "packages/session/test/*.test.ts"   # 会话层（回环 TCP）
node --test --test-force-exit "packages/*/test/*.test.ts"         # 全部 1233 项
node packages/cli/src/probe.ts --list BESTPOS
node packages/cli/src/probe.ts --host 192.168.3.1 --port 3001 --log BESTPOS --period 1
node packages/app/src/server.ts --port 4711                       # 网页版控制台
```

串口需要可选的 `serialport`：`npm i serialport`（只有 `--serial` 才加载）。
打包成单文件 exe 见 [`../05_打包/NovAtelReverseGui/README.md`](../05_打包/NovAtelReverseGui/README.md)。

## 保真度约定

原实现有一批确凿缺陷（[`../03_分析/00A_总体架构.md`](../03_分析/00A_总体架构.md) 第 8 节）。处理原则：

1. **默认镜像**：默认行为与 2.11.0 完全一致，包括看起来是 bug 的地方。
2. **可观测**：原实现静默丢弃的字节、静默忽略的 CRC 不匹配，这里通过 `onDrop` / `crcOk` 暴露出来，
   但不改变消费决策。
3. **修正放开关后**：例如 `crcMode: 'validate'`、`gpsToUtcDate()`。

具体三处对照：

| 原实现 | 本实现 |
|---|---|
| CRC 字段为 0 就丢包，非 0 不校验 | `crcMode: 'mirror'`（默认）/ `'validate'` / `'ignore'` |
| `new Date('January 6, 1980 …')` 本地时区 + 硬编码 18 秒 | `gpsToDateMirroring()` 逐位复刻；`gpsToUtcDate()` 用真实闰秒表 |
| `boolean` 类型参数不写字节 | 同样不写，但 `unsupportedParamTypes()` 会报出来 |

## 数据目录怎么来的

`data/*.json` 全部由脚本从 `../01_解包/app` 的**数据表**导出，不是手抄：

| 文件 | 来源 | 生成脚本 |
|---|---|---|
| `msgids.json`（OEM6 638 / OEM7 670 / GIII 20） | `model/*MessageIdConstants.js` + `index.html` 的装配与 tweaks 覆盖 | `tools/gen_catalog.js` |
| `commands.json`（80 条命令的 messageId + 字段枚举） | `NovatelIdConstants.commandsAndEnums` | 同上 |
| `portnames.json`（1552 个端口名） | `controller/frameCommand.js` 的 `NovatelPortNamesList` | 同上 |
| `portaddresses.json` | `NovatelIdConstants.portsMap` + `commandsAndEnums.log.port` | 同上 |
| `parser-tables.json`（102 张字段表） | `model/logparsers.js` 的 `xxxJSON` 常量 | `tools/gen_parser_tables.js` |
| `message-specs.json`（123 条消息 / 879 字段 + 比例因子 + 枚举） | `../03_分析/附录/parsers-fields.csv` + 枚举表 | `tools/gen_message_specs.js` |
| `repeat-layouts.json`（31 条 `repeat:true` 消息） | 同上 CSV 与 `logparsers.js` 的循环/步进；固定块按块起点与块长重算相对偏移，变长项由显式 custom decoder 处理 | `tools/gen_repeat_layouts.js` + `packages/protocol/src/decode.ts` |
| `fields-required.json`（141 条） | `jarvisInterface.dummyJSON` | `tools/gen_catalog.js` |
| `components.json` | `compRegister` / `compLogsRegister` / 状态与配置组件清单 | 同上 |

重新生成：

```powershell
cd ../            # 回到 逆向/
node tools/gen_catalog.js
node tools/gen_parser_tables.js
node tools/gen_message_specs.js
node tools/gen_repeat_layouts.js
```

## 测试口径

| 包 | 源码 | 测试文件 | 说明 |
|---|---|---|---|
| `protocol` | 24 | 42 | 含手册 CRC 向量、字段样例、成帧边界、转换 golden 比对 |
| `view` | 63 | 15 | 跑真实 shipped 片段（`minidom`），status/config 组件的状态与格式化 |
| `app` | 14 | 37 | 服务端 API、配置宿主、PDF/KML/CSV 导出、主题与端口枚举 |
| `graph` | 14 | 9 | 图表数据、列序、PDF 字体与中文 |
| `playback` | 3 | 1 | 回放模型与时间轴 |
| `session` | 2 | 1 | 回环 TCP 端到端（心跳用例对时序敏感，隔离运行必过） |
| `desktop` | 2 | 1 | 启动器 |
| `cli` | 7 | 0 | 由上面各包的测试覆盖 |

合计 **1233 项**。跑法见上；`--test-force-exit` 用于有长连接（socket、定时器）的包。

## 下一步

按 [`../03_分析/00A_总体架构.md`](../03_分析/00A_总体架构.md) 第 6 节的优先级推进：

- **P0 已完成**：31 条 `repeat:true` 消息全部可解码——26 条固定块由 `tools/gen_repeat_layouts.js`
  生成并校验块内越界，5 条变长/多级计数由 `decode.ts` 的 custom decoder 处理。
- **P1 已完成主体**：Manage 视图层（页签 / 瓦片 / 连接流程 / 14 个 status 组件）与 19 个配置页的
  三态、命令组帧、应答计数、模板装配；Device Details/Export/Update/Restart、标准 OEM `.cfg` 交换、
  Terminal 与 Events 都接通。剩余：GRIT 专属面板的边角、Plotly 像素对照、Longhorn 的
  update/config PIMTP 状态机、非 status 消息的完整枚举与展示派生。
- **P2 已完成主体**：Convert 的 9 种格式、Graph 应用（13 类图表 + 8 页 PDF + `.gpf`）、
  安装与更新仍是缺口（固件写入路径未开放）。

写 UI 之前先读 [`../03_分析/01_Manage主界面与视图层.md`](../03_分析/01_Manage主界面与视图层.md) 第 4 节
（每个瓦片组件的对外签名）与 [`../03_分析/02_配置类视图.md`](../03_分析/02_配置类视图.md) 第 5 节
（命令/日志清单）——这两节是接口契约。
