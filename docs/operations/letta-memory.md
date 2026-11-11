# Bot-5 Letta 真接：验收边界（2026-11-11）

## 一句话

**适配器的 HTTP 层与 pydantic 校验已被真实 `letta-client` 跑通；
「对真 Letta 服务端往返」仍无证据。**

## 实际做到

| 层面 | 状态 | 证据 |
|---|---|---|
| `letta-client` 真实签名 | ✅ | `inspect.signature` 逐条验过（见下表） |
| HTTP + pydantic 序列化 | ✅ | 22 项用例用真 `letta-client 1.12.1` + 真 `httpx`，打进程内假 REST 服务 |
| 记忆块往返 | ✅ | `write_block` / `read_block` 在假服务上往返一致 |
| 降级语义 | ✅ | 真客户端打没人听的端口 → `backend=local-fallback`、`degraded=True`、`note` 写清原因 |
| 对真服务端往返 | ❌ | 本机 Docker 守护进程没起，起真服务要 Postgres + FastAPI 一整栈 |

## 用 `inspect` 验过的四处（只看文档会踩）

| 位置 | 文档/直觉 | 实际 1.12.1 |
|---|---|---|
| `agents.passages.search` | `limit=` | **`top_k=`**，没有 `limit` |
| `agents.passages.create` | 接受 `metadata=` | **没有 `metadata`**，传了 `TypeError` |
| `agents.passages.create` 返回 | 单个对象 | **`List[Passage]`** —— 按对象取 `.id` 会静默拿到空串 |
| `SearchResult` | 有 `score` | **没有 `score`**，字段是 `content` |

另有两处性能/正确性问题一并修掉：
- 探测专用客户端 `max_retries=0`，探针从 8.2 s 降到 2.7 s；
- `agents.list(name=...)` 服务端过滤 —— 原先拉一页 200 条再本地比对，
  bot 超过一页会建出**第二个同名 agent**。

## 顺带修掉的一个真 bug

适配器带 `store` 又被塞进 `BotMemory` 时两边都写本地，`key` 为空不受
upsert 约束，召回里会多一条内容相同的重复记录。
现在门面接手时把适配器的 `store` 摘掉，`TestSingleWriterToLocalStore` 两条测试钉住。

## 补最后一步的方法

```powershell
# 1. 起一个真 Letta 服务（需要 Postgres + FastAPI）
# 2. 把地址指过去
$env:FSA_LETTA_URL = "http://127.0.0.1:8283"
# 3. 跑一次往返，确认 backend=letta 且 degraded=False
```

这一步没做，所以本文不写「已完全验通」。
