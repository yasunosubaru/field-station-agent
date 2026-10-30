/**
 * Field Station launcher core.
 *
 * The double-clickable `Start-FieldStation.cmd` has to stay ASCII-only and dependency-free, so
 * every decision lives here: the `.cmd` locates `node`, forwards argv, and nothing else. Node
 * >= 22.6 runs this file directly (type stripping), so the launcher needs no build step and no
 * `node_modules` — which is the whole point, because the machine this ships to has no registry.
 *
 * What it owns:
 *   1. single instance — scan the candidate ports, adopt a live `nas-reimpl-app`, open the browser;
 *   2. port choice — 7788, 7789, … (5 candidates), the next one only after the previous refused;
 *   3. one child process — `packages/app/src/server.ts`, piped into the launcher log;
 *   4. shutdown — SIGINT / SIGTERM / SIGHUP (console close) kills the child and frees the port.
 *
 * It never imports and never writes `packages/app/**`; the server tree is spawned, not modified.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `<repo>/逆向/04_重实现/packages/desktop` */
export const DESKTOP_DIR = resolve(here, '..');
/** `<repo>/逆向/04_重实现` */
export const IMPL_DIR = resolve(DESKTOP_DIR, '..', '..');
/** `<repo>` */
export const REPO_DIR = resolve(IMPL_DIR, '..', '..');
/** The HTTP shell this launcher owns. Spawned, never imported, never written. */
export const SERVER_PATH = join(IMPL_DIR, 'packages', 'app', 'src', 'server.ts');

/** The `service` field `/api/health` answers with; how a live instance is recognised. */
export const SERVICE_ID = 'nas-reimpl-app';
export const DEFAULT_PORT = 7788;
export const PORT_ATTEMPTS = 5;
export const LOG_LIMIT_BYTES = 200 * 1024;
export const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 600;
const STOP_TIMEOUT_MS = 3_000;

export type BrowserOpener = (url: string) => void;

export interface LauncherArgs {
  /** `undefined` → `FIELD_STATION_PORT`, else 7788. */
  port: number | undefined;
  openBrowser: boolean;
  minimize: boolean;
  help: boolean;
}

export interface LaunchOptions {
  preferredPort?: number;
  attempts?: number;
  /** `false` suppresses the browser entirely; a test injects `browserOpener` instead. */
  openBrowser?: boolean;
  browserOpener?: BrowserOpener;
  logFile?: string;
  logLimitBytes?: number;
  probeTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Minimise the console window the launcher runs in (what a double-click gets). */
  minimizeConsole?: boolean;
  /** Defaults to `process.execPath`; `FIELD_STATION_NODE` overrides. */
  nodePath?: string;
  cwd?: string;
  /** Keeps the launcher from echoing to stdout (the log still gets everything). */
  quiet?: boolean;
}

export interface LaunchResult {
  /** True when an already-running instance was adopted instead of spawning a child. */
  reused: boolean;
  port: number;
  url: string;
  /** `null` exactly when `reused`; otherwise the server child this launcher must stop. */
  child: ChildProcess | null;
  logFile: string;
  openedBrowser: boolean;
  /** Kills the child (if any) and waits for the port to stop answering. Idempotent. */
  stop: () => Promise<void>;
}

export function urlFor(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function candidatePorts(preferred: number, attempts = PORT_ATTEMPTS): number[] {
  const ports: number[] = [];
  for (let i = 0; i < Math.max(1, attempts); i++) {
    const port = preferred + i;
    if (port > 65_535) break;
    ports.push(port);
  }
  return ports;
}

function parsePortValue(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  const port = Number(text);
  if (!text || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`端口不合法：${raw ?? '(缺少)'}`);
  }
  return port;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return !/^(0|false|no|off|)$/i.test(value.trim());
}

/**
 * The `.cmd` forwards argv verbatim; `-NoBrowser` / `-Port 7790` are accepted in PowerShell
 * spelling as well as the GNU `--no-browser` / `--port 7790` one, because the documented usage in
 * the README is the PowerShell-ish form. Unknown flags are an error rather than silently ignored:
 * a launcher that ignores `-NoBrowser` opens a browser the operator asked it not to.
 */
export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): LauncherArgs {
  const args: LauncherArgs = {
    port: env.FIELD_STATION_PORT ? parsePortValue(env.FIELD_STATION_PORT) : undefined,
    openBrowser: !truthy(env.FIELD_STATION_NO_BROWSER),
    minimize: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const flag = raw.trim().toLowerCase();
    if (flag === '-nobrowser' || flag === '--no-browser' || flag === '/nobrowser') args.openBrowser = false;
    else if (flag === '-browser' || flag === '--browser') args.openBrowser = true;
    else if (flag === '-minimize' || flag === '--minimize') args.minimize = true;
    else if (flag === '-nominimize' || flag === '--no-minimize' || flag === '-keepwindow') args.minimize = false;
    else if (flag === '-h' || flag === '--help' || flag === '/?') args.help = true;
    else if (flag === '-port' || flag === '--port' || flag === '-p') args.port = parsePortValue(argv[++i]);
    else if (flag.startsWith('--port=')) args.port = parsePortValue(raw.trim().slice('--port='.length));
    else throw new Error(`未知参数：${raw}（用 -h 看用法）`);
  }
  return args;
}

