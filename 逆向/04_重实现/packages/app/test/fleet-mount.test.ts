/**
 * 视-2 重做后的自测：把 `views/fleet.js` **真的 mount 起来**，看三栏渲染出来的是什么。
 *
 *   node --test packages/app/test/fleet-mount.test.ts
 *
 * ## 为什么还要这一份（fleet.test.ts 已经验过结构）
 *
 * 那份读源码：能证明「代码里写了 `section('任务树')`」，**证明不了它真的画在页面上**。
 * 而这次重做最容易坏的正是这一类 —— 结构对、文案对、函数也在，但：
 *
 *   ① **状态徽章映射错档。** `failed` 画成灰色、`done` 画成橙色：代码里一个键写错，
 *      源码断言照样绿，用户看到的是「这一步好像没失败」。
 *   ② **干预 POST 的 body 形状错。** 多带 `step_id`、少带 `note`，后端 400，
 *      而界面只显示「正在提交…」后静默不动。所以这里截住真发出去的 body 逐键断言。
 *   ③ **「拿不到」被画成「没有任务」。** 两者对用户意味着完全不同的下一步。
 *   ④ **展开输入输出不生效。** 点了没反应、或者默认就全展开（一屏 JSON 看不到时间线）。
 *   ⑤ **自动刷新不停。** 卸载后定时器还在跑，切回来就变成两个轮询器。
 *
 * 桩的边界（说清楚，免得被当成「验过样式」）：只实现 fleet.js / dom.js / state.js
 * 真正调用到的 DOM API。不跑 CSS、不算布局。**能证明的是节点在、文案对、状态对、
 * 请求体对。**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const fleetUrl = pathToFileURL(join(viewsDir, 'fleet.js')).href;

/* ---------------------------------------------------------------------------------------------
 * 最小 DOM 桩
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
  /** 每个节点自己的监听器表；`dispatch` 冒泡时逐级读。 */
  __listeners: Record<string, Array<(event: unknown) => void>>;
  focus(): void;
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
    children: [] as StubNode[],
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    parentElement: null as StubNode | null,
    __listeners: listeners,
    focus() { /* 桩：只需存在 */ },

    // 像浏览器那样聚合后代文本 —— 否则 `assert.match(node.textContent, …)` 永远是空串。
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
      if (name === 'disabled') this.disabled = true;
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
      if (name === 'disabled') this.disabled = false;
    },

    addEventListener(type: string, fn: (event: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    /**
     * 派发一次事件，**沿 parentElement 向上冒泡**。
     *
     * 浏览器里点一行，事件会从那一行一路冒到容器；而实现把监听器都挂在容器上
     * （`treeHost` / `botHost` / `actions`）。桩若不冒泡，就一个监听器都调不到 ——
     * 于是「点了有反应」永远测不出来。`event.target` 始终是真正被点的那一行，
     * 所以 `closest()` 仍然能定位正确，不会把「点第二行」测成「点第一行」。
     */
    dispatch(type: string, event?: unknown) {
      const e = (event ?? { type }) as Record<string, unknown>;
      if (typeof e.preventDefault !== 'function') e.preventDefault = () => {};
      if (typeof e.stopPropagation !== 'function') e.stopPropagation = () => {};
      if (!e.target) e.target = this;
      let current: StubNode | null = this as unknown as StubNode;
      while (current) {
        for (const fn of current.__listeners?.[type] ?? []) fn(e);
        current = current.parentElement;
      }
    },

    /** 从自己往上找：`[data-x]` / `[data-x="y"]` / `.cls`。 */
    closest(selector: string) {
      let current: StubNode | null = this as unknown as StubNode;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },

    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string) {
      const out: StubNode[] = [];
      const walk = (current: StubNode): void => {
        for (const child of current.children) {
          if (matches(child, selector)) out.push(child);
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

/** `[data-x]` / `[data-x="y"]` / `.cls` / 标签名。 */
function matches(candidate: StubNode, selector: string): boolean {
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
}

/** 装桩，跑 `run`，再拆掉。`fleet.js` 只在调用时碰 document。 */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const documentStub = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (value: string): TextStub => ({ nodeType: 3, textContent: value }),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, Node: globals.Node, setInterval: globals.setInterval, clearInterval: globals.clearInterval };
  globals.document = documentStub;
  // `dom.js` 的 `kv()` 用 `value instanceof Node` 判断；桩里给个空基类够用。
  globals.Node = class NodeStub {};

  try {
    return await run();
  } finally {
    globals.document = saved.document;
    globals.Node = saved.Node;
    globals.setInterval = saved.setInterval;
    globals.clearInterval = saved.clearInterval;
  }
}

/* ---------------------------------------------------------------------------------------------
 * 搭一个能 mount 的 ctx
 * ------------------------------------------------------------------------------------------- */

/** 只有编队台用到的那几个字段。 */
const FOREST = {
  bots: [
    { bot_id: 'b1', name: 'ops', status: 'running', current_task_id: 'T1', task_count: 3 },
    { bot_id: 'b2', name: 'audit', status: 'waiting_operator', current_task_id: 'T2', task_count: 1 },
    { bot_id: 'b3', name: 'idle-one', status: 'idle', current_task_id: '', task_count: 0 },
  ],
};

const TREE = {
  task_id: 'T1',
  status: 'running',
  steps: [
    {
      step_id: 's1', name: '取数', status: 'done', elapsed_ms: 120,
      tool: 'robust_stats', input: { station_id: 'WUHN' }, output: { n: 86400 }, attempts: 1,
    },
    {
      step_id: 's2', name: '聚合', status: 'running', elapsed_ms: 3400,
      tool: 'aggregate', input: { window: '1h' }, output: null, attempts: 2,
    },
    {
      step_id: 's3', name: '写库', status: 'failed', elapsed_ms: 40,
      tool: 'store_write', input: { table: 'qc' }, output: null, attempts: 1,
      error: 'database is locked',
    },
    {
      step_id: 's4', name: '通知', status: 'skipped', elapsed_ms: 0,
      tool: 'notify', input: {}, output: null, attempts: 0,
    },
  ],
};

const EVENTS = {
  events: [
    { seq: 1, kind: 'tool.call', call_id: 'c-1', tool: 'robust_stats', ts: '2026-11-11T09:30:00.000Z' },
    { seq: 2, kind: 'tool.result', call_id: 'c-1', tool: 'robust_stats', ts: '2026-11-11T09:30:01.000Z' },
  ],
};

const PENDING = {
  pending: [
    { intervention_id: 'i0', task_id: 'T1', kind: 'pause', status: 'pending' },
  ],
};

interface Mounted {
  main: StubNode;
  head: StubNode;
  rail: StubNode;
  cleanup: () => void;
  /** 真发出去的请求，按顺序。 */
  calls: Array<{ url: string; init?: { method?: string; body?: string } }>;
  /** 本轮轮询器的回调（手动触发用）。 */
  ticks: Array<() => void>;
}

interface MountOptions {
  /** 按 URL 给响应；返回 `null` 表示「这个接口不该被调」。 */
  route?: (url: string, init?: { method?: string; body?: string }) => unknown;
  /** 假装 selectedTaskId 已经是某个值。 */
  selectedTaskId?: string;
}

/**
 * 装一份编队视角，并把 `fetch` / 定时器换掉。
 *
 * `fetch` 的桩替掉的是「网络」这一层：`getJson()` / `ensure()` 都是真的代码，
 * 所以缓存命中、失败保留旧值这些行为也一起被验到。
 */
async function mountFleet(options: MountOptions = {}): Promise<Mounted> {
  const { mount } = await import(fleetUrl);

  const main = makeNode('main');
  const head = makeNode('header');
  const rail = makeNode('aside');

  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const ticks: Array<() => void> = [];

  const defaultRoute = (url: string, init?: { method?: string }) => {
    if (url === '/api/botd/forest') return FOREST;
    if (url.startsWith('/api/botd/tree')) return TREE;
    if (url.startsWith('/api/botd/events')) return EVENTS;
    if (url === '/api/botd/pending') return PENDING;
    if (url === '/api/botd/intervene' && init?.method === 'POST') {
      return { ok: true, intervention_id: 'i-new', status: 'pending' };
    }
    return null;
  };
  const route = options.route ?? defaultRoute;

  const globals = globalThis as unknown as Record<string, unknown>;
  const savedFetch = globals.fetch;
  const savedSetInterval = globals.setInterval;
  const savedClearInterval = globals.clearInterval;

  globals.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), init });
    const payload = route(String(url), init);
    if (payload === null) {
      // 模拟 404：`getJson()` 会抛 `HTTP 404`，`ensure()` 记一次 error。
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };

  // 定时器换成「记下来、不自动跑」：轮询是否发生由测试手动触发，不靠等真实 3 秒。
  let cleared = 0;
  globals.setInterval = (fn: () => void) => { ticks.push(fn); return ticks.length; };
  globals.clearInterval = () => { cleared += 1; };

  const store = fakeStore(options.selectedTaskId ?? null);

  const unmount = mount({
    main,
    head,
    state: store.state,
    rail,
    renderRail: (draw: (host: StubNode) => void) => store.renderRail(rail, draw),
    repaintRail: () => store.repaint(),
    go: (path: string) => { calls.push({ url: `GO ${path}` }); },
  });

  // `mount()` 里的取数是异步的（`fetchFleet()` 不是 await 出来的）。
  // 不等一拍就断言，读到的是「正在取编队数据…」那一版 —— 整份测试会全假红。
  await settle(14);

  return {
    main,
    head,
    rail,
    calls,
    ticks,
    cleanup: () => {
      // 先卸载再还原定时器：卸载要经过计数桩，否则「清没清」根本没被观察到。
      const result = typeof unmount === 'function' ? unmount() : undefined;
      globals.fetch = savedFetch;
      globals.setInterval = savedSetInterval;
      globals.clearInterval = savedClearInterval;
      assert.ok(cleared >= 1, '卸载时必须清掉轮询器');
      return result;
    },
  };
}

