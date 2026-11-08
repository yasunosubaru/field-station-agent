/**
 * 视-1 的自测：工具卡五要素、审批卡四要素、三条硬规矩。
 *
 *   node --test packages/app/test/cards.test.ts
 *
 * ## 为什么这些断言值得写
 *
 * 第 26.15 节列了视-1 的错法，两条都是「看起来做了、实际没做」：
 *   · 工具卡有状态没耗时 —— 用户判断不了「正常不正常」；
 *   · 审批卡的「做什么」和「后果」写在一句里 —— 「归档」听起来无害，
 *     但「写 120 MB 到磁盘」可能是用户不想的。
 * 这两类错都能靠「字段在不在、是不是分开的」机械检出，所以这里断言 DOM 结构。
 *
 * ## 怎么跑 DOM
 *
 * 不引 jsdom（本包零依赖是它的卖点）：用一个最小的 DOM 桩。
 * 桩只实现 `cards.js` 真正用到的那几个 API，够验结构，不够跑样式。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const agentDir = join(appDir, 'src', 'web', 'agent');
const cardsPath = join(agentDir, 'cards.js');
/** Windows 上动态 import 必须用 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME。 */
const cardsUrl = pathToFileURL(cardsPath).href;

/* ---------------------------------------------------------------------------------------------
 * 最小 DOM 桩
 * ------------------------------------------------------------------------------------------- */

interface StubNode {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  children: StubNode[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  parentElement: StubNode | null;
  disabled: boolean;
  value: string;
  focus(): void;
  removeAttribute(name: string): void;
  appendChild(child: StubNode | { nodeType: 3; textContent: string }): StubNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (...args: unknown[]) => void): void;
  dispatch(type: string, event?: unknown): void;
  querySelector(selector: string): StubNode | null;
  querySelectorAll(selector: string): StubNode[];
  replaceWith(node: StubNode): void;
  remove(): void;
  insertBefore(node: StubNode, ref: StubNode | null): void;
  classList: { add(cls: string): void; remove(cls: string): void; toggle(cls: string, on?: boolean): void };
  innerHTML: string;
  replaceChildren(...nodes: StubNode[]): void;
}

function makeNode(tagName: string): StubNode {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let ownText = '';
  const node: StubNode = {
    tagName: tagName.toUpperCase(),
    className: '',
    hidden: false,
    children: [],
    attrs: {},
    dataset: {},
    parentElement: null,
    disabled: false,
    value: '',
    innerHTML: '',
    focus() { /* 桩：只需存在，行为不重要 */ },
    // `textContent` 必须像浏览器那样**聚合所有后代的文本** —— 否则
    // `summary.textContent` 永远拿到空串，摘要断言就变成了假通过。
    get textContent() {
      return ownText + this.children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      ownText = String(value ?? '');
      this.children = [];
    },
    appendChild(child) {
      const asNode = child as StubNode;
      if (asNode.nodeType === 3) {
        ownText += asNode.textContent;
        return this;
      }
      asNode.parentElement = this;
      this.children.push(asNode);
      return asNode;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      // `hidden` 是属性也是特性：桩要两边同步，否则断言 `hidden === true` 永远假。
      if (name === 'hidden') this.hidden = true;
      // 让 `data-*` 归一到 dataset，和浏览器一致 —— 测试要靠 dataset 找卡。
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
    getAttribute(name) {
      if (name === 'hidden') return this.hidden ? '' : null;
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    removeAttribute(name) {
      delete this.attrs[name];
      if (name === 'hidden') this.hidden = false;
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] ?? []) fn(event ?? { type, stopPropagation() {}, preventDefault() {} });
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const out: StubNode[] = [];
      const matches = (candidate: StubNode): boolean => {
        // `[data-x="y"]` 必须**先**判 —— 它也以 `]` 结尾，放在无值分支后面会被
        // 当成「有无该属性」处理，于是算出错误的属性名、永远匹配不到。
        if (selector.startsWith('[data-') && selector.includes('="')) {
          const body = selector.slice(1, -1);
          const eq = body.indexOf('=');
          const name = body.slice(5, eq).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
          const want = body.slice(eq + 2, -1);
          return candidate.dataset[name] === want;
        }
        if (selector.startsWith('[data-') && selector.endsWith(']')) {
          const name = selector.slice(6, -1).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
          return candidate.dataset[name] !== undefined;
        }
        if (selector.startsWith('.')) {
          return candidate.className.split(/\s+/).includes(selector.slice(1));
        }
        if (selector.startsWith('code')) return candidate.tagName === 'CODE';
        if (selector.startsWith('textarea')) return candidate.tagName === 'TEXTAREA';
        if (selector.startsWith('button')) return candidate.tagName === 'BUTTON';
        return false;
      };
      const walk = (current: StubNode): void => {
        for (const child of current.children) {
          if (matches(child)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    replaceWith(next) {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) {
        parent.children[index] = next;
        next.parentElement = parent;
        this.parentElement = null;
      }
    },
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentElement = null;
    },
    insertBefore(next, ref) {
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index >= 0) {
        this.children.splice(index, 0, next);
      } else {
        this.children.push(next);
      }
      next.parentElement = this;
      return next;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const item of nodes) {
        if (item) this.appendChild(item);
      }
    },
    classList: {
      add(this: unknown, cls: string) {
        const host = this as unknown as StubNode;
        if (!host.className.split(/\s+/).includes(cls)) host.className = `${host.className} ${cls}`.trim();
      },
      remove(this: unknown, cls: string) {
        const host = this as unknown as StubNode;
        host.className = host.className.split(/\s+/).filter((name) => name !== cls).join(' ');
      },
      toggle(this: unknown, cls: string, on?: boolean) {
        const host = this as unknown as StubNode;
        const has = host.className.split(/\s+/).includes(cls);
        const want = on === undefined ? !has : on;
        if (want) (host.classList as { add(c: string): void }).add(cls);
        else (host.classList as { remove(c: string): void }).remove(cls);
      },
    },
  } as StubNode;
  return node;
}

