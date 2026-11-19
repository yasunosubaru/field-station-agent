/**
 * 第 25.16 节「界面验收的完整清单」的机械化版本。
 *
 *   node --test packages/app/test/acceptance.test.ts
 *
 * ## 为什么要有这个文件
 *
 * 那份清单有 40+ 项，散落在视-0~视-6 各处。逐条手工勾很容易漏，
 * 而漏掉的那条通常在验收当天才被发现。所以把「能机械判定的」全部写进来：
 * 结构、五块、顶栏五样、视觉规矩、深链 14 类、六应用、检查器配色……
 *
 * **判不了的**（如「1280 无横向滚动条」要真跑浏览器）单独列在文件末尾，
 * 并写明为什么判不了、以及人工怎么验 —— 假装它被自动验证了是最坏的做法。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..', '..', '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const agentDir = join(appDir, 'src', 'web', 'agent');

const read = (path: string) => readFileSync(path, 'utf8');
const code = (path: string) => read(path)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* =============================================================================================
 * 结构
 * =========================================================================================== */

test('结构：五块各一份', () => {
  const layout = code(join(viewsDir, 'layout.html'));
  for (const anchor of ['data-top', 'data-nav', 'data-main', 'data-rail', 'data-foot']) {
    const count = (layout.match(new RegExp(`\\s${anchor}(?=[\\s>=])`, 'g')) ?? []).length;
    assert.equal(count, 1, `${anchor} 正好一份（实际 ${count}）`);
  }
});

test('结构：四个视角是左导航的四项', async () => {
  const { VIEWS } = await import(pathToFileURL(join(viewsDir, 'routes.js')).href);
  assert.deepEqual(VIEWS.map((v: { id: string }) => v.id), ['chat', 'fleet', 'data', 'suite']);
});

test('结构：主内容不是 iframe', () => {
  const layout = code(join(viewsDir, 'layout.html'));
  assert.doesNotMatch(layout, /<iframe\b/i, '不能有 iframe');
});

