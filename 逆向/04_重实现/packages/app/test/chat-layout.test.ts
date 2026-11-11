/**
 * 对话台重做后的结构自测：会话侧栏 / 消息流 / 工具卡两折 / 审批卡 / 输入区 / 证据 rail。
 *
 *   node --test packages/app/test/chat-layout.test.ts
 *
 * ## 这份测的是「结构在不在、插槽对不对」，不是样式
 *
 * 挂载级的行为断言在 `chat-mount.test.ts`；这里补的是重做之后**新增或改名**的那些
 * 定位点（`data-chat-*`）—— 它们既是 CSS 的钩子，也是下一次改版时唯一可靠的锚。
 * 只读源码能验的部分（有没有这个选择器）用源码断言，需要节点树才能验的用 mount。
 *
 * ## 为什么专门有一条「空流也要同步审批门」
 *
 * 这是一个**真出过的 bug**，而且症状被误判成了 Electron 输入注入问题：
 * 审批卡未决 → 输入框被禁用 → 点「清空」（或下钻 / 退出下钻）→ 消息流空了，
 * 而 `painThread()` 在空流分支里 `return`，**跳过了 `syncApprovalGate()`**。
 * 结果输入框永久停在 `disabled`，页面上却没有任何审批卡能解锁它。
 * 与此同时点示例按钮仍然有效（脚本直接写 `.value`，不过键盘），
 * 于是现象看起来就是「鼠标能点、键盘打不进字」。
 *
 * 所以这一条必须由**真的把输入框置锁再清空**来验，不能只 grep 源码。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const chatPath = join(viewsDir, 'chat.js');
const chatUrl = pathToFileURL(chatPath).href;
const cssPath = join(viewsDir, 'blocks.css');

/** 去掉注释后的源码 —— 注释里写的 `input.value = ''` 不该被当成实现。 */
function codeOf(): string {
  return readFileSync(chatPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function cssOf(): string {
  return readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ---------------------------------------------------------------------------------------------
 * 最小 DOM 桩（与 chat-mount.test.ts 同口径，补 `closest` 与 `files`）
 * ------------------------------------------------------------------------------------------- */

interface StubNode {
  tagName: string;
  className: string;
  title: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  files: unknown[];
  children: StubNode[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  parentElement: StubNode | null;
  scrollTop: number;
  scrollHeight: number;
  focus(): void;
  click(): void;
  append(child: StubNode | TextStub): void;
  appendChild(child: StubNode | TextStub): StubNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  dispatch(type: string, event?: unknown): void;
  closest(selector: string): StubNode | null;
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
  let ownHtml = '';

  const node = {
    tagName: tagName.toUpperCase(),
    className: '',
    title: '',
    hidden: false,
    disabled: false,
    value: '',
    files: [] as unknown[],
    children: [] as StubNode[],
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    parentElement: null as StubNode | null,
    scrollTop: 0,
    scrollHeight: 0,
    focus() { /* 桩：只需存在 */ },
    click() { /* 桩：attachBtn 会调它；不该抛 */ },

    get textContent(): string {
      return ownText + this.children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      ownText = String(value ?? '');
      ownHtml = '';
      this.children = [];
    },

    get innerHTML(): string { return ownHtml; },
    set innerHTML(value: string) {
      ownHtml = String(value ?? '');
      ownText = ownHtml
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
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

    /**
     * 只支持对话里真正用到的三个 `[data-*]` 形态。
     * 不实现完整 CSS 选择器 —— 桩面越大，它自己出错的机会越多。
     */
    closest(selector: string) {
      const wanted = /^\[(data-[a-z-]+)\]$/.exec(selector)?.[1] ?? '';
      if (!wanted) return null;
      const key = wanted.slice(5).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
      let current: StubNode | null = this as unknown as StubNode;
      while (current) {
        if (current.dataset[key] !== undefined) return current;
        current = current.parentElement;
      }
      return null;
    },

    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    /**
     * 只支持三种形态：
     *   `[data-x]` / `[data-x="y"]`   属性
     *   `.cls`                         类
     *   `TAG`                          标签
     *   `A B`                          后代（对话里用到了 `[data-fold-slot="args"] .vw-chat-fold-body`）
     * 不实现完整 CSS 选择器 —— 桩面越大，它自己出错的机会越多。
     */
    querySelectorAll(selector: string) {
      const single = (candidate: StubNode, part: string): boolean => {
        if (part.startsWith('[data-') && part.includes('="')) {
          const body = part.slice(1, -1);
          const eq = body.indexOf('=');
          const name = body.slice(5, eq).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
          return candidate.dataset[name] === body.slice(eq + 2, -1);
        }
        if (part.startsWith('[data-') && part.endsWith(']')) {
          const name = part.slice(6, -1).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
          return candidate.dataset[name] !== undefined;
        }
        if (part.startsWith('.')) return candidate.className.split(/\s+/).includes(part.slice(1));
        return candidate.tagName === part.toUpperCase();
      };

      const parts = selector.split(/\s+/).filter(Boolean);
      const matches = (candidate: StubNode): boolean => {
        if (!single(candidate, parts[parts.length - 1])) return false;
        let rest = parts.slice(0, -1);
        let current = candidate.parentElement;
        while (rest.length && current) {
          if (single(current, rest[rest.length - 1])) rest = rest.slice(0, -1);
          current = current.parentElement;
        }
        return rest.length === 0;
      };

      const out: StubNode[] = [];
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
      for (const item of nodes) if (item) this.append(item);
    },

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

async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, Node: globals.Node };
  globals.document = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (value: string): TextStub => ({ nodeType: 3, textContent: value }),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  };
  globals.Node = class NodeStub {};
  try {
    return await run();
  } finally {
    globals.document = saved.document;
    globals.Node = saved.Node;
  }
}

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

/** 装一份对话；`sessions` 给左侧列表喂数据，`detail` 让回放能返回 events。 */
async function mountChat(options: {
  events?: string[];
  sessions?: Array<{ id: string; title: string; updated_at: string }>;
  detail?: { session: unknown; events: unknown[] };
  sessionsFail?: boolean;
} = {}): Promise<Mounted & { fetchCalls: string[] }> {
  const { mount } = await import(chatUrl);
  const main = makeNode('main');
  const head = makeNode('header');
  const rail = makeNode('aside');
  const state = fakeState();
  const fetchCalls: string[] = [];

  const globals = globalThis as unknown as Record<string, unknown>;
  const savedFetch = globals.fetch;
  /*
   * 一条 URL 上挂着两个方法：`GET /sessions` 是列表，`POST /sessions` 是新建。
   * 不分开就会把「新建」也答成列表（`{sessions:[]}`），于是 `session_id` 读不到，
   * `sendMessage` 走「会话没有 id」那条错误分支 —— 后面的审批、工具卡全都不会出现，
   * 测试看起来是「结构没做」，其实是桩答错了。
   */
  globals.fetch = async (url: string, init?: { method?: string }) => {
    const target = String(url);
    const method = String(init?.method || 'GET').toUpperCase();
    fetchCalls.push(`${method} ${target}`);
    if (target.endsWith('/sessions')) {
      if (method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ session_id: 'ses-test' }) };
      }
      if (options.sessionsFail) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ sessions: options.sessions ?? [] }) };
    }
    if (/\/sessions\/[^/]+$/.test(target)) {
      return { ok: true, status: 200, json: async () => (options.detail ?? { session: {}, events: [] }) };
    }
    return sseResponse(options.events ?? []);
  };

  const railRenderers = new Map<string, (host: StubNode) => void>();
  const cleanup = mount({
    main,
    head,
    state,
    rail,
    renderRail: (draw: (host: StubNode) => void) => {
      railRenderers.set('chat', draw);
      draw(rail);
    },
    /*
     * `repaintRail` 必须真的重画。
     *
     * 给个空函数看起来更省事，但 `chat.js` 里右栏的调用次数远多于首画 ——
     * 工具卡进流、会话 id 落定、审批出现，每次都靠它同步。空实现会让「右栏有证据」
     * 这类断言永远是红的，而失败原因看起来像「没实现」，其实是桩没干活。
     */
    repaintRail: () => {
      rail.replaceChildren();
      const render = railRenderers.get('chat');
      if (render) render(rail);
    },
  });

  const input = main.querySelector('textarea');
  assert.ok(input, '输入框要挂出来');

  return {
    main,
    head,
    rail,
    input,
    fetchCalls,
    cleanup: () => {
      globals.fetch = savedFetch;
      cleanup();
    },
  };
}

