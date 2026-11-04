/**
 * 四个视角路由的自测（W2）。
 *
 *   node --test packages/app/test/views.test.ts
 *
 * 两段：
 *   1. 纯数据：`web/views/routes.ts` 的四条路由、iframe 源、layout.html 与占位。
 *   2. 端到端：真起 server.ts（`--port 0`），四个路径 200、HTML 带对应的 `data-view`，
 *      同时确认 `/`、`/api/health`、`/views/views.css` 仍然可用（additive 的底线）。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAYOUT_FILE,
  LAYOUT_TOKENS,
  VIEWS,
  layoutValues,
  renderLayout,
  viewForPath,
  type ViewId,
} from '../src/web/views/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..', '..', '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const layoutPath = join(viewsDir, LAYOUT_FILE);
const serverPath = join(appDir, 'src', 'server.ts');

/** 每个视角必须挂到的现有页面（改这里就等于改合同）。 */
const EXPECTED_FRAMES: Record<ViewId, string> = {
  chat: '/',
  fleet: '/geo/luciad-stage.html',
  data: '/config/events',
  suite: '/?mode=pro',
};

/* ---------------------------------------------------------------------------------------------
 * 1. 路由表与 layout
 * ------------------------------------------------------------------------------------------- */

test('四个视角：/chat /fleet /data /suite，id 与路径一一对应', () => {
  assert.equal(VIEWS.length, 4);
  assert.deepEqual(VIEWS.map((view) => view.path), ['/chat', '/fleet', '/data', '/suite']);
  assert.deepEqual(VIEWS.map((view) => view.id), ['chat', 'fleet', 'data', 'suite']);
  assert.equal(new Set(VIEWS.map((view) => view.path)).size, 4, '路径不重复');
  assert.equal(new Set(VIEWS.map((view) => view.id)).size, 4, 'id 不重复');

  for (const view of VIEWS) {
    assert.equal(viewForPath(view.path), view, `${view.path} 能解析到自己`);
    assert.equal(viewForPath(`${view.path}/`), view, `${view.path}/ 也认`);
    assert.ok(view.label.length > 0, `${view.path} 有导航名`);
    assert.ok(view.title.length > 0, `${view.path} 有标题`);
  }
});

test('每个视角的默认 iframe 源是现有页面', () => {
  for (const view of VIEWS) {
    assert.equal(view.frame, EXPECTED_FRAMES[view.id], `${view.path} → ${view.frame}`);
    assert.ok(view.frame.startsWith('/'), `${view.path} 的 iframe 是同源绝对路径`);
  }
  // 专业面板必须落到 pro 模式；对话必须落回 agent。
  assert.equal(VIEWS.find((view) => view.id === 'suite')?.mode, 'pro');
  assert.equal(VIEWS.find((view) => view.id === 'chat')?.mode, 'agent');
});

test('不是视角路由的路径不匹配（/ 与 API 保持原样）', () => {
  for (const path of ['/', '/index.html', '/api/health', '/chatty', '/view/chat', '/views/views.css']) {
    assert.equal(viewForPath(path), undefined, `${path} 不应命中视角路由`);
  }
});

test('layout.html 存在，四个视角共用且占位齐全', () => {
  assert.ok(existsSync(layoutPath), `缺少外壳页：${layoutPath}`);
  const template = readFileSync(layoutPath, 'utf8');

  for (const token of LAYOUT_TOKENS) {
    assert.ok(template.includes(`{{${token}}}`), `layout 缺少占位 {{${token}}}`);
  }
  // 右栏三段检查器的锚点。
  for (const panel of ['device', 'evidence', 'logs']) {
    assert.match(template, new RegExp(`data-panel="${panel}"`), `检查器缺少 ${panel} 段`);
  }
  // 左导航四条链接。
  for (const view of VIEWS) {
    assert.match(template, new RegExp(`data-view-link="${view.id}"`), `左导航缺少 ${view.id}`);
  }
  // 同一份 layout 渲染四次，只换 data-view / iframe 源。
  for (const view of VIEWS) {
    const html = renderLayout(template, view);
    assert.match(html, new RegExp(`data-view="${view.id}"`), `${view.path} 的 data-view`);
    assert.ok(html.includes(`src="${view.frame}"`), `${view.path} 的 iframe 源`);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), `${view.path} 仍有未替换的占位`);
  }
  assert.deepEqual(layoutValues(VIEWS[0]).FRAME_SRC, '/');
});

test('views.css 只借现有 token，不写死颜色', () => {
  const cssPath = join(viewsDir, 'views.css');
  assert.ok(existsSync(cssPath), `缺少布局样式：${cssPath}`);
  const css = readFileSync(cssPath, 'utf8');
  assert.ok(css.includes('var(--border)'), '用了现有 --border');
  assert.ok(css.includes('var(--panel)'), '用了现有 --panel');
  // 不新造主题：除 @charset 外不应出现十六进制 / rgb 颜色。
  assert.doesNotMatch(css.replace(/@charset[^;]+;/, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

/* ---------------------------------------------------------------------------------------------
 * 2. 端到端
 * ------------------------------------------------------------------------------------------- */

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`服务 20 秒内没起来\nstderr:\n${stderr}`)), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（code ${code}）\n${stderr}`));
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env },
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child && child.exitCode === null) child.kill();
  child = null;
});

test('四个路径都 200，且 HTML 带对应 data-view 与 iframe 源', async () => {
  for (const view of VIEWS) {
    const response = await fetch(base + view.path);
    assert.equal(response.status, 200, `${view.path} 状态码`);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/, `${view.path} 是 HTML`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-src 'self'/, `${view.path} 允许同源 iframe`);

    const html = await response.text();
    assert.match(html, new RegExp(`data-view="${view.id}"`), `${view.path} 的 data-view`);
    assert.match(html, new RegExp(`data-frame-src="${escapeRegExp(view.frame)}"`), `${view.path} 的 iframe 源`);
    assert.match(html, new RegExp(`data-panel="device"`), `${view.path} 有检查器占位`);
  }
});

test('四个视角都由同一份 layout 渲染（只有占位不同）', async () => {
  const template = readFileSync(layoutPath, 'utf8');
  for (const view of VIEWS) {
    const html = await (await fetch(base + view.path)).text();
    assert.equal(html, renderLayout(template, view), `${view.path} 应由 layout.html 渲染`);
  }
});

test('原有入口与 API 不受影响', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200, '/ 仍然 200');
  assert.match(await page.text(), /<body data-mode="agent"/, '/ 仍是 Agent 工作台');

  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  const body = (await health.json()) as {
    ok: boolean;
    views?: Array<{ path: string; id: string; frame: string }>;
    endpoints: string[];
  };
  assert.equal(body.ok, true);
  assert.ok(body.endpoints.includes('/api/health'));
  assert.deepEqual(body.views?.map((view) => view.path), ['/chat', '/fleet', '/data', '/suite']);

  const css = await fetch(base + '/views/views.css');
  assert.equal(css.status, 200, '/views/views.css 由服务端提供');
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
});
