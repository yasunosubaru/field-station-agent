/**
 * 视-2 / 视-3 / 视-4 的 HTTP 出口：`/api/botd/*`、`/api/data/*`、`/api/suite/*`。
 *
 *   node --test packages/app/test/surface-routes.test.ts
 *
 * ## 为什么这些测试要存在
 *
 * 三个前端视角（`web/views/fleet.js` / `data.js` / `suite.js`）早就写好了取数逻辑，
 * 但它们调的接口在 `server.ts` 里**一个都没有**。那种缺失有个讨厌的特点：页面能打开、
 * 不报错、只是每块都显示「还没接上」—— 看起来像后端没做完，而实际上是路由没接。
 * 所以这里断言的是「路由在不在、转发的路径对不对、上游的回答有没有被改形状」。
 *
 * ## 两条硬约束
 *
 * 1. **形状由前端定，不由后端定**：`fleet.js` 读 `tree` 的顶层 `task_id` / `status` /
 *    `steps`，读 `events` 的 `raw.events`，读 `pending` 的 `intervention_id`；
 *    `suite.js` 用 `response.text()` 读 markdown。这三条各自有单独用例。
 * 2. **不重复实现 Python 的口径**：`batch` / `task_id` 的校验、`R-4.2` 的阈值、
 *    `takeover` 要审批，全在上游。Node 层只转发，上游的 4xx 原样透传 —— 把它改写
 *    成 500 会把「请求不合法」说成「服务坏了」。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SURFACE_ENDPOINTS,
  handleSurfaceRoute,
  isSurfacePath,
} from '../src/surface-routes.ts';
import { AgentBridge } from '../src/agent-bridge.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoTail = resolve(here, '..', '..', '..', '..', '..');
const TOKEN = '0123456789abcdef0123456789abcdef';

/* ---------------------------------------------------------------------------------------------
 * 1. 路由表：前缀归属与清单
 * ------------------------------------------------------------------------------------------- */

test('三个前缀各有归属，且不越界', () => {
  for (const path of [
    '/api/botd',
    '/api/botd/forest',
    '/api/botd/tree',
    '/api/data/batches',
    '/api/data/search',
    '/api/suite/field-parity',
  ]) {
    assert.equal(isSurfacePath(path), true, `${path} 应由本模块处理`);
  }
  // 不相干的前缀绝不能落进来：`/api/agent/*` 有自己的路由，`/api/graph/*` 也是。
  for (const path of [
    '/api/agent/health',
    '/api/graph/data',
    '/api/health',
    '/api/botdx/forest',
    '/api/datax',
    '/',
    '/views/fleet.js',
  ]) {
    assert.equal(isSurfacePath(path), false, `${path} 不该被本模块拦下`);
  }
});