/** 一个够编队台用的 store：get / set / subscribe / cache。 */
function fakeStore(initialSelected: string | null) {
  let value: {
    selectedTaskId: string | null;
    selectedTaskDraft: null;
    cache: Record<string, { state: string; value: unknown; error: { what: string; code: string; hint: string } | null; at: number }>;
  } = {
    selectedTaskId: initialSelected,
    selectedTaskDraft: null,
    cache: {
      forest: { state: 'idle', value: null, error: null, at: 0 },
      tree: { state: 'idle', value: null, error: null, at: 0 },
      events: { state: 'idle', value: null, error: null, at: 0 },
      pending: { state: 'idle', value: null, error: null, at: 0 },
    },
  };
  const listeners = new Set<(next: unknown, changed: Set<string>) => void>();
  /**
   * 外壳的行为照搬：`renderRail(draw)` 只**登记**，之后每次 `repaintRail()` 才重画。
   * 桩里必须留住这个 draw，否则「点一步 → 右栏跟着变」这条链会假绿（右栏一直是初值）。
   */
  let draw: ((host: StubNode) => void) | null = null;
  let rail: StubNode | null = null;

  return {
    state: {
      get: () => value,
      set(patch: Record<string, unknown>) {
        const changed = new Set<string>();
        for (const key of Object.keys(patch)) {
          if ((value as Record<string, unknown>)[key] !== patch[key]) changed.add(key);
        }
        value = { ...value, ...patch } as typeof value;
        for (const fn of listeners) fn(value, changed);
      },
      subscribe(fn: (next: unknown, changed: Set<string>) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    /** 对应外壳的 `renderRail`：登记 + 立刻画一次（外壳挂载时就会画）。 */
    renderRail: (host: StubNode, drawFn: (host: StubNode) => void) => {
      draw = drawFn;
      rail = host;
      drawFn(host);
    },
    /** 对应外壳的 `repaintRail`：用同一个节点重画，不清空引用。 */
    repaint: () => {
      if (draw && rail) draw(rail);
    },
  };
}

/** 等 async 链跑完（`fetchFleet()` / `selectTask()` 都不是 await 出来的，只能等几拍）。 */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 5));
}

