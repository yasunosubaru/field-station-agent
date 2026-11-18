/*
 * environment.js —— 启动前的「几何固化」预处理（计划书 §3.6 的 3、4 步）。
 *
 * 这个模块只做两件事，不做别的：
 *
 *   1. `setup_display.ps1`  把绘制目标固定到目标模式（虚拟屏优先，绝不静默退回物理屏）
 *   2. `keep-desktop.ps1`   会话保活的两项无需管理员的措施（注册表 + keep-awake）
 *
 * ## 为什么不塞进 main.js
 *
 * `main.js` 已经 1300 行，而这两步的失败语义与「起服务失败」完全不同：它们不是
 * 「页面打不开」，而是「坐标从此没有意义」。分开写，才能让 `boot()` 里那一段
 * 读起来是一句 `await prepareEnvironment()`，而不是又一段五十行的 spawn 逻辑。
 *
 * ## 为什么失败就退出，而不是记个 warning 继续跑
 *
 * 计划书 §3.1：一旦允许「这次用物理屏、下次用虚拟屏」，坐标基准就有两个，
 * **判断本身就会引入漂移**。所以这里宁可起不来，也不能带着不确定的基准去点。
 *
 * 例外是 `-PreferPhysical`：那是显式的降级开关（开发/调试/厂商软件不在位的机器），
 * 一旦用了它，返回值里的 `display.degraded` 就是 `true`，调用方必须把这件事
 * 写进日志和 `shell:info`，不能假装一切正常。
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

/** 几何固化的目标模式。与 CDP 视口一致，免掉一层缩放换算（计划书 §3.3）。 */
const DEFAULT_MODE = { width: 1920, height: 1080, refresh: 60 };

/**
 * 跑一个 PowerShell 脚本并收集输出。
 *
 * 用 `-NoProfile`：用户机器上的 profile 可能改变 `$ErrorActionPreference`，
 * 那会让「本可以捕获的失败」变成静默成功。用 `-ExecutionPolicy Bypass`：
 * 仓库里的 .ps1 没有签名，默认策略下会被拦；这不是「绕过安全策略」，
 * 而是让随包脚本在默认配置的机器上能跑。
 */