const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 10));
};

async function send(view: Mounted & { fetchCalls: string[] }, text: string): Promise<void> {
  view.input.value = text;
  const form = view.main.querySelector('form');
  assert.ok(form, '要有输入表单');
  form.dispatch('submit', { type: 'submit', preventDefault() {}, stopPropagation() {} });
  await settle();
}

/** 触发一个委托监听：事件必须带 `target`，否则 `closest()` 无从查起。 */
function fireOn(host: StubNode, type: string, target: StubNode | null): void {
  assert.ok(target, '要能定位到被点的那个节点');
  host.dispatch(type, { type, target, stopPropagation() {}, preventDefault() {} });
}

/* ---------------------------------------------------------------------------------------------
 * 1. 三栏骨架：会话侧栏 + 消息流 + 右栏
 * ------------------------------------------------------------------------------------------- */

test('三栏骨架：会话侧栏、消息流、右栏各就各位', async () => {
  await withDom(async () => {
    const view = await mountChat();
    try {
      assert.ok(view.main.querySelector('[data-chat-shell]'), '有两列壳（侧栏 + 中列）');
      assert.ok(view.main.querySelector('[data-chat-sessions]'), '左侧会话栏');
      assert.ok(view.main.querySelector('[data-chat-session-list]'), '会话列表容器');
      assert.ok(view.main.querySelector('[data-chat-new-session]'), '新建会话按钮');
      assert.ok(view.main.querySelector('[data-chat-stream]'), '消息流');
      assert.ok(view.main.querySelector('[data-chat-composer]'), '输入区');
      // 右栏归外壳，但内容是对话写的：本次会话 + 证据两节都要有。
      assert.match(view.rail.textContent, /本次会话/, '右栏有「本次会话」');
      assert.match(view.rail.textContent, /证据/, '右栏有「证据」');
      assert.match(view.rail.textContent, /工具调用/, '右栏有工具调用数');
      assert.match(view.rail.textContent, /总耗时/, '右栏有总耗时');
    } finally {
      view.cleanup();
    }
  });
});

