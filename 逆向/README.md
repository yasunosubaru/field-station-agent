# NovAtel Application Suite 2.11.0 逆向与重实现

**目标**：把 `C:\Program Files\NovAtel Inc\NovAtel Application Suite`（Electron 套件，含 Manage /
Playback / Convert / GRIT Monitor / Graph）**每一个可观察行为**都还原成「文档 + 可运行的重实现」，
不留「大概是这样」，最后收成一个能连 OEM729 的单文件 GUI。

**现状**：文档主体完成，重实现覆盖到 GUI 全流程，[`v0.1.10`](https://github.com/yasunosubaru/field-station-agent/releases/tag/v0.1.10)
的单文件 exe 已在真机跑通。

| 项 | 现状 |
|---|---|
| 分析文档 | `03_分析/` 30 篇、约 16 500 行，带 `文件:行号` 引用与 **R1–R101** 条可验收断言 |
| 重实现 | 零依赖 TypeScript，8 个包，**1242 项测试**（1 项心跳用例对时序敏感，隔离运行必过） |
| 协议层 | CRC32（对过 OEM7 手册向量）、SBF 长/短头、成帧、ASCII/二进制命令、123 条消息 879 个字段、31 条重复块布局 |
| 会话层 | TCP / UDP / 串口、心跳、日志订阅，回环端到端 |
| 视图层 | 无依赖 DOM 子集、页签与瓦片系统、Packery 等价布局、连接流程、节流、语言、`updateView` 契约 |
| 应用层 | Manage 19 个配置页 + 11 个状态瓦片、Convert 9 种格式、GRIT 频谱与 Signal Matrix、Playback 回放与事件带、Graph 13 类图表与 8 页 PDF |
| 打包 | WinForms + WebView2 外壳内嵌 Node 与重实现，单文件 exe，无需装 Node.js |
| 真机 | OEM729（串口与 TCP 两种接入）已端到端验证 |

## 目录

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `00_来源/` | 证据来源：ASAR 清单、安装目录哈希基线、厂商手册提取文本、**golden 样本** | 部分（手册文本不入库，样本入库） |
| `01_解包/` | `app.asar` 与 `Graph/resources/app.asar` 的解包产物 | **不入库**（260 MB，禁止修改） |
| `02_证据/` | REA 等工具产出的认证级证据包 | **不入库**（163 MB） |
| `03_分析/` | 逐子系统逆向文档，带 `文件:行号` 与可验收断言 | 入库 |
| `04_重实现/` | 可运行的 TypeScript 重实现（零 npm 依赖） | 入库 |
| `05_打包/` | WinForms + WebView2 外壳源码与打包说明 | 入库 |
| `tools/` | 解包、生成、比对、探针脚本（见下） | 入库 |

三个不入库目录的 `.gitignore` 逐条写明了原因（厂商授权 + GitHub 100 MB 硬限），重建方式见「快速开始」。

## 快速开始

```powershell
# 0. 在仓库根的 逆向/ 目录下执行

# 1. 重跑解包（01_解包 被删时；从本机安装目录重建，只读产物）
node tools/asar_extract.js "C:\Program Files\NovAtel Inc\NovAtel Application Suite\resources\app.asar" `
     01_解包\app --skip-node-modules

# 2. 从解包产物重建重实现所需的数据目录（勿手改 packages/protocol/data）
node tools/gen_catalog.js          # 消息 ID / 命令枚举 / 端口表
node tools/gen_parser_tables.js    # logparsers 的 102 张字段表
node tools/gen_message_specs.js    # 123 条消息 / 879 个字段的完整 schema
node tools/gen_repeat_layouts.js   # 31 条 repeat 消息的块布局

# 3. 跑重实现测试（Node ≥ 22.6 直接执行 .ts，不需要编译、不需要 npm install）
cd 04_重实现
node --test "packages/protocol/test/*.test.ts"
node --test --test-force-exit "packages/session/test/*.test.ts"
node --test --test-force-exit "packages/*/test/*.test.ts"    # 全部 1242 项

# 4. 连真机 / 查字段
node packages/cli/src/probe.ts --list BESTPOS
node packages/cli/src/probe.ts --host 192.168.3.1 --port 3001 --log BESTPOS --period 1
node packages/app/src/server.ts --port 4711                  # 不起外壳，直接开网页版 GUI
```

打包成单文件 exe 的配方（payload 内容、`dotnet publish` 参数、发布流程）见
[`05_打包/NovAtelReverseGui/README.md`](05_打包/NovAtelReverseGui/README.md)。

## 分析文档（03_分析/）

先读 [`_约定.md`](03_分析/_约定.md)：所有分析文档必须遵守同一套写法（结论在前、给 `文件:行号`、
可验收断言编号 R##）。

| 文档 | 内容 |
|---|---|
| [`00_通信协议与调度核心.md`](03_分析/00_通信协议与调度核心.md) | 协议与调度核心 |
| [`00A_总体架构.md`](03_分析/00A_总体架构.md) | 总体架构、复现路线、P0–P2 清单、原实现缺陷清单 |
| [`00B_报文解析与消息目录.md`](03_分析/00B_报文解析与消息目录.md) | 报文解析与消息目录 |
| [`01_Manage主界面与视图层.md`](03_分析/01_Manage主界面与视图层.md) | Manage 主界面与视图层（每个瓦片组件的对外签名） |
| [`02_配置类视图.md`](03_分析/02_配置类视图.md) | 配置面板、设备管理页、终端 / 事件 / 卫星 / 干扰监测 |
| [`03_Convert简介.md`](03_分析/03_Convert简介.md) · [`03_Convert组件.md`](03_分析/03_Convert组件.md) | Convert 的界面流程与组件实现（含命令行模式） |
| [`04_Playback组件.md`](03_分析/04_Playback组件.md) | Playback 日志回放 |
| [`05_GRIT-Monitor.md`](03_分析/05_GRIT-Monitor.md) | GRIT Monitor：干扰监测、频谱、地图 |
| [`06_Graph应用.md`](03_分析/06_Graph应用.md) + [`06_Graph应用-附录/`](03_分析/06_Graph应用-附录/) | Graph 独立子程序：IPC 通道、`.gpf` 项目文件、原生命令协议 |
| [`07_国际化与安装更新.md`](03_分析/07_国际化与安装更新.md) | 国际化与安装 / 更新流程 |
| [`08_Edie原生解码层.md`](03_分析/08_Edie原生解码层.md) · [`09_EDIE消息字典与ASCII一致性.md`](03_分析/09_EDIE消息字典与ASCII一致性.md) | Edie 原生解码与消息字典 |
| [`10_RINEX输出规格.md`](03_分析/10_RINEX输出规格.md) | RINEX 输出规格（从 golden 反推） |
| [`11_UI壳.md`](03_分析/11_UI壳.md) · [`12_桌面启动器.md`](03_分析/12_桌面启动器.md) | UI 壳与桌面启动器 |
| [`13_Graph分析页.md`](03_分析/13_Graph分析页.md) · [`13_Graph列序分析.md`](03_分析/13_Graph列序分析.md) · [`14_Graph第二份样本.md`](03_分析/14_Graph第二份样本.md) | Graph 分析页与列序的实测复核 |
| [`15_UI像素比对.md`](03_分析/15_UI像素比对.md) | UI 像素比对方法与判读 |
| [`16_交接_下一步.md`](03_分析/16_交接_下一步.md) | 交接清单：一比一还原还差什么 |
| [`17_A1_连接层与Terminal.md`](03_分析/17_A1_连接层与Terminal.md) | 连接层与 Terminal |
| [`18_1比1差距台账.md`](03_分析/18_1比1差距台账.md) | **差距台账**：每一节记录一处与厂商行为的差异、修法与实测结果 |
| [`附录/`](03_分析/附录/) | 应用自带文件清单、Edie 消息统计等机器生成的附表 |

## 工具（tools/）

`tools/` 下约 90 个脚本，绝大多数是一次性探针（`probe-*.ts`）与对照实现（`oracle-*.ts`），
只在查某条断言时用；按用途分四类：

| 类别 | 代表脚本 | 作用 |
|---|---|---|
| 解包与抽取 | `asar_list.js`、`asar_extract.js`、`extract_literal.js`、`eval_global.js`、`load_model.js`、`summarize_rea.js` | 只读 ASAR、抽字面量、在 `vm` 沙箱里求值、压缩 REA 证据 |
| 数据目录生成 | `gen_catalog.js`、`gen_parser_tables.js`、`gen_message_specs.js`、`gen_repeat_layouts.js`、`gen_edie_layouts.js`、`gen_grit_registers.js`、`gen_language_dicts.js`、`gen_file_inventory.js` | 从应用自身的数据表导出 `packages/*/data/*.json`，**勿手改产物** |
| 对照与校验 | `crc_vector_test.js`、`golden-check.ts`、`ui-diff.ts`、`summary-check.ts`、`nav-diff.ts`、`oracle-*.ts` | 与厂商行为逐字段 / 逐像素对照 |
| 真机与远程 | `probe-*.ts`、`remote/`（含 `README.md`） | 连真机抓日志、跑远程会话；脚本里的主机与路径全部走参数，不写死 |

写新脚本时的两条约定：**产物由脚本生成**（879 个字段偏移靠手抄必然出错），以及
**「照抄」与「修正」分开写**（见下）。

## 保真度约定

原实现有一批确凿缺陷（[`00A_总体架构.md`](03_分析/00A_总体架构.md) 第 8 节）。重实现的原则是三条：

1. **默认镜像**——默认行为与 2.11.0 完全一致，包括看起来是 bug 的地方；
2. **可观测**——原实现静默丢弃的字节、静默忽略的 CRC 不匹配，这里通过 `onDrop` / `crcOk` 暴露，
   但不改变消费决策；
3. **修正放开关后**——例如 `crcMode: 'validate'`、`gpsToUtcDate()`，要显式打开才生效，
   避免「悄悄变好」导致与真机行为不一致。

三处具体对照：

| 原实现 | 本实现 |
|---|---|
| CRC 字段为 0 就丢包，非 0 不校验 | `crcMode: 'mirror'`（默认）/ `'validate'` / `'ignore'` |
| `new Date('January 6, 1980 …')` 本地时区 + 硬编码 18 秒 | `gpsToDateMirroring()` 逐位复刻；`gpsToUtcDate()` 用真实闰秒表 |
| `boolean` 类型参数不写字节 | 同样不写，但 `unsupportedParamTypes()` 会报出来 |

## 证据与不入库的东西

| 内容 | 处理 | 原因 |
|---|---|---|
| `01_解包/`、`02_证据/`、`00_来源/手册文本/` | 不入库 | 厂商二进制、REA 产物与手册提取文本；用 `tools/asar_extract.js` 从本机安装目录重建 |
| `00_来源/samples/`（181 个文件，约 124 MB） | **入库** | 厂商软件与真机自己写出来的文件，是逐字节比对的基准 |
| `dist/`、`node_modules/` | 不入库 | 打包产物（exe 约 132 MB）与 npm 依赖 |
| `tools/remote/*.local.ps1` | 不入库 | 本机专用的远程会话参数 |

`00_来源/samples/` 里的文件带着生成它们那台机器的本机路径（Convert 摘要的头段、Graph 导出的 CSV 头、
真机抓取日志）。这些路径是**证据本体**——改一个字，逐字节比对就失效，所以脱敏守卫对它们整目录单列
豁免，并在输出里给出豁免条数，不做静默放行；细则见 [`docs/known-issues.md`](../docs/known-issues.md) 的 KI-12。
其余文件一律仍按原规则拦。

## 覆盖边界

| 边界 | 说明 |
|---|---|
| OEM729 / OEM7 路径 | 一比一对齐：协议、日志、Manage、配置、Convert、Playback、GRIT、Graph 与连接层 |
| Longhorn（PIM222A） | 只到结构与文档，需要真机才能推进 |
| 固件 Update | 只读；没有可牺牲的单元，写路径未开放。Factory Reset 需人工确认 |
| 硬件与授权类 | SPAN/IMU、RTK fixed、双天线 ALIGN、Wi-Fi AP、LUA/API、内置存储、Galileo/GLONASS/NavIC/SBAS、HDR 与带通滤波、PIM/G-III/Longhorn |
| 地图底图 | Google 瓦片在当前网络不可达，GRIT 与 PDF 第二页改用 Esri World Imagery |
| 套件级 RPA | Auto Updates、Displays Settings、Dynamic Tiles、Add Application、Device Management、Update Application |
| Graph 工程校验 | 依赖原版 Graph Process 页（本机无 GOS/GDS 时不可用） |

## 与仓库其余部分的关系

* 交付物 A（野外台站智能体）是主项目，本目录是它的**取数前置**：先把接收机侧的数据通路打通，
  台站那边才有东西可判、可调度。总览见[仓库根 README](../README.md)。
* 每个对外数字都可回源；本目录的文档不参与 `tools/audit_claims.py` 的核对（它只核对根 README 的
  机维护块），但同样遵守「给得出处」这条纪律。
