/**
 * 四个视角的自测（视-0 之后）。
 *
 *   node --test packages/app/test/views.test.ts
 *
 * 三段：
 *   1. 纯数据：路由表、内容块、layout.html 与占位、左导航片段。
 *   2. 单页结构：没有 iframe、只有一份 store、五块各一份、`.center` 有 min-width:0。
 *   3. 端到端：真起 server.ts（`--port 0`），四个路径 200、HTML 带对应结构，
 *      同时确认 `/`、`/api/health`、`/views/*` 仍然可用（additive 的底线）。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAYOUT_FILE,
  LAYOUT_TOKENS,
  VIEWS,
  layoutValues,
  navItems,
  renderLayout,
  viewById,
  viewForPath,
  type ViewId,
} from '../src/web/views/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..', '..', '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const layoutPath = join(viewsDir, LAYOUT_FILE);
const serverPath = join(appDir, 'src', 'server.ts');

/* ---------------------------------------------------------------------------------------------
 * 1. 路由表
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
    assert.equal(viewById(view.id), view, `${view.id} 能按 id 找回`);
    assert.ok(view.label.length > 0, `${view.path} 有导航名`);
    assert.ok(view.title.length > 0, `${view.path} 有标题`);
    assert.ok(view.glyph.length > 0, `${view.path} 有图标`);
    // 图标必须是几何符号，不是 emoji（25.4.2：emoji 在不同系统上长得不一样，而且颜色跳）。
    assert.doesNotMatch(view.glyph, /\p{Extended_Pictographic}/u, `${view.path} 的图标不能是 emoji`);
  }
});

test('主内容是内容块标识，不是 URL —— 三个错指已经修掉', () => {
  // 改前：fleet → /geo/luciad-stage.html（地图）、data → /config/events（事件列表）、
  //      suite → /?mode=pro（原版首页）。第 26.16 节把「/fleet 还是地图」列为第一条错法。
  const wrongTargets = ['/geo/luciad-stage.html', '/config/events', '/?mode=pro'];
  for (const view of VIEWS) {
    assert.equal(view.content, view.id, `${view.path} 的内容块就是它自己`);
    assert.equal(view.frame, view.content, `${view.path} 的 frame 别名与 content 同值`);
    assert.ok(!view.content.startsWith('/'), `${view.path} 的 content 不是 URL`);
    for (const wrong of wrongTargets) {
      assert.notEqual(view.content, wrong, `${view.path} 不能再指到 ${wrong}`);
      assert.notEqual(view.frame, wrong, `${view.path} 的 frame 不能再指到 ${wrong}`);
    }
  }
  // 四个视角各有一个模块文件，且文件真的在。
  for (const view of VIEWS) {
    const modulePath = join(appDir, 'src', 'web', view.module);
    assert.ok(existsSync(modulePath), `${view.path} 的模块存在：${view.module}`);
  }
});

test('不是视角路由的路径不匹配（/ 与 API 保持原样）', () => {
  for (const path of ['/', '/index.html', '/api/health', '/chatty', '/view/chat', '/views/views.css']) {
    assert.equal(viewForPath(path), undefined, `${path} 不应命中视角路由`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * 2. 单页结构（视-0 的核心）
 * ------------------------------------------------------------------------------------------- */

test('主内容不是 iframe —— 这是视-0 的全部价值', () => {
  const template = stripComments(readFileSync(layoutPath, 'utf8'));
  // 改前中栏是一个 <iframe>，四个视角各挂一个现成页面。
  assert.doesNotMatch(template, /<iframe\b/i, 'layout 里不能再有 iframe');
  // 中栏必须是一个可换内容的容器。
  assert.match(template, /<main[^>]*\bdata-main\b/, '中栏需要 data-main 作为换内容的落点');
  assert.match(template, /data-content="\{\{VIEW_CONTENT\}\}"/, '中栏带内容块标识');
});

