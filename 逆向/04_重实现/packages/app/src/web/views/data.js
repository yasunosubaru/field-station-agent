/**
 * 数据视角 —— 视-3。重做成**数据工作台**（DuckDB / ClickHouse 那种查询界面 + 质控看板）。
 *
 * ## 一屏四区（2×2）
 *
 * ```
 * ┌──────────────────────────────┬──────────────────────────────┐
 * │ 批次                          │ 质控                          │
 * │ 批次 / 时间范围 / 行数 / 分区  │ 三类计数 + 规则编号 + 阈值线    │
 * ├──────────────────────────────┼──────────────────────────────┤
 * │ 检索                          │ 评测                          │
 * │ 问一句 → 答案 + 分区 + SQL + 行数 │ 每条 EV-xx 的 S1–S6          │
 * └──────────────────────────────┴──────────────────────────────┘
 * ```
 *
 * 批次在左上：它是这一屏所有数字的前提，换它就四区全变（验收项）。
 *
 * ## 三条不能妥协的
 *
 * 1. **换批次是一个动作**，四区一起重画 —— 各自监听会出现「批次已换、质控还是旧的」，
 *    而用户正拿那一屏做判断。
 * 2. **检索的回源不折叠**：分区路径 / SQL / 行数三样同时可见。折起来用户不会点开，
 *    而「看了一眼但没看来源」等于没看（25.11.2）。
 * 3. **不可判就说不可判**：评测的 `s3` / `s6` 可以是 `null`（不可机判），
 *    界面显示「不可判」，**不画成绿也不画成红**。把它画绿是造假，画红是冤枉。
 *
 * ## 规则编号为什么必须在界面上
 *
 * 质控三类计数各自对应手册里一条可回源的规则（`docs/operations/qc-rules.md`）：
 * R-4.2 CN0 下限 30 dB-Hz、R-4.3 缺测率上限 5%、R-4.4 跳变门限 0.5 TECU。
 * 只给数字不给编号，用户无法判断「这个 3% 算不算不合格」，
 * 也没法在手册里查到原文 —— 那就退回成「模型说数据不好」。
 *
 * ## 数据从哪来
 *
 * 四个端点集中在 `DATA_ENDPOINTS`。响应形状按下面的口径归一（`normalize*`）：
 *
 * ```
 * GET /api/data/batches
 *   -> {"batches":[{"batch":"WUHN/2026-10-01","first":"…","last":"…","rows":…,"partitions":…}]}
 * GET /api/data/quality?batch=
 *   -> {"missing_rate":…,"slip_count":…,"out_of_range":…,
 *       "rules":[{"rule_id":"R-4.2","verdict":"ok","value":42.1}, …]}
 * GET /api/data/search?batch=&q=
 *   -> {"answer":"…","sql":"…","row_count":31,"partition_paths":["obs/…/"]}
 * GET /api/data/eval?batch=
 *   -> {"items":[{"case_id":"EV-01","s1":true,"s2":true,"s3":null, …}]}
 * ```
 *
 * 上游当前还多给一层（`counts` / `results` / `partition`），归一函数两种都吃，
 * 所以后端把包裹层去掉或留着，界面都不用改。
 *
 * ## store 缓存的一条坑（实测）
 *
 * `ensure()` 判缓存只看「这个槽是不是 ready」，**不看 URL**。四个区都按批次取数，
 * 槽却只有 forest/tree/events/pending 四个 —— 于是换批次会拿到上一批的值。
 * 这正是本屏验收项要避免的「半新半旧」。所以按批次 / 按问题的取数一律 `force: true`。
 */

import { el, empty, section, kv, button, headActions, num } from './dom.js';
import { ensure, formatNumber, formatPercent } from './state.js';

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

/**
 * 一条评测结论的显示。
 *
 * `null` 是**不可机判**（这条任务不考它，或要人工判），不是「没跑过」也不是「失败」。
 * 三档文字互不相同，而且 `?` + 「不可判」两样都给 —— 只给问号的话，
 * 扫一眼分不清是「待判」还是「漏画」。
 */
export function evalStatus(value) {
  if (value === true) return { mark: '✓', label: '通过', state: 'true' };
  if (value === false) return { mark: '✗', label: '未通过', state: 'false' };
  return { mark: '?', label: '不可判', state: 'unknown' };
}

/**
 * 三类质控计数，各自挂在手册里一条规则上。
 *
 * `key` 必须与后端 `counts` 的键同名（`missing` / `jumps` / `outOfRange`），
 * 否则界面会静默显示 `—` 而不是报错 —— 那种「看起来正常的空」最难查。
 */