export function defaultLogFile(env: Record<string, string | undefined> = process.env): string {
  if (env.FIELD_STATION_LOG) return env.FIELD_STATION_LOG;
  const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'FieldStation', 'launcher.log');
}

/**
 * Append one timestamped line, trimming the file to its last `limit` bytes first. The trim cuts at
 * a newline found *in the raw bytes* so a multi-byte character is never split in half.
 */
export function appendLog(logFile: string, message: string, limit = LOG_LIMIT_BYTES): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  mkdirSync(dirname(logFile), { recursive: true });
  try {
    const { size } = statSync(logFile);
    const incoming = Buffer.byteLength(line);
    if (size + incoming > limit) {
      const kept = readFileSync(logFile);
      const from = Math.max(0, kept.byteLength - Math.max(limit - incoming, 1));
      const newline = kept.indexOf(0x0a, from);
      writeFileSync(logFile, kept.subarray(newline >= 0 ? newline + 1 : from));
    }
  } catch {
    /* first write of a fresh log directory */
  }
  appendFileSync(logFile, line);
}

export function readLogTail(logFile: string, bytes = 4_096): string {
  try {
    const kept = readFileSync(logFile);
    return kept.subarray(Math.max(0, kept.byteLength - bytes)).toString('utf8');
  } catch {
    return '';
  }
}

/** True when `port` answers `/api/health` as our own service. Never throws. */
export async function probeInstance(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'cache-control': 'no-store' },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown };
    return body.service === SERVICE_ID;
  } catch {
    return false;
  }
}

/** True when something accepts a TCP connection on `port`. Used to prove the port was freed. */
export function isPortListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      clearTimeout(timer);
      done(listening);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** `rundll32 url.dll,FileProtocolHandler` avoids `cmd /c start` quoting traps with titles. */
export function openDefaultBrowser(url: string): void {
  const options = { detached: true, stdio: 'ignore' as const, windowsHide: true };
  try {
    if (process.platform === 'win32') {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], options).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], options).unref();
    } else {
      spawn('xdg-open', [url], options).unref();
    }
  } catch {
    /* no default handler is not a launcher failure; the URL is printed and logged anyway */
  }
}

/**
 * Minimise the console window the launcher itself runs in. Best effort: a hidden PowerShell frees
 * its own invisible console, attaches to `pid`, and calls `ShowWindow(SW_MINIMIZE)`. Failure is
 * silent — the operator can always minimise by hand.
 */
export function minimizeConsole(pid = process.pid, logFile?: string): void {
  if (process.platform !== 'win32') return;
  const script = [
    '$src = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class FsConsoleWindow {',
    '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();',
    '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);',
    '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '}',
    '"@',
    'try {',
    '  Add-Type -TypeDefinition $src -ErrorAction Stop | Out-Null',
    '  [void][FsConsoleWindow]::FreeConsole()',
    `  if ([FsConsoleWindow]::AttachConsole(${Math.trunc(pid)})) {`,
    '    $handle = [FsConsoleWindow]::GetConsoleWindow()',
    '    if ($handle -ne [IntPtr]::Zero) {',
    '      $ok = [FsConsoleWindow]::ShowWindow($handle, 6)',
    '      Write-Output ("minimize handle=" + $handle + " show=" + $ok)',
    '    } else { Write-Output "minimize skipped: no console window" }',
    '    [void][FsConsoleWindow]::FreeConsole()',
    '  } else { Write-Output ("minimize skipped: attach failed(" + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ")") }',
    '} catch { Write-Output ("minimize failed: " + $_.Exception.Message) }',
  ].join('\n');
  try {
    // Not `detached` / `windowsHide`: CREATE_NO_WINDOW leaves the helper with a console of its
    // own, `AttachConsole` then fails and the window is never touched. Sharing the console is
    // what makes `GetConsoleWindow` return the window we want.
    const helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    helper.stdout?.setEncoding('utf8');
    let out = '';
    helper.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    helper.once('exit', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).join(' | ');
      if (line && logFile) appendLog(logFile, `[console] ${line}`);
    });
    helper.unref();
  } catch {
    /* minimise is cosmetic */
  }
}