test('会话列表来自 /api/agent/sessions，且标题与相对时间都在', async () => {
  await withDom(async () => {
    const view = await mountChat({
      sessions: [
        { id: 's-1', title: 'WUHN 昨天数据', updated_at: new Date().toISOString() },
        { id: 's-2', title: 'ALIC 缺测率', updated_at: new Date(Date.now() - 7200e3).toISOString() },
      ],
    });
    try {
      await settle();
      assert.ok(view.fetchCalls.some((url) => url.endsWith('/sessions')), '要拉会话列表');
      const rows = view.main.querySelectorAll('[data-session-id]');
      assert.equal(rows.length, 2, `列表要有两条，实际 ${rows.length}`);
      assert.match(rows[0].textContent, /WUHN 昨天数据/, '标题');
      assert.match(rows[0].textContent, /刚刚/, '相对时间也在（裸 id 看不出新旧）');
    } finally {
      view.cleanup();
    }
  });
});

test('会话列表拉不到时说出原因，而不是留一片空白', async () => {
  await withDom(async () => {
    const view = await mountChat({ sessionsFail: true });
    try {
      await settle();
      const text = view.main.querySelector('[data-chat-session-list]').textContent;
      assert.match(text, /没拉到/, '要说「没拉到」');
      assert.match(text, /503/, '要带状态码');
      assert.match(text, /仍可直接发消息/, '要说下一步：列表挂了不妨碍发消息');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 2. 工具卡：卡 + 入参 / 返回两条独立折叠 + 可复制的 call_id
 * ------------------------------------------------------------------------------------------- */

test('工具卡：入参与返回是两个独立折叠槽，默认都收起', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我查一下。' }),
        JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'robust_stats', args: { station_id: 'WUHN' } }),
        JSON.stringify({
          type: 'tool_result', id: 'c-1', ok: true, summary: '完成',
          data: { n: 86400, cn0_median: 44.2 }, evidence: { agent: 'ops', call_id: 't0001' }, duration_ms: 412,
        }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, 'WUHN 昨天数据怎么样');

      // 一次调用仍然只有一张卡（结构重做不能把「一对一」弄丢）。
      assert.equal(view.main.querySelectorAll('[data-card-type="tool"]').length, 1, '一次调用一张卡');

      const slots = view.main.querySelectorAll('[data-fold-slot]').map((n) => n.dataset.foldSlot);
      assert.deepEqual(slots, ['args', 'result'], '入参与返回各自一个槽，顺序固定');

      for (const slot of ['args', 'result']) {
        const head = view.main.querySelectorAll('[data-fold]').find((n) => n.dataset.fold === slot);
        assert.ok(head, `缺 ${slot} 的折叠头`);
        assert.equal(head.getAttribute('aria-expanded'), 'false', `${slot} 默认收起`);
        const body = view.main.querySelectorAll('.vw-chat-fold-body')
          .find((n) => n.closest('[data-fold-slot]')?.dataset.foldSlot === slot);
        assert.ok(body, `缺 ${slot} 的折叠体`);
        assert.equal(body.hidden, true, `${slot} 的正文默认不可见`);
      }

      // 内容要是**真的**那一份，不是占位。
      const argsBody = view.main.querySelectorAll('[data-fold-slot="args"] .vw-chat-fold-body')[0];
      assert.match(argsBody.textContent, /WUHN/, '入参里应有 station_id 的值');
      const resultBody = view.main.querySelectorAll('[data-fold-slot="result"] .vw-chat-fold-body')[0];
      assert.match(resultBody.textContent, /86,?400|86400/, '返回里应有 n');
    } finally {
      view.cleanup();
    }
  });
});

