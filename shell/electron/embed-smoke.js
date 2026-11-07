'use strict';
/**
 * W3 嵌入 spike —— 真机跨进程冒烟。
 *
 * 这个脚本**不是单测**（单测在 `test/embed.test.js`，用假 user32 跑状态机）。
 * 它只回答一个单测回答不了的问题：**SetParent 在这台机器的真实窗口上到底成不成立**。
 *
 * 做法（不依赖原版套件、不抢串口、不装任何东西）：
 *
 *   1. 本进程（宿主）开一个 BrowserWindow 作为面板；
 *   2. spawn 第二个 Electron 进程（子），子进程开窗后把自己的 HWND 写进一个文件；
 *   3. 宿主读那个 HWND，调 `embed.attach()` 把它挂进自己的面板；
 *   4. 量一下尺寸、截图、再 `embed.detach()`，确认它回到独立窗口；
 *   5. 关掉子进程。
 *
 * 用第二个 Electron 进程而不是记事本，是因为 HWND 要**可靠地拿到**：
 * 记事本在 Win11 上是打包应用，类名和标题都随语言变，拿窗口只能靠枚举+启发式，
 * 那种"有时能跑"的冒烟证明不了任何事。Electron 子进程可以用
 * `getNativeWindowHandle()` 直接报出自己的 HWND，确定性来自这里。
 *
 * 用法：
 *
 *   cd shell/electron
 *   node_modules\electron\dist\electron.exe ..\..\..\tools\embed_smoke.js --json
 *
 * 退出码：0 全部断言通过 / 1 有断言失败 / 2 环境不具备（非 Windows、缺 koffi）。
 */

