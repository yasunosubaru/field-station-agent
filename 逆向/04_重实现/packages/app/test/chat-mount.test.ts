/**
 * 视-1 的挂载级自测：把 `views/chat.js` **真的 mount 起来**，喂它 SSE，看渲染结果。
 *
 *   node --test packages/app/test/chat-mount.test.ts
 *
 * ## 为什么还要这一份（cards.test.ts 已经验过卡片本身）
 *
 * `cards.test.ts` 验的是「给一张卡的数据，卡画得对不对」。它验不到下面这三件事：
 *
 *   ① **空态到底出不出得来。** `toolsEmptyNote()` 在 `mount()` 的闭包里，不是导出函数；
 *      只读源码能看出「有这句文案」，看不出「这一轮真的会显示它」。而这条正是
 *      最容易做成「代码里写了、界面上没有」的那一类。
 *   ② **规矩一会不会触发。** 它依赖「审批事件 → 卡片进消息流 → syncApprovalGate 读到
 *      pending」这条链。`chat-view.test.ts` 只用正则读源码，链路任何一环断了它照样绿。
 *   ③ **一次工具调用是不是只有一张卡。** 这是 08f10c0 那个 bug 的形状：
 *      `tool_call` 与 `tool_result` 配不上对，于是卡片永远停在「运行中」。
 *
 * 所以这里用 `mount()` 真跑一遍：假的 `fetch` 返回真的 SSE 字节，`TextDecoder` 也是真的，
 * 只有 DOM 是桩。
 *
 * ## 桩的边界（说清楚，免得被当成「验过样式」）
 *
 * 桩只实现 `chat.js` / `dom.js` / `cards.js` 真正调用到的那几个 API。
 * 它不跑 CSS、不算布局、不管焦点顺序。**能证明的是「节点在、文案对、状态对」**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const chatUrl = pathToFileURL(join(appDir, 'src', 'web', 'views', 'chat.js')).href;

/* ---------------------------------------------------------------------------------------------
 * 最小 DOM 桩（与 cards.test.ts 同口径，但补上 dom.js 用到的 `append` / `title`）
 * ------------------------------------------------------------------------------------------- */