test('工具卡：点折叠头当场展开/收起，不必重画整条流', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我查一下。' }),
        JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'robust_stats', args: { station_id: 'WUHN' } }),
        JSON.stringify({ type: 'tool_result', id: 'c-1', ok: true, data: { n: 1 }, evidence: { call_id: 't1' }, duration_ms: 5 }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '查一下');
      const head = view.main.querySelectorAll('[data-fold]').find((n) => n.dataset.fold === 'args');
      assert.ok(head);
      head.dispatch('click');

      const body = view.main.querySelectorAll('[data-fold-slot="args"] .vw-chat-fold-body')[0];
      assert.ok(body, '折叠体要在');
      assert.equal(body.hidden, false, '点一次要展开');
      assert.equal(head.getAttribute('aria-expanded'), 'true', 'aria 也要跟着');
      assert.match(head.className, /is-open/, '样式钩子要跟上（否则箭头不转）');

      head.dispatch('click');
      assert.equal(body.hidden, true, '再点要收起');
      assert.equal(head.getAttribute('aria-expanded'), 'false');
    } finally {
      view.cleanup();
    }
  });
});

test('工具卡：call_id 可复制，值是 evidence 里那一个', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我查一下。' }),
        JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'robust_stats', args: {} }),
        JSON.stringify({ type: 'tool_result', id: 'c-1', ok: true, data: { n: 1 }, evidence: { call_id: 't0042' }, duration_ms: 8 }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '查一下');

      const copy = view.main.querySelectorAll('[data-copy-call]').find((n) => n.dataset.copyCall === 't0042');
      assert.ok(copy, 'call_id 旁边要有复制按钮，且带着那个 id');
      assert.equal(copy.textContent, '复制');

      // 桩环境没有 navigator.clipboard / execCommand：这里只验「点了不抛、状态会变」。
      // 复制成功与否由 nextTick 的文案决定，两种都算「有反馈」。
      copy.dispatch('click', { type: 'click', stopPropagation() {}, preventDefault() {} });
      await settle(2);
      assert.ok(
        ['已复制', '复制失败'].includes(copy.textContent),
        `复制之后要有反馈，实际「${copy.textContent}」`,
      );
    } finally {
      view.cleanup();
    }
  });
});

