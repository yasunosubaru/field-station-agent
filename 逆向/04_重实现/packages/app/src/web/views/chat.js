/**
 * 对话视角（视-0 骨架 → Bot-9 的自由对话 + 下钻）。
 *
 * ## 本文件在视-0 时负责什么
 *
 * 只负责「这一块长什么样」与「空态该说什么」，不接后端。理由：
 * 第 25.1.1 节给场景一列了三条要求，其中两条是纯界面的事 ——
 * 「打开就能问」（不要先选菜单）、「一句话给结论」（不要一堆工具卡淹没结论）。
 *
 * ## 空态的六个设计点（附录 C.1）
 *
 * 其中三条落在本文件：
 *   · 三个例子必须覆盖三类能力：查数据 / 查统计 / 查知识
 *   · 右栏显示「还没有选中任务」—— 右栏空白会让用户以为这栏坏了
 *   · 没有「新对话」按钮（左导航的「对话」就是新对话）
 *
 * ## 为什么输入框在下、结论在上
 *
 * 消息流是「越往下越新」。所以输入框固定在下方，不随内容滚动。
 * 审批未决时它必须禁用并说明原因（附录 C.3 点三）—— 那条在视-1 接审批卡时打开。
 */

import { el, empty, section, kv, button } from './dom.js';

/** 三个例子，覆盖三类能力。第一次打开时用户不知道「能问什么」，靠它开局。 */
const EXAMPLES = [
  { text: 'WUHN 昨天数据怎么样', kind: '查数据' },
  { text: 'ALIC 这个月的缺测率', kind: '查统计' },
  { text: '帮我查一下规程 4.2 条', kind: '查知识' },
];

export function mount(ctx) {
  const { main, head, state } = ctx;

  /* —— 页头：视角名 + 会话标题 + 该视角的操作（附录 C.7） —— */
  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '对话' }),
    el('div', {
      cls: 'vw-view-context',
      children: [el('span', { text: '新会话' })],
    }),
    el('div', {
      cls: 'vw-view-head-actions',
      children: [
        button('清空', { variant: 'text', data: { action: 'clear' } }),
      ],
    }),
  );

  /* —— 中栏：空态（还没有消息时）—— */
  const stream = el('div', { cls: 'vw-chat-stream', data: { chatStream: '' } });

  function paintEmpty() {
    stream.replaceChildren(el('div', { cls: 'vw-chat-hero', children: [
      el('p', { cls: 'vw-chat-hero-title', text: '野外台站智能体' }),
      el('p', { cls: 'vw-chat-hero-note', text: '问一句开始。' }),
      el('p', { cls: 'vw-chat-hero-examples-label', text: '例：' }),
      el('ul', {
        cls: 'vw-chat-hero-examples',
        children: EXAMPLES.map((example) => el('li', {
          cls: 'vw-chat-hero-example',
          children: [
            el('button', {
              cls: 'vw-chat-example-btn',
              text: example.text,
              attr: { type: 'button' },
              data: { example: example.text },
            }),
            el('span', { cls: 'unit', text: example.kind }),
          ],
        })),
      }),
    ] }));
  }
  paintEmpty();

  /* —— 输入区：固定在下方 —— */
  const input = el('textarea', {
    cls: 'vw-chat-input',
    attr: {
      rows: '2',
      placeholder: '输入…（Ctrl+Enter 发送）',
      'aria-label': '输入消息',
    },
  });

  const send = button('发送', { variant: 'primary', data: { action: 'send' } });

  const composer = el('form', {
    cls: 'vw-chat-composer',
    attr: { 'data-chat-composer': '' },
    children: [input, send],
  });

  main.append(stream, composer);

  /* —— 右栏：还没有选中任务时也要说清，不能空着（附录 C.1 点二） —— */
  ctx.renderRail((rail) => {
    const { selectedTaskId } = state.get();
    rail.replaceChildren(
      section('当前任务', null, [
        selectedTaskId
          ? kv([['任务', selectedTaskId]])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中的任务。' }),
      ]),
      section('最近任务', '（无）', [
        el('p', { cls: 'vw-rail-empty', text: '还没有任务。到编队台建一个，或直接在左边问一句。' }),
      ]),
    );
  });

  /* —— 交互：例子点一下填进输入框 —— */
  stream.addEventListener('click', (event) => {
    const target = event.target.closest('[data-example]');
    if (!target) return;
    input.value = target.dataset.example ?? '';
    input.focus();
  });

  head.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="clear"]');
    if (!target) return;
    input.value = '';
    paintEmpty();
    input.focus();
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    // 视-0 不接后端：发送只把内容留在输入框里并提示「还没接」。
    // 真正的发送在 Bot-9 接 SSE 时补上 —— 这里不假装成功。
    if (!input.value.trim()) return;
    stream.replaceChildren(empty(
      '这一块还没接上会话接口。',
      '视-0 只做外壳与状态共享；自由对话与下钻在 Bot-9。已经输入的内容会留在下面的框里。',
    ));
  });

  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  /* —— 订阅：选中任务变了，右栏跟着变 —— */
  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedTaskId')) ctx.repaintRail();
  });

  return () => {
    unsubscribe();
  };
}
