'use strict';
/**
 * Electron 主进程 —— 骨架；本机已用 Electron 45.2.2 实测起窗与截图（见 shell/README.md §8）。
 * 仓库里不提交 node_modules，换机器按 README §7 重新安装。
 *
 * 职责只有四件：
 *   1. 单实例：第二个进程把已有窗口叫到前面，然后自己退出。
 *   2. 启动编排：拉起现有零依赖 Node 服务（`逆向/04_重实现/packages/app/src/server.ts`），
 *      轮询 `/api/health` 最多 40 秒；失败弹错误框并清理。
 *   3. 一个窗口：加载 Node 服务自己的 `/chat` `/fleet` `/data` `/suite` 外壳页，
 *      不自己拼 UI、也不改这些页面。
 *   4. 退出清理：窗口全关 / 退出 / Ctrl-C 时把 Node 子进程连同它的子进程一起结束。
 *
 * 命令行：
 *   --port 7810     用指定端口（默认 7803；也认 NAS_SHELL_PORT）
 *   --view chat     首屏视角（chat / fleet / data / suite，默认 chat）
 *   --attach        不启动 Node 服务，直接连接已经在跑的那个端口
 *   --screenshot <文件>  冒烟测试用：窗口加载完 3.5 秒后 capturePage() 存 PNG，然后退出
 *
 * 这里没有任何打包/签名逻辑，也不写业务代码——它只是把已有的 Node 服务装进一个窗口。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/* ---------------------------------------------------------------------------------------------
 * 路径与常量
 * ------------------------------------------------------------------------------------------- */

/** `<repo>/shell` */
const SHELL_DIR = path.resolve(__dirname, '..');
/** `<repo>` */
const REPO_ROOT = path.resolve(SHELL_DIR, '..');
/** 现有 Node 服务入口；仓库结构变了就只改这一行。 */
const SERVER_ENTRY = path.join(REPO_ROOT, '逆向', '04_重实现', 'packages', 'app', 'src', 'server.ts');

const DEFAULT_PORT = 7803;
/** 就绪探测：最多 40 秒，间隔 400 毫秒（首次 import 大量 .ts 时也用不了这么久）。 */
const HEALTH_TIMEOUT_MS = 40_000;
const HEALTH_INTERVAL_MS = 400;
const HEALTH_REQUEST_TIMEOUT_MS = 1500;

/** 与 `web/views/routes.ts` 的四个视角一一对应（主进程不 import 那个 .ts，保持零构建）。 */
const VIEW_IDS = ['chat', 'fleet', 'data', 'suite'];
const VIEW_PATHS = {
  chat: '/chat',
  fleet: '/fleet',
  data: '/data',
  suite: '/suite',
};

/* ---------------------------------------------------------------------------------------------
 * 参数
 * ------------------------------------------------------------------------------------------- */

function parseArgs(argv) {
  const parsed = {
    port: process.env.NAS_SHELL_PORT ? Number(process.env.NAS_SHELL_PORT) : DEFAULT_PORT,
    view: 'chat',
    attach: false,
    screenshot: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--port' || token === '-p') parsed.port = Number(argv[++i]);
    else if (token.startsWith('--port=')) parsed.port = Number(token.slice('--port='.length));
    else if (token === '--view') parsed.view = String(argv[++i] || '');
    else if (token.startsWith('--view=')) parsed.view = token.slice('--view='.length);
    else if (token === '--attach') parsed.attach = true;
    else if (token === '--screenshot') parsed.screenshot = String(argv[++i] || '');
    else if (token.startsWith('--screenshot=')) parsed.screenshot = token.slice('--screenshot='.length);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error(`--port 必须是 1..65535 的整数（收到 ${parsed.port}）`);
  }
  if (!VIEW_IDS.includes(parsed.view)) {
    throw new Error(`--view 必须是 ${VIEW_IDS.join(' / ')}（收到 ${parsed.view || '空'}）`);
  }
  return parsed;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  dialog.showErrorBox('参数不合法', error instanceof Error ? error.message : String(error));
  app.exit(1);
}

