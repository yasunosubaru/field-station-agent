/**
 * 数据视角 —— 视-3。
 *
 * ## 改前是什么
 *
 * `/data` 的 iframe 指向 `/config/events`，那是**事件列表**。数据视角在那之前不存在。
 *
 * ## 改后是什么（第 25.11 节 / 附录 C.5）
 *
 * 四区，从上到下：
 *
 * ```
 * 批次   批次号 / 台站 / 时段 / 行数 / 分区数
 * 质控   缺测率 / 跳变 / 越界 三类计数（绝对数 + 比例）
 * 检索   答案 + 分区 + SQL + 行数   ← 三样必须同时可见，不折叠
 * 评测   每条 S1–S6 绿否
 * ```
 *
 * ## 三条不能妥协的
 *
 * 1. **批次选择在最上面**且换它就四区全变 —— 它是这一屏所有数字的前提（验收项）。
 * 2. **检索区的分区 / SQL / 行数 / 引擎同时可见，不折叠** ——
 *    折起来用户不会点开，而「看了一眼但没看来源」等于没看（25.11.2）。
 * 3. **四种空态互相区分** —— 都显示「无数据」会让用户不知道下一步做什么（25.11.4）。
 *
 * ## 数据从哪来
 *
 * `data/parquet.py` / `query.py` / `engines.py` 都在，但**当前没有 HTTP 出口**
 * （`server.ts` 里搜 parquet / batch 全空）。所以和视-2 同样的处理：
 *
 *   · `DATA_ENDPOINTS` 集中一份路径；
 *   · 接口不到位时 `unavailable`，四区照常画，每区说清是哪一种「没有」。
 *
 * 接口到位后只改端点与映射，界面一行不用动。
 */

import { el, empty, section, kv, button, headActions, num } from './dom.js';
import { ensure, formatNumber, formatPercent, formatBytes } from './state.js';

/**
 * 四种空态（25.11.4）。
 *
 * 导出成常量：测试逐条断言它们**互不相同**。都写「无数据」是最省事的做法，
 * 也是这一节专门点名要避免的 —— 因为那句话让用户不知道下一步该做什么。
 */
export const EMPTY_STATES = {
  /** 一个批次都没有：下一步很明确，给「导入」。 */
  noBatch: { title: '还没有导入数据。', note: '先把一份抓包导入成 Parquet 批次，四个区才有东西可显示。' },
  /** 有批次但选中的是空批次：**不给导入按钮**，数据在，只是这批没有行 —— 给导入会误导。 */
  emptyBatch: { title: '这个批次没有数据。', note: '换一个批次，或检查这次抓包是不是只含头部。' },
  /** 字段不在本批次里：说清是**哪个**字段，而不是笼统的无数据。 */
  missingField: { title: '这个字段不在本批次里。', note: '换一个字段，或确认这份数据的日志类型。' },
  /** 引擎不可用：这是**降级**，不是没数据 —— 数据还在盘上，必须说出来（附录 C.9 第 5 条）。 */
  engineDown: { title: '查询引擎不可用，已降级。', note: '数据还在磁盘上；恢复引擎后再查，结果口径会一致。' },
};

/** 评测的六条（S1–S6）。用 ✓ ✗ 不用颜色 —— 颜色在色盲用户那里失效（附录 C.5 点五）。 */
export const EVAL_KEYS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

/** 数据侧端点，集中一处。 */
export const DATA_ENDPOINTS = {
  batches: '/api/data/batches',
  quality: (batch) => `/api/data/quality?batch=${encodeURIComponent(batch)}`,
  search: (batch, q) => `/api/data/search?batch=${encodeURIComponent(batch)}&q=${encodeURIComponent(q)}`,
  eval: (batch) => `/api/data/eval?batch=${encodeURIComponent(batch)}`,
};

