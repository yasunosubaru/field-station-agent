/**
 * Agent bridge (WP4) — Node ↔ Python.
 *
 * Two layers are covered:
 *
 *  1. `AgentBridge` + `handleAgentRoute` against a stub agent server written with `node:http`.
 *     The bridge's `spawn` is injected, so no Python and no child process is involved; the stub
 *     checks the `Authorization` header itself, emits its own SSE chunks, and records what it saw.
 *  2. The real `server.ts`, spawned as a child with `NAS_PYTHON=node` and a stub script that prints
 *     `AGENT_READY <port>` — this is what proves the routes are mounted ahead of the `/api/`
 *     fallback and that the token really travels from Node to Python.
 *
 * What must stay true:
 *   - a missing/unstartable agent server is a 503 `agent server unavailable: …`, never a fake 200;
 *   - the token never appears in a response, and a failed start is retried on the next request;
 *   - SSE bytes are forwarded as they arrive (the first event reaches the client before the stub
 *     writes its second), and a client that disconnects destroys the upstream request;
 *   - a session id is `[A-Za-z0-9_-]+`; anything else is a 400 and never reaches the agent;
 *   - `stop()` terminates the worker.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentBridge, handleAgentRoute } from '../src/agent-bridge.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoTail = resolve(here, '..', '..', '..', '..', '..');
const TOKEN = '0123456789abcdef0123456789abcdef';

/* -------------------------------------------------------------------------------------------
 * Stub agent server (stands in for tools/agent_server.py)
 * ----------------------------------------------------------------------------------------- */

interface SeenRequest {
  method: string;
  path: string;
  auth: string;
  body: string;
}

interface StubState {
  last: SeenRequest | null;
  requests: SeenRequest[];
  sseClosed: boolean;
  sseClosedCount: number;
}

const stubState: StubState = { last: null, requests: [], sseClosed: false, sseClosedCount: 0 };
let stubServer: Server | null = null;
let stubPort = 0;

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.byteLength });
  res.end(body);
}

function startStubAgent(): Promise<void> {
  stubServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      const seen: SeenRequest = {
        method: req.method ?? '',
        path,
        auth: String(req.headers.authorization ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      stubState.last = seen;
      stubState.requests.push(seen);

      if (seen.auth !== `Bearer ${TOKEN}`) {
        json(res, 401, { ok: false, error: 'unauthorized', class: 'input' });
        return;
      }

      const route = `${seen.method} ${path}`;
      if (route === 'GET /health') {
        json(res, 200, { ok: true, version: 'stub-9', provider: 'fake', model: 'stub', tools: 3 });
        return;
      }
      if (route === 'GET /tools') {
        json(res, 200, { tools: [{ name: 'station_health', risk: 'low', source: 'local', params: {} }] });
        return;
      }
      if (route === 'GET /sessions') {
        json(res, 200, { sessions: [{ id: 's1', title: '夜间值班', updated_at: '2026-11-03T00:00:00Z' }] });
        return;
      }
      if (route === 'POST /sessions') {
        json(res, 200, { session_id: 's-new' });
        return;
      }
      if (route === 'GET /sessions/s1') {
        json(res, 200, { session: { id: 's1', title: '夜间值班' }, events: [{ type: 'message', id: 'm1', content: 'hi' }] });
        return;
      }
      if (route === 'GET /sessions/s1/artifacts') {
        json(res, 200, { artifacts: [{ id: 'f1', name: 'x.pdf', kind: 'pdf' }] });
        return;
      }
      if (route === 'POST /sessions/s1/approval') {
        json(res, 200, { ok: true });
        return;
      }
      if (route === 'POST /sessions/s1/cancel') {
        json(res, 200, { ok: true });
        return;
      }
      if (route === 'GET /settings') {
        json(res, 200, {
          provider: 'fake', base_url: '', model: 'stub', temperature: 0.2, has_key: false, fake_fallback: true,
        });
        return;
      }
      if (route === 'POST /settings') {
        json(res, 200, { ok: true, settings: { provider: 'fake', model: 'stub' } });
        return;
      }
      if (route === 'POST /sessions/s1/message') {
        // Two writes 150 ms apart: a buffering bridge would deliver them together at the end.
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('event: agent\ndata: {"type":"token","id":"m1","delta":"你"}\n\n');
        stubState.sseClosed = false;
        res.on('close', () => {
          stubState.sseClosed = true;
          stubState.sseClosedCount += 1;
        });
        const timer = setTimeout(() => {
          res.write('event: agent\ndata: {"type":"done","session_id":"s1"}\n\n');
          res.write('event: done\ndata: {}\n\n');
          res.end();
        }, 150);
        res.on('close', () => clearTimeout(timer));
        return;
      }

      json(res, 404, { ok: false, error: `stub: no ${route}`, class: 'input' });
    });
  });
  return new Promise((ready, fail) => {
    stubServer?.once('error', fail);
    stubServer?.listen(0, '127.0.0.1', () => {
      const address = stubServer?.address();
      stubPort = typeof address === 'object' && address ? address.port : 0;
      ready();
    });
  });
}

