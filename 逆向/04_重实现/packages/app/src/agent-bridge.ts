/**
 * Agent bridge (WP4) — the Node ↔ Python half of the desktop app.
 *
 * The agent server is Python (`tools/agent_server.py`, stdlib only) because the tools it drives
 * are the Python side of the suite. This module is the **only** thing in the Node app that starts
 * it, and it starts it lazily: the first `/api/agent/*` request spawns it, the process prints
 * `AGENT_READY <port>` on stdout, and every later request is a plain HTTP call to
 * `127.0.0.1:<port>` with `Authorization: Bearer <token>`.
 *
 * Contract (see `docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md` §1/§3/§4):
 *
 *   GET  /health                      {ok, version, provider, model, tools}
 *   GET  /tools                       {tools:[…]}
 *   GET  /sessions                    {sessions:[…]}
 *   POST /sessions                    {session_id}
 *   GET  /sessions/{id}               {session, events:[…]}
 *   POST /sessions/{id}/message       text/event-stream (piped chunk by chunk)
 *   POST /sessions/{id}/approval      {ok}
 *   POST /sessions/{id}/cancel        {ok}
 *   GET  /sessions/{id}/artifacts     {artifacts:[…]}
 *   GET  /settings → {provider, base_url, model, temperature, has_key, fake_fallback}
 *   POST /settings → {ok, settings}
 *
 * Rules that matter:
 *   - the token never appears in a response, a log line or an error message;
 *   - a dead/unstartable server is reported as 503 `{ok:false,error:"agent server unavailable: …"}`
 *     and the **next** request tries to start it again (a crashed agent must not poison the app);
 *   - SSE is relayed unbuffered, and a client that goes away destroys the upstream request.
 */

import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { HttpError, REPO_DIR } from './paths.ts';