/**
 * 点一下某个节点。
 *
 * 事件从**这一行自己**开始派发，然后沿 `parentElement` 冒到容器 —— 与浏览器一致。
 * 从容器开始派发是不行的：监听器就在容器上，而容器的祖先里没有它，
 * 于是「点了有反应」永远测不出来。
 */
function fire(target: StubNode, type = 'click'): void {
  target.dispatch(type, { type, target });
}

/* ---------------------------------------------------------------------------------------------
 * 1. 三栏结构：左 bot 列表 / 中步骤时间线 / 右详情
 * ------------------------------------------------------------------------------------------- */

test('三栏齐：左侧 bot 列表、中间步骤时间线、右侧（外壳右栏）选中 step 详情', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      // 左：bot 列表 —— DBOS 的「工作流列表」。
      const bots = view.main.querySelector('[data-bot-list]');
      assert.ok(bots, '左栏要有 bot 列表');
      assert.equal(view.main.querySelectorAll('[data-bot-id]').length, 3, '三个 bot 三行');

      // 中：步骤时间线 —— DBOS 的「步骤时间线」。
      const tree = view.main.querySelector('[data-task-tree]');
      assert.ok(tree, '中栏要有任务树');

      // 右：外壳右栏拿到过内容（`renderRail` 被调用），且里面是 step 详情。
      assert.ok(view.rail.children.length > 0, '右栏要有内容');
      const railText = view.rail.textContent;
      assert.match(railText, /选中任务/, '右栏有「选中任务」一节');
      assert.match(railText, /选中步骤/, '右栏有「选中步骤」一节');
      assert.match(railText, /事件流/, '右栏有事件流');
    } finally {
      view.cleanup();
    }
  });
});

test('左栏每行：名字 + 状态徽章，三个 bot 的状态各不相同', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const rows = view.main.querySelectorAll('[data-bot-id]');
      const byId = (id: string): StubNode => {
        const found = rows.find((row) => row.dataset.botId === id);
        assert.ok(found, `缺 bot ${id}`);
        return found;
      };

      const running = byId('b1');
      assert.match(running.textContent, /ops/, '名字');
      const runningBadge = running.querySelector('.vw-badge');
      assert.equal(runningBadge.textContent, '执行中', 'running 的中文');
      assert.equal(runningBadge.dataset.tone, 'run', 'running 的色调');

      const waiting = byId('b2');
      assert.equal(waiting.querySelector('.vw-badge').textContent, '等人批');
      assert.equal(waiting.querySelector('.vw-badge').dataset.tone, 'warn', '等人批要用 warn，它是要用户做事的');

      const idle = byId('b3');
      assert.equal(idle.querySelector('.vw-badge').textContent, '空闲');
      assert.equal(idle.querySelector('.vw-badge').dataset.tone, 'idle');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 2. 中间：步骤时间线
 * ------------------------------------------------------------------------------------------- */

test('中栏四步各一行，步骤名 / 工具 / 耗时 / 状态都在', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const rows = view.main.querySelectorAll('[data-step-id]');
      // 首屏会自动选中第一个有当前任务的 bot（T1），所以树已经出来了。
      assert.equal(rows.length, 4, `四步四行，实际 ${rows.length}`);

      const byId = (id: string): StubNode => {
        const found = rows.find((row) => row.dataset.stepId === id);
        assert.ok(found, `缺步骤 ${id}`);
        return found;
      };

      const s1 = byId('s1');
      assert.match(s1.textContent, /取数/, '步骤名');
      assert.match(s1.textContent, /robust_stats/, '工具名要显示');
      assert.match(s1.textContent, /120ms/, '耗时');
      assert.equal(s1.dataset.status, 'done');
    } finally {
      view.cleanup();
    }
  });
});

