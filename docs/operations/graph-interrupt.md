# 原生闸门（LangGraph interrupt）

- 日期：2026-11-08
- 对应：v5 计划 Bot-3 / Bot-4
- 代码锚点：`src/fieldstation/graph/gate.py`、`graph/five_stage.py`、`graph/adapter_langgraph.py`、`graph/checkpoint.py`
- 回归：`tests/test_graph_interrupt.py`（11 项）、`tests/test_botd_trace.py`（12 项）

---

## 1. 为什么换掉原来的做法

原来的闸门是「记一个 `gate` 状态位，然后整个执行循环退出来等」。三条做不到：

| | 存状态位 + return | 原生 `interrupt()` |
|---|---|---|
| 等待期间进程 | 得活着，或靠轮询 | **可以关掉** |
| 关机后能不能继续 | **不能**，这次运行丢了 | 能，`Command(resume=)` 从闸门那行继续 |
| 已完成节点会不会重跑 | 取决于状态位记全不全 | 不会，快照在 checkpointer 里 |

W7 的验收原文是「杀进程重启任务继续」。只有后者做得到。

---

## 2. 一条必须记住的实测事实

**`interrupt()` 所在的节点，在恢复时会从函数开头重跑一遍。**

实测（三个节点 `a → gate → c`，每步往文件里记一行）：

```
run  1:  log = ['A-ran', 'gate-before']
resume :  log = ['A-ran', 'gate-before', 'gate-before', 'gate-after', 'C-ran']
                         ↑ 多出来这一行
```

两条结论：

* **已完成节点 `A` 只跑了一次** —— "已完成不重跑"成立，这是 Bot-3 第 2 条验收。
* **闸门节点跑了两次** —— `interrupt()` **之前**的代码执行了两遍。

### 2.1 所以闸门节点里不许有副作用

`interrupt()` 之前的任何写操作都会执行两次：

| 在 `interrupt()` 之前做什么 | 后果 |
|---|---|
| 发审批通知 | 人收到两条 |
| 写库 | 写了两行 |
| 扣额度 / 调外部接口 | 扣两次 |

现在的实现里，闸门节点只从 state 读已经算好的阶段结论，不做任何写操作。
这条不是风格问题 —— 它就是"重放安全"在这个框架里的具体含义。

### 2.2 和 Bot-1 那条是同一个坑

Bot-1（DBOS）也是这个形状：**崩溃瞬间正在执行的那一步会重跑**。
两处结论合起来就是全项目的一条纪律：

> **带副作用的动作必须能承受"最多执行两次"。**
> 设备动作要幂等键，写文件要能覆盖，通知要去重。

---

## 3. 续跑必须同时满足三个条件

缺一个就显式报错，**不静默降级** —— "以为有闸门、其实没停"是这个功能
最危险的失败方式：

| 条件 | 缺了会怎样 | 实现怎么拦 |
|---|---|---|
| `engine="langgraph"` | 自带 runner 没有 `interrupt()` | `ValueError`，提示换引擎 |
| `gate_checkpointer` | 重启就丢，等于没做 | `ValueError`，要求传检查点 |
| `thread_id` | 找不到快照，接不上 | `ValueError`，要求传线程 |

### 3.1 一个危险的静默失效

**在别的线程上 `Command(resume=...)` 不报错，而是返回 `None`，什么也不做。**

```
run on t1   -> 停在闸门
resume on t2 -> 返回 None，无异常
```

后果：界面上"批了"，实际什么都没发生。所以判据不能是"有没有抛异常"，
必须是"原线程的活有没有被干完"。`tests/test_graph_interrupt.py` 里
`test_resume_without_the_thread_id_cannot_continue` 就钉这一点：
它断言 `C-ran` 出现 0 次、`A-ran` 仍然只有 1 次、返回值是 `null`。

---

## 4. 两套记录并存不是冗余（Bot-4）

| 记录 | 存在形式 | 给谁用 | 为什么不能合并 |
|---|---|---|---|
| LangGraph checkpointer | `<业务库目录>/graph-checkpoint.sqlite` | **框架**恢复 | 存的是完整状态快照 |
| `CheckpointStore`（自建） | JSONL | 人工排查 / 跳过已完成节点 | 只存摘要，**故意不存产物** |
| trace | JSONL | 回放、逐字节比对、界面跳转 | **故意不放时间戳**，否则回放基线失效 |

合并会同时破坏两件事：往 trace 里塞时间戳 → 回放不可复现；
把快照写进摘要 → 又还原不了状态。

### 4.1 序号只有一个来源

`thread.last_event_seq` 必须等于 **trace 文件的行号**。两个写者迟早不一致，
所以约定「谁写 trace 谁报行号」，唯一入口是 `checkpoint.TraceLedger.append()`。

`TraceLedger.resume_after()` 还有一个防错：如果库里的序号**大于**文件行数
（文件被截断过），**以文件为准**并顺手纠正缓存。静默沿用偏大的值会让续跑
跳过真实事件 —— 而且不报错，只是少了几条。

---

## 5. 怎么自查

```powershell
# 闸门三条验收（跨进程）
python -m unittest tests.test_graph_interrupt

# 序号对齐 + 不重复发消息
python -m unittest tests.test_botd_trace

# 复现"闸门节点会重跑"这条事实
python -c "import tests.test_graph_interrupt as t; ..."   # 见其中 cross-process 用例的断言
```

`graph-checkpoint.sqlite` 可以随时删 —— 它只有执行状态。删了最多让"停在闸门上
的任务"再也接不上，业务数据（`botd.sqlite`）不受影响。