test('/api/health 的 endpoints 清单包含每一个新接口', () => {
  // 验收项：清单要能一眼看出后端暴露了什么。
  assert.deepEqual([...SURFACE_ENDPOINTS], [
    '/api/botd/forest',
    '/api/botd/tree',
    '/api/botd/events',
    '/api/botd/pending',
    '/api/botd/intervene',
    '/api/data/batches',
    '/api/data/quality',
    '/api/data/search',
    '/api/data/eval',
    '/api/suite/field-parity',
  ]);
  // 前端的三个端点常量必须都能在清单里找到 —— 漏一条就是「页面点了没反应」。
  const frontend = [
    '/api/botd/forest',
    '/api/botd/tree',
    '/api/botd/events',
    '/api/botd/pending',
    '/api/botd/intervene',
    '/api/data/batches',
    '/api/data/quality',
    '/api/data/search',
    '/api/data/eval',
    '/api/suite/field-parity',
  ];
  for (const path of frontend) {
    assert.ok(SURFACE_ENDPOINTS.includes(path), `${path} 必须在 endpoints 清单里`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * 2. 进程内：转发路径、方法、形状
 * ------------------------------------------------------------------------------------------- */

interface Seen {
  method: string;
  path: string;
  auth: string;
  body: string;
}

const seen: Seen[] = [];
let stub: Server | null = null;
let stubPort = 0;

function startStub(): Promise<void> {
  stub = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '/';
      const path = url.split('?')[0];
      seen.push({
        method: req.method ?? 'GET',
        path: url,
        auth: String(req.headers.authorization ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (path === '/board/forest') {
        return json(res, 200, { ok: true, tasks: [], pending: [] });
      }
      if (path === '/board/events') {
        // 界面读 `{events:[…]}`（fleet.js 的端点表）；每一条带 kind / ts / tool / call_id。
        return json(res, 200, {
          ok: true,
          events: [{ seq: 1, kind: 'tool.call', call_id: 'c-1', tool: 'robust_stats',
                     ts: '2026-11-11T09:30:00.000Z', phase: 'tool.call', label: '调用' }],
          task_id: 't-1',
        });
      }
      if (path === '/board/tree') {
        if (!url.includes('task_id=t-1')) {
          return json(res, 400, { ok: false, error: '缺少 task_id 参数', class: 'input' });
        }
        return json(res, 200, { ok: true, root: {}, steps: [], counts: { steps: 0 } });
      }
      if (path === '/board/intervene') {
        return json(res, 200, { ok: true, needs_approval: false });
      }
      if (path === '/data/quality') {
        return json(res, 400, { ok: false, error: '缺少 batch 参数', class: 'input' });
      }
      if (path === '/suite/field-parity') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end('| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |\n');
      }
      return json(res, 200, { ok: true, path });
    });
  });
  return new Promise((ready) => {
    stub?.listen(0, '127.0.0.1', () => {
      const address = stub?.address();
      stubPort = typeof address === 'object' && address ? address.port : 0;
      ready();
    });
  });
}

let front: Server | null = null;
let frontPort = 0;
let bridge: AgentBridge;

function startFront(): Promise<void> {
  front = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = (req.method ?? 'GET').toUpperCase();
    void handleSurfaceRoute({ bridge, req, res, url, method }).catch((error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    });
  });
  return new Promise((ready) => {
    front?.listen(0, '127.0.0.1', () => {
      const address = front?.address();
      frontPort = typeof address === 'object' && address ? address.port : 0;
      ready();
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.byteLength });
  res.end(body);
}

interface Reply {
  status: number;
  type: string;
  text: string;
}

async function call(path: string, method = 'GET', payload?: unknown): Promise<Reply> {
  const response = await fetch(`http://127.0.0.1:${frontPort}${path}`, {
    method,
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

before(async () => {
  await startStub();
  // 172.0.0.1 is never contacted: every request goes through the injected spawn below.
  bridge = new AgentBridge({ token: TOKEN, nodeUrl: 'http://127.0.0.1:1' });
  // 让桥直接对着 stub：把 ensureStarted 的结果固定成 stub 端口。
  (bridge as unknown as { endpoint: { port: number } }).endpoint = { port: stubPort };
  await startFront();
});

after(async () => {
  await new Promise<void>((done) => (front ? front.close(() => done()) : done()));
  await new Promise<void>((done) => (stub ? stub.close(() => done()) : done()));
});

test('GET /api/botd/forest 转发到 /board/forest，带 token', async () => {
  const reply = await call('/api/botd/forest');
  assert.equal(reply.status, 200);
  assert.match(reply.type, /^application\/json/);
  const body = JSON.parse(reply.text) as { ok: boolean; tasks: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.tasks));

  const hit = seen.at(-1);
  assert.equal(hit?.path, '/board/forest', '路径要重写前缀');
  assert.equal(hit?.method, 'GET');
  assert.equal(hit?.auth, `Bearer ${TOKEN}`, 'token 必须走 Authorization 头');
});

test('GET /api/data/batches 转发到 /data/batches，查询串原样带过去', async () => {
  const reply = await call('/api/data/batches');
  assert.equal(reply.status, 200);
  const hit = seen.at(-1);
  assert.equal(hit?.path, '/data/batches');

  // 查询串必须原样到达上游：task_id / batch / q 的口径只在 Python 侧定义一次。
  await call('/api/data/search?batch=WUHN%2F2026-11-07&q=%E5%B9%B3%E5%9D%87');
  const search = seen.at(-1);
  assert.equal(search?.path, '/data/search?batch=WUHN%2F2026-11-07&q=%E5%B9%B3%E5%9D%87');
});

test('GET /api/suite/field-parity 原样返回 markdown，不包成 JSON', async () => {
  const reply = await call('/api/suite/field-parity');
  assert.equal(reply.status, 200);
  // suite.js 用 response.text() 再交给 parseParityMarkdown；包成 JSON 会让它解析出 0 行。
  assert.match(reply.type, /^text\/markdown/);
  assert.match(reply.text, /^\| 字段 \| 页面 \|/, '开头就是表头');
  assert.doesNotMatch(reply.text, /^\s*\{/, '不能是 JSON');
});

test('GET /api/botd/events 转发到 /board/events，形状是 {events:[…]}', async () => {
  const reply = await call('/api/botd/events?task_id=t-1');
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.text) as {
    ok: boolean;
    events: Array<{ kind: string; ts: string; tool: string; call_id: string }>;
  };
  // fleet.js 的端点表：`{events:[{seq,kind,call_id,tool,ts}]}`。
  assert.ok(Array.isArray(parsed.events), 'events 必须是数组');
  assert.equal(parsed.events[0].kind, 'tool.call');
  assert.equal(parsed.events[0].call_id, 'c-1');
  assert.equal(hitPath(), '/board/events?task_id=t-1');
});

/** 上一条转发到上游的路径（含查询串）。 */
function hitPath(): string {
  return seen.at(-1)?.path ?? '';
}

test('POST /api/botd/intervene 带 JSON body 转发', async () => {
  const reply = await call('/api/botd/intervene', 'POST', {
    kind: 'pause',
    task_id: 't-1',
    prompt: '先停下',
  });
  assert.equal(reply.status, 200);
  const hit = seen.at(-1);
  assert.equal(hit?.method, 'POST');
  assert.equal(hit?.path, '/board/intervene');
  const forwarded = JSON.parse(hit?.body ?? '{}') as Record<string, unknown>;
  assert.equal(forwarded.kind, 'pause');
  assert.equal(forwarded.task_id, 't-1');
  assert.equal(forwarded.prompt, '先停下');
});

test('上游的 4xx 原样透传（不改写成 500）', async () => {
  // 「请求不合法」和「服务坏了」是两件事：前者用户能自己改，后者只能等人修。
  const missingBatch = await call('/api/data/quality');
  assert.equal(missingBatch.status, 400);
  assert.match(missingBatch.text, /缺少 batch 参数/);

  const missingTask = await call('/api/botd/tree');
  assert.equal(missingTask.status, 400);
  assert.match(missingTask.text, /缺少 task_id 参数/);
});

test('方法不在白名单里就是 405，不会打到上游', async () => {
  const before = seen.length;
  const reply = await call('/api/data/batches', 'POST', {});
  assert.equal(reply.status, 405);
  assert.equal(seen.length, before, '被拒的请求不该转发出去');
  assert.match(reply.text, /只接受 GET/);

  const botd = await call('/api/data/batches', 'DELETE');
  assert.equal(botd.status, 405);
});

test('请求体不是 JSON 对象就是 400', async () => {
  const response = await fetch(`http://127.0.0.1:${frontPort}/api/botd/intervene`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '["not", "an", "object"]',
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /JSON 对象/);
});

/* ---------------------------------------------------------------------------------------------
 * 3. 上游不可用 → 503，且下一轮重试
 * ------------------------------------------------------------------------------------------- */

test('agent server 不可用时是 503，不是假 200', async () => {
  const dead = new AgentBridge({ token: TOKEN, nodeUrl: 'http://127.0.0.1:1' });
  const local = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleSurfaceRoute({
      bridge: dead,
      req,
      res,
      url,
      method: (req.method ?? 'GET').toUpperCase(),
    });
  });
  const port = await new Promise<number>((ready) => {
    local.listen(0, '127.0.0.1', () => {
      const address = local.address();
      ready(typeof address === 'object' && address ? address.port : 0);
    });
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/botd/forest`);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /^agent server unavailable: /);
  } finally {
    await new Promise<void>((done) => local.close(() => done()));
  }
});

/* ---------------------------------------------------------------------------------------------
 * 4. 真 server.ts：路由挂载在 `/api/` 兜底之前
 * ------------------------------------------------------------------------------------------- */

/**
 * 一个只会回答新接口的最小 Python 替身。
 *
 * 用 `NAS_PYTHON=node` + `NAS_AGENT_SERVER=<这个 .mjs>` 把它当作 agent server 拉起，
 * 于是整条链路（server.ts → AgentBridge → 子进程 → HTTP）都是真的，只有业务答案是假的。
 * 这样验的是「路由真的挂上了、路径真的重写了」，而不是「Python 的 SQL 算得对」——
 * 后者属于 Python 侧的单测。
 */
const STUB_AGENT = `import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const token = argv[argv.indexOf('--token') + 1];

const BODIES = {
  '/board/forest': { ok: true, tasks: [], pending: [], database: { path: '', exists: false } },
  '/board/pending': { ok: true, pending: [] },
  '/board/tree': { ok: true, root: { task_id: 't-1' }, steps: [], children: [],
                   counts: { steps: 0, done: 0, failed: 0, skipped: 0, pending: 0 } },
  '/data/batches': { ok: true, batches: [{ id: 'WUHN/2026-11-07', station: 'WUHN',
                                           date: '2026-11-07', rows: 4, partitions: 1,
                                           bytes: 512 }], count: 1 },
  '/data/quality': { ok: true, engineDown: false,
                     counts: { rows: 4, missing: 0, jumps: 0, outOfRange: 0,
                               missingRate: 0, jumpsRate: 0, outOfRangeRate: 0 } },
  '/data/search': { ok: true, question: 'q', value: 4, sql: 'SELECT count(*) AS row_count FROM obs',
                    partition: 'station=WUHN/date=2026-11-07/hour=07/part-000.ndjson',
                    rows: 4, engine: 'builtin', elapsedMs: 1.5, missingField: false },
  '/data/eval': { ok: true, results: null,
                  checks: { S1: null, S2: null, S3: null, S4: null, S5: null, S6: null } },
};

const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"unauthorized"}');
    return;
  }
  const path = (req.url || '/').split('?')[0];
  if (path === '/board/events') {
    const body = JSON.stringify({ ok: true, task_id: 't-1',
      events: [{ seq: 1, kind: 'tool.call', call_id: 'c-1', tool: 'x',
                 ts: '2026-11-11T09:30:00.000Z' }] });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (path === '/suite/field-parity') {
    const body = '# parity\\n| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |\\n';
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(body);
    return;
  }
  const payload = BODIES[path];
  if (payload) {
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                         'Content-Length': Buffer.byteLength(body) });
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

interface AppHandle {
  child: ChildProcess;
  base: string;
  stderr: () => string;
  close: () => Promise<void>;
}

function startApp(env: NodeJS.ProcessEnv): Promise<AppHandle> {
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
      if (child.exitCode !== null) { done(); return; }
      child.once('exit', () => done());
      child.kill();
    }),
  }));
}