/* -------------------------------------------------------------------------------------------
 * Fake child process — the bridge sees a real ChildProcess surface without spawning anything
 * ----------------------------------------------------------------------------------------- */

interface FakeChildHandle {
  child: ChildProcess;
  kills: string[];
}

function fakeChild(options: { ready?: number; failWith?: string; exitCode?: number }): FakeChildHandle {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kills: string[];
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kills: string[] = [];
  Object.assign(child, {
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    killed: false,
    kills,
    kill: (signal?: string) => {
      kills.push(signal ?? 'SIGTERM');
      (child as unknown as { killed: boolean }).killed = true;
      return true;
    },
  });

  setImmediate(() => {
    if (options.failWith !== undefined) {
      stderr.emit('data', Buffer.from(`${options.failWith}\n`));
      (child as unknown as { exitCode: number }).exitCode = options.exitCode ?? 1;
      child.emit('exit', options.exitCode ?? 1, null);
      return;
    }
    if (options.ready !== undefined) {
      stdout.emit('data', Buffer.from('booting agent…\n'));
      stdout.emit('data', Buffer.from(`AGENT_READY ${options.ready}\n`));
    }
  });

  return { child, kills };
}

/* -------------------------------------------------------------------------------------------
 * Helpers: route server, HTTP client, polling
 * ----------------------------------------------------------------------------------------- */

interface RouteServer {
  base: string;
  server: Server;
  close: () => Promise<void>;
}

async function startRouteServer(bridge: AgentBridge): Promise<RouteServer> {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleAgentRoute({ bridge, req, res, url, method }).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: `handler crashed: ${String(error)}` });
        return;
      }
      res.end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

function call(base: string, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(`${base}${path}`, {
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.byteLength) }
        : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = text ? JSON.parse(text) : {};
          if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          /* the caller can inspect `text` */
        }
        resolveCall({ status: res.statusCode ?? 0, text, json: parsed, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface SseSession {
  statusOf: () => number;
  headersOf: () => Record<string, string | string[] | undefined>;
  chunks: { at: number; text: string }[];
  finished: Promise<string>;
  abort: () => void;
}

function openSse(base: string, path: string, body: unknown): SseSession {
  const started = Date.now();
  const chunks: { at: number; text: string }[] = [];
  let status = 0;
  let headers: Record<string, string | string[] | undefined> = {};
  let client: ClientRequest | undefined;

  const finished = new Promise<string>((resolveText, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.byteLength) },
    }, (res) => {
      status = res.statusCode ?? 0;
      headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push({ at: Date.now() - started, text: chunk }));
      res.on('end', () => resolveText(chunks.map((entry) => entry.text).join('')));
      res.on('error', reject);
    });
    client = req;
    req.on('error', reject);
    req.end(payload);
  });
  // An aborted stream rejects; the abort test awaits the stub, not this promise.
  finished.catch(() => undefined);

  return {
    statusOf: () => status,
    headersOf: () => headers,
    chunks,
    finished,
    abort: () => client?.destroy(),
  };
}