test('状态徽章映射：done→ok、running→run、failed→bad、skipped→idle，且都带字形', async () => {
  await withDom(async () => {
    const { statusBadge, STATUS_BADGES } = await import(fleetUrl);

    // 步的五态 + bot 的三态，档次一个都不能错。
    assert.deepEqual(statusBadge('done'), { glyph: '✓', label: '完成', tone: 'ok' });
    assert.deepEqual(statusBadge('running'), { glyph: '◆', label: '执行中', tone: 'run' });
    assert.deepEqual(statusBadge('failed'), { glyph: '✕', label: '失败', tone: 'bad' });
    assert.deepEqual(statusBadge('pending'), { glyph: '○', label: '待执行', tone: 'idle' });
    assert.deepEqual(statusBadge('skipped'), { glyph: '–', label: '跳过', tone: 'idle' });
    assert.deepEqual(statusBadge('waiting_operator'), { glyph: '◇', label: '等人批', tone: 'warn' });
    assert.deepEqual(statusBadge('idle'), { glyph: '○', label: '空闲', tone: 'idle' });

    // 每一档都必须有字形：只靠颜色，色弱用户看到一排一样的灰块。
    for (const [status, badge] of Object.entries(STATUS_BADGES) as Array<[string, { glyph: string }]>) {
      assert.ok(badge.glyph && badge.glyph.length > 0, `${status} 要有字形`);
    }
    // 同一个 tone 不能把 done 与 failed 混在一起 —— 那是最严重的一档错。
    assert.notEqual(STATUS_BADGES.done.tone, STATUS_BADGES.failed.tone);

    // 不认识的 status：原样显示，**不猜成「待执行」**。
    assert.equal(statusBadge('weird_new_state').label, 'weird_new_state', '原样显示');
    assert.equal(statusBadge('weird_new_state').tone, 'idle', '按 idle 上色');
    assert.equal(statusBadge(null).label, '—', '没有状态显示破折号');
  });
});

test('渲染出来的徽章色调与映射一致（不是只在函数里对）', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const badges = view.main.querySelectorAll('.vw-step-badge');
      const toneOf = (stepId: string): string => {
        const row = view.main.querySelectorAll('[data-step-id]').find((n) => n.dataset.stepId === stepId);
        assert.ok(row, `缺 ${stepId}`);
        return row.querySelector('.vw-step-badge').dataset.tone;
      };
      assert.equal(toneOf('s1'), 'ok');
      assert.equal(toneOf('s2'), 'run');
      assert.equal(toneOf('s3'), 'bad');
      assert.equal(toneOf('s4'), 'idle');
      assert.ok(badges.length >= 4);
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 3. 展开输入输出
 * ------------------------------------------------------------------------------------------- */

test('输入输出默认收起，点一步展开，再点收起', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const ioOf = (stepId: string): StubNode | null => view.main.querySelector(`[data-step-io="${stepId}"]`);

      // 默认收起：一屏全是 JSON 就看不到时间线了。
      assert.equal(ioOf('s1').hidden, true, '默认收起');
      assert.equal(ioOf('s1').getAttribute('hidden'), '', '收起时带 hidden 属性');

      const row = view.main.querySelectorAll('[data-step-id]').find((n) => n.dataset.stepId === 's1');
      assert.ok(row);
      assert.equal(row.getAttribute('aria-expanded'), 'false', '收起时 aria-expanded=false');

      // 点一下：展开。
      fire(row);
      await settle(2);
      const opened = ioOf('s1');
      assert.equal(opened.hidden, false, '点一下要展开');
      assert.match(opened.textContent, /station_id/, '输入里的真实字段要出来');
      assert.match(opened.textContent, /86400/, '输出里的值要出来');

      const reopenedRow = view.main.querySelectorAll('[data-step-id]').find((n) => n.dataset.stepId === 's1');
      assert.equal(reopenedRow.getAttribute('aria-expanded'), 'true');

      // 再点一下：收起。
      fire(reopenedRow);
      await settle(2);
      assert.equal(ioOf('s1').hidden, true, '再点要收起');
    } finally {
      view.cleanup();
    }
  });
});

test('展开后右栏同时显示这一步的详情（输入 / 输出 / 错误 / 重试次数）', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const row = view.main.querySelectorAll('[data-step-id]').find((n) => n.dataset.stepId === 's3');
      assert.ok(row);
      fire(row);
      await settle(2);

      const detail = view.rail.querySelector('[data-step-detail]');
      assert.ok(detail, '右栏要点出这一步');
      assert.equal(detail.dataset.stepDetail, 's3');
      const text = detail.textContent;
      assert.match(text, /写库/, '步骤名');
      assert.match(text, /store_write/, '工具');
      assert.match(text, /database is locked/, '错误信息必须显示');
      assert.match(text, /重试次数/, '重试次数要在');
      assert.match(text, /失败/, '状态');
    } finally {
      view.cleanup();
    }
  });
});

