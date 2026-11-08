/**
 * Bot-9 的自测：自由对话 + 下钻。
 *
 *   node --test packages/app/test/chat-view.test.ts
 *
 * ## 两条是用户点名的硬要求
 *
 * > 下钻**不新开 store，只改 selection**
 * > 自由对话 —— 发一句要能看到回话
 *
 * 第一条最容易做错的方式是「下钻时 new 一个 ChatView / 新建一份 state」——
 * 那样界面上看起来对，但切走再回来消息就没了，而且编队台选中的任务与
 * 对话里正在聊的任务会各自记一份。
 *
 * ## 从真实 SSE 里学到的两件事（都吃了亏）
 *
 *   ① 事件名是通用的 `event: agent`，**真类型在 `data.type`**；
 *   ② 流式增量是 `token` + `delta`，而 `message` 是**整段重发** —— 两者都追加
 *      就会出现两遍一模一样的话（实测就是这样，页面上看得一清二楚）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const chatPath = join(viewsDir, 'chat.js');

function codeOf(): string {
  return readFileSync(chatPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ---------------------------------------------------------------------------------------------
 * 1. 下钻只改 selection
 * ------------------------------------------------------------------------------------------- */

test('下钻只改 selectedTaskId，不新建 store', () => {
  const source = codeOf();
  const body = /function drillInto\(taskId\)[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 drillInto');
  assert.match(body, /state\.set\(\{ selectedTaskId: taskId \}\)/, '改的是 selection');
  // 这条是用户原话的落点。
  assert.doesNotMatch(source, /createStore\(/, '整个模块都不能新建 store');
  assert.doesNotMatch(body, /new\s+Map\(|new\s+Set\(\).*state|Object\.create/, '不另起一份 state');
});

test('下钻会换会话（上下文不能混）', () => {
  const source = codeOf();
  const body = /function drillInto\(taskId\)[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  // 会话按 task_id 隔离；复用会把两个任务的上下文混在一起 ——
  // 那种混法在审计上查不出来（消息都对，只是不属于同一个任务）。
  assert.match(body, /selectedTaskId/, '读选中项');
  assert.match(source, /task_id: drill/, '建会话时带 task_id');
});

test('退出下钻把选中项清掉', () => {
  const source = codeOf();
  assert.match(source, /selectedTaskId: null/, '能清空');
  assert.match(source, /退出下钻/, '有退出入口');
});

/* ---------------------------------------------------------------------------------------------
 * 2. SSE 解析（两处实测差异）
 * ------------------------------------------------------------------------------------------- */

test('事件类型优先取 data.type，不是 SSE 的 event 名', () => {
  const source = codeOf();
  const body = /function parseSseBlock\(raw\)[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 parseSseBlock');
  // 实测事件名是通用的 `event: agent`，真类型在 data.type 里。
  assert.match(body, /data\.type/, '读 data.type');
  assert.match(body, /typeof data\.type === 'string'/, '只认字符串');
});

test('流式增量收 token + delta，且 message 走替换不是追加', () => {
  const source = codeOf();
  // ① 增量：实测叫 `token` 带 `delta`。
  assert.match(source, /type === 'token'/, '认 token');
  assert.match(source, /data\.delta/, '读 delta');
  // ② 整段重发：`message` 到达时以它为准，不能追加 ——
  //    两者都追加会出现两遍一模一样的话。
  assert.match(source, /data\.role/, '看 role 区分用户/助手');
  assert.match(source, /assistant\.content = full/, 'message 时替换');
  assert.doesNotMatch(
    /if \(type === 'message'\)[\s\S]{0,400}?assistant\.content \+=/.exec(source)?.[0] ?? '',
    /\+=/,
    'message 分支不能追加',
  );
});

test('用户那条不重复贴（发时已贴过）', () => {
  const source = codeOf();
  assert.match(source, /if \(who === 'user'\) return assistant/, '跳过用户消息事件');
});

test('认不得的事件不丢，记在最后一条消息上', () => {
  const source = codeOf();
  // 静默丢弃会让「少了一截」无从排查。
  assert.match(source, /assistant\.unknown/, '记下未知事件类型');
});

/* ---------------------------------------------------------------------------------------------
 * 3. 自由对话
 * ------------------------------------------------------------------------------------------- */

test('发消息：先贴用户那句，再发请求', () => {
  const source = codeOf();
  const body = /async function sendMessage\(text\)[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 sendMessage');
  const putUser = body.indexOf("role: 'user'");
  const doFetch = body.indexOf('fetch(');
  assert.ok(putUser > 0 && doFetch > 0, '两件事都在');
  // 等回包再贴会让人觉得「点了没反应」。
  assert.ok(putUser < doFetch, '先贴用户消息，再发请求');
});

test('建会话：读 session_id（实测字段），不是 id', () => {
  const source = codeOf();
  assert.match(source, /body\.session_id \|\| body\.id/, '两个都收，session_id 优先');
});

test('发送失败给人话 + 下一步（错误提示三要素）', () => {
  const source = codeOf();
  assert.match(source, /type: 'error'/, '有错误卡');
  // renderErrorCard 读 message / errorClass，字段名必须对上，否则显示「没有给出原因」。
  assert.match(source, /message: `这一句没有发出去/, '给 message');
  assert.match(source, /errorClass:/, '给 errorClass');
  assert.match(source, /agent 服务是否在跑/, '给下一步');
});

/* ---------------------------------------------------------------------------------------------
 * 4. 规矩一：审批未决时禁用输入框
 * ------------------------------------------------------------------------------------------- */

test('审批未决时禁用输入框并说明原因', () => {
  const source = codeOf();
  assert.match(source, /function syncApprovalGate/, '有审批门');
  assert.match(source, /input\.disabled = blocked/, '禁用输入框');
  assert.match(source, /需要先处理上面的审批/, '说明原因');
  // 判断依据是消息流里有没有未决审批卡，不另存一份状态。
  assert.match(source, /type === 'approval' && card\.status === 'pending'/, '按未决卡判断');
});

test('审批结论带理由上去（拒绝必填）', () => {
  const source = codeOf();
  const body = /async function decideApproval\(card, decision, payload\)[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 decideApproval');
  // 理由必须一起进审批记录，不能只留在界面上。
  assert.match(body, /reason: payload\?\.reason/, '带上 reason');
  assert.match(body, /note: payload\?\.note/, '带上 note');
});

/* ---------------------------------------------------------------------------------------------
 * 5. 卡片复用 agent/cards.js（同一张卡不能有两种长相）
 * ------------------------------------------------------------------------------------------- */

test('卡片复用 web/agent/cards.js 的渲染函数', () => {
  const source = readFileSync(chatPath, 'utf8');
  for (const fn of ['renderMessage', 'renderToolCard', 'renderApprovalCard', 'renderErrorCard']) {
    assert.match(source, new RegExp(`${fn}[,\\s]`), `复用 ${fn}`);
  }
  assert.match(source, /from '\.\.\/agent\/cards\.js'/, '从 agent/cards.js 导入');
});