interface StubNode {
  tagName: string;
  className: string;
  title: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  children: StubNode[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  parentElement: StubNode | null;
  scrollTop: number;
  scrollHeight: number;
  focus(): void;
  append(child: StubNode | TextStub): void;
  appendChild(child: StubNode | TextStub): StubNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  dispatch(type: string, event?: unknown): void;
  querySelector(selector: string): StubNode | null;
  querySelectorAll(selector: string): StubNode[];
  replaceChildren(...nodes: StubNode[]): void;
  classList: { add(cls: string): void; remove(cls: string): void; toggle(cls: string, on?: boolean): void };
  innerHTML: string;
}

interface TextStub { nodeType: 3; textContent: string }

function makeNode(tagName: string): StubNode {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  let ownText = '';

  const node = {
    tagName: tagName.toUpperCase(),
    className: '',
    title: '',
    hidden: false,
    disabled: false,
    value: '',
    innerHTML: '',
    children: [] as StubNode[],
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    parentElement: null as StubNode | null,
    scrollTop: 0,
    scrollHeight: 0,
    focus() { /* 桩：只需存在 */ },

    // 像浏览器那样聚合后代文本 —— 否则 `assert.match(node.textContent, …)` 永远是空串，测试变假绿。
    get textContent(): string {
      return ownText + this.children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      ownText = String(value ?? '');
      this.children = [];
    },

    append(child: StubNode | TextStub) {
      if ((child as TextStub).nodeType === 3) {
        ownText += (child as TextStub).textContent;
        return;
      }
      const asNode = child as StubNode;
      asNode.parentElement = this as unknown as StubNode;
      this.children.push(asNode);
    },
    appendChild(child: StubNode | TextStub) {
      this.append(child);
      return child as StubNode;
    },

    setAttribute(name: string, value: string) {
      this.attrs[name] = String(value);
      if (name === 'hidden') this.hidden = true;
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
    getAttribute(name: string) {
      if (name === 'hidden') return this.hidden ? '' : null;
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    removeAttribute(name: string) {
      delete this.attrs[name];
      if (name === 'hidden') this.hidden = false;
    },

    addEventListener(type: string, fn: (event: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    dispatch(type: string, event?: unknown) {
      const e = event ?? { type, stopPropagation() {}, preventDefault() {} };
      for (const fn of listeners[type] ?? []) fn(e);
    },

    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string) {
      const out: StubNode[] = [];
      // `[data-x="y"]` 必须先判 —— 它同样以 `]` 结尾，落到下面的无值分支就会算错属性名。
      const matches = (candidate: StubNode): boolean => {
        if (selector.startsWith('[data-') && selector.includes('="')) {
          const body = selector.slice(1, -1);
          const eq = body.indexOf('=');
          const name = body.slice(5, eq).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
          const want = body.slice(eq + 2, -1);
          return candidate.dataset[name] === want;
        }
        if (selector.startsWith('[data-') && selector.endsWith(']')) {
          const name = selector.slice(6, -1).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
          return candidate.dataset[name] !== undefined;
        }
        if (selector.startsWith('.')) {
          return candidate.className.split(/\s+/).includes(selector.slice(1));
        }
        return candidate.tagName === selector.toUpperCase();
      };
      const walk = (current: StubNode): void => {
        for (const child of current.children) {
          if (matches(child)) out.push(child);
          walk(child);
        }
      };
      walk(this as unknown as StubNode);
      return out;
    },

    replaceChildren(...nodes: StubNode[]) {
      this.children = [];
      ownText = '';
      for (const item of nodes) {
        if (item) this.append(item);
      }
    },

    /*
     * `classList` 的三个方法**必须闭包到 node**，不能用 `this`。
     *
     * 它是个普通对象字面量，`node.classList.add(...)` 调用时 `this` 指向的是
     * `classList` 对象而不是节点 —— 于是 `this.className` 是 undefined，
     * `undefined.split` 直接抛。真人浏览器里 `classList` 是节点上的 getter，不是这个形状。
     * 这个坑在 cards.test.ts 里没被踩到，是因为那边没有代码调用 `classList.toggle`。
     */
    classList: {
      add(cls: string) {
        if (!node.className.split(/\s+/).includes(cls)) node.className = `${node.className} ${cls}`.trim();
      },
      remove(cls: string) {
        node.className = node.className.split(/\s+/).filter((n) => n !== cls).join(' ');
      },
      toggle(cls: string, on?: boolean) {
        const has = node.className.split(/\s+/).includes(cls);
        const want = on === undefined ? !has : on;
        if (want) node.classList.add(cls);
        else node.classList.remove(cls);
      },
    },
  };

  return node as unknown as StubNode;
}

/** 装桩，跑 `run`，再拆掉。`chat.js` 与它 import 的模块都只在调用时碰 document。 */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const documentStub = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (value: string): TextStub => ({ nodeType: 3, textContent: value }),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: globals.document,
    Node: globals.Node,
  };
  globals.document = documentStub;
  // `dom.js` 的 `kv()` 用 `value instanceof Node` 判断；桩里给个空基类够用。
  globals.Node = class NodeStub {};

  try {
    return await run();
  } finally {
    globals.document = saved.document;
    globals.Node = saved.Node;
  }
}

/* ---------------------------------------------------------------------------------------------
 * 搭一个能 mount 的 ctx（只实现 chat.js 真正用到的接口）
 * ------------------------------------------------------------------------------------------- */

interface Mounted {
  main: StubNode;
  head: StubNode;
  rail: StubNode;
  input: StubNode;
  cleanup: () => void;
}

function fakeState() {
  let value: { selectedTaskId: string | null } = { selectedTaskId: null };
  const listeners = new Set<(next: unknown, changed: Set<string>) => void>();
  return {
    get: () => value,
    set(patch: { selectedTaskId?: string | null }) {
      const changed = new Set<string>();
      for (const key of Object.keys(patch)) {
        if ((value as Record<string, unknown>)[key] !== (patch as Record<string, unknown>)[key]) changed.add(key);
      }
      value = { ...value, ...patch };
      for (const fn of listeners) fn(value, changed);
    },
    subscribe(fn: (next: unknown, changed: Set<string>) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** SSE 字节 → 假的 `Response`；`getReader()` 逐块吐，`TextDecoder` 是真的。 */
function sseResponse(events: string[]) {
  const chunks = events.map((raw) => new TextEncoder().encode(`event: agent\ndata: ${raw}\n\n`));
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let index = 0;
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
        };
      },
    },
  };
}

/**
 * 装一份对话视角，并把 `fetch` 换掉。
 *
 * @param events 这一轮 SSE 要发的事件（每项是一个 `data:` 的 JSON 串）
 */
async function mountChat(events: string[]): Promise<Mounted> {
  const { mount } = await import(chatUrl);

  const main = makeNode('main');
  const head = makeNode('header');
  const rail = makeNode('aside');
  const state = fakeState();

  const calls: string[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedFetch = globals.fetch;
  globals.fetch = async (url: string) => {
    calls.push(String(url));
    // 建会话 → 返回会话 id（实测字段是 session_id）。
    if (String(url).endsWith('/sessions')) {
      return { ok: true, status: 200, json: async () => ({ session_id: 'ses-test' }) };
    }
    return sseResponse(events);
  };

  const cleanup = mount({
    main,
    head,
    state,
    rail,
    // chat.js 立刻用回调画右栏，所以这里同步调用并把 rail 传进去。
    renderRail: (draw: (host: StubNode) => void) => draw(rail),
    repaintRail: () => {},
  });

  const input = main.querySelector('textarea');
  assert.ok(input, '输入框要挂出来');

  return {
    main,
    head,
    rail,
    input,
    cleanup: () => {
      globals.fetch = savedFetch;
      cleanup();
    },
  };
}

/** 发一句话，等 async 链跑完（`sendMessage` 不是 await 出来的，只能等一拍）。 */
async function send(view: Mounted, text: string): Promise<void> {
  view.input.value = text;
  const form = view.main.querySelector('form');
  assert.ok(form, '要有输入表单');
  form.dispatch('submit', { type: 'submit', preventDefault() {}, stopPropagation() {} });
  // 两段 await（建会话 → 消费流）加宏任务，足够跑完。
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ---------------------------------------------------------------------------------------------
 * 1. 空态：本轮没有工具调用
 * ------------------------------------------------------------------------------------------- */

test('空态：这一轮真没有工具调用时，「本轮没有工具调用」真的画在页面上', async () => {
  await withDom(async () => {
    const view = await mountChat([
      // 真序列是 token×N → message（整段重发）。这里只给 message，等价于「模型直接答了」。
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: 'WUHN 昨天一切正常。' }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, 'WUHN 昨天数据怎么样');

      const note = view.main.querySelector('[data-chat-tools-empty]');
      assert.ok(note, '没有工具调用时要画出空态 —— 留白会让「没调工具」和「卡片没画出来」看起来一样');
      assert.equal(note.textContent, '本轮没有工具调用');
      assert.match(note.className, /vw-chat-tools-empty/, '要有自己的 class（样式挂在这里）');

      // 助手那句话也在，说明空态不是替代了回话。
      assert.match(view.main.textContent, /WUHN 昨天一切正常/);
    } finally {
      view.cleanup();
    }
  });
});

test('空态不误报：这一轮有工具调用时，那句「本轮没有工具调用」必须消失', async () => {
  await withDom(async () => {
    const view = await mountChat([
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我查一下。' }),
      JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'robust_stats', args: { station_id: 'WUHN' } }),
      JSON.stringify({
        type: 'tool_result', id: 'c-1', ok: true, summary: 'robust_stats 完成（3 个字段）',
        data: { n: 86400, cn0_median: 44.2 }, evidence: { agent: 'ops', call_id: 't0001' }, duration_ms: 412,
      }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, 'WUHN 昨天数据怎么样');

      assert.equal(
        view.main.querySelector('[data-chat-tools-empty]'), null,
        '有工具卡还写「本轮没有工具调用」就是明着说谎',
      );
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 2. 一次成功的工具调用 = 一张五要素卡
 * ------------------------------------------------------------------------------------------- */

test('成功的工具调用：页面上正好一张卡，五要素齐全且填上了真实值', async () => {
  await withDom(async () => {
    const view = await mountChat([
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我查一下。' }),
      JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'robust_stats', args: { station_id: 'WUHN' } }),
      JSON.stringify({
        type: 'tool_result', id: 'c-1', ok: true, summary: 'robust_stats 完成（3 个字段）',
        data: { n: 86400, cn0_median: 44.2 },
        evidence: { agent: 'ops', call_id: 't0001' }, duration_ms: 412,
      }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, 'WUHN 昨天数据怎么样');

      const cards = view.main.querySelectorAll('[data-card-type="tool"]');
      assert.equal(cards.length, 1, `一次调用只能有一张卡，实际 ${cards.length} 张（多了就是没配上对）`);

      const card = cards[0];
      const part = (name: string): StubNode => {
        const found = card.querySelectorAll('[data-part]').find((n) => n.dataset.part === name);
        assert.ok(found, `缺要素 ${name}`);
        return found;
      };

      assert.equal(part('name').textContent, 'robust_stats', '① 工具名');
      assert.match(part('args').textContent, /station_id=WUHN/, '② 参数摘要');
      assert.match(part('result').textContent, /86,400/, '③ 结果摘要要有人能读的数字');
      assert.equal(part('duration').textContent, '412 ms', '④ 耗时');
      assert.equal(part('status').textContent, '成功', '⑤ 成功');
      assert.equal(part('status').dataset.status, 'ok');

      // 规矩三：call_id 在 evidence 里，卡片上必须有 —— 它是回源的唯一入口。
      assert.equal(card.dataset.callId, 't0001', 'call_id 从 evidence.call_id 取');
      assert.equal(card.dataset.status, 'ok', '卡片不能停在运行中');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 3. 失败态：真实错误分类
 * ------------------------------------------------------------------------------------------- */

test('失败的工具调用：卡片带真实错误分类，不是一句「出错了」', async () => {
  await withDom(async () => {
    const view = await mountChat([
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我试一下。' }),
      JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'native_live_command', args: { port: 'COM3' } }),
      // 后端对一次失败发两条：先 tool_result(ok:false)，再 error(class)。
      JSON.stringify({
        type: 'tool_result', id: 'c-1', ok: false, summary: '连接超时：192.0.2.10:5017 无响应',
        data: {}, evidence: { agent: 'ops', call_id: 't0007' }, duration_ms: 5000,
      }),
      JSON.stringify({ type: 'error', class: 'environment', message: '连接超时：192.0.2.10:5017 无响应' }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, '连一下接收机');

      const cards = view.main.querySelectorAll('[data-card-type="tool"]');
      assert.equal(cards.length, 1, '失败也不能多出一张卡');
      const card = cards[0];

      assert.equal(card.dataset.status, 'failed');
      const line = card.querySelector('.ag-tool-error-class');
      assert.ok(line, '失败卡要有错误分类行');
      // 真字段名是 `class`，不是 `kind` —— 读错了这里会是「未提供分类」。
      assert.equal(line.dataset.errorClass, 'environment', '分类从 error 事件的 class 字段接过来');
      assert.match(line.textContent, /环境不通/, '要翻成人话');
      assert.match(line.textContent, /environment/, '原枚举也留着（对得上日志）');

      // 原因单独一行。
      assert.match(card.querySelector('.ag-tool-note').textContent, /192\.0\.2\.10:5017/);

      // 同一句话不印两遍：不再另插一张错误卡。
      assert.equal(
        view.main.querySelectorAll('[data-card-type="error"]').length, 0,
        '分类已接到工具卡上，再插一张错误卡就是同一句话印两遍',
      );
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 4. 审批卡四要素 + 规矩一
 * ------------------------------------------------------------------------------------------- */

test('审批卡：四要素齐全，且未决时输入框被禁用并说明原因（规矩一）', async () => {
  await withDom(async () => {
    const view = await mountChat([
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '重启需要你批准。' }),
      // 真样本形状（orchestrator 的 approval 事件）。
      JSON.stringify({
        type: 'approval', id: 'a-1', call_id: 'c-1', risk: 'high',
        reason: '用户要求重启设备',
        prompt: '是否允许执行 workflow_run？（station_id=WUHN, action=restart_receiver）',
        requested_by: 'ops', status: 'pending',
      }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, '重启 WUHN 接收机');

      const cards = view.main.querySelectorAll('[data-card-type="approval"]');
      assert.equal(cards.length, 1, '一条审批一张卡');
      const card = cards[0];

      const part = (name: string): StubNode => {
        const found = card.querySelectorAll('[data-part]').find((n) => n.dataset.part === name);
        assert.ok(found, `审批卡缺要素 ${name}`);
        return found;
      };

      // ① 谁申请 —— 真字段是 requested_by。
      assert.match(part('who').textContent, /ops/, '申请方从 requested_by 读');
      assert.equal(part('who').dataset.missing, undefined, '有申请方就不该标 missing');
      // ② 要做什么。
      assert.match(part('what').textContent, /workflow_run/);
      // ③ 风险等级。
      assert.equal(part('risk').textContent, '高风险');
      // ④ 批准 / 拒绝。
      const decide = part('decision');
      const approve = decide.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'approved');
      const reject = decide.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'rejected');
      assert.ok(approve, '要有批准');
      assert.ok(reject, '要有拒绝');
      assert.equal(approve.textContent, '批准');
      assert.equal(reject.textContent, '拒绝');

      // 规矩一：未决 → 输入框禁用，且**说清原因**（灰掉不说话比不禁用更糟）。
      assert.equal(card.dataset.pending, 'true', '未决要标记');
      assert.equal(view.input.disabled, true, '审批未决时禁用输入框');
      const gate = view.main.querySelector('.ag-gate-note');
      assert.ok(gate, '要有说明行');
      assert.equal(gate.hidden, false, '说明行要可见');
      assert.match(gate.textContent, /需要先处理上面的审批/);
    } finally {
      view.cleanup();
    }
  });
});

test('点拒绝后 UI 状态正确：卡片转已决、pending 撤掉、输入框解锁', async () => {
  await withDom(async () => {
    const view = await mountChat([
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '重启需要你批准。' }),
      JSON.stringify({
        type: 'approval', id: 'a-1', call_id: 'c-1', risk: 'high',
        reason: '用户要求重启设备', prompt: '批准重启 WUHN？', requested_by: 'ops', status: 'pending',
      }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, '重启 WUHN 接收机');

      let card = view.main.querySelectorAll('[data-card-type="approval"]')[0];
      assert.equal(view.input.disabled, true, '未决时禁用');

      const rejectOf = (host: StubNode): StubNode =>
        host.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'rejected') as StubNode;

      // 第一次点：只展开理由框（规矩二），不提交。
      rejectOf(card).dispatch('click');
      const reasonField = card.querySelector('.ag-reason-field');
      assert.equal(reasonField.hidden, false, '第一次点要展开理由框');

      // 填理由，再点：走 decideApproval → POST /approval。
      const reasonInput = reasonField.querySelector('textarea');
      assert.ok(reasonInput);
      reasonInput.value = '时间不对';
      rejectOf(card).dispatch('click');
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));

      // 重画之后要重新取节点 —— paintThread 会整体替换。
      card = view.main.querySelectorAll('[data-card-type="approval"]')[0];
      assert.equal(card.dataset.status, 'rejected', '卡片转已拒绝');
      assert.equal(card.dataset.pending, undefined, 'pending 标记要撤掉（否则门永远关着）');
      assert.equal(view.input.disabled, false, '决定之后输入框解锁');
      assert.equal(view.main.querySelector('.ag-gate-note').hidden, true, '说明行收起');

      const decision = card.querySelector('.ag-decision');
      assert.equal(decision.hidden, false);
      assert.match(decision.textContent, /已拒绝/);
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 5. 审批第二次事件不冲掉第一次的字段
 * ------------------------------------------------------------------------------------------- */

test('审批决定事件不把申请方和后果冲掉（第二次事件不带那些字段）', async () => {
  await withDom(async () => {
    const view = await mountChat([
      JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '需要批准。' }),
      JSON.stringify({
        type: 'approval', id: 'a-1', call_id: 'c-1', risk: 'high',
        reason: '用户要求重启设备', prompt: '批准重启 WUHN？',
        impact: '会中断观测约 30 秒', requested_by: 'ops', status: 'pending',
      }),
      // 决定事件：只带 status / decision / decided_at，不带 requested_by / impact。
      JSON.stringify({
        type: 'approval', id: 'a-1', call_id: 'c-1', risk: 'high',
        reason: '用户要求重启设备', prompt: '批准重启 WUHN？',
        status: 'rejected', decision: 'rejected', decided_at: '2026-11-08T09:31:12.000Z',
        note: '改约 22:00 维护窗口',
      }),
      JSON.stringify({ type: 'done' }),
    ]);
    try {
      await send(view, '重启 WUHN 接收机');

      const card = view.main.querySelectorAll('[data-card-type="approval"]')[0];
      assert.equal(card.dataset.status, 'rejected');

      const part = (name: string): StubNode | undefined =>
        card.querySelectorAll('[data-part]').find((n) => n.dataset.part === name);

      // 这三行是审计要回看的东西，第二次事件没带，不能被清空。
      assert.match(part('who').textContent, /ops/, '申请方不能被第二次事件冲掉');
      assert.match(part('what').textContent, /批准重启 WUHN/, '动作描述不能丢');
      assert.ok(card.querySelector('.ag-approval-impact'), '后果那一行不能丢');
      assert.match(card.querySelector('.ag-approval-impact').textContent, /中断观测/);

      // 决定时刻要读 `decided_at`（真字段），否则已决卡显示不出什么时候批的。
      const decision = card.querySelector('.ag-decision');
      assert.match(decision.textContent, /已拒绝/);
      assert.match(decision.textContent, /:31/, '决定时间要显示出来（来自 decided_at）');
    } finally {
      view.cleanup();
    }
  });
});