const HOST = '127.0.0.1';
/** 16 bytes → the 32 hex characters the contract asks for. */
const TOKEN_BYTES = 16;
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BODY_LIMIT = 1_000_000;
const STDERR_LINES = 20;
const STDERR_CHARS = 4_000;
/** Session ids are path segments; nothing else may appear in one. */
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const READY_RE = /AGENT_READY (\d{1,5})/;
export const AGENT_PREFIX = '/api/agent';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface AgentBridgeOptions {
  /** Repository root — the Python server's cwd (default `<repo>`). */
  repo?: string;
  /** Interpreter override; default order: `NAS_PYTHON` → `<repo>/runtime/python/python.exe` → PATH. */
  python?: string;
  /** `<repo>/tools/agent_server.py` unless `NAS_AGENT_SERVER` names another entry point. */
  script?: string;
  /** `NAS_AGENT_DATA` — where sessions/artifacts live. Left unset the agent picks its own default. */
  dataDir?: string;
  /** Bearer token; generated when absent. Tests inject one so a stub can verify the header. */
  token?: string;
  /** `http://127.0.0.1:<nodePort>` passed to Python as `--node-url`. */
  nodeUrl?: string;
  /** Read at spawn time, so the bridge can be built before `server.listen` reports its port. */
  nodePort?: () => number;
  /** Injection point for tests; the default is `child_process.spawn`. */
  spawn?: SpawnFn;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Extra environment for the child (merged over `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Where the child's stderr goes; default `console.warn`, already redacted. */
  log?: (line: string) => void;
}

/** "There is no agent to talk to" — mapped to 503 by the route layer, never to a fake success. */
export class AgentUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'AgentUnavailableError';
    this.reason = reason;
  }
}

interface Endpoint {
  port: number;
}

function textChunk(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
}

/** Read a response body with a cap and an idle timeout; used for every non-SSE reply. */
function readAll(stream: IncomingMessage, limit: number, idleMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        stream.destroy();
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => done(new AgentUnavailableError(`agent server 响应超时（${idleMs} ms 没有数据）`)),
        idleMs,
      );
      timer.unref?.();
    };

    arm();
    stream.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        done(new HttpError(502, `agent server 返回体过大（超过 ${limit} B）`));
        return;
      }
      chunks.push(chunk);
      arm();
    });
    stream.on('end', () => done());
    stream.on('error', (error: Error) => {
      done(new AgentUnavailableError(`读取 agent server 响应失败：${error.message}`));
    });
  });
}

export class AgentBridge {
  readonly repo: string;
  readonly script: string;
  readonly dataDir: string;
  readonly token: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;

  private readonly fixedPython: string;
  private readonly fixedNodeUrl: string;
  private readonly nodePort: (() => number) | undefined;
  private readonly spawn: SpawnFn;
  private readonly extraEnv: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;

  private child: ChildProcess | null = null;
  private endpoint: Endpoint | null = null;
  private starting: Promise<Endpoint> | null = null;
  private stderrTail: string[] = [];
  /** Bumped by `stop()` so a start that lands after shutdown does not leave a worker behind. */
  private generation = 0;

  constructor(options: AgentBridgeOptions = {}) {
    this.repo = options.repo ?? REPO_DIR;
    this.script = options.script
      ?? (process.env.NAS_AGENT_SERVER && process.env.NAS_AGENT_SERVER.trim()
        ? process.env.NAS_AGENT_SERVER.trim()
        : join(this.repo, 'tools', 'agent_server.py'));
    this.dataDir = options.dataDir ?? (process.env.NAS_AGENT_DATA ?? '').trim();
    this.token = options.token ?? (
      process.env.FSA_AGENT_TOKEN?.trim()
      || randomBytes(TOKEN_BYTES).toString('hex')
    );
    this.fixedPython = options.python ?? '';
    this.fixedNodeUrl = options.nodeUrl ?? '';
    this.nodePort = options.nodePort;
    this.spawn = options.spawn ?? spawnChildProcess;
    this.extraEnv = options.env ?? {};
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  /** Nothing secret is in here — the token is deliberately absent. */
  status(): { ready: boolean; pid: number | null; port: number | null; python: string; script: string } {
    return {
      ready: this.endpoint !== null,
      pid: this.child?.pid ?? null,
      port: this.endpoint?.port ?? null,
      python: this.resolvePython().command,
      script: this.script,
    };
  }

  /** `NAS_PYTHON` → the bundled `runtime/python/python.exe` → PATH `python`, in that order. */
  resolvePython(): { command: string; source: 'env' | 'runtime' | 'path' } {
    const calc = (this.fixedPython || '').trim()
      || (this.extraEnv.NAS_PYTHON ?? '').trim()
      || (process.env.NAS_PYTHON ?? '').trim();
    if (calc) return { command: calc, source: 'env' };
    const bundled = join(this.repo, 'runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python');
    if (existsSync(bundled)) return { command: bundled, source: 'runtime' };
    return { command: 'python', source: 'path' };
  }

  /** Never let the token out, even if the child echoes its own argv. */
  redact(text: string): string {
    if (!text || !this.token) return text;
    return text.split(this.token).join('<token>');
  }

  private nodeUrl(): string {
    if (this.fixedNodeUrl) return this.fixedNodeUrl;
    return `http://${HOST}:${this.nodePort ? this.nodePort() : 0}`;
  }

  private noteStderr(text: string): void {
    for (const raw of this.redact(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      this.stderrTail.push(line);
      while (this.stderrTail.length > STDERR_LINES) this.stderrTail.shift();
      this.log(`[agent] ${line.slice(0, 400)}`);
    }
    let joined = this.stderrTail.join('\n');
    if (joined.length > STDERR_CHARS) {
      joined = joined.slice(-STDERR_CHARS);
      this.stderrTail = joined.split('\n');
    }
  }

  private stderrSummary(): string {
    const tail = this.stderrTail.slice(-3).join(' / ');
    return tail ? `：${tail}` : '';
  }

  /** Start once; concurrent callers share the same start. A failure clears the way for a retry. */
  private async ensureStarted(): Promise<Endpoint> {
    if (this.endpoint) return this.endpoint;
    if (!this.starting) {
      const generation = this.generation;
      const pending = this.start(generation).finally(() => {
        if (this.starting === pending) this.starting = null;
      });
      this.starting = pending;
    }
    return this.starting as Promise<Endpoint>;
  }

  private start(generation: number): Promise<Endpoint> {
    if (!existsSync(this.script)) {
      return Promise.reject(new AgentUnavailableError(`找不到 agent 服务入口（${this.script}）`));
    }

    const python = this.resolvePython();
    const args = [
      this.script,
      '--port', '0',
      '--token', this.token,
      '--node-url', this.nodeUrl(),
      '--repo', this.repo,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    env.PYTHONPATH = 'src';
    env.PYTHONIOENCODING = 'utf-8';
    if (this.dataDir) env.NAS_AGENT_DATA = this.dataDir;

    let child: ChildProcess;
    try {
      child = this.spawn(python.command, args, {
        cwd: this.repo,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.reject(new AgentUnavailableError(`无法启动 python（${python.command}）：${message}`));
    }

    this.child = child;
    this.stderrTail = [];

    return new Promise<Endpoint>((resolve, reject) => {
      let output = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (error?: Error, endpoint?: Endpoint): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          if (this.child === child) {
            this.child = null;
            this.endpoint = null;
          }
          reject(error);
          return;
        }
        this.endpoint = endpoint ?? null;
        resolve(endpoint as Endpoint);
      };

      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        settle(new AgentUnavailableError(
          `agent server 在 ${Math.round(this.startupTimeoutMs / 1000)} s 内没有报告 AGENT_READY${this.stderrSummary()}`,
        ));
      }, this.startupTimeoutMs);
      timer.unref?.();

      child.stdout?.on('data', (chunk: unknown) => {
        if (settled) return;
        output += textChunk(chunk);
        const match = READY_RE.exec(output);
        if (!match) return;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          settle(new AgentUnavailableError(`agent server 报告的端口不合法：${match[1]}`));
          return;
        }
        if (generation !== this.generation) {
          // `stop()` ran while this worker was starting: shut it down instead of leaking it.
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          settle(new AgentUnavailableError('agent server 在启动过程中被停止'));
          return;
        }
        settle(undefined, { port });
      });

      child.stderr?.on('data', (chunk: unknown) => this.noteStderr(textChunk(chunk)));

      child.once('error', (error: Error) => {
        settle(new AgentUnavailableError(`无法启动 python（${python.command}）：${error.message}`));
      });

      child.once('exit', (code, signal) => {
        // Ready or not, a child that exited is not something to keep talking to; the next request
        // starts a fresh one.
        if (this.child === child) {
          this.child = null;
          this.endpoint = null;
        }
        if (settled) return;
        settle(new AgentUnavailableError(
          `agent server 启动失败（退出码 ${code ?? 'null'}${signal ? ` / ${signal}` : ''}）${this.stderrSummary()}`,
        ));
      });
    });
  }

  /** One authenticated request; resolves with the upstream response once its headers arrived. */
  private open(port: number, path: string, method: string, payload: Buffer | undefined): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json, text/event-stream',
      };
      if (payload) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = String(payload.byteLength);
      } else if (method !== 'GET' && method !== 'HEAD') {
        headers['Content-Length'] = '0';
      }

      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (error?: Error, upstream?: IncomingMessage): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(upstream as IncomingMessage);
      };

      const req = httpRequest({ host: HOST, port, path, method, headers, agent: false }, (upstream) => {
        finish(undefined, upstream);
      });

      timer = setTimeout(() => {
        const error = new AgentUnavailableError(`agent server 请求超时（${this.requestTimeoutMs} ms）`);
        req.destroy(error);
        finish(error);
      }, this.requestTimeoutMs);
      timer.unref?.();

      req.on('error', (error: Error) => {
        finish(new AgentUnavailableError(`连不上 agent server（127.0.0.1:${port}）：${this.redact(error.message)}`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /** JSON proxy. Non-2xx replies are returned, not thrown: the caller relays the agent's own answer. */
  async requestJson(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const endpoint = await this.ensureStarted();
    const verb = method.toUpperCase();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const upstream = await this.open(endpoint.port, path, verb, payload);

    let raw: Buffer;
    try {
      raw = await readAll(upstream, BODY_LIMIT, this.requestTimeoutMs);
    } catch (error) {
      // A socket that dies under a working child means the child died: let the next call restart it.
      this.endpoint = null;
      throw error;
    }

    const status = upstream.statusCode ?? 502;
    const text = raw.toString('utf8').trim();
    if (!text) {
      return { status, data: { ok: status >= 200 && status < 300 } };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return { status, data: parsed as Record<string, unknown> };
    } catch {
      throw new HttpError(502, `agent server 返回了非 JSON 响应（HTTP ${status}）`);
    }
  }

  /**
   * Relay `text/event-stream` without buffering: each upstream chunk is written to the client as it
   * arrives (back-pressure pauses the upstream instead of growing a queue), and a client that
   * disconnects destroys the upstream request so the agent stops generating for nobody.
   */
  async requestSse(path: string, body: unknown, res: ServerResponse): Promise<void> {
    const endpoint = await this.ensureStarted();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const upstream = await this.open(endpoint.port, path, 'POST', payload);
    const status = upstream.statusCode ?? 502;

    if (status < 200 || status >= 300) {
      // The agent answered with a JSON error instead of a stream (400/404/409/500).
      let data: Record<string, unknown> = { ok: false, error: `agent server 返回 HTTP ${status}` };
      try {
        const text = (await readAll(upstream, BODY_LIMIT, this.requestTimeoutMs)).toString('utf8').trim();
        const parsed: unknown = text ? JSON.parse(text) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      } catch {
        /* keep the generic error; the status is the fact that matters */
      }
      sendAgentJson(res, status, data);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => {
      closed = true;
      upstream.destroy();
    });
    res.on('drain', () => upstream.resume());

    upstream.on('data', (chunk: Buffer) => {
      if (closed) return;
      if (!res.write(chunk)) upstream.pause();
    });
    upstream.on('end', () => {
      if (!closed && !res.writableEnded) res.end();
    });
    upstream.on('error', (error: Error) => {
      if (closed || res.writableEnded) return;
      const event = {
        type: 'error',
        class: 'execution',
        message: `agent 事件流中断：${this.redact(error.message)}`,
      };
      res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  }

  /** Terminate the worker (if any). Safe to call twice, and from a signal handler. */
  stop(): void {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.starting = null;
    if (!child) return;
    try {
      if (child.exitCode === null) child.kill();
    } catch {
      /* already gone */
    }
  }
}

/* ---------------------------------------------------------------------------------------------
 * HTTP surface — `/api/agent/*`
 *
 * These routes are mounted by `server.ts` **before** the `/api/` catch-all, so an unknown
 * `/api/agent/...` path is a 404 from here and never the generic "未知接口". Validation is strict:
 * a session id is `[A-Za-z0-9_-]{1,96}`, so nothing decodable (`%2e`, spaces, dots) reaches the
 * Python side as a path.
 * ------------------------------------------------------------------------------------------- */

function sendAgentJson(res: ServerResponse, status: number, payload: unknown, method = 'GET'): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > BODY_LIMIT) throw new HttpError(413, '请求体过大');
    chunks.push(buf);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export function assertAgentId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) {
    throw new HttpError(400, '会话 id 只允许字母、数字、下划线和连字符');
  }
  return raw;
}

const SESSION_PATH_RE = /^\/api\/agent\/sessions\/([^/]+)(?:\/(message|approval|cancel|artifacts))?$/;

export interface AgentRouteContext {
  bridge: AgentBridge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
}

async function relayJson(
  bridge: AgentBridge,
  res: ServerResponse,
  method: string,
  upstreamMethod: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const result = await bridge.requestJson(upstreamMethod, path, body);
  sendAgentJson(res, result.status, result.data, method);
}

/** Dispatch one `/api/agent/*` request. Throws only for genuine bugs; everything else is answered. */
export async function handleAgentRoute(context: AgentRouteContext): Promise<void> {
  const { bridge, req, res, url, method } = context;
  const path = url.pathname;

  try {
    if (path === `${AGENT_PREFIX}/health`) {
      if (method !== 'GET') throw new HttpError(405, '/api/agent/health 只接受 GET');
      await relayJson(bridge, res, method, 'GET', '/health');
      return;
    }

    if (path === `${AGENT_PREFIX}/tools`) {
      if (method !== 'GET') throw new HttpError(405, '/api/agent/tools 只接受 GET');
      await relayJson(bridge, res, method, 'GET', '/tools');
      return;
    }

    if (path === `${AGENT_PREFIX}/sessions`) {
      if (method === 'GET') {
        await relayJson(bridge, res, method, 'GET', '/sessions');
        return;
      }
      if (method === 'POST') {
        const body = await readJsonObject(req);
        await relayJson(bridge, res, method, 'POST', '/sessions', body);
        return;
      }
      throw new HttpError(405, '/api/agent/sessions 只接受 GET / POST');
    }

    if (path === `${AGENT_PREFIX}/settings`) {
      if (method === 'GET') {
        await relayJson(bridge, res, method, 'GET', '/settings');
        return;
      }
      if (method === 'POST') {
        const body = await readJsonObject(req);
        await relayJson(bridge, res, method, 'POST', '/settings', body);
        return;
      }
      throw new HttpError(405, '/api/agent/settings 只接受 GET / POST');
    }

    const match = SESSION_PATH_RE.exec(path);
    if (match) {
      const id = assertAgentId(match[1]);
      const tail = match[2] ?? '';

      if (!tail) {
        if (method !== 'GET') throw new HttpError(405, '/api/agent/sessions/:id 只接受 GET');
        await relayJson(bridge, res, method, 'GET', `/sessions/${id}`);
        return;
      }

      if (tail === 'message') {
        if (method !== 'POST') throw new HttpError(405, '/api/agent/sessions/:id/message 只接受 POST');
        const body = await readJsonObject(req);
        await bridge.requestSse(`/sessions/${id}/message`, body, res);
        return;
      }

      if (tail === 'approval') {
        if (method !== 'POST') throw new HttpError(405, '/api/agent/sessions/:id/approval 只接受 POST');
        const body = await readJsonObject(req);
        await relayJson(bridge, res, method, 'POST', `/sessions/${id}/approval`, body);
        return;
      }

      if (tail === 'cancel') {
        if (method !== 'POST') throw new HttpError(405, '/api/agent/sessions/:id/cancel 只接受 POST');
        const body = await readJsonObject(req);
        await relayJson(bridge, res, method, 'POST', `/sessions/${id}/cancel`, body);
        return;
      }

      // tail === 'artifacts'
      if (method !== 'GET') throw new HttpError(405, '/api/agent/sessions/:id/artifacts 只接受 GET');
      await relayJson(bridge, res, method, 'GET', `/sessions/${id}/artifacts`);
      return;
    }

    throw new HttpError(404, `未知接口：${path}`);
  } catch (error) {
    if (res.headersSent) {
      // An SSE stream had already started; the only honest thing left is to close it.
      if (!res.writableEnded) res.end();
      return;
    }
    if (error instanceof AgentUnavailableError) {
      sendAgentJson(res, 503, {
        ok: false,
        error: `agent server unavailable: ${bridge.redact(error.reason)}`,
      }, method);
      return;
    }
    if (error instanceof HttpError) {
      sendAgentJson(res, error.status, { ok: false, error: error.message }, method);
      return;
    }
    throw error;
  }
}