test('没有 error 的步不画错误块（不编一条出来）', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const row = view.main.querySelectorAll('[data-step-id]').find((n) => n.dataset.stepId === 's1');
      assert.ok(row);
      fire(row);
      await settle(2);

      const detail = view.rail.querySelector('[data-step-detail]');
      assert.ok(detail);
      assert.doesNotMatch(detail.textContent, /错误/, '没出错就不该有「错误」这一块');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 4. 干预：POST 的 body 形状 + 刷新
 * ------------------------------------------------------------------------------------------- */

test('点「暂停」真的 POST 到 /api/botd/intervene，body 正好三个键', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const pause = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === 'pause');
      assert.ok(pause, '要有暂停按钮');
      assert.equal(pause.disabled, false, '任务在跑时暂停可用');

      fire(pause);
      await settle();

      const posts = view.calls.filter((call) => call.url === '/api/botd/intervene');
      assert.equal(posts.length, 1, `只发一次，实际 ${posts.length}`);
      assert.equal(posts[0].init?.method, 'POST', '必须是 POST');

      const body = JSON.parse(String(posts[0].init?.body));
      // 形状就是接口约定：多一个键会让后端以为「按步干预」，少一个键直接 400。
      assert.deepEqual(Object.keys(body).sort(), ['kind', 'note', 'task_id'], 'body 只有三个键');
      assert.equal(body.task_id, 'T1', 'task_id 来自选中的树');
      assert.equal(body.kind, 'pause');
      assert.equal(typeof body.note, 'string', 'note 一定是字符串，不是 undefined');
    } finally {
      view.cleanup();
    }
  });
});

test('干预请求体构造函数：三个键、缺省 note 是空串', async () => {
  const { interveneBody } = await import(fleetUrl);
  assert.deepEqual(interveneBody('T1', 'pause'), { task_id: 'T1', kind: 'pause', note: '' });
  assert.deepEqual(interveneBody('T1', 'retry', '把窗口从 1h 改成 6h'), {
    task_id: 'T1', kind: 'retry', note: '把窗口从 1h 改成 6h',
  });
  // 传 null 也不能变成 "null" 字符串或 undefined。
  assert.deepEqual(interveneBody(null, null), { task_id: '', kind: '', note: '' });
  assert.deepEqual(Object.keys(interveneBody('a', 'b')).sort(), ['kind', 'note', 'task_id'], '不许加字段');
});

test('暂停后那条「将在当前步骤完成后生效」立刻可见（不写「已暂停」）', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const notice = view.main.querySelector('[data-pause-notice]');
      assert.ok(notice, '要有暂停提示');
      assert.equal(notice.hidden, true, '没点之前不显示');

      const pause = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === 'pause');
      assert.ok(pause);
      fire(pause);
      await settle();

      assert.equal(notice.hidden, false, '点了必须显示');
      assert.match(notice.textContent, /将在当前步骤完成后生效/, '说「将生效」，不说「已生效」');
      assert.doesNotMatch(notice.textContent, /已暂停/, '绝不能写「已暂停」');
    } finally {
      view.cleanup();
    }
  });
});

test('成功后刷新：POST 之后又重新取了 forest（界面不能停在猜测上）', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const forestBefore = view.calls.filter((call) => call.url === '/api/botd/forest').length;
      const pause = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === 'pause');
      assert.ok(pause);
      fire(pause);
      await settle(12);

      const forestAfter = view.calls.filter((call) => call.url === '/api/botd/forest').length;
      assert.ok(forestAfter > forestBefore, '提交成功后必须重取一次');

      const note = view.main.querySelector('[data-action-note]');
      assert.equal(note.hidden, false, '要有结果提示');
      assert.match(note.textContent, /已提交/, '说清提交了');
      assert.match(note.textContent, /i-new/, '带上后端给的 intervention_id');
    } finally {
      view.cleanup();
    }
  });
});

test('改参重试必须先写说明，否则不发请求', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      // T1 有一步 failed，所以改参重试可用。
      const retry = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === 'retry');
      assert.ok(retry, '要有改参重试');
      assert.equal(retry.disabled, false, '有失败步骤时可用');

      fire(retry);
      await settle();

      assert.equal(
        view.calls.filter((call) => call.url === '/api/botd/intervene').length, 0,
        '没写说明就发出去，等于一条无法解释的输入变更',
      );
      const note = view.main.querySelector('[data-action-note]');
      assert.equal(note.hidden, false);
      assert.match(note.textContent, /写明改了什么/);

      // 填上说明再点：这次要发，且 body 里的 note 就是填的那句。
      const input = view.main.querySelector('[data-note]');
      assert.ok(input, '要有说明框');
      input.value = '把窗口从 1h 改成 6h';
      fire(retry);
      await settle();

      const posts = view.calls.filter((call) => call.url === '/api/botd/intervene');
      assert.equal(posts.length, 1, '有说明就该发');
      const body = JSON.parse(String(posts[0].init?.body));
      assert.equal(body.kind, 'retry');
      assert.equal(body.note, '把窗口从 1h 改成 6h');
    } finally {
      view.cleanup();
    }
  });
});

test('后端说 ok:false 时不假装成功', async () => {
  await withDom(async () => {
    const view = await mountFleet({
      route: (url, init) => {
        if (url === '/api/botd/forest') return FOREST;
        if (url.startsWith('/api/botd/tree')) return TREE;
        if (url.startsWith('/api/botd/events')) return EVENTS;
        if (url === '/api/botd/pending') return PENDING;
        if (url === '/api/botd/intervene' && init?.method === 'POST') {
          return { ok: false, status: 'rejected', error: 'takeover 需要审批' };
        }
        return null;
      },
    });
    try {
      const takeover = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === 'takeover');
      assert.ok(takeover);
      fire(takeover);
      await settle();

      const note = view.main.querySelector('[data-action-note]');
      assert.equal(note.hidden, false);
      assert.match(note.textContent, /没有接受/, '要说后端没接受');
      assert.match(note.textContent, /takeover 需要审批/, '把后端给的原因带出来');
      assert.doesNotMatch(note.textContent, /已提交/, '不能同时说「已提交」');
    } finally {
      view.cleanup();
    }
  });
});