/** 把桩装到 globalThis 上，再动态 import cards.js（它一加载就用 document）。 */
async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const documentStub = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (value: string) => ({ nodeType: 3, textContent: value }),
    // `iconSvg` 走 SVG 命名空间；桩不区分命名空间，标签名够用。
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = documentStub;
  try {
    return await run();
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

/* ---------------------------------------------------------------------------------------------
 * 1. 工具卡五要素
 * ------------------------------------------------------------------------------------------- */

test('工具卡五要素齐：名 / 状态 / 耗时 / 返回摘要 / call_id', async () => {
  await withDom(async () => {
    const { renderToolCard } = await import(cardsUrl);
    const card = renderToolCard({
      id: 'c1',
      name: 'robust_stats',
      status: 'ok',
      durationMs: 412,
      callId: 'call-abc123',
      data: { n: 86400, cn0_median: 44.2, missing: 604, p05: 30, p95: 51 },
    });

    // ① 工具名（等宽：`.ag-tool-name` 是要能一眼分辨 robust_stats 与 slope_stats 的）。
    const name = card.querySelector('.ag-tool-name');
    assert.ok(name, '要有工具名');
    assert.equal(name.textContent, 'robust_stats');

    // ② 状态 + 耗时。
    const pill = card.querySelector('.ag-pill');
    assert.ok(pill, '要有状态');
    assert.equal(pill.dataset.status, 'ok');
    assert.equal(pill.textContent, '成功');

    const dur = card.querySelector('.ag-dur');
    assert.ok(dur, '要有耗时');
    assert.match(dur.textContent, /412\s*ms/, '耗时是 412ms');

    // ③ 返回摘要：3–4 个关键数字，不是全部。
    const summary = card.querySelector('.ag-tool-summary');
    assert.ok(summary, '要有结果摘要');
    // 数字带千分位（视觉规矩一：一列数字要能比大小），所以断言也按带逗号的写法。
    assert.match(summary.textContent, /86,?400/, '有样本量');
    assert.match(summary.textContent, /44\.2/, '有核心指标');
    assert.match(summary.textContent, /604/, '有缺测数');
    // 分位数属于 trace，不该进摘要（25.8.2 点明了 p05/p25/p75/p95/mad 不进）。
    assert.doesNotMatch(summary.textContent, /p05/, '分位数不进摘要');
    assert.doesNotMatch(summary.textContent, /p95/, '分位数不进摘要');

    // ④ 展开入口：叫「查看 trace」，不是「详情」。
    const trace = card.querySelector('.ag-tool-trace');
    assert.ok(trace, '要有展开入口');
    assert.equal(trace.textContent, '查看 trace', '入口叫「查看 trace」');

    // ⑤ call_id：必须在（回源的唯一入口，规格 6.3 规矩三）。
    const callId = card.querySelector('.ag-tool-call-id');
    assert.ok(callId, '工具卡必须有 call_id');
    assert.equal(callId.textContent, 'call-abc123');
    assert.equal(card.dataset.callId, 'call-abc123', 'call_id 同时进 data 属性');
  });
});

test('工具卡结果摘要只取标量，且优先「最能改变判断」的几个', async () => {
  await withDom(async () => {
    const { resultSummary } = await import(cardsUrl);

    // 对象与数组是细节，属于 trace，不进摘要。
    const rows = resultSummary({
      n: 86400,
      nested: { a: 1 },
      list: [1, 2, 3],
      missing: 604,
      cn0_median: 44.2,
    }, 3);
    assert.deepEqual(rows.map((row: { key: string }) => row.key), ['n', 'cn0_median', 'missing']);

    // 没有可用字段时返回空 —— 调用方据此不显示摘要行，而不是显示一堆无关数字。
    assert.deepEqual(resultSummary({ nested: { a: 1 }, list: [] }), []);
    assert.deepEqual(resultSummary(null), []);
  });
});

test('工具卡没有 call_id 时不伪造', async () => {
  await withDom(async () => {
    const { renderToolCard } = await import(cardsUrl);
    const card = renderToolCard({ id: 'c2', name: 'x', status: 'ok' });
    assert.equal(card.querySelector('.ag-tool-call-id'), null, '没有就不画，不编一个');
  });
});

/* ---------------------------------------------------------------------------------------------
 * 2. 审批卡四要素
 * ------------------------------------------------------------------------------------------- */

test('审批卡四要素齐：风险等级 / 动作 + 后果分写 / 批准拒绝 / 查看证据', async () => {
  await withDom(async () => {
    const { renderApprovalCard } = await import(cardsUrl);
    const card = renderApprovalCard({
      id: 'a1',
      status: 'pending',
      risk: 'high',
      prompt: '归档到 exports/2026-11-08/ 并生成工单。',
      impact: '新增 3 个文件，共约 120 MB。',
      callId: 'call-x1',
    });

    // ① 风险等级。
    const risk = card.querySelector('.ag-risk');
    assert.ok(risk, '要有风险等级');
    assert.equal(risk.textContent, '高风险');

    // ② 动作与后果**分两行**（25.9.1：「做什么」和「后果」必须分开写）。
    const what = card.querySelector('.ag-approval-what');
    const impact = card.querySelector('.ag-approval-impact');
    assert.ok(what, '要有动作描述');
    assert.match(what.textContent, /归档到 exports/);
    assert.ok(impact, '要有独立的后果行');
    assert.match(impact.textContent, /120 MB/);
    assert.notEqual(what, impact, '动作与后果不能是同一个节点');

    // ③ 批准 / 拒绝。
    const approve = card.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'approved');
    const reject = card.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'rejected');
    assert.ok(approve, '要有批准');
    assert.ok(reject, '要有拒绝');
    assert.equal(approve.textContent, '批准');
    assert.equal(reject.textContent, '拒绝');

    // ④ 查看证据。
    const evidence = card.querySelector('[data-action="evidence"]');
    assert.ok(evidence, '要有查看证据');
    assert.equal(evidence.textContent, '查看证据');

    // 未决标记：对话页据此禁用输入框。
    assert.equal(card.dataset.pending, 'true');
  });
});

