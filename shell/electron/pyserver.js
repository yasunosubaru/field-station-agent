'use strict';
/**
 * 拉起 Python 服务 —— 壳的第二件事。
 *
 * 图上原文：「只负责 payload 解压、拉起 Python 服务」。壳-1 管前半句，这个文件管后半句。
 *
 * ## 拉起哪个服务
 *
 * `src/fieldstation/runtimes/server.py`（运行时网关：`/v1/runtimes` 状态 + `/v1/chat` SSE）。
 * 仓库里还有 `tools/agent_server.py`，但它由 Node 桥**懒启动**（首次访问 `/api/agent/*`），
 * 不是外壳的职责；外壳拉了它就会变成两个进程抢同一件事。所以这里只拉
 * `python -m fieldstation.runtimes.server`，`PYTHONPATH=<repo>/src`。
 *
 * 计划书 §壳-2 步骤 2 里写的也是这一条。
 *
 * ## 就绪协议：照 Python 侧已有的约定
 *
 * `runtimes/server.py` 第 115 行已经在 stdout 打：
 *
 *     RUNTIME_GATEWAY_READY http://127.0.0.1:8788
 *
 * 外壳照这个前缀读，**不改 Python 侧**。同时兼容项目里另外两种既有写法
 * （`READY <port>` 见 docs/product/architecture.md，`AGENT_READY <port>` 见 agent_server.py），
 * 因为它们已经是这个仓库的约定，多认两个前缀不会增加歧义。
 *
 * 一个必须注意的坑：那一行是在 `ThreadingHTTPServer` 绑定**之前**打的
 * （`print` 在前、`serve()` 在后）。端口被占时进程会先打出 READY 再崩
 * —— 实测 `PermissionError: [WinError 10013]`。所以读到就绪行之后**还要探一次
 * `/health`**，两边都过才算起来了。只信那一行会拿着一个没在监听的地址去开窗口。
 *
 * ## 端口
 *
 * `--port 8788` 是 `server.py` 自己的默认值。不用 `--port 0`：那需要从 stdout 读系统
 * 分配的端口，而上面那个「print 在 bind 之前」的顺序会让 0 变得不可用（打出来的 0 不是
 * 真端口）。所以用固定端口 + 冲突时 +1 重试（最多 5 个）。
 *
 * ## 退出
 *
 * Windows 上 `taskkill /pid <pid> /T /F`，与 `main.js` 结束 Node 服务完全同一做法：
 * 只 kill 父进程会留下 Python 的子进程，而它们会占着端口。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/* ---------------------------------------------------------------------------------------------
 * 开关语义（纯函数）
 * ------------------------------------------------------------------------------------------- */

/**
 * 三个开关决定「拉 / 只连 / 完全不碰」。
 *
 * `--attach` 是**外壳级**开关：图上原文「只负责 payload 解压、拉起 Python 服务」，
 * 而 `--attach` 的语义是「服务已经跑着，我只连不拉」。这个语义不能只对 Node 服务成立、
 * 对 Python 服务失效 —— 那样用户带 `--attach` 启动时会意外多拉起一个 Python 进程，
 * 正是他想避免的事。所以 `--attach` **隐含** Python 只连不拉。
 *
 * `--attach-python` 保留，用于「Node 我自己拉、Python 你只连」这种分开调试的场合。
 * `--no-python` 优先级最高：它说的是「这台机器上完全不碰 Python」。
 *
 * @returns {{mode: 'skip'|'attach'|'launch', reason: string}}
 */
function resolvePythonMode({ python = true, attach = false, attachPython = false } = {}) {
  if (!python) return { mode: 'skip', reason: '--no-python' };
  if (attachPython) return { mode: 'attach', reason: '--attach-python' };
  if (attach) return { mode: 'attach', reason: '--attach' };
  return { mode: 'launch', reason: 'default' };
}

/** 认的就绪前缀，按「先长后短」排：`AGENT_READY` 不能被 `READY` 前缀误吃。 */
const READY_PREFIXES = ['RUNTIME_GATEWAY_READY', 'AGENT_READY', 'READY', 'DEV_CHAT_READY'];