/**
 * 把一条 SQL 排成多行。
 *
 * 规格 25.11.3：不要一行到底。理由不是美观 —— 是「用户要能看懂它在查什么」，
 * 而一行 200 字符的 SQL 谁也看不懂。
 *
 * 只做**主句换行 + 缩进**，不做完整格式化：真正的格式化要解析 SQL，
 * 那是后端的活。这里的目标是「能读」，不是「好看」。
 */
export function formatSql(sql) {
  const text = String(sql || '').trim();
  if (!text) return '';
  return text
    // 主句之前换行。
    .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|UNION|JOIN|LEFT JOIN|INNER JOIN)\s+/gi,
      (_match, keyword) => `\n${keyword.toUpperCase()} `)
    // 逻辑连接词换行并缩进。
    .replace(/\s+(AND|OR)\s+/gi, (_match, keyword) => `\n  ${keyword.toUpperCase()} `)
    // `FILTER (WHERE ...)` 这类括起来的条件：括号内不换行，但要保证括号前有空格
    // —— 少了它就成了 `FILTER(WHERE`，读起来像函数名而不是带条件的聚合。
    .replace(/\s*\(\s*WHERE\s+/gi, ' (WHERE ')
    .replace(/\s*\)\s*\*\s*/g, ')\n  * ')
    .trim();
}