test('真 server.ts 把三条前缀都挂上了（验收项 1–3）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nas-surface-'));
  const stubScript = join(dir, 'stub-surface.mjs');
  writeFileSync(stubScript, STUB_AGENT, 'utf8');

  const app = await startApp({ NAS_PYTHON: process.execPath, NAS_AGENT_SERVER: stubScript });
  try {
    // 验收项 1：GET /api/botd/forest 200 且有 JSON。
    const forest = await fetch(`${app.base}/api/botd/forest`);
    assert.equal(forest.status, 200, `forest failed\n${app.stderr()}`);
    const forestBody = (await forest.json()) as { ok: boolean; tasks: unknown[] };
    assert.equal(forestBody.ok, true);
    assert.ok(Array.isArray(forestBody.tasks));

    // 验收项 2：GET /api/data/batches 200。
    const batches = await fetch(`${app.base}/api/data/batches`);
    assert.equal(batches.status, 200);
    const batchBody = (await batches.json()) as { ok: boolean; batches: Array<{ id: string }> };
    assert.equal(batchBody.ok, true);
    assert.equal(batchBody.batches[0].id, 'WUHN/2026-11-07');

    // 验收项 3：GET /api/suite/field-parity 200 且是 markdown。
    const parity = await fetch(`${app.base}/api/suite/field-parity`);
    assert.equal(parity.status, 200);
    assert.match(parity.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.match(await parity.text(), /\| 字段 \| 页面 \|/);

    // 其余几条同批验一遍，形状各自钉住。
    const events = await fetch(`${app.base}/api/botd/events?task_id=t-1`);
    assert.equal(events.status, 200);
    const eventBody = (await events.json()) as { events: Array<{ kind: string }> };
    assert.ok(Array.isArray(eventBody.events), 'events 必须是数组');
    assert.equal(eventBody.events[0].kind, 'tool.call');

    const tree = await fetch(`${app.base}/api/botd/tree?task_id=t-1`);
    assert.equal(tree.status, 200);
    const treeBody = (await tree.json()) as { root: { task_id: string }; counts: { steps: number } };
    assert.equal(treeBody.root.task_id, 't-1');
    assert.equal(treeBody.counts.steps, 0);

    for (const path of [
      '/api/botd/pending',
      '/api/data/quality?batch=WUHN/2026-11-07',
      '/api/data/search?batch=WUHN/2026-11-07&q=rows',
      '/api/data/eval?batch=WUHN/2026-11-07',
    ]) {
      const response = await fetch(`${app.base}${path}`);
      assert.equal(response.status, 200, `${path} 应 200，实际 ${response.status}`);
      const body = (await response.json()) as { ok: boolean };
      assert.equal(body.ok, true, `${path} 的 ok 应为 true`);
    }

    // 清单：`/api/health.endpoints` 必须列出新路由（验收项 4 的一半）。
    const health = await fetch(`${app.base}/api/health`);
    const healthBody = (await health.json()) as { endpoints: string[] };
    for (const path of SURFACE_ENDPOINTS) {
      assert.ok(healthBody.endpoints.includes(path), `${path} 应在 /api/health.endpoints 里`);
    }

    // 既有接口一个字节都不受影响：`/api/agent/*` 仍是自己的 404，其余 API 仍走兜底。
    const unknownAgent = await fetch(`${app.base}/api/agent/does-not-exist`);
    assert.equal(unknownAgent.status, 404);
    const unknownApi = await fetch(`${app.base}/api/does-not-exist`);
    assert.equal(unknownApi.status, 404);
  } finally {
    await app.close();
  }
});

test('缺 agent server 时三个前缀都是 503（不假装 200）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nas-surface-'));
  const stubScript = join(dir, 'stub-surface.mjs');
  writeFileSync(stubScript, STUB_AGENT, 'utf8');

  const app = await startApp({
    NAS_PYTHON: join(dir, 'no-such-python.exe'),
    NAS_AGENT_SERVER: stubScript,
  });
  try {
    for (const path of ['/api/botd/forest', '/api/data/batches', '/api/suite/field-parity']) {
      const response = await fetch(`${app.base}${path}`);
      assert.equal(response.status, 503, `${path} 应为 503`);
      const body = (await response.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /^agent server unavailable: /);
    }
  } finally {
    await app.close();
  }
});
