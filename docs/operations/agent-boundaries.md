# 质控 Agent 与研判 Agent 的边界

- **质控 Agent（qc）**：判断观测批次或反演输出是否满足确定性质控判据。输出“可用/拒绝、触发判据、证据”。
- **研判 Agent（fault_diagnosis）**：消费质控证据、设备健康度和知识库规程，判断更可能的故障类别与处置方向。
- 质控 Agent 不猜硬件故障；研判 Agent 不重新实现周跳、连续性或量级判据。
- 两个 Agent 共用 M3 的结论契约和 `call_id` 证据链。
- 跨阶段共享上下文只走共享黑板（M5-2）：阶段在 `board_reads` / `board_writes` 里声明范围，`Pipeline` 据此授予 `board_read` / `board_write`。这两个工具**不**走 `config/agents/*.json` 的 `tools` 白名单 —— 黑板能力由阶段声明单点决定，语义见 `docs/operations/blackboard.md`。
