/**
 * 编队视角 —— 视-2。
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
 * ## 数据从哪来
 *
 * `botd/interaction.py` 的 `forest()` / `tree()` / `event_stream()` / `pending()`。
 * 那几个方法已有 34 项测试，但**当前没有 HTTP 出口**（已在广播板问 A 线）。
 * 所以本文件把「取数」与「画」分开：
 *
 *   · `fetchFleet()` 是唯一的数据入口，路径集中在一处；
 *   · 接口不到位时它返回 `{ unavailable: true }`，界面照常画出四块，
 *     只是每块内部显示「还没接上」而不是假装有数据。
 *
 * 这样接口一到位只改 `fetchFleet()` 的 URL，界面一行不用动。
 * **不造假数据**：没有就是没有，「0 运行」和「拿不到」必须能区分。
 */

import { el, empty, section, kv, button, headActions, num } from './dom.js';
import { ensure, formatDuration, formatClock, taskId, elapsedMs } from './state.js';

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

/** 概览的中文名。`awaiting` 是唯一「需要用户做事」的那个，要能一眼找到。 */
const OVERVIEW_LABELS = { running: '运行', awaiting: '等人批', done: '完成', failed: '失败' };

/**
 * botd 的 HTTP 端点。
 *
 * 集中在这里，接口定下来只改这一处。当前 `server.ts` 没有这些路由
 * （已问 A 线：是新建 `/api/botd/*` 还是并进 runtimes/server.py）。
 */
export const BOTD_ENDPOINTS = {
  forest: '/api/botd/forest',
  tree: (id) => `/api/botd/tree?task_id=${encodeURIComponent(id)}`,
  events: (id) => `/api/botd/events?task_id=${encodeURIComponent(id)}`,
  pending: '/api/botd/pending',
  intervene: '/api/botd/intervene',
};

/** 任务状态 → 图标 + 中文。状态是五态（见 store.py 的 STEP_STATUSES）。 */
const STEP_STATUS = {
  pending: { glyph: '○', label: '待执行' },
  running: { glyph: '◆', label: '执行中' },
  done: { glyph: '✓', label: '完成' },
  failed: { glyph: '✕', label: '失败' },
  skipped: { glyph: '–', label: '跳过' },
};

/** 任务级状态（八态）。只列界面会用到的，其余原样显示。 */
const TASK_STATUS = {
  pending: '待执行',
  running: '运行中',
  done: '完成',
  failed: '失败',
  // `pause` 是「请求已提交」，不是「已经停了」—— 文案必须与 25.10.5 一致：
  // 干预在步骤边界消费，此刻任务还在跑。
  paused: '停止请求已提交',
  cancelled: '已取消',
};