/** `server.py --port` 的默认值。 */
const DEFAULT_PORT = 8788;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MODULE = 'fieldstation.runtimes.server';
/** 端口冲突时往后试几个。5 个够：这个服务不是给人挑端口的。 */
const PORT_ATTEMPTS = 5;
const READY_TIMEOUT_MS = 30_000;
const PROBE_INTERVAL_MS = 300;
const PROBE_TIMEOUT_MS = 1500;
/**
 * 读到就绪行、`/health` 也通了之后，还要再等这么久确认**自己那个进程没死**。
 *
 * 为什么必须等：`server.py` 是先 `print(RUNTIME_GATEWAY_READY …)` 再 bind。
 * 端口被占时它会打一行 READY 然后崩，而 `/health` 会打到**占着那个端口的别人**，
 * 于是外壳以为起来了，接着去 taskkill 一个已经死掉的 pid，端口上留着一个不是自己拉的服务。
 * 2026-11-09 在本机实测踩到过。250 毫秒足够 bind 失败的那条路自己退出。
 */
const READY_SETTLE_MS = 250;

/* ---------------------------------------------------------------------------------------------
 * 就绪行解析（纯函数）
 * ------------------------------------------------------------------------------------------- */

/**
 * 解析一行 stdout。不是就绪行就返回 null（普通日志行必须被忽略）。
 *
 * 接受的写法：
 *   `RUNTIME_GATEWAY_READY http://127.0.0.1:8788`   ← server.py 现有的
 *   `READY 7803` / `AGENT_READY 8811`                ← 项目里另外两种（只有端口）
 *
 * @param {string} line
 * @returns {{prefix: string, host: string, port: number, url: string} | null}
 */
function parseReadyLine(line) {
  if (typeof line !== 'string') return null;
  const text = line.trim();
  if (!text) return null;
  // 主进程给子进程的日志加了 `[server] ` 前缀；那类转发出去的副本不能当就绪证据，
  // 但万一有人拿带前缀的字符串来调，这里直接不认，避免「日志里出现过 READY」就启动。
  if (text.startsWith('[')) return null;

  const prefix = READY_PREFIXES.find(
    (candidate) => text.startsWith(`${candidate} `) || text === candidate,
  );
  if (!prefix) return null;
  const rest = text.slice(prefix.length).trim();
  if (!rest) return null;

  // 形式一：带 URL。
  if (/^https?:\/\//i.test(rest)) {
    let parsed;
    try {
      parsed = new URL(rest.split(/\s+/)[0]);
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== 'http:') return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host = parsed.hostname || DEFAULT_HOST;
    return { prefix, host, port, url: `http://${host}:${port}` };
  }

  // 形式二：只有端口（`READY 7803`）。
  const token = rest.split(/\s+/)[0];
  if (!/^\d{1,5}$/.test(token)) return null;
  const port = Number(token);
  if (port < 1 || port > 65535) return null;
  return { prefix, host: DEFAULT_HOST, port, url: `http://${DEFAULT_HOST}:${port}` };
}

/* ---------------------------------------------------------------------------------------------
 * 参数 / 环境（纯函数）
 * ------------------------------------------------------------------------------------------- */

