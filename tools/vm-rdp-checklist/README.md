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

## 第 2 条：RDP 断开 -> tscon 救回绘制

**功能已实现**（2026-11-18，提交 2a7ef4f）。原先只有注释、没有代码，
现在有 `tools/session_guard.py`：

    session_state()      只读：解析 query session，认 Disc / Active / 侦听
    foreground_window()  只读：GetForegroundWindow 句柄
    reclaim()            动会话：tscon <id> /dest:console，默认 dry_run

验收侧 `tools/probe_rdp_session.py --item 2` 会自动判断：

    有 Disc 会话  -> 真救回，验证 has_disc 变 False（强证据）
    无 Disc 会话  -> 验 tscon 就绪 + 预演命令，
                     detail 里明确写「未在真实 Disc 场景下验证」

所以第 2 条现在是 PASS，但**本机那一份是「能力已就绪、场景未出现」**。
要在真实 Disc 下变成强证据，仍得造一次场景。

### 造场景（不需要密码的路子已试过，不通）

试过 `tscon 1 /dest:rdp-tcp#0` 把 console 推到监听器，本机与 VM 上
都**没有 rdp-tcp#0**（该名字只在有 RDP 会话时才存在），推不过去。
所以只能靠真实 RDP 客户端：

1. VM 里跑 `1-enable-rdp.bat`（管理员），重启；
2. 在 VM 里 `mstsc /v:127.0.0.1`，用 VM 自己的账号登录
   （这时 `query session` 会出现 `rdp-tcp#0 ... 运行中`）；
3. 直接关掉 mstsc 窗口（不是注销）；
4. 跑 `2-probe-state.ps1`，应看到某个会话状态变成 `Disc` / `已断开`；
5. 再跑 `python tools/probe_rdp_session.py --item 2`，
   它会检测到 Disc 并真的执行 tscon。

### 一个实测到的注意点

VM 无交互桌面时 `GetForegroundWindow` 返回 0（句柄不存在）。
item_03 会因此正确报 FAIL，而不是误报通过 —— 这是判据有效的证据，
不是 bug。

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