test('POST 挂了（接口 404）时说明「干预没有发出去」，不是静默失败', async () => {
  await withDom(async () => {
    const view = await mountFleet({
      route: (url, init) => {
        if (url === '/api/botd/forest') return FOREST;
        if (url.startsWith('/api/botd/tree')) return TREE;
        if (url.startsWith('/api/botd/events')) return EVENTS;
        if (url === '/api/botd/pending') return PENDING;
        if (url === '/api/botd/intervene' && init?.method === 'POST') return null; // 404
        return null;
      },
    });
    try {
      const pause = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === 'pause');
      assert.ok(pause);
      fire(pause);
      await settle();

      const note = view.main.querySelector('[data-action-note]');
      assert.equal(note.hidden, false, '失败也必须有提示');
      assert.match(note.textContent, /干预没有发出去/);
      assert.match(note.textContent, /404/, '带上真实状态码');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 5. 干预可用性
 * ------------------------------------------------------------------------------------------- */

test('四个干预的可用性：暂停看是否在跑、继续看有没有待生效的暂停、重试看有没有失败', async () => {
  const { interventionAvailability } = await import(fleetUrl);

  const running = { task_id: 'T1', status: 'running', steps: [{ status: 'done' }, { status: 'running' }] };
  assert.deepEqual(
    (({ pause, resume, retry, takeover }) => ({ pause: pause.enabled, resume: resume.enabled, retry: retry.enabled, takeover: takeover.enabled }))(interventionAvailability(running, [])),
    { pause: true, resume: false, retry: false, takeover: true },
    '任务在跑、没失败：暂停与接管可用',
  );

  // 有一条待生效的 pause 时「继续」才可用。
  const paused = interventionAvailability(running, [{ task_id: 'T1', kind: 'pause', status: 'pending' }]);
  assert.equal(paused.resume.enabled, true, '有 pending 的 pause 才能继续');
  assert.equal(interventionAvailability(running, [{ task_id: 'T2', kind: 'pause' }]).resume.enabled, false, '别的任务的暂停不算');
  assert.equal(interventionAvailability(running, [{ task_id: 'T1', kind: 'retry' }]).resume.enabled, false, '别的 kind 不算');

  const failed = { task_id: 'T1', status: 'failed', steps: [{ status: 'failed' }] };
  const f = interventionAvailability(failed, []);
  assert.equal(f.pause.enabled, false, '没在跑就不能暂停');
  assert.equal(f.retry.enabled, true, '有失败就能改参重试');
  assert.equal(f.takeover.enabled, true, '有失败就能接管');

  const done = { task_id: 'T1', status: 'done', steps: [{ status: 'done' }, { status: 'skipped' }] };
  const d = interventionAvailability(done, []);
  assert.equal(d.pause.enabled || d.retry.enabled || d.takeover.enabled, false, '全跑完都不能用');

  // 没有树：全部不可用，且理由是人话。
  const none = interventionAvailability(null, []);
  for (const key of ['pause', 'resume', 'retry', 'takeover']) {
    assert.equal(none[key].enabled, false, `${key} 在没有选中任务时不可用`);
    assert.equal(none[key].why, '还没有选中任务', `${key} 要给出理由`);
  }
});

test('不可用的按钮置灰、带 title 理由、并且 aria-disabled', async () => {
  await withDom(async () => {
    // 全跑完的任务：四个干预全灰。
    const doneTree = {
      task_id: 'T1', status: 'done',
      steps: [{ step_id: 's1', name: '取数', status: 'done', elapsed_ms: 10, tool: 'x', input: {}, output: {}, attempts: 1 }],
    };
    const view = await mountFleet({
      route: (url) => {
        if (url === '/api/botd/forest') return FOREST;
        if (url.startsWith('/api/botd/tree')) return doneTree;
        if (url.startsWith('/api/botd/events')) return EVENTS;
        if (url === '/api/botd/pending') return { pending: [] };
        return null;
      },
    });
    try {
      for (const kind of ['pause', 'retry', 'takeover']) {
        const btn = view.main.querySelectorAll('[data-kind]').find((n) => n.dataset.kind === kind);
        assert.ok(btn, `要有 ${kind}`);
        assert.equal(btn.disabled, true, `${kind} 应置灰`);
        assert.ok(String(btn.title).length > 0, `${kind} 灰掉必须给理由`);
        assert.equal(btn.getAttribute('aria-disabled'), 'true', `${kind} 读屏也要知道`);
      }
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 6. 空态与错误态：说清「拿不到 + 为什么」
 * ------------------------------------------------------------------------------------------- */

test('forest 404 时三处都写「拿不到」，绝不写「还没有任务」', async () => {
  await withDom(async () => {
    const view = await mountFleet({
      route: (url) => {
        // 全部 404：五个端点都没开。
        if (url === '/api/botd/forest') return null;
        return null;
      },
    });
    try {
      const mainText = view.main.textContent;
      assert.match(mainText, /编队列表还拿不到数据/, '左栏说拿不到');
      assert.match(mainText, /任务树还拿不到数据/, '中栏说拿不到');
      assert.match(mainText, /还没接上/, '说清是「还没接上」而不是「没有」');
      assert.match(mainText, /不是「没有任务」，是「还没接上」/, '把区别明写在文案里');
      assert.doesNotMatch(mainText, /还没有任务/, '绝不能画成「没有任务」—— 用户会去建一个本来就有的');

      // 「拿不到」必须给一个能点的动作：什么都不给等于死路。
      const retry = view.main.querySelectorAll('[data-action="retry-fleet"]');
      assert.ok(retry.length >= 1, '要给重试');
    } finally {
      view.cleanup();
    }
  });
});

test('「拿不到」里带出真实错误码与下一步（不是一句泛泛的「出错了」）', async () => {
  await withDom(async () => {
    const view = await mountFleet({ route: () => null });
    try {
      const text = view.main.textContent;
      // describeFailure 对 HTTP 404 会带 404 与一句「该做什么」。
      assert.match(text, /404/, '错误码要露出来（报 bug 时要用）');
      assert.match(text, /重试一次/, '要给下一步');
    } finally {
      view.cleanup();
    }
  });
});

test('forest 回空数组时写「还没有 bot」，与「拿不到」区分开', async () => {
  await withDom(async () => {
    const view = await mountFleet({
      route: (url) => {
        if (url === '/api/botd/forest') return { bots: [] };
        if (url === '/api/botd/pending') return { pending: [] };
        return null;
      },
    });
    try {
      const text = view.main.textContent;
      assert.match(text, /还没有 bot/, '空就是真的空');
      assert.doesNotMatch(text, /拿不到/, '接口通了就不该说拿不到');
      // 还没有任务时，下一步要给出去处。
      assert.match(text, /还没有任务/, '任务区说没有任务');
      assert.ok(view.main.querySelector('[data-action="go-chat"]'), '给「去问一句」');
      assert.ok(view.main.querySelector('[data-action="go-suite"]'), '给「去套件台」');
    } finally {
      view.cleanup();
    }
  });
});

test('概览：完成 / 失败这两档 forest 不给，就显示 —（不填 0）', async () => {
  const { overviewCounts } = await import(fleetUrl);

  const onlyBots = overviewCounts({ bots: FOREST.bots, pending: [] });
  assert.equal(onlyBots.counts.running, 1);
  assert.equal(onlyBots.counts.awaiting, 1, 'waiting_operator 计入等人批');
  assert.equal(onlyBots.known.done, false, 'done 是「不知道」');
  assert.equal(onlyBots.known.failed, false, 'failed 是「不知道」');

  // pending 比 bot 级状态更可信时，取较大的那个（不重复计同一件事）。
  const withPending = overviewCounts({ bots: FOREST.bots, pending: [{}, {}, {}] });
  assert.equal(withPending.counts.awaiting, 3, 'pending 有三条就至少是 3');

  // bot 自己带 done / failed 时，那一档就是知道的。
  const withDone = overviewCounts({ bots: [{ status: 'done' }, { status: 'failed' }], pending: [] });
  assert.equal(withDone.known.done, true);
  assert.equal(withDone.known.failed, true);
  assert.equal(withDone.counts.done, 1);
  assert.equal(withDone.counts.failed, 1);
});

test('概览渲染：不知道的那两档是「—」，且有一行小字解释口径', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const value = (key: string): StubNode => {
        const item = view.head.querySelector(`[data-overview-key="${key}"]`);
        assert.ok(item, `缺概览 ${key}`);
        return item.querySelector('.vw-overview-value');
      };
      assert.equal(value('running').textContent, '1', 'running 有真值');
      assert.equal(value('awaiting').textContent, '1', '等人批有真值');
      assert.equal(value('done').textContent, '—', 'done 不知道就是 —');
      assert.equal(value('failed').textContent, '—', 'failed 不知道就是 —');
      assert.match(view.head.textContent, /任务级口径/, '要解释为什么是 —');
    } finally {
      view.cleanup();
    }
  });
});

test('右栏：没选任务 / 选了任务但没选步骤，两种空态的话不一样', async () => {
  await withDom(async () => {
    const view = await mountFleet({ selectedTaskId: null });
    try {
      // 首屏会自动选第一个有当前任务的 bot，所以右栏已经有「选中任务」。
      assert.match(view.rail.textContent, /选中步骤/);
      assert.match(view.rail.textContent, /点中间时间线上的一步/, '没选步骤时告诉用户点哪里');
    } finally {
      view.cleanup();
    }
  });
});

test('事件流：右栏按 seq 列出 kind / tool / 时间', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      const text = view.rail.textContent;
      assert.match(text, /tool\.call/, '事件种类');
      assert.match(text, /robust_stats/, '工具名');
      assert.match(text, /#1/, '序号');
      assert.match(text, /#2/);

      const rows = view.rail.querySelectorAll('[data-phase]');
      assert.equal(rows.length, 2, '两条事件两行');
    } finally {
      view.cleanup();
    }
  });
});

test('事件流挂了不影响任务树（它挂了不该把整块拉黑）', async () => {
  await withDom(async () => {
    const view = await mountFleet({
      route: (url) => {
        if (url === '/api/botd/forest') return FOREST;
        if (url.startsWith('/api/botd/tree')) return TREE;
        if (url.startsWith('/api/botd/events')) return null; // 事件 404
        if (url === '/api/botd/pending') return PENDING;
        return null;
      },
    });
    try {
      assert.equal(view.main.querySelectorAll('[data-step-id]').length, 4, '树照常出来');
      assert.match(view.rail.textContent, /事件流还拿不到数据/, '事件那边说清拿不到');
      assert.doesNotMatch(view.main.textContent, /任务树还拿不到数据/, '树不该被事件带挂');
    } finally {
      view.cleanup();
    }
  });
});

/* ---------------------------------------------------------------------------------------------
 * 7. 自动刷新（轮询）
 * ------------------------------------------------------------------------------------------- */

test('自动刷新：注册了一个轮询器，手动触发会重新取数', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      assert.equal(view.ticks.length, 1, '只注册一个轮询器（多一个就是两条链在跑）');

      const before = view.calls.filter((call) => call.url === '/api/botd/forest').length;
      view.ticks[0]();
      await settle(10);
      const after = view.calls.filter((call) => call.url === '/api/botd/forest').length;
      assert.ok(after > before, '一次轮询要真的重新取 forest');
    } finally {
      view.cleanup();
    }
  });
});