function buildPythonArgs({ port, module = DEFAULT_MODULE, host = DEFAULT_HOST } = {}) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Python 服务端口必须是 1..65535 的整数（收到 ${port}）`);
  }
  return ['-m', module, '--host', host, '--port', String(value)];
}

/**
 * 子进程环境。
 *
 * `PYTHONPATH` 指到 `<repo>/src`（`fieldstation` 包的那一层），并**保留**调用方原有的值：
 * 直接覆盖会把别人设好的路径丢掉，表现为「单独跑没问题、从壳里跑就 ImportError」。
 *
 * `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`：Windows 上 Python 默认按 GBK 写 stdout，
 * 就绪行里若有中文（或路径），主进程按 utf8 解码就会成乱码。统一 UTF-8 是这里唯一稳的解法。
 */
function buildPythonEnv({ baseEnv = process.env, pythonPath = [] } = {}) {
  const env = { ...baseEnv };
  const parts = [...pythonPath.filter(Boolean)];
  if (baseEnv && baseEnv.PYTHONPATH) parts.push(baseEnv.PYTHONPATH);
  env.PYTHONPATH = parts.join(path.delimiter);
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

function buildSpawnSpec({ python, port, host = DEFAULT_HOST, module = DEFAULT_MODULE,
  repoRoot, baseEnv = process.env, pythonPath } = {}) {
  if (!python) throw new Error('buildSpawnSpec 需要 python 解释器路径');
  if (!repoRoot) throw new Error('buildSpawnSpec 需要 repoRoot');
  const env = buildPythonEnv({
    baseEnv,
    pythonPath: pythonPath || [path.join(repoRoot, 'src')],
  });
  return {
    command: python,
    args: buildPythonArgs({ port, module, host }),
    cwd: repoRoot,
    env,
    options: {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // posix 上让子进程自成一个进程组，kill 时才能整组带走（见 killTreeCommand）。
      detached: process.platform !== 'win32',
    },
  };
}

/* ---------------------------------------------------------------------------------------------
 * 解释器
 * ------------------------------------------------------------------------------------------- */

/**
 * 按优先级找解释器：payload 里带的 > 仓库 `.deps/venv` > `.venv` > `venv`。
 *
 * payload 优先是因为打包之后机器上未必有 venv，而 payload 里那份是自己带过去的
 * （`build_payload.py --python-dir` 会把它放进 `runtime/python`）。
 *
 * `exists` 可注入，测试不需要真造这些目录。
 */
function resolvePython({ repoRoot, payloadDir = null, platform = process.platform,
  exists = (file) => { try { return fs.statSync(file).isFile(); } catch (e) { return false; } } } = {}) {
  if (!repoRoot) return null;
  const win = platform === 'win32';
  const exe = win ? 'python.exe' : 'python3';
  const candidates = [];
  if (payloadDir) {
    candidates.push({ path: path.join(payloadDir, 'runtime', 'python', exe), source: 'payload' });
  }
  /*
   * Packaged layout: the build script stages the bundled runtime at
   *   <resources>/app/payload/runtime/python/Scripts/python.exe  (venv layout)
   * while `payloadDir()` points at `<userData>/payload` (the extraction target).
   * Without this candidate the packaged app reports "no Python" even though the
   * interpreter is right there — measured on the first real run of the build.
   * Note the `Scripts/` level: the bundled thing is a **venv**, not a bare
   * python.exe, so it sits under Scripts/ just like .deps/venv does.
   */
  const bundledRoot = path.join(repoRoot, 'payload', 'runtime', 'python');
  candidates.push(win
    ? { path: path.join(bundledRoot, 'Scripts', 'python.exe'), source: 'bundled-venv' }
    : { path: path.join(bundledRoot, 'bin', 'python3'), source: 'bundled-venv' });
  // scheme A (official embeddable, not a venv): python.exe sits at the root,
  // no Scripts/ level. build_payload.py ships this layout; measured on the
  // single-file build where only this path existed and the app said "no Python".
  candidates.push(win
    ? { path: path.join(bundledRoot, 'python.exe'), source: 'bundled-embed' }
    : { path: path.join(bundledRoot, 'python3'), source: 'bundled-embed' });
  for (const name of ['.deps/venv', '.venv', 'venv']) {
    const dir = path.join(repoRoot, ...name.split('/'));
    candidates.push({
      path: win ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python3'),
      source: 'venv',
    });
  }
  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate;
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------
 * 端口 / 健康
 * ------------------------------------------------------------------------------------------- */

function choosePortCandidates(start, count = PORT_ATTEMPTS) {
  const first = Number(start);
  const out = [];
  for (let port = first; port <= 65535 && out.length < count; port++) out.push(port);
  return out;
}

function pythonHealthUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/health`;
}

