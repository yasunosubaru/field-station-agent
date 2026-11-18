# §9 剩余 3 条验收：在虚拟机里跑

宿主机做不了（现在是 Console 会话，没有 Disc 状态），而且用户要求实验只在 VM 里做。
以下按顺序执行。

## 前置：VM 现在连不进来

实测 `DESKTOP-AVSL61I`：

```
fDenyTSConnections    REG_DWORD    0x1     <- RDP 被禁用
netstat -an | findstr :3389                  <- 无输出，未监听
```

先跑 `1-enable-rdp.bat`（**管理员**），然后重启一次 VM。

## 第 2 条：RDP 断开 → tscon 救回绘制

**先说清：这条现在不可能 PASS —— 功能没实现。**

```powershell
grep -r "tscon" tools src
#   verify_plan.py:95    (docstring text, no code)
#   verify_plan.py:342  ("2", "RDP 断开后 tscon 救回绘制", item_02)
```

只有验收脚本自己提到 tscon，`runner.py` / `tools/` 里没有任何救回实现。
所以正确顺序是：**先实现救回逻辑，再造 RDP 场景验证**。清单只能验证已有功能，
不能让它凭空通过。

想自己确认场景能不能造出来，可以：

1. VM 里 `1-enable-rdp.bat` -> 重启；
2. 从别处 mstsc 连进 VM（**这时 `query session` 应出现 `rdp-tcp#0  ...  Active`**）；
3. 直接拔掉 / `logoff` 掉那个 RDP 会话；
4. VM 里跑 `2-probe-state.ps1`，看是否出现 `Disc` 状态的会话。

第 4 步若看到 `Disc`，说明**场景可造**，第 2 条就只差功能实现。

## 第 3 条：RDP 最小化后 GetForegroundWindow 非 0

判据：RDP 会话最小化后，`GetForegroundWindow()` 返回非 0。

```powershell
# 在 RDP 会话里把窗口最小化，然后：
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.Form]::ActiveForm    # 或直接用下面的探针
.-foreground-probe.ps1
```

仓库里 `tools/probe_*.py` 已有一份读前景窗口的实现可复用；本条同样需要
**先确认有对应功能**，否则只是记录现状。

## 第 10b 条：断 RDP 后 gui.suite.autoupdate 仍 succeeded

这条最实在——它验的是既有流程在断线后还能跑完。

1. RDP 连着，确认套件在线（`9445` LISTEN）；
2. 先跑一次 `gui.suite.autoupdate` 取基线（应停在 `dismiss_stale` 人工闸门）；
3. `3-run-item10b.bat` 会断开 RDP，然后重跑同一条件；
4. 对比两次的 `status` / `current_step` / `step_index` 是否一致。

实测基线（2026-11-18，本机）：
```
gui.suite.autoupdate   waiting_operator   dismiss_stale   idx=3   x3 次一致
```
断线后若仍是同一三元组，本条可 PASS。

## 回传

跑完 `4-collect.ps1`，把 `C:\fsa_vm\rdp-collect.json` 拷回来给我，
我接进 `verify_plan.py` 的 item_02 / item_03 / item_10b 判据。

## 我不会做的事

- 不连你的 VM，不读你的密码（上一轮问密码是错的，已收回）；
- 不改宿主机的 RDP 设置；
- 不在宿主机上造 RDP 会话。
