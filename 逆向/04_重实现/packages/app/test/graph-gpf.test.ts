/**
 * D5 — Flags in the project's `.gpf` (the panel's half) + the `localStorage` fallback.
 *
 * The original writes the markers into the project file
 * (`FlagsInitialState: {allFlags, isFlagsPanelOpen}`, `index-B86bHcCD.js` @16246801). This build's
 * panel (`packages/app/src/web/panels/graph.js`) can only reach the disk through the server, so the
 * two halves are:
 *
 *   `parseGpfFlags` / `mergeGpfFlags`   pure functions over the **`.gpf` text**
 *   `createFlagStore({storage, api})`   `localStorage` always, plus `GET/POST /graph/flags` for a
 *                                       project whose `.gpf` owns the flags
 *
 * What is pinned:
 *
 *  1. the browser copy and the Node copy (`packages/graph/src/export-projects.ts`) agree **byte for
 *     byte** on the shipped `clean.gpf` — one rule, two runtimes;
 *  2. a real temp project: copy `clean.gpf` → write the panel's `FlagsInitialState` → "reopen" reads
 *     it back through the store, and every other key of the file is unchanged;
 *  3. no `.gpf` (or no route, or a throwing route): the store is exactly the old `localStorage`
 *     behaviour — per-project buckets, bad JSON, no storage at all;
 *  4. a broken `.gpf` never throws and never gets written.
 *
 *   node --test --test-force-exit "packages/app/test/graph-gpf.test.ts"
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FLAG_GPF_ROUTE,
  FLAG_STORAGE_PREFIX,
  createFlagStore,
  emptyFlagState,
  flagStorageKey,
  loadFlagState,
  mergeGpfFlags,
  parseGpfFlags,
  restoreFlagState,
  saveFlagState,
  serializeFlagState,
} from '../src/web/panels/graph.js';
import {
  mergeGpfFlags as mergeGpfFlagsNode,
  readProjectFlags,
  resolveExportProject,
  writeProjectFlags,
  type ExportProject,
} from '../../graph/src/export-projects.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** `packages/app/test` → `逆向/00_来源/samples`. */
const SAMPLES = resolve(here, '..', '..', '..', '..', '00_来源', 'samples');
const CLEAN_GPF = resolve(SAMPLES, 'graph', 'project', 'clean.gpf');

/* ---------------- helpers ---------------- */

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

function makeProject(root: string, key: string, gpf?: string): ExportProject {
  const dir = join(root, key);
  mkdirSync(join(dir, 'csv'), { recursive: true });
  writeFileSync(
    join(dir, 'csv', 'Height.csv'),
    '#Project Name:          clean\r\ntimestamp (GPS week sec),Height\r\n2442  463097.350,1.000000\r\n',
    'utf8',
  );
  if (gpf !== undefined) writeFileSync(join(dir, `${key}.gpf`), gpf, 'utf8');
  const { project } = resolveExportProject(root, key);
  assert.ok(project);
  return project;
}

function flagPayload(count: number, extra: Record<string, unknown> = {}) {
  let state = emptyFlagState();
  state = {
    ...state,
    allFlags: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      timeCaptured: 1477384697350 + i * 1000,
      timeBase: 'gps',
      description: `note ${i + 1}`,
      color: '#F95B61',
      latitude: 45.1 + i,
      longitude: -75.2 - i,
      height: 80 + i,
      state: 'activeFlag',
    })),
    newFlagId: count + 1,
    ...extra,
  };
  return state;
}

/**
 * A server stand-in: `/health` first (that is how the panel discovers the route without eating a
 * 404), then whatever the test wants `/graph/flags` to answer.
 */
