/**
 * 视-4 的自测：套件台三栏、六应用、检查器四列与 matched 不出眼。
 *
 *   node --test packages/app/test/suite-view.test.ts
 *
 * ## 为什么这些值得写
 *
 * 第 18.8 节记过一次真实事故：「把 Manage 的分区标签当成六个应用」。
 * 这类错的特点是**清单看起来合理**，而验收时才发现少了应用或多出伪应用。
 *
 * 另一条是检查器的配色规矩：`matched` 要灰（不出眼）。这条反直觉 ——
 * 「对上了为什么不高亮」—— 所以最容易被后来的改动「修正」成绿色。
 * 因此用断言钉住它。
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
const suitePath = join(viewsDir, 'suite.js');
const suiteUrl = pathToFileURL(suitePath).href;

function codeOf(): string {
  return readFileSync(suitePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ---------------------------------------------------------------------------------------------
 * 1. 六个应用
 * ------------------------------------------------------------------------------------------- */

test('六个应用 = 五个核心 + Perception', async () => {
  const { APPS, CORE_APPS } = await import(suiteUrl);
  assert.equal(APPS.length, 6, `正好六个，实际 ${APPS.length}`);
  assert.equal(CORE_APPS.length, 5, '五个核心');

  const labels = APPS.map((app: { label: string }) => app.label);
  assert.deepEqual(labels, ['Manage', 'Playback', 'Convert', 'GRIT', 'Graph', 'Perception']);

  // Perception 是唯一的 nonCoreApp，且默认未装。
  const perception = APPS.find((app: { id: string }) => app.id === 'perception');
  assert.ok(perception);
  assert.equal(perception.core, false, 'Perception 是 nonCoreApp');
  assert.equal(perception.installed, false, '默认未装');
  // 五个核心都算「已装」。
  for (const app of CORE_APPS) {
    assert.equal(app.installed, true, `${app.label} 默认已装`);
  }
});

test('Perception 视觉分隔，且未装时给「未安装」+ 安装按钮', () => {
  const source = codeOf();
  assert.match(source, /vw-app-sep/, 'Perception 之前有分隔线');
  assert.match(source, /未安装/, '未装要说出来');
  assert.match(source, /安装 \$\{app\.label\}/, '给安装按钮（不是灰掉不说为什么）');
  // 分隔线只在 nonCore 之前插一次。
  assert.match(source, /if \(!app\.core && !sawNonCore\)/, '分隔只插一次');
});

/* ---------------------------------------------------------------------------------------------
 * 2. 检查器
 * ------------------------------------------------------------------------------------------- */

test('检查器四列：字段 / 原版 / B 侧 / 状态', () => {
  const source = codeOf();
  const cols = /\{\s*label:\s*'字段'\s*\},\s*\{\s*label:\s*'原版'\s*\},\s*\{\s*label:\s*'B 侧'\s*\},\s*\{\s*label:\s*'状态'\s*\}/.exec(source);
  assert.ok(cols, '四列表头齐全');
});

test('matched 不出眼（灰、·），b_only / a_only 才显眼', async () => {
  const { FIELD_STATES } = await import(suiteUrl);
  // 25.12.3：用户关心的是**对不上的**。一屏 100 个绿会让 3 个橙淹没掉。
  assert.equal(FIELD_STATES.matched.tone, 'quiet', 'matched 是 quiet');
  assert.equal(FIELD_STATES.matched.glyph, '·', 'matched 用点');
  assert.equal(FIELD_STATES.b_only.tone, 'add', 'b_only 有颜色');
  assert.equal(FIELD_STATES.b_only.glyph, '+');
  assert.equal(FIELD_STATES.a_only.tone, 'miss', 'a_only 有颜色');
  assert.equal(FIELD_STATES.a_only.glyph, '−');

  const css = readFileSync(join(viewsDir, 'blocks.css'), 'utf8');
  // quiet 用最淡的颜色 —— 这条是「不出眼」的落点。
  assert.match(css, /\.vw-tag\[data-tone="quiet"\][\s\S]{0,200}?color:\s*var\(--dim\)/, 'quiet 用 --dim');
});

test('检查器默认可以没有数据，但不假装全 matched', () => {
  const source = codeOf();
  // 拿不到时要说清来源与原因，而不是渲染一张空表或写「全部匹配」。
  assert.match(source, /不假装全 matched/, '文案里写明这一点');
  assert.match(source, /suite_field_parity\.py/, '说清对照表由谁生成');
  assert.match(source, /INSPECTOR_ENDPOINT/, '端点集中一处');
});