test('拒绝不做成红色大按钮（会让人不敢拒绝）', async () => {
  await withDom(async () => {
    const { renderApprovalCard } = await import(cardsUrl);
    const card = renderApprovalCard({ id: 'a2', status: 'pending', risk: 'medium' });
    const reject = card.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'rejected');
    assert.ok(reject);
    assert.doesNotMatch(reject.className, /danger/, '拒绝不能用 danger 样式');
  });
});

/* ---------------------------------------------------------------------------------------------
 * 3. 三条硬规矩
 * ------------------------------------------------------------------------------------------- */

test('规矩二：拒绝必须填理由 —— 空理由点了也不提交', async () => {
  await withDom(async () => {
    const { renderApprovalCard } = await import(cardsUrl);
    const calls: Array<{ decision: string; payload: unknown }> = [];
    const card = renderApprovalCard({ id: 'a3', status: 'pending', risk: 'high', prompt: '写盘' }, {
      onApproval: async (_card: unknown, decision: string, payload: unknown) => {
        calls.push({ decision, payload });
      },
    });

    const reject = card.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'rejected');
    const reasonField = card.querySelector('.ag-reason-field');
    assert.ok(reject && reasonField);
    assert.equal(reasonField.hidden, true, '理由框默认收起');

    // 第一次点：只展开理由框，不提交。
    reject.dispatch('click');
    assert.equal(reasonField.hidden, false, '第一次点展开理由框');
    assert.equal(calls.length, 0, '第一次点不提交');

    // 第二次点（理由还空着）：仍然不提交，并给出错误提示。
    reject.dispatch('click');
    assert.equal(calls.length, 0, '空理由不提交');
    const error = card.querySelector('.ag-reason-error');
    assert.ok(error, '要说清为什么没提交');
    assert.equal(error.hidden, false);

    // 填了理由才提交，且理由一起送上去（要进审批记录）。
    const input = card.querySelector('.ag-reason-field').querySelector('textarea') as StubNode;
    input.value = '时间不对';
    reject.dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1, '填了理由才提交');
    assert.equal(calls[0].decision, 'rejected');
    assert.deepEqual(calls[0].payload, { note: '', reason: '时间不对' });
  });
});