test('卸下后轮询器被清掉（不清会越切越多）', async () => {
  await withDom(async () => {
    const cleared: number[] = [];
    const globals = globalThis as unknown as Record<string, unknown>;
    const savedSet = globals.setInterval;
    const savedClear = globals.clearInterval;
    let handle = 0;
    globals.setInterval = () => { handle += 1; return handle; };
    globals.clearInterval = (id: number) => { cleared.push(id); };

    try {
      const { mount } = await import(fleetUrl);
      const main = makeNode('main');
      const head = makeNode('header');
      const rail = makeNode('aside');
      const store = fakeStore(null);
      globals.fetch = async (url: string) => {
        if (String(url) === '/api/botd/forest') return { ok: true, status: 200, json: async () => FOREST };
        return { ok: true, status: 200, json: async () => ({ steps: [], events: [], pending: [] }) };
      };

      const unmount = mount({
        main, head, state: store.state, rail,
        renderRail: (draw: (host: StubNode) => void) => draw(rail),
        repaintRail: () => {},
        go: () => {},
      });
      await settle();

      assert.equal(handle, 1, '挂载时注册一个');
      unmount();
      assert.deepEqual(cleared, [1], '卸载时必须清掉那一个');
    } finally {
      globals.setInterval = savedSet;
      globals.clearInterval = savedClear;
    }
  });
});

