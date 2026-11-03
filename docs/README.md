# 文档索引

本仓库的文档分四类：**设计**（要做什么）、**决策**（为什么这么做）、**运维**（怎么跑、怎么判）、
**交付材料**（结题与软著）。每一篇都按同一套纪律写：结论在前、数字可回源、引用给 `文件:行号`。

不知道从哪看起，就按目的选一条：

| 你的目的 | 从这三篇开始 |
|---|---|
| 想把代码跑起来 | [新手上手：把代码跑起来](team/新手上手与本地运行.md) → [README](../README.md#开始使用) → [环境与干净环境重跑](operations/environment.md) |
| 想懂系统怎么设计 | [基础设计](spec/2026-10-13-野外台站智能体基础设计.md) → [五类智能体](../README.md#五类智能体) → [共享黑板](operations/blackboard.md) |
| 想复核某个数字 | [已知缺陷与覆盖缺口登记](known-issues.md) → [`tools/audit_claims.py`](../tools/audit_claims.py) → [试运行台账](operations/trial-ledger.md) |
| 想看接收机那套厂商软件怎么拆的 | [`逆向/README.md`](../逆向/README.md) → [`逆向/03_分析/`](../逆向/03_分析/) |
| 想接手继续做 | [收尾交接（2026-11-03）](handoff/2026-11-03-收尾交接.md) → [开放议题](https://github.com/yasunosubaru/field-station-agent/issues) |

## 目录

| 目录 / 文件 | 内容 | 什么时候看 |
|---|---|---|
| [`spec/`](spec/) | 基础设计：系统边界、五类智能体职责、目录树、DoD | 第一次接触项目 |
| [`decisions/`](decisions/) | 架构决策记录（ADR），一篇一个决定 | 想知道某个选型为什么这么定 |
| [`operations/`](operations/) | 运维手册：黑板、看板、评估协议、公开数据、试运行台账 | 跑评测、接数据、写报告 |
| [`m1/`](m1/) | 需求调研记录与数据字典（M1 交付物） | 接口与字段口径 |
| [`m7/`](m7/) | 结题材料：一页摘要、结题报告骨架、软著三件套 | 写结题与软著材料 |
| [`superpowers/`](superpowers/) | M0 决策记录、SDD ledger 归档、各阶段实施计划 | 追某一步为什么这么做 |
| [`team/`](team/) | 分工与后续工作、新手上手 | 判断某块归谁 |
| [`reports/`](reports/) | 阶段性演练报告 | 看一次完整试跑长什么样 |
| [`images/`](images/) | README 用的界面截图（重实现 GUI，0.1.10） | 只想看界面 |
| [`handoff/`](handoff/) | **收尾交接**：给下一个 agent 的任务清单、环境陷阱与纪律 | 刚接手这个仓库 |
| [`known-issues.md`](known-issues.md) | 已知缺陷与覆盖缺口登记表（KI-##） | 遇到怪现象先查这里 |

## 设计（spec/）

| 文档 | 一句话 |
|---|---|
| [野外台站智能体管理系统 —— 基础设计](spec/2026-10-13-野外台站智能体基础设计.md) | 系统边界、五类智能体职责、目录树、完成定义；其余文档都以它为准 |

## 决策（decisions/）

| 文档 | 决定 |
|---|---|
| [ADR-001 智能体运行时选型](decisions/2026-10-14-智能体运行时选型.md) | LangGraph 打底、Pydantic AI 兜底；AutoGen 与 n8n 排除 |
| [ADR-002 仓库许可证选择](decisions/2026-10-15-许可证选择.md) | MIT，以及搬运件不在覆盖范围内的例外 |
| [ADR-003 本地模型通道与可复现性口径](decisions/2026-10-18-本地模型通道与复现性口径.md) | 本地模型通道怎么接，什么算「可复现」 |
| [ADR-004 Agent 归因结论契约](decisions/2026-10-18-Agent结论契约.md) | 研判结论的字段、置信度与「不确定」的表达方式 |
| [ADR-005 M5 集成通道](decisions/2026-10-20-M5集成通道.md) | 消息总线 + 共享黑板 + 输入留痕 |
| [ADR-006 API 通道选型与额度](decisions/2026-10-20-API通道选型与额度.md) | 外部 API 通道与额度控制 |
| [ADR-007 四层框架与真实机器接入](decisions/2026-10-21-四层框架与真实机器接入.md) | 四层框架的对外口径与真实机器接入路线 |

## 运维（operations/）

| 文档 | 一句话 |
|---|---|
| [质控与研判的边界](operations/agent-boundaries.md) | 两个最容易越权的智能体各自能做什么、不能做什么 |
| [共享黑板](operations/blackboard.md) | 数据形状、并发语义与受控访问（M5-2） |
| [运行看板](operations/dashboard.md) | 口径与数据流（M5-3；可选叠加心跳与调度台账） |
| [设备心跳与离线判定](operations/heartbeat.md) | 心跳模型、三态阈值与「与读数健康度正交」的口径（M6-5） |
| [Webhook 上报](operations/webhook.md) | 默认 dry-run 的通知通道：载荷契约、重试与审计（M6-6） |
| [任务调度与失败分类](operations/station-loop.md) | 到点 / 错过 / 超时三种情形与台账口径（M6-4） |
| [评估协议](operations/evaluation-protocol.md) | 预注册的指标与判读方式（M6-2） |
| [公开数据通路](operations/public-data.md) | 公开数据怎么取、怎么留痕 |
| [设备侧合成场景](operations/synthetic-device-scenarios.md) | 供电 / 网络 / 安防异常怎么造 |
| [试运行台账](operations/trial-ledger.md) | 每次试跑记什么（M6-1 骨架） |
| [高风险设备动作清单](operations/high-risk-actions.md) | 哪些动作必须人工批准 |
| [归档策略](operations/archive-policy.md) | 入库、版本、元数据与保留期（M4-4） |
| [环境与干净环境重跑](operations/environment.md) | 换机器怎么把结论重跑出来 |

## 原版 GUI 缺口流程（交付物 B）

| 文档 | 一句话 |
|---|---|
| [原版 GUI 覆盖矩阵](../逆向/03_分析/19_原版GUI覆盖矩阵.md) | A（原版 GUI）× B（重实现）逐项盘点：covered / partial / a_only / not_applicable，每个缺口都有处置 |
| [固定流程目录](../workflows/README.md) | 三条流程（重启 / 刷固件 / 导出 Graph PDF）的用法、证据与安全约束 |
| [执行器说明](../src/fieldstation/workflows/__init__.py) | 状态机、锁、幂等键、只追加审计、人工闸门与 GUI 驱动边界 |

## 交付材料（m1/、m7/、reports/）

| 文档 | 一句话 |
|---|---|
| [M1 调研记录表](m1/调研记录表.md) | 需求与接口调研的原始记录 |
| [数据字典](m1/数据字典.md) | 字段口径的单一来源 |
| [M7 结题材料索引](m7/README.md) | 结题与软著材料的入口 |
| [一页摘要](m7/一页摘要.md) | 指标与结论的一页版 |
| [结题报告（骨架）](m7/结题报告-骨架.md) | 结题报告正文 |
| [软著 · 软件说明书](m7/软著-软件说明书.md) | 软著说明书草稿，数字与生成器一致 |
| [软著 · 源程序](m7/软著-源程序.txt) | 由 `tools/make_copyright_source.py` 生成，前 30 + 后 30 页 |
| [软著 · 申请信息](m7/软著-申请信息.md) | 申请信息填写模板 |
| [试运行演练报告](reports/2026-10-21-试运行演练（公开数据+合成观测）.md) | 一次完整试跑的过程与结论 |

## 流程归档（superpowers/）

| 文档 | 一句话 |
|---|---|
| [M0 决策记录](superpowers/m0-decisions.md) | 地基与旧代码整合期的逐条决策 |
| [M0 SDD Ledger 归档](superpowers/m0-ledger-archive.md) | 当时的 ledger 原文 |
| [M0 实施计划](superpowers/plans/2026-10-13-M0-地基与旧代码整合.md) · [M1/M2](superpowers/plans/2026-10-14-M1调研与M2接入层.md) · [M3—M7](superpowers/plans/2026-10-17-M3至M7-全流程实施计划.md) | 各阶段实施计划 |

## 团队（team/）

| 文档 | 一句话 |
|---|---|
| [分工与后续工作](team/分工与后续工作.md) | 谁负责哪块、下一步做什么 |
| [新手上手：把代码跑起来](team/新手上手与本地运行.md) | 从装环境到跑通第一条测试 |

## 工具

| 脚本 | 作用 |
|---|---|
| [`tools/audit_claims.py`](../tools/audit_claims.py) | 把文档里每个对外数字与仓库实际状态逐条核对 |
| [`tools/sync_code_counts.py`](../tools/sync_code_counts.py) | 生成 README 里的代码量机维护块（`git ls-files` 权威口径） |
| [`tools/check_desensitization.py`](../tools/check_desensitization.py) | 脱敏守卫：本机路径、邮箱、手机号、学号、私钥、token |
| [`tools/check_datadict.py`](../tools/check_datadict.py) | 数据字典完整性门禁 |
| [`tools/make_copyright_source.py`](../tools/make_copyright_source.py) | 生成软著源程序文档（每页 50 行，前 30 + 后 30 页） |
| [`tools/make_cli_figures.py`](../tools/make_cli_figures.py) | 生成论文可用图表（可选依赖 matplotlib） |
| [`tools/make_station_dashboard.py`](../tools/make_station_dashboard.py) | 生成看板 HTML |
| [`tools/build_knowledge_base.py`](../tools/build_knowledge_base.py) | 构建知识库（`data/kb/`） |
| [`tools/fetch_public_data.py`](../tools/fetch_public_data.py) | 抓取公开数据并留痕 |
| [`tools/env_snapshot.py`](../tools/env_snapshot.py) | 记录环境快照，供换机重跑比对 |
| [`tools/probe_provider_live.py`](../tools/probe_provider_live.py) | 模型通道探活（不消耗额度的小请求） |
| [`tools/trial_ledger.py`](../tools/trial_ledger.py) | 试运行台账读写（数据源六类 + 任务两类失败） |
| [`harness/heartbeat_replay.py`](../harness/heartbeat_replay.py) | 设备心跳回放：合成序列 → 三态判定（M6-5） |
| [`harness/station_loop.py`](../harness/station_loop.py) | 任务调度演示：到点 / 错过 / 超时的确定性台账（M6-4） |
| [`tools/workflow_cli.py`](../tools/workflow_cli.py) | 原版 GUI 缺口流程的命令行入口：目录、运行、审批门、人工任务、证据 |
| [`tools/uia_driver.py`](../tools/uia_driver.py) | 原版套件的 UIA 驱动（可选）：按控件名操作，无坐标；套件需 `--force-renderer-accessibility` |
| [`tools/gui_coverage.py`](../tools/gui_coverage.py) | 从源码生成/校验 A×B 覆盖矩阵，防止盘点与代码漂移（`--check` 进 CI） |
| [`harness/selftest.py`](../harness/selftest.py) | 五项发布门禁 |

## 写文档的约定

* **数字必须能回源**：对外数字放进表格，别写成「词：数字」的形状——
  [`tools/audit_claims.py`](../tools/audit_claims.py) 会把那个形状当声明去核对，核不到就返回退出码 1。
* **决策写进 `decisions/`**：一篇一个决定，文件名带日期；决定改了不改旧篇，新开一篇写清楚取代关系。
* **机维护块别手改**：README 的代码量块由脚本生成，手改会在 CI 上炸。
* **引用给位置**：分析类文档一律给 `文件:行号`，让读者能原地复核。