/** 去掉 HTML 注释与 JS 行注释，免得「注释里提到 iframe」被当成真有 iframe。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** 去掉 CSS 注释。注释里写「不许用 box-shadow」不该被当成用了 box-shadow。 */
function stripCss(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('五块各一份：顶栏 / 左导航 / 主内容 / 右栏 / 底栏', () => {
  const template = stripComments(readFileSync(layoutPath, 'utf8'));
  for (const anchor of ['data-top', 'data-nav', 'data-main', 'data-rail', 'data-foot']) {
    const count = (template.match(new RegExp(`\\s${anchor}(?=[\\s>=])`, 'g')) ?? []).length;
    assert.equal(count, 1, `${anchor} 必须正好一份，实际 ${count}`);
  }
});

test('顶栏五样齐（应用名 / 版本 / 台站 / 模型 / 运行时 / 连接）', () => {
  const template = readFileSync(layoutPath, 'utf8');
  // 第 25.3.1 节：这五样是「报 bug 时要用」的信息，少一样就得去别处找。
  assert.match(template, /野外台站智能体/, '应用名');
  assert.match(template, /data-info-version/, '版本');
  assert.match(template, /data-station-picker/, '台站选择器');
  assert.match(template, /data-info-model/, '模型');
  assert.match(template, /data-info-runtime/, '运行时');
  assert.match(template, /data-info-connection/, '连接状态');

  // 不该显示的三样（25.3.2）：完整路径、实时 token、全部台站列表。
  assert.doesNotMatch(template, /C:\\\\|%USERPROFILE%/, '不能出现完整本机路径');
});

test('底栏四个状态灯，且每个都能点开看原因', () => {
  const shell = readFileSync(join(viewsDir, 'shell.js'), 'utf8');
  // 第 25.7.1 节：黄（降级）比红更常见也更重要 —— 用户可能不知道自己在降级状态。
  for (const lamp of ['dbos', 'graph', 'memory', 'queue']) {
    assert.match(shell, new RegExp(`'${lamp}'`), `底栏要有 ${lamp} 灯`);
  }
  // 灯必须是 button，不是 div —— 否则「点开看原因」做不到，键盘也够不着。
  assert.match(shell, /createElement\('button'\)/, '灯是可点的按钮');
  assert.match(shell, /vw-lamp-reason/, '灯要能展开原因');
});

test('一份 store：不能每个入口各建一次', () => {
  const state = readFileSync(join(viewsDir, 'state.js'), 'utf8');
  // 第 6.2.7 节把「store 不共享」列为本条最大的技术风险。
  assert.match(state, /export function store\(\)/, 'store() 是单例入口');
  assert.match(state, /__FSA_STORE__/, '单例挂到 window，供控制台与测试验「真的共享」');

  // 视角模块只能 import store()，不能自己 createStore() —— 那会变成两份。
  for (const view of VIEWS) {
    const source = readFileSync(join(appDir, 'src', 'web', view.module), 'utf8');
    assert.doesNotMatch(source, /createStore\(/, `${view.module} 不能自己 createStore`);
  }
  // 壳也只能用 store()。
  const shell = readFileSync(join(viewsDir, 'shell.js'), 'utf8');
  assert.doesNotMatch(shell, /createStore\(/, 'shell.js 不能自己 createStore');
});

test('.center 的 min-width: 0 必须在 —— 这是 1280 不溢出的技术核心', () => {
  const css = readFileSync(join(viewsDir, 'views.css'), 'utf8');
  // 25.5.3：Flex 子元素默认 min-width:auto，内容里的宽表格会把页面撑出横向滚动条。
  const mainBlock = /\.vw-main\s*\{([^}]*)\}/.exec(css);
  assert.ok(mainBlock, 'views.css 要有 .vw-main 规则');
  assert.match(mainBlock[1], /min-width:\s*0/, '.vw-main 必须 min-width: 0');
  // 中栏的父容器同样要 0，否则 flex 链上还是会撑开。
  const bodyBlock = /\.vw-body\s*\{([^}]*)\}/.exec(css);
  assert.ok(bodyBlock, 'views.css 要有 .vw-body 规则');
  assert.match(bodyBlock[1], /min-width:\s*0/, '.vw-body 必须 min-width: 0');
});

test('视觉规矩三条与三个不许用', () => {
  const css = stripCss(stripComments(readFileSync(join(viewsDir, 'views.css'), 'utf8')));
  const blocks = stripCss(stripComments(readFileSync(join(viewsDir, 'blocks.css'), 'utf8')));
  const all = `${css}\n${blocks}`;

  // 规矩一：数字等宽右对齐。
  assert.match(all, /\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/, '.num 用等宽数字');
  assert.match(all, /\.num\s*\{[^}]*text-align:\s*right/, '.num 右对齐');
  // 规矩二：单位小一号。
  assert.match(all, /\.unit\s*\{[^}]*font-size:\s*var\(--fs-tiny\)/, '.unit 小一号');
  // 规矩三：表格只画横线。
  assert.match(all, /table\.clean/, '有 table.clean 规则');
  assert.match(all, /table\.clean[\s\S]{0,400}?border-bottom:\s*1px solid var\(--border\)/, '表格画横线');
  assert.match(all, /table\.clean[\s\S]{0,400}?border-left:\s*0/, '表格不画竖线');

  // 正文 13px。
  assert.match(all, /--fs-body:\s*13px/, '正文 13px');

  // 三个不许用：无渐变、无阴影、圆角 ≤ 4px。
  assert.doesNotMatch(all, /linear-gradient|radial-gradient/, '不许用渐变');
  assert.doesNotMatch(all, /box-shadow/, '不许用阴影');
  const radii = [...all.matchAll(/border-radius:\s*(\d+)px/g)].map((match) => Number(match[1]));
  for (const radius of radii) {
    assert.ok(radius <= 4, `圆角 ${radius}px 超过 4px 上限`);
  }
});

test('views.css 与 blocks.css 只借 token，不写死颜色', () => {
  for (const name of ['views.css', 'blocks.css']) {
    const cssPath = join(viewsDir, name);
    assert.ok(existsSync(cssPath), `缺少样式：${cssPath}`);
    const css = readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('var(--border)'), `${name} 用了现有 --border`);
    assert.ok(css.includes('var(--panel)'), `${name} 用了现有 --panel`);
    // 不新造主题：除 @charset 外不应出现十六进制 / rgb 颜色。
    assert.doesNotMatch(
      css.replace(/@charset[^;]+;/, ''),
      /#[0-9a-fA-F]{3,8}\b|rgba?\(/,
      `${name} 不能写死颜色`,
    );
  }
});