export const QC_FIELDS = [
  {
    key: 'missing',
    label: '缺测',
    rule_id: 'R-4.3',
    section: '4.3',
    rule: '缺测率 ≤ 5%',
    threshold: 0.05,
    /** 越上限才算不合格（等于 5% 仍合格，与 verdict.py 一致）。 */
    direction: 'max',
  },
  {
    key: 'jumps',
    label: '跳变',
    rule_id: 'R-4.4',
    section: '4.4',
    rule: '相邻历元跳变 ≤ 0.5 TECU',
    threshold: 0,
    direction: 'max',
  },
  {
    key: 'outOfRange',
    label: '越界',
    rule_id: 'R-4.2',
    section: '4.2',
    // 反向阈值：CN0 低于下限就算越界，所以这里以「越界行数为 0」为准。
    rule: 'CN0 ≥ 30 dB-Hz',
    threshold: 0,
    direction: 'max',
  },
];

/** 合格 / 超限 / 不可判 三档的文字与记号。三档互不相同，不只靠颜色。 */
export const VERDICT_TEXT = {
  ok: { mark: '✓', label: '合格', tone: 'ok' },
  fail: { mark: '✗', label: '超限', tone: 'bad' },
  unknown: { mark: '?', label: '不可判', tone: 'quiet' },
};

/** 数据侧端点，集中一处。 */
export const DATA_ENDPOINTS = {
  batches: '/api/data/batches',
  quality: (batch) => `/api/data/quality?batch=${encodeURIComponent(batch)}`,
  search: (batch, q) => `/api/data/search?batch=${encodeURIComponent(batch)}&q=${encodeURIComponent(q)}`,
  eval: (batch) => `/api/data/eval?batch=${encodeURIComponent(batch)}`,
};

/* ================================================================
 * ① 响应归一：两种包裹层都吃
 * ================================================================ */

/** 数值或 `null`。`true`/`false` 不算数字（它们是 `int` 的子类，混进来会变成 1/0）。 */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 三态布尔：只认 `true` / `false`，其余（含 `null`）一律 `null` = 不可判。 */
function toBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/**
 * 批次列表。
 *
 * 认两种：契约的 `{batch, first, last}` 与上游的 `{id, station, date, period}`。
 * `id` 是这一屏的主键，缺了它这一行就没法点 —— 所以直接丢掉而不是画一个空行。
 */
export function normalizeBatches(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload && payload.batches) ? payload.batches : []);
  const rows = list.map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const id = String(source.batch ?? source.id ?? '').trim();
    return {
      id,
      station: String(source.station ?? ''),
      first: String(source.first ?? source.first_time ?? source.date ?? ''),
      last: String(source.last ?? source.last_time ?? source.date ?? ''),
      rows: toNumber(source.rows),
      partitions: toNumber(source.partitions),
    };
  });
  return rows.filter((row) => row.id);
}

/** 规则裁决：数组或按编号索引的对象都认；只留 `ok` / `fail` / `not_applicable`。 */
export function normalizeRules(raw) {
  const out = [];
  const push = (id, row) => {
    if (!id) return;
    const source = row && typeof row === 'object' ? row : {};
    const verdict = source.verdict === 'ok' || source.verdict === 'fail' || source.verdict === 'not_applicable'
      ? source.verdict
      : 'not_applicable';
    out.push({
      rule_id: String(source.rule_id ?? id),
      verdict,
      value: toNumber(source.value),
      threshold: toNumber(source.threshold),
      unit: String(source.unit ?? ''),
      section: String(source.section ?? ''),
      reason: String(source.reason ?? ''),
    });
  };
  if (Array.isArray(raw)) {
    for (const row of raw) push(row && row.rule_id ? row.rule_id : '', row);
  } else if (raw && typeof raw === 'object') {
    for (const [id, row] of Object.entries(raw)) push(id, row);
  }
  return out;
}

/**
 * 质控。
 *
 * 契约把三类计数放在顶层（`missing_rate` / `slip_count` / `out_of_range`），
 * 上游多包一层 `counts`（另带 `missingRate` 之类）。两者都认。
 * 比例优先用上游给的，没给就按计数 / 行数算 —— 但**分母为 0 时给 `null`**，
 * 不是 0：0/0 显示成 0% 会被读成「很好」。
 */
export function normalizeQuality(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const counts = payload.counts && typeof payload.counts === 'object' ? payload.counts : payload;
  const rows = toNumber(counts.rows);
  const missing = toNumber(counts.missing);
  const jumps = toNumber(counts.jumps ?? counts.slip_count);
  const outOfRange = toNumber(counts.outOfRange ?? counts.out_of_range);
  const rate = (value, given) => {
    const direct = toNumber(given);
    if (direct !== null) return direct;
    if (value === null || rows === null || rows <= 0) return null;
    return value / rows;
  };
  return {
    engineDown: payload.engineDown === true,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    rows,
    missing,
    jumps,
    outOfRange,
    missingRate: rate(missing, counts.missingRate ?? payload.missing_rate),
    jumpsRate: rate(jumps, counts.jumpsRate),
    outOfRangeRate: rate(outOfRange, counts.outOfRangeRate),
    rules: normalizeRules(payload.rules),
  };
}