const baseUrl = args ? `http://127.0.0.1:${args.port}` : '';

/* ---------------------------------------------------------------------------------------------
 * 状态
 * ------------------------------------------------------------------------------------------- */

let mainWindow = null;
let serverChild = null;
/** 子进程最近的 stderr，失败时原样递给错误框，避免只看到一句“启动超时”。 */
let serverStderr = '';
let stopping = false;
let quitting = false;

/* ---------------------------------------------------------------------------------------------
 * Node 服务
 * ------------------------------------------------------------------------------------------- */

function startServer() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `找不到 Node 服务入口：\n${SERVER_ENTRY}\n\n`
      + '确认仓库里仍有 逆向/04_重实现/packages/app/src/server.ts，'
      + '或者用 --attach 连接已经启动的服务。',
    );
  }

  /*
   * 用系统的 `node`，不是 Electron 自带的运行时：服务是直接跑的 `.ts`（Node 的类型擦除），
   * Electron 内置的 Node 版本未必支持，而 README 里写明的运行前提本来就是 Node ≥ 22.18。
   * `NAS_NODE` 可以指定别的解释器。
   */
  const nodeBinary = process.env.NAS_NODE || 'node';
  serverChild = spawn(
    nodeBinary,
    [SERVER_ENTRY, '--port', String(args.port)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  serverChild.stdout.setEncoding('utf8');
  serverChild.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) console.log(`[server] ${line}`);
    }
  });
  serverChild.stderr.setEncoding('utf8');
  serverChild.stderr.on('data', (chunk) => {
    serverStderr = `${serverStderr}${chunk}`.slice(-8000);
    console.error(`[server] ${String(chunk).trimEnd()}`);
  });
  serverChild.on('error', (error) => {
    serverStderr += `\n${error.message}`;
  });
  serverChild.on('exit', (code, signal) => {
    if (stopping) return;
    console.log(`[shell] Node 服务退出：code=${code} signal=${signal}`);
    // 窗口已经开着、服务却没了：说清楚，而不是留一个空白 iframe。
    if (mainWindow && !quitting) {
      dialog.showErrorBox(
        'Node 服务已退出',
        `退出码 ${code ?? signal}\n${serverStderr.trim() || '（没有 stderr 输出）'}`,
      );
    }
  });
}

/** Windows 上只 kill 父进程会留下 node 的子进程，所以整棵树一起结束。 */
function stopServer() {
  if (!serverChild || serverChild.killed) return;
  stopping = true;
  const pid = serverChild.pid;
  try {
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      serverChild.kill('SIGTERM');
    }
  } catch (error) {
    console.error('[shell] 结束 Node 服务失败：', error);
  }
  serverChild = null;
}

/* ---------------------------------------------------------------------------------------------
 * 就绪探测
 * ------------------------------------------------------------------------------------------- */

function probeHealth() {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);
    fetch(`${baseUrl}/api/health`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return resolve(false);
        const body = await response.json().catch(() => null);
        resolve(Boolean(body && body.ok === true));
      })
      .catch(() => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询 `/api/health` 直到 `ok:true`。子进程提前退出时立刻失败并带上 stderr，
 * 不必等满 40 秒。
 */
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (serverChild && serverChild.exitCode !== null) {
      throw new Error(
        `Node 服务启动即退出（code ${serverChild.exitCode}）。\n`
        + `${serverStderr.trim() || '（没有 stderr 输出）'}`,
      );
    }
    attempts += 1;
    if (await probeHealth()) return attempts;
    await sleep(HEALTH_INTERVAL_MS);
  }
  throw new Error(
    `等了 ${Math.round(HEALTH_TIMEOUT_MS / 1000)} 秒仍未就绪：${baseUrl}/api/health\n`
    + `${serverStderr.trim() || '（没有 stderr 输出）'}`,
  );
}

