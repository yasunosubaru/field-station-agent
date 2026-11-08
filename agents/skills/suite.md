# 技能：套件流程

**什么时候用**：用户问套件（NovAtel Application Suite 重实现）起没起、Graph 怎么导、UI 上怎么做某件事。

## 本 agent 的权限边界（先看这条）

`suite_*` 四个工具里，这个 agent **只有 `suite_status` 的权限**：

| 工具 | 本 agent 的策略 | 说明 |
|---|---|---|
| `suite_status` | `allowed` | 只读，但要 `pid` |
| `suite_launch` | `denied` | 拉起外部进程属于「改变环境」 |
| `suite_stop` | `denied` | 同上 |
| `suite_graph_export` | `denied` | 需要 Node 服务 + UI 自动化 |

所以「帮我起套件」这类请求，你**不能说「已启动」**。正确做法是：

1. 如果能拿到 pid，查 `suite_status` 报告当前状态；
2. 给用户可直接执行的命令（`python tools/suite_launcher.py launch …`），
   并说明这是**人去做**的事；
3. 或者建议走 `workflow_run`（同样需要人批）。

## 工作流工具怎么用

| 工具 | 用途 |
|---|---|
| `workflow_list` | 列出可用工作流（`intent` 可过滤） |
| `workflow_status` | 看某个 job 到哪一步了 |
| `workflow_artifacts` | 取产物清单（含 sha256） |

`workflow_run` / `workflow_gate` / `workflow_resume` / `workflow_cancel` 都不在本 agent 允许范围内。
要执行就告诉用户「需要你批准」。

## Graph 导出的正确说法

`suite_graph_export` 需要三样都在：套件在跑、Node 服务可达、UI 可自动化。
缺任何一样，正确回答是「不可用，缺 X」，不是「导出失败」。

引用产物时只用它返回的 `path / sha256 / bytes / pages`，**不要自己拼路径**，
也不要根据文件大小猜页数。

## 常见错法

- **说「已启动」但其实什么都没做**：`suite_launch` 在你的 deny 名单里，调用会直接失败。
- **把 `suite_status` 的 `page` 字段当成「套件在工作」**：它只是 CDP 当前页，
  套件可能停在一个错误对话框上。
- **下载产物后自己算 sha256 去对照**：口径可能不同（大小写、算法），引用工具给的。

## 回答形状

```
结论：套件当前不可知——没有 pid，我不扫进程表去猜。
证据：无（未调用工具）
下一步：请提供 pid，或人工跑 `python tools/suite_launcher.py status --pid N`。
不确定项：套件是否在跑、Graph 能否导出，均未知。
```