export function mount(ctx) {
  const { main, head, state } = ctx;

  /** 当前批次列表与「接口是否可用」。 */
  let dataState = { unavailable: false, batches: [] };
  /** 当前选中批次的四区数据。 */
  let current = null;

  /* —— 页头：视角名 + 批次选择 + 操作（附录 C.7「数据 → 批次选择」） —— */
  const batchPicker = el('select', {
    cls: 'vw-batch-picker',
    attr: { 'aria-label': '批次' },
    data: { batchPicker: '' },
  });
  const batchMeta = el('span', { cls: 'vw-sec-meta', data: { batchMeta: '' }, text: '—' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '数据' }),
    el('div', { cls: 'vw-view-context', children: [batchPicker, batchMeta] }),
    headActions([
      button('导入', { variant: 'quiet', data: { action: 'import' } }),
      button('刷新', { variant: 'quiet', data: { action: 'refresh' } }),
    ]),
  );

  function paintPicker() {
    batchPicker.replaceChildren();
    if (dataState.unavailable || !dataState.batches.length) {
      batchPicker.append(new Option(dataState.unavailable ? '拿不到批次' : '还没有批次', ''));
      batchPicker.disabled = dataState.unavailable || !dataState.batches.length;
      batchMeta.textContent = dataState.unavailable ? '接口未接' : '共 0 分区';
      return;
    }
    batchPicker.disabled = false;
    for (const batch of dataState.batches) {
      const label = `${batch.station || '—'} ${batch.date || ''}`.trim();
      batchPicker.append(new Option(label, batch.id || `${batch.station}/${batch.date}`));
    }
    batchPicker.value = state.get().selectedBatchId || batchPicker.options[0]?.value || '';
    const selected = dataState.batches.find((b) => (b.id || `${b.station}/${b.date}`) === batchPicker.value);
    const parts = selected?.partitions;
    batchMeta.textContent = parts == null ? '共 — 分区' : `共 ${formatNumber(parts)} 分区`;
  }

  /* —— ① 批次区 —— */
  const batchHost = el('div', { cls: 'vw-data-batch', data: { batchBody: '' } });

  function paintBatch() {
    // 接口拿不到 / 一个批次都没有：第一种空态，带「导入」（下一步很明确）。
    if (dataState.unavailable) {
      // 这条空态**必须给一个能点的动作**。只写「等接口」的话，用户在这里
      // 除了读一段说明什么都做不了 —— 而他真正能做的往往是「重试一次」
      // （后端刚起来、代理刚通、端口刚换，都发生过）。
      batchHost.replaceChildren(empty(
        '批次还拿不到数据。',
        '数据视角要读 Parquet 批次，查询层已经实现，但还没有 HTTP 出口。'
          + '这一块不是「没有批次」，是「还没接上」。',
        button('重试', { variant: 'primary', data: { action: 'retry-batches' } }),
      ));
      return;
    }
    if (!current) {
      batchHost.replaceChildren(empty(
        EMPTY_STATES.noBatch.title,
        EMPTY_STATES.noBatch.note,
        button('导入抓包', { variant: 'primary', data: { action: 'import' } }),
      ));
      return;
    }

    const batch = current.batch || {};
    const size = formatBytes(batch.bytes);
    batchHost.replaceChildren(kv([
      ['批次', batch.id || state.get().selectedBatchId || '—'],
      ['台站', batch.station || '—'],
      ['时段', batch.period || batch.date || '—'],
      ['行数', num(formatNumber(batch.rows))],
      ['分区', num(formatNumber(batch.partitions))],
      ['字节', el('span', { children: [num(size.value), el('span', { cls: 'unit', text: size.unit })] })],
    ]));
  }

  /* —— ② 质控区：三列，每列「绝对数 + 比例」 —— */
  const qcHost = el('div', { cls: 'vw-data-qc', data: { qcBody: '' } });

  /** 三类计数的显示名。顺序即界面顺序。 */
  const QC_FIELDS = [
    { key: 'missing', label: '缺测' },
    { key: 'jumps', label: '跳变' },
    { key: 'outOfRange', label: '越界' },
  ];

  function paintQuality() {
    if (dataState.unavailable) {
      qcHost.replaceChildren(empty('质控还拿不到数据。', '同上：等查询层的 HTTP 出口。'));
      return;
    }
    if (!current) {
      // 有批次但还没选：这是第五种情况（「未选择」），不是「无数据」。
      qcHost.replaceChildren(empty('选中一个批次后显示质控。', '三个计数：缺测 / 跳变 / 越界。'));
      return;
    }
    if (current.qualityUnavailable) {
      // 引擎不可用是**降级**，不是没数据 —— 必须明确说出来。
      qcHost.replaceChildren(empty(EMPTY_STATES.engineDown.title, EMPTY_STATES.engineDown.note));
      return;
    }
    const quality = current.quality || {};
    if (quality.rows === 0) {
      qcHost.replaceChildren(empty(EMPTY_STATES.emptyBatch.title, EMPTY_STATES.emptyBatch.note));
      return;
    }

    qcHost.replaceChildren(el('div', { cls: 'vw-qc-grid' }, QC_FIELDS.map((field) => {
      const absolute = quality[field.key];
      const ratio = quality[`${field.key}Rate`];
      return el('div', { cls: 'vw-qc-cell', data: { qc: field.key }, children: [
        el('span', { cls: 'vw-qc-label', text: field.label }),
        // 绝对数说明「有多少」，比例说明「严重不严重」—— 两个都要（附录 C.5 点二）。
        el('span', { cls: 'vw-qc-value', text: formatNumber(absolute) }),
        el('span', { cls: 'vw-qc-ratio', text: formatPercent(ratio) }),
      ] });
    })));
  }

  /* —— ③ 检索区：答案 + 回源，四样同在一屏 —— */
  const searchHost = el('div', { cls: 'vw-data-search', data: { searchBody: '' } });

  function paintSearch() {
    if (dataState.unavailable) {
      searchHost.replaceChildren(empty('检索还拿不到数据。', '同上：等查询层的 HTTP 出口。'));
      return;
    }
    if (!current) {
      searchHost.replaceChildren(empty('选中一个批次后可以检索。', '答案会连同分区、SQL、行数一起给出 —— 三样必须同时可见。'));
      return;
    }
    const answer = current.search;
    if (!answer) {
      searchHost.replaceChildren(empty('还没有提问。', '问一句「WUHN 昨天缺测率多少」，答案与回源会一起出现在这里。'));
      return;
    }
    if (answer.missingField) {
      // 第三种空态：字段不存在，说清是哪个字段。
      searchHost.replaceChildren(empty(EMPTY_STATES.missingField.title, EMPTY_STATES.missingField.note));
      return;
    }

    const sql = formatSql(answer.sql);
    searchHost.replaceChildren(el('div', { cls: 'vw-search', children: [
      el('p', { cls: 'vw-search-q', children: [
        el('span', { cls: 'unit', text: '问' }),
        el('span', { text: answer.question || '—' }),
      ] }),
      el('p', { cls: 'vw-search-a', children: [
        el('span', { cls: 'unit', text: '答' }),
        el('span', { cls: 'num vw-search-answer', text: answer.value ?? '—' }),
      ] }),
      // 回源块：**不折叠**。这是本区唯一的设计硬要求。
      el('div', { cls: 'vw-provenance', data: { provenance: '' }, children: [
        el('div', { cls: 'vw-provenance-head', text: '回源' }),
        kv([
          ['分区', el('code', { cls: 'vw-path', text: answer.partition || '—' })],
          ['行数', num(formatNumber(answer.rows))],
          ['引擎', el('span', { children: [
            el('span', { text: answer.engine || '—' }),
            answer.elapsedMs == null ? null : el('span', { cls: 'unit', text: `· ${answer.elapsedMs} ms` }),
          ] })],
        ]),
        el('div', { cls: 'vw-sql-wrap', children: [
          el('pre', { cls: 'vw-sql', data: { sql: '' }, text: sql || '（本次查询没有 SQL）' }),
        ] }),
      ] }),
    ] }));
  }

  /* —— ④ 评测区：S1–S6，用 ✓ ✗ 不用颜色 —— */
  const evalHost = el('div', { cls: 'vw-data-eval', data: { evalBody: '' } });

  function paintEval() {
    if (dataState.unavailable) {
      evalHost.replaceChildren(el('p', { cls: 'vw-rail-empty', text: '评测还拿不到数据。' }));
      return;
    }
    if (!current) {
      evalHost.replaceChildren(el('p', { cls: 'vw-rail-empty', text: '选中一个批次后显示评测结果。' }));
      return;
    }
    const results = current.eval || null;
    if (!results) {
      evalHost.replaceChildren(el('p', {
        cls: 'vw-rail-empty',
        text: '这个批次还没跑评测。跑完后每条 S1–S6 各给一个 ✓ 或 ✗。',
      }));
      return;
    }
    evalHost.replaceChildren(...EVAL_KEYS.map((key) => {
      const passed = results[key];
      const known = passed === true || passed === false;
      return el('span', { cls: 'vw-eval-item', data: { evalKey: key }, children: [
        el('span', { text: key }),
        // 只靠符号，不靠颜色（色盲用户）。未知用 `?` 而不是装作失败。
        el('span', {
          cls: 'vw-eval-mark',
          data: { ok: known ? String(passed) : 'unknown' },
          text: known ? (passed ? '✓' : '✗') : '?',
          attr: { 'aria-label': known ? (passed ? '通过' : '未通过') : '未跑' },
        }),
      ] });
    }));
  }

  main.append(el('div', { cls: 'vw-data', children: [
    section('批次', null, [batchHost]),
    section('质控', '缺测 / 跳变 / 越界', [qcHost]),
    section('检索', '答案与回源同时可见', [searchHost]),
    section('评测', 'S1–S6', [evalHost]),
  ] }));

  /* —— 右栏：选中批次的统计（25.6.1「数据 → 选中批次的统计」） —— */
  ctx.renderRail((rail) => {
    const selected = state.get().selectedBatchId;
    const batch = current?.batch;
    const size = formatBytes(batch?.bytes);

    rail.replaceChildren(
      section('批次详情', selected ? '已选' : '未选', [
        selected
          ? kv([['批次', selected]])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中的批次。' }),
        kv([
          ['行数', num(formatNumber(batch?.rows))],
          ['分区', num(formatNumber(batch?.partitions))],
          ['字节', el('span', { children: [num(size.value), el('span', { cls: 'unit', text: size.unit })] })],
        ]),
      ]),
      section('数据质量', null, [
        current?.quality
          ? kv(QC_FIELDS.map((field) => [
            field.label,
            el('span', { children: [
              num(formatNumber(current.quality[field.key])),
              el('span', { cls: 'unit', text: formatPercent(current.quality[`${field.key}Rate`]) }),
            ] }),
          ]))
          : el('p', { cls: 'vw-rail-empty', text: '质控结果出来后，这里给三类计数。' }),
        // 降级必须显示，不能藏（附录 C.9 第 5 条：藏起来让界面好看等于骗用户）。
        current?.qualityUnavailable
          ? el('p', { cls: 'vw-warn', text: EMPTY_STATES.engineDown.title })
          : null,
      ]),
    );
  });

  /* —— 取数 —— */

  async function fetchBatches(force = false) {
    const payload = await ensure(state, 'forest', DATA_ENDPOINTS.batches, (raw) => raw, '批次列表', { force });
    const slot = state.get().cache.forest;
    if (payload === null && slot.state === 'error') {
      dataState = { unavailable: true, batches: [] };
    } else {
      dataState = {
        unavailable: false,
        batches: Array.isArray(payload) ? payload : (payload?.batches ?? []),
      };
    }
    paintPicker();
    paintBatch();
    paintQuality();
    paintSearch();
    paintEval();
  }

  /**
   * 换批次：四区全变。
   *
   * 这是本条的验收项 —— 所以它必须是**一个动作**同时刷新四块，
   * 而不是四个区各自监听。各自监听的话，切换瞬间会出现「批次已换、质控还是旧的」
   * 那种半新半旧的屏，而用户正拿它做判断。
   */
  async function selectBatch(id) {
    if (!id) return;
    state.set({ selectedBatchId: id });
    if (dataState.unavailable) {
      current = null;
      paintBatch();
      paintQuality();
      paintSearch();
      paintEval();
      ctx.repaintRail();
      return;
    }

    const [quality, search, evalResult] = await Promise.all([
      ensure(state, 'tree', DATA_ENDPOINTS.quality(id), (raw) => raw, `批次 ${id} 的质控`),
      ensure(state, 'events', DATA_ENDPOINTS.search(id, ''), (raw) => raw, `批次 ${id} 的检索`),
      ensure(state, 'pending', DATA_ENDPOINTS.eval(id), (raw) => raw, `批次 ${id} 的评测`),
    ]);

    const batch = dataState.batches.find((item) => (item.id || `${item.station}/${item.date}`) === id) || {};
    current = {
      batch,
      quality: quality?.counts || null,
      qualityUnavailable: Boolean(quality?.engineDown),
      search: search || null,
      eval: evalResult && typeof evalResult === 'object' ? evalResult.results || evalResult : null,
    };
    // 四区一起重画：避免半新半旧。
    paintBatch();
    paintQuality();
    paintSearch();
    paintEval();
    ctx.repaintRail();
  }

  /* —— 交互 —— */

  batchPicker.addEventListener('change', () => {
    selectBatch(batchPicker.value);
  });

  head.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="refresh"]')) {
      fetchBatches(true);
      if (state.get().selectedBatchId) selectBatch(state.get().selectedBatchId);
    }
    if (event.target.closest('[data-action="import"]')) {
      // 导入走 Convert 面板（那里已有抓包 → Parquet 的通道），不在这里再造一个。
      ctx.go('/suite');
    }
  });

  batchHost.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="import"]')) ctx.go('/suite');
    if (event.target.closest('[data-action="retry-batches"]')) fetchBatches(true);
  });

  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedBatchId')) ctx.repaintRail();
  });

  fetchBatches();

  return () => unsubscribe();
}