/** 探 `/health`。返回 true 才算真在监听（`server.py` 的 `/health` 回 `{ok:true}`）。 */
async function probeHealth(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return Boolean(body && body.ok === true);
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 这个端口现在能不能 bind。
 *
 * `server.py` 是在 bind 之前打就绪行的，所以「先问一句有没有人占着」比「起来再看」
 * 便宜得多：被占就直接换下一个端口，不必先拉一个注定要崩的进程。
 * 这里与真正 bind 之间仍有竞态 —— 所以 `waitForReady()` 的 settle 检查不能省。
 */
function isPortFree({ port, host = DEFAULT_HOST } = {}) {
  return new Promise((resolve) => {
    const server = require('node:net').createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------------------------------------
 * 就绪等待（状态机，可注入 probe）
 * ------------------------------------------------------------------------------------------- */

/**
 * 等子进程吐出就绪行，然后再确认两件事：`/health` 通，且**自己那个进程还活着**。
 *
 * 失败有四种，都要带足信息（不然用户只看到「Python 起不来」）：
 *   · 子进程提前退出 → 带退出码与最后一段 stderr；
 *   · 超时 → 带已经收集到的 stderr；
 *   · 有就绪行但 `/health` 不通 → 说明它打了一行却没绑上端口；
 *   · `/health` 通、但等到 `settleMs` 时自己已经退出 → 通的那个是别人的服务。
 */
function waitForReady({ child, probe = probeHealth, timeoutMs = READY_TIMEOUT_MS,
  intervalMs = PROBE_INTERVAL_MS, settleMs = READY_SETTLE_MS, log = () => {} } = {}) {
  if (!child) return Promise.reject(new Error('waitForReady 需要 child'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    let ready = null;
    let healthTried = false;
    let settleTimer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      clearInterval(poller);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('exit', onExit);
      fn(value);
    };

    const checkHealth = async () => {
      if (settled || !ready || healthTried) return;
      healthTried = true;
      const ok = await probe(pythonHealthUrl(ready.url));
      if (settled) return;
      if (!ok) {
        // 没通就下一轮再试：刚 bind 完到能响应之间有几十毫秒。ready 保留着，
        // 超时那条路的报错会带上「读到了就绪行但 /health 不通」。
        healthTried = false;
        return;
      }
      if (settleTimer) return;
      // `/health` 通了还要确认这是**我们起的**那个进程：再等一会儿看它有没有退出。
      settleTimer = setTimeout(() => {
        if (settled) return;
        if (child.exitCode !== null || child.killed) {
          finish(reject, new Error(
            `Python 服务 ${ready.url} 上有 HTTP 响应，但我们起的进程已经退出（code ${child.exitCode}）`
            + '—— 那个端口上跑的是别的服务。\n'
            + `${stderr.trim() || '（没有 stderr 输出）'}`,
          ));
          return;
        }
        log(`[python] 就绪：${ready.url}`);
        finish(resolve, ready);
      }, settleMs);
    };

    const poller = setInterval(() => { void checkHealth(); }, intervalMs);

    const onStdout = (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === '\r' ? 2 : 1));
        if (!line.trim()) continue;
        log(`[python] ${line}`);
        const parsed = parseReadyLine(line);
        if (parsed && !ready) {
          ready = parsed;
          void checkHealth();
        }
      }
    };
    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      log(`[python] ${String(chunk).trimEnd()}`);
    };
    const onExit = (code, signal) => {
      finish(reject, new Error(
        `Python 服务启动即退出（code ${code ?? signal}）。\n${stderr.trim() || '（没有 stderr 输出）'}`,
      ));
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);

    const timer = setTimeout(() => {
      const extra = ready
        ? `\n读到就绪行 ${ready.url}，但 /health 一直不通 —— 端口可能被占（server.py 是在 bind 之前打那一行的）。`
        : '';
      const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
      finish(reject, new Error(
        `超时：等了 ${waited}没等到 Python 服务就绪。${extra}`
        + `\n${stderr.trim() || '（没有 stderr 输出）'}`,
      ));
    }, timeoutMs);
  });
}

/* ---------------------------------------------------------------------------------------------
 * kill 树
 * ------------------------------------------------------------------------------------------- */

/**
 * 结束整棵进程树的命令。**纯函数**，返回 `{command, args}`，调用方去 spawn。
 *
 * 与 `main.js` 的 `stopServer()` 同一个做法（Windows `taskkill /T /F`）：
 * 只 kill 父进程会留下 Python 的子进程，而它们还占着端口。
 * posix 上杀进程组（负 pid），前提是 spawn 时 `detached: true`。
 */
function killTreeCommand({ pid, platform = process.platform } = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (platform === 'win32') {
    return { command: 'taskkill', args: ['/pid', String(value), '/T', '/F'] };
  }
  return { command: 'kill', args: ['-TERM', `-${value}`] };
}

/* ---------------------------------------------------------------------------------------------
 * 编排
 * ------------------------------------------------------------------------------------------- */

/**
 * 起服务。返回 `{ child, ready }`：`ready` 是 Promise，等它就绪或失败。
 *
 * `spawnImpl` / `probe` 可注入 —— 单元测试不真开进程、不真连网。
 */
function startPythonService({ python, repoRoot, port = DEFAULT_PORT, host = DEFAULT_HOST,
  module = DEFAULT_MODULE, spawnImpl = spawn, probe = probeHealth,
  timeoutMs = READY_TIMEOUT_MS, intervalMs = PROBE_INTERVAL_MS, settleMs = READY_SETTLE_MS,
  baseEnv = process.env, log = () => {}, onSpawn = null } = {}) {
  const spec = buildSpawnSpec({ python, port, host, module, repoRoot, baseEnv });
  log(`[python] 启动：${spec.command} ${spec.args.join(' ')}（cwd ${spec.cwd}）`);
  const child = spawnImpl(spec.command, spec.args, spec.options);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.on('error', (error) => { log(`[python] 启动失败：${error.message}`); });
  // 进程一 spawn 出来就交出去，不等就绪。
  //
  // 为什么必须这么早：`main.js` 的 `boot()` 在 `await pythonPromise` 之前就可能失败
  // （Node 服务没起、payload 坏了），那时 `launchPythonService` 还没返回、
  // `pythonChild` 仍是 null，`stopPython()` 什么都杀不到 —— 已经拉起来的 Python
  // 就会一直活到用户自己发现。启动路径上的失败比正常退出更常见，
  // 清理不能只在「成功拿到 child」之后才成立。
  if (typeof onSpawn === 'function') onSpawn(child);
  const ready = waitForReady({ child, probe, timeoutMs, intervalMs, settleMs, log });
  return { child, ready, spec };
}

