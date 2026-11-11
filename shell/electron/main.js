'use strict';
/**
 * Electron 主进程 —— 外壳；本机已用 Electron 45.2.2 实测起窗与截图（见 shell/README.md §8）。
 * 仓库里不提交 node_modules，换机器按 README §7 重新安装。
 *
 * 职责：
 *   1. 单实例：第二个进程把已有窗口叫到前面，然后自己退出；顺带取 argv 里的
 *      `fsa://job/<id>`——Windows 把协议 URL 当命令行参数递进来，所以单实例回调
 *      和冷启动都走同一条解析，不必写两套。
 *   2. 启动编排：先按需解压 payload（`payload.js`），再拉起两个服务 ——
 *      零依赖 Node 服务（`逆向/04_重实现/packages/app/src/server.ts`）与
 *      Python 服务（`src/fieldstation/runtimes/server.py`，`pyserver.js`）；
 *      各自探就绪，失败弹错误框并清理。
 *   3. 窗口：加载 Node 服务自己的 `/chat` `/fleet` `/data` `/suite` 外壳页，
 *      不自己拼 UI、也不改这些页面；可以开多个，每个窗口独立记录。
 *   4. 退出清理：真的退出时把两个子进程连同它们的子进程一起结束。
 *      关掉最后一个窗口**不等于**退出——有托盘就藏进托盘，服务留着；
 *      服务是全局的，任何一个窗口关掉都不许把它杀掉。
 *   5. 托盘 / 崩溃守护 / 主题密度：这三件解决的都是“窗口看不见的时候怎么办”。
 *      没有它们，渲染进程一崩就只剩一个空白窗口，用户既不知道发生了什么也没法恢复。
 *
 * 命令行：
 *   --port 7810       用指定端口（默认 7803；也认 NAS_SHELL_PORT）
 *   --view chat       首屏视角（chat / fleet / data / suite，默认 chat）
 *   --attach          不启动 Node 服务，直接连接已经在跑的那个端口；
 *                     同时**隐含** Python 服务也只连不拉（见下方 --attach-python）
 *   --python-port 8788  用指定端口拉 Python 服务（默认 8788）
 *   --attach-python   只让 Python 服务「只连不拉」，Node 服务照常拉起。
 *                     用于「Node 我自己拉、Python 用现成的」这种分开调试的场合；
 *                     `--attach` 已经隐含它，这个开关是给不想连 Node 也 attach 的人用的
 *   --no-python       完全不碰 Python 服务（无解释器的机器上启动外壳用），优先级最高
 *   --payload-zip <文件>  指定 payload.zip（默认 逆向/05_打包/payload.zip，或 NAS_PAYLOAD_ZIP）
 *   --theme dark      起始主题（system / light / dark，默认 system）
 *   --density compact 起始密度（comfortable / compact，默认 comfortable）
 *   --no-tray         不建托盘，关窗就退出（冒烟测试 / 无桌面环境用）
 *   --screenshot <文件>  冒烟测试用：窗口加载完 3.5 秒后 capturePage() 存 PNG，然后退出
 *
 * 这里没有任何打包/签名逻辑，也不写业务代码——它只是把已有的两个服务装进一个窗口。
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// 深链解析单独成模块：它是外部输入的第一道门，需要逐条测试，
// 而 main.js 一 require 就会去建 Electron 应用、起服务，没法在单元测试里加载。
const { parseDeepLink, linkFromArgv } = require('./deeplink.js');
// payload 解压（壳-1）与 Python 服务（壳-2）同理：逻辑都在各自模块里，
// main.js 只负责「什么时候调、失败时怎么报」。
const payload = require('./payload.js');
const pyserver = require('./pyserver.js');

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
const VIEW_LABELS = { chat: '对话', fleet: '机队', data: '数据', suite: '专业面板' };

/**
 * 深链认 `fsa://job/<id>` 与 `fsa://device/<id>` 两种。
 *
 * id 的字符集**刻意收窄**：它会被拼进 URL 查询串交给页面，又可能来自任意第三方
 * 程序发起的协议调用，允许 `?` `&` `#` `/` 之类就等于把注入点直接送给外部调用方。
 * 收窄是为了防注入，不要为了「支持更多 id」而放宽（规格 25.15.2 原话）。
 *
 * 解析与校验都在 `deeplink.js` 里（那里可单独测试）；这里只剩这个常量。
 * 校验失败一律「记日志 + 忽略」，绝不让一个畸形链接把主进程带崩。
 */
const PROTOCOL = 'fsa';

/**
 * 同一窗口连续崩溃的重载上限。超过就不再自动重载——
 * 否则一个必然崩的页面会变成无限重载循环，用户连菜单都点不到。
 */
const RENDER_RELOAD_LIMIT = 2;

const THEMES = ['system', 'light', 'dark'];
const DENSITIES = ['comfortable', 'compact'];
const THEME_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };
const DENSITY_LABELS = { comfortable: '舒适', compact: '紧凑' };

/**
 * 窗口底色取 `agent.css` 的 `--bg`（深 `#121212` / 浅 `#f2f0e5`），
 * 这样首帧到页面画完之间闪的那一下也是同一个颜色，而不是白闪。
 */
const BACKGROUND = { dark: '#121212', light: '#f2f0e5' };

