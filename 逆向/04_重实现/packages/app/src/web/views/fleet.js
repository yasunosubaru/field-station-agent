/**
 * 编队视角 —— 视-0 建骨架，视-2 填内容。
 *
 * ## 改前是什么
 *
 * `/fleet` 的 iframe 指向 `/geo/luciad-stage.html`，也就是**地图页**。
 * 编队台在那之前根本不存在（第 26.16 节把「错法一：`/fleet` 还是地图」列在第一条）。
 *
 * ## 改后是什么（第 25.10 节 / 附录 C.4）
 *
 * 四块，从上到下：
 *
 * ```
 * 概览：3 运行 / 1 等人批 / 2 完成 / 0 失败
 * 任务树          ← 必须有耗时列
 * 事件流
 * 三种干预
 * ```
 *
 * ## 本阶段只做结构与空态
 *
 * 数据要 `forest()` / `tree()` / `event_stream()` / `pending()`，那些在视-2 接。
 * 但**结构与文案现在就定死**，因为最容易做错的两处都在这里：
 *
 *   · 任务树必须有「耗时」列 —— 它是「判断正常不正常」的唯一依据（25.10.3）
 *   · 「暂停」的文案必须是「将在当前步骤完成后生效」，**不能写「已暂停」**（25.10.5）
 *
 * 两条都写在代码里，不留在产品文档里 —— 文档不跟着发版走。
 */

import { el, empty, section, kv, table, button, headActions } from './dom.js';

/**
 * 「暂停」的提示文案。
 *
 * 第 25.10.5 节把这句点名为**全项目最容易做错的一处文案**。
 *
 * 为什么不能写「已暂停」：点下去那一刻，正在跑的那一步还在跑（ADR-009 规定
 * 干预在**步骤边界**被消费，不在工具执行中途强插）。写「已暂停」就是在骗人 ——
 * 用户会以为已经停了，然后去做别的，而任务还在动。
 *
 * 导出成常量，是为了让测试能直接断言这句话；写在模板字符串里就没法验了。
 */
export const PAUSE_NOTICE = '暂停请求已提交，将在当前步骤完成后生效';

/** 概览的四个数字。顺序即界面顺序。 */
export const OVERVIEW_KEYS = ['running', 'awaiting', 'done', 'failed'];

export function mount(ctx) {
  const { main, head, state } = ctx;

  /* —— 页头：视角名 + 概览 + 操作（附录 C.7 说页头要带「概览数字」） —— */
  const overview = el('div', { cls: 'vw-view-context', data: { overview: '' } });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '编队' }),
    overview,
    headActions([
      button('刷新', { variant: 'quiet', data: { action: 'refresh' } }),
      button('筛选', { variant: 'quiet', data: { action: 'filter' } }),
    ]),
  );

  /* —— ① 概览：四个数字 —— */
  function paintOverview() {
    // 第 25.10.2 节：这四个是用户要关心的。`pending` 不算 —— 「排队」不是用户要做事的事。
    // 但 100 个 pending 时要给一行小字（图上没有，附录 C.4 点一自己标为缺陷）。
    const counts = { running: 0, awaiting: 0, done: 0, failed: 0 };
    const labels = { running: '运行', awaiting: '等人批', done: '完成', failed: '失败' };
    overview.replaceChildren(...OVERVIEW_KEYS.map((key, index) => {
      const item = el('span', {
        cls: `vw-overview-item${index > 0 ? ' vw-overview-item-sep' : ''}`,
        data: { overviewKey: key },
        children: [
          el('span', { cls: 'num vw-overview-value', text: String(counts[key]) }),
          el('span', { cls: 'unit', text: labels[key] }),
        ],
      });
      return item;
    }));
  }
  paintOverview();

  /* —— ② 任务树：五列，其中「耗时」是最不该被砍的一列 —— */
  const treeHost = el('div', { cls: 'vw-fleet-tree', data: { taskTree: '' } });

  function paintTree() {
    // 树还没有数据时给空态；四种空态要互相区分（这里属于「还没有任务」）。
    treeHost.replaceChildren(empty(
      '还没有任务。',
      '在对话里问一句，或在套件台选设备后点「建任务」。任务会出现在这里。',
    ));
  }
  paintTree();

  /* —— ③ 事件流 —— */
  const flowHost = el('div', { cls: 'vw-fleet-flow', data: { eventStream: '' } });
  flowHost.replaceChildren(empty('还没有事件。', '选中一个任务后，这里按时间列出派发 / 完成 / 等待审批。'));

  /* —— ④ 三种干预 —— */
  const pauseNotice = el('p', { cls: 'vw-pause-notice', attr: { hidden: '' }, data: { pauseNotice: '' }, text: PAUSE_NOTICE });

  const actions = el('div', { cls: 'vw-fleet-actions', children: [
    // 三个按钮的可用性不同（25.10.4）：暂停要任务在跑；改参重试要有失败步骤；
    // 接管该步要有 running 或 failed 的步骤。不可用时置灰**并给出理由**。
    button('暂停', { disabled: true, title: '当前没有正在运行的任务（视-2 接 forest 后按状态启用）' }),
    button('改参重试', { disabled: true, title: '当前没有失败的步骤' }),
    button('接管该步', { disabled: true, title: '当前没有正在跑或失败的步骤' }),
    pauseNotice,
  ] });

  main.append(
    el('div', { cls: 'vw-fleet', children: [
      section('任务树', '按创建时间倒序', [treeHost]),
      section('事件流', null, [flowHost]),
      section('干预', '暂停 / 改参重试 / 接管该步', [actions]),
    ] }),
  );

  /* —— 右栏：选中任务的详情（25.6.1「编队 → 选中任务的详情」） —— */
  ctx.renderRail((rail) => {
    const { selectedTaskId } = state.get();
    rail.replaceChildren(
      section('选中任务', selectedTaskId ? '已选' : '未选', [
        selectedTaskId
          ? kv([['任务', selectedTaskId]])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中任务。点左边任务树上的一行。' }),
      ]),
      section('步骤', null, [
        el('p', { cls: 'vw-rail-empty', text: '选中任务后显示每一步的状态与耗时。' }),
      ]),
      section('事件流', null, [
        el('p', { cls: 'vw-rail-empty', text: '选中任务后显示最近几条。' }),
      ]),
    );
  });

  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedTaskId')) ctx.repaintRail();
  });

  return () => unsubscribe();
}