/**
 * `--attach python` 语义：已经跑着就只连不拉。
 *
 * 返回 `{attached:true, url, port}` 或 `{attached:false}`。
 * 不在此处抛错：没连上不等于出错，调用方多半要转去「那我自己拉一个」。
 */
async function attachOnly({ port = DEFAULT_PORT, host = DEFAULT_HOST, probe = probeHealth } = {}) {
  const url = `http://${host}:${port}`;
  const ok = await probe(pythonHealthUrl(url));
  return ok ? { attached: true, url, port } : { attached: false, port };
}

/**
 * 结束服务。幂等：第二次调用什么都不做（`main.js` 里 `window-all-closed`、
 * `before-quit`、信号三条路都会调它，重复调是常态）。
 */
function stopPythonService({ child, platform = process.platform, spawnImpl = spawn,
  log = () => {} } = {}) {
  if (!child || child.killed || child.exitCode !== null) return false;
  const command = killTreeCommand({ pid: child.pid, platform });
  if (!command) return false;
  child.killed = true;
  try {
    spawnImpl(command.command, command.args, { windowsHide: true, stdio: 'ignore' });
    log(`[python] 已结束进程树：${command.command} ${command.args.join(' ')}`);
  } catch (error) {
    log(`[python] 结束进程树失败：${error.message}`);
  }
  return true;
}

/**
 * 一个入口把「找解释器 → 选端口 → 起 → 等就绪」串起来，`main.js` 只调它。
 *
 * 端口冲突分两步挡：
 *   ① 起之前 `isPortFree()` 问一句 —— 被占就直接换下一个，不拉一个注定要崩的进程；
 *   ② 起来之后 `waitForReady()` 还要确认 `/health` 通**且自己那个进程没死** ——
 *      因为 ① 与真正 bind 之间有竞态，而 `server.py` 会在 bind 之前先打就绪行。
 *
 * ②失败且错误信息像端口占用时，也换下一个端口重试。
 */
async function launchPythonService({ repoRoot, payloadDir = null, python = null,
  startPort = DEFAULT_PORT, platform = process.platform, spawnImpl = spawn,
  probe = probeHealth, isPortFreeImpl = isPortFree, timeoutMs = READY_TIMEOUT_MS,
  intervalMs = PROBE_INTERVAL_MS, settleMs = READY_SETTLE_MS,
  baseEnv = process.env, log = () => {}, onSpawn = null } = {}) {
  const resolved = python
    ? { path: python, source: 'explicit' }
    : resolvePython({ repoRoot, payloadDir, platform });
  if (!resolved) {
    throw new Error(
      `找不到 Python 解释器：${path.join(repoRoot, '.deps', 'venv', 'Scripts', 'python.exe')} 不存在，`
      + 'payload 里也没有 runtime/python/python.exe。用 --no-python 跳过，或先建好 .deps/venv。',
    );
  }

  const ports = choosePortCandidates(startPort);
  let lastError = null;
  for (const port of ports) {
    if (!(await isPortFreeImpl({ port }))) {
      log(`[python] 端口 ${port} 已被占用，换下一个`);
      continue;
    }
    const attempt = startPythonService({
      python: resolved.path, repoRoot, port, spawnImpl, probe, timeoutMs, intervalMs,
      settleMs, baseEnv, log, onSpawn,
    });
    try {
      const ready = await attempt.ready;
      return { ...ready, child: attempt.child, python: resolved };
    } catch (error) {
      lastError = error;
      stopPythonService({ child: attempt.child, platform, spawnImpl, log });
      const portBusy = /10013|Only one usage|address already in use|EADDRINUSE/i.test(error.message);
      if (!portBusy) throw error;
      log(`[python] 端口 ${port} 不可用，换下一个（${error.message.split('\n')[0]}）`);
    }
  }
  throw lastError || new Error(`没有可用端口（试过 ${ports.join(', ')}）`);
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_MODULE,
  READY_PREFIXES,
  READY_SETTLE_MS,
  resolvePythonMode,
  parseReadyLine,
  buildPythonArgs,
  buildPythonEnv,
  buildSpawnSpec,
  resolvePython,
  choosePortCandidates,
  pythonHealthUrl,
  probeHealth,
  isPortFree,
  waitForReady,
  killTreeCommand,
  startPythonService,
  attachOnly,
  stopPythonService,
  launchPythonService,
};