/**
 * 托盘图标。仓库里没有 .ico/.png，也不想为一张 16×16 的图新增二进制资源
 * （打包时还得在 electron-builder 里另配 icon，反而多一个会漂的地方），
 * 所以内嵌一张自己画的 16×16 RGBA PNG：三根柱子，正好是“台站数据”的意思。
 * 限制：Windows 上这是 1× 位图，高 DPI 屏幕会被系统放大得略糊；真要出正式版，
 * 应换成 .ico（含 16/24/32/48/256 多尺寸）再 `nativeImage.createFromPath`。
 */
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVR4nGNgGFngxo0b/2F4JBiATfEgNoBYxcPZgAEFACts6M/lAwNNAAAAAElFTkSuQmCC';

/* ---------------------------------------------------------------------------------------------
 * 参数
 * ------------------------------------------------------------------------------------------- */

function parseArgs(argv) {
  const parsed = {
    port: process.env.NAS_SHELL_PORT ? Number(process.env.NAS_SHELL_PORT) : DEFAULT_PORT,
    view: 'chat',
    attach: false,
    screenshot: '',
    theme: 'system',
    density: 'comfortable',
    tray: true,
    // 壳-2：Python 服务。默认拉起来（图上原文「拉起 Python 服务」），三个开关能单独关掉。
    python: true,
    pythonPort: pyserver.DEFAULT_PORT,
    attachPython: false,
    // 壳-1：payload.zip 的位置。空 = 用 payload.js 的默认/环境变量。
    payloadZip: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--port' || token === '-p') parsed.port = Number(argv[++i]);
    else if (token.startsWith('--port=')) parsed.port = Number(token.slice('--port='.length));
    else if (token === '--view') parsed.view = String(argv[++i] || '');
    else if (token.startsWith('--view=')) parsed.view = token.slice('--view='.length);
    else if (token === '--attach') parsed.attach = true;
    else if (token === '--theme') parsed.theme = String(argv[++i] || '');
    else if (token.startsWith('--theme=')) parsed.theme = token.slice('--theme='.length);
    else if (token === '--density') parsed.density = String(argv[++i] || '');
    else if (token.startsWith('--density=')) parsed.density = token.slice('--density='.length);
    else if (token === '--no-tray') parsed.tray = false;
    else if (token === '--screenshot') parsed.screenshot = String(argv[++i] || '');
    else if (token.startsWith('--screenshot=')) parsed.screenshot = token.slice('--screenshot='.length);
    else if (token === '--python-port') parsed.pythonPort = Number(argv[++i]);
    else if (token.startsWith('--python-port=')) {
      parsed.pythonPort = Number(token.slice('--python-port='.length));
    } else if (token === '--attach-python') parsed.attachPython = true;
    else if (token === '--no-python') parsed.python = false;
    else if (token === '--payload-zip') parsed.payloadZip = String(argv[++i] || '');
    else if (token.startsWith('--payload-zip=')) {
      parsed.payloadZip = token.slice('--payload-zip='.length);
    }
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error(`--port 必须是 1..65535 的整数（收到 ${parsed.port}）`);
  }
  if (!VIEW_IDS.includes(parsed.view)) {
    throw new Error(`--view 必须是 ${VIEW_IDS.join(' / ')}（收到 ${parsed.view || '空'}）`);
  }
  if (!THEMES.includes(parsed.theme)) {
    throw new Error(`--theme 必须是 ${THEMES.join(' / ')}（收到 ${parsed.theme || '空'}）`);
  }
  if (!DENSITIES.includes(parsed.density)) {
    throw new Error(`--density 必须是 ${DENSITIES.join(' / ')}（收到 ${parsed.density || '空'}）`);
  }
  if (!Number.isInteger(parsed.pythonPort) || parsed.pythonPort < 1 || parsed.pythonPort > 65535) {
    throw new Error(`--python-port 必须是 1..65535 的整数（收到 ${parsed.pythonPort}）`);
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

/** 所有窗口（多窗口要“全关才算全关”，所以不能只留一个引用）。插入顺序即创建顺序。 */
const windows = new Set();
/** 最近一次获得焦点的窗口；`BrowserWindow.getFocusedWindow()` 在弹对话框后会返回 null。 */
let lastFocusedWindow = null;
/** 第一个窗口。`--screenshot` 只拍它，否则多开会拍出一堆同名文件。 */
let firstWindow = null;
let tray = null;

let serverChild = null;
/** 子进程最近的 stderr，失败时原样递给错误框，避免只看到一句“启动超时”。 */
let serverStderr = '';
let stopping = false;
let quitting = false;
/**
 * 服务就绪了没有。第二个实例可能在启动编排还没跑完时就到达，
 * 那时开窗口只会加载一个还没监听端口的地址，所以先看这个标记。
 */
let serverReady = false;

/**
 * Python 服务（壳-2）。`--no-python` 时一直是 null，`--attach-python` 时只有 url 没有 child。
 * 与 Node 服务**互不阻塞**：Python 起不来只记日志 + 把状态写进 `shell:info`，
 * 不让外壳打不开窗口 —— 界面的入口在 Node 服务那边，缺 Python 是能力缺失，不是启动失败。
 */
let pythonChild = null;
let pythonState = 'idle';   // idle / starting / ready / attached / failed / skipped
let pythonUrl = '';
let pythonError = '';

/**
 * payload 解压进度（壳-1）。解压发生在**窗口还不存在**的时候，所以进度只能先存在这里：
 * 窗口建好后再问 `shell:info`，就能看到「已解压 N/M」而不是只有一个最终结果。
 * 没有这一步，解压期间用户看到的就是一个什么都不发生的桌面。
 */
let payloadProgress = { done: 0, total: 0, text: '', state: 'idle' };

/** 当前密度；菜单切换时改它，窗口创建和切换后都用它。 */
let density = args ? args.density : DENSITIES[0];
/**
 * 冷启动那一份深链（`{ kind, id }` 或 `null`）。协议 URL 在 `app.whenReady()` 之前
 * 就躺在 argv 里，那时窗口和服务都还没有，只能先存下来、等首个窗口建好再喂给它。
 *
 * 存整个对象而不只是 id：`device` 与 `job` 要去不同的视角，丢了 kind 就只能猜。
 */
let pendingLink = null;

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
    // 这里用“还有窗口”而不是“有主窗口”——多开之后没有唯一的主窗口了。
    if (windows.size > 0 && !quitting) {
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
 * payload 解压（壳-1）
 * ------------------------------------------------------------------------------------------- */

/** `<userData>/payload`：解压目标，删掉它就能验证「首次解压 / 二次跳过」。 */
function payloadDir() {
  return path.join(app.getPath('userData'), 'payload');
}

/**
 * 启动前把 payload 准备好。
 *
 * 三种结果都不阻塞启动：
 *   · `absent`    仓库里没有 payload.zip（开发态常态）→ 记一行日志，继续；
 *   · `skipped`   三方校验通过 → 秒过；
 *   · `extracted` 真解压了 → 日志里有「已解压 N/M」与总耗时。
 *
 * 校验失败（zip 损坏、清单与磁盘对不上）**不吞**：抛出去由 `boot()` 弹框并退出。
 * 那种情况下继续启动等于拿一棵半坏的树去起服务，坏法会在别处以「Python 起不来」出现。
 */
async function preparePayload() {
  const options = {
    repoRoot: REPO_ROOT,
    userDataDir: app.getPath('userData'),
    env: args.payloadZip ? { ...process.env, NAS_PAYLOAD_ZIP: args.payloadZip } : process.env,
    // 相对路径按启动时的 cwd 解析。Electron 的 cwd 是 `shell/electron`（npx electron .），
    // 而 `app.getPath` 与 `REPO_ROOT` 都是绝对的 —— 不写死这一条，日志里的相对路径
    // 就会和它实际解析出来的位置对不上。
    cwd: process.cwd(),
    log: (line) => console.log(line),
    onProgress: (progress) => {
      // 主进程控制台是解压期间唯一的观测点（窗口这时还没建），所以先写一份到状态里，
      // 让随后打开的窗口还能从 `shell:info` 读到「已解压 N/M」。
      // 日志本身的节流在 payload.js 里做过了（5% 一步），这里不重复节流。
      payloadProgress = {
        done: progress.done,
        total: progress.total,
        text: progress.text,
        state: progress.done === progress.total ? 'done' : 'running',
      };
    },
  };
  const result = await payload.preparePayload(options);
  if (result.status === 'skipped') {
    const summary = `已解压 ${result.files}/${result.files}（沿用上次结果）`;
    payloadProgress = {
      done: result.files, total: result.files, text: summary, state: 'skipped',
    };
    console.log(`[shell] payload 已是最新，跳过解压（${result.files} 文件）`);
  } else if (result.status === 'extracted') {
    payloadProgress = {
      done: result.files,
      total: result.files,
      text: payload.formatProgress(result.files, result.files),
      state: 'done',
    };
    console.log(`[shell] payload 解压完成：${result.files} 文件 / `
      + `${payload.formatBytes(result.bytes)}（${result.reason}）`);
  } else {
    payloadProgress = { done: 0, total: 0, text: '没有 payload.zip', state: result.status };
  }
  return result;
}

/* ---------------------------------------------------------------------------------------------
 * Python 服务（壳-2）
 * ------------------------------------------------------------------------------------------- */

/**
 * 拉起（或连接）Python 服务。**不抛**：失败只记状态。
 *
 * 理由：界面的入口是 Node 服务。Python 跑不起来时，用户仍然应该能看到窗口、
 * 能读日志，而不是被一个错误框挡在门外。缺 Python 是一个可见的降级状态
 * （`shell:info` 里的 `python.state`），不是启动失败。
 */
async function startPython() {
  const choice = pyserver.resolvePythonMode({
    python: args.python, attach: args.attach, attachPython: args.attachPython,
  });
  if (choice.mode === 'skip') {
    pythonState = 'skipped';
    console.log(`[shell] 跳过 Python 服务（${choice.reason}）`);
    return;
  }

  pythonState = 'starting';
  try {
    if (choice.mode === 'attach') {
      const attached = await pyserver.attachOnly({ port: args.pythonPort });
      if (!attached.attached) {
        pythonState = 'failed';
        pythonError = `${choice.reason} 指定只连不拉，但 ${pyserver.pythonHealthUrl(
          `http://127.0.0.1:${args.pythonPort}`)} 连不上`;
        console.error(`[shell] ${pythonError}`);
        return;
      }
      pythonUrl = attached.url;
      pythonState = 'attached';
      console.log(`[shell] Python 服务已在跑，只连不拉（${choice.reason}）：${pythonUrl}`);
      return;
    }

    const started = await pyserver.launchPythonService({
      repoRoot: REPO_ROOT,
      payloadDir: payloadDir(),
      python: process.env.NAS_PYTHON || null,
      startPort: args.pythonPort,
      // 进程一 spawn 就交出来，不等就绪：`boot()` 可能在 `await pythonPromise` 之前
      // 就失败（Node 服务没起、payload 坏了），那时必须能杀掉已经拉起的 Python。
      onSpawn: (child) => { pythonChild = child; },
      log: (line) => console.log(line),
    });
    pythonChild = started.child;
    pythonUrl = started.url;
    pythonState = 'ready';
    console.log(`[shell] Python 服务就绪：${pythonUrl}`
      + `（解释器 ${started.python.path}，来源 ${started.python.source}）`);
    pythonChild.on('exit', (code, signal) => {
      if (stopping || quitting) return;
      pythonState = 'failed';
      pythonError = `退出码 ${code ?? signal}`;
      console.error(`[shell] Python 服务退出：code=${code} signal=${signal}`);
      // 不弹框：窗口该继续能用。状态已经在 shell:info 里，页面能读到。
    });
  } catch (error) {
    pythonState = 'failed';
    pythonError = error instanceof Error ? error.message : String(error);
    console.error('[shell] Python 服务未就绪：', pythonError);
  }
}

/** 结束 Python 服务整棵树（与 `stopServer()` 同一做法）。幂等。 */
function stopPython() {
  if (!pythonChild) return;
  const child = pythonChild;
  pythonChild = null;
  pyserver.stopPythonService({ child, log: (line) => console.log(`[shell] ${line}`) });
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

/**
 * 视角地址。深链参数不是路由而是查询串：路由表（`routes.ts`）只认 pathname，
 * 多一个查询串不会让它 404，页面侧却能直接 `location.search` 拿到 id。
 *
 * `param` 给键名：`job` → 编队台，`device` → 套件台。默认 `job` 是为了不动老调用点。
 */
function viewUrl(view, id, param = 'job') {
  const base = `${baseUrl}${VIEW_PATHS[view] || VIEW_PATHS.chat}`;
  if (!id) return base;
  return `${base}?${param}=${encodeURIComponent(id)}`;
}

/** 焦点窗口；托盘/菜单这类“对当前窗口做事”的入口都从这里取，避免各自猜一个。 */
function focusedWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed()) return lastFocusedWindow;
  for (const win of windows) {
    if (!win.isDestroyed()) return win;
  }
  return null;
}

/** 窗口里当前是哪个视角：从实际 URL 反查，菜单“在新窗口打开当前视角”才不会指错。 */
function viewOfWindow(win) {
  if (!win || win.isDestroyed()) return args.view;
  let pathname;
  try {
    pathname = new URL(safeUrl(win) || baseUrl).pathname.replace(/\/+$/, '') || '/';
  } catch (error) {
    return args.view;
  }
  return VIEW_IDS.find((id) => VIEW_PATHS[id] === pathname) || args.view;
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

/** 读 URL 的安全版：窗口/渲染进程已经在销毁过程中时 `getURL()` 会抛。 */
function safeUrl(win) {
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return '';
    return win.webContents.getURL() || '';
  } catch (error) {
    return '';
  }
}

/**
 * 每个窗口自己的记录。多开之后“崩溃重载计数 / 是否正在关闭”
 * 放进同一个对象，避免用一堆并行数组按索引对齐——那种写法关掉一个窗口就会错位。
 */
const windowMeta = new Map();

/** 该关窗，还是该收进托盘？托盘存在且不是真退出时一律收起。 */
function shouldHideOnClose() {
  return Boolean(tray) && !app.isQuitting;
}

/**
 * 挂上渲染进程的异常监听。
 * 这里必须先分清“崩了”和“用户正常关窗”：关窗过程中 Chromium 也会报
 * `render-process-gone`（reason 可能是 killed），照崩处理就等于每次关窗都收获一个错误框。
 * 所以用 meta.closing 把正常关闭挡掉，它只在 close 真的放行时才立起来。
 */
function attachCrashGuard(win, meta) {
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && details.reason ? details.reason : 'unknown';
    const exitCode = details && details.exitCode !== undefined ? details.exitCode : '?';
    const url = safeUrl(win);
    console.error(`[shell] 渲染进程退出：reason=${reason} exitCode=${exitCode} url=${url}`);
    // 正常关闭（窗口正在关 / app 正在退出）不算故障，只留日志。
    if (reason === 'clean-exit' || meta.closing || quitting) return;
    if (win.isDestroyed()) return;

    const canReload = meta.reloads < RENDER_RELOAD_LIMIT;
    if (canReload) meta.reloads += 1;
    const detail = [
      `原因：${reason}`,
      `退出码：${exitCode}`,
      `地址：${url || '（空）'}`,
      canReload ? '' : '已经连续崩溃多次，自动重载可能一直失败，建议退出后重开。',
    ].filter(Boolean).join('\n');

    dialog.showMessageBox(win, {
      type: 'error',
      title: '页面崩溃',
      message: '页面进程已崩溃，窗口内容是空白的。',
      detail,
      buttons: canReload ? ['重新加载', '退出外壳'] : ['退出外壳'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (canReload && response === 0) {
        if (!win.isDestroyed()) win.reload();
        return;
      }
      beginQuit();
      app.quit();
    }).catch((error) => {
      console.error('[shell] 崩溃提示框失败：', error);
    });
  });

  win.webContents.on('unresponsive', () => {
    const url = safeUrl(win);
    console.warn(`[shell] 页面无响应：${url}`);
    if (meta.closing || quitting || win.isDestroyed()) return;
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '页面无响应',
      message: '页面暂时没有响应，可能正在做很重的计算。',
      detail: `地址：${url || '（空）'}\n可以继续等，也可以重新加载这个窗口。`,
      buttons: ['继续等待', '重新加载'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response === 1 && !win.isDestroyed()) win.reload();
    }).catch((error) => {
      console.error('[shell] 无响应提示框失败：', error);
    });
  });
}