/**
 * 检索答案。
 *
 * 回源三样（分区路径 / SQL / 行数）一个都不能少，所以这里把它们各自归一成
 * 明确的字段，缺了就是 `null` / `[]` / `''` —— 界面据此显示 `—`，
 * 而不是让某一格塌掉。
 */
export function normalizeSearch(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const paths = Array.isArray(payload.partition_paths)
    ? payload.partition_paths
    : (Array.isArray(payload.partitionPaths)
      ? payload.partitionPaths
      : (payload.partition ? [payload.partition] : []));
  const question = String(payload.question ?? payload.q ?? '');
  const sql = typeof payload.sql === 'string' ? payload.sql : '';
  const rowCount = toNumber(payload.row_count ?? payload.rows);
  const answer = payload.answer !== undefined && payload.answer !== null
    ? payload.answer
    : (payload.value !== undefined ? payload.value : null);
  return {
    // `asked` 不只看问题串：接口可能不带 question（契约只看答案与回源），
    // 那时只要有 SQL 或行数，就说明真查过一次 —— 不能当成「还没提问」。
    asked: question.trim().length > 0 || sql.length > 0 || rowCount !== null || answer !== null,
    question,
    // `??` 而不是 `||`：答案是 0 的时候必须显示 0。
    answer,
    sql,
    rowCount,
    engine: String(payload.engine ?? ''),
    elapsedMs: toNumber(payload.elapsedMs ?? payload.duration_ms),
    paths: paths.filter((path) => typeof path === 'string' && path.length > 0),
    missingField: payload.missingField === true,
    reason: String(payload.reason ?? ''),
    note: String(payload.note ?? ''),
  };
}

/**
 * 评测结果。
 *
 * 认两种：契约的 `{items:[{case_id, s1…s6}]}` 与上游的单条 `{results:{S1…S6}}`。
 * 一律展开成「每条一行 + 六个三态值」，界面才画得出 `不可判`。
 */
export function normalizeEval(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.items)) {
    if (!payload.items.length) return null;
    return payload.items.map((item) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        caseId: String(source.case_id ?? source.caseId ?? '—'),
        checks: EVAL_KEYS.map((key) => toBool(source[key.toLowerCase()])),
      };
    });
  }
  const results = payload.results ?? payload.checks;
  if (!results || typeof results !== 'object') return null;
  return [{
    caseId: String(payload.task_id ?? payload.batch ?? '本批次'),
    checks: EVAL_KEYS.map((key) => toBool(results[key])),
  }];
}

/**
 * 一类的裁决：优先用后端给的（它带手册原文与阈值来源），没有才按口径当场算。
 *
 * 两处判据与 `src/fieldstation/rules/verdict.py` 对齐：
 *   · 缺测率 **严格大于** 5% 才不合格（等于 5% 仍合格）；
 *   · 跳变 / 越界只要发生一次就算不合格（门限本身写在手册里）。
 */
export function qcVerdict(field, quality) {
  if (!quality) return 'unknown';
  if (quality.rows === null || quality.rows === 0) return 'unknown';
  const explicit = (quality.rules || []).find((row) => row.rule_id === field.rule_id);
  if (explicit) {
    if (explicit.verdict === 'fail') return 'fail';
    if (explicit.verdict === 'ok') return 'ok';
    return 'unknown';
  }
  if (field.key === 'missing') {
    if (quality.missingRate === null) return 'unknown';
    return quality.missingRate > field.threshold ? 'fail' : 'ok';
  }
  const count = quality[field.key];
  if (count === null) return 'unknown';
  return count > 0 ? 'fail' : 'ok';
}

/** 三类计数的显示数据（纯函数，测试直接验）。 */
export function qcCells(quality) {
  return QC_FIELDS.map((field) => ({
    field,
    verdict: qcVerdict(field, quality),
    text: VERDICT_TEXT[qcVerdict(field, quality)],
    count: field.key === 'missing' ? quality.missing : quality[field.key],
    rate: field.key === 'missing' ? quality.missingRate : quality[`${field.key}Rate`],
  }));
}

/* ================================================================
 * ② SQL 格式化
 * ================================================================ */

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

/* ================================================================
 * ③ 挂载
 * ================================================================ */