test('layout.html 占位齐全，四个视角共用同一份', () => {
  assert.ok(existsSync(layoutPath), `缺少外壳页：${layoutPath}`);
  const template = readFileSync(layoutPath, 'utf8');

  for (const token of LAYOUT_TOKENS) {
    assert.ok(template.includes(`{{${token}}}`), `layout 缺少占位 {{${token}}}`);
  }
  // 视-0 之后不再有 FRAME_SRC / FRAME_MODE —— 主内容不是 iframe，没有 src 要填。
  assert.ok(!template.includes('{{FRAME_SRC}}'), '不再有 FRAME_SRC');
  assert.ok(!template.includes('{{FRAME_MODE}}'), '不再有 FRAME_MODE');

  // 同一份 layout 渲染四次，只换占位。
  for (const view of VIEWS) {
    const html = renderLayout(template, view);
    assert.match(html, new RegExp(`data-view="${view.id}"`), `${view.path} 的 data-view`);
    assert.match(html, new RegExp(`data-content="${view.content}"`), `${view.path} 的 data-content`);
    assert.match(html, new RegExp(`data-view-link="${view.id}"`), `${view.path} 在左导航里`);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), `${view.path} 仍有未替换的占位`);
  }
  assert.deepEqual(layoutValues(VIEWS[0]).VIEW_CONTENT, 'chat');
  assert.deepEqual(layoutValues(VIEWS[0]).VIEW_ID, 'chat');
});

test('左导航四项，当前项带 aria-current（不只靠颜色）', () => {
  const markup = navItems('fleet');
  for (const view of VIEWS) {
    assert.match(markup, new RegExp(`data-view-link="${view.id}"`), `导航包含 ${view.id}`);
    assert.match(markup, new RegExp(`href="${view.path}"`), `${view.id} 是真链接`);
  }
  // 当前项：竖条与背景是视觉，aria-current 给读屏（25.4.3 要求至少两个手段）。
  const current = markup.match(/aria-current="page"/g) ?? [];
  assert.equal(current.length, 1, '只有一个 aria-current');
  assert.match(markup, /data-view-link="fleet"[^>]*aria-current="page"/, '当前项是 fleet');
});