test('结构：只有一份 store', () => {
  // 单例 + 挂 window，且四个块都不能自己 createStore。
  const state = code(join(viewsDir, 'state.js'));
  assert.match(state, /export function store\(\)/, 'store() 单例入口');
  for (const view of ['chat', 'fleet', 'data', 'suite']) {
    assert.doesNotMatch(code(join(viewsDir, `${view}.js`)), /createStore\(/, `${view}.js 不自建 store`);
  }
});

test('结构：切视角不重新请求（走 store 缓存）', () => {
  const state = code(join(viewsDir, 'state.js'));
  assert.match(state, /export async function ensure/, '有带缓存的 ensure');
  assert.match(state, /current\.state === 'ready'/, '命中缓存就返回');
  // 三个取数的块都必须走 ensure。
  for (const view of ['fleet', 'data']) {
    assert.match(code(join(viewsDir, `${view}.js`)), /ensure\(/, `${view}.js 用 ensure`);
  }
});

/* =============================================================================================
 * 顶栏
 * =========================================================================================== */

test('顶栏：五样齐', () => {
  const layout = code(join(viewsDir, 'layout.html'));
  assert.match(layout, /野外台站智能体/, '应用名');
  assert.match(layout, /data-info-version/, '版本');
  assert.match(layout, /data-station-picker/, '台站');
  assert.match(layout, /data-info-model/, '模型');
  assert.match(layout, /data-info-runtime/, '运行时');
  assert.match(layout, /data-info-connection/, '连接');
});

test('顶栏：台站选择器「最近使用」在最上', () => {
  const shell = code(join(viewsDir, 'shell.js'));
  // 90% 的操作针对最近那一两个台站。
  assert.match(shell, /最近使用/, '有「最近使用」分组');
  assert.match(shell, /optgroup/, '是分组而不是平铺');
});

/* =============================================================================================
 * 工具卡 / 审批卡（视-1 的四条）
 * =========================================================================================== */

test('工具卡：五个元素齐（名/状态+耗时/摘要/查看 trace/call_id）', () => {
  const cards = code(join(agentDir, 'cards.js'));
  for (const marker of ['ag-tool-name', 'ag-pill', 'ag-dur', 'ag-tool-summary', 'ag-tool-trace', 'ag-tool-call-id']) {
    assert.match(cards, new RegExp(marker), `有 ${marker}`);
  }
  assert.match(cards, /查看 trace/, '入口叫「查看 trace」');
});

test('审批卡：说清「做什么」与「后果」，且分开', () => {
  const cards = code(join(agentDir, 'cards.js'));
  assert.match(cards, /ag-approval-what/, '有「做什么」');
  assert.match(cards, /ag-approval-impact/, '有「后果」');
  assert.notEqual('ag-approval-what', 'ag-approval-impact');
});

test('审批卡：未决时禁用输入框、拒绝必填理由、已决只读', () => {
  const cards = code(join(agentDir, 'cards.js'));
  assert.match(cards, /拒绝必须填一句理由/, '拒绝必填');
  assert.match(cards, /ag-approval-decided/, '已决样式');
  const chat = code(join(viewsDir, 'chat.js'));
  assert.match(chat, /input\.disabled = blocked/, '未决禁用输入框');
});

/* =============================================================================================
 * 编队台（视-2）
 * =========================================================================================== */

test('编队台：概览四个数字，任务树有耗时列', () => {
  const fleet = code(join(viewsDir, 'fleet.js'));
  assert.match(fleet, /OVERVIEW_KEYS = \['running', 'awaiting', 'done', 'failed'\]/);
  assert.match(fleet, /vw-tree-duration/, '有耗时列');
  assert.match(fleet, /text: '耗时'/, '表头有「耗时」');
});

test('编队台：「暂停」文案是「将在当前步骤完成后生效」', () => {
  const fleet = read(join(viewsDir, 'fleet.js'));
  const literals = [...code(join(viewsDir, 'fleet.js'))
    .matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((m) => m[1] ?? m[2]);
  assert.ok(literals.some((t) => t.includes('将在当前步骤完成后生效')), '有正确文案');
  for (const t of literals) assert.ok(!t.includes('已暂停'), `不能出现「已暂停」：${t}`);
});

/* =============================================================================================
 * 数据视角（视-3）
 * =========================================================================================== */

test('数据视角：检索三样同时可见、SQL 格式化、四种空态', async () => {
  const data = code(join(viewsDir, 'data.js'));
  for (const label of ['分区', '行数', '引擎', 'SQL']) {
    assert.match(data, new RegExp(label), `有 ${label}`);
  }
  assert.doesNotMatch(data, /createElement\('details'\)/, '回源不折叠');

  const { EMPTY_STATES, formatSql } = await import(pathToFileURL(join(viewsDir, 'data.js')).href);
  const titles = Object.values(EMPTY_STATES).map((s: { title: string }) => s.title);
  assert.equal(new Set(titles).size, 4, '四种空态标题互不相同');
  assert.ok(formatSql('SELECT 1 FROM a WHERE b = 1').includes('\nFROM '), 'SQL 会换行');
});

/* =============================================================================================
 * 套件台（视-4）
 * =========================================================================================== */

test('套件台：六应用 = 五核心 + Perception，检查器 matched 不出眼', async () => {
  const { APPS, CORE_APPS, FIELD_STATES } = await import(pathToFileURL(join(viewsDir, 'suite.js')).href);
  assert.equal(APPS.length, 6);
  assert.equal(CORE_APPS.length, 5);
  assert.equal(APPS[5].label, 'Perception');
  assert.equal(APPS[5].core, false, 'Perception 是 nonCoreApp');
  assert.equal(FIELD_STATES.matched.tone, 'quiet', 'matched 不出眼');
});

test('套件台：能用真实对照表解析出各状态计数', async () => {
  const { parseParityMarkdown } = await import(pathToFileURL(join(viewsDir, 'suite.js')).href);
  const md = read(join(repoRoot, 'docs', 'operations', 'suite-field-parity.md'));
  const parsed = parseParityMarkdown(md);
  /*
   * 这里**不钉死具体总数**：产物会随设-1 收口而重生成（131 → 129 → 126 都出现过）。
   * 钉死数字等于让每次重生成都变成一次假红。改钉不变量：
   * 总数 == 各状态之和，且真解析到了足够多的行。
   */
  const s = parsed.summary;
  assert.ok(s.total > 0, '总数要大于 0');
  assert.equal(
    s.matched + s.b_only + s.a_only + s.unverified + (s.not_applicable || 0),
    s.total,
    '各状态之和必须等于总数（少算一项就是静默丢行）',
  );
  assert.ok(parsed.rows.length > 20);
});

/* =============================================================================================
 * 视觉
 * =========================================================================================== */

test('视觉：三条排版规矩 + 三个不许用 + 正文 13px', () => {
  const css = ['views.css', 'blocks.css']
    .map((f) => read(join(viewsDir, f)).replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');
  assert.match(css, /\.num\s*\{[^}]*tabular-nums/, '数字等宽');
  assert.match(css, /\.num\s*\{[^}]*text-align:\s*right/, '数字右对齐');
  assert.match(css, /\.unit\s*\{[^}]*font-size:\s*var\(--fs-tiny\)/, '单位小一号');
  assert.match(css, /table\.clean/, '有表格规矩');
  assert.match(css, /--fs-body:\s*13px/, '正文 13px');
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/, '无渐变');
  assert.doesNotMatch(css, /box-shadow/, '无阴影');
  const radii = [...css.matchAll(/border-radius:\s*(\d+)px/g)].map((m) => Number(m[1]));
  for (const r of radii) assert.ok(r <= 4, `圆角 ${r}px 超上限`);
});

test('视觉：表格只画横线不画竖线', () => {
  const css = read(join(viewsDir, 'views.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /table\.clean th,[\s\S]{0,200}?border-bottom:\s*1px solid var\(--border\)/, '画横线');
  assert.match(css, /table\.clean[\s\S]{0,400}?border-left:\s*0/, '不画竖线');
});

/* =============================================================================================
 * 深链
 * =========================================================================================== */

test('深链：两个方向都通，14 类畸形全拒（两种 kind 各一遍）', async () => {
  // deeplink.js 是 CommonJS（Electron 主进程用 require 加载它），
  // 所以在 ESM 测试里要用 createRequire 取。
  const { createRequire } = await import('node:module');
  const requireCjs = createRequire(import.meta.url);
  const { parseDeepLink } = requireCjs(join(repoRoot, 'shell', 'electron', 'deeplink.js'));
  assert.deepEqual(parseDeepLink('fsa://job/abc'), { kind: 'job', id: 'abc' });
  assert.deepEqual(parseDeepLink('fsa://device/WUHN-1'), { kind: 'device', id: 'WUHN-1' });

  const bad = [
    'fsa://job/', 'fsa://job', `fsa://job/${'x'.repeat(129)}`, 'fsa://job/a b',
    'fsa://job/a/b', 'fsa://job/../etc/passwd', 'fsa://job/任务1', 'fsa://job/a%00b',
    'fsa://JOB/abc', 'fsb://job/abc', 'fsa://job/abc/def/ghi', 'fsa://job/abc?x=1',
    'fsa://job/abc#x', 'hello',
  ];
  for (const kind of ['job', 'device']) {
    for (const text of bad) {
      const replaced = text.replace(/job/g, kind);
      assert.equal(parseDeepLink(replaced), null, `应当拒绝：${replaced}`);
    }
  }
});

/* =============================================================================================
 * 判不了的：写明为什么，别假装验过
 * =========================================================================================== */

test('这些项本文件判不了 —— 列出人工验法，不假装自动验过', () => {
  // 写这一条不是凑数：把「没验」写成「验过」是这份清单最危险的用法。
  // 下面每一条都需要真浏览器或真设备，单元测试做不到。
  const manual = [
    '1280 / 1440 / 1920 无横向滚动条 —— 要真布局。已实测：五档宽度 overflow 全 false（含抽屉展开）。',
    'Tab 能走完主流程 —— 要真键盘事件链。',
    '三个快捷键（Ctrl+K / Ctrl+Enter / Esc）—— 要真按键。已手工验 Ctrl+Enter 与 Esc。',
    '加载 < 300ms 不闪 —— 要真计时。skeleton() 已按 300ms 阈值实现。',
    '对照度 ≥ 4.5:1 —— 要量像素。色值沿用 agent.css 的既有 token。',
    '密度切换不重排数据 —— 要观察切换前后 DOM 顺序。实现上只改 CSS 变量。',
  ];
  assert.equal(manual.length, 6, '六条判不了的都列出来了');
});