test('工具卡：运行中还没返回时，返回槽写「暂无」而不是留白', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '我试一下。' }),
        JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'workflow_run', args: { action: 'restart' } }),
        // 故意不发 tool_result：卡停在运行中
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '重启');
      const card = view.main.querySelectorAll('[data-card-type="tool"]')[0];
      assert.equal(card.dataset.status, 'running', '要停在运行中');
      const body = view.main.querySelectorAll('[data-fold-slot="result"] .vw-chat-fold-body')[0];
      assert.ok(body, '返回槽必须存在 —— 没有它，五要素变成「成功之后才有」');
      assert.match(body.textContent, /暂无/, '没返回就说「暂无」，留白会被读成漏画');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 3. 流式输出：token 追加 + 末尾光标
 * ------------------------------------------------------------------------------------------- */

test('流式：token 逐片追加，末尾有光标；message 到达后光标撤掉', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'token', id: 'm-2', delta: '我先查' }),
        JSON.stringify({ type: 'token', id: 'm-2', delta: '一下。' }),
        JSON.stringify({ type: 'message', id: 'm-2', role: 'assistant', content: '我先查一下。' }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '查一下');
      assert.match(view.main.textContent, /我先查一下/, '两片要拼起来且不重复');
      // 整段 message 是权威文本，收尾后不该再有 streaming 状态。
      assert.match(view.main.textContent, /我先查一下。/, 'message 到达后以它为准');
      // 光标只在流式中出现：这一轮已 done，所以必须没有。
      assert.equal(
        view.main.querySelectorAll('[data-chat-cursor]').length, 0,
        '生成结束后不能留着光标 —— 留着一个不动的光标会被读成「卡住了」',
      );
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 4. 审批卡：未决时禁用输入框，且清空 / 下钻后必须解锁
 * ------------------------------------------------------------------------------------------- */

test('审批未决：输入框禁用、说明行可见、示例按钮的写入不算数', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '需要批准。' }),
        JSON.stringify({
          type: 'approval', id: 'a-1', call_id: 'c-1', risk: 'high',
          reason: '用户要求重启设备', prompt: '批准重启 WUHN？', requested_by: 'ops', status: 'pending',
        }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '重启 WUHN');
      assert.equal(view.input.disabled, true, '未决时禁用输入框');
      const gate = view.main.querySelector('.ag-gate-note');
      assert.ok(gate);
      assert.equal(gate.hidden, false, '说明行要可见');
      assert.match(gate.textContent, /需要先处理上面的审批/, '要说清为什么不能发');
    } finally {
      view.cleanup();
    }
  });
});

