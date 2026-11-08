/**
 * 数据视角 —— 视-0 建骨架，视-3 填内容。
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
 * 质控   缺测率 / 跳变 / 越界 三类计数
 * 检索   答案 + 分区 + SQL + 行数   ← 三样必须同时可见，不折叠
 * 评测   每条 S1–S6 绿否
 * ```
 *
 * ## 本阶段只做结构与空态
 *
 * 数据要 Parquet 分区与两个查询引擎，那些在视-3 接。但三件事现在就定死：
 *
 *   · **批次选择在最上面** —— 它是这一屏所有数字的前提，「换它，下面全变」（验收项）
 *   · **检索区的分区 / SQL / 行数必须同时可见，不折叠** —— 折起来用户不会点开，
 *     而「看了一眼但没看来源」等于没看（25.11.2）
 *   · **四种空态互相区分** —— 「无数据」让用户不知道下一步做什么（25.11.4）
 */

import { el, empty, section, kv, table, button, headActions, num } from './dom.js';

/**
 * 四种空态。
 *
 * 第 25.11.4 节列了这四种，并明确「四种不能都显示『无数据』」——
 * 因为那句让用户不知道下一步该做什么。导出成常量，测试可以逐条断言它们互不相同。
 */
export const EMPTY_STATES = {
  /** 没有批次：要给一个「导入」的动作。 */
  noBatch: { title: '还没有导入数据。', note: '先把一份抓包导入成 Parquet 批次，四个区才有东西可显示。' },
  /** 有批次但选中是空批次：不要给导入按钮，那是误导 —— 数据在，只是这一批没有行。 */
  emptyBatch: { title: '这个批次没有数据。', note: '换一个批次，或检查这次抓包是不是只含头部。' },
  /** 字段不存在：说清「哪个字段不在本批次里」，而不是笼统的无数据。 */
  missingField: { title: '这个字段不在本批次里。', note: '换一个字段，或确认这份数据的日志类型。' },
  /** 引擎不可用：这是**降级**，不是没数据 —— 必须说出来（附录 C.9 第 5 条）。 */
  engineDown: { title: '查询引擎不可用，已降级。', note: '数据还在磁盘上；恢复引擎后再查，结果口径会一致。' },
};

export function mount(ctx) {
  const { main, head, state } = ctx;

  /* —— 页头：视角名 + 批次选择 + 操作 —— */
  const batchPicker = el('select', {
    cls: 'vw-batch-picker',
    attr: { 'aria-label': '批次' },
    data: { batchPicker: '' },
    children: [el('option', { text: '还没有批次', attr: { value: '' } })],
  });

  const batchMeta = el('span', { cls: 'vw-sec-meta', data: { batchMeta: '' }, text: '共 0 分区' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '数据' }),
    el('div', { cls: 'vw-view-context', children: [batchPicker, batchMeta] }),
    headActions([
      button('导入', { variant: 'quiet', data: { action: 'import' } }),
      button('刷新', { variant: 'quiet', data: { action: 'refresh' } }),
    ]),
  );

  /* —— ① 批次区 —— */
  const batchHost = el('div', { cls: 'vw-data-batch', data: { batchBody: '' } });

  function paintBatch() {
    // 没有批次 → 第一种空态（带「导入」动作，因为下一步很明确）。
    batchHost.replaceChildren(empty(
      EMPTY_STATES.noBatch.title,
      EMPTY_STATES.noBatch.note,
      button('导入抓包', { variant: 'primary', data: { action: 'import' } }),
    ));
  }
  paintBatch();

  /* —— ② 质控区：三列，每列「绝对数 + 比例」 —— */
  const qcHost = el('div', { cls: 'vw-data-qc', data: { qcBody: '' } });
  qcHost.replaceChildren(empty(
    '选中一个批次后显示质控。',
    '三个计数：缺测 / 跳变 / 越界。绝对数说明「有多少」，比例说明「严重不严重」。',
  ));

  /* —— ③ 检索区：答案 + 回源，四样同在 —— */
  const searchHost = el('div', { cls: 'vw-data-search', data: { searchBody: '' } });

  function paintSearch() {
    // 检索区的骨架现在就画出来：问题、答案、回源（分区 / SQL / 行数 / 引擎）。
    // **不折叠** —— 这是本区唯一的设计硬要求。
    searchHost.replaceChildren(el('div', { cls: 'vw-search', children: [
      el('p', { cls: 'vw-search-q', children: [
        el('span', { cls: 'unit', text: '问' }),
        el('span', { text: 'WUHN 昨天缺测率多少？' }),
      ] }),
      el('p', { cls: 'vw-search-a', children: [
        el('span', { cls: 'unit', text: '答' }),
        el('span', { cls: 'num vw-search-answer', text: '—' }),
      ] }),
      el('div', { cls: 'vw-provenance', data: { provenance: '' }, children: [
        el('div', { cls: 'vw-provenance-head', text: '回源' }),
        kv([
          ['分区', '—'],
          ['行数', '—'],
          ['引擎', '—'],
        ]),
        el('div', { cls: 'vw-sql-wrap', children: [
          el('pre', { cls: 'vw-sql', data: { sql: '' }, text: '（查询执行后显示 SQL，一行一条子句，带缩进）' }),
        ] }),
      ] }),
    ] }));
  }
  paintSearch();

  /* —— ④ 评测区：S1–S6，用 ✓ ✗ 不用颜色（色盲用户） —— */
  const evalHost = el('div', { cls: 'vw-data-eval', data: { evalBody: '' } });
  evalHost.replaceChildren(el('p', {
    cls: 'vw-rail-empty',
    text: '评测还没跑。跑完后每条 S1–S6 各给一个 ✓ 或 ✗。',
  }));

  main.append(el('div', { cls: 'vw-data', children: [
    section('批次', null, [batchHost]),
    section('质控', null, [qcHost]),
    section('检索', '答案与回源同时可见', [searchHost]),
    section('评测', 'S1–S6', [evalHost]),
  ] }));

  /* —— 右栏：选中批次的统计（25.6.1） —— */
  ctx.renderRail((rail) => {
    const { selectedBatchId } = state.get();
    rail.replaceChildren(
      section('批次详情', selectedBatchId ? '已选' : '未选', [
        selectedBatchId
          ? kv([['批次', selectedBatchId]])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中的批次。' }),
        kv([
          ['行数', num('—')],
          ['分区', num('—')],
          ['字节', num('—')],
        ]),
      ]),
      section('数据质量', null, [
        el('p', { cls: 'vw-rail-empty', text: '质控结果出来后，这里给一句「合格 / 不合格」和依据的规程条目。' }),
      ]),
    );
  });

  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedBatchId')) ctx.repaintRail();
  });

  return () => unsubscribe();
}