export function mount(ctx) {
  const { main, head, state } = ctx;

  /** 批次列表与「接口是否可用」。 */
  let dataState = { unavailable: false, batches: [], note: '' };
  /** 当前选中批次的四区数据。 */
  let current = null;
  /** 上一次真实发出的问题（空串 = 还没问）。 */
  let asked = '';

  /* —— 页头：视角名 + 批次快切 + 操作（附录 C.7「数据 → 批次选择」） —— */
  const batchPicker = el('select', {
    cls: 'vw-batch-picker',
    attr: { 'aria-label': '批次' },
    data: { batchPicker: '' },
  });
  const batchMeta = el('span', { cls: 'vw-sec-meta', data: { batchMeta: '' }, text: '—' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '数据' }),
    el('div', { cls: 'vw-view-context' }, [batchPicker, batchMeta]),
    headActions([
      button('导入', { variant: 'quiet', data: { action: 'import' } }),
      button('刷新', { variant: 'quiet', data: { action: 'refresh' } }),
    ]),
  );

  /* —— 四个区的落点 —— */
  const batchHost = el('div', { cls: 'vw-data-batch', data: { batchBody: '' } });
  const qcHost = el('div', { cls: 'vw-data-qc', data: { qcBody: '' } });
  const searchHost = el('div', { cls: 'vw-data-search', data: { searchBody: '' } });
  const evalHost = el('div', { cls: 'vw-data-eval', data: { evalBody: '' } });

  const queryInput = el('input', {
    cls: 'vw-search-input',
    attr: {
      type: 'search',
      placeholder: '问一句：WUHN 昨天缺测率多少',
      'aria-label': '检索问题',
      spellcheck: 'false',
      autocomplete: 'off',
    },
    data: { searchInput: '' },
  });
  const queryButton = button('查询', { variant: 'primary', data: { action: 'search' } });
  const searchForm = el('form', { cls: 'vw-search-form', attr: { role: 'search' } }, [queryInput, queryButton]);

  main.append(el('div', { cls: 'vw-data' }, [
    el('div', { cls: 'vw-pane vw-pane-batch', data: { pane: 'batch' } }, [
      section('批次', '选中一个 · 其他三区跟着变', [batchHost]),
    ]),
    el('div', { cls: 'vw-pane vw-pane-quality', data: { pane: 'quality' } }, [
      section('质控', '缺测 / 跳变 / 越界', [qcHost]),
    ]),
    el('div', { cls: 'vw-pane vw-pane-search', data: { pane: 'search' } }, [
      section('检索', '答案与回源同时可见', [searchForm, searchHost]),
    ]),
    el('div', { cls: 'vw-pane vw-pane-eval', data: { pane: 'eval' } }, [
      section('评测', 'S1–S6', [evalHost]),
    ]),
  ]));

  /* —— 批次快切（页头那个 select） —— */
  function paintPicker() {
    batchPicker.replaceChildren();
    if (dataState.unavailable || !dataState.batches.length) {
      batchPicker.append(el('option', { attr: { value: '' }, text: dataState.unavailable ? '拿不到批次' : '还没有批次' }));
      batchPicker.disabled = true;
      batchMeta.textContent = dataState.unavailable ? '接口未接' : '共 0 个批次';
      return;
    }
    batchPicker.disabled = false;
    for (const batch of dataState.batches) {
      const option = el('option', { text: batch.id });
      option.value = batch.id;
      batchPicker.append(option);
    }
    const selected = state.get().selectedBatchId;
    batchPicker.value = dataState.batches.some((batch) => batch.id === selected)
      ? selected
      : dataState.batches[0].id;
    const partitions = dataState.batches
      .reduce((sum, batch) => sum + (batch.partitions || 0), 0);
    batchMeta.textContent = `${dataState.batches.length} 个批次 · ${formatNumber(partitions)} 分区`;
  }

  /* —— ① 批次区：一张表，点一行就换批次 —— */
  function paintBatch() {
    if (dataState.unavailable) {
      // 这条空态**必须给一个能点的动作**。只写「等接口」的话，用户在这里
      // 除了读一段说明什么都做不了 —— 而他真正能做的往往是「重试一次」
      // （后端刚起来、代理刚通、端口刚换，都发生过）。
      batchHost.replaceChildren(empty(
        '批次还拿不到数据。',
        '数据视角要读 Parquet 批次，查询层已经实现，但这一块还没接上。'
          + '这不是「没有批次」，是「还没接上」。',
        button('重试', { variant: 'primary', data: { action: 'retry-batches' } }),
      ));
      return;
    }
    if (!dataState.batches.length) {
      batchHost.replaceChildren(empty(
        EMPTY_STATES.noBatch.title,
        EMPTY_STATES.noBatch.note,
        button('导入抓包', { variant: 'primary', data: { action: 'import' } }),
      ));
      return;
    }

    const selectedId = state.get().selectedBatchId;
    const headRow = el('div', { cls: 'vw-batch-row vw-batch-row-head', attr: { role: 'row' } }, [
      el('span', { attr: { role: 'columnheader' }, text: '批次' }),
      el('span', { attr: { role: 'columnheader' }, text: '时间范围' }),
      el('span', { cls: 'num', attr: { role: 'columnheader' }, text: '行数' }),
      el('span', { cls: 'num', attr: { role: 'columnheader' }, text: '分区' }),
    ]);

    const rows = dataState.batches.map((batch) => {
      const isCurrent = batch.id === selectedId;
      return el('button', {
        cls: `vw-batch-row vw-batch-row-item${isCurrent ? ' vw-batch-row-current' : ''}`,
        attr: { type: 'button', role: 'row', 'aria-pressed': String(isCurrent) },
        data: { batchId: batch.id },
        children: [
          el('span', { cls: 'vw-batch-id', title: batch.id, text: batch.id }),
          el('span', {
            cls: 'vw-batch-range',
            title: `${batch.first || '—'} … ${batch.last || '—'}`,
            text: batch.first || batch.last ? `${batch.first || '—'} … ${batch.last || '—'}` : '—',
          }),
          el('span', { cls: 'num', text: formatNumber(batch.rows) }),
          el('span', { cls: 'num', text: formatNumber(batch.partitions) }),
        ],
      });
    });

    batchHost.replaceChildren(el('div', { cls: 'vw-batch-table', attr: { role: 'table' } }, [headRow, ...rows]));
  }

  /* —— ② 质控区：三类计数 + 规则编号 + 阈值线 + 红绿状态 —— */
  function paintQuality() {
    if (dataState.unavailable) {
      qcHost.replaceChildren(empty('质控还拿不到数据。', '同上：等查询层的 HTTP 出口。'));
      return;
    }
    if (!current) {
      // 有批次但还没选：这是「未选择」，不是「无数据」。
      qcHost.replaceChildren(empty(
        '选中一个批次后显示质控。',
        '三个计数：缺测 / 跳变 / 越界，每个都带一条规则编号与阈值。',
      ));
      return;
    }
    if (current.qualityDown) {
      // 引擎不可用是**降级**，不是没数据 —— 必须明确说出来。
      qcHost.replaceChildren(empty(
        EMPTY_STATES.engineDown.title,
        current.qualityReason ? `${EMPTY_STATES.engineDown.note}（${current.qualityReason}）` : EMPTY_STATES.engineDown.note,
      ));
      return;
    }
    if (!current.quality || current.quality.rows === 0) {
      qcHost.replaceChildren(empty(EMPTY_STATES.emptyBatch.title, EMPTY_STATES.emptyBatch.note));
      return;
    }

    qcHost.replaceChildren(el('div', { cls: 'vw-qc-grid' }, qcCells(current.quality).map((cell) => el('div', {
      cls: 'vw-qc-cell',
      data: { qc: cell.field.key, verdict: cell.verdict },
      title: `${cell.field.rule_id} · docs/operations/qc-rules.md §${cell.field.section}`,
      children: [
        el('span', { cls: 'vw-qc-label' }, [
          el('span', { cls: 'vw-qc-rule', text: cell.field.rule_id }),
          el('span', { text: cell.field.label }),
        ]),
        // 绝对数说明「有多少」，比例说明「严重不严重」—— 两个都要（附录 C.5 点二）。
        // 契约只给缺测**率**（`missing_rate`）时，主值就是那个比例 —— 不能显示成「—」。
        el('span', {
          cls: 'vw-qc-value num',
          text: cell.count === null ? formatPercent(cell.rate) : formatNumber(cell.count),
        }),
        el('span', {
          cls: 'vw-qc-ratio',
          text: cell.count === null ? '' : formatPercent(cell.rate),
        }),
        // 阈值线：不给它，用户没法判断「这个 3% 算不算不合格」。
        el('span', { cls: 'vw-qc-line', text: `阈值 ${cell.field.rule}` }),
        // 合格 / 超限 / 不可判：记号 + 文字 + 颜色，三样都有（不只靠颜色）。
        el('span', {
          cls: 'vw-qc-badge',
          data: { tone: cell.text.tone },
          text: `${cell.text.mark} ${cell.text.label}`,
        }),
      ],
    }))));
  }

  /* —— ③ 检索区：答案 + 回源，四样同在一屏 —— */
  function paintSearch() {
    if (dataState.unavailable) {
      searchHost.replaceChildren(empty('检索还拿不到数据。', '同上：等查询层的 HTTP 出口。'));
      return;
    }
    if (!current) {
      searchHost.replaceChildren(empty(
        '选中一个批次后可以检索。',
        '答案会连同分区路径、SQL、行数一起给出 —— 三样必须同时可见。',
      ));
      return;
    }
    if (current.searchError) {
      searchHost.replaceChildren(empty(
        '这次查询没答上来。',
        current.searchError,
        button('重试', { data: { action: 'retry-search' } }),
      ));
      return;
    }
    const answer = current.search;
    if (!answer || !answer.asked) {
      searchHost.replaceChildren(empty(
        '还没有提问。',
        '问一句「WUHN 昨天缺测率多少」，答案与回源会一起出现在这里。',
      ));
      return;
    }
    if (answer.missingField) {
      // 第三种空态：字段不存在，说清是哪个字段。
      searchHost.replaceChildren(empty(
        EMPTY_STATES.missingField.title,
        answer.reason ? `${EMPTY_STATES.missingField.note}（${answer.reason}）` : EMPTY_STATES.missingField.note,
      ));
      return;
    }

    const sql = formatSql(answer.sql);
    const partitionValue = answer.paths.length
      ? el('code', { cls: 'vw-path', text: answer.paths[0] })
      : el('span', { cls: 'vw-path', text: '—' });

    searchHost.replaceChildren(el('div', { cls: 'vw-search' }, [
      el('p', { cls: 'vw-search-q' }, [
        el('span', { cls: 'unit', text: '问' }),
        el('span', { text: answer.question || asked || '—' }),
      ]),
      el('p', { cls: 'vw-search-a' }, [
        el('span', { cls: 'unit', text: '答' }),
        el('span', {
          cls: 'num vw-search-answer',
          text: answer.answer === null || answer.answer === undefined ? '—' : String(answer.answer),
        }),
      ]),
      // 回源块：**不折叠**。这是本区唯一的设计硬要求。
      el('div', { cls: 'vw-provenance', data: { provenance: '' } }, [
        el('div', { cls: 'vw-provenance-head', text: '回源' }),
        kv([
          ['分区', partitionValue],
          ['行数', el('span', { cls: 'num', data: { rowCount: String(answer.rowCount ?? '') }, text: formatNumber(answer.rowCount) })],
          ['引擎', el('span', {}, [
            el('span', { text: answer.engine || '—' }),
            answer.elapsedMs === null ? null : el('span', { cls: 'unit', text: `· ${answer.elapsedMs} ms` }),
          ])],
        ]),
        // 分区路径**全部**列出：只给第一个的话，用户没法判断这份答案覆盖了几个分区。
        el('div', {
          cls: 'vw-part-paths',
          data: { partitionCount: String(answer.paths.length) },
          attr: { 'aria-label': `分区路径 ${answer.paths.length} 条` },
        }, answer.paths.length
          ? answer.paths.map((path) => el('code', { cls: 'vw-path vw-part-path', text: path }))
          : [el('span', { cls: 'vw-path', text: '（本次答案不涉及分区）' })]),
        el('div', { cls: 'vw-sql-wrap' }, [
          el('pre', { cls: 'vw-sql', data: { sql: '' }, text: sql || '（本次查询没有 SQL）' }),
        ]),
      ]),
    ]));
  }

  /* —— ④ 评测区：每条 EV-xx 的 S1–S6，null 显示「不可判」 —— */
  function paintEval() {
    if (dataState.unavailable) {
      evalHost.replaceChildren(el('p', { cls: 'vw-rail-empty', text: '评测还拿不到数据。' }));
      return;
    }
    if (!current) {
      evalHost.replaceChildren(el('p', { cls: 'vw-rail-empty', text: '选中一个批次后显示评测结果。' }));
      return;
    }
    if (!current.evalItems || !current.evalItems.length) {
      evalHost.replaceChildren(el('p', {
        cls: 'vw-rail-empty',
        text: current.evalNote
          ? `这个批次还没有评测结果。${current.evalNote}`
          : '这个批次还没有评测结果。每条 S1–S6 会各给一个 ✓、✗ 或「不可判」。',
      }));
      return;
    }

    const headRow = el('div', { cls: 'vw-eval-row vw-eval-row-head' }, [
      el('span', { text: '用例' }),
      ...EVAL_KEYS.map((key) => el('span', { cls: 'vw-eval-key', text: key })),
    ]);

    const rows = current.evalItems.map((item) => el('div', {
      cls: 'vw-eval-row',
      data: { evalCase: item.caseId },
    }, [
      el('span', { cls: 'vw-eval-case', title: item.caseId, text: item.caseId }),
      ...item.checks.map((value, index) => {
        const status = evalStatus(value);
        return el('span', {
          cls: 'vw-eval-cell',
          data: { evalKey: EVAL_KEYS[index], state: status.state },
          // 读屏也要听到「不可判」：只给一个问号，读屏会念成「问号」。
          attr: { 'aria-label': `${EVAL_KEYS[index]} ${status.label}` },
          title: `${EVAL_KEYS[index]} ${status.label}`,
          children: [
            // ✓ / ✗ 之外再给「不可判」三个字 —— 空值不能画成绿也不能画成红。
            el('span', { cls: 'vw-eval-mark', data: { state: status.state }, text: status.mark }),
            status.state === 'unknown' ? el('span', { cls: 'vw-eval-word', text: status.label }) : null,
          ],
        });
      }),
    ]));

    evalHost.replaceChildren(el('div', { cls: 'vw-eval-table', attr: { role: 'table' } }, [headRow, ...rows]));
  }

  /* —— 右栏：选中批次的统计（25.6.1「数据 → 选中批次的统计」） —— */
  ctx.renderRail((rail) => {
    const selected = state.get().selectedBatchId;
    const batch = current && current.batch;

    rail.replaceChildren(
      section('批次详情', selected ? '已选' : '未选', [
        selected
          ? kv([['批次', selected]])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中的批次。' }),
        kv([
          ['时间范围', batch ? `${batch.first || '—'} … ${batch.last || '—'}` : '—'],
          ['行数', num(formatNumber(batch && batch.rows))],
          ['分区', num(formatNumber(batch && batch.partitions))],
        ]),
      ]),
      section('数据质量', null, [
        current && current.quality
          ? kv(qcCells(current.quality).map((cell) => [
            `${cell.field.rule_id} ${cell.field.label}`,
            el('span', {}, [
              el('span', { text: `${cell.text.mark} ${cell.text.label}` }),
              el('span', { cls: 'unit', text: formatPercent(cell.rate) }),
            ]),
          ]))
          : el('p', { cls: 'vw-rail-empty', text: '质控结果出来后，这里按规则编号给三档结论。' }),
        // 降级必须显示，不能藏（附录 C.9 第 5 条：藏起来让界面好看等于骗用户）。
        current && current.qualityDown
          ? el('p', { cls: 'vw-warn', text: EMPTY_STATES.engineDown.title })
          : null,
      ]),
      section('最近一次查询', asked ? '已问' : '未问', [
        asked
          ? el('p', { cls: 'vw-rail-empty', text: asked })
          : el('p', { cls: 'vw-rail-empty', text: '还没有提问。答案里的分区、SQL、行数会一起出现，方便回源。' }),
      ]),
    );
  });

  /* —— 取数 —— */

  async function fetchBatches(force = false) {
    const payload = await ensure(state, 'forest', DATA_ENDPOINTS.batches, (raw) => raw, '批次列表', { force });
    const slot = state.get().cache.forest;
    if (payload === null && slot.state === 'error') {
      dataState = { unavailable: true, batches: [], note: '' };
    } else {
      dataState = {
        unavailable: false,
        batches: normalizeBatches(payload),
        note: payload && typeof payload.note === 'string' ? payload.note : '',
      };
    }
    paintPicker();
    paintBatch();
    paintQuality();
    paintSearch();
    paintEval();

    if (dataState.unavailable || !dataState.batches.length) {
      current = null;
      ctx.repaintRail();
      return;
    }
    // 自动选中一个批次：否则四区都停在「选中一个批次后……」，等于什么都没显示。
    const wanted = state.get().selectedBatchId;
    const id = dataState.batches.some((batch) => batch.id === wanted)
      ? wanted
      : dataState.batches[0].id;
    await selectBatch(id);
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
    const previous = state.get().selectedBatchId;
    state.set({ selectedBatchId: id });
    // **只在这个批次真的换了的时候**清掉上一次的问题与答案。
    // 无条件清会出现一个真实的竞态：初次加载的 selectBatch 还在取数时用户已经问了
    // 一句，它的 await 后落在 runSearch 之后，于是刚答出来的答案被清成「还没有提问」
    // （实测踩到）。同一个批次重新选一次也不该清 —— 用户会以为查询失败了。
    if (previous !== id) {
      asked = '';
      queryInput.value = '';
    }
    paintPicker();
    if (dataState.unavailable) {
      current = null;
      paintBatch();
      paintQuality();
      paintSearch();
      paintEval();
      ctx.repaintRail();
      return;
    }

    const [qualityRaw, searchRaw, evalRaw] = await Promise.all([
      // `force: true` 是必须的：ensure 判缓存只看槽是否 ready、不看 URL，
      // 而四个区共用四个槽 —— 不强制重取的话，换批次会拿到上一批的数字。
      ensure(state, 'tree', DATA_ENDPOINTS.quality(id), (raw) => raw, `批次 ${id} 的质控`, { force: true }),
      ensure(state, 'events', DATA_ENDPOINTS.search(id, ''), (raw) => raw, `批次 ${id} 的检索`, { force: true }),
      ensure(state, 'pending', DATA_ENDPOINTS.eval(id), (raw) => raw, `批次 ${id} 的评测`, { force: true }),
    ]);

    const qualitySlot = state.get().cache.tree;
    const batch = dataState.batches.find((item) => item.id === id) || { id };
    const quality = normalizeQuality(qualityRaw);
    const evalItems = normalizeEval(evalRaw);

    // 这次取数期间用户可能已经问过一句（runSearch 先落了答案）。那份答案属于这个批次，
    // 必须留住 —— 整体换掉 `current` 会把它清成「还没有提问」，而用户明明刚看到结果。
    const carried = current && current.search && asked && current.batch && current.batch.id === id
      ? current.search
      : null;

    current = {
      batch,
      quality: quality && !quality.engineDown ? quality : null,
      qualityDown: Boolean(qualityRaw && (qualityRaw.engineDown === true || qualitySlot.state === 'error')),
      qualityReason: quality && quality.reason ? quality.reason : '',
      search: carried || normalizeSearch(searchRaw),
      searchError: '',
      evalItems,
      evalNote: evalRaw && typeof evalRaw.note === 'string' ? evalRaw.note : '',
    };
    // 四区一起重画：避免半新半旧。
    paintBatch();
    paintQuality();
    paintSearch();
    paintEval();
    ctx.repaintRail();
  }

  /** 问一句：答案 + 回源一起回来（回源三样不折叠）。 */
  async function runSearch(question) {
    const batchId = state.get().selectedBatchId;
    if (!batchId) return;
    const text = String(question || '').trim();
    asked = text;
    if (!current) return;

    if (!text) {
      current.search = null;
      current.searchError = '';
      paintSearch();
      return;
    }

    queryButton.disabled = true;
    try {
      const raw = await ensure(
        state,
        'events',
        DATA_ENDPOINTS.search(batchId, text),
        (row) => row,
        `批次 ${batchId} 的检索「${text}」`,
        { force: true },
      );
      // 期间换了批次：这份答案作废（否则会出现「问的是 A、显示的是 B」）。
      if (state.get().selectedBatchId !== batchId) return;
      const slot = state.get().cache.events;
      if (slot.state === 'error') {
        current.search = null;
        current.searchError = slot.error
          ? `${slot.error.what}（${slot.error.code}）：${slot.error.hint}`
          : '接口没有返回内容。';
      } else {
        current.search = normalizeSearch(raw || { question: text });
        current.searchError = '';
      }
    } finally {
      queryButton.disabled = false;
    }
    paintSearch();
    ctx.repaintRail();
  }

  /* —— 交互 —— */

  /**
   * 「导入」的唯一入口：先选中 Convert，再跳套件台。
   *
   * 套件台记着上一次选中的应用（`selectedAppId` 也会持久化）。实测：上一次停在
   * Graph，从数据台点「导入抓包」跳过去落在 **Graph** —— 那里没有任何导入入口，
   * 只有「还没有图工程」。用户会以为导入坏了，而真正的通道在 Convert 面板。
   * 所以跳转前必须把选中项切到 `convert`。
   */
  function goImport() {
    state.set({ selectedAppId: 'convert' });
    ctx.go('/suite');
  }

  batchPicker.addEventListener('change', () => {
    selectBatch(batchPicker.value);
  });

  batchHost.addEventListener('click', (event) => {
    const row = event.target.closest('[data-batch-id]');
    if (row) {
      selectBatch(row.dataset.batchId);
      return;
    }
    if (event.target.closest('[data-action="import"]')) goImport();
    if (event.target.closest('[data-action="retry-batches"]')) fetchBatches(true);
  });

  searchForm.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    runSearch(queryInput.value);
  });

  /*
   * `button()` 建出来的按钮是 `type="button"`，**它不会提交表单**。所以除了 `submit`
   * （输入框里按回车），还必须给按钮自己绑一次 `click` —— 只绑 submit 的话，
   * 回车里有反应、点按钮没反应，而「点了没反应」会被读成「查询坏了」（实测踩到）。
   * 两条路都走同一个 `runSearch`，不各写一遍。
   */
  queryButton.addEventListener('click', () => runSearch(queryInput.value));

  searchHost.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="retry-search"]')) runSearch(asked);
  });

  head.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="refresh"]')) {
      fetchBatches(true);
    }
    if (event.target.closest('[data-action="import"]')) {
      // 导入走 Convert 面板（那里已有抓包 → Parquet 的通道），不在这里再造一个。
      goImport();
    }
  });

  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedBatchId')) ctx.repaintRail();
  });

  fetchBatches();

  return () => unsubscribe();
}