/**
 * `child-process-gone` 是 app 级事件，只有一条通路。
 * 这里**只记录不弹框**：Node 服务自己的退出已经由 `serverChild.on('exit')` 弹过一次，
 * 两处都弹就会连着出现两个框，用户根本分不清是哪一个进程没了。
 */
function watchChildProcesses() {
  app.on('child-process-gone', (_event, details) => {
    const info = details || {};
    const line = `type=${info.type || '?'} reason=${info.reason || '?'} exitCode=${info.exitCode ?? '?'}`
      + (info.serviceName ? ` service=${info.serviceName}` : '')
      + (info.name ? ` name=${info.name}` : '');
    if (info.reason === 'clean-exit') {
      console.log(`[shell] 子进程正常退出：${line}`);
      return;
    }
    console.error(`[shell] 子进程异常退出：${line}`);
  });
}

/**
 * 建一个窗口。`options.view` / `options.job` 让托盘、深链、菜单都能直接指定首屏，
 * 不必“先建窗再跳一次”——那会白加载一遍页面。
 */
function createWindow(options = {}) {
  const view = options.view && VIEW_IDS.includes(options.view) ? options.view : args.view;
  // 深链参数：编队台用 `job`，套件台用 `device`。两者都是「选中某个东西」，
  // 只是去的地方不同，所以合并成一份深链参数处理。
  const linkParam = typeof options.device === 'string' && options.device
    ? { name: 'device', id: options.device }
    : { name: 'job', id: typeof options.job === 'string' ? options.job : '' };

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: windowBackground(), // 与 agent.css 的 --bg 一致，闪一下也是同一个底色
    title: '野外台站智能体',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const meta = { reloads: 0, closing: false };
  windows.add(win);
  windowMeta.set(win, meta);
  lastFocusedWindow = win;
  if (!firstWindow) firstWindow = win;

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('focus', () => { lastFocusedWindow = win; });

  /*
   * 关窗两种语义：
   *   · 有托盘 → 只藏起来，服务继续跑（用户按 × 通常只是想收起来）；
   *   · 没托盘（或正在真退出）→ 照原来那样销毁，全部关完就退出。
   * `preventDefault()` 之后窗口不进销毁流程，所以 `render-process-gone` 不会被误报成崩溃。
   */
  win.on('close', (event) => {
    if (!shouldHideOnClose() || win.isDestroyed()) {
      meta.closing = true;
      return;
    }
    event.preventDefault();
    win.hide();
    console.log('[shell] 窗口已收进托盘');
  });

  win.on('closed', () => {
    meta.closing = true;
    windows.delete(win);
    windowMeta.delete(win);
    if (firstWindow === win) firstWindow = null;
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });

  attachCrashGuard(win, meta);

  // 外壳不接管外部链接：交给系统浏览器，也不让页面自己开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    // 页面自己的 <title> 会覆盖 BrowserWindow 的 title，实测值以这里为准。
    console.log(`[shell] 窗口标题：${win.getTitle()}`);
    // 页面自己不会读主题（preload 不在这次改动范围内），只能在每次加载完后写一次属性。
    // 必须用 on 而不是 once：切视角也是 loadURL，换页之后属性就没了。
    syncPageAppearance(win, appearanceState());
    if (args.screenshot && win === firstWindow) captureAndQuit(win, args.screenshot);

    /*
     * 主动探一次页面是否真的挂载成功。
     *
     * 为什么不在页面里加：那时「点了没反应」只能靠猜。这里从主进程执行一段 JS，
     * 直接问页面「关键节点在不在、监听器有没有响应」，答案进日志。
     * 只检查结构，不改页面行为。
     */
    win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      const ta = q('textarea[aria-label="输入消息"]');
      const btn = q('.vw-chat-example-btn');
      const out = {
        readyState: document.readyState,
        hasTextarea: !!ta,
        hasExampleBtn: !!btn,
        textareaDisabled: ta ? ta.disabled : null,
        scriptCount: document.scripts.length,
      };
      if (btn && ta) {
        const before = ta.value;
        btn.click();
        out.valueAfterClick = ta.value;
        out.clickWorked = ta.value !== before;
        ta.value = before;
      }
      return out;
    })()`).then((info) => {
      console.log('[shell] 页面自检：' + JSON.stringify(info));
    }).catch((error) => {
      console.error('[shell] 页面自检失败：' + (error && error.message));
    });
  });

  /*
   * 渲染进程的控制台与未捕获异常**必须转发到主进程日志**。
   *
   * 为什么：之前「按钮点了没反应」排查了很久，因为页面里的 JS 报错全被吞掉 ——
   * Electron 默认不把 console 输出到 stdout，于是界面看起来正常、点了没反应，
   * 而主进程日志一片干净。加上这几条之后，「点了没反应」会直接看到原因。
   *
   * **Electron 35+ 的签名变了**：`console-message` 现在传一个事件对象
   * (`event.level` / `event.message` / `event.lineNumber` / `event.sourceId`)，
   * 旧的 `(event, level, message, line, sourceId)` 五个位置参数**不再填充**，
   * 于是监听器挂了却什么都不打印 —— 这个坑本身就很隐蔽（实测 Electron 45.2.2）。
   * 两种签名都兼容，避免升级/降级时又静默失效。
   */
  win.webContents.on('console-message', (...params) => {
    const first = params[0];
    let level, message, line, sourceId;
    if (first && typeof first === 'object' && 'message' in first) {
      ({ level, message, lineNumber: line, sourceId } = first);
    } else {
      [, level, message, line, sourceId] = params;
    }
    const tag = ['log', 'warn', 'error', 'debug'][level] || 'log';
    const where = sourceId ? ` (${sourceId}:${line})` : '';
    console.log(`[render:${tag}] ${message}${where}`);
  });

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[render] preload 加载失败 ${preloadPath}：${error && error.message}`);
  });

  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[render] 页面加载失败 ${url}：${desc}（${code}）`);
  });

  const initialUrl = viewUrl(view, linkParam.id, linkParam.name);
  win.loadURL(initialUrl).catch((error) => {
    dialog.showErrorBox('页面加载失败', `${initialUrl}\n${error.message}`);
  });
  return win;
}

/** 对指定窗口切视角；未知 id 返回 false，交给调用方决定要不要提示。 */
function navigateToWindow(win, view) {
  if (!VIEW_IDS.includes(view)) return false;
  if (!win || win.isDestroyed()) return false;
  win.loadURL(viewUrl(view));
  return true;
}

/** 菜单用的切视角：作用在聚焦窗口上，Node 服务不动。 */
function navigate(view) {
  return navigateToWindow(focusedWindow(), view);
}

/** 把窗口提到前面（最小化时先还原）。托盘“显示窗口”和第二个实例共用。 */
function showWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

/**
 * 现在能不能开新窗口。服务还没就绪时开窗口，只会得到一个连不上端口的空白页——
 * 那比什么都不发生更难解释，所以统一挡在这里。
 */
function canCreateWindow() {
  return Boolean(baseUrl) && serverReady;
}

/**
 * 显示窗口。全被藏进托盘之后点托盘时可能一个窗口都不剩下（用户从任务栏关掉了），
 * 这时开一个新的——总比点了托盘什么都不发生强。
 */
function showOrCreateWindow() {
  const win = focusedWindow();
  if (win) return showWindow(win);
  if (!canCreateWindow()) return false;
  return showWindow(createWindow());
}

/** 隐藏所有窗口。显式“隐藏窗口”按“都收起来”理解，只藏一个会让用户以为没生效。 */
function hideAllWindows() {
  let hidden = 0;
  for (const win of windows) {
    if (!win.isDestroyed() && win.isVisible()) {
      win.hide();
      hidden += 1;
    }
  }
  return hidden;
}

/* ---------------------------------------------------------------------------------------------
 * 深链：把已解析的 `{kind, id}` 送到位
 *
 * 解析与校验在 `deeplink.js`（那里可逐条测试，覆盖 14 类畸形输入）。
 * 这一段只管「送去哪」。
 * ------------------------------------------------------------------------------------------- */

/** 深链被拒时的日志出口。日志里的原文截断到 200 字符，避免畸形输入把终端刷满。 */
function deepLinkLog(message, detail) {
  console.warn(`[shell] ${message}，忽略：`, String(detail ?? '').slice(0, 200));
}

/**
 * 打开一个深链目标。
 *
 * 三种时序都要有去处，不能把 id 丢了：
 *   · 有窗口 → 直接在那个窗口里加载；
 *   · 一个窗口都没有但服务已就绪 → 开一个新窗口直接落在那个目标上；
 *   · 服务还没起来（冷启动） → 先记进 `pendingLink`，由 `boot()` 建首个窗口时消费。
 *
 * `device` 与 `job` 只是去的地方不同，时序处理一模一样 —— 所以共用这一份。
 */
function openLink(link) {
  if (!link || !link.id) return false;
  const view = link.kind === 'device' ? 'suite' : 'fleet';
  const param = link.kind === 'device' ? 'device' : 'job';
  const url = viewUrl(view, link.id, param);

  const win = focusedWindow();
  if (win) {
    win.loadURL(url);
    showWindow(win);
    console.log(`[shell] 深链跳转：/${view}?${param}=${link.id}`);
    return true;
  }
  if (canCreateWindow()) {
    showWindow(createWindow({ view, [param]: link.id }));
    console.log(`[shell] 深链开窗：/${view}?${param}=${link.id}`);
    return true;
  }
  pendingLink = link;
  return false;
}

/** 注册 `fsa://`。开发态（`electron .`）必须把启动脚本一起登记，否则协议拉起的是裸 electron。 */
function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch (error) {
    // 注册失败只影响“从浏览器点链接”，不该拦住窗口本身。
    console.warn('[shell] 注册 fsa:// 失败（不影响正常启动）：', error instanceof Error ? error.message : error);
  }
}

