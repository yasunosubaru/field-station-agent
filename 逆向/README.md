# NovAtel Application Suite 2.11.0 完全逆向与重实现

目标：把 `C:\Program Files\NovAtel Inc\NovAtel Application Suite`（Electron 套件，含 Manage / Playback /
Convert / GRIT Monitor / Graph）**每一个可观察行为**都还原成文档 + 可运行的重实现，不留「大概是这样」。

## 目录

| 目录 | 内容 | 可变性 |
|---|---|---|
| `00_来源/` | 证据来源：ASAR 清单、官方手册提取的文本（可直接 grep） | 只读 |
| `01_解包/` | `app.asar` 与 `Graph/resources/app.asar` 的解包产物 | **只读，禁止修改** |
| `02_证据/` | REA 等工具产出的认证级证据包 | 追加 |
| `03_分析/` | 逐子系统逆向文档（10 篇 + 附录），带 `文件:行号` 引用与可验收断言 | 追加/修订 |
| `04_重实现/` | 可运行的 TypeScript 重实现（零 npm 依赖） | 开发 |
| `tools/` | 生成/抽取/校验脚本（见下） | 开发 |

## 快速开始

```powershell
# 1. 重跑解包（如果 01_解包 被删）
node tools/asar_extract.js "C:\Program Files\NovAtel Inc\NovAtel Application Suite\resources\app.asar" `
     "01_解包\app" --skip-node-modules

# 2. 从解包产物重建重实现所需的数据目录
node tools/gen_catalog.js          # 消息 ID / 命令枚举 / 端口名 → packages/protocol/data
node tools/gen_parser_tables.js    # logparsers 的 102 张字段表
node tools/gen_message_specs.js    # 123 条消息 / 879 个字段的完整 schema

# 3. 跑测试
node --test "04_重实现/packages/protocol/test/*.test.ts"
node --test --test-force-exit "04_重实现/packages/session/test/*.test.ts"
node --test --test-force-exit "04_重实现/packages/view/test/*.test.ts"

# 4. 查字段 / 连真机
node 04_重实现/packages/cli/src/probe.ts --list BESTPOS
node 04_重实现/packages/cli/src/probe.ts --host 192.168.3.1 --port 3001 --log BESTPOS --period 1
```

## 工具

| 脚本 | 作用 |
|---|---|
| `tools/asar_list.js` | 只读 ASAR 头，输出文件树与体积统计（不落盘） |
| `tools/asar_extract.js` | 解包 ASAR（支持 `--skip-node-modules`、`--skip <regex>`） |
| `tools/extract_literal.js` | 从 JS 源码里按括号匹配抽出一个对象/数组字面量并求值 |
| `tools/eval_global.js` | 在 `vm` 沙箱里执行「纯数据脚本」，把全局变量导成 JSON |
| `tools/load_model.js` | 按 `index.html` 的顺序加载 model 目录，验证全局装配结果 |
| `tools/gen_catalog.js` | 生成消息目录 / 命令枚举 / 端口表 / 组件注册表 |
| `tools/gen_parser_tables.js` | 抽取 `logparsers.js` 里 102 张字段表 |
| `tools/gen_message_specs.js` | 把 `附录/parsers-fields.csv` + 枚举表合并成自包含 schema |
| `tools/gen_repeat_layouts.js` | 生成「固定头 + N 个同构块」的重复块布局 |
| `tools/summarize_rea.js` | 把 171 MB 的 REA Evidence 压成可读摘要 |
| `tools/gen_file_inventory.js` | 生成 1017 个文件的覆盖账本 |
| `tools/crc_vector_test.js` | 用手册给出的两个向量验证 CRC32 实现 |

## 为什么这样做

- **`01_解包` 是不可变证据**：所有引用的行号都指向它。任何分析都要能在原地复核。
- **数据目录是生成的，不是手抄的**：879 个字段偏移若靠人工转录必然出错，全部由脚本从应用自身数据表导出，
  并有单测钉住（CRC 向量、字段样例、成帧边界）。
- **「照抄」与「修正」分开写**：原实现有一批确凿缺陷（见 `03_分析/00A_总体架构.md §8`）。
  重实现默认保留可观察行为，把修正放在显式开关后面，避免「悄悄变好」导致与真机行为不一致。

## 现状

- 逆向文档：10 篇，约 8 500 行，525 条可验收断言，覆盖 `app.asar` 里除 `node_modules` 外的全部代码。
- 重实现：协议层 + 会话层 + CLI + **Manage 视图层**，**209 项单测全过**（含手册 CRC 向量、回环 TCP 端到端、真实 shipped 片段的端到端）。
- 认证证据：`02_证据/` 里有 REA 对 166 个 JS 文件的静态分析与可读摘要。
- Manage 视图层已落地：页签、16 步容器、tile 计划与挂载、Packery 等价布局、连接流程、节流、语言、`updateView`（`04_重实现/packages/view/`）。
- 待办：14 个 status 组件与配置页的内部逻辑、GRIT / Convert / Graph；原生层（PIMTP 已有 JS 替代实现，
  SQLCipher 与 9 种格式编解码尚未重写）。详见 `03_分析/00A_总体架构.md §6` 的 P0–P2 清单。