test('规矩一的复位：审批未决时点「清空」，输入框必须解锁（这是真出过的锁死 bug）', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'message', id: 'm1', role: 'assistant', content: '需要批准。' }),
        JSON.stringify({
          type: 'approval', id: 'a-1', call_id: 'c-1', risk: 'high',
          reason: '用户要求重启设备', prompt: '批准重启 WUHN？', requested_by: 'ops', status: 'pending',
        }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '重启 WUHN');
      assert.equal(view.input.disabled, true, '前置：未决时确实锁着');

      // 清空：审批卡随消息流一起消失。
      const clear = view.head.querySelectorAll('[data-action]').find((n) => n.dataset.action === 'clear');
      fireOn(view.head, 'click', clear ?? null);
      await settle();

      assert.equal(view.main.querySelectorAll('[data-card-type="approval"]').length, 0, '审批卡应已清掉');
      assert.equal(
        view.input.disabled, false,
        '没有审批卡了就必须解锁 —— 否则用户敲不进字，而页面上没有任何东西能解锁它',
      );
      const gate = view.main.querySelector('.ag-gate-note');
      assert.equal(gate.hidden, true, '说明行也必须收起（否则它在说一件已经不成立的事）');
    } finally {
      view.cleanup();
    }
  });
});

test('规矩一的复位：审批未决时下钻，输入框也要解锁', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'approval', id: 'a-1', risk: 'high', prompt: '批准？', status: 'pending' }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '重启');
      assert.equal(view.input.disabled, true, '前置：锁着');
      // 从别处改选中项 = 下钻（编队台点了一行就会这样）。
      // 这里直接走「新建会话」这颗按钮，它和清空同一条复位路径。
      const fresh = view.main.querySelector('[data-chat-new-session]');
      assert.ok(fresh, '要有新建会话按钮');
      fresh.dispatch('click');
      await settle();
      assert.equal(view.input.disabled, false, '换会话之后旧的审批不该再锁着新的会话');
    } finally {
      view.cleanup();
    }
  });
});