test('规矩二：理由可以很短（「1」「暂不」都行），只要能区分「我看过了」', async () => {
  await withDom(async () => {
    const { renderApprovalCard } = await import(cardsUrl);
    const calls: unknown[] = [];
    const card = renderApprovalCard({ id: 'a4', status: 'pending', risk: 'low' }, {
      onApproval: async (_c: unknown, _d: string, payload: unknown) => { calls.push(payload); },
    });
    const reject = card.querySelectorAll('[data-decision]').find((n) => n.dataset.decision === 'rejected');
    reject.dispatch('click');
    const input = card.querySelector('.ag-reason-field').querySelector('textarea') as StubNode;
    input.value = '1';
    reject.dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1, '「1」也是合法理由');
  });
});

test('规矩三：已决的审批卡变只读（批准是已经发生的事）', async () => {
  await withDom(async () => {
    const { renderApprovalCard } = await import(cardsUrl);
    const card = renderApprovalCard({ id: 'a5', status: 'approved', risk: 'high', decidedBy: 'user:1' });
    for (const button of card.querySelectorAll('[data-decision]')) {
      assert.equal(button.disabled, true, '决定后按钮禁用');
    }
    assert.equal(card.dataset.pending, undefined, '已决就不再标记 pending');
    const decision = card.querySelector('.ag-decision');
    assert.ok(decision);
    assert.equal(decision.hidden, false);
    assert.match(decision.textContent, /已批准/);
    // 已决不再染未决的橙底：还染着会让人以为还得再点一次。
    assert.doesNotMatch(card.className, /ag-approval-pending/);
    assert.match(card.className, /ag-approval-decided/);
  });
});

test('工具名不重复显示（label 缺省时等于 name，两处都分会打两遍）', async () => {
  await withDom(async () => {
    const { renderToolCard } = await import(cardsUrl);
    const plain = renderToolCard({ id: 'c9', name: 'robust_stats', status: 'ok' });
    assert.equal(plain.querySelector('.ag-tool-name').textContent, 'robust_stats');
    // label 与 name 同名时，label 那格留空。
    assert.equal(plain.querySelector('.ag-tool-label').textContent, '');

    // 不同名时才两处都显示（label 是人话名，name 是实际工具名）。
    const labeled = renderToolCard({ id: 'c10', name: 'robust_stats', label: '稳健统计', status: 'ok' });
    assert.equal(labeled.querySelector('.ag-tool-label').textContent, '稳健统计');
    assert.equal(labeled.querySelector('.ag-tool-name').textContent, 'robust_stats');
  });
});

/* ---------------------------------------------------------------------------------------------
 * 4. 规矩一：审批未决禁用输入框（读源码，因为它在 index.js 里）
 * ------------------------------------------------------------------------------------------- */

test('规矩一：审批未决时禁用输入框，并说明原因', () => {
  const source = readFileSync(join(agentDir, 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 契约 S5：「pending 期间同 call_id 无 tool.result」。审批没处理又发消息，
  // 会出现「两个操作并发」，事后没人能说清顺序。
  assert.match(source, /function syncApprovalGate/, '要有一个审批门');
  assert.match(source, /composer\.input\.disabled = blocked/, '未决时禁用输入框');
  assert.match(source, /data-card-type="approval"\]\[data-pending="true"/, '按未决审批卡判断');
  // 禁用必须说清原因 —— 灰掉但不说为什么，用户会以为界面坏了（附录 C.3 点三）。
  assert.match(source, /需要先处理上面的审批/, '禁用时要说明原因');
  assert.match(source, /ag-gate-note/, '原因以可见的一行显示');
});

test('工具卡与审批卡都不把用户数据当 HTML 插入', () => {
  const source = readFileSync(cardsPath, 'utf8');
  const toolStart = source.indexOf('export function renderToolCard');
  const approvalStart = source.indexOf('export function renderApprovalCard');
  const end = source.indexOf('export function renderArtifactCard');
  const region = source.slice(toolStart, end);
  assert.ok(toolStart > 0 && approvalStart > toolStart && end > approvalStart);
  // `el()` 支持 `html:`，但工具名、摘要、prompt、impact 这些来自数据的文本必须走 text:。
  assert.doesNotMatch(region, /html:\s*(card\.|part\.|summary)/, '数据不能进 innerHTML');
  assert.match(region, /text: card\.name/, '工具名走 textContent');
  assert.match(region, /text: card\.prompt/, '动作描述走 textContent');
});
