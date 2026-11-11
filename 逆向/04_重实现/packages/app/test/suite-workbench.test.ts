/**
 * 套件台（视-4 重做）的自测：三栏、六应用、五档徽章、表格三条阅读性要求、检查器空态。
 *
 *   node --test packages/app/test/suite-workbench.test.ts
 *
 * ## 与 `suite-view.test.ts` 的分工
 *
 * 那一份钉的是**纪律**（六个应用 = 五核心 + Perception、`matched` 不出眼、
 * 解析真实产物得 62/32/20/0/15/129），守着不被改坏。
 * 这一份钉的是**这一版重做出来的东西**：
 *
 *   · 三栏真的是三栏（左导航 / 中内容 / 右检查器各有独立落点）；
 *   · 五档徽章的记号 / 色档 / 中文名一一对应，`matched` 仍然不出眼；
 *   · 表格三条阅读性要求（固定表头 / 数字右对齐 / 密度可切）在 CSS 里真的落了；
 *   · `INSPECTOR_ENDPOINT` 拿不到时**说清是哪一步没成**，不假装全 matched。
 *
 * ## 为什么徽章那几条要写成表
 *
 * 五个状态里三个是灰的（`matched` / `unverified` / `not_applicable`），
 * 很容易在「统一一下配色」时被一起改成绿的。一屏 100 个绿的会让 3 个橙淹没掉 ——
 * 所以每一档的 `tone` 与 `glyph` 都单独钉住，改错了立刻红。
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
const cssPath = join(viewsDir, 'blocks.css');

function rawCode(): string {
  return readFileSync(suitePath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function cssCode(): string {
  // 去掉 CSS 注释：注释里写「不许用阴影」不该被当成用了阴影。
  return readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ---------------------------------------------------------------------------------------------
 * 1. 三栏
 * ------------------------------------------------------------------------------------------- */