test('轮询间隔是常量，能被测试读出来（不写死在 setTimeout 里）', async () => {
  const { POLL_MS } = await import(fleetUrl);
  assert.equal(typeof POLL_MS, 'number');
  assert.ok(POLL_MS >= 1000 && POLL_MS <= 10000, `间隔要合理，实际 ${POLL_MS}`);
});

/* ---------------------------------------------------------------------------------------------
 * 8. 纯函数：树归一与 JSON 显示
 * ------------------------------------------------------------------------------------------- */

test('normalizeTree 自己数出五个计数，skipped 单列', async () => {
  const { normalizeTree } = await import(fleetUrl);
  const tree = normalizeTree(TREE);
  assert.equal(tree.counts.steps, 4);
  assert.equal(tree.counts.done, 1);
  assert.equal(tree.counts.failed, 1);
  assert.equal(tree.counts.skipped, 1, 'skipped 必须单列');
  assert.equal(tree.counts.pending, 1, 'running 归到未结束');
  // 五个键齐全：界面各处只有这一个进度来源。
  assert.deepEqual(Object.keys(tree.counts).sort(), ['done', 'failed', 'pending', 'skipped', 'steps']);

  // 坏输入不崩。
  for (const bad of [null, undefined, {}, { steps: null }, 'nope']) {
    const parsed = normalizeTree(bad);
    assert.deepEqual(parsed.steps, []);
    assert.equal(parsed.counts.steps, 0);
    assert.equal(parsed.status, 'pending', '缺状态时按 pending，不编一个 running');
  }
});

test('进度分子含 skipped（少算它进度永远差一格）', async () => {
  await withDom(async () => {
    const view = await mountFleet();
    try {
      // T1 是 1 done + 1 failed + 1 skipped + 1 running：已结束 3，共 4。
      // 用 `.vw-tree-row` 而不是 `[data-task-id]`：bot 行也带 taskId（它的当前任务），
      // 用属性选会先命中左栏那一行，而它没有进度列。
      const row = view.main.querySelector('.vw-tree-row');
      assert.ok(row, '任务头行');
      const progress = row.querySelector('.vw-tree-progress');
      assert.equal(progress.textContent, '3/4', 'done+failed+skipped = 3，共 4 步');
    } finally {
      view.cleanup();
    }
  });
});

test('readJson：null / undefined 说「没有」，不印 {}', async () => {
  const { readJson } = await import(fleetUrl);
  assert.equal(readJson(null), '（没有）');
  assert.equal(readJson(undefined), '（没有）');
  assert.equal(readJson({ a: 1 }), '{\n  "a": 1\n}', '带缩进，能看层级');
  assert.equal(readJson([1, 2]), '[\n  1,\n  2\n]');
  // 空对象是「有值但为空」，与「没有」不是一回事。
  assert.equal(readJson({}), '{}');
});