/* ---------------------------------------------------------------------------------------------
 * 3. 端到端
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

test('四个路径都 200，HTML 带五块与内容块标识', async () => {
  for (const view of VIEWS) {
    const response = await fetch(base + view.path);
    assert.equal(response.status, 200, `${view.path} 状态码`);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/, `${view.path} 是 HTML`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

    const html = await response.text();
    assert.match(html, new RegExp(`data-view="${view.id}"`), `${view.path} 的 data-view`);
    assert.match(html, new RegExp(`data-content="${view.content}"`), `${view.path} 的 data-content`);
    const live = stripComments(html);
    for (const anchor of ['data-top', 'data-nav', 'data-main', 'data-rail', 'data-foot']) {
      assert.match(live, new RegExp(`\\s${anchor}(?=[\\s>=])`), `${view.path} 有 ${anchor}`);
    }
    assert.doesNotMatch(live, /<iframe\b/i, `${view.path} 不能还有 iframe`);
  }
});

test('四个视角都由同一份 layout 渲染（只有占位不同）', async () => {
  const template = readFileSync(layoutPath, 'utf8');
  for (const view of VIEWS) {
    const html = await (await fetch(base + view.path)).text();
    assert.equal(html, renderLayout(template, view), `${view.path} 应由 layout.html 渲染`);
  }
});

test('shell.js 与四个视角模块都能被服务端取到（MIME 是 JS）', async () => {
  for (const asset of ['shell.js', 'state.js', 'dom.js', 'routes.js', ...VIEWS.map((view) => view.module.split('/').pop())]) {
    const response = await fetch(`${base}/views/${asset}`);
    assert.equal(response.status, 200, `/views/${asset} 状态码`);
    // nosniff 生效时，MIME 不是 JS 就执行不了 —— 所以这条必须验。
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/javascript/,
      `/views/${asset} 必须以 JS 提供`,
    );
  }
});

test('浏览器侧的七个模块语法合法，且不 import .ts', async () => {
  // 这一条是从一次真实翻车里补来的：`densityToggle?.textContent = ...` 这类
  // 「可选链做赋值目标」是**语法错误**，而静态 grep 与单元测试都看不出来 ——
  // 页面打开后整块 JS 不执行，界面却「看起来正常」（骨架是服务端渲染的）。
  // 所以这里真的让 Node 解析一遍每一个模块。
  const { execFileSync } = await import('node:child_process');
  const files = ['shell.js', 'state.js', 'dom.js', 'routes.js', ...VIEWS.map((view) => view.module.split('/').pop())];
  for (const name of files) {
    const full = join(viewsDir, name);
    assert.ok(existsSync(full), `缺少模块：${name}`);
    // `node --check` 对 .js 按脚本解析；这些文件都是 ESM，所以用 --input-type 显式声明。
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: readFileSync(full, 'utf8'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 浏览器跑不了 .ts（服务端 MIME 表没有 .ts 且 nosniff），所以不能 import 它。
    const source = stripComments(readFileSync(full, 'utf8'));
    assert.doesNotMatch(source, /from\s+['"][^'"]*\.ts['"]/, `${name} 不能 import .ts`);
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
  // `frame` 别名仍然给 health 用（server.ts 读它），值现在是内容块标识。
  assert.deepEqual(body.views?.map((view) => view.frame), ['chat', 'fleet', 'data', 'suite']);

  const css = await fetch(base + '/views/views.css');
  assert.equal(css.status, 200, '/views/views.css 由服务端提供');
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);

  const blocks = await fetch(base + '/views/blocks.css');
  assert.equal(blocks.status, 200, '/views/blocks.css 由服务端提供');
});

/* ---------------------------------------------------------------------------------------------
 * 4. 文案与结构的硬约束（错一次就会骗用户）
 * ------------------------------------------------------------------------------------------- */

