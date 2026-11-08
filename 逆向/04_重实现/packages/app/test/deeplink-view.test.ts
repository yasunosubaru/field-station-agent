/**
 * 视-6 的自测：深链两个方向，在前端这一侧。
 *
 *   node --test packages/app/test/deeplink-view.test.ts
 *
 * ## 两个方向
 *
 * | 方向 | 例子 |
 * |---|---|
 * | 正向 | `fsa://device/WUHN-1` → 套件视角选中该设备 |
 * | 反向 | 套件选中 → 「建任务」→ 编队预填 |
 *
 * Electron 主进程那一侧的解析（14 类畸形输入）在
 * `shell/electron/test/deeplink.test.js` 里测；这里测**页面这一侧**：
 * 参数怎么进 store、反向怎么把草稿交给编队、以及「不新开 store」这条。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..', '..', '..');
const viewsDir = join(appDir, 'src', 'web', 'views');

function codeOf(name: string): string {
  return readFileSync(join(viewsDir, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ---------------------------------------------------------------------------------------------
 * 1. 正向：URL 参数 → selection
 * ------------------------------------------------------------------------------------------- */

test('正向深链把 id 写进 store 的 selection，不新建 store', () => {
  const shell = codeOf('shell.js');
  const body = /function applyDeepLink\(\)[\s\S]*?\n\}/.exec(shell)?.[0] ?? '';
  assert.ok(body, 'shell.js 要有 applyDeepLink');

  // `?device=` → selectedDeviceId；`?job=` → selectedTaskId。
  assert.match(body, /params\.get\('device'\)/, '读 device 参数');
  assert.match(body, /params\.get\('job'\)/, '读 job 参数');
  assert.match(body, /selectedDeviceId = device/, '写进 selectedDeviceId');
  assert.match(body, /selectedTaskId = job/, '写进 selectedTaskId');
  // 下钻与深链共用同一份 selection —— 不新开 store（Bot-9 的同一条原则）。
  assert.doesNotMatch(body, /createStore\(/, '深链不能新建 store');
  assert.match(shell, /state\.set\(patch\)/, '走 store.set');
});

test('深链参数用完就从地址栏抹掉', () => {
  const shell = codeOf('shell.js');
  // 留着它，用户每刷新一次都会被「重新深链」一次，而那时他可能已经换了选择。
  assert.match(shell, /history\.replaceState\([\s\S]{0,120}?location\.pathname\)/, '抹掉查询串保留路径');
  // 明确不要用 pushState（那会多一条历史，后退键要按两次才回到上一屏）。
  const body = /function applyDeepLink\(\)[\s\S]*?\n\}/.exec(shell)?.[0] ?? '';
  assert.doesNotMatch(body, /pushState/, '用 replaceState，不新增历史');
});

test('boot() 里真的调了 applyDeepLink', () => {
  const shell = codeOf('shell.js');
  const boot = /function boot\(\)[\s\S]*?\n\}/.exec(shell)?.[0] ?? '';
  assert.match(boot, /applyDeepLink\(\)/, 'boot 要消费深链参数');
});

/* ---------------------------------------------------------------------------------------------
 * 2. 反向：套件 → 编队
 * ------------------------------------------------------------------------------------------- */

test('反向深链：套件台「建任务」把设备带到编队', () => {
  const suite = codeOf('suite.js');
  const body = /if \(action === 'new-task'\)[\s\S]{0,600}?\n    \}/.exec(suite)?.[0] ?? '';
  assert.ok(body, '有建任务分支');
  assert.match(body, /selectedDeviceId/, '读当前设备');
  assert.match(body, /selectedTaskDraft/, '写预填草稿');
  assert.match(body, /ctx\.go\('\/fleet'\)/, '跳到编队');
  assert.doesNotMatch(body, /fetch\(/, '不在这里就直接建任务（跳过去是导航，建任务是下一步）');
});

test('反向只写草稿，不自动建任务', () => {
  const fleet = codeOf('fleet.js');
  // 跳过来是一次导航，建任务是用户按下去之后的事 —— 混在一起会出现
  // 「点了一下就产生了一个没人想要的空任务」。
  assert.match(fleet, /selectedTaskDraft/, '编队读草稿');
  assert.match(fleet, /button\('建这个任务'/, '给一个明确的建按钮');
  assert.match(fleet, /dismiss-draft/, '可以取消');
  // 建草稿那一步不能假装成功。
  assert.match(fleet, /不假装建成|接口还没接上/, '说清卡在哪');
});

test('草稿字段的默认值是 null（不是空对象）', () => {
  const state = codeOf('state.js');
  // 空对象会让 `if (draft)` 永远为真，于是编队台一进去就显示一条空预填。
  assert.match(state, /selectedTaskDraft:\s*null/, '默认 null');
});

/* ---------------------------------------------------------------------------------------------
 * 3. 与 Electron 侧对齐
 * --------------------------------------------------------------------------------------------- */

test('前端的参数名与主进程送的参数名一致', () => {
  const shell = codeOf('shell.js');
  const main = readFileSync(join(repoRoot, 'shell', 'electron', 'main.js'), 'utf8');
  // 主进程送 `?device=` 与 `?job=`，页面必须读同样的名字。
  // 两边一旦分叉，深链会「打开正确页面但不选中任何东西」—— 最难发现的一类。
  for (const param of ['device', 'job']) {
    assert.match(shell, new RegExp(`params\\.get\\('${param}'\\)`), `页面读 ${param}`);
    assert.match(main, new RegExp(`'${param}'`), `主进程送 ${param}`);
  }
});

test('主进程的解析已抽成可测模块，且 main.js 不再重复实现', () => {
  const main = readFileSync(join(repoRoot, 'shell', 'electron', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/deeplink\.js'\)/, 'main.js 引用 deeplink.js');
  // 内联实现若还在，两边会各自演化 —— 那正是「同一套标准」失守的方式。
  assert.doesNotMatch(main, /function parseDeepLink/, 'main.js 不能自己再实现一遍');
  // 字符集也只能有一份。
  assert.doesNotMatch(main, /\[A-Za-z0-9\._-\]\{1,128\}/, '字符集只在 deeplink.js 里');
});
