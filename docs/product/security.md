# All powered-FSA · 安全模型

本文说明四件事：**哪些动作必须过人、密钥放在哪、日志里不能有什么、自动点原版套件的边界**。
标记沿用 [README](README.md#状态标记)：**当前** = 已实现；**Wave 1** = 本轮落地。

## 1 审批边界

风险等级来自工具登记与流程规格，**模型不能声明、也不能降级**。工具卡与审批卡上显示的 `risk`，
就是服务端登记的那个值。

| 风险 | 处理 |
|---|---|
| `low` | 只读观测与查询，直接执行，结果留证据 |
| `medium` | 可撤的写操作（建工单、格式转换、连接/命令、恢复人工任务）；是否弹审批由该工具或流程的定义决定，不由模型临场判断 |
| `high` | **必须人工审批**；批准前不得出现该 `call_id` 的 `tool_result` |

三条硬约束：

1. **pending 就是 pending。** `approval.status=pending` 期间，同一 `call_id` 不允许有
   `tool_result`；决定之后先写 `approval`（含决定人、时间、备注），再写 `tool_result`。
2. **批准只能由人做。** 审批卡的按钮是唯一入口；模型不能替用户点，也不能把 `pending`
   当成 `approved` 继续跑。流程侧的 `workflow_gate` 只接受 `approved` / `rejected`，
   `workflow_resume` 只接受 `done` / `failed`——传别的值直接报错。
3. **拒绝即停止。** 拒绝后流程停在原地，不自动重试、不换参数再试、不改走另一条路径。
   「不动」始终是合法结局。

审批卡必须写清三件事，缺一项就不该批准：

| 项 | 内容 |
|---|---|
| 动作 | 要执行什么，带完整参数（目标设备、文件、选项） |
| 风险 | `high` 的原因：为什么不可逆 / 影响范围 |
| 影响 | 失败或成功分别会发生什么；有没有回退 |

## 2 高风险清单

### 工具层

| 工具 | 为什么高 |
|---|---|
| `execute_device_action` | 直接改变现场设备状态 |
| `workflow_gate` | 批准动作本身就是「执行不可逆」的那一刻 |

### 流程层

| 流程 | 闸门位置 |
|---|---|
| `script.device.restart` | 工作流级；发 `RESET` 之前 |
| `gui.device.update` | **Apply 之前**；准备步骤只读、可撤 |
| `gui.app.install` | **Install 之前** |
| `gui.app.update` | **Update 之前** |
| `gui.graph.newproject` | Process 之前（写盘动作） |

### 动作名（`config/actions/high_risk.json`）

`restart_receiver`、`power_cycle`、`push_configuration`、`upgrade_firmware`、
`disable_alarm`、`modify_security_policy`。新增动作名必须与工具/流程的实际后果一致；
把高危动作登记成 `low` 是缺陷，不是配置。

执行器还有一道加载期保护：步骤里出现 `RESET` / `FRESET` 时，流程必须在规格里声明
`approval.required: true`，否则加载失败。这样「忘了加闸门」不会拖到运行时才暴露。

## 3 密钥：DPAPI，只在当前用户下可解

`tools/secret_store.py` 负责「一个路径 → 一段密文」，路径由调用方给。产品里这个路径是
`%LOCALAPPDATA%\AllPoweredFSA\secrets.bin`。

| 事实 | 说明 |
|---|---|
| 加密方式 | Windows `CryptProtectData`，**用户作用域**（不加 `CRYPTPROTECT_LOCAL_MACHINE`） |
| 换账户 | 解不开。换机器、换 Windows 用户都必须重填 key |
| 无人值守 | 带 `CRYPTPROTECT_UI_FORBIDDEN`，进程里绝不弹 DPAPI 提示框 |
| 文件头 | `FSA1` + DPAPI blob；早期无前缀的裸 blob 仍尝试解一次，解不开就是「没有 key」 |
| 非 Windows | 降级为 `FSA1PLAIN\n` + UTF-8，并尽量设成 `0600`。**这不是等价保证**，只是「同机同账户 + 权限位」；`backend()` 会明说走的是哪条 |
| 空值 | 拒绝写盘（`ValueError`）。粘贴常带换行，`strip` 后为空说明其实没填；写成空文件会让 `has_secret` 误报「有 key」 |
| 写入 | 先写临时文件、`fsync`、再 `os.replace`，中途失败不留半截密文 |
| 损坏 | 空文件 / 解不开 / 不存在一律返回 `None`，不抛异常——对调用方这四种都是「没有可用 key」 |

API key 的其它约束：

- `settings.json` 只存 `provider`、`base_url`、`model`、`temperature`；**key 只进 `secrets.bin`**。
- `GET/POST /settings` 只回 `has_key`，**永不回声 key**；写接口的响应里也没有 key。
- Provider 抛出的错误文本先过 `_scrub`，把 key 换成 `***`；模块不 `print`、不写日志。
- 删除 `secrets.bin` 等于吊销本机保存的 key。这是有意设计：没有「导出 key」这个功能。

## 4 日志与文本脱敏

| 位置 | 规则 |
|---|---|
| 应用日志 | 不写 key、token、Authorization 头；只写事件与错误分类 |
| Provider 错误 | 完整 URL 可以写（用于排查 `/v1/v1` 这类配置错误），key 必须打码 |
| Webhook | 默认 dry-run 不发请求；载荷走白名单，摘要化，`<home>` 替换用户目录；审计只记 URL 的 host |
| 会话与 artifacts | 本机证据可以含本机路径；**分享或提交前必须脱敏**，它们不在仓库脱敏守卫的覆盖范围内 |
| 仓库文本 | `tools/check_desensitization.py` 扫用户目录路径、手机号、邮箱、学号形状、私钥/token；它是绊线，不是证明 |

两条经验写在工具文件头里，值得重复：

1. **正则扫描器给过假的「0 命中」。** M0 的教训是最终靠字面值比对才验干净。守卫通过不等于没有泄露。
2. **不要为了排查把密钥打进日志。** 需要确认「有没有 key」时查 `has_secret` / `backend()`，
   不要打印内容，也不要打印前几位。

## 5 RPA 无坐标原则

自动操作原版套件时，只按控件身份找目标，**没有任何坐标点击**：

- 选择器在 `tools/uia_selectors.json`，按 `Name` / `AutomationId` / `ControlType` 匹配。
- 找不到控件就报 `GuiUnavailable`，流程按失败分类停下；**不会**退回「大概位置点一下」。
- 原版套件是 Electron，默认不向 UIA 暴露网页内容；必须以 `--force-renderer-accessibility`
  启动，否则只能看到 `Intermediate D3D Window`。
- 选择器随套件版本维护；套件升级后先跑 `python tools/uia_driver.py --check`，再跑流程。
- `gui` 步骤默认 `assisted`：没有驱动时转人工任务，界面里点「已完成」。这不是降级容错，
  而是默认立场——机器不确定时，让人来。
- 每次 `gui` 动作都留证据（动作、目标控件、结果）；`verify_ui` 负责回读，避免「点了但没生效」
  被当成成功。

为什么不用坐标：窗口位置、DPI、主题、语言、套件版本任一变化都会让坐标失效，而坐标点击失败时
往往已经点到了别的地方。控件身份失效会立刻报错，这是可接受的失败方式。

## 6 原版套件的再分发

NovAtel Application Suite 2.11.0 是厂商专有软件：

- 仓库里只有**自产的分析文档与重实现代码**；`逆向/01_解包/`、`逆向/02_证据/`、厂商手册原文
  与安装包都不入库（见 `逆向/.gitignore`）。
- 重实现是**行为复刻**：按 `文件:行号` 记录原版行为，再独立实现；不复用其代码、不打包其二进制。
- `tools/build_payload.py --with-original` 只用于**本机构建**，把已安装的套件拷进 payload，
  方便离线演示 UIA 流程。这样构建出的包**不得对外分发**。
- 发布到 Releases 的 `AllPoweredFSA.exe` 只含重实现与自产资源；需要原版套件的功能，由用户
  自行安装正版。
- 仓库的 MIT 许可覆盖自有代码，不覆盖厂商软件，也不覆盖 `PROVENANCE.md` 里登记的上游授权
  未明文件。

## 7 本机攻击面

- Node 与 Python 都只监听 `127.0.0.1`，不对局域网开放；端口是系统分配的临时端口。
- 跨进程调用要 token：Node → Python 用 `Authorization: Bearer`，Python → Node 用 `X-FSA-Token`。
  token 写在 `runtime.json`，权限仅当前用户。
- 没有远程 API、没有云同步、没有自动更新。所有网络请求只发生在用户配置的模型通道上。
- 模型输出不直接执行：它只能选工具目录里的名字；工具参数会进入审批卡或证据，不能凭空改风险。
- 网页内容（本地 UI）不加载远程脚本；WebView2 用户数据放在 `%LOCALAPPDATA%\AllPoweredFSA\webview2`。

## 8 出问题时的自查顺序

1. 看审批事件：`pending` 有没有对应的决定？决定人是谁？
2. 看工具证据：`tool_result.evidence.agent:call_id` 对应的调用参数是什么？
3. 看流程现场：`jobs/<job_id>/audit.jsonl` 的 `gate.opened` / `gate.resolved`，以及
   `artifacts/failure.json`。
4. 看日志：只有错误分类与 URL，没有 key；如果日志里出现密钥，按事故处理并轮换。
5. 密钥问题：`python tools/secret_store.py <secrets.bin>` 只报 `backend` 与 `has_secret`，
   不打印值。