/* ---------------------------------------------------------------------------------------------
 * 主题 / 密度
 * ------------------------------------------------------------------------------------------- */

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

/** 当前外观快照。菜单标签、窗口底色、发给页面的 IPC 都从这一个函数取，避免三处各算一遍。 */
function appearanceState() {
  return {
    source: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors,
    density,
  };
}

/**
 * 通知页面。preload 这次不改，所以没有订阅通道给页面用；
 * 既要让主题真的看得见，就只剩“主进程写一次 DOM 属性”这条路
 * （`web/index.html` 与 `layout.html` 本来就是读 `data-agent-theme` 的）。
 * 页面还没 body / 已经导航走时这里会 reject，属正常情况，吞掉即可。
 */
function syncPageAppearance(win, state) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const theme = state.dark ? 'dark' : 'light';
  const script = '(() => { const b = document.body; if (!b) return;'
    + ` b.setAttribute('data-agent-theme', '${theme}');`
    + ` b.setAttribute('data-density', '${state.density}'); })();`;
  win.webContents.executeJavaScript(script, true).catch(() => { /* 页面已跳走，不算故障 */ });
}

/** 把当前外观刷到所有窗口；系统主题变化、菜单切换、新窗口加载完都调它。 */
function applyAppearance() {
  const state = appearanceState();
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    win.setBackgroundColor(windowBackground());
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('shell:theme', state);
      syncPageAppearance(win, state);
    }
  }
  if (tray) tray.setToolTip(trayTooltip());
  return state;
}