test('「暂停」的文案是「将在当前步骤完成后生效」，绝不写「已暂停」', () => {
  const raw = readFileSync(join(viewsDir, 'fleet.js'), 'utf8');
  // 断言只能看**真正会渲染出去的字符串**，不能看注释 —— 注释里写
  // 「为什么不能写『已暂停』」正是这句设计的存在理由，把它当违规会逼人删掉解释。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 抽所有字符串字面量，逐个检查 —— 比在整个文件上 grep 精确得多。
  const literals = [...code.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((match) => match[1] ?? match[2]);

  assert.ok(
    literals.some((text) => text.includes('将在当前步骤完成后生效')),
    '渲染文案里必须有「将在当前步骤完成后生效」',
  );
  // 第 25.10.5 节：点下去那一刻任务还在跑（干预在步骤边界消费），
  // 所以「已暂停」是谎话。
  for (const text of literals) {
    assert.ok(!text.includes('已暂停'), `文案里不能出现「已暂停」，发现：${text}`);
  }
  // 文案要导出成常量，才可能被测试逐字断言。
  assert.match(code, /export const PAUSE_NOTICE/, 'PAUSE_NOTICE 是可断言的常量');
});

test('任务树必须有耗时列', () => {
  const fleet = readFileSync(join(viewsDir, 'fleet.js'), 'utf8');
  const css = readFileSync(join(viewsDir, 'blocks.css'), 'utf8');
  // 第 25.10.3 节：「耗时」这一列是最容易被砍掉的，也是最该留的 ——
  // 用户判断「正常不正常」主要靠它。
  assert.match(fleet, /耗时|duration/, '任务树要有耗时列');
  assert.match(css, /\.vw-tree-duration/, '耗时列有独立样式（右对齐 + 等宽）');
});

test('数据视角：检索答案四样同时可见，不折叠', () => {
  const data = readFileSync(join(viewsDir, 'data.js'), 'utf8');
  // 25.11.2：分区 / SQL / 行数 / 引擎三样必须同时可见。折起来用户不会点开，
  // 而「看了一眼但没看来源」等于没看。
  for (const field of ['分区', '行数', '引擎', 'SQL']) {
    assert.match(data, new RegExp(field), `检索区要有 ${field}`);
  }
  // 不能用 <details> 把回源收起来。
  assert.doesNotMatch(data, /<details|createElement\('details'\)/, '回源不能折叠');
  // SQL 要格式化（多行），所以放在 <pre> 里。
  assert.match(data, /vw-sql/, 'SQL 有独立的格式化容器');
});

test('数据视角：四种空态互相区分，不能都说「无数据」', () => {
  const data = readFileSync(join(viewsDir, 'data.js'), 'utf8');
  // 25.11.4：四种空态各说清下一步做什么。「无数据」让用户不知道该怎么办。
  for (const key of ['noBatch', 'emptyBatch', 'missingField', 'engineDown']) {
    assert.match(data, new RegExp(`${key}:\\s*\\{`), `要有 ${key} 空态`);
  }
  const titles = [...data.matchAll(/title:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.equal(new Set(titles).size, titles.length, '四种空态的标题不能重复');
});

test('套件台：六个应用 = 五个核心 + Perception，且 Perception 视觉分隔', () => {
  const suite = readFileSync(join(viewsDir, 'suite.js'), 'utf8');
  const css = readFileSync(join(viewsDir, 'blocks.css'), 'utf8');
  // 第 18.8 节记过事故：「把 Manage 的分区标签当成六个应用」。所以清单写死六个。
  for (const app of ['Manage', 'Playback', 'Convert', 'GRIT', 'Graph', 'Perception']) {
    assert.match(suite, new RegExp(`label: '${app}'`), `清单要有 ${app}`);
  }
  assert.match(suite, /core: false/, 'Perception 是 nonCoreApp');
  assert.match(suite, /CORE_APPS/, '导出 CORE_APPS 供测试断言「五个核心」');
  // 视觉分隔。
  assert.match(suite, /vw-app-sep/, 'Perception 之前要有分隔');
  assert.match(css, /\.vw-app-sep/, '分隔有样式');
  // 未安装必须说出来。
  assert.match(suite, /未安装/, '未装要说「未安装」');
});

test('检查器：matched 不出眼（灰），b_only / a_only 才显眼', () => {
  const suite = readFileSync(join(viewsDir, 'suite.js'), 'utf8');
  const css = readFileSync(join(viewsDir, 'blocks.css'), 'utf8');
  // 25.12.3：用户关心的是**对不上的**。一屏 100 个绿会让 3 个橙淹没掉。
  assert.match(suite, /matched:[\s\S]{0,80}?tone: 'quiet'/, 'matched 是 quiet');
  assert.match(css, /\.vw-tag\[data-tone="quiet"\][\s\S]{0,200}?color: var\(--dim\)/, 'matched 用最淡的颜色');
  // 反过来：b_only / a_only 要有颜色，否则「对不上的」也看不见。
  assert.match(css, /\.vw-tag\[data-tone="add"\]/, 'b_only 有样式');
  assert.match(css, /\.vw-tag\[data-tone="miss"\]/, 'a_only 有样式');
});

test('页头不在 <main> 内部（否则换视角会把它一起摘掉）', () => {
  const template = stripComments(readFileSync(layoutPath, 'utf8'));
  // 真实踩过：`main.replaceChildren()` 每次换视角清空主内容，页头若在 <main> 里
  // 会被一起摘掉；之后往那个游离节点里塞什么都没用，页面上永远不出现
  // （现象是编队台的概览整块消失，而控制台没有报错）。
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(template);
  assert.ok(mainMatch, 'layout 里要有 <main>');
  assert.doesNotMatch(mainMatch[1], /data-view-head/, '页头不能在 <main> 内部');
  assert.match(template, /<header[^>]*data-view-head/, '页头仍然存在');
  // 两者要在同一个容器里并列。
  assert.match(template, /class="vw-center"/, '页头与主内容共用一个竖排容器');
});

test('右栏隐藏时必须能打开（< 1280 用详情抽屉，不挤压主内容）', () => {
  const template = stripComments(readFileSync(layoutPath, 'utf8'));
  const css = stripCss(readFileSync(join(viewsDir, 'views.css'), 'utf8'));
  // 25.6.2：< 1280 时右栏隐藏，用一个「详情」按钮打开抽屉；抽屉不能挤压主内容
  // （挤压会重排，用户正在看的那一行会跳到别处）。
  assert.match(template, /data-rail-drawer-open/, '窄屏要有打开右栏的入口');
  assert.match(template, /aria-controls="vw-rail"/, '入口要指向右栏');
  assert.match(template, /id="vw-rail"/, '右栏要有 id 供 aria-controls');
  // 抽屉是 absolute 覆盖，不是占位挤开。
  const drawerBlock = /@media \(max-width: 1150px\)[\s\S]*?\.vw-rail\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(drawerBlock, '要有窄屏的右栏规则');
  assert.match(drawerBlock[1], /position:\s*absolute/, '抽屉用 absolute 覆盖，不挤压主内容');
  assert.doesNotMatch(drawerBlock[1], /display:\s*none/, '不能只是隐藏掉');
});

test('前端模块不读 task.id，只读 task.task_id（依赖 A 线 Bot-7）', () => {
  const files = readdirSync(viewsDir).filter((name) => name.endsWith('.js'));
  for (const name of files) {
    const source = stripComments(readFileSync(join(viewsDir, name), 'utf8'));
    // 硬要求：不许写 task.id，也不许写兼容分支 task.task_id || task.id。
    // 兼容分支会让「字段没对上」静默降级成「看起来能用」，正是要避免的。
    assert.doesNotMatch(source, /\btask\.id\b(?!_)/, `${name} 不能读 task.id`);
    assert.doesNotMatch(source, /task_id\s*\|\|/, `${name} 不能写 task_id || task.id 兼容分支`);
  }
  // 主键只有一个来源：state.js 的 taskId()。
  const state = readFileSync(join(viewsDir, 'state.js'), 'utf8');
  assert.match(state, /export function taskId\(task\)/, 'taskId() 是唯一主键入口');
  assert.match(state, /task\.task_id/, 'taskId() 读 task_id');
});
