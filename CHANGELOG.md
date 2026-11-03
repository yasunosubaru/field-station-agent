# 变更记录

本仓库有两条线，各自记版本：

| 线 | 版本形态 | 现在 |
|---|---|---|
| **重实现 GUI**（`NovAtelReverse`，交付物 B 的产物） | `0.1.x`，跟 `逆向/05_打包/NovAtelReverseGui/NasGui.csproj` 的 `<Version>` 走 | `0.1.10`（[Releases](../../releases)） |
| **野外台站智能体**（交付物 A） | 按阶段 M0 — M7 推进，不打语义化版本 | M0、M4 已完成 |

规则：一个版本号对应一次 `dotnet publish`，exe 的 SHA256 与发布说明一起记在 Release 里；
只用 `0.1.0` 起的递增号，跳号表示那版没出。

## 2026-11-03

**仓库界面整理（本次提交）**

| 项 | 内容 |
|---|---|
| README | 重写为「两件交付物 + 仓库地图 + 门禁」结构，补现状数字与界面速览截图 |
| 新增 | [`CHANGELOG.md`](CHANGELOG.md)、[`docs/README.md`](docs/README.md)（文档索引）、`.github` 下的 issue 与 PR 模板 |
| 截图 | [`docs/images/`](docs/images/) 加入 0.1.10 的界面截图 |
| 门禁 | 脱敏守卫补上「证据文件单列豁免」的口径（见 [KI-12](docs/known-issues.md)），其余文件仍按原规则拦 |
| 软著材料 | 源程序文档按当前 `tools/` / `harness/` / `agents/` 重新生成（41 个文件、8,486 行、170 页），说明书里的数字同步 |
| 工具 | `逆向/tools/remote/` 下脚本的本机路径与主机名改为参数，不再写死 |

**原版 GUI 缺口固化为固定流程（本次提交）**

| 项 | 内容 |
|---|---|
| A−B 盘点 | 新增 [`逆向/03_分析/19_原版GUI覆盖矩阵.md`](逆向/03_分析/19_原版GUI覆盖矩阵.md)，由 `tools/gui_coverage.py` 从 A/B 两侧源码生成：50 项逐项映射，A 目录不许漏项，引用的文件/行/workflow 失效即报错 |
| 流程执行器 | `src/fieldstation/workflows/`：严格 YAML 子集、加载期规格校验、状态机、文件锁、幂等键、只追加审计、人工闸门、可插拔 GUI 驱动；纯标准库 |
| 固定流程 | `workflows/`：`script.device.restart`、`gui.device.update`（Apply 前人工闸门）、`gui.graph.export`，附 [`workflows/README.md`](workflows/README.md) |
| 入口 | `python tools/workflow_cli.py list/describe/run/status/gate/resume/cancel/artifacts/validate`；`python -m fieldstation.cli workflow ...`；退出码 0 成功 / 1 失败 / 2 用法 / 3 停在闸门 |
| 门禁 | 新增 `python tools/gui_coverage.py --check`，并与测试、五项自检、数字回源、脱敏守卫并列进质量门禁表 |
| 软著材料 | 源程序文档随新增源码重新生成（43 个文件、9,496 行、190 页），说明书与一页摘要的数字同步 |