function spawnServer(port: number, options: LaunchOptions): ChildProcess {
  const nodePath = options.nodePath ?? process.env.FIELD_STATION_NODE ?? process.execPath;
  return spawn(nodePath, [SERVER_PATH, '--port', String(port)], {
    cwd: options.cwd ?? IMPL_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Every line the server writes lands in the log, tagged and timestamped. */
function pipeToLog(child: ChildProcess, logFile: string, limit: number): void {
  const attach = (stream: NodeJS.ReadableStream | null, tag: string): void => {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) appendLog(logFile, `[${tag}] ${line}`, limit);
    });
  };
  attach(child.stdout, 'server');
  attach(child.stderr, 'server');
}

/**
 * Resolves as soon as the child is provably serving: either its `READY <port>` line or a passing
 * health probe. A child that exits first resolves `ok: false` with the tail of its stderr, which
 * is how a busy port ("端口 7788 已被占用") turns into "try the next candidate".
 */
function waitForReady(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  return new Promise((done) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;

    const finish = (ok: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      done({ ok, reason });
    };

    timer = setTimeout(() => finish(false, `not ready after ${timeoutMs} ms`), timeoutMs);
    timer.unref?.();

    poll = setInterval(() => {
      void probeInstance(port).then((alive) => {
        if (alive) finish(true, 'health probe');
      });
    }, 120);
    poll.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (/READY \d+/.test(stdout)) finish(true, 'READY line');
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => finish(false, `spawn failed: ${(error as Error).message}`));
    child.once('exit', (code, signal) => {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ');
      finish(false, `exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})${tail ? `: ${tail}` : ''}`);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      done(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    child.once('exit', onExit);
  });
}

async function terminate(child: ChildProcess, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child, timeoutMs);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  if (await exited) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* nothing left to try */
    }
  }
  await waitForExit(child, timeoutMs);
}

async function waitUntilPortClosed(port: number, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return true;
    await new Promise((done) => setTimeout(done, 60));
  }
  return !(await isPortListening(port));
}

/**
 * The one entry point. Returns handles rather than installing global signal handlers, so the CLI
 * can wire Ctrl+C and the tests can call `stop()` directly.
 */
export async function launch(options: LaunchOptions = {}): Promise<LaunchResult> {
  const preferred = options.preferredPort ?? DEFAULT_PORT;
  const attempts = options.attempts ?? PORT_ATTEMPTS;
  const logFile = options.logFile ?? defaultLogFile();
  const limit = options.logLimitBytes ?? LOG_LIMIT_BYTES;
  const probeTimeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const candidates = candidatePorts(preferred, attempts);

  const log = (message: string) => {
    appendLog(logFile, message, limit);
    if (!options.quiet) process.stdout.write(`[fieldstation] ${message}\n`);
  };

  const openBrowser = (url: string): boolean => {
    if (options.openBrowser === false) {
      log(`browser skipped for ${url} (--no-browser)`);
      return false;
    }
    try {
      (options.browserOpener ?? openDefaultBrowser)(url);
    } catch (error) {
      log(`browser open failed: ${(error as Error).message}`);
      return false;
    }
    log(`browser opened ${url}`);
    return true;
  };

  log(`launcher start pid=${process.pid} node=${process.version} candidates=${candidates.join(',')}`);

  // Single instance: adopt a live instance anywhere in the candidate range, not only on the
  // preferred port — an earlier launch may have drifted to 7789 because 7788 was taken.
  for (const port of candidates) {
    if (await probeInstance(port, probeTimeout)) {
      const url = urlFor(port);
      log(`reuse ${url} (${SERVICE_ID} already running, no new process)`);
      return {
        reused: true,
        port,
        url,
        child: null,
        logFile,
        openedBrowser: openBrowser(url),
        stop: async () => {},
      };
    }
  }
  log('no running instance found, starting server');

  const readyTimeout = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  for (const port of candidates) {
    const child = spawnServer(port, options);
    pipeToLog(child, logFile, limit);
    const ready = await waitForReady(child, port, readyTimeout);
    if (!ready.ok) {
      log(`port ${port} unusable: ${ready.reason}`);
      await terminate(child);
      continue;
    }

    const url = urlFor(port);
    log(`ready ${url} (${ready.reason}) pid=${child.pid ?? '?'}`);
    const openedBrowser = openBrowser(url);
    if (options.minimizeConsole) minimizeConsole(process.pid, logFile);

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      log('shutdown requested');
      await terminate(child);
      const closed = await waitUntilPortClosed(port);
      log(closed ? `stopped, port ${port} released` : `stopped, but port ${port} still answers`);
    };

    child.once('exit', (code, signal) => {
      log(`server exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
    });

    return { reused: false, port, url, child, logFile, openedBrowser, stop };
  }

  const message = `every candidate port failed: ${candidates.join(', ')}`;
  log(`failed: ${message}`);
  throw new Error(message);
}