const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHELL_DIR = __dirname;
const embed = require(path.join(SHELL_DIR, 'embed.js'));

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 子进程脚本：开一个窗口，把 HWND 的十进制值写进文件，然后一直开着。 */
const CHILD_SCRIPT = `
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const out = process.env.FSA_SMOKE_HWND_FILE;
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 520, height: 380, title: 'EMBED-CHILD-PROBE',
    backgroundColor: '#1f6feb',
  });
  win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="margin:0;background:#1f6feb;color:#fff;font:16px sans-serif;padding:24px">'
    + 'EMBED CHILD PROBE</body>'));
  win.once('ready-to-show', () => {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
    fs.writeFileSync(out, String(hwnd), 'utf8');
    win.show();
  });
});
`;

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP 这个冒烟只在 Windows 上有意义（user32.SetParent）');
    app.exit(2);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsa-embed-smoke-'));
  const hwndFile = path.join(tmp, 'child.hwnd');
  const childScript = path.join(tmp, 'child.js');
  const shotFile = process.env.FSA_SMOKE_SHOT || path.join(tmp, 'embedded.png');
  fs.writeFileSync(childScript, CHILD_SCRIPT, 'utf8');

  let win32;
  try {
    win32 = embed.createWin32();
    check('koffi + user32 可用', true);
  } catch (error) {
    console.log(`SKIP 无法建立 FFI 层：${error.message}`);
    app.exit(2);
    return;
  }

  const host = new BrowserWindow({
    width: 900, height: 700, show: false, backgroundColor: '#121212',
    title: 'EMBED HOST',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await host.loadURL('data:text/html,'
    + encodeURIComponent('<body style="margin:0;background:#121212;color:#888;'
      + 'font:14px sans-serif;padding:12px">EMBED HOST PANEL</body>'));
  host.show();
  await sleep(600);

  const childEnv = { ...process.env, FSA_SMOKE_HWND_FILE: hwndFile };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [childScript], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  let childErr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { childErr += c; });

  // 等子进程写出 HWND（最多 30 秒；Electron 冷启动在慢盘上要十几秒）
  let childHwnd = 0n;
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(hwndFile)) {
      const text = fs.readFileSync(hwndFile, 'utf8').trim();
      if (text) { childHwnd = BigInt(text); break; }
    }
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  if (childHwnd === 0n) {
    check('子进程报出自己的 HWND', false, childErr.trim().slice(-500) || '子进程没有写出 HWND');
    finish(host, child, 1);
    return;
  }
  check('子进程报出自己的 HWND', true, `hwnd=${childHwnd}`);

  // 等窗口真的可见（GetParent/样式操作要求窗口存在且已创建）
  let live = false;
  for (let i = 0; i < 50; i++) {
    if (win32.isWindow(childHwnd)) { live = true; break; }
    await sleep(200);
  }
  check('子窗口句柄在 user32 里有效', live);
  if (!live) { finish(host, child, 1); return; }

  const hostBuf = host.getNativeWindowHandle();
  const hostHwnd = hostBuf.length >= 8
    ? hostBuf.readBigUInt64LE(0)
    : BigInt(hostBuf.readUInt32LE(0));
  check('宿主窗口句柄可读', hostHwnd !== 0n, `hwnd=${hostHwnd}`);

  const hostClient = win32.getClientSize(hostHwnd) || { width: 0, height: 0 };
  check('宿主客户区可量', hostClient.width > 0 && hostClient.height > 0,
    `${hostClient.width}×${hostClient.height}`);

  // ---- 核心断言：真的挂上了 ----
  const e = embed.createEmbedder(win32);
  const styleBeforeAttach = win32.getStyle(childHwnd);
  let st = null;
  try {
    st = e.attach({ child: childHwnd, parent: hostHwnd });
  } catch (error) {
    check('attach 成功', false, error.message);
    finish(host, child, 1);
    return;
  }
  check('attach 成功', st.attached, JSON.stringify({
    dpiMismatch: st.dpiMismatch, dpiScale: st.dpiScale, focusDeferred: st.focusDeferred,
  }));

  await sleep(800);
  const realParent = win32.getParent(childHwnd);
  check('user32 确认父窗口已变成宿主', Number(realParent) === Number(hostHwnd),
    `GetParent=${realParent} 期望 ${hostHwnd}`);

  const style = win32.getStyle(childHwnd);
  const styleBits = BigInt(style) & 0xffffffffn;
  check('WS_CHILD 已置位', (BigInt(style) & 0x40000000n) !== 0n, `style=0x${styleBits.toString(16)}`);
  check('WS_POPUP 已清除', (BigInt(style) & 0x80000000n) === 0n, `style=0x${styleBits.toString(16)}`);

  const childClient = win32.getClientSize(childHwnd) || { width: 0, height: 0 };
  check('子窗口已铺满宿主客户区（±4px 容差）',
    Math.abs(childClient.width - Math.round(hostClient.width * st.dpiScale)) <= 4
    && Math.abs(childClient.height - Math.round(hostClient.height * st.dpiScale)) <= 4,
    `子 ${childClient.width}×${childClient.height} / 宿主 ${hostClient.width}×${hostClient.height} × ${st.dpiScale}`);

  // 截图作为证据。注意：capturePage() 只截 Electron 自己的渲染面，
  // **截不到 SetParent 挂进来的原生子窗口**（实测：面板是黑的，子进程那块蓝色不在图上）。
  // 所以下面还有一次真正的整屏抓取；这条只用于证明宿主窗口本身渲染正常。
  try {
    const png = (await host.webContents.capturePage()).toPNG();
    fs.writeFileSync(shotFile, png);
    check('宿主渲染面截图落盘（不含原生子窗口）', png.length > 1000, `${shotFile}（${png.length} 字节）`);
  } catch (error) {
    check('宿主渲染面截图落盘（不含原生子窗口）', false, error.message);
  }

  /*
   * 真正的"视觉上嵌进去了"证据：抓整屏。
   * capturePage() 走的是 Electron 的合成器，原生子窗口不在其中——拿它当证据会得出
   * "嵌入没生效"的错误结论。整屏抓取走 GDI，看到的是用户眼睛看到的东西。
   */
  const screenShot = process.env.FSA_SMOKE_SCREEN;
  if (screenShot) {
    try {
      host.moveTop();
      host.focus();
      await sleep(600);
      const ps = [
        '-NoProfile', '-Command',
        "$ErrorActionPreference='Stop';"
        + 'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;'
        + '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;'
        + '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;'
        + '$g=[System.Drawing.Graphics]::FromImage($bmp);'
        + '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);'
        + `$bmp.Save('${screenShot.replace(/'/g, "''")}');`
        + '$g.Dispose();$bmp.Dispose()',
      ];
      const r = spawnSync('powershell', ps, { windowsHide: true, encoding: 'utf8' });
      const ok = fs.existsSync(screenShot) && fs.statSync(screenShot).size > 5000;
      check('整屏抓取落盘（这条才看得出原生子窗口）', ok,
        r.status === 0 && ok ? `${screenShot}（${fs.statSync(screenShot).size} 字节）` : (r.stderr || '').slice(-300));
    } catch (error) {
      check('整屏抓取落盘（这条才看得出原生子窗口）', false, error.message);
    }
  }

  // ---- 一键退回独立窗口 ----
  let det = null;
  try {
    det = e.detach();
  } catch (error) {
    check('detach 成功', false, error.message);
  }
  if (det) {
    check('detach 成功', det.detached);
    await sleep(400);
    const after = win32.getParent(childHwnd);
    check('解挂后父窗口已摘掉', Number(after) === 0, `GetParent=${after}`);
    const afterStyle = win32.getStyle(childHwnd);
    const afterBits = BigInt(afterStyle) & 0xffffffffn;
    check('解挂后不再是子窗口', (BigInt(afterStyle) & 0x40000000n) === 0n,
      `style=0x${afterBits.toString(16)}`);
    /*
     * 这里比的是"逐位等于挂载前"，而不是"WS_POPUP 回来了"。
     * 挂载前那个窗口是被 Windows 以 WS_OVERLAPPEDWINDOW 创建的（没有 WS_POPUP），
     * 拿一个从来没出现过的位当判据只会得到假 FAIL —— 实测踩过。
     */
    check('解挂后样式与挂载前逐位一致',
      BigInt(afterStyle) === BigInt(styleBeforeAttach),
      `挂载前 0x${(BigInt(styleBeforeAttach) & 0xffffffffn).toString(16)} / 解挂后 0x${afterBits.toString(16)}`);
  }

  if (st && st.warnings.length) {
    console.log('\n嵌入期间的告警（这些是设计上会记录的，不是失败）：');
    for (const w of st.warnings) console.log('  · ' + w);
  }

  finish(host, child, RESULTS.some((r) => !r.ok) ? 1 : 0);
}

function finish(host, child, code) {
  try { if (child && child.exitCode === null) child.kill(); } catch { /* 已经没了 */ }
  try { if (host && !host.isDestroyed()) host.destroy(); } catch { /* 已经没了 */ }

  const passed = RESULTS.filter((r) => r.ok).length;
  console.log(`\n合计 ${passed}/${RESULTS.length} PASS`);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ results: RESULTS }, null, 1));
  }
  app.exit(code === 0 && passed === RESULTS.length ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error('冒烟脚本自身出错：', error);
  app.exit(1);
});
