/**
 * 数据工作台（视-3 重做）的自测：四区、规则编号、不可判、空态 / 错误态、换批次联动。
 *
 *   node --test packages/app/test/data-workbench.test.ts
 *
 * ## 与 `data-view.test.ts` 的分工
 *
 * 那一份钉的是**纪律**（回源不折叠、四种空态互相区分、端点集中一处），守着不被改坏。
 * 这一份钉的是**这一版重做出来的东西**：
 *
 *   · 四区真的是四个落点，而且换批次**一个动作**刷新四块；
 *   · 质控每一类都带**规则编号**（R-4.2 / R-4.3 / R-4.4）与阈值线；
 *   · 评测里 `null` 显示「不可判」，不是绿也不是红；
 *   · 检索的答案 / 分区 / SQL / 行数同时可见；
 *   · 接口挂了、批次是空的、查询失败，三种错法各有各的话。
 *
 * 后半段用**假 DOM 真跑 mount()**：只读源码看不出「节点到底有没有画出来」，
 * 而「代码里写了、界面上没有」正是这一屏最容易出的错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const viewsDir = join(appDir, 'src', 'web', 'views');
const dataPath = join(viewsDir, 'data.js');
const dataUrl = pathToFileURL(dataPath).href;

function rawCode(): string {
  return readFileSync(dataPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ---------------------------------------------------------------------------------------------
 * 1. 四区结构
 * ------------------------------------------------------------------------------------------- */

test('四区齐，且各是一个独立落点（不是一块里堆四段）', () => {
  const source = rawCode();
  for (const pane of ['batch', 'quality', 'search', 'eval']) {
    assert.match(source, new RegExp(`data: \\{ pane: '${pane}' \\}`), `有 ${pane} 区落点`);
    assert.match(source, new RegExp(`vw-pane-${pane}`), `${pane} 区有自己的 class`);
  }
  // 四个 host 各一份：共用一个 host 的话，换批次会互相清掉。
  for (const host of ['batchHost', 'qcHost', 'searchHost', 'evalHost']) {
    assert.match(source, new RegExp(`const ${host} = el\\(`), `${host} 独立`);
  }
  // 批次在左上：它是这一屏所有数字的前提。
  const order = [...source.matchAll(/vw-pane-(batch|quality|search|eval)/g)].map((m) => m[1]);
  assert.deepEqual(order, ['batch', 'quality', 'search', 'eval'], '批次 → 质控 → 检索 → 评测');
});

