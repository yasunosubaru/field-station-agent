# 上报通道：Webhook（M6-6，issue #110）

状态：初版（2026-11-03）

## 为什么是 Webhook

问题原来只落在看板和 JSON 里，不会主动找人。邮件 / 短信 / App 对三人小组过重；
**Webhook 一条就够** —— 企业微信、钉钉、自建服务都能接。

实现：`src/fieldstation/agents/notify.py`，只用标准库 `urllib`，不引第三方。

## 默认 dry-run（CI 不联网）

**默认不发请求**，只把「将要发什么」写进审计。要真发，必须同时满足：

1. URL 非空；
2. 调用方显式构造 `WebhookNotifier(..., dry_run=False)` 或设置环境变量开关；
3. 调用方主动触发（例如 `harness/heartbeat_replay.py --notify`）。

测试与仓库默认路径全部走 dry-run。

## 配置（URL 不入库）

| 环境变量 | 含义 | 默认 |
|---|---|---|
| `FIELD_STATION_WEBHOOK_URL` | Webhook 地址（常带 token，**不写进仓库**） | 空 |
| `FIELD_STATION_WEBHOOK_ENABLED` | `1/true/yes/on` 才真发 | 未设置 → dry-run |
| `FIELD_STATION_WEBHOOK_TIMEOUT` | 单次请求超时（秒） | `5` |
| `FIELD_STATION_WEBHOOK_MAX_ATTEMPTS` | 尝试上限 | `2` |

```powershell
# 先看 dry-run 会发什么
$env:PYTHONPATH="src"; python harness/heartbeat_replay.py --notify
# 真发（本机临时会话变量，不写进任何文件）
$env:FIELD_STATION_WEBHOOK_URL="https://example.invalid/hook"
$env:FIELD_STATION_WEBHOOK_ENABLED="1"
python harness/heartbeat_replay.py --notify
```

## 载荷契约（只发摘要）

| 字段 | 含义 |
|---|---|
| `version` | 固定 `1` |
| `event` | 固定 `station_alert` |
| `level` | `warn` / `critical` |
| `station` / `source` | 台站与告警来源 |
| `title` / `detail` | 一行标题与摘要（换行折平；`detail` 截断到 240 字符） |
| `evidence` | 只保留 `agent` / `call_id` |
| `generated_at` | 生成时间（调用方给） |
| `log_path` | 本地日志路径（家目录替换成 `<home>`） |

**不发完整日志**，只发摘要 + 本地日志路径；载荷不含个人 / 敏感信息。

## 失败语义

- 上报失败**不影响链路结论**：`send()` 不抛异常，只返回 `failed`；
- 5xx / 429 / 连接失败按上限重试；4xx（429 除外）不重试；
- 每一次尝试都进审计（JSONL），审计里只记 URL 的 **host**，不记完整 URL；
- 审计默认写 `logs/notify_audit.jsonl`（可配置）。

## 怎么验证

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_webhook -v
```

测试用本地 `http.server` 假服务收契约，覆盖：dry-run 零请求、载荷白名单与脱敏、
5xx 重试上限、4xx 不重试、连不上不阻塞、审计不含 token。

## 边界

- 不做邮件 / 短信 / App 推送（本阶段用 Webhook 一条通道）；
- 不把 URL / token 写进 `config/` 或文档；
- 上报成功与否**不改变**结论与工单状态 —— 它只是通知。
