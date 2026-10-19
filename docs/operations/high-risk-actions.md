# 高风险设备动作清单

判断依据不是“模型有多自信”，而是动作是否可能造成远程台站失联、不可逆配置变化或安全能力下降。

## 必须人工审批

| 动作 | 原因 |
|---|---|
| `restart_receiver` / `power_cycle` | 远程台站可能无法自动恢复，重启期间观测中断 |
| `push_configuration` | 错误配置可能让设备长期离线 |
| `upgrade_firmware` | 升级失败可能使设备变砖，回滚依赖现场 |
| `disable_alarm` | 会降低安全可见性，可能掩盖正在发生的故障 |
| `modify_security_policy` | 直接改变门禁、访问或告警边界 |

## 低风险

创建工单、查询状态、生成报告、归档导出不会直接改变设备控制面，可自动执行，但仍必须落 trace。

真实 SCM/SSH 执行器接入时必须复用 `ApprovalGate`；当前 `ExecuteDeviceActionTool` 只返回授权命令包，不直接操作硬件。