test('换批次是一个动作、四区一起重画（不是各区各自监听）', () => {
  const source = rawCode();
  const body = /async function selectBatch[\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, '有 selectBatch');
  for (const painter of ['paintBatch()', 'paintQuality()', 'paintSearch()', 'paintEval()']) {
    assert.ok(body.includes(painter), `selectBatch 里要调 ${painter}`);
  }
  // 批次行与页头下拉都走同一个入口，否则两条路各刷一部分。
  assert.match(source, /selectBatch\(row\.dataset\.batchId\)/, '点批次行走 selectBatch');
  assert.match(source, /batchPicker\.addEventListener\('change'[\s\S]{0,80}?selectBatch\(batchPicker\.value\)/,
    '下拉也走 selectBatch');
});

test('批次表显示 id / 时间范围 / 行数 / 分区四样', () => {
  const source = rawCode();
  for (const label of ['批次', '时间范围', '行数', '分区']) {
    assert.match(source, new RegExp(`text: '${label}'`), `表头有 ${label}`);
  }
  // 行数、分区是数字：走 .num（等宽右对齐），否则一列数字对不齐。
  assert.match(source, /cls: 'num', text: formatNumber\(batch\.rows\)/, '行数右对齐');
  assert.match(source, /cls: 'num', text: formatNumber\(batch\.partitions\)/, '分区右对齐');
});

/* ---------------------------------------------------------------------------------------------
 * 2. 质控：规则编号与阈值线
 * ------------------------------------------------------------------------------------------- */

test('三类计数各挂一条规则编号（R-4.2 / R-4.3 / R-4.4）', async () => {
  const { QC_FIELDS } = await import(dataUrl);
  assert.equal(QC_FIELDS.length, 3, '正好三类');

  const keys = QC_FIELDS.map((field: { key: string }) => field.key);
  assert.deepEqual(keys, ['missing', 'jumps', 'outOfRange'], '键名与后端 counts 同名');

  const rules = QC_FIELDS.map((field: { rule_id: string }) => field.rule_id);
  assert.deepEqual(rules.slice().sort(), ['R-4.2', 'R-4.3', 'R-4.4'], '三条规则编号齐全');

  // 每条都要能落到手册小节上 —— 只有编号没有小节，用户查不到原文。
  for (const field of QC_FIELDS as Array<{ rule_id: string; section: string; rule: string }>) {
    assert.match(field.section, /^4\.[234]$/, `${field.rule_id} 有小节号`);
    assert.ok(field.rule.length > 0, `${field.rule_id} 有阈值描述`);
  }
});

test('规则编号与阈值都画在界面上（不是只在数据里）', () => {
  const source = rawCode();
  // 编号要落到一个可见的元素上。
  assert.match(source, /cls: 'vw-qc-rule', text: cell\.field\.rule_id/, '规则编号是可见元素');
  // 阈值线：不给它，用户没法判断「这个 3% 算不算不合格」。
  assert.match(source, /vw-qc-line/, '有阈值线');
  assert.match(source, /阈值 \$\{cell\.field\.rule\}/, '阈值文字带具体门限');
  // 手册位置进 title，能直接按 §4.3 去查原文。
  assert.match(source, /docs\/operations\/qc-rules\.md/, '指明手册路径');
});

test('三档结论：合格 / 超限 / 不可判，记号 + 文字 + 颜色三样都有', async () => {
  const { VERDICT_TEXT } = await import(dataUrl);
  assert.deepEqual(Object.keys(VERDICT_TEXT).sort(), ['fail', 'ok', 'unknown']);
  assert.equal(VERDICT_TEXT.ok.mark, '✓');
  assert.equal(VERDICT_TEXT.fail.mark, '✗');
  assert.equal(VERDICT_TEXT.unknown.mark, '?');
  // 不只靠颜色：三档的**文字**必须互不相同（色盲用户看不到色）。
  const labels = Object.values(VERDICT_TEXT).map((row: { label: string }) => row.label);
  assert.equal(new Set(labels).size, 3, `三档文字不能重复：${labels.join('/')}`);
  assert.ok(labels.includes('不可判'), '未知档要写「不可判」');
});

test('缺测率的判据是「严格大于 5%」（等于 5% 仍合格，与 verdict.py 一致）', async () => {
  const { qcVerdict, QC_FIELDS } = await import(dataUrl);
  const missing = QC_FIELDS.find((field: { key: string }) => field.key === 'missing');

  const atLimit = { rows: 1000, missing: 50, missingRate: 0.05, jumps: 0, outOfRange: 0, rules: [] };
  assert.equal(qcVerdict(missing, atLimit), 'ok', '恰好 5% 合格');

  const overLimit = { rows: 1000, missing: 51, missingRate: 0.051, jumps: 0, outOfRange: 0, rules: [] };
  assert.equal(qcVerdict(missing, overLimit), 'fail', '超过 5% 不合格');

  // 后端给了裁决就用它的（它带手册原文与阈值来源），不自己重算。
  const explicit = { rows: 1000, missing: 10, missingRate: 0.01, jumps: 0, outOfRange: 0,
    rules: [{ rule_id: 'R-4.3', verdict: 'fail', value: 0.081 }] };
  assert.equal(qcVerdict(missing, explicit), 'fail', '后端说 fail 就是 fail');
});

test('分母为 0 时比例是「—」，不是 0%（0/0 显示 0% 会被读成很好）', async () => {
  const { normalizeQuality } = await import(dataUrl);
  const parsed = normalizeQuality({ counts: { rows: 0, missing: 0, jumps: 0, outOfRange: 0 } });
  assert.equal(parsed.missingRate, null, '0/0 不给比例');

  const normal = normalizeQuality({ counts: { rows: 100, missing: 5, jumps: 1, outOfRange: 2 } });
  assert.equal(normal.missingRate, 0.05);
  assert.equal(normal.jumpsRate, 0.01);
  assert.equal(normal.outOfRangeRate, 0.02);
});

/* ---------------------------------------------------------------------------------------------
 * 3. 评测：null = 不可判
 * ------------------------------------------------------------------------------------------- */

test('null / 缺键 / 非布尔一律「不可判」，不画成绿也不画成红', async () => {
  const { evalStatus } = await import(dataUrl);
  assert.deepEqual(evalStatus(true), { mark: '✓', label: '通过', state: 'true' });
  assert.deepEqual(evalStatus(false), { mark: '✗', label: '未通过', state: 'false' });
  for (const value of [null, undefined, 'true', 1, 0, '']) {
    const status = evalStatus(value);
    assert.equal(status.label, '不可判', `${String(value)} 应当不可判`);
    assert.equal(status.state, 'unknown', `${String(value)} 的 state 是 unknown`);
    // 记号不是绿也不是红 —— 上面两条已经保证了 state，这一条钉住记号本身。
    assert.equal(status.mark, '?');
  }
});

test('评测区把「不可判」三个字画出来（只给问号分不清是待判还是漏画）', () => {
  const source = rawCode();
  assert.match(source, /vw-eval-word/, '有「不可判」那个词的元素');
  // 只在 unknown 时给词：通过 / 未通过那几格已经有 ✓ ✗，再加字会挤成一团。
  assert.match(source, /status\.state === 'unknown' \? el\('span', \{ cls: 'vw-eval-word'/, '只在 unknown 时给词');
  assert.match(source, /text: status\.label/, '词来自 evalStatus 的 label');
});

test('六个键 S1–S6 按顺序画成一列六格', () => {
  const source = rawCode();
  assert.match(source, /EVAL_KEYS = \['S1', 'S2', 'S3', 'S4', 'S5', 'S6'\]/);
  // 表头一行六格 + 每行六格：顺序由 EVAL_KEYS 决定，不另写一遍。
  assert.match(source, /EVAL_KEYS\.map\(\(key\) => el\('span'/, '表头按 EVAL_KEYS 生成');
  assert.match(source, /item\.checks\.map\(\(value, index\)/, '每行按 checks 生成');
  assert.match(source, /EVAL_KEYS\[index\]/, '格子知道自己是哪一条');
});

test('评测响应两种形状都认（契约 items 与上游 results）', async () => {
  const { normalizeEval } = await import(dataUrl);
  const items = normalizeEval({ items: [{ case_id: 'EV-01', s1: true, s2: false, s3: null, s4: true, s5: true, s6: null }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].caseId, 'EV-01');
  assert.deepEqual(items[0].checks, [true, false, null, true, true, null]);

  const results = normalizeEval({ results: { S1: true, S2: true, S3: null, S4: true, S5: false, S6: null } });
  assert.equal(results.length, 1, '单条也展开成一行');
  assert.deepEqual(results[0].checks, [true, true, null, true, false, null]);

  // 没有结果时返回 null（界面据此显示「还没跑评测」），不是编六个 true。
  assert.equal(normalizeEval({ results: null }), null);
  assert.equal(normalizeEval({}), null);
  assert.equal(normalizeEval(null), null);
});

/* ---------------------------------------------------------------------------------------------
 * 4. 检索：三样同时可见
 * ------------------------------------------------------------------------------------------- */

test('检索区有输入框，提交走一次查询', () => {
  const source = rawCode();
  assert.match(source, /vw-search-input/, '有输入框');
  assert.match(source, /type: 'search'/, '是搜索框');
  assert.match(source, /searchForm\.addEventListener\('submit'/, '提交有监听');
  assert.match(source, /runSearch\(queryInput\.value\)/, '提交取输入框的值');
});

test('「查询」按钮自己也能点（`button()` 是 type="button"，不提交表单）', () => {
  const source = rawCode();
  // 实测踩到：只绑 form 的 submit 时，输入框里按回车有反应、点按钮没反应 ——
  // 而「点了没反应」会被读成「查询坏了」。两条路必须都绑到同一个 runSearch。
  assert.match(source, /queryButton\.addEventListener\('click',[\s\S]{0,90}?runSearch\(queryInput\.value\)/,
    '按钮自己绑了 click');
  // 不能借机再写一遍逻辑（两处实现迟早会分叉）。
  const calls = [...source.matchAll(/runSearch\(/g)].length;
  assert.ok(calls <= 5, `runSearch 的调用点不该遍地开花，实际 ${calls} 处`);
});

test('答案 / 分区 / SQL / 行数四样都在同一个回源块里，不折叠', () => {
  const source = rawCode();
  const provenance = /vw-provenance[\s\S]{0,1600}?vw-sql-wrap/.exec(source)?.[0] ?? '';
  assert.ok(provenance, '回源块里含 SQL 容器');
  for (const label of ['分区', '行数', '引擎']) {
    assert.ok(provenance.includes(`['${label}'`), `回源块里有 ${label}`);
  }
  // 行数要带 data-row-count，测试与用户都能直接读到它。
  assert.match(source, /data: \{ rowCount:/, '行数带标记');
  // 分区路径**全部**列出来，不只第一个。
  assert.match(source, /vw-part-paths/, '有分区路径清单');
  assert.match(source, /answer\.paths\.map\(/, '全部路径都画');
  // 不折叠。
  assert.doesNotMatch(source, /<details|createElement\('details'\)/, '不能折叠');
});

test('检索响应归一：契约字段与上游字段都认，答案是 0 时显示 0', async () => {
  const { normalizeSearch } = await import(dataUrl);
  const contract = normalizeSearch({
    answer: '3.2%', sql: 'SELECT 1', row_count: 31,
    partition_paths: ['obs/station=WUHN/date=2026-10-01/'],
  });
  assert.equal(contract.rowCount, 31);
  assert.deepEqual(contract.paths, ['obs/station=WUHN/date=2026-10-01/']);
  // 契约不带 question 时也要认「真查过」：有 SQL / 行数就够了，不能当成「还没提问」。
  assert.equal(contract.asked, true, '有 SQL 与行数就算查过');

  const upstream = normalizeSearch({
    question: '缺测率', value: 0, sql: 'SELECT 2', rows: 7, partition: 'obs/x/',
  });
  assert.equal(upstream.answer, 0, '答案是 0 时不能塌成空');
  assert.deepEqual(upstream.paths, ['obs/x/'], '单个 partition 也归一成数组');

  // 空问题 + 空回源：asked 为 false，界面画「还没有提问」而不是画一个空答案。
  const blank = normalizeSearch({ question: '', value: null, sql: '', row_count: null });
  assert.equal(blank.asked, false);
});

/* ---------------------------------------------------------------------------------------------
 * 5. 空态 / 错误态
 * ------------------------------------------------------------------------------------------- */

test('接口挂了：说「拿不到」并给重试（不是一段只读的说明）', () => {
  const source = rawCode();
  const branch = /if \(dataState\.unavailable\) \{[\s\S]{0,900}?return;/.exec(source)?.[0] ?? '';
  assert.ok(branch, '有 unavailable 分支');
  assert.match(branch, /还拿不到数据/, '说清是拿不到');
  assert.match(branch, /retry-batches/, '给重试动作');
  assert.match(branch, /不是「没有批次」，是「还没接上」/, '把区别写进文案');
});

test('空批次不给「导入」按钮（数据在，只是这批没有行）', () => {
  const source = rawCode();
  const branch = /emptyBatch\.title[\s\S]{0,240}/.exec(source)?.[0] ?? '';
  assert.doesNotMatch(branch, /导入/, '不给导入，避免误导');
});

test('评测没跑：说清「还没跑」并带上后端给的原因', () => {
  const source = rawCode();
  const branch = /if \(!current\.evalItems[\s\S]{0,600}?return;/.exec(source)?.[0] ?? '';
  assert.ok(branch, '有「没有评测结果」分支');
  assert.match(branch, /还没有评测结果/, '说清是没跑');
  assert.match(branch, /current\.evalNote/, '把后端的原因带出来');
  // 不能借机编六个 ✓。
  assert.doesNotMatch(branch, /'✓'/, '没结果时不能画 ✓');
});

test('查询失败：错误里带三要素（发生了什么 / 错误码 / 该做什么）', () => {
  const source = rawCode();
  const branch = /current\.searchError[\s\S]{0,600}?return;/.exec(source)?.[0] ?? '';
  assert.ok(branch, '有查询失败分支');
  assert.match(branch, /retry-search/, '给重试');
  assert.match(source, /slot\.error\.code/, '把错误码带出来');
  assert.match(source, /slot\.error\.hint/, '把「该做什么」带出来');
});

/* ---------------------------------------------------------------------------------------------
 * 6. 真跑一遍 mount()（假 DOM）
 * ------------------------------------------------------------------------------------------- */

interface StubNode {
  tagName: string;
  className: string;
  title: string;
  textContent: string;
  disabled: boolean;
  value: string;
  children: StubNode[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  append(child: StubNode | { nodeType: 3; textContent: string }): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  dispatch(type: string, event?: unknown): void;
  replaceChildren(...nodes: StubNode[]): void;
  closest(selector: string): StubNode | null;
}

/**
 * 假节点。
 *
 * **必须真的 `instanceof Node`**：`dom.js` 的 `kv()` 用 `value instanceof Node`
 * 判断「这个值是节点还是要当成文本」，`table()` 同理。桩节点不是 `Node` 的实例时，
 * 那些格子会被静默降级成文本节点 —— 于是「行数带 data-row-count」这类断言假红，
 * 而界面上看起来一切正常。这与 chat-mount.test.ts 里那条注释是同一个坑。
 */
class StubNodeBase {
  tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }
}

function makeNode(tagName: string): StubNode {
  const own = { text: '' };
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const children: StubNode[] = [];

  const matches = (candidate: StubNode, selector: string): boolean => {
    if (selector.startsWith('[data-') && selector.endsWith(']')) {
      const name = selector.slice(6, -1).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
      return candidate.dataset[name] !== undefined;
    }
    if (selector.startsWith('.')) return candidate.className.split(/\s+/).includes(selector.slice(1));
    return candidate.tagName === selector.toUpperCase();
  };

  const node = Object.assign(Object.create(StubNodeBase.prototype), {
    tagName: tagName.toUpperCase(),
    className: '',
    title: '',
    disabled: false,
    value: '',
    children,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,

    append(child: StubNode | { nodeType: 3; textContent: string }) {
      if ((child as { nodeType?: number }).nodeType === 3) {
        own.text += (child as { textContent: string }).textContent;
        return;
      }
      (child as { parentNode?: unknown }).parentNode = node;
      children.push(child as StubNode);
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = String(value);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
      if (name === 'disabled') this.disabled = true;
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    addEventListener(type: string, fn: (event: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    dispatch(type: string, event?: unknown) {
      const payload = event ?? { type, preventDefault() {}, stopPropagation() {} };
      for (const fn of listeners[type] ?? []) fn(payload);
    },
    replaceChildren(...nodes: StubNode[]) {
      children.length = 0;
      own.text = '';
      for (const item of nodes) if (item) node.append(item);
    },
    closest(selector: string) {
      return matches(node as unknown as StubNode, selector) ? node : null;
    },
  }) as unknown as StubNode;

  Object.defineProperty(node, 'textContent', {
    get() { return own.text + children.map((child) => child.textContent).join(''); },
    set(value: string) {
      own.text = String(value ?? '');
      children.length = 0;
    },
    enumerable: true,
    configurable: true,
  });

  return node;
}

/** 深度遍历，按 class 找节点（桩里没有 CSS 选择器引擎，够用就好）。 */
function findAll(node: StubNode, predicate: (candidate: StubNode) => boolean): StubNode[] {
  const out: StubNode[] = [];
  const walk = (current: StubNode): void => {
    for (const child of current.children) {
      if (predicate(child)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function byClass(node: StubNode, cls: string): StubNode[] {
  return findAll(node, (candidate) => candidate.className.split(/\s+/).includes(cls));
}

/** 一次 mount：假 DOM + 假 fetch + 假 store（只实现 data.js 用到的接口）。 */
async function mountData(routes: Record<string, unknown>): Promise<{
  main: StubNode;
  rail: StubNode;
  requested: string[];
  flush(): Promise<void>;
}> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, Node: globals.Node, fetch: globals.fetch };
  globals.document = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (value: string) => ({ nodeType: 3, textContent: String(value) }),
  };
  globals.Node = StubNodeBase;

  const requested: string[] = [];
  globals.fetch = async (url: string) => {
    const key = String(url);
    requested.push(key);
    const body = routes[key];
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  const { mount } = await import(dataUrl);
  const { createStore } = await import(pathToFileURL(join(viewsDir, 'state.js')).href);
  const state = createStore();

  const main = makeNode('main');
  const head = makeNode('header');
  const rail = makeNode('aside');

  const cleanup = mount({
    main,
    head,
    state,
    rail,
    renderRail: (draw: (host: StubNode) => void) => draw(rail),
    repaintRail: () => {
      rail.replaceChildren();
      // 与 shell.js 同口径：重画就是清空再调渲染函数。
      // 这里没有保存渲染函数，所以只清空；断言只用得着「清空过」这件事。
    },
    go: () => {},
  });

  // 两轮微任务：ensure 是 async，fetchBatches 里还要 await selectBatch。
  const flush = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  await flush();

  (globalThis as { __cleanup?: () => void }).__cleanup = cleanup;
  // 只在最后一个用例里恢复全局 —— 这里恢复的话后面的用例拿不到 document。
  void saved;
  return { main, rail, requested, flush };
}

const BATCHES_OK = {
  batches: [
    { batch: 'WUHN/2026-10-31', first: '2026-10-31', last: '2026-10-31', rows: 86400, partitions: 1 },
    { batch: 'WUHN/2026-10-01', first: '2026-10-01', last: '2026-10-30', rows: 2462400, partitions: 31 },
  ],
};

/**
 * 一个「后端正常」的路由表：批次 + 两个批次的质控 / 检索 / 评测。
 *
 * 刻意让两个批次的数字**不一样** —— 一样的话，「换批次有没有真的重取」这件事
 * 测不出来（半新半旧的屏正好会显示成正确值）。
 */
function okRoutes(): Record<string, unknown> {
  return {
    '/api/data/batches': BATCHES_OK,
    '/api/data/quality?batch=WUHN%2F2026-10-31': {
      missing_rate: 0.032,
      slip_count: 12,
      out_of_range: 3,
      rows: 86400,
      rules: [
        { rule_id: 'R-4.2', verdict: 'ok', value: 42.1 },
        { rule_id: 'R-4.3', verdict: 'fail', value: 0.081 },
        { rule_id: 'R-4.4', verdict: 'ok', value: 0.12 },
      ],
    },
    '/api/data/quality?batch=WUHN%2F2026-10-01': {
      missing_rate: 0.004,
      slip_count: 0,
      out_of_range: 0,
      rows: 2462400,
      rules: [
        { rule_id: 'R-4.2', verdict: 'ok', value: 45 },
        { rule_id: 'R-4.3', verdict: 'ok', value: 0.004 },
        { rule_id: 'R-4.4', verdict: 'ok', value: 0.1 },
      ],
    },
    '/api/data/search?batch=WUHN%2F2026-10-31&q=': {
      question: '', answer: null, sql: '', row_count: null, partition_paths: [],
    },
    '/api/data/search?batch=WUHN%2F2026-10-01&q=': {
      question: '', answer: null, sql: '', row_count: null, partition_paths: [],
    },
    '/api/data/eval?batch=WUHN%2F2026-10-31': { items: [] },
    '/api/data/eval?batch=WUHN%2F2026-10-01': { items: [] },
  };
}

test('mount 后批次表真的画出来（两个批次 + 四列表头）', async () => {
  const view = await mountData(okRoutes());
  const rows = byClass(view.main, 'vw-batch-row-item');
  assert.equal(rows.length, 2, `两个批次行，实际 ${rows.length}`);
  const head = byClass(view.main, 'vw-batch-row-head')[0];
  assert.ok(head, '有表头行');
  for (const label of ['批次', '时间范围', '行数', '分区']) {
    assert.match(head.textContent, new RegExp(label), `表头有 ${label}`);
  }
  // 第一行是自动选中的那一个：否则四区都停在「选中一个批次后……」。
  assert.match(rows[0].className, /vw-batch-row-current/, '默认选中第一个');
});

test('mount 后质控三类各自带规则编号与阈值（画在节点上，不只是数据里）', async () => {
  const view = await mountData(okRoutes());
  const cells = byClass(view.main, 'vw-qc-cell');
  assert.equal(cells.length, 3, `三个质控格，实际 ${cells.length}`);

  const ruleTexts = byClass(view.main, 'vw-qc-rule').map((node) => node.textContent);
  assert.deepEqual(ruleTexts.slice().sort(), ['R-4.2', 'R-4.3', 'R-4.4'], '三类各带一条规则编号');

  const lines = byClass(view.main, 'vw-qc-line').map((node) => node.textContent);
  assert.equal(lines.length, 3, '三条阈值线');
  for (const line of lines) assert.match(line, /^阈值 /, `阈值线形如「阈值 …」，实际：${line}`);

  // R-4.3 后端判了 fail，界面那一格必须显示「超限」而不是「合格」。
  const missingCell = cells.find((cell) => cell.dataset.qc === 'missing');
  assert.ok(missingCell, '有缺测那一格');
  assert.equal(missingCell.dataset.verdict, 'fail', '后端说 fail 就是 fail');
  assert.match(missingCell.textContent, /超限/, '失败格写「超限」');
});

test('mount 后换批次：质控数字跟着换（不是半新半旧）', async () => {
  const view = await mountData(okRoutes());
  const before = byClass(view.main, 'vw-qc-value').map((node) => node.textContent);
  assert.ok(before.length === 3, '先有三格');

  // 点第二行（WUHN/2026-10-01，缺测率 0.4% 而不是 3.2%）。
  // 桩不冒泡，所以直接把事件派给监听者（批次区 host），target 指到第二行。
  const rows = byClass(view.main, 'vw-batch-row-item');
  const host = findAll(view.main, (node) => node.dataset.batchBody !== undefined)[0];
  assert.ok(host, '有批次区 host');
  host.dispatch('click', { target: rows[1], preventDefault() {}, stopPropagation() {} });
  await view.flush();

  const after = byClass(view.main, 'vw-qc-value').map((node) => node.textContent);
  assert.notDeepEqual(after, before, '换批次后质控数字必须变');

  const missingCell = byClass(view.main, 'vw-qc-cell').find((cell) => cell.dataset.qc === 'missing');
  assert.ok(missingCell);
  assert.equal(missingCell.dataset.verdict, 'ok', '第二批的缺测率合格');

  // 当前行也跟着换（两个手段：竖条与背景，这里钉住 class）。
  const updated = byClass(view.main, 'vw-batch-row-item');
  assert.match(updated[1].className, /vw-batch-row-current/, '选中的是第二行');
  assert.doesNotMatch(updated[0].className, /vw-batch-row-current/, '第一行不再选中');
});

test('mount 后评测的 null 显示「不可判」而不是 ✓ / ✗', async () => {
  const routes = okRoutes();
  routes['/api/data/eval?batch=WUHN%2F2026-10-31'] = {
    items: [{ case_id: 'EV-01', s1: true, s2: true, s3: null, s4: true, s5: false, s6: null }],
  };
  const view = await mountData(routes);
  const cells = byClass(view.main, 'vw-eval-cell');
  assert.equal(cells.length, 6, `六个格子，实际 ${cells.length}`);

  const unknown = cells.filter((cell) => cell.dataset.state === 'unknown');
  assert.equal(unknown.length, 2, 's3 / s6 两格不可判');
  for (const cell of unknown) {
    assert.match(cell.textContent, /不可判/, '不可判那格要写字');
    assert.doesNotMatch(cell.textContent, /[✓✗]/, '不可判那格不能出现 ✓ 或 ✗');
  }
  // 读数屏：aria-label 也要念出「不可判」，不能只念一个问号。
  assert.match(unknown[0].attrs['aria-label'] ?? '', /不可判/);
  // 通过的那几格仍然有 ✓。
  assert.equal(cells.filter((cell) => cell.dataset.state === 'true').length, 3);
  assert.equal(cells.filter((cell) => cell.dataset.state === 'false').length, 1);
});

test('mount 后检索的回源三样同时在 DOM 里（分区 / SQL / 行数）', async () => {
  const routes = okRoutes();
  routes[`/api/data/search?batch=WUHN%2F2026-10-31&q=${encodeURIComponent('缺测率')}`] = {
    question: '缺测率',
    answer: '3.2%',
    sql: "SELECT count(*) FROM obs WHERE cn0 IS NULL AND station = 'WUHN'",
    row_count: 31,
    partition_paths: [
      'obs/station=WUHN/date=2026-10-01/',
      'obs/station=WUHN/date=2026-10-02/',
    ],
  };
  const view = await mountData(routes);

  // 提交一次查询。
  const form = byClass(view.main, 'vw-search-form')[0];
  assert.ok(form, '有查询表单');
  const input = byClass(view.main, 'vw-search-input')[0];
  assert.ok(input, '有输入框');
  input.value = '缺测率';
  form.dispatch('submit');
  await view.flush();

  const provenance = byClass(view.main, 'vw-provenance')[0];
  assert.ok(provenance, '回源块画出来了');
  // 三样同时可见：分区路径、SQL、行数。
  assert.equal(byClass(view.main, 'vw-part-path').length, 2, '两条分区路径都在');
  assert.match(view.main.textContent, /obs\/station=WUHN\/date=2026-10-01\//, '分区路径可见');
  const sql = byClass(view.main, 'vw-sql')[0];
  assert.ok(sql, 'SQL 容器在');
  assert.match(sql.textContent, /SELECT/, 'SQL 内容在');
  assert.match(sql.textContent, /\nFROM /, 'SQL 已格式化（FROM 另起一行）');
  // 行数：带标记 + 千分位。
  const rowCount = findAll(view.main, (node) => node.dataset.rowCount !== undefined)[0];
  assert.ok(rowCount, '行数带 data-row-count');
  assert.equal(rowCount.dataset.rowCount, '31');
  assert.equal(rowCount.textContent, '31');
  // 答案本身。
  assert.match(view.main.textContent, /3\.2%/, '答案可见');
});

test('mount 后接口全挂：四区都说「拿不到」并给重试，不说「没有数据」', async () => {
  const view = await mountData({});
  const text = view.main.textContent;
  assert.match(text, /拿不到数据/, '说清是拿不到');
  assert.match(text, /重试/, '给重试');
  assert.doesNotMatch(text, /没有数据/, '不能笼统说「没有数据」');
  // 四块各有一句 —— 只在一块说，另三块会变成空白。
  assert.ok(byClass(view.main, 'vw-pane').length === 4, '四区都在');
  assert.ok(byClass(view.main, 'vw-btn').length >= 1, '有能点的按钮');
});

test('装完假 DOM 之后 data.js 的导出仍然可用（模块没被测试污染）', async () => {
  const { DATA_ENDPOINTS, EMPTY_STATES } = await import(dataUrl);
  assert.equal(DATA_ENDPOINTS.batches, '/api/data/batches');
  assert.equal(Object.keys(EMPTY_STATES).length, 4);
});