/** 循环切主题。重建菜单是因为那一项的文字要跟着变，否则用户不知道现在在哪一档。 */
function cycleTheme() {
  const index = THEMES.indexOf(nativeTheme.themeSource);
  nativeTheme.themeSource = THEMES[(index + 1) % THEMES.length];
  applyAppearance();
  Menu.setApplicationMenu(buildMenu());
  console.log(`[shell] 主题：${nativeTheme.themeSource}（深色=${nativeTheme.shouldUseDarkColors}）`);
}

function cycleDensity() {
  density = DENSITIES[(DENSITIES.indexOf(density) + 1) % DENSITIES.length];
  applyAppearance();
  Menu.setApplicationMenu(buildMenu());
  console.log(`[shell] 密度：${density}`);
}

/* ---------------------------------------------------------------------------------------------
 * 托盘
 * ------------------------------------------------------------------------------------------- */

function trayTooltip() {
  const state = appearanceState();
  return `野外台站智能体 · ${baseUrl || '未连接'}\n主题 ${THEME_LABELS[state.source] || state.source} · 密度 ${DENSITY_LABELS[state.density] || state.density}`;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { showOrCreateWindow(); } },
    { label: '隐藏窗口', click: () => { hideAllWindows(); } },
    { type: 'separator' },
    ...VIEW_IDS.map((id) => ({
      label: `打开${VIEW_LABELS[id]}`,
      click: () => {
        const win = focusedWindow();
        if (win) {
          showWindow(win);
          navigateToWindow(win, id);
        } else if (canCreateWindow()) {
          showWindow(createWindow({ view: id }));
        }
      },
    })),
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 托盘里的“退出”是唯一能真正结束进程的入口（关窗只会隐藏），
        // 所以必须先立标记，否则 window-all-closed 会把它又藏回托盘。
        beginQuit();
        app.quit();
      },
    },
  ]);
}