export function mount(ctx) {
  const { main, head, state } = ctx;

  /** 上次拿到的是「接口不可用」还是「真的有数据」，决定空态怎么画。 */
  let fleetState = { unavailable: false, tasks: [], pending: [] };
  let selectedTree = null;

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
    const counts = { running: 0, awaiting: 0, done: 0, failed: 0 };
    for (const item of fleetState.tasks) {
      const status = item.task?.status;
      if (status === 'running') counts.running += 1;
      else if (status === 'done') counts.done += 1;
      else if (status === 'failed') counts.failed += 1;
    }
    counts.awaiting = fleetState.pending.length;

    overview.replaceChildren(...OVERVIEW_KEYS.map((key, index) => el('span', {
      cls: `vw-overview-item${index > 0 ? ' vw-overview-item-sep' : ''}`,
      data: { overviewKey: key },
      children: [
        el('span', { cls: `num vw-overview-value${fleetState.unavailable ? ' vw-dim' : ''}`, text: fleetState.unavailable ? '—' : String(counts[key]) }),
        el('span', { cls: 'unit', text: OVERVIEW_LABELS[key] }),
      ],
    })));

    // 「排队很多」时给一行小字（附录 C.4 点一自己标为缺陷：图上没有）。
    const queued = fleetState.tasks.reduce(
      (sum, item) => sum + Math.max(0, (item.step_count || 0) - (item.done || 0) - (item.failed || 0)),
      0,
    );
    if (queued > 10) {
      overview.append(el('span', { cls: 'unit vw-overview-queued', text: `排队 ${queued}` }));
    }
  }

  /* —— ② 任务树：五列，其中「耗时」是最不该被砍的一列 —— */
  const treeHost = el('div', { cls: 'vw-fleet-tree', data: { taskTree: '' } });

  function paintTree() {
    if (fleetState.unavailable) {
      treeHost.replaceChildren(empty(
        '任务树还拿不到数据。',
        '编队台要读 botd 的 forest() / tree()，那几个方法已经实现，但还没有 HTTP 出口。'
          + '接口定下来之后这一块会自己填上；现在不是「没有任务」，是「还没接上」。',
      ));
      return;
    }
    if (!fleetState.tasks.length) {
      treeHost.replaceChildren(empty(
        '还没有任务。',
        '在对话里问一句，或在套件台选设备后点「建任务」。任务会出现在这里。',
      ));
      return;
    }

    const rows = [];
    // 表头。耗时列右对齐、等宽 —— 一列数字的目的就是让人比较大小（视觉规矩一）。
    rows.push(el('div', { cls: 'vw-tree-row vw-tree-row-head', children: [
      el('span', { text: '' }),
      el('span', { text: '任务' }),
      el('span', { text: '状态' }),
      el('span', { cls: 'vw-tree-progress', text: '进度' }),
      el('span', { cls: 'vw-tree-duration', text: '耗时' }),
    ] }));

    for (const item of fleetState.tasks) {
      const task = item.task || {};
      const id = taskId(task);
      const isCurrent = id && id === state.get().selectedTaskId;
      const status = task.status || 'pending';
      const total = item.step_count || 0;
      const finished = (item.done || 0) + (item.failed || 0);

      const row = el('div', {
        cls: `vw-tree-row${isCurrent ? ' vw-tree-row-current' : ''}`,
        data: { taskId: id },
        attr: { role: 'button', tabindex: '0', 'aria-current': isCurrent ? 'true' : null },
        children: [
          el('span', { cls: 'vw-tree-glyph', text: TASK_STATUS[status] ? (status === 'running' ? '◆' : status === 'done' ? '✓' : status === 'failed' ? '✕' : '○') : '○' }),
          el('span', { cls: 'vw-tree-name', title: task.title || id, text: task.title || task.kind || id }),
          el('span', { cls: 'vw-tree-status', text: TASK_STATUS[status] || status }),
          el('span', { cls: 'vw-tree-progress', text: total ? `${finished}/${total}` : '—' }),
          // 耗时：正在跑的显示「已跑多久」，跑完的显示总耗时。
          el('span', { cls: 'vw-tree-duration', text: taskDurationText(item) }),
        ],
      });
      rows.push(row);
    }

    treeHost.replaceChildren(...rows);
  }

  /**
   * 一个顶层任务在列表里该显示多少耗时。
   *
   * 正在跑的用「现在 - 开始」算「已跑多久」（用户最关心的正是这个：第 3 步跑了
   * 5 分钟，正常吗）；跑完的用总耗时。都没有就 `—`，**不猜**。
   */
  function taskDurationText(item) {
    const task = item.task || {};
    const start = task.started_at || task.created_at;
    const end = task.finished_at;
    const ms = elapsedMs(start, end || null);
    if (ms === null) return '—';
    // 跑完的任务不再「长大」，所以传 end 让它停在终点；
    // 没跑完的 `elapsedMs` 用当前时间，表现上是「已跑多久」。
    return formatDuration(ms);
  }

  /* —— ③ 事件流 —— */
  const flowHost = el('div', { cls: 'vw-fleet-flow', data: { eventStream: '' } });

  function paintFlow() {
    if (fleetState.unavailable) {
      flowHost.replaceChildren(empty('事件流还拿不到数据。', '同上：等 botd 的 HTTP 出口。'));
      return;
    }
    const events = selectedTree?.events ?? [];
    if (!events.length) {
      flowHost.replaceChildren(empty(
        '还没有事件。',
        '选中一个任务后，这里按时间列出派发 / 完成 / 等待审批。',
      ));
      return;
    }
    flowHost.replaceChildren(...events.map((event) => el('div', {
      cls: 'vw-flow-row',
      data: { phase: event.phase },
      children: [
        // 时间可能为 null（老数据没有该字段）—— 不编一个出来，显示 `—`。
        el('span', { cls: 'vw-flow-time', text: formatClock(event.at) }),
        el('span', { cls: 'vw-flow-label', text: event.label || event.phase }),
      ],
    })));
  }

  /* —— ④ 三种干预 —— */
  const pauseNotice = el('p', {
    cls: 'vw-pause-notice',
    attr: { hidden: '' },
    data: { pauseNotice: '' },
    text: PAUSE_NOTICE,
  });

  /**
   * 三个按钮的可用性（25.10.4）。
   *
   * | 按钮 | 什么时候可用 |
   * |---|---|
   * | 暂停 | 任务在跑时 |
   * | 改参重试 | 有步骤失败时 |
   * | 接管该步 | 有步骤正在跑或失败时 |
   *
   * 不可用时置灰**并给出理由** —— 灰掉不说为什么，用户会以为界面坏了。
   */
  function interventionAvailability() {
    const tree = selectedTree;
    if (fleetState.unavailable || !tree) {
      return {
        pause: { enabled: false, why: '还没有选中任务' },
        retry: { enabled: false, why: '还没有选中任务' },
        takeover: { enabled: false, why: '还没有选中任务' },
      };
    }
    const steps = tree.steps || [];
    const anyRunning = steps.some((step) => step.status === 'running');
    const anyFailed = steps.some((step) => step.status === 'failed');
    const taskRunning = tree.root?.status === 'running';

    return {
      pause: {
        enabled: taskRunning || anyRunning,
        why: taskRunning || anyRunning ? '' : '这个任务没有在跑的步骤',
      },
      retry: {
        enabled: anyFailed,
        why: anyFailed ? '' : '当前没有失败的步骤',
      },
      takeover: {
        enabled: anyRunning || anyFailed,
        why: anyRunning || anyFailed ? '' : '当前没有正在跑或失败的步骤',
      },
    };
  }

  const pauseButton = button('暂停', { data: { kind: 'pause' } });
  const retryButton = button('改参重试', { data: { kind: 'retry' } });
  const takeoverButton = button('接管该步', { data: { kind: 'takeover' } });

  const actions = el('div', { cls: 'vw-fleet-actions', children: [
    pauseButton, retryButton, takeoverButton, pauseNotice,
  ] });

  function paintInterventions() {
    const availability = interventionAvailability();
    const map = { pause: pauseButton, retry: retryButton, takeover: takeoverButton };
    for (const [kind, buttonEl] of Object.entries(map)) {
      const info = availability[kind];
      buttonEl.disabled = !info.enabled;
      buttonEl.title = info.why || '';
      // 不可用时要能让键盘用户也知道原因。
      buttonEl.setAttribute('aria-disabled', String(!info.enabled));
    }
  }

  main.append(el('div', { cls: 'vw-fleet', children: [
    section('任务树', '按创建时间倒序', [treeHost]),
    section('事件流', null, [flowHost]),
    section('干预', '暂停 / 改参重试 / 接管该步', [actions]),
  ] }));

  /* —— 右栏：选中任务的详情（25.6.1「编队 → 选中任务的详情」） —— */
  ctx.renderRail((rail) => {
    const selected = state.get().selectedTaskId;
    const tree = selectedTree;

    const stepRows = tree?.steps?.length
      ? tree.steps.map((step) => {
        const info = STEP_STATUS[step.status] || { glyph: '○', label: step.status || '—' };
        const seconds = step.duration_s;
        return el('div', { cls: 'vw-rail-step', children: [
          el('span', { cls: 'vw-tree-glyph', text: info.glyph }),
          el('span', { cls: 'vw-rail-step-name', title: step.name || step.kind, text: step.name || step.kind || '（未命名步骤）' }),
          el('span', { cls: 'vw-rail-step-status', text: info.label }),
          el('span', { cls: 'vw-tree-duration', text: seconds == null ? '—' : formatDuration(seconds * 1000) }),
        ] });
      })
      : [el('p', { cls: 'vw-rail-empty', text: selected ? '这个任务还没有步骤。' : '选中任务后显示每一步的状态与耗时。' })];

    rail.replaceChildren(
      section('选中任务', selected ? '已选' : '未选', [
        selected
          ? kv([
            ['任务', selected],
            ['状态', TASK_STATUS[tree?.root?.status] || tree?.root?.status || '—'],
            ['步骤', tree?.counts ? `${tree.counts.done + (tree.counts.failed || 0)}/${tree.counts.steps}` : '—'],
          ])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中任务。点左边任务树上的一行。' }),
      ]),
      section('步骤', tree?.counts ? `${tree.counts.steps} 步` : null, stepRows),
      section('事件流', null, [
        el('p', { cls: 'vw-rail-empty', text: selected ? '最近几条见中栏。' : '选中任务后显示最近几条。' }),
      ]),
    );
  });

  /* —— 取数 —— */

  /**
   * 唯一的取数入口。
   *
   * 走 `ensure()` 的缓存：切视角回来不重新请求（视-0 的验收项）。
   * 接口还没开时，`ensure()` 会记一次失败并保留旧值；这里把它翻译成
   * 「还没接上」而不是「没有任务」—— 两者对用户意味着完全不同的下一步。
   */
  async function fetchFleet(force = false) {
    const payload = await ensure(
      state,
      'forest',
      BOTD_ENDPOINTS.forest,
      (raw) => raw,
      '编队数据（forest）',
      { force },
    );
    const slot = state.get().cache.forest;

    if (payload === null && slot.state === 'error') {
      fleetState = { unavailable: true, tasks: [], pending: [] };
    } else {
      const list = Array.isArray(payload) ? payload : (payload?.tasks ?? []);
      fleetState = { unavailable: false, tasks: list, pending: payload?.pending ?? [] };
    }
    paintOverview();
    paintTree();
    paintFlow();
    paintInterventions();
  }

  /** 选中一个任务：改 store 的 selection（下钻也只改它，不新开 store）。 */
  async function selectTask(id) {
    if (!id) return;
    state.set({ selectedTaskId: id });
    if (fleetState.unavailable) return;

    const [tree, events] = await Promise.all([
      ensure(state, 'tree', BOTD_ENDPOINTS.tree(id), (raw) => raw, `任务 ${id} 的步骤`),
      ensure(state, 'events', BOTD_ENDPOINTS.events(id), (raw) => raw, `任务 ${id} 的事件`),
    ]);
    selectedTree = tree ? { ...tree, events: Array.isArray(events) ? events : [] } : null;
    paintFlow();
    paintInterventions();
    ctx.repaintRail();
  }

  /* —— 交互 —— */

  treeHost.addEventListener('click', (event) => {
    const row = event.target.closest('[data-task-id]');
    if (!row) return;
    selectTask(row.dataset.taskId);
  });

  treeHost.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-task-id]');
    if (!row) return;
    event.preventDefault();
    selectTask(row.dataset.taskId);
  });

  head.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="refresh"]')) {
      fetchFleet(true);
    }
  });

  actions.addEventListener('click', (event) => {
    const kind = event.target.closest('[data-kind]')?.dataset.kind;
    if (!kind) return;
    // 暂停：先把「将在当前步骤完成后生效」摆到用户眼前，再说结果。
    // 不能等他点了才显示 —— 那之前他已经以为停下来了。
    if (kind === 'pause') {
      pauseNotice.hidden = false;
      // 视-2 只做到「提交请求」；写库要等 botd 的 HTTP 出口（已在广播板问 A 线）。
      if (fleetState.unavailable) {
        pauseNotice.dataset.tone = 'warn';
        pauseNotice.textContent = `${PAUSE_NOTICE}（接口还没接上，这条请求没有发出去）`;
      }
      return;
    }
    // 改参重试与接管该步各需一个对话框（改什么参数 / 接管哪一步），
    // 那里要真实的后端支持才做得对，所以先不假装成功。
    pauseNotice.hidden = false;
    pauseNotice.dataset.tone = 'warn';
    pauseNotice.textContent = kind === 'retry'
      ? '改参重试要先选一个失败的步骤并写明改了什么（等接口接上）。'
      : '接管该步需要审批结论（等接口接上）。';
  });

  /* —— 订阅：选中任务变了，右栏跟着变 —— */
  const unsubscribe = state.subscribe((next, changed) => {
    if (!changed.has('selectedTaskId')) return;
    if (next.selectedTaskId && next.selectedTaskId !== selectedTree?.root?.task_id) {
      // 由深链或其他视角改了选中项：同步取这一棵。
      selectTask(next.selectedTaskId);
    } else {
      ctx.repaintRail();
    }
  });

  fetchFleet();
  paintInterventions();

  return () => unsubscribe();
}
