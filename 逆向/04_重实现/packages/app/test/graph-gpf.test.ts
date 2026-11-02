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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('工程没有 .gpf：只走 localStorage，行为与改动前一致', async () => {
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
    // 一次 /health + 一次 /graph/flags；保存不会往一个没有 .gpf 的工程 POST。
    assert.deepEqual(calls.filter((call) => call.method === 'post'), []);
    assert.equal(calls.filter((call) => call.path === FLAG_GPF_ROUTE).length, 1, '每个工程只探一次');

    // 负结果只探测一次：再 hydrate 不再发请求。
    const before = calls.length;
    assert.equal(await store.hydrate('clean'), null);
    assert.equal(calls.length, before, '没有 .gpf 的工程不再重复探测');
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