async function until(predicate: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((wait) => setTimeout(wait, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* -------------------------------------------------------------------------------------------
 * 1. Bridge + routes against the stub (no child process)
 * ----------------------------------------------------------------------------------------- */

let routes: RouteServer;
let bridge: AgentBridge;
let spawnCount = 0;

before(async () => {
  await startStubAgent();
  bridge = new AgentBridge({
    repo: repoTail,
    script: serverPath, // any existing file: the spawn is faked, the existence check is not
    token: TOKEN,
    spawn: () => {
      spawnCount += 1;
      return fakeChild({ ready: stubPort }).child;
    },
  });
  routes = await startRouteServer(bridge);
});

after(async () => {
  await routes.close();
  await new Promise<void>((done) => {
    if (!stubServer) {
      done();
      return;
    }
    stubServer.close(() => done());
  });
});

test('JSON proxy forwards the bearer token and relays /health', async () => {
  const reply = await call(routes.base, 'GET', '/api/agent/health');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { ok: true, version: 'stub-9', provider: 'fake', model: 'stub', tools: 3 });
  assert.equal(stubState.last?.method, 'GET');
  assert.equal(stubState.last?.path, '/health');
  assert.equal(stubState.last?.auth, `Bearer ${TOKEN}`, 'Authorization must be the injected token');
  assert.equal(spawnCount, 1, 'the agent server is started lazily, exactly once');
});

test('sessions list, create, detail, artifacts and tools all reach the agent', async () => {
  const list = await call(routes.base, 'GET', '/api/agent/sessions?limit=5');
  assert.equal(list.status, 200);
  assert.equal((list.json.sessions as unknown[]).length, 1);
  assert.equal(stubState.last?.path, '/sessions', 'no query string is forwarded');

  const created = await call(routes.base, 'POST', '/api/agent/sessions', { title: '新会话' });
  assert.equal(created.status, 200);
  assert.equal(created.json.session_id, 's-new');
  assert.deepEqual(JSON.parse(stubState.last?.body ?? '{}'), { title: '新会话' });

  const detail = await call(routes.base, 'GET', '/api/agent/sessions/s1');
  assert.equal(detail.status, 200);
  assert.equal((detail.json.events as unknown[]).length, 1);

  const artifacts = await call(routes.base, 'GET', '/api/agent/sessions/s1/artifacts');
  assert.equal(artifacts.status, 200);
  assert.equal((artifacts.json.artifacts as unknown[])[0]?.name, 'x.pdf');

  const tools = await call(routes.base, 'GET', '/api/agent/tools');
  assert.equal(tools.status, 200);
  assert.equal((tools.json.tools as unknown[])[0]?.name, 'station_health');
});

test('approval, cancel and settings reach the agent with their bodies', async () => {
  const approval = await call(routes.base, 'POST', '/api/agent/sessions/s1/approval', {
    approval_id: 'a1', decision: 'approved', note: '现场确认',
  });
  assert.equal(approval.status, 200);
  assert.deepEqual(approval.json, { ok: true });
  assert.equal(stubState.last?.path, '/sessions/s1/approval');
  assert.deepEqual(JSON.parse(stubState.last?.body ?? '{}'), { approval_id: 'a1', decision: 'approved', note: '现场确认' });

  const cancel = await call(routes.base, 'POST', '/api/agent/sessions/s1/cancel');
  assert.equal(cancel.status, 200);
  assert.equal(stubState.last?.path, '/sessions/s1/cancel');

  const settings = await call(routes.base, 'GET', '/api/agent/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.json.fake_fallback, true);
  assert.equal(settings.json.has_key, false);

  const write = await call(routes.base, 'POST', '/api/agent/settings', { model: 'stub-2', api_key: 'sk-never-echoed' });
  assert.equal(write.status, 200);
  assert.equal(stubState.last?.path, '/settings');
  assert.equal(write.text.includes('sk-never-echoed'), false, 'the agent answer is relayed, nothing is invented');
});

test('SSE is relayed chunk by chunk with no-cache headers', async () => {
  const session = openSse(routes.base, '/api/agent/sessions/s1/message', { text: '你好' });
  const body = await session.finished;

  assert.equal(session.statusOf(), 200);
  const headers = session.headersOf();
  assert.match(String(headers['content-type']), /^text\/event-stream/);
  assert.equal(headers['cache-control'], 'no-cache');
  assert.equal(headers.connection, 'keep-alive');
  assert.equal(headers['x-accel-buffering'], 'no');
  assert.ok(!('content-length' in headers), 'a stream must not announce a length');

  assert.ok(session.chunks.length >= 2, `expected separate chunks, got ${session.chunks.length}`);
  assert.match(session.chunks[0].text, /"type":"token"/, 'the first event is the token event');
  assert.doesNotMatch(session.chunks[0].text, /"type":"done"/, 'the done event had not been written yet');
  // The stub writes its second event 150 ms in; a buffering proxy would only flush at the end.
  const gap = session.chunks[session.chunks.length - 1].at - session.chunks[0].at;
  assert.ok(gap >= 100, `chunks must arrive apart (gap ${gap} ms)`);
  assert.match(body, /event: done[\s\S]*$/);
});

test('SSE: a client that disconnects destroys the upstream request', async () => {
  stubState.sseClosed = false;
  const session = openSse(routes.base, '/api/agent/sessions/s1/message', { text: '取消' });
  await until(() => session.chunks.length > 0, 2000, 'first SSE chunk');
  session.abort();
  await until(() => stubState.sseClosed, 3000, 'the stub to see its response closed');
  assert.ok(stubState.sseClosed, 'the upstream request must not keep generating for nobody');
});

test('a bad session id is a 400 and never reaches the agent', async () => {
  const before = stubState.requests.length;
  for (const bad of ['bad.id', 'a%20b', 'x'.repeat(97)]) {
    const reply = await call(routes.base, 'GET', `/api/agent/sessions/${bad}`);
    assert.equal(reply.status, 400, `id ${bad} must be refused`);
    assert.equal(reply.json.ok, false);
    assert.match(String(reply.json.error), /id/);
  }
  assert.equal(stubState.requests.length, before, 'no invalid id was proxied');
});

test('method and path mismatches are answered by the agent layer', async () => {
  const wrongMethod = await call(routes.base, 'GET', '/api/agent/sessions/s1/approval');
  assert.equal(wrongMethod.status, 405);
  assert.match(String(wrongMethod.json.error), /只接受 POST/);

  const unknown = await call(routes.base, 'GET', '/api/agent/nope');
  assert.equal(unknown.status, 404);
  assert.match(String(unknown.json.error), /未知接口/);
});

test('an agent that refuses the token is relayed as-is', async () => {
  const wrongTokenBridge = new AgentBridge({
    repo: repoTail,
    script: serverPath,
    token: 'ffffffffffffffffffffffffffffffff',
    spawn: () => fakeChild({ ready: stubPort }).child,
  });
  const other = await startRouteServer(wrongTokenBridge);
  try {
    const reply = await call(other.base, 'GET', '/api/agent/health');
    assert.equal(reply.status, 401);
    assert.equal(reply.json.error, 'unauthorized');
    assert.equal(reply.text.includes('ffffffffffffffffffffffffffffffff'), false);
  } finally {
    wrongTokenBridge.stop();
    await other.close();
  }
});

test('stop() kills the worker and the next request starts a fresh one', async () => {
  const counter = { spawns: 0 };
  let first: FakeChildHandle | null = null;
  const local = new AgentBridge({
    repo: repoTail,
    script: serverPath,
    token: TOKEN,
    spawn: () => {
      counter.spawns += 1;
      const handle = fakeChild({ ready: stubPort });
      if (counter.spawns === 1) first = handle;
      return handle.child;
    },
  });
  const localRoutes = await startRouteServer(local);
  try {
    const result = await call(localRoutes.base, 'GET', '/api/agent/health');
    assert.equal(result.status, 200);
    assert.equal(counter.spawns, 1);

    local.stop();
    assert.ok((first as FakeChildHandle | null)?.kills.length, 'stop() must signal the child');
    assert.equal(local.status().ready, false);

    const second = await call(localRoutes.base, 'GET', '/api/agent/health');
    assert.equal(second.status, 200);
    assert.equal(counter.spawns, 2, 'a stopped bridge starts a new worker on the next request');
  } finally {
    local.stop();
    await localRoutes.close();
  }
});

/* -------------------------------------------------------------------------------------------
 * 2. Failure paths — 503, and no token in the message
 * ----------------------------------------------------------------------------------------- */

test('a missing agent entry point is a 503, retried on the next request', async () => {
  let attempts = 0;
  const missing = new AgentBridge({
    repo: repoTail,
    script: join(repoTail, 'no-such-agent-server.py'),
    token: TOKEN,
    spawn: () => {
      attempts += 1;
      return fakeChild({ ready: stubPort }).child;
    },
  });
  const local = await startRouteServer(missing);
  try {
    for (let round = 0; round < 2; round += 1) {
      const reply = await call(local.base, 'GET', '/api/agent/health');
      assert.equal(reply.status, 503);
      assert.equal(reply.json.ok, false);
      assert.match(String(reply.json.error), /^agent server unavailable: /);
      assert.match(String(reply.json.error), /找不到 agent 服务入口/);
      assert.equal(reply.text.includes(TOKEN), false, 'the token is never echoed');
    }
    assert.equal(attempts, 0, 'nothing is spawned when the script is not there');
  } finally {
    await local.close();
  }
});

test('a spawn that throws and a child that exits early are both 503', async () => {
  const throwing = new AgentBridge({
    repo: repoTail,
    script: serverPath,
    token: TOKEN,
    spawn: () => {
      throw new Error('ENOENT: python.exe not found');
    },
  });
  const one = await startRouteServer(throwing);
  try {
    const reply = await call(one.base, 'GET', '/api/agent/health');
    assert.equal(reply.status, 503);
    assert.match(String(reply.json.error), /无法启动 python/);
  } finally {
    await one.close();
  }

  let spawns = 0;
  const dying = new AgentBridge({
    repo: repoTail,
    script: serverPath,
    token: TOKEN,
    spawn: () => {
      spawns += 1;
      return fakeChild({ failWith: 'Traceback: no module named fieldstation', exitCode: 2 }).child;
    },
  });
  const two = await startRouteServer(dying);
  try {
    const first = await call(two.base, 'GET', '/api/agent/health');
    assert.equal(first.status, 503);
    assert.match(String(first.json.error), /启动失败/);
    assert.match(String(first.json.error), /退出码 2/);

    const second = await call(two.base, 'GET', '/api/agent/health');
    assert.equal(second.status, 503);
    assert.equal(spawns, 2, 'every request retries a dead server');
    assert.equal(second.text.includes(TOKEN), false);
  } finally {
    await two.close();
  }
});

test('a health request that never reports AGENT_READY times out as 503', async () => {
  const handle = fakeChild({}); // prints nothing
  const silent = new AgentBridge({
    repo: repoTail,
    script: serverPath,
    token: TOKEN,
    startupTimeoutMs: 300,
    spawn: () => handle.child,
  });
  const local = await startRouteServer(silent);
  try {
    const reply = await call(local.base, 'GET', '/api/agent/health');
    assert.equal(reply.status, 503);
    assert.match(String(reply.json.error), /AGENT_READY/);
    assert.ok(handle.kills.length >= 1, 'a worker that never gets ready is killed');
  } finally {
    await local.close();
  }
});

/* -------------------------------------------------------------------------------------------
 * 3. The real server.ts — routes mounted before the `/api/` fallback, token travels end to end
 * ----------------------------------------------------------------------------------------- */

const STUB_PYTHON = `import { createServer } from 'node:http';
const argv = process.argv.slice(2);
const token = argv[argv.indexOf('--token') + 1];
const nodeUrl = argv[argv.indexOf('--node-url') + 1];
const repo = argv[argv.indexOf('--repo') + 1];
const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"unauthorized"}');
    return;
  }
  if ((req.url || '').split('?')[0] === '/health') {
    const body = JSON.stringify({ ok: true, version: 'stub-python', provider: 'fake', model: 'stub',
                                  tools: 0, node_url: nodeUrl, repo });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"ok":false,"error":"stub: not found"}');
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('AGENT_READY ' + server.address().port + '\\n');
});
`;

interface ServerHandle {
  child: ChildProcess;
  base: string;
  stderr: () => string;
  close: () => Promise<void>;
}

function startApp(env: NodeJS.ProcessEnv): Promise<ServerHandle> {
  const child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: repoTail,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const base = new Promise<string>((ready, fail) => {
    let stdout = '';
    const timer = setTimeout(() => fail(new Error(`server did not start in 20 s\n${stderr}`)), 20_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        ready(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited (${code}) before READY\n${stderr}`));
    });
  });

  return base.then((url) => ({
    child,
    base: url,
    stderr: () => stderr,
    close: () => new Promise<void>((done) => {
      if (child.exitCode !== null) {
        done();
        return;
      }
      child.once('exit', () => done());
      child.kill();
    }),
  }));
}

test('server.ts mounts /api/agent/* and passes the token to Python', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nas-agent-bridge-'));
  const stub = join(dir, 'stub-agent.mjs');
  writeFileSync(stub, STUB_PYTHON, 'utf8');
  const app = await startApp({ NAS_PYTHON: process.execPath, NAS_AGENT_SERVER: stub });
  try {
    const health = await call(app.base, 'GET', '/api/agent/health');
    assert.equal(health.status, 200, `expected the stub's health\n${app.stderr()}`);
    assert.equal(health.json.version, 'stub-python');
    assert.equal(health.json.ok, true);
    assert.equal(health.json.repo, repoTail);
    assert.equal(String(health.json.node_url), `http://127.0.0.1:${new URL(app.base).port}`);
    assert.equal(health.text.includes('AGENT_READY'), false);

    const badId = await call(app.base, 'GET', '/api/agent/sessions/bad.id');
    assert.equal(badId.status, 400);

    const wrongMethod = await call(app.base, 'POST', '/api/agent/health');
    assert.equal(wrongMethod.status, 405);
    assert.match(String(wrongMethod.json.error), /\/api\/agent\/health 只接受 GET/);

    // Still the app's own fallback for a non-agent API path.
    const otherApi = await call(app.base, 'GET', '/api/does-not-exist');
    assert.equal(otherApi.status, 404);
  } finally {
    await app.close();
  }
});

test('server.ts answers 503 when Python cannot be started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nas-agent-bridge-'));
  const stub = join(dir, 'stub-agent.mjs');
  writeFileSync(stub, STUB_PYTHON, 'utf8');
  const app = await startApp({
    NAS_PYTHON: join(dir, 'no-such-python.exe'),
    NAS_AGENT_SERVER: stub,
  });
  try {
    const reply = await call(app.base, 'GET', '/api/agent/health');
    assert.equal(reply.status, 503);
    assert.equal(reply.json.ok, false);
    assert.match(String(reply.json.error), /^agent server unavailable: /);
    assert.match(String(reply.json.error), /无法启动 python/);
  } finally {
    await app.close();
  }
});