function apiStub(options: {
  endpoints?: string[];
  get?: (path: string, params?: unknown) => unknown | Promise<unknown>;
  post?: (path: string, body?: unknown) => unknown | Promise<unknown>;
} = {}) {
  const calls: Array<{ method: string; path: string; params?: unknown; body?: unknown }> = [];
  const endpoints = options.endpoints ?? ['/api/graph/flags'];
  const api = {
    get: (path: string, params?: unknown) => {
      calls.push({ method: 'get', path, params });
      if (path === '/health') return Promise.resolve({ ok: true, endpoints });
      return Promise.resolve(options.get ? options.get(path, params) : { ok: true, gpf: false, flags: null });
    },
    post: (path: string, body?: unknown) => {
      calls.push({ method: 'post', path, body });
      return Promise.resolve(options.post ? options.post(path, body) : { ok: true });
    },
  };
  return { api, calls };
}

/** The empty `{...}` of a `.gpf` with the flags block taken out, formatted as the file was. */
function withoutFlags(text: string): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.FlagsInitialState;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^\{\r?\n([ \t]+)"/.exec(body)?.[1] ?? '  ';
  let out = JSON.stringify(parsed, null, indent);
  if (newline === '\r\n') out = out.replace(/\n/g, '\r\n');
  return bom + out + (/\r?\n$/.test(body) ? newline : '');
}

/* ---------------- 1. one rule, two runtimes ---------------- */

test('浏览器侧与 Node 侧的 mergeGpfFlags 在 clean.gpf 上逐字节一致', () => {
  const original = readFileSync(CLEAN_GPF, 'utf8');
  const state = flagPayload(3, { isFlagsPanelOpen: true });
  const browser = mergeGpfFlags(original, state);
  const node = mergeGpfFlagsNode(original, { allFlags: state.allFlags, isFlagsPanelOpen: true });

  assert.equal(typeof browser, 'string');
  assert.equal(browser, node, '同一份 .gpf 文本，两边必须给出同一串字节');
  assert.equal(withoutFlags(browser!), original, '其它键（含 checksum/PageRoute/PersistenceInfo）逐字不变');
  assert.deepEqual(Object.keys(JSON.parse(browser!)), [
    ...Object.keys(JSON.parse(original)),
    'FlagsInitialState',
  ], '新键追加在末尾，原有顺序不动');
});

test('浏览器侧 mergeGpfFlags 保留缩进/换行/BOM/结尾换行，坏文本返回 null', () => {
  const base = readFileSync(CLEAN_GPF, 'utf8');
  const variants = [
    { name: '样本（LF，无结尾换行）', text: base, indent: '  ' },
    { name: '带结尾换行', text: base + '\n', indent: '  ' },
    { name: 'CRLF', text: base.replace(/\n/g, '\r\n'), indent: '  ' },
    { name: 'BOM + CRLF', text: '\uFEFF' + base.replace(/\n/g, '\r\n'), indent: '  ' },
    { name: '四空格', text: JSON.stringify(JSON.parse(base), null, 4), indent: '    ' },
  ];
  for (const variant of variants) {
    const merged = mergeGpfFlags(variant.text, flagPayload(1))!;
    assert.ok(merged, variant.name);
    assert.equal(withoutFlags(merged), variant.text, `${variant.name}：其它键不变`);
    assert.equal(merged.split(/\r?\n/)[1].startsWith(`${variant.indent}"`), true, `${variant.name}：缩进沿用`);
    assert.equal(merged.includes('\r\n'), variant.text.includes('\r\n'), `${variant.name}：换行沿用`);
    assert.equal(merged.startsWith('\uFEFF'), variant.text.startsWith('\uFEFF'), `${variant.name}：BOM 沿用`);
    assert.equal(/\r?\n$/.test(merged), /\r?\n$/.test(variant.text), `${variant.name}：结尾一致`);
    // 与 Node 侧对同一变体也一致（不只样本那一份）。
    assert.equal(merged, mergeGpfFlagsNode(variant.text, { allFlags: flagPayload(1).allFlags, isFlagsPanelOpen: false }));
  }

  assert.equal(mergeGpfFlags('not json', flagPayload(1)), null);
  assert.equal(mergeGpfFlags('[]', flagPayload(1)), null);
  assert.equal(mergeGpfFlags('null', flagPayload(1)), null);
  assert.equal(mergeGpfFlags(undefined as unknown as string, flagPayload(1)), null);
});