**NovAtelReverse 0.1.10**（[Release](https://github.com/yasunosubaru/field-station-agent/releases/tag/v0.1.10)，提交 `747af9a`）

| 改动 | 说明 |
|---|---|
| Graph 工程编辑区暗色 | 图表区深底浅轴、网格线与轴线；地图叠加层保持浅色墨（画在影像瓦片上）；Legend / 时间轴 / dock 深底浅字 |
| 配置抽屉暗色 | 抽屉内的原版 markup 跟随外壳的 `body.darkMode`，`MutationObserver` 实时同步，开着抽屉切主题立即生效；新增 `config-dark.css` 补齐原版暗色段漏掉的控件 |
| 覆盖审计 | 5 个面板 + 配置抽屉 20 页，浅色与暗色两侧对比度审计均为 0 |
| 产物 | `NovAtelReverse.exe`，139,001,951 B，SHA256 `f79aa94e…ed53d` |

## GUI 版本

| 版本 | 日期 | 改了什么 |
|---|---|---|
| `0.1.0` | 2026-11-02 | 单文件 GUI 外壳（WinForms + WebView2 + 内嵌 payload），用原版图标 |
| `0.1.1` | 2026-11-02 | Add Device 不再禁用；点开 live 连接抽屉（Serial / TCP），未连接时聚焦 COM 端口 |
| `0.1.2` | 2026-11-02 | 图标按像素反相（原版蓝底黑块反成黑底蓝块） |
| `0.1.4` | 2026-11-02 | 远程机实测修复三处：打包内嵌 `serialport`、Add Device 列真实串口、`PerMonitorV2` 修 DPI 变形 |
| `0.1.5` | 2026-11-02 | 补上官方主界面 My Applications：五张应用卡片、活动连接数、Add application；启动即主页 |
| `0.1.6` | 2026-11-02 | 默认浅色（与原版一致，不跟随系统）；暗色补齐 Manage / GRIT / 弹窗与终端 |
| `0.1.7` | 2026-11-02 | 修 Playback 深底标签不可读、暗色 `--pb-*` token 缺失；暗色 span 改为继承；两侧对比度审计归零 |
| `0.1.9` | 2026-11-03 | 修 GRIT Signal Matrix 错位与窄屏堆叠；Convert / Graph 补暗色；徽章深字 |
| `0.1.10` | 2026-11-03 | Graph 工程编辑区与配置抽屉暗色；抽屉跟随外壳主题 |

`0.1.3` 与 `0.1.8` 未出。

## 交付物 A 的阶段

| 阶段 | 状态 | 落地内容 |
|---|---|---|
| M0 骨架与评测底座 | 已完成 2026-10-14 | 仓库骨架、旧代码整合、运行时最小核、五项门禁、确定性回放 |
| M1 需求调研与接口梳理 | 交付物已落地，仍在补充 | 调研记录表、数据字典与 `datadict` 门禁 |
| M2 真实数据接入层 | 未开始 | 摄取层已就绪（RINEX 2/3、CRINEX），等真实数据 |
| M3 数据质量校验智能体 | 进行中 | M3-0…M3-3 完成；M3-4 待标注样本 |
| M4 研判 / 调度 / 归档与知识库 | 已完成 2026-10-18 | 工单状态机、归档策略、知识库 |
| M5 集成联调与告警看板 | 已落地部分 | 共享黑板、看板、公开数据通路；真实样本验收待 #28 / #33 |
| M6 试运行与指标评估 | 未开始 | 评估协议已预注册，试运行台账有骨架 |
| M7 成果整理与结题验收 | 进行中 | 一页摘要、结题报告骨架、软著三件套 |

## 交付物 B 的阶段

| 阶段 | 状态 | 落地内容 |
|---|---|---|
| 解包与证据 | 完成 | `app.asar` 与 Graph 的 asar 解包、REA 对 166 个 JS 文件的静态分析（不入库） |
| 逆向文档 | 完成主体 | [`逆向/03_分析/`](逆向/03_分析/) 30 篇、约 16 500 行、R1–R101 条可验收断言 |
| 协议与会话 | 完成 | CRC32、SBF 成帧、123 条消息 879 个字段、TCP/UDP/串口会话与心跳 |
| 视图与应用 | 完成主体 | Manage 19 个配置页与 11 个状态瓦片、Convert 9 种格式、GRIT、Playback、Graph |
| 打包与发布 | 进行中 | 单文件 GUI 已发到 `0.1.10`；固件 Update 只读、Longhorn 分支待真机 |