/**
 * 建托盘。`--screenshot` 与 `--no-tray` 时跳过：
 * 截图冒烟测试要能在拍完之后自己退出，托盘会把 window-all-closed 的退出挡掉，
 * 那种场景下托盘只会让 CI 挂住。
 */
function createTray() {
  if (!args.tray || args.screenshot) {
    console.log('[shell] 未创建托盘（--no-tray 或 --screenshot）');
    return null;
  }
  if (tray) return tray;

  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  // 空图会让托盘在 Windows 上完全看不见；宁可留个日志，也不要“好像没启动”。
  if (icon.isEmpty()) console.warn('[shell] 托盘图标解码为空，托盘可能不显示');
  try {
    tray = new Tray(icon);
  } catch (error) {
    console.error('[shell] 创建托盘失败（不影响窗口）：', error);
    tray = null;
    return null;
  }
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(buildTrayMenu());
  // 单击 = 把窗口叫回来。隐藏之后用户最容易做的动作就是点图标。
  tray.on('click', () => { showOrCreateWindow(); });
  tray.on('double-click', () => { showOrCreateWindow(); });
  // 图标是内嵌的，出问题时最容易怀疑它；把尺寸打出来，省得猜。
  const size = icon.getSize();
  console.log(`[shell] 托盘已创建（图标 ${size.width}×${size.height}）`);
  return tray;
}