test('三栏各有独立落点：左导航 / 中内容 / 右检查器', () => {
  const source = rawCode();
  assert.match(source, /cls: 'vw-suite'/, '套件台容器');
  assert.match(source, /cls: 'vw-app-list'[\s\S]{0,120}?'?nav'?|el\('nav'/, '左栏是 nav');
  assert.match(source, /cls: 'vw-suite-main'/, '中栏有自己的容器');
  assert.match(source, /cls: 'vw-app-body'/, '中栏内容区');
  assert.match(source, /ctx\.renderRail/, '右栏由检查器填');

  // 三栏 CSS：左窄 + 中自适应。
  const css = cssCode();
  const block = /\.vw-suite\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(block, /display:\s*grid/, '三栏用 grid');
  assert.match(block, /grid-template-columns:\s*\d+px\s+minmax\(0,\s*1fr\)/, '左列定宽 + 中列自适应');
});

test('中栏顶部写清当前应用（截图时不用猜这是哪一屏）', () => {
  const source = rawCode();
  assert.match(source, /vw-app-bar/, '有应用头栏');
  assert.match(source, /vw-app-bar-name/, '有应用名');
  assert.match(source, /app\.fullName \|\| app\.label/, '全名优先，缺了退回短名');
  // 「已安装 · N 块」让用户知道这一栏该有几块。
  assert.match(source, /已安装 · \$\{blocks\.length\} 块/, '说清已装与块数');
});

/* ---------------------------------------------------------------------------------------------
 * 2. 六应用
 * ------------------------------------------------------------------------------------------- */

test('六应用短名与全名分开，导航里放不下全名也说得清', async () => {
  const { APPS } = await import(suiteUrl);
  assert.equal(APPS.length, 6);
  // 导航短名被旧的 suite-view.test.ts 逐字钉住，这里再钉一次：改名字要两边一起改。
  assert.deepEqual(APPS.map((app: { label: string }) => app.label),
    ['Manage', 'Playback', 'Convert', 'GRIT', 'Graph', 'Perception']);
  // 全名：GRIT Monitor / Perception Viewer 是用户点名的两个叫法。
  const byId = Object.fromEntries(APPS.map((app: { id: string; fullName: string }) => [app.id, app.fullName]));
  assert.equal(byId.grit, 'GRIT Monitor');
  assert.equal(byId.perception, 'Perception Viewer');
  // 每个都有全名，不留空。
  for (const app of APPS as Array<{ id: string; fullName: string }>) {
    assert.ok(app.fullName && app.fullName.length > 0, `${app.id} 有全名`);
  }
});

test('每个应用有几何图标（不是 emoji —— 25.4.2）', async () => {
  const { APPS, APP_GLYPHS } = await import(suiteUrl);
  for (const app of APPS as Array<{ id: string }>) {
    const glyph = APP_GLYPHS[app.id];
    assert.ok(glyph, `${app.id} 有图标`);
    assert.doesNotMatch(glyph, /\p{Extended_Pictographic}/u, `${app.id} 的图标不能是 emoji`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * 3. 五档徽章
 * ------------------------------------------------------------------------------------------- */

test('五档徽章：记号 / 色档 / 中文名一一对应', async () => {
  const { FIELD_STATES } = await import(suiteUrl);
  const keys = Object.keys(FIELD_STATES);
  assert.equal(keys.length, 5, `正好五档，实际 ${keys.length}`);
  assert.deepEqual(keys.slice().sort(),
    ['a_only', 'b_only', 'matched', 'not_applicable', 'unverified']);

  const expected: Record<string, { glyph: string; tone: string; name: string }> = {
    matched: { glyph: '·', tone: 'quiet', name: '一致' },
    b_only: { glyph: '+', tone: 'add', name: 'B 独占' },
    a_only: { glyph: '−', tone: 'miss', name: 'A 独占' },
    unverified: { glyph: '?', tone: 'quiet', name: '未核对' },
    not_applicable: { glyph: '~', tone: 'quiet', name: '不适用' },
  };
  for (const [key, want] of Object.entries(expected)) {
    const got = FIELD_STATES[key as keyof typeof FIELD_STATES];
    assert.ok(got, `有 ${key} 这一档`);
    assert.equal(got.glyph, want.glyph, `${key} 的记号`);
    assert.equal(got.tone, want.tone, `${key} 的色档`);
    assert.equal(got.name, want.name, `${key} 的中文名`);
  }
});

test('单元格里的短写只为放得下，全名仍然可读（title + 图例）', async () => {
  const { FIELD_STATES } = await import(suiteUrl);
  // `~ not_applicable` 是 16 个等宽字符，78px 的状态列放不下（实测被截成 `~ not_appl`）。
  // 缩成 `n/a` 是缩宽度，不是缩信息：`label` 仍是全名，图例里写着全名。
  assert.equal(FIELD_STATES.not_applicable.label, 'not_applicable', 'label 仍是全名');
  assert.equal(FIELD_STATES.not_applicable.short, 'n/a', '表格里用短写');

  const source = rawCode();
  // 单元格用 short，title 给全名 —— 悬停能读到 `~ not_applicable · 不适用`。
  assert.match(source, /stateInfo\.short \?\? stateInfo\.label/, '单元格用 short，缺了退回 label');
  assert.match(source, /title: `\$\{stateInfo\.glyph\} \$\{stateInfo\.label\} · \$\{stateInfo\.name\}`/, 'title 给全名');
});

test('matched 不出眼（灰）；只有差异两档有色', async () => {
  const { FIELD_STATES } = await import(suiteUrl);
  // 25.12.3：用户关心的是**对不上的**。一屏 100 个绿会让 3 个橙淹没掉。
  assert.equal(FIELD_STATES.matched.tone, 'quiet', 'matched 是灰');
  assert.equal(FIELD_STATES.unverified.tone, 'quiet', 'unverified 也是灰（没核对 ≠ 有差异）');
  assert.equal(FIELD_STATES.not_applicable.tone, 'quiet', '不适用也是灰（明确不做）');
  // 反过来：两档差异必须有颜色，否则「对不上的」也看不见。
  assert.equal(FIELD_STATES.b_only.tone, 'add');
  assert.equal(FIELD_STATES.a_only.tone, 'miss');

  const css = cssCode();
  assert.match(css, /\.vw-tag\[data-tone="quiet"\][\s\S]{0,200}?color:\s*var\(--dim\)/, 'quiet 最淡');
  assert.match(css, /\.vw-tag\[data-tone="add"\][\s\S]{0,200}?color:\s*var\(--accent\)/, 'b_only 用强调色');
  assert.match(css, /\.vw-tag\[data-tone="miss"\][\s\S]{0,200}?color:\s*var\(--warn\)/, 'a_only 用警告色');
});

test('图例按「差异在前、无差异在后」排（先看到要处理的）', async () => {
  const { FIELD_STATE_ORDER } = await import(suiteUrl);
  assert.deepEqual(FIELD_STATE_ORDER,
    ['b_only', 'a_only', 'unverified', 'matched', 'not_applicable'],
    '两档差异排在最前');
  // 界面真的用它排图例。
  assert.match(rawCode(), /FIELD_STATE_ORDER\.map/, '图例按 FIELD_STATE_ORDER 生成');
  assert.match(rawCode(), /vw-legend/, '有图例');
});

/* ---------------------------------------------------------------------------------------------
 * 4. 表格三条阅读性要求
 * ------------------------------------------------------------------------------------------- */

test('固定表头：thead th 是 sticky top', () => {
  const css = cssCode();
  const block = /\.vw-inspector-wrap table\.clean thead th\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.ok(block, '有表头规则');
  assert.match(block, /position:\s*sticky/, '表头固定');
  assert.match(block, /top:\s*0/, '固定在顶部');
  // 不透明底色：透过去的话下面的行会从表头文字之间穿出来。
  assert.match(block, /background:\s*var\(--panel\)/, '有不透明底色');
  // 不许用阴影分隔（三个不许用）。
  assert.doesNotMatch(block, /box-shadow/, '不用阴影');
});

test('三档密度真的改行高（不是只换一个 class 名）', () => {
  const css = cssCode();
  for (const [mode, min] of [['compact', 1], ['roomy', 5]] as Array<[string, number]>) {
    const block = new RegExp(`\\.vw-inspector-wrap\\[data-density="${mode}"\\][^{]*\\{([\\s\\S]*?)\\}`).exec(css)?.[1] ?? '';
    assert.ok(block, `${mode} 档有规则`);
    const padding = /padding:\s*(\d+)px/.exec(block);
    assert.ok(padding, `${mode} 档有 padding`);
    assert.ok(Number(padding[1]) >= min, `${mode} 档的 padding 要真的不同（${padding[1]}px）`);
  }
});

test('数字右对齐：行号单独走 .num（一列行号能纵向比大小）', async () => {
  const { splitPath } = await import(suiteUrl);
  assert.deepEqual(
    splitPath('逆向/01_解包/app/view/convert/convert.html:103'),
    { file: 'convert.html', line: '103' },
  );
  // 没有行号时只给文件名，不编一个 0。
  assert.deepEqual(splitPath('逆向/01_解包/app/view/x/y.js'), { file: 'y.js', line: '' });
  assert.deepEqual(splitPath(''), { file: '—', line: '' });
  assert.deepEqual(splitPath(null), { file: '—', line: '' });

  const source = rawCode();
  assert.match(source, /cls: 'num vw-path-line'/, '行号走 .num');
  assert.match(source, /cls: 'vw-path-cell'/, '位置格是两段式');
  const css = cssCode();
  assert.match(css, /\.vw-path-line\s*\{[^}]*font-variant-numeric:\s*tabular-nums|\.vw-path-line\s*\{[^}]*font-family:\s*var\(--mono\)/,
    '行号等宽');
});

test('密度可切：三档，只改行高不重排数据', async () => {
  const { ROW_DENSITIES } = await import(suiteUrl);
  assert.equal(ROW_DENSITIES.length, 3, '三档');
  assert.deepEqual(ROW_DENSITIES.map((row: { id: string }) => row.id), ['compact', 'comfort', 'roomy']);
  for (const row of ROW_DENSITIES as Array<{ id: string; label: string; note: string }>) {
    assert.ok(row.label.length > 0, `${row.id} 有中文名`);
    assert.ok(row.note.length > 0, `${row.id} 有说明`);
  }

  const source = rawCode();
  assert.match(source, /vw-density-ctl/, '有密度控件');
  assert.match(source, /aria-pressed/, '当前档有 aria-pressed（不只靠颜色）');
  assert.match(source, /data: \{ density: density\.id \}/, '每档带 data-density');
  // 切换写回 rowDensity 并重画。
  assert.match(source, /rowDensity = density\.dataset\.density/, '切换写回状态');
  assert.match(source, /data: \{ density: rowDensity \}/, '表格带上当前档');

  const css = cssCode();
  assert.match(css, /\.vw-inspector-wrap\[data-density="compact"\]/, '紧凑档有样式');
  assert.match(css, /\.vw-inspector-wrap\[data-density="roomy"\]/, '宽松档有样式');
});

/* ---------------------------------------------------------------------------------------------
 * 5. 检查器：拿不到时说清是哪一步
 * ------------------------------------------------------------------------------------------- */

test('拿不到时给具体的失败原因，不写「失败」两个字', () => {
  const source = rawCode();
  // HTTP 状态与网络错误都要落到文案里。
  assert.match(source, /HTTP \$\{response\.status\}/, 'HTTP 状态进原因');
  assert.match(source, /接口 \$\{INSPECTOR_ENDPOINT\} 返回/, '原因里带端点');
  // 通了但解析出 0 行是另一件事，必须分开说 —— 否则「表头变了」会被说成「没接上」。
  assert.match(source, /没解析出任何对照行/, '解析为 0 行单独报');
  assert.match(source, /markdown\.length/, '报出实际字节数');
  // 仍然不假装全 matched。
  assert.match(source, /不假装全 matched/, '文案里写明这一点');
  assert.match(source, /suite_field_parity\.py/, '说清对照表由谁生成');
  assert.match(source, /INSPECTOR_ENDPOINT/, '端点集中一处');
});

test('统计里差异口径只算 b_only + a_only', async () => {
  const { parityConclusion } = await import(suiteUrl);
  // unverified（没核对）与 not_applicable（明确不做）不算差异 ——
  // 把它们算进去会把「没核对 / 不做」误报成「漏做」。
  const withNoise = parityConclusion({ total: 129, matched: 62, b_only: 32, a_only: 20, unverified: 5, not_applicable: 15 });
  assert.match(withNoise.text, /对不上 52 条/, '差异是 32 + 20');
  assert.match(withNoise.text, /32 B 独占/, '分项写清');
  assert.match(withNoise.text, /20 A 独占/, '分项写清');
  assert.equal(withNoise.tone, 'warn');

  const clean = parityConclusion({ total: 10, matched: 10, b_only: 0, a_only: 0, unverified: 0, not_applicable: 0 });
  assert.equal(clean.tone, 'ok');
  assert.match(clean.text, /10\/10 对得上/);

  // 没有数据时不给结论（不能凭空说「全对得上」）。
  assert.equal(parityConclusion(null).text, '');
  assert.equal(parityConclusion({ total: 0 }).text, '');
});

test('真实产物解析出的数字仍然对得上（这一版没有改动口径）', async () => {
  const { parseParityMarkdown, parityConclusion } = await import(suiteUrl);
  const mdPath = join(repoRoot, 'docs', 'operations', 'suite-field-parity.md');
  assert.ok(existsSync(mdPath), '对照表应已提交');
  const parsed = parseParityMarkdown(readFileSync(mdPath, 'utf8'));

  assert.equal(parsed.summary.matched, 62);
  assert.equal(parsed.summary.b_only, 32);
  assert.equal(parsed.summary.a_only, 20);
  assert.equal(parsed.summary.unverified, 0);
  assert.equal(parsed.summary.not_applicable, 15);
  assert.equal(parsed.summary.total, 129);

  // 界面上那句结论要能直接由这些数字算出来。
  const conclusion = parityConclusion(parsed.summary);
  assert.match(conclusion.text, /对不上 52 条/);
});

/* ---------------------------------------------------------------------------------------------
 * 6. 其它结构
 * ------------------------------------------------------------------------------------------- */

test('建任务仍是反向深链（跳编队 + 只写草稿）', () => {
  const source = rawCode();
  const body = /if \(action === 'new-task'\)[\s\S]{0,700}?\n    \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有建任务分支');
  assert.match(body, /selectedTaskDraft/, '写草稿');
  assert.match(body, /ctx\.go\('\/fleet'\)/, '跳编队');
  assert.doesNotMatch(body, /fetch\(/, '不在这里就建任务');
});

test('Perception 未装时给「未安装」+ 安装按钮，且两个 data-* 不混用', () => {
  const source = rawCode();
  assert.match(source, /未安装/, '说出来');
  assert.match(source, /安装 \$\{app\.label\}/, '给安装按钮');
  // `data-app-id` 只给导航项：混用会让「有几个应用」的遍历数出 7 个。
  assert.equal([...source.matchAll(/data: \{ appId: app\.id \}/g)].length, 1, 'data-app-id 只有导航项');
  assert.ok([...source.matchAll(/installApp: app\.id/g)].length >= 2, '安装按钮都用 installApp');
});