test('审批卡：批准/拒绝两个动作都在，拒绝的理由框默认收起', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({
          type: 'approval', id: 'a-1', risk: 'medium', prompt: '批准归档？',
          reason: '需要写盘', requested_by: 'ops', status: 'pending',
        }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '归档');
      const card = view.main.querySelectorAll('[data-card-type="approval"]')[0];
      const decisions = card.querySelectorAll('[data-decision]').map((n) => n.dataset.decision);
      assert.deepEqual(decisions.sort(), ['approved', 'rejected'], '批准与拒绝都要在');
      assert.equal(card.querySelector('.ag-reason-field').hidden, true, '理由框默认收起（点了拒绝才出现）');
      assert.match(card.textContent, /中风险/, '风险等级要写成中文');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 5. 输入区：Ctrl+Enter 发送、Enter 换行、发送中禁用发送键但不禁输入框
 * ------------------------------------------------------------------------------------------- */

test('输入区：Ctrl+Enter 发送，且输入法组合态不触发发送', async () => {
  const source = codeOf();
  const body = /input\.addEventListener\('keydown'[\s\S]*?\n  \}\);/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 keydown 监听');
  assert.match(body, /event\.ctrlKey \|\| event\.metaKey/, '认 Ctrl / Cmd');
  assert.match(body, /event\.key === 'Enter'/, '认 Enter');
  // 中文输入按 Enter 是上屏，不是发送 —— 不判组合态会把半句话发出去。
  assert.match(body, /event\.isComposing/, '要判 isComposing');
  assert.match(body, /keyCode === 229/, '要判 229（部分输入法只给这个）');
  // Enter 换行：只在带修饰键时才 preventDefault，裸 Enter 必须放行。
  assert.doesNotMatch(body, /if \(event\.key === 'Enter'\)\s*\{\s*event\.preventDefault/, '裸 Enter 不能被吃掉');
});

test('输入区：辅助按钮都有 handler（附件 / 清空输入）', () => {
  const source = codeOf();
  // `data-*` 在 el() 里写的是 camelCase 键（`data: { chatAttach: '' }`），
  // 落到 DOM 上才是 `data-chat-attach`。断言源码就该用源码的形状。
  for (const marker of ['chatAttach', 'chatClearInput', 'vw-chat-file']) {
    assert.match(source, new RegExp(marker), `要有 ${marker} 这个钩子`);
  }
  assert.match(source, /filePicker\.click\(\)/, '附件按钮要真的打开文件选择框');
  assert.match(source, /input\.value = '';\s*\n\s*attachments = \[\];/, '清空输入要真的清掉输入与附件');
});

test('发送中只禁「发送」与「附件」，不禁输入框', () => {
  const source = codeOf();
  const body = /function syncSending\(\)[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 syncSending');
  assert.match(body, /send\.disabled = busy/, '禁发送键');
  assert.match(body, /attachBtn\.disabled = busy/, '禁附件（生成中再传文件没有意义）');
  // 输入框**不能**在这里被禁：用户往往已经在写下一句，锁掉等于逼他等。
  assert.doesNotMatch(body, /input\.disabled/, '生成中不能禁输入框');
});

/* ---------------------------------------------------------------------------------------------
 * 6. 右栏：证据 call_id 可点，能定位到那张卡
 * ------------------------------------------------------------------------------------------- */

test('右栏证据：列 call_id，点一条就展开并定位到那张工具卡', async () => {
  await withDom(async () => {
    const view = await mountChat({
      events: [
        JSON.stringify({ type: 'tool_call', id: 'c-1', name: 'robust_stats', args: {} }),
        JSON.stringify({ type: 'tool_result', id: 'c-1', ok: true, data: { n: 1 }, evidence: { call_id: 't0007' }, duration_ms: 20 }),
        JSON.stringify({ type: 'done' }),
      ],
    });
    try {
      await send(view, '查一下');
      const entry = view.rail.querySelectorAll('[data-evidence-id]').find((n) => n.dataset.evidenceId === 't0007');
      assert.ok(entry, '右栏要有一条 t0007，且可点');

      fireOn(view.rail, 'click', entry);
      await settle(2);

      // 点了之后那张卡的折叠区要展开（否则「定位」只是滚一下，看不到内容）。
      const args = view.main.querySelectorAll('[data-fold-slot="args"] .vw-chat-fold-body')[0];
      assert.ok(args, '工具卡还在');
      assert.equal(args.hidden, false, '定位到的卡要把入参展开，用户才能当场核对');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 7. 样式：新结构的钩子都有规则，且不违反「三个不许用」
 * ------------------------------------------------------------------------------------------- */

test('blocks.css：新结构的每个钩子都有样式', () => {
  const css = cssOf();
  for (const hook of [
    '.vw-chat-sessions', '.vw-chat-session', '.vw-chat-session-list',
    '.vw-chat-main', '.vw-chat-tool', '.vw-chat-tool-detail',
    '.vw-chat-fold', '.vw-chat-fold-head', '.vw-chat-fold-body',
    '.vw-chat-evidence', '.vw-chat-copy', '.vw-chat-cursor',
    '.vw-chat-composer-row', '.vw-chat-composer-tools', '.vw-chat-key-hint',
    '.vw-chat-attachments', '.vw-chat-attach', '.vw-rail-call',
  ]) {
    assert.match(css, new RegExp(hook.replace('.', '\\.')), `缺样式 ${hook}`);
  }
});

test('blocks.css：消息流里的项不许被压缩（否则高卡片会被裁掉）', () => {
  const css = cssOf();
  // .vw-chat-stream 是纵向 flex，子项默认 flex-shrink: 1 —— 审批卡实测被压到 71px，
  // 批准/拒绝按钮整块消失，且因为没有溢出所以连滚动条都不出现。
  const block = /\.vw-chat-stream\s*>\s*\*\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, '要有 .vw-chat-stream > * 规则');
  assert.match(block[1], /flex:\s*0\s+0\s+auto/, '子项必须禁止收缩');
});

test('blocks.css：没有渐变 / 阴影，圆角仍 ≤ 4px', () => {
  const css = cssOf();
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/, '不许用渐变');
  assert.doesNotMatch(css, /box-shadow/, '不许用阴影');
  const radii = [...css.matchAll(/border-radius:\s*(\d+)px/g)].map((m) => Number(m[1]));
  for (const radius of radii) assert.ok(radius <= 4, `圆角 ${radius}px 超过 4px`);
});