/* ---------------------------------------------------------------------------------------------
 * 窗口
 * ------------------------------------------------------------------------------------------- */

function viewUrl(view) {
  return `${baseUrl}${VIEW_PATHS[view] || VIEW_PATHS.chat}`;
}

/**
 * `--screenshot` 冒烟测试：等 3.5 秒（外壳页里的 iframe 也要画完）再 capturePage()，
 * 把 PNG 写盘后退出。只用 Electron 自带能力，不引第三方截图库。
 */
function captureAndQuit(win, target) {
  const file = path.resolve(target);
  setTimeout(async () => {
    try {
      const png = (await win.webContents.capturePage()).toPNG();
      if (!png.length) throw new Error('capturePage 返回了空图');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, png);
      console.log(`[shell] 截图已保存：${file}（${png.length} 字节）`);
    } catch (error) {
      console.error('[shell] 截图失败：', error);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  }, 3500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#121212', // 与 agent.css 的 --bg 一致，闪一下也是深色
    title: '野外台站智能体',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外壳不接管外部链接：交给系统浏览器，也不让页面自己开新窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow) return;
    // 页面自己的 <title> 会覆盖 BrowserWindow 的 title，实测值以这里为准。
    console.log(`[shell] 窗口标题：${mainWindow.getTitle()}`);
    if (args.screenshot) captureAndQuit(mainWindow, args.screenshot);
  });

  mainWindow.loadURL(viewUrl(args.view)).catch((error) => {
    dialog.showErrorBox('页面加载失败', `${viewUrl(args.view)}\n${error.message}`);
  });
  return mainWindow;
}

/** 菜单里的视角跳转：重新加载外壳页，Node 服务不动。 */
function navigate(view) {
  if (!VIEW_IDS.includes(view)) return false;
  if (!mainWindow) return false;
  mainWindow.loadURL(viewUrl(view));
  return true;
}

/* ---------------------------------------------------------------------------------------------
 * 菜单（占位：只放应用 / 四个视角 / 开发者 / 帮助）
 * ------------------------------------------------------------------------------------------- */

function buildMenu() {
  const viewItems = VIEW_IDS.map((id) => ({
    label: { chat: '对话', fleet: '机队', data: '数据', suite: '专业面板' }[id],
    type: 'normal',
    click: () => navigate(id),
  }));

  return Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '关于野外台站智能体', role: 'about' },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '视角',
      submenu: viewItems,
    },
    {
      label: '开发者',
      submenu: [
        { label: '重新加载外壳', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开服务地址',
          click: () => { if (baseUrl) shell.openExternal(baseUrl); },
        },
        {
          label: '打开 shell/README.md',
          click: () => { void shell.openPath(path.join(SHELL_DIR, 'README.md')); },
        },
      ],
    },
  ]);
}

/* ---------------------------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------------------------- */

async function boot() {
  if (!args) return;
  Menu.setApplicationMenu(buildMenu());

  ipcMain.handle('shell:info', () => ({
    baseUrl,
    port: args.port,
    view: args.view,
    attach: args.attach,
    views: VIEW_IDS,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
  }));
  ipcMain.handle('shell:navigate', (_event, view) => navigate(String(view)));

  try {
    if (!args.attach) startServer();
    const attempts = await waitForHealth();
    console.log(`[shell] ${baseUrl} 就绪（探测 ${attempts} 次）`);
    createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[shell] 启动失败：', message);
    stopServer();
    dialog.showErrorBox('启动失败', message);
    app.exit(1);
  }
}

/* 单实例：第二个进程只负责把已有窗口叫到前面。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });

  app.on('activate', () => {
    // macOS: 点 Dock 图标时窗口全关了就再开一个（服务还在）。
    if (BrowserWindow.getAllWindows().length === 0 && baseUrl) createWindow();
  });

  app.on('window-all-closed', () => {
    stopServer();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopServer();
      app.quit();
    });
  }
}