function runPowerShell(scriptPath, args = [], { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const argv = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...args,
    ];
    const child = spawn('powershell.exe', argv, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 把脚本输出整理成一行一句，喂给日志。空行与纯缩进续行保留缩进。 */
function outline(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * 第一步：把绘制目标固定到目标模式。
 *
 * 三种结果，语义不同，不要混：
 *   · `ok`        已在该模式 / 切换并读回校验通过
 *   · `degraded`  用了 `-PreferPhysical`（显式降级，坐标基准是物理屏）
 *   · `failed`    没有可用虚拟屏且没允许降级 —— 这是**启动失败**，不是警告
 */
async function setupDisplay(repoRoot, options = {}) {
  const {
    preferPhysical = false,
    mode = DEFAULT_MODE,
    dryRun = false,
    timeoutMs = 60_000,
    log = () => {},
  } = options;

  const script = path.join(repoRoot, 'tools', 'setup_display.ps1');
  const args = ['-Width', String(mode.width), '-Height', String(mode.height),
    '-Refresh', String(mode.refresh)];
  if (preferPhysical) args.push('-PreferPhysical');
  if (dryRun) args.push('-DryRun');

  const result = await runPowerShell(script, args, { timeoutMs });
  const lines = outline(result.stdout);
  for (const line of lines) log(`[display] ${line}`);
  if (result.stderr.trim()) {
    for (const line of outline(result.stderr)) log(`[display!] ${line}`);
  }
  if (result.timedOut) {
    return { status: 'failed', reason: `setup_display.ps1 超时（${timeoutMs}ms）`,
      lines, code: null };
  }
  if (result.code !== 0) {
    // 退出码是脚本契约的一部分（见 setup_display.ps1 头部）：
    //   2 = 没有可用适配器 / 不支持该模式
    //   3 = 应用失败（切了但没粘住）
    //   4 = 参数非法
    const why = {
      2: '没有可用的显示适配器或目标模式不受支持',
      3: '切换显示模式失败（ChangeDisplaySettingsEx 返回错误或读回不一致）',
      4: '参数非法',
    }[result.code] || `未知退出码 ${result.code}`;
    return { status: 'failed', reason: why, lines, code: result.code };
  }
  return {
    status: preferPhysical ? 'degraded' : 'ok',
    lines,
    code: 0,
    mode: { ...mode },
  };
}

/**
 * 第二步：会话保活。
 *
 * 这一步**不允许**把启动挡下来：注册表写不进去最多是「RDP 最小化后可能不重绘」，
 * 与「坐标没意义」不是一个量级。失败只记 `warnings`，由调用方写进 `shell:info`。
 *
 * `-Reconnect`（`tscon`）刻意**不**放在这里：它需要管理员、会把控制台会话留在解锁
 * 状态，属于必须人决定的动作，不能每次启动都自动跑。
 */
async function keepDesktop(repoRoot, options = {}) {
  const { apply = true, timeoutMs = 30_000, log = () => {} } = options;
  const script = path.join(repoRoot, 'tools', 'keep-desktop.ps1');
  const args = apply ? ['-Apply'] : ['-Status'];

  const result = await runPowerShell(script, args, { timeoutMs });
  const lines = outline(result.stdout);
  for (const line of lines) log(`[keep-desktop] ${line}`);
  if (result.stderr.trim()) {
    for (const line of outline(result.stderr)) log(`[keep-desktop!] ${line}`);
  }
  if (result.timedOut) {
    return { status: 'failed', reason: `keep-desktop.ps1 超时（${timeoutMs}ms）`,
      lines, code: null };
  }
  if (result.code !== 0) {
    return { status: 'failed', reason: `退出码 ${result.code}`, lines, code: result.code };
  }
  return { status: apply ? 'applied' : 'reported', lines, code: 0 };
}

/**
 * 第三步：把虚拟屏接成第二个显示器。
 *
 * 这一步是 v6 才弄清的（计划书 §3.3.3）：驱动装好之后，虚拟屏只在
 * `EnumDisplayDevices` 里存在、能枚举模式，但 `EnumDisplayMonitors` 看不到它。
 * 唯一的有效调用是**最朴素的那两个 flag**：
 *
 *     SetDisplayConfig(0, NULL, 0, NULL, SDC_TOPOLOGY_EXTEND | SDC_APPLY)   // rc=0
 *
 * 任何额外修饰符都会让它整体失效（ALLOW_CHANGES / NO_OPTIMIZATION /
 * SAVE_TO_DATABASE 全试过，一律 ERROR_INVALID_PARAMETER）。细节记在
 * tools/probe_vdd_attach.py 里，那里用 SDC_VALIDATE 穷举过组合。
 *
 * 为什么要单独成一步而不是塞进 setupDisplay：`setup_display.ps1` 管的是
 * 「往哪个适配器切模式」，这一步管的是「这块屏是否属于桌面」，失败语义不同。
 */
async function extendVirtualDisplay(repoRoot, options = {}) {
  const { timeoutMs = 30_000, log = () => {} } = options;
  const script = path.join(repoRoot, 'tools', 'ensure_virtual_display.py');

  const result = await runCommand('py', ['-3', script, '--expect', '1920x1080'],
    { timeoutMs });
  const lines = outline(result.stdout);
  for (const line of lines) log(`[vdisplay] ${line}`);
  if (result.stderr.trim()) {
    for (const line of outline(result.stderr)) log(`[vdisplay!] ${line}`);
  }
  if (result.timedOut) {
    return { status: 'failed', reason: `超时（${timeoutMs}ms）`, lines };
  }
  // 0=已就绪 2=找不到虚拟屏 3=扩展失败 4=分辨率不符
  if (result.code === 0) {
    return { status: 'attached', lines, code: 0 };
  }
  const why = {
    2: '没有可用的虚拟屏适配器（驱动没装 / 没枚举到模式）',
    3: '虚拟屏存在但没能接上桌面',
    4: '分辨率不是预期的 1920x1080',
  }[result.code] || `未知退出码 ${result.code}`;
  return { status: 'failed', reason: why, lines, code: result.code };
}

/** 跑一个普通进程（不是 PowerShell），收集输出。与 runPowerShell 同样不抛。 */
function runCommand(exe, args = [], { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * 完整预处理：几何 → 虚拟屏上桌面 → 保活。
 *
 * 返回结构被 `shell:info` 直接用，所以字段名要能自解释：
 *   `display.status`       `${'ok'|'degraded'|'failed'}`
 *   `virtualDisplay.status` `${'attached'|'failed'}`
 *   `keepDesktop.status`   `${'applied'|'reported'|'failed'}`
 */
async function prepareEnvironment(repoRoot, options = {}) {
  const { preferPhysical = false, mode = DEFAULT_MODE, log = () => {} } = options;

  // 注意：不要写成 `const display = await display(...)` 这类与函数同名的局部变量 ——
  // 同名 `const` 出现在初始化表达式里会落进 TDZ，运行时报
  // "Cannot access 'keepDesktop' before initialization"（实测踩到过）。
  const displayResult = await setupDisplay(repoRoot, { preferPhysical, mode, log });
  if (displayResult.status === 'failed') {
    // 几何没固化就不往下走：见模块头部的解释。
    return {
      display: displayResult,
      virtualDisplay: { status: 'skipped', reason: 'display 失败，未执行' },
      keepDesktop: { status: 'skipped', reason: 'display 失败，未执行' },
      ok: false,
    };
  }

  const virtualDisplayResult = await extendVirtualDisplay(repoRoot, { log });

  // 保活不挡启动：注册表写不进去最多是「RDP 最小化后可能不重绘」，
  // 与「坐标没意义」不是一个量级。
  const keepDesktopResult = await keepDesktop(repoRoot, { log });

  return {
    display: displayResult,
    virtualDisplay: virtualDisplayResult,
    keepDesktop: keepDesktopResult,
    ok: virtualDisplayResult.status === 'attached',
  };
}

module.exports = {
  DEFAULT_MODE,
  extendVirtualDisplay,
  keepDesktop,
  prepareEnvironment,
  runCommand,
  runPowerShell,
  setupDisplay,
};