/* ---------------------------------------------------------------------------------------------
 * 菜单（应用 / 视角 / 外观 / 开发者 / 帮助）
 * ------------------------------------------------------------------------------------------- */

function buildMenu() {
  const viewItems = VIEW_IDS.map((id) => ({
    label: VIEW_LABELS[id],
    type: 'normal',
    click: () => navigate(id),
  }));

  return Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '关于野外台站智能体', role: 'about' },
        { type: 'separator' },
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          click: () => { if (canCreateWindow()) createWindow(); },
        },
        {
          label: '在新窗口打开当前视角',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            const win = focusedWindow();
            if (canCreateWindow()) createWindow({ view: viewOfWindow(win) });
          },
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '视角',
      submenu: viewItems,
    },
    {
      label: '外观',
      submenu: [
        {
          // 单项循环而不是三个 radio：菜单每次切换都要重建，
          // radio 的勾选状态在重建后容易和 nativeTheme 的真实值对不上。
          label: `主题：${THEME_LABELS[nativeTheme.themeSource] || '跟随系统'}`,
          click: () => cycleTheme(),
        },
        {
          label: `密度：${DENSITY_LABELS[density] || density}`,
          click: () => cycleDensity(),
        },
        { type: 'separator' },
        {
          label: '隐藏到托盘',
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            if (!hideAllWindows()) console.log('[shell] 没有可隐藏的窗口');
          },
        },
      ],
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
 * 退出
 * ------------------------------------------------------------------------------------------- */

