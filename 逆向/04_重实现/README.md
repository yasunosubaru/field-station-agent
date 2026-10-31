# 重实现

原套件是 Electron + jQuery + Node（`nodeIntegration: true`，全局变量满天飞）。这里把它的
**可观察行为**重新组织成有类型、可测试、无全局状态的模块，但**不擅自改变行为**。

## 结构

```
packages/
  protocol/          纯函数层，零 I/O、零依赖
    src/crc.ts       NovAtel CRC-32（反射 0xEDB88320、初值 0、无末尾异或）
    src/header.ts    SBF 长头 28 B / 短头 12 B 的解析与序列化
    src/framing.ts   有状态解帧器（半包、六种记录起点、CRC 策略）
    src/ascii.ts     ASCII 命令改造（端口插入 + CRC 帧）
    src/command.ts   二进制命令构造（LOG / UNLOG / 任意命令 + 字符串 4 字节对齐）
    src/decode.ts    字段解码（ENUM/DOUBLE/…/ustringvariable，越界返回 0）
    src/time.ts      GPS 周/秒 ↔ UTC（保留原实现的缺陷版本供对照）
    data/            由应用自身数据表生成的目录（勿手改，见 tools/gen_*.js）
    test/            120 项
  session/           有 I/O 的会话层
    src/transport.ts TCP / UDP / 串口（串口工厂注入，不硬依赖 serialport）
    src/session.ts   ReceiverSession：状态机、心跳、日志订阅、命令下发
    test/            10 项（回环 TCP 端到端）
  view/              Manage 视图层（详见 packages/view/README.md）
    src/minidom.ts   零依赖 DOM 子集（Node 里跑真实 shipped 片段）
    src/tabs.ts      页签系统
    src/containers.ts 16 步容器 + 三套配置页
    src/tiles.ts     §3.2 的按机型 tile 计划与挂载
    src/layout.ts    Packery 等价布局 + 持久化 + Undo/Reset
    src/connection.ts 35 s 守卫 / VERSIONB 门闩 / 初始日志
    src/throttle.ts  活动 tab 直渲、非活动缓存、切回重放
    src/language.ts  字典 + 20/9 个 processLanguage 扇出
    src/view.ts      updateView 契约（selector/缓存/RAG/格式化）
    src/status/      14 个 status tile 的状态、RAG、数值格式化与图表适配
    src/config/      14 个配置页、三态字典、命令组帧/应答计数、Longhorn 文本配置
    src/manage.ts    唯一装配点（实现 ManageRuntime）
  cli/               无界面验证工具
    src/probe.ts     --list 查字段；--host/--serial 连真机打印日志
```

## 运行

Node ≥ 22.6 直接执行 `.ts`（原生类型擦除），**不需要编译、不需要 npm install**。

```powershell
node --test "packages/protocol/test/*.test.ts"
node --test --test-force-exit "packages/session/test/*.test.ts"
node packages/cli/src/probe.ts --list BESTPOS
```

串口需要可选的 `serialport`：`npm i serialport`（只有 `--serial` 才加载）。

## 保真度约定

原实现有一批确凿缺陷（`03_分析/00A_总体架构.md §8`）。本重实现的处理原则：

1. **默认镜像**：默认行为与 2.11.0 完全一致，包括看起来是 bug 的地方。
2. **可观测**：原实现静默丢弃的字节、静默忽略的 CRC 不匹配，这里通过 `onDrop` / `crcOk` 暴露出来，
   但不改变消费决策。
3. **修正放开关后**：例如 `crcMode: 'validate'`、`gpsToUtcDate()`。

具体三处对照：

| 原实现 | 本实现 |
|---|---|
| CRC 字段为 0 就丢包，非 0 不校验 | `crcMode: 'mirror'`（默认）/ `'validate'` / `'ignore'` |
| `new Date('January 6, 1980 …')` 本地时区 + 硬编码 18 s | `gpsToDateMirroring()` 逐位复刻；`gpsToUtcDate()` 用真实闰秒表 |
| `boolean` 类型参数不写字节 | 同样不写，但 `unsupportedParamTypes()` 会报出来 |

## 数据目录怎么来的

`data/*.json` 全部由脚本从 `01_解包/app` 的**数据表**导出，不是手抄：

| 文件 | 来源 | 生成脚本 |
|---|---|---|
| `msgids.json`（OEM6 638 / OEM7 670 / GIII 20） | `model/*MessageIdConstants.js` + `index.html:1182-1198` 的装配与 tweaks 覆盖 | `tools/gen_catalog.js` |
| `commands.json`（80 条命令的 messageId + 字段枚举） | `NovatelIdConstants.commandsAndEnums` | 同上 |
| `portnames.json`（1552 个端口名） | `controller/frameCommand.js` 的 `NovatelPortNamesList` | 同上 |
| `portaddresses.json` | `NovatelIdConstants.portsMap` + `commandsAndEnums.log.port` | 同上 |
| `parser-tables.json`（102 张字段表） | `model/logparsers.js` 的 `xxxJSON` 常量 | `tools/gen_parser_tables.js` |
| `message-specs.json`（123 条消息 / 879 字段 + 比例因子 + 枚举） | `03_分析/附录/parsers-fields.csv` + 枚举表 | `tools/gen_message_specs.js` |
| `repeat-layouts.json`（31 条 `repeat:true` 消息：26 条固定块 + 5 条变长/多级计数 custom 布局） | 同上的 CSV 与 `logparsers.js` 的循环/步进；固定块按块起点与块长重算相对偏移，变长项由显式 custom decoder 处理 | `tools/gen_repeat_layouts.js`、`packages/protocol/src/decode.ts` |
| `fields-required.json`（141 条） | `jarvisInterface.dummyJSON` | `tools/gen_catalog.js` |
| `components.json` | `compRegister` / `compLogsRegister` / 状态与配置组件清单 | 同上 |

重新生成：

```powershell
node tools/gen_catalog.js
node tools/gen_parser_tables.js
node tools/gen_message_specs.js
node tools/gen_repeat_layouts.js
```

## 下一步

按 `03_分析/00A_总体架构.md §6` 的优先级推进：

- P0 的重复块解码已覆盖全部 31 条 `repeat:true` 消息；26 条固定块由
  `tools/gen_repeat_layouts.js` 生成并校验块内越界，5 条变长/多级计数由
  `decode.ts` 的 custom decoder 处理。
- P1：Manage 视图层（tab/瓦片/连接流程/14 个 status 组件）已完成核心路径；
  14 个配置页的三态、命令组帧、应答计数、三套模板装配与通用配置弹窗也已完成核心路径。
  Device Details/Export/Update/Restart、标准 OEM `.cfg` 交换、Terminal 与 Events 已接通。
  当前 507 项回归全绿（protocol 120 / app 15 / playback 13 / graph 38 / view 304 /
  session 11 / desktop 6）；剩余顺序为 GRIT 专属面板、Plotly 像素对照、Longhorn
  update/config PIMTP 状态机、非 status 消息的完整枚举/展示派生。
- P2：Convert 的 9 种格式、Graph 应用、安装与更新。

写 UI 之前先读 `03_分析/01_Manage主界面与视图层.md §4`（每个瓦片组件的对外签名）与
`02_配置类视图.md §5`（命令/日志清单），这两节是接口契约。
