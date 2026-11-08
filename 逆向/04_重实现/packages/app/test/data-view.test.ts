/**
 * 视-3 的自测：数据视角四区、检索三样可见、四种空态、换批次联动。
 *
 *   node --test packages/app/test/data-view.test.ts
 *
 * ## 为什么这些值得写
 *
 * 第 26.17 节列了视-3 的错法，其中两条特别隐蔽：
 *   · **把「无数据」当成唯一的空态** —— 用户不知道下一步做什么；
 *   · **把回源折叠起来** —— 「看了一眼但没看来源」等于没看。
 * 这两条都不是「跑不起来」，是「看起来做完了」。所以这里断言结构与文案。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const dataPath = join(viewsDir, 'data.js');
const dataUrl = pathToFileURL(dataPath).href;

function codeOf(): string {
  return readFileSync(dataPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ---------------------------------------------------------------------------------------------
 * 1. 四区
 * ------------------------------------------------------------------------------------------- */

test('数据视角四区齐：批次 / 质控 / 检索 / 评测', () => {
  const source = codeOf();
  assert.match(source, /section\('批次'/, '有批次区');
  assert.match(source, /section\('质控'/, '有质控区');
  assert.match(source, /section\('检索'/, '有检索区');
  assert.match(source, /section\('评测'/, '有评测区');
});

test('批次选择在最上面，且换它四区全变', () => {
  const raw = readFileSync(dataPath, 'utf8');
  const source = codeOf();
  // 它是这一屏所有数字的前提（验收项）。
  assert.match(source, /batchPicker/, '有批次选择器');
  assert.match(source, /batchPicker\.addEventListener\('change'/, '换批次有监听');
  // 一个动作同时刷新四块 —— 各自监听会出现「批次已换、质控还是旧的」的半新半旧屏。
  assert.match(source, /async function selectBatch/, 'selectBatch 是唯一入口');
  const body = /async function selectBatch[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  for (const painter of ['paintBatch', 'paintQuality', 'paintSearch', 'paintEval']) {
    assert.match(body, new RegExp(`${painter}\\(\\)`), `selectBatch 里要刷新 ${painter}`);
  }
  // 「为什么一起画」写在注释里，所以这条要读原文。
  assert.match(raw, /四区一起重画/, '注释写明为什么一起画');
});

/* ---------------------------------------------------------------------------------------------
 * 2. 检索区三样同时可见
 * ------------------------------------------------------------------------------------------- */

test('检索区四样同时可见：分区 / SQL / 行数 / 引擎', () => {
  const source = codeOf();
  for (const label of ['分区', '行数', '引擎']) {
    assert.match(source, new RegExp(`\\['${label}'`), `回源要有 ${label}`);
  }
  assert.match(source, /vw-sql/, 'SQL 有独立容器');
  // 引擎要带耗时。
  assert.match(source, /elapsedMs/, '引擎耗时');
});

test('回源不能折叠（折起来用户不会点开）', () => {
  const source = codeOf();
  // `details` / `summary` 是最省事的折叠，也是最容易犯这个错的地方。
  assert.doesNotMatch(source, /<details|createElement\('details'\)|createElement\("details"\)/, '不能用 details 折叠');
  assert.doesNotMatch(source, /<summary/, '不能用 summary 折叠');
  // 回源块必须直接画出来。
  assert.match(source, /vw-provenance/, '回源块直接渲染');
});

test('SQL 格式化：主句换行、逻辑词缩进', async () => {
  const { formatSql } = await import(dataUrl);
  const sql = "SELECT count(*) FILTER (WHERE cn0 IS NULL) * 100.0 / count(*) FROM obs WHERE station = 'WUHN' AND date = '2026-11-07'";
  const formatted = formatSql(sql);
  // 25.11.3：一行到底的 SQL 不可读，而用户要「看懂它在查什么」。
  assert.ok(formatted.split('\n').length >= 3, `至少三行，实际：\n${formatted}`);
  assert.match(formatted, /\nFROM /, 'FROM 另起一行');
  assert.match(formatted, /\nWHERE /, 'WHERE 另起一行');
  assert.match(formatted, /\n {2}AND /, 'AND 换行并缩进');
  // 括号前必须有空格：`FILTER(WHERE` 读起来像函数名，不是带条件的聚合。
  assert.match(formatted, /FILTER \(WHERE /, 'FILTER 与括号之间有空格');
  assert.doesNotMatch(formatted, /FILTER\(WHERE/, '不能出现 FILTER(WHERE');
  // 空输入不崩。
  assert.equal(formatSql(''), '');
  assert.equal(formatSql(null), '');
});

/* ---------------------------------------------------------------------------------------------
 * 3. 四种空态互相区分
 * ------------------------------------------------------------------------------------------- */

test('四种空态齐，且标题互不相同', async () => {
  const { EMPTY_STATES } = await import(dataUrl);
  const keys = Object.keys(EMPTY_STATES);
  assert.deepEqual(keys.sort(), ['emptyBatch', 'engineDown', 'missingField', 'noBatch']);

  const titles = keys.map((key) => EMPTY_STATES[key as keyof typeof EMPTY_STATES].title);
  assert.equal(new Set(titles).size, 4, `四个空态标题不能重复：${titles.join(' / ')}`);
  // 25.11.4 点名不许都写「无数据」——那句话让用户不知道下一步做什么。
  for (const title of titles) {
    assert.doesNotMatch(title, /^无数据$/, '不能只说「无数据」');
  }
});

test('「引擎不可用」是降级不是没数据，必须说清数据还在', async () => {
  const { EMPTY_STATES } = await import(dataUrl);
  // 附录 C.9 第 5 条：藏起来让界面好看等于骗用户。
  assert.match(EMPTY_STATES.engineDown.title, /引擎不可用/);
  assert.match(EMPTY_STATES.engineDown.note, /数据还在/, '要说清数据没丢');
  assert.doesNotMatch(EMPTY_STATES.engineDown.title, /没有数据/, '这不是「没有数据」');
});

test('空批次不给「导入」按钮（数据在，只是这批没有行）', () => {
  const source = codeOf();
  // 空批次那一段里不能出现导入 —— 给导入会误导用户以为数据丢了。
  const emptyBranch = /emptyBatch\.title[\s\S]{0,200}/.exec(source)?.[0] ?? '';
  assert.doesNotMatch(emptyBranch, /导入/, '空批次不给导入');
});

/* ---------------------------------------------------------------------------------------------
 * 4. 其他
 * ------------------------------------------------------------------------------------------- */

test('质控三列，每列「绝对数 + 比例」', () => {
  const source = codeOf();
  for (const key of ['missing', 'jumps', 'outOfRange']) {
    assert.match(source, new RegExp(`key: '${key}'`), `有 ${key} 一类`);
  }
  // 绝对数说明「有多少」，比例说明「严重不严重」—— 两个都要（附录 C.5 点二）。
  assert.match(source, /vw-qc-value/, '有绝对数');
  assert.match(source, /vw-qc-ratio/, '有比例');
});

test('评测用 ✓ ✗ 不用颜色（色盲用户那里颜色失效）', () => {
  const source = codeOf();
  assert.match(source, /'✓'/, '有 ✓');
  assert.match(source, /'✗'/, '有 ✗');
  // 未跑用 `?`，不装作失败。
  assert.match(source, /'\\?'|'\?'/, '未跑用问号');
  assert.match(source, /EVAL_KEYS = \['S1', 'S2', 'S3', 'S4', 'S5', 'S6'\]/, '六条');
});

test('接口没接上时说「拿不到」，不说「没有数据」', () => {
  const source = codeOf();
  assert.match(source, /还拿不到数据/, '说清是拿不到');
  assert.match(source, /不是「没有批次」，是「还没接上」/, '把区别写进文案');
  assert.match(source, /DATA_ENDPOINTS/, '端点集中一处');
});

test('走 store 缓存，不自建 store', () => {
  const source = codeOf();
  assert.match(source, /ensure\(/, '用 ensure');
  assert.doesNotMatch(source, /createStore\(/, '不能自建 store');
});

test('el() 的第三个位置参数也是子节点（否则会静默丢空整块）', async () => {
  // 真实翻车：探针页写 `el('div', { cls }, [...])`，而第一版 `el` 只收两个参数，
  // 于是元素建出来了、class 对了、内容全空 —— 看着像样式没生效。
  // 质控与评测两块同时空掉，排查了两轮。
  const domPath = join(viewsDir, 'dom.js');
  const previous = (globalThis as { document?: unknown }).document;
  const makeStub = (tag: string) => ({
    tagName: tag.toUpperCase(),
    className: '',
    title: '',
    children: [] as unknown[],
    dataset: {} as Record<string, string>,
    setAttribute() { /* 桩 */ },
    append(child: unknown) { this.children.push(child); return this; },
  });
  (globalThis as { document?: unknown }).document = { createElement: makeStub, createTextNode: (v: string) => v };
  try {
    const { el } = await import(pathToFileURL(domPath).href);
    const a = el('div', { cls: 'x' }, ['一', '二']);
    assert.equal(a.children.length, 2, '第三参数要被当子节点');
    const b = el('div', { cls: 'x', children: ['一'] }, ['二']);
    assert.equal(b.children.length, 1, 'options.children 优先，不与第三参数叠加');
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});