test('检查器底部给统计（一眼看到这一页对不对得上）', () => {
  const source = codeOf();
  assert.match(source, /section\('统计'/, '有统计节');
  for (const key of ['matched', 'b_only', 'a_only']) {
    assert.match(source, new RegExp(`\\['${key}'`), `统计里有 ${key}`);
  }
  assert.match(source, /对得上/, '全对上时给一句结论');
});

test('检查器四列在 280px 里可读（状态列固定，不靠压缩每列）', () => {
  const css = readFileSync(join(viewsDir, 'blocks.css'), 'utf8');
  // 实测过两次：
  //   ① 不设最小宽度 → 四列各 65px，`convert.html:103` 被截成不可辨认的片段；
  //   ② 只加横向滚动 → 滚到右边看 B 侧位置时，状态被推出视野，而那正是要看的东西。
  const wrap = /\.vw-inspector-wrap\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(wrap, /overflow:\s*auto/, '整体可滚动');
  assert.match(css, /\.vw-inspector-wrap table\.clean\s*\{[^}]*min-width:\s*\d+px/, '表格有最小宽度');
  assert.match(css, /table\.clean td:last-child[\s\S]{0,300}?position:\s*sticky/, '状态列固定');
  assert.match(css, /table\.clean td:last-child[\s\S]{0,300}?right:\s*0/, '固定在右侧');
  // 固定列不能靠阴影分隔（规矩：不许阴影）。
  const stickyBlock = /table\.clean td:last-child[\s\S]*?\}/.exec(css)?.[0] ?? '';
  assert.doesNotMatch(stickyBlock, /box-shadow/, '固定列不用阴影分隔');
});

/* ---------------------------------------------------------------------------------------------
 * 3. 解析真实产物
 * ------------------------------------------------------------------------------------------- */

test('能解析真实的 suite-field-parity.md（四列 + 结论区计数）', async () => {
  const { parseParityMarkdown, FIELD_STATES } = await import(suiteUrl);
  const mdPath = join(repoRoot, 'docs', 'operations', 'suite-field-parity.md');
  assert.ok(existsSync(mdPath), '对照表应已提交');
  const parsed = parseParityMarkdown(readFileSync(mdPath, 'utf8'));

  // 表里每一行的四列都要真取到（名称非空、状态是四种之一）。
  assert.ok(parsed.rows.length > 20, `要抽到足够多的行，实际 ${parsed.rows.length}`);
  for (const row of parsed.rows) {
    assert.ok(row.name, '字段名不能空');
    assert.ok(row.page, '页面不能空');
    assert.ok(row.verdict in FIELD_STATES, `状态必须是四种之一：${row.verdict}`);
    // 至少有一侧位置（另一侧本来就可能没有）。
    assert.ok(row.a || row.b, `${row.name} 至少一侧要有位置`);
  }

  // 结论区的数字：这份产物当前是 52 / 42 / 37 / 0。
  assert.equal(parsed.summary.matched, 52, 'matched 取去重字段口径');
  assert.equal(parsed.summary.b_only, 42);
  assert.equal(parsed.summary.a_only, 37);
  assert.equal(parsed.summary.unverified, 0);
  assert.equal(parsed.summary.total, 131, '总数是四个之和');
});

test('解析器对坏输入不崩', async () => {
  const { parseParityMarkdown } = await import(suiteUrl);
  for (const bad of ['', null, undefined, 'no table here', '| 字段 | 页面 |']) {
    const parsed = parseParityMarkdown(bad);
    assert.deepEqual(parsed.rows, []);
    assert.equal(parsed.summary.total, 0);
  }
});

test('解析器不把分隔行 `| --- |` 当成数据行', async () => {
  const { parseParityMarkdown } = await import(suiteUrl);
  const markdown = [
    '| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |',
    '| --- | --- | --- | --- | --- |',
    '| cv-dest | convert | `a.js:411` | — | b_only |',
  ].join('\n');
  const parsed = parseParityMarkdown(markdown);
  assert.equal(parsed.rows.length, 1, '只有一条数据行');
  assert.equal(parsed.rows[0].name, 'cv-dest');
  assert.equal(parsed.rows[0].verdict, 'b_only');
  assert.equal(parsed.rows[0].b, 'a.js:411', 'B 侧位置去掉反引号');
  assert.equal(parsed.rows[0].a, '', '「—」归一成空串，不是字符串「—」');
});

/* ---------------------------------------------------------------------------------------------
 * 4. 结构与跨视角跳
 * ------------------------------------------------------------------------------------------- */

test('三栏结构：应用栏 / 中内容 / 右检查器', () => {
  const source = codeOf();
  assert.match(source, /vw-suite/, '套件台容器');
  assert.match(source, /vw-app-list/, '左应用栏');
  assert.match(source, /vw-suite-main/, '中内容');
  assert.match(source, /ctx\.renderRail/, '右检查器');
});

test('中栏底部三个按钮，且「建任务」是反向深链', () => {
  const source = codeOf();
  assert.match(source, /button\('建任务'/, '有建任务');
  assert.match(source, /data: \{ action: 'new-task' \}/, '建任务有动作');
  // 视-6 的反向：跳到编队。
  assert.match(source, /ctx\.go\('\/fleet'\)/, '建任务跳到编队');
  assert.match(source, /button\('刷新'/, '有刷新');
  assert.match(source, /button\('嵌入原版'/, '有嵌入原版');
});

test('切换应用走 store，不自建 store', () => {
  const source = codeOf();
  assert.match(source, /state\.set\(\{ selectedAppId:/, '切换改 store');
  assert.doesNotMatch(source, /createStore\(/, '不自建 store');
});