test('parseGpfFlags：没有块 = present:false，坏的 = ok:false，好的 = 原样读回', () => {
  const empty = parseGpfFlags(readFileSync(CLEAN_GPF, 'utf8'));
  assert.equal(empty.ok, true);
  assert.equal(empty.present, false, 'clean.gpf 还没写过 flags');
  assert.deepEqual(empty.state, emptyFlagState());

  assert.equal(parseGpfFlags('{oops').ok, false);
  assert.equal(parseGpfFlags('[]').ok, false);
  assert.equal(parseGpfFlags(null as unknown as string).ok, false);
  assert.equal(parseGpfFlags(JSON.stringify({ FlagsInitialState: { allFlags: 'x' } })).ok, false);

  const state = flagPayload(2, { isFlagsPanelOpen: true });
  const text = mergeGpfFlags(readFileSync(CLEAN_GPF, 'utf8'), state)!;
  const parsed = parseGpfFlags(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.state.allFlags, state.allFlags);
  assert.equal(parsed.state.isFlagsPanelOpen, true);
  assert.equal(parsed.state.newFlagId, 3, 'newFlagId = max(id)+1，与 setStoreDefaults 一致');
});

/* ---------------- 2. a real project: write, reopen, restore ---------------- */

test('复制 clean.gpf 的临时工程：写 flags 后"重开"能恢复，其他键逐字不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-app-'));
  try {
    const original = readFileSync(CLEAN_GPF, 'utf8');
    const project = makeProject(root, 'clean', original);
    const gpfPath = join(project.directory, 'clean.gpf');

    // The panel's own state → the bytes a server would put in `FlagsInitialState`.
    const state = flagPayload(3, { isFlagsPanelOpen: true });
    const written = writeProjectFlags(project, serializeFlagState(state) as unknown as {
      allFlags: unknown[]; isFlagsPanelOpen: boolean;
    });
    assert.equal(written.ok, true);
    assert.equal(withoutFlags(readFileSync(gpfPath, 'utf8')), original, '其它键逐字不变');

    // "Reopen": the server hands the file's flags to the panel through `/graph/flags`.
    const storage = memoryStorage();
    const { api, calls } = apiStub({
      get: (path) => {
        assert.equal(path, FLAG_GPF_ROUTE);
        const read = readProjectFlags(project);
        assert.ok(read);
        return { ok: true, gpf: read.flags !== null, path: read.path, flags: read.flags };
      },
    });

    const store = createFlagStore({ storage, api });
    const hydrated = await store.hydrate('clean');
    assert.ok(hydrated);
    assert.equal(store.isGpfBacked('clean'), true);
    assert.deepEqual(hydrated!.allFlags, state.allFlags);
    assert.equal(hydrated!.isFlagsPanelOpen, true);
    assert.deepEqual(calls[0], { method: 'get', path: '/health', params: undefined }, '先问能力，再问数据');
    assert.deepEqual(calls[1], { method: 'get', path: FLAG_GPF_ROUTE, params: { project: 'clean' } });

    // …and a later save goes to the `.gpf` route as well.
    store.save('clean', { ...hydrated!, isFlagsPanelOpen: false });
    const post = calls.find((call) => call.method === 'post');
    assert.ok(post, '有 .gpf 的工程，保存会 POST 到 /graph/flags');
    assert.deepEqual(post!.params, undefined);
    assert.deepEqual(post!.body, {
      project: 'clean',
      flags: { allFlags: state.allFlags, isFlagsPanelOpen: false },
    });
    // localStorage 里仍有一份当次会话的镜像（首屏不等请求）。
    assert.equal(loadFlagState(storage, 'clean').allFlags.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('工程没有 .gpf：第一次保存问一次"要不要建"，服务端说不行就只走 localStorage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-none-'));
  try {
    const project = makeProject(root, 'clean'); // 没有 .gpf
    assert.equal(readProjectFlags(project), null);

    const storage = memoryStorage();
    const { api, calls } = apiStub();

    const store = createFlagStore({ storage, api });
    assert.equal(await store.hydrate('clean'), null, '没有 .gpf 就是没有可恢复的状态');
    assert.equal(store.isGpfBacked('clean'), false);

    const b1 = flagPayload(2);
    const clean = flagPayload(5);
    store.save('b1', b1);
    store.save('clean', clean);

    assert.equal(store.load('b1').allFlags.length, 2, '切工程不串');
    assert.equal(store.load('clean').allFlags.length, 5);
    assert.equal(store.load('other').allFlags.length, 0);
    assert.equal(storage.dump()[`${FLAG_STORAGE_PREFIX}b1`].includes('"allFlags"'), true);

    // 每个工程各问一次"能不能给这个工程建一个 .gpf"（B/E1），服务端答 `gpf` 非真 → 保持 localStorage。
    const posts = calls.filter((call) => call.method === 'post');
    assert.deepEqual(posts.map((call) => (call.body as { project: string }).project).sort(), ['b1', 'clean']);
    assert.deepEqual(posts[0].body, { project: 'b1', flags: serializeFlagState(b1) });
    assert.equal(posts[0].path, FLAG_GPF_ROUTE);

    // 一次 /health + 每个工程一次 GET，创建失败不重试。
    const beforeSaves = calls.length;
    store.save('b1', b1);
    store.save('clean', clean);
    assert.equal(calls.length, beforeSaves, '创建被拒绝后不再重复 POST');

    // 负结果只探测一次：再 hydrate 不再发请求。
    const before = calls.length;
    assert.equal(await store.hydrate('clean'), null);
    assert.equal(calls.length, before, '没有 .gpf 的工程不再重复探测');
    assert.equal(store.isGpfBacked('clean'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空标记的保存不消耗"建一次 .gpf"的机会：面板先存 isFlagsPanelOpen 也不会挡住创建（B/E1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-create-empty-first-'));
  try {
    const project = makeProject(root, 'clean');
    const posts: Array<{ project: string; flags: { allFlags: unknown[] } }> = [];
    const api = {
      get: (path: string, params?: any) => {
        if (path === '/health') return Promise.resolve({ ok: true, endpoints: ['/api/graph/flags'] });
        const read = readProjectFlags(project);
        return Promise.resolve(read ? { ok: true, gpf: true, flags: read.flags } : { ok: true, gpf: false });
      },
      post: (_path: string, body: any) => {
        posts.push(body);
        const write = writeProjectFlags(project, body.flags, { create: true, resign: true });
        return Promise.resolve({ ok: write.ok, gpf: write.reason !== 'no-gpf' });
      },
    };
    const store = createFlagStore({ storage: memoryStorage(), api });
    assert.equal(await store.hydrate('clean'), null);

    // 面板打开标记面板时就会存一次"面板开着"，这时还没有任何标记。
    store.save('clean', { ...emptyFlagState(), isFlagsPanelOpen: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posts.length, 0, '空列表不向服务端要文件');
    assert.equal(existsSync(join(project.directory, 'clean.gpf')), false);
    assert.equal(store.isGpfBacked('clean'), false);

    // 真正的第一个标记：这一次才创建。
    store.save('clean', flagPayload(1));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].flags.allFlags.length, 1);
    assert.equal(existsSync(join(project.directory, 'clean.gpf')), true);
    assert.equal(store.isGpfBacked('clean'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无 .gpf 的工程：第一次保存真的建出 .gpf，刷新后从文件恢复（B/E1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-create-app-'));
  try {
    const project = makeProject(root, 'clean');
    const gpfPath = join(project.directory, 'clean.gpf');
    assert.equal(existsSync(gpfPath), false);

    /** The route's own body (`writeProjectFlags(..., {create: true, resign: true})`). */
    const server = () => {
      const calls: Array<{ method: string; body?: any }> = [];
      const api = {
        get: (path: string, params?: unknown) => {
          calls.push({ method: 'get' });
          if (path === '/health') return Promise.resolve({ ok: true, endpoints: ['/api/graph/flags'] });
          const read = readProjectFlags(project);
          return Promise.resolve(read
            ? { ok: true, gpf: true, flags: read.flags, path: read.path }
            : { ok: true, gpf: false });
        },
        post: (_path: string, body: any) => {
          calls.push({ method: 'post', body });
          const write = writeProjectFlags(project, body.flags, { create: true, resign: true });
          return Promise.resolve({
            ok: write.ok,
            gpf: write.reason !== 'no-gpf' && write.reason !== 'no-data',
            ...(write.created ? { created: true } : {}),
            ...(write.path ? { path: write.path } : {}),
            ...(write.reason ? { reason: write.reason } : {}),
          });
        },
      };
      return { api, calls };
    };

    // 第一个会话：hydrate 说没有 .gpf，用户加了一个标记 → 保存时把 .gpf 建出来。
    const storage = memoryStorage();
    const first = server();
    const store = createFlagStore({ storage, api: first.api });
    assert.equal(await store.hydrate('clean'), null);
    const state = flagPayload(1, { isFlagsPanelOpen: true });
    store.save('clean', state);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(existsSync(gpfPath), true, '首次保存生成了 .gpf');
    assert.equal(store.isGpfBacked('clean'), true, '服务端答 gpf:true 之后这个工程由 .gpf 管辖');
    const created = JSON.parse(readFileSync(gpfPath, 'utf8'));
    assert.deepEqual(created.FlagsInitialState, { allFlags: state.allFlags, isFlagsPanelOpen: true });
    assert.equal(first.calls.filter((call) => call.method === 'post').length, 1);

    // 第二个会话（刷新）：首屏还是 localStorage 镜像，hydrate 之后以 .gpf 为准。
    const second = server();
    const reloaded = createFlagStore({ storage, api: second.api });
    assert.equal(reloaded.load('clean').allFlags.length, 1, '首屏不等请求');
    const hydrated = await reloaded.hydrate('clean');
    assert.ok(hydrated);
    assert.equal(reloaded.isGpfBacked('clean'), true);
    assert.deepEqual(hydrated!.allFlags, state.allFlags);

    // 之后的保存不再问"要不要建"，直接写文件；再读仍是新状态。
    const next = flagPayload(2, { isFlagsPanelOpen: false });
    reloaded.save('clean', next);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second.calls.filter((call) => call.method === 'post').length, 1);
    assert.deepEqual(readProjectFlags(project)?.flags, { allFlags: next.allFlags, isFlagsPanelOpen: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('另一个工程没有 .gpf：新建的 .gpf 只属于它自己，切工程不串（B/E1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-create-two-'));
  try {
    const clean = makeProject(root, 'clean');
    const b1 = makeProject(root, 'b1');
    const api = {
      get: (path: string, params?: any) => {
        if (path === '/health') return Promise.resolve({ ok: true, endpoints: ['/api/graph/flags'] });
        const project = params?.project === 'b1' ? b1 : clean;
        const read = readProjectFlags(project);
        return Promise.resolve(read ? { ok: true, gpf: true, flags: read.flags } : { ok: true, gpf: false });
      },
      post: (_path: string, body: any) => {
        const project = body.project === 'b1' ? b1 : clean;
        const write = writeProjectFlags(project, body.flags, { create: true, resign: true });
        return Promise.resolve({ ok: write.ok, gpf: write.ok, ...(write.created ? { created: true } : {}) });
      },
    };
    const storage = memoryStorage();
    const store = createFlagStore({ storage, api });
    await store.hydrate('clean');
    await store.hydrate('b1');

    store.save('clean', flagPayload(2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(join(clean.directory, 'clean.gpf')), true);
    assert.equal(existsSync(join(b1.directory, 'b1.gpf')), false, '没动过标记的工程不会被建文件');

    store.save('b1', flagPayload(3));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(join(b1.directory, 'b1.gpf')), true);
    assert.equal(readProjectFlags(clean)?.flags?.allFlags.length, 2);
    assert.equal(readProjectFlags(b1)?.flags?.allFlags.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('服务端没有 /api/graph/flags 时，一个请求都不发（404 会变成 console error）', async () => {
  const storage = memoryStorage();
  const { api, calls } = apiStub({ endpoints: ['/api/health', '/api/graph/projects'] });
  const store = createFlagStore({ storage, api });
  assert.equal(await store.hydrate('clean'), null);
  assert.deepEqual(calls.map((call) => call.path), ['/health'], '只问了 /health，没有碰不存在的路由');
  assert.equal(store.isGpfBacked('clean'), false);
  // 能力也是一次性的：第二个工程不再问 /health。
  assert.equal(await store.hydrate('b1'), null);
  assert.equal(calls.length, 1);
  // 保存照旧只写 localStorage。
  const state = flagPayload(2);
  assert.equal(store.save('clean', state), true);
  assert.equal(store.load('clean').allFlags.length, 2);
  assert.equal(calls.filter((call) => call.method === 'post').length, 0);
});

test('没有 api / api 抛错：仍是 localStorage，不抛、不丢', async () => {
  const storage = memoryStorage();
  const plain = createFlagStore({ storage });
  const state = flagPayload(2);
  assert.equal(plain.save('clean', state), true);
  assert.equal(plain.load('clean').allFlags.length, 2);
  assert.equal(await plain.hydrate('clean'), null);
  assert.equal(plain.isGpfBacked('clean'), false);

  const throwing = createFlagStore({
    storage,
    api: {
      get: () => { throw new Error('offline'); },
      post: () => { throw new Error('offline'); },
    },
  });
  assert.equal(await throwing.hydrate('clean'), null);
  assert.equal(throwing.isGpfBacked('clean'), false);
  // 保存不因为 .gpf 写不进去而失败或抛错。
  assert.equal(throwing.save('clean', flagPayload(3)), true);
  assert.equal(throwing.load('clean').allFlags.length, 3);

  // 异步 reject 也只当"这个工程没有 .gpf"。
  const rejecting = createFlagStore({
    storage,
    api: { get: () => Promise.reject(new Error('404')), post: () => Promise.reject(new Error('404')) },
  });
  assert.equal(await rejecting.hydrate('clean'), null);
  rejecting.save('clean', state);
  assert.equal(rejecting.load('clean').allFlags.length, 2);
});

test('坏 .gpf：读不到就退回 localStorage，且绝不把坏文件当空文件还原', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-bad-'));
  try {
    const broken = makeProject(root, 'clean', '{ nope');
    const read = readProjectFlags(broken);
    assert.equal(read?.flags, null);
    assert.match(String(read?.error), /不是合法的 \.gpf JSON/);

    const storage = memoryStorage({
      [flagStorageKey('clean')]: JSON.stringify(serializeFlagState(flagPayload(4))),
    });
    const { api } = apiStub();
    const store = createFlagStore({ storage, api });

    // 首屏就是 localStorage 里的 4 个，坏工程文件不能把它们清掉。
    assert.equal(store.load('clean').allFlags.length, 4);
    assert.equal(await store.hydrate('clean'), null);
    assert.equal(store.load('clean').allFlags.length, 4);
    assert.equal(readFileSync(join(broken.directory, 'clean.gpf'), 'utf8'), '{ nope', '坏文件没被改写');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('服务端说 .gpf 存在但还没有 flags：恢复成空而不是回退 localStorage', async () => {
  const storage = memoryStorage({
    [flagStorageKey('clean')]: JSON.stringify(serializeFlagState(flagPayload(2))),
  });
  const { api } = apiStub({ get: () => ({ ok: true, gpf: true, flags: null }) });
  const store = createFlagStore({ storage, api });
  const hydrated = await store.hydrate('clean');
  assert.ok(hydrated);
  assert.deepEqual(hydrated, emptyFlagState(), '.gpf 是权威：里面没有标记就是没有');
  assert.equal(store.isGpfBacked('clean'), true);

  // 之后的保存应当写 .gpf，而不是只留在 localStorage。
  const posts: unknown[] = [];
  const { api: withPostApi } = apiStub({
    get: () => ({ ok: true, gpf: true, flags: null }),
    post: (_path, body) => {
      posts.push(body);
      return { ok: true };
    },
  });
  const withPost = createFlagStore({ storage, api: withPostApi });
  await withPost.hydrate('clean');
  withPost.save('clean', flagPayload(1));
  assert.equal(posts.length, 1);
});

test('saveFlagState / restoreFlagState 仍然只认 FlagsInitialState 的两个字段', () => {
  const storage = memoryStorage();
  const state = flagPayload(1, { editFlagId: 1 });
  assert.equal(saveFlagState(storage, 'clean', state), true);
  const stored = JSON.parse(storage.dump()[flagStorageKey('clean')]);
  assert.deepEqual(Object.keys(stored).sort(), ['allFlags', 'isFlagsPanelOpen']);
  assert.equal(stored.isFlagsPanelOpen, false);
  assert.equal(restoreFlagState(stored).newFlagId, 2);
});

/* ---------------- 4. the real HTTP route (B/E1) ----------------
 *
 * The unit tests above use an API stub. This block runs `packages/app/src/server.ts` for real and
 * speaks to `/api/graph/flags`, because "the first save creates the `.gpf`" is a property of the
 * route, not of the store:
 *
 *   1. `GET` on a project with no `.gpf` → `{ok:true, gpf:false}`;
 *   2. `POST` one marker → `{ok:true, gpf:true, created:true}` and the file is on disk, signed;
 *   3. `GET` again → the same markers, `gpf:true` (this is the "refresh restores it" path);
 *   4. a second `POST` of the same state → identical bytes, no `created`;
 *   5. clearing the list on an existing file still writes the file (it is not deleted).
 *
 * `heading` is used because it is the smallest shipped project (3 CSVs); the file it creates is
 * removed again in `after()` so the sample tree is left exactly as it was.
 */

const headingGpf = resolve(SAMPLES, 'graph', 'export', 'heading', 'heading.gpf');
const headingGpfExisted = existsSync(headingGpf);
const serverPath = resolve(here, '..', 'src', 'server.ts');
let serverChild: ChildProcessWithoutNullStreams | null = null;
let apiBase = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((ready, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('server did not start in 20 s')), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        ready(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* drain */ });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
}

before(async () => {
  serverChild = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: resolve(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiBase = `http://127.0.0.1:${await waitForReady(serverChild)}`;
});

after(async () => {
  if (serverChild && !serverChild.killed) {
    const closed = new Promise((done) => serverChild!.once('close', done));
    serverChild.kill('SIGTERM');
    const timer = setTimeout(() => serverChild?.kill('SIGKILL'), 2000);
    timer.unref();
    await closed;
    clearTimeout(timer);
    await new Promise((done) => setTimeout(done, 150));
  }
  if (!headingGpfExisted) rmSync(headingGpf, { force: true });
});

async function callJson(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(apiBase + path, body === undefined
    ? { headers: { connection: 'close' } }
    : {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
    });
  return { status: response.status, body: await response.json() };
}

test('POST /api/graph/flags：no-gpf 的工程会生成 .gpf 并回 gpf:true，GET 读得回来', async () => {
  const flags = serializeFlagState({
    ...flagPayload(1, { isFlagsPanelOpen: true }),
  });

  const before = await callJson('/api/graph/flags?project=heading');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, { ok: true, gpf: false }, '起点没有 .gpf');
  assert.equal(existsSync(headingGpf), false);

  const post = await callJson('/api/graph/flags', { project: 'heading', flags });
  assert.equal(post.status, 200);
  assert.equal(post.body.ok, true);
  assert.equal(post.body.gpf, true, '创建成功 → 前端从此以 .gpf 为准');
  assert.equal(post.body.created, true);
  assert.equal(post.body.path, headingGpf, '<dir>/<basename(dir)>.gpf');
  assert.equal(existsSync(headingGpf), true);

  const created = JSON.parse(readFileSync(headingGpf, 'utf8')) as Record<string, any>;
  assert.deepEqual(created.FlagsInitialState, flags);
  assert.equal(created.PageRoute, '/process');
  assert.equal(created.projectDirectory, resolve(SAMPLES, 'graph', 'export', 'heading'));
  assert.equal(created.filename, 'heading.sbf', 'CSV 的 #Data File Name:');
  const summary = created.updatedProjSummary;
  assert.equal(summary.DataInfo.Duration, 5001, 'heading.sbf 的窗口：470000.000 → 470005.001');
  assert.deepEqual(summary.Messages, { HEADING2: 3, INSPVAX: 6 }, 'project.json 里的解码计数');
  assert.deepEqual(Object.keys(summary.PlotSummary), ['Heading_Attitude']);
  // checksum：verifyChecksum 的算法，独立复算一遍。
  const { checksum, ...rest } = created;
  assert.equal(
    checksum,
    createHash('sha256').update(JSON.stringify(rest) + 'GAA170P4468F1218', 'utf8').digest('hex'),
  );

  const read = await callJson('/api/graph/flags?project=heading');
  assert.equal(read.body.gpf, true);
  assert.deepEqual(read.body.flags, flags, '刷新后读回来的就是刚存的那个标记');

  // 同一份状态再 POST 一次：不再 created，字节不变（不会每次重排/长大）。
  const text = readFileSync(headingGpf, 'utf8');
  const again = await callJson('/api/graph/flags', { project: 'heading', flags });
  assert.equal(again.body.ok, true);
  assert.equal(again.body.gpf, true);
  assert.equal(again.body.created, undefined);
  assert.equal(readFileSync(headingGpf, 'utf8'), text);

  // 清空标记：写进文件的是空列表，文件不会被删（Graph 也是写空数组）。
  const cleared = await callJson('/api/graph/flags', {
    project: 'heading',
    flags: { allFlags: [], isFlagsPanelOpen: false },
  });
  assert.equal(cleared.body.gpf, true);
  const headingProject = resolveExportProject(resolve(SAMPLES, 'graph', 'export'), 'heading').project!;
  assert.deepEqual(readProjectFlags(headingProject)?.flags, { allFlags: [], isFlagsPanelOpen: false });
  assert.equal(existsSync(headingGpf), true);

  // 空列表 + 从未有过 .gpf 的工程：不建文件，路由说 gpf:false（前端继续 localStorage）。
  const csv = await callJson('/api/graph/flags', {
    project: 'csv',
    flags: { allFlags: [], isFlagsPanelOpen: false },
  });
  assert.equal(csv.body.gpf, false);
  assert.equal(csv.body.reason, 'no-gpf');
  assert.equal(existsSync(resolve(SAMPLES, 'graph', 'export', 'csv', 'csv.gpf')), false,
    '没有标记可存时不在装载样本上生成工程文件');
});

test('POST /api/graph/flags 拒绝不存在的工程（404），不会顺手建目录', async () => {
  const post = await callJson('/api/graph/flags', { project: 'nope', flags: { allFlags: [], isFlagsPanelOpen: false } });
  assert.equal(post.status, 404);
  assert.match(String(post.body.error), /没有工程/);
});