/**
 * 立“真的要退出”的标记。Electron 没有 `isQuitting` 这个属性，自己挂一个：
 * 托盘菜单、崩溃提示、before-quit 三处都要看同一个标记，
 * 各写一份布尔量迟早会有一天不一致，然后表现为“点了退出又弹回托盘”。
 */
function beginQuit() {
  quitting = true;
  app.isQuitting = true;
}

/* ---------------------------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------------------------- */

async function boot() {
  if (!args) return;

  registerProtocol();
  // 系统主题变化（跟随系统时）要实时反映到窗口底色和页面属性上。
  nativeTheme.themeSource = args.theme;
  nativeTheme.on('updated', () => { applyAppearance(); });

  Menu.setApplicationMenu(buildMenu());

  ipcMain.handle('shell:info', () => ({
    baseUrl,
    port: args.port,
    view: args.view,
    attach: args.attach,
    views: VIEW_IDS,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    // 壳-2：Python 服务的状态。附加上去的字段，老页面读不到也不受影响。
    python: { state: pythonState, url: pythonUrl, error: pythonError, port: args.pythonPort },
    // 壳-1：解压目标。页面若将来要显示「payload 目录」，不必自己拼 app.getPath。
    payloadDir: payloadDir(),
    // 壳-1：解压进度。窗口建好时可能已经解压完了，所以这里是**快照**而不是订阅；
    // 要画进度条得在解压期间就有窗口，见 docs/operations/shell.md §5。
    payloadProgress,
    // 附加字段：preload 现在读不到，但页面将来加订阅时不必再改主进程的契约。
    appearance: appearanceState(),
    windows: windows.size,
  }));
  ipcMain.handle('shell:navigate', (event, view) => {
    // 用发送者的窗口，不用“主窗口”：多开之后切视角必须切用户正在点的那个。
    const win = BrowserWindow.fromWebContents(event.sender) || focusedWindow();
    return navigateToWindow(win, String(view));
  });

  try {
    /*
     * 顺序是有意的：
     *   ① payload 解压（壳-1）—— 它是「这台机器上有没有一套可用的文件树」的前提，
     *      Python 解释器也可能就在里面（`payload/runtime/python/python.exe`）；
     *   ② 两个服务并行拉起 —— Node 出界面、Python 出 Agent 后端，谁先起来都行；
     *      只用 await Node 的就绪来定「能不能开窗口」，Python 的失败不挡窗口。
     */
    await preparePayload();

    if (!args.attach) startServer();
    const pythonPromise = startPython();
    const attempts = await waitForHealth();
    console.log(`[shell] ${baseUrl} 就绪（探测 ${attempts} 次）`);
    serverReady = true;
    // 冷启动时 argv 里的深链在这里消费：首屏直接就是那个目标（编队的 job / 套件的设备）。
    if (pendingLink) {
      const view = pendingLink.kind === 'device' ? 'suite' : 'fleet';
      createWindow({ view, [pendingLink.kind === 'device' ? 'device' : 'job']: pendingLink.id });
      pendingLink = null;
    } else {
      createWindow({ view: args.view });
    }
    createTray();
    // 窗口先开、再等 Python：它能跑几十秒（首次 import 一整棵运行时栈），
    // 让用户在窗口里等着，而不是盯着一个没有响应的事件循环。
    await pythonPromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[shell] 启动失败：', message);
    stopPython();
    stopServer();
    dialog.showErrorBox('启动失败', message);
    app.exit(1);
  }
}

/* 单实例：第二个进程只负责把已有窗口叫到前面，并处理它带来的深链。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 冷启动的深链可能已经到了（从浏览器点链接直接拉起本程序）。
  pendingLink = linkFromArgv(process.argv.slice(1), deepLinkLog);

  app.on('second-instance', (_event, argv) => {
    const link = linkFromArgv(argv, deepLinkLog);
    // 带深链时先走它：有窗口就在那个窗口里跳，没窗口（且服务已就绪）就直接开一个
    // 落在目标上的窗口 —— 先 showOrCreateWindow() 再跳会白白加载两次页面。
    if (link && openLink(link)) return;
    showOrCreateWindow();
  });

  watchChildProcesses();

  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });

  app.on('activate', () => {
    // macOS: 点 Dock 图标时窗口全关了就再开一个（服务还在）。
    if (BrowserWindow.getAllWindows().length === 0 && canCreateWindow()) createWindow();
  });

  app.on('window-all-closed', () => {
    /*
     * 有托盘就不退出，只把状态留在这里等着被叫回来：
     * 服务是全局的，用户关窗往往只是想收起来，重新拉起一次要再等 40 秒就绪探测。
     * 真正的退出走托盘菜单 / Ctrl+Q，两条路都会先 `beginQuit()`。
     */
    if (tray && !app.isQuitting) {
      console.log('[shell] 窗口已全部关闭，留在托盘');
      return;
    }
    stopPython();
    stopServer();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    beginQuit();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    // 先 Python 后 Node：Python 是 Node 的下游（Node 桥将来按需调它），
    // 反过来关会让 Node 在关的过程中还往一个已经死掉的端口发请求。
    stopPython();
    stopServer();
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      beginQuit();
      stopPython();
      stopServer();
      app.quit();
    });
  }
}
