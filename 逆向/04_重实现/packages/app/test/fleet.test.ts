/**
 * 视-2 的自测：编队台的结构、任务树、干预可用性。
 *
 *   node --test packages/app/test/fleet.test.ts
 *
 * ## 为什么这些要单独测
 *
 * 第 26.16 节把「`/fleet` 还是地图」列为第一条错法。这条错法有个特点：
 * 页面能打开、不报错，只是**干的不是编队这件事**。所以这里断言的是
 * 「四块在不在、任务树有没有耗时列、三种干预的可用性对不对」，
 * 而不是「页面能渲染」。
 *
 * 另一条要守的是文案：25.10.5 说「暂停」写成「已暂停」是**全项目最容易做错的
 * 一处文案**，因为点下去那一刻任务真的还在跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const viewsDir = join(appDir, 'src', 'web', 'views');

/** 去掉注释：断言只该看真代码，注释里「解释为什么不能这么写」不该算违规。 */
function codeOf(name: string): string {
  const raw = readFileSync(join(viewsDir, name), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 抽出所有字符串字面量，用于精确的文案断言。 */
function literalsOf(name: string): string[] {
  return [...codeOf(name).matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((match) => match[1] ?? match[2]);
}

/* ---------------------------------------------------------------------------------------------
 * 1. 结构与文案
 * ------------------------------------------------------------------------------------------- */

test('编队台四块齐：概览 / 任务树 / 事件流 / 干预', () => {
  const source = codeOf('fleet.js');
  // 第 25.10.1 节的四块，少一块就不是编队台。
  assert.match(source, /section\('任务树'/, '有任务树');
  assert.match(source, /section\('事件流'/, '有事件流');
  assert.match(source, /section\('干预'/, '有干预块');
  assert.match(source, /paintOverview/, '有概览');
  // 概览的四个数字：运行 / 等人批 / 完成 / 失败。
  assert.match(source, /OVERVIEW_KEYS = \['running', 'awaiting', 'done', 'failed'\]/);
});

test('概览不显示 pending（排队不算用户要关心的事）', () => {
  const source = codeOf('fleet.js');
  const keys = /OVERVIEW_KEYS = \[([^\]]+)\]/.exec(source);
  assert.ok(keys);
  assert.doesNotMatch(keys[1], /pending/, 'pending 不进概览的四个数字');
  // 但排队很多时要给小字（附录 C.4 点一自己标为缺陷）。
  assert.match(source, /排队/, 'pending 很多时给一行小字');
});

test('任务树有耗时列（25.10.3 点名最容易被砍的一列）', () => {
  const source = codeOf('fleet.js');
  const css = readFileSync(join(viewsDir, 'blocks.css'), 'utf8');
  // 「用户判断正常不正常主要靠它」——有耗时列才谈得上这件事。
  assert.match(source, /vw-tree-duration/, '任务树有耗时格');
  assert.match(source, /text: '耗时'/, '表头写明「耗时」');
  assert.match(css, /\.vw-tree-duration\s*\{[^}]*text-align: right/, '耗时右对齐');
  assert.match(css, /\.vw-tree-duration\s*\{[^}]*tabular-nums/, '耗时等宽数字');
});

test('任务树也有进度列（2/5 是最有信息量的那个）', () => {
  const source = codeOf('fleet.js');
  assert.match(source, /vw-tree-progress/, '有进度格');
  assert.match(source, /\$\{finished\}\/\$\{total\}/, '进度是「完成/总数」');
});

test('任务树只读 task.task_id 当主键，不读 task.id', () => {
  const source = codeOf('fleet.js');
  // A 线 Bot-7 把 task.id 改成 task_id；兼容分支会让「字段没对上」静默降级。
  assert.doesNotMatch(source, /task\.id\b(?!_)/, '不能读 task.id');
  assert.doesNotMatch(source, /task_id\s*\|\|/, '不能写兼容分支');
  assert.match(source, /taskId\(task\)/, '主键统一走 state.js 的 taskId()');
});

test('「暂停」文案是「将在当前步骤完成后生效」，渲染文案里不出现「已暂停」', () => {
  const literals = literalsOf('fleet.js');
  assert.ok(
    literals.some((text) => text.includes('将在当前步骤完成后生效')),
    '必须有这句',
  );
  for (const text of literals) {
    assert.ok(!text.includes('已暂停'), `文案里不能出现「已暂停」，发现：${text}`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * 2. 三种干预的可用性（25.10.4）
 * ------------------------------------------------------------------------------------------- */

/**
 * 把 `interventionAvailability` 的判断规则单独实现一遍来验。
 *
 * 不直接 import fleet.js 的原因：它 `mount()` 就要真实 DOM 与 store。
 * 这里复制的是**同一条规则**，并且同时断言源码里那三个分支真的在
 * （两边都在才算数）。
 */
function availability(tree: {
  root?: { status?: string };
  steps?: Array<{ status?: string }>;
}) {
  const steps = tree.steps || [];
  const anyRunning = steps.some((step) => step.status === 'running');
  const anyFailed = steps.some((step) => step.status === 'failed');
  const taskRunning = tree.root?.status === 'running';
  return {
    pause: taskRunning || anyRunning,
    retry: anyFailed,
    takeover: anyRunning || anyFailed,
  };
}

test('三种干预的可用性规则正确', () => {
  // 任务在跑、没有失败步骤：只能暂停与接管，不能改参重试。
  assert.deepEqual(
    availability({ root: { status: 'running' }, steps: [{ status: 'done' }, { status: 'running' }] }),
    { pause: true, retry: false, takeover: true },
  );

  // 有失败步骤：三个都能用。
  assert.deepEqual(
    availability({ root: { status: 'failed' }, steps: [{ status: 'failed' }] }),
    { pause: false, retry: true, takeover: true },
  );

  // 全跑完：都不能用。
  assert.deepEqual(
    availability({ root: { status: 'done' }, steps: [{ status: 'done' }, { status: 'skipped' }] }),
    { pause: false, retry: false, takeover: false },
  );

  // 源码里确实按这三条判断。
  const source = codeOf('fleet.js');
  assert.match(source, /taskRunning \|\| anyRunning/, '暂停看「任务在跑或某步在跑」');
  assert.match(source, /enabled: anyFailed/, '改参重试看「有失败步骤」');
  assert.match(source, /enabled: anyRunning \|\| anyFailed/, '接管看「有跑着或失败的步骤」');
});

test('不可用的干预要给出理由（灰掉不说为什么，用户以为界面坏了）', () => {
  const source = codeOf('fleet.js');
  assert.match(source, /why:/, '每个按钮带理由');
  assert.match(source, /buttonEl\.title = info\.why/, '理由进 title');
  assert.match(source, /'aria-disabled'/, '读屏也要知道');
  // 理由要是人话，不是状态码。
  assert.match(source, /当前没有失败的步骤/, '理由是人话');
});

/* ---------------------------------------------------------------------------------------------
 * 3. 数据来源与「不造假」
 * ------------------------------------------------------------------------------------------- */

test('接口没接上时显示「还没接上」，不显示「没有任务」', () => {
  const source = codeOf('fleet.js');
  // 这两句对用户意味着完全不同的下一步：一个是「去建一个」，一个是「等接口」。
  assert.match(source, /任务树还拿不到数据/, '说清是拿不到，不是没有');
  assert.match(source, /不是「没有任务」，是「还没接上」/, '把区别写进文案');
  assert.match(source, /unavailable/, '有不可用状态');
});

test('端点集中在一处，接口定了只改那一处', () => {
  const source = codeOf('fleet.js');
  assert.match(source, /export const BOTD_ENDPOINTS/, '端点集中导出');
  for (const name of ['forest', 'tree', 'events', 'pending', 'intervene']) {
    assert.match(source, new RegExp(`${name}:`), `有 ${name} 端点`);
  }
  // 用 task_id 作查询参数名（与后端方法签名一致）。
  assert.match(source, /task_id=\$\{encodeURIComponent/, '查询参数用 task_id');
});

test('取数走 store 的缓存（切视角回来不重新请求）', () => {
  const source = codeOf('fleet.js');
  assert.match(source, /ensure\(/, '用 ensure 而非裸 fetch');
  assert.equal((source.match(/from '\.\/state\.js'/g) || []).length, 1, '从 state.js 取 store 工具');
  assert.doesNotMatch(source, /createStore\(/, '不能自建 store');
});

test('耗时显示：没有时间戳就显示「—」，不猜', () => {
  const source = codeOf('fleet.js');
  assert.match(source, /elapsedMs\(/, '用 elapsedMs 算');
  assert.match(source, /if \(ms === null\) return '—'/, '缺时间戳就 —');
});
