/**
 * 编队视角 —— 视-2：照 DBOS 官方「工作流执行视图」的结构重做。
 *
 * ## 为什么是这个结构
 *
 * DBOS 的执行视图是三栏，它解决的问题是**「现在跑到哪、卡在哪」**：
 *
 * ```
 * ┌──────────────┬────────────────────────────┬──────────────────┐
 * │ 工作流列表   │ 步骤时间线                 │ 选中项详情       │
 * │ 名字         │ step 名 / 状态 / 耗时      │ 完整输入输出 JSON│
 * │ 状态徽章     │ 输入输出可展开             │ 错误信息         │
 * │ 开始时间     │                            │ 重试次数         │
 * └──────────────┴────────────────────────────┴──────────────────┘
 * ```
 *
 * 映射到本项目：
 *
 * ```
 * ┌──────────────┬────────────────────────────┬──────────────────┐
 * │ bot 列表     │ 任务树 / 步骤时间线        │ 选中 step 详情   │
 * │ 名字         │ 每步：名 / 状态 / 工具     │ 输入输出 + 错误  │
 * │ 状态徽章     │ 耗时 + 可展开输入输出      │ 重试次数         │
 * │ 当前任务     │                            │ 事件流           │
 * └──────────────┴────────────────────────────┴──────────────────┘
 *                                   干预区（底部，横跨中栏）
 * ```
 *
 * 右栏没有自己画：外壳已经有右栏（`ctx.renderRail`），再画一栏就成了四栏，
 * 而 1280 像素放不下。所以「右侧详情」落到外壳的右栏里，这是同一个三栏结构。
 *
 * ## 数据从哪来
 *
 * 五个端点，全部集中在 `BOTD_ENDPOINTS`：
 *
 * | 端点 | 形状 |
 * |---|---|
 * | `GET  /api/botd/forest`   | `{bots:[{bot_id,name,status,current_task_id,task_count}]}` |
 * | `GET  /api/botd/tree`     | `{task_id,status,steps:[{step_id,name,status,elapsed_ms,tool,input,output,attempts}]}` |
 * | `GET  /api/botd/events`   | `{events:[{seq,kind,call_id,tool,ts}]}` |
 * | `GET  /api/botd/pending`  | `{pending:[{intervention_id,task_id,kind,status}]}` |
 * | `POST /api/botd/intervene`| body `{task_id,kind,note}` → `{ok,intervention_id,status}` |
 *
 * **接口拿不到就写「拿不到 + 为什么 + 重试」**，不写「没有任务」。这两件事对用户
 * 意味着完全不同的下一步：一个是「去建一个」，一个是「等接口 / 再看一眼日志」。
 * 把「拿不到」画成空数据，用户会去建一个本来就有的任务 —— 这是本文件最不能出的错。
 *
 * ## 自动刷新
 *
 * 用**轮询**（`POLL_MS`）而不是 SSE。理由是可测：轮询的定时器能被测试替换成手动触发，
 * 于是「刷新真的发生了」「卸载后真的停了」都能断言；SSE 在 Node 里要搭一条流，
 * 测出来的是那条流而不是界面。选一个能测的。
 */

import { el, empty, section, kv, button, headActions } from './dom.js';
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
 * 集中在这里，接口定下来只改这一处。`server.ts` 的这五个路由由另一条线在补，
 * 本文件不碰服务端。
 */
export const BOTD_ENDPOINTS = {
  forest: '/api/botd/forest',
  tree: (id) => `/api/botd/tree?task_id=${encodeURIComponent(id)}`,
  events: (id) => `/api/botd/events?task_id=${encodeURIComponent(id)}`,
  pending: '/api/botd/pending',
  intervene: '/api/botd/intervene',
};

/** 轮询间隔。3 秒：比人的反应慢，比「刷新一下」快，且不会把日志刷爆。 */
export const POLL_MS = 3000;

/**
 * 状态 → 徽章（字形 + 中文 + 色调）。
 *
 * ## 为什么带字形
 *
 * 只靠颜色区分状态，色弱用户看到的是一排一样的灰块。所以每一档都有字形，
 * **颜色只是第二重线索**（这也是 cards.js 里 `✓/✗` 不用颜色的同一条规矩）。
 *
 * | 色调 | 语义 | 用在 |
 * |---|---|---|
 * | `ok`   | 成功结束 | done |
 * | `run`  | 正在动   | running |
 * | `bad`  | 失败     | failed |
 * | `warn` | 等人做事 | waiting_operator |
 * | `idle` | 没在动   | pending / skipped / idle |
 *
 * 步的五态见 `store.py` 的 `STEP_STATUSES`；bot 的三态见 `forest` 的接口约定。
 */
export const STATUS_BADGES = {
  pending: { glyph: '○', label: '待执行', tone: 'idle' },
  running: { glyph: '◆', label: '执行中', tone: 'run' },
  done: { glyph: '✓', label: '完成', tone: 'ok' },
  failed: { glyph: '✕', label: '失败', tone: 'bad' },
  skipped: { glyph: '–', label: '跳过', tone: 'idle' },
  idle: { glyph: '○', label: '空闲', tone: 'idle' },
  waiting_operator: { glyph: '◇', label: '等人批', tone: 'warn' },
};

/**
 * 取一个状态的徽章描述。
 *
 * 不认识的 status 原样显示、按 `idle` 上色 —— **不猜、不归并**。把一个没见过的
 * 状态悄悄画成「待执行」会让人以为任务还在排队，而它可能已经失败了。
 */
export function statusBadge(status) {
  const found = STATUS_BADGES[status];
  if (found) return found;
  return { glyph: '○', label: status ? String(status) : '—', tone: 'idle' };
}

/** 四种干预的中文名。`resume` 只在有暂停请求时可用（见 `interventionAvailability`）。 */
export const INTERVENTION_LABELS = {
  pause: '暂停',
  resume: '继续',
  retry: '改参重试',
  takeover: '接管该步',
};

/**
 * 已结束的步数 = done + failed + **skipped**。
 *
 * 为什么必须有 skipped：`interaction.py::tree()` 的 counts 有五个键，
 * `skipped` 是专门单列出来的。少算它，有一步 skipped 时分子永远追不上分母，
 * 进度条看着卡在 N/N+1 —— 用户会以为任务卡住了，而它其实已经跑完。
 *
 * 这类「数字差一」的错最难发现：没有报错、没有空白，只有一个永远走不完的进度。
 */
function finishedSteps(counts) {
  if (!counts) return 0;
  return (counts.done || 0) + (counts.failed || 0) + (counts.skipped || 0);
}

/**
 * 把 `tree` 的响应整理成界面要的形状。
 *
 * 接口给 `{task_id, status, steps}`，**不给 counts**。但进度分子要 `done+failed+skipped`，
 * 而 skipped 必须单列（少算它进度永远差一格）。所以这里自己数一遍，把五个键补齐，
 * 让「进度」只有一个来源 —— 界面各处不再各数各的。
 */
export function normalizeTree(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const counts = { steps: steps.length, done: 0, failed: 0, skipped: 0, pending: 0 };
  for (const step of steps) {
    const status = step && typeof step === 'object' ? step.status : null;
    if (status === 'done') counts.done += 1;
    else if (status === 'failed') counts.failed += 1;
    else if (status === 'skipped') counts.skipped += 1;
    else counts.pending += 1;
  }
  return {
    task_id: typeof raw.task_id === 'string' ? raw.task_id : '',
    status: typeof raw.status === 'string' ? raw.status : 'pending',
    steps,
    counts,
  };
}

/**
 * 概览的四个数字，以及「哪些数是真知道的」。
 *
 * `forest()` 的返回只有 bot 级状态（running / idle / waiting_operator），
 * 没有任务级的 done / failed，也没有 `skipped` —— 那是 `tree()` 的 counts 才有的键。
 * 所以 `known` 跟着一起返回：
 *
 *   · bot 自己的状态里有 done / failed → 那一档是知道的；
 *   · 接口以后带上 `tasks` 数组 → 任务级口径可用；
 *   · 两者都没有 → 那一档是 `—`，**不填 0**。
 *
 * 填 0 是最容易犯的错：用户会以为「一个都没失败」，而其实是「不知道」。
 */
export function overviewCounts(model) {
  const counts = { running: 0, awaiting: 0, done: 0, failed: 0 };
  const known = { running: true, awaiting: true, done: false, failed: false };
  const bots = Array.isArray(model?.bots) ? model.bots : [];

  for (const bot of bots) {
    const status = bot && typeof bot === 'object' ? bot.status : null;
    if (status === 'running') counts.running += 1;
    else if (status === 'waiting_operator') counts.awaiting += 1;
    else if (status === 'done') { counts.done += 1; known.done = true; }
    else if (status === 'failed') { counts.failed += 1; known.failed = true; }
  }

  // pending 是「等人批」的第二条证据：bot 还没来得及转 waiting_operator 时，
  // 干预表里已经有 pending 行了。取两者的较大值，是为了**不把同一件事数两遍**。
  counts.awaiting = Math.max(counts.awaiting, Array.isArray(model?.pending) ? model.pending.length : 0);

  if (Array.isArray(model?.tasks) && model.tasks.length) {
    known.done = true;
    known.failed = true;
  }
  return { counts, known };
}

/**
 * 干预请求体。**形状就是接口约定，不要加字段。**
 *
 * 后端按 `{task_id, kind, note}` 落库；多带一个字段不会报错，但会让人以为
 * 「界面传了 step_id，所以按步干预」—— 而实际只按任务干预。少带一个字段则直接 400。
 * 所以这里只允许这三个键，且 `note` 一定有值（缺省空串，不是 undefined）。
 */
export function interveneBody(taskIdValue, kind, note = '') {
  return {
    task_id: String(taskIdValue ?? ''),
    kind: String(kind ?? ''),
    note: String(note ?? ''),
  };
}

/**
 * 四个干预按钮什么时候可用（25.10.4 的规则，加上 `resume`）。
 *
 * | 按钮 | 什么时候可用 |
 * |---|---|
 * | 暂停 | 任务在跑，或某步在跑 |
 * | 继续 | 这个任务有一条待生效的 pause |
 * | 改参重试 | 有步骤失败 |
 * | 接管该步 | 有步骤正在跑或失败 |
 *
 * 不可用时置灰**并给出理由** —— 灰掉不说为什么，用户会以为界面坏了。
 */
export function interventionAvailability(tree, pending = []) {
  if (!tree) {
    const why = '还没有选中任务';
    return {
      pause: { enabled: false, why },
      resume: { enabled: false, why },
      retry: { enabled: false, why },
      takeover: { enabled: false, why },
    };
  }
  const steps = tree.steps || [];
  const anyRunning = steps.some((step) => step.status === 'running');
  const anyFailed = steps.some((step) => step.status === 'failed');
  const taskRunning = tree.status === 'running';
  const anyPauseRequested = (Array.isArray(pending) ? pending : []).some(
    (row) => String(row?.task_id ?? '') === String(tree.task_id ?? '') && row?.kind === 'pause',
  );

  return {
    pause: {
      enabled: taskRunning || anyRunning,
      why: taskRunning || anyRunning ? '' : '这个任务没有在跑的步骤',
    },
    resume: {
      enabled: anyPauseRequested,
      why: anyPauseRequested ? '' : '这个任务没有待生效的暂停请求',
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

/** 把任意值转成能读的 JSON 文本。`undefined` 与 `null` 都说清「没有」，不印 `{}`。 */
export function readJson(value) {
  if (value === undefined || value === null) return '（没有）';
  try {
    return JSON.stringify(value, null, 2) ?? '（没有）';
  } catch {
    // 循环引用不该出现（数据来自 JSON.parse），但真出现时也不能让整块挂掉。
    return '（这个值无法序列化）';
  }
}

/**
 * forest 里可能带一份顶层任务列表（`tasks`）。主键一律走 `state.js` 的 `taskId()`：
 * A 线 Bot-7 把 `task.id` 改名成 `task.task_id`，这里**不留兼容分支** ——
 * 兼容分支会让「字段没对上」静默降级成「看起来能用」。
 */
function topLevelTasksOf(raw) {
  const out = [];
  const list = Array.isArray(raw?.tasks) ? raw.tasks : [];
  for (const item of list) {
    const task = item && typeof item === 'object' ? (item.task ?? item) : null;
    const id = taskId(task);
    if (!id) continue;
    out.push({ ...item, task, task_id: id });
  }
  return out;
}

export function mount(ctx) {
  const { main, head, state } = ctx;

  /**
   * 界面状态。
   *
   * `state` 与 `unavailable` 是两件事，必须分开：
   *   · `state: 'idle' | 'loading' | 'ready' | 'error'` —— 取到哪一步了；
   *   · `unavailable` —— 「拿不到」这一种，决定空态写什么。
   * 合成一个布尔值就没法区分「正在取」「取失败了」「确实没有」。
   */
  let fleetState = {
    state: 'idle',
    unavailable: false,
    bots: [],
    tasks: [],
    pending: [],
    reason: '',
  };
  let selectedTree = null;
  let eventsState = { events: [], unavailable: false, reason: '' };
  let selectedStepId = '';
  /** 展开了输入输出的步（step_id）。折叠是默认 —— 一屏全是 JSON 就看不到时间线了。 */
  const expanded = new Set();

  /** 只有这一处用 `if (fleetState.unavailable)` 的**直接判断**，其余走它。 */
  const isUnavailable = () => fleetState.unavailable;

  /** 把 cache 里记下的失败翻成人话，作为「为什么」。 */
  function failureText(slot) {
    const failure = state.get().cache?.[slot]?.error;
    if (!failure) return '';
    return `${failure.code}：${failure.hint}`;
  }

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
    const { counts, known } = overviewCounts(fleetState);

    overview.replaceChildren(...OVERVIEW_KEYS.map((key, index) => el('span', {
      cls: `vw-overview-item${index > 0 ? ' vw-overview-item-sep' : ''}`,
      data: { overviewKey: key },
      children: [
        el('span', {
          cls: `num vw-overview-value${fleetState.unavailable || !known[key] ? ' vw-dim' : ''}`,
          // 不知道就是 `—`，**不填 0**：0 会被读成「一个都没有」，而那是另一件事。
          text: fleetState.unavailable || !known[key] ? '—' : String(counts[key]),
          title: known[key] ? '' : '接口没给这一档的数据，所以是「不知道」而不是 0',
        }),
        el('span', { cls: 'unit', text: OVERVIEW_LABELS[key] }),
      ],
    })));

    // 「排队很多」时给一行小字（附录 C.4 点一自己标为缺陷：图上没有）。
    const queued = selectedTree?.counts?.pending ?? 0;
    if (queued > 10) {
      overview.append(el('span', { cls: 'unit vw-overview-queued', text: `排队 ${queued}` }));
    }
    // 哪几档是「不知道」，明说一句 —— 四个 `—` 不带解释等于四个空白。
    if (!fleetState.unavailable && (!known.done || !known.failed)) {
      overview.append(el('span', {
        cls: 'unit vw-overview-unknown',
        text: '（完成 / 失败 是任务级口径，forest 现在只给 bot 级状态）',
      }));
    }
  }

  /* —— ② 左栏：bot 列表（DBOS 的「工作流列表」） —— */
  const botHost = el('div', { cls: 'vw-fleet-bots-host', data: { botList: '' } });

  function paintBots() {
    if (isUnavailable()) {
      botHost.replaceChildren(empty(
        '编队列表还拿不到数据。',
        `森林接口（forest）没有回应。${failureText('forest')}`.trim(),
        button('重试', { variant: 'primary', data: { action: 'retry-fleet' } }),
      ));
      return;
    }
    if (fleetState.state === 'idle' || fleetState.state === 'loading') {
      botHost.replaceChildren(el('p', { cls: 'vw-rail-empty', text: '正在取编队数据…' }));
      return;
    }
    if (!fleetState.bots.length) {
      botHost.replaceChildren(empty('还没有 bot。', 'bot 由 botd 拉起；这个列表是 forest 给的，空就是真的空。'));
      return;
    }

    const head_ = el('div', { cls: 'vw-bot-row vw-bot-row-head', children: [
      el('span', { text: '' }),
      el('span', { text: 'bot' }),
      el('span', { text: '状态' }),
    ] });

    const rows = fleetState.bots.map((bot) => {
      const id = String(bot?.bot_id ?? '');
      const badge = statusBadge(bot?.status);
      const current = String(bot?.current_task_id ?? '');
      const isCurrent = current && current === state.get().selectedTaskId;
      return el('div', {
        cls: `vw-bot-row${isCurrent ? ' vw-bot-row-current' : ''}`,
        // `currentTaskId` 而不是 `taskId`：`data-task-id` 的语义是「正在看的那个任务」
        // （中栏任务头行用它）。bot 行上的那个是「这个 bot 当前接的任务」，两者不是一回事，
        // 共用一个属性名会让 `[data-task-id]` 的遍历把 bot 行也算成任务行。
        data: { botId: id, currentTaskId: current, status: String(bot?.status ?? '') },
        attr: { role: 'button', tabindex: '0', 'aria-current': isCurrent ? 'true' : null },
        title: current ? `当前任务 ${current}` : '这个 bot 还没有任务',
        children: [
          el('span', { cls: 'vw-tree-glyph', text: badge.glyph }),
          el('span', { cls: 'vw-bot-name', text: String(bot?.name ?? id) }),
          el('span', { cls: 'vw-badge', data: { tone: badge.tone }, text: badge.label }),
        ],
      });
    });

    botHost.replaceChildren(head_, ...rows);
  }

  /* —— ③ 中栏：任务树 / 步骤时间线（DBOS 的「步骤时间线」） —— */
  const treeHost = el('div', { cls: 'vw-fleet-tree', data: { taskTree: '' } });

  /** 选中任务对应的 bot 名字（`tree` 只给 task_id，名字在 forest 里）。 */
  function botNameOf(taskIdValue) {
    const bot = fleetState.bots.find((item) => String(item?.current_task_id ?? '') === String(taskIdValue));
    return bot ? String(bot.name ?? '') : '';
  }

  /**
   * 一个任务该显示多少耗时。
   *
   * 正在跑的用「现在 - 开始」算「已跑多久」（用户最关心的正是这个：第 3 步跑了
   * 5 分钟，正常吗）；跑完的用总耗时。**没有开始时间就 `—`，不猜。**
   *
   * 为什么不退回「各步耗时相加」：那是**步骤时间之和**，不是墙上时间（并行步骤会
   * 重复计、排队等待不进任何一步）。两个数长得一样、含义不同，混着显示等于制造
   * 一个永远对不上账的数字。步骤合计单独写成一句小字，见 `sumStepMs`。
   */
  function taskDurationText(tree) {
    const ms = elapsedMs(tree?.started_at, tree?.finished_at ?? null);
    if (ms === null) return '—';
    return formatDuration(ms);
  }

  /** 各步 `elapsed_ms` 之和。一个都没有返回空串（不显示，也不写 0）。 */
  function sumStepMs(tree) {
    let sum = 0;
    let any = false;
    for (const step of tree?.steps ?? []) {
      const ms = step?.elapsed_ms;
      if (Number.isFinite(ms)) {
        sum += ms;
        any = true;
      }
    }
    return any ? `各步合计 ${formatDuration(sum)}` : '';
  }

  /** 步骤耗时：`elapsed_ms` 缺失就 `—`。 */
  function stepDurationText(step) {
    const ms = step?.elapsed_ms;
    if (!Number.isFinite(ms)) return '—';
    return formatDuration(ms);
  }

  /** 任务头行：名字 / 状态 / 进度 / 耗时（DBOS 里 workflow 那一行）。 */
  function taskHeadRow(tree) {
    const id = String(tree.task_id ?? '');
    const badge = statusBadge(tree.status);
    const counts = tree.counts;
    const finished = finishedSteps(counts);
    const total = counts?.steps ?? 0;
    const name = botNameOf(id) || id;
    return el('div', {
      cls: 'vw-tree-row vw-tree-row-current',
      data: { taskId: id, status: String(tree.status ?? '') },
      children: [
        el('span', { cls: 'vw-tree-glyph', text: badge.glyph }),
        el('span', { cls: 'vw-tree-name', title: id, text: name }),
        el('span', { cls: 'vw-tree-status', text: badge.label }),
        // 进度的分子必须是**已结束**的步数：done + failed + skipped。
        el('span', { cls: 'vw-tree-progress', text: total ? `${finished}/${total}` : '—' }),
        el('span', { cls: 'vw-tree-duration', text: taskDurationText(tree) }),
      ],
    });
  }

  /** 一步：一行摘要 + 一块可展开的输入输出。 */
  function stepNode(step) {
    const stepId = String(step?.step_id ?? '');
    const badge = statusBadge(step?.status);
    const isOpen = expanded.has(stepId);
    const isSelected = stepId && stepId === selectedStepId;
    const tool = String(step?.tool ?? '') || '—';

    const io = el('div', {
      cls: 'vw-step-io',
      data: { stepIo: stepId },
      attr: { hidden: isOpen ? null : '' },
      children: [
        el('div', { cls: 'vw-io-block', children: [
          el('span', { cls: 'vw-io-label', text: '输入' }),
          el('pre', { cls: 'vw-json', text: readJson(step?.input) }),
        ] }),
        el('div', { cls: 'vw-io-block', children: [
          el('span', { cls: 'vw-io-label', text: '输出' }),
          el('pre', { cls: 'vw-json', text: readJson(step?.output) }),
        ] }),
        Number.isFinite(step?.attempts) && step.attempts > 1
          ? el('p', { cls: 'vw-io-retries', text: `重试 ${step.attempts} 次` })
          : null,
      ],
    });

    const row = el('div', {
      cls: `vw-step-row${isSelected ? ' vw-step-row-current' : ''}`,
      data: { stepId, status: String(step?.status ?? '') },
      attr: {
        role: 'button',
        tabindex: '0',
        'aria-expanded': isOpen ? 'true' : 'false',
        'aria-current': isSelected ? 'true' : null,
      },
      children: [
        el('span', { cls: 'vw-tree-glyph', text: badge.glyph }),
        el('span', { cls: 'vw-step-name', title: String(step?.name ?? stepId), text: String(step?.name ?? '') || '（未命名步骤）' }),
        el('span', { cls: 'vw-step-tool', text: tool }),
        el('span', { cls: 'vw-tree-duration', text: stepDurationText(step) }),
        el('span', { cls: 'vw-step-badge', text: badge.label, data: { tone: badge.tone } }),
      ],
    });

    return el('div', { cls: 'vw-step', data: { step: stepId } }, [row, io]);
  }

  function paintTree() {
    if (fleetState.unavailable) {
      // 空态必须给一个能点的动作 —— 只写「等接口」的话用户在这里无事可做，
      // 而他真正能做的往往是「重试一次」（后端刚起来、代理刚通都发生过）。
      treeHost.replaceChildren(empty(
        '任务树还拿不到数据。',
        '编队台要读 botd 的 forest() / tree()，那几个方法已经实现，但还没有 HTTP 出口。'
          + '接口定下来之后这一块会自己填上；现在不是「没有任务」，是「还没接上」。',
        button('重试', { variant: 'primary', data: { action: 'retry-fleet' } }),
      ));
      return;
    }
    if (fleetState.state === 'idle' || fleetState.state === 'loading') {
      treeHost.replaceChildren(el('p', { cls: 'vw-rail-empty', text: '正在取任务树…' }));
      return;
    }
    if (!fleetState.bots.length && !fleetState.tasks.length) {
      // 「还没有任务」的下一步很明确：去对话问一句，或去套件台建任务。
      treeHost.replaceChildren(empty(
        '还没有任务。',
        '在对话里问一句，或在套件台选设备后点「建任务」。任务会出现在这里。',
        el('div', { cls: 'vw-empty-actions' }, [
          button('去问一句', { variant: 'primary', data: { action: 'go-chat' } }),
          button('去套件台', { data: { action: 'go-suite' } }),
        ]),
      ));
      return;
    }
    if (!selectedTree) {
      treeHost.replaceChildren(empty(
        selectedTreeId() ? '这个任务还没有步骤。' : '还没有选中任务。',
        selectedTreeId()
          ? 'tree 接口返回了空 steps —— 任务建了但一步都没排，去对话里看看它为什么没排。'
          : '点左边 bot 列表里的一行；有当前任务的 bot 会直接展开它的步骤。',
      ));
      return;
    }

    // 表头：假想一个空的 18px 列，与任务头行的字形列对齐。
    // 耗时列右对齐、等宽 —— 一列数字的目的就是让人比较大小（视觉规矩一）。
    const head_ = el('div', { cls: 'vw-step-row vw-step-row-head', children: [
      el('span', { text: '' }),
      el('span', { text: '步骤' }),
      el('span', { text: '工具' }),
      el('span', { cls: 'vw-tree-duration', text: '耗时' }),
      el('span', { text: '状态' }),
    ] });

    treeHost.replaceChildren(
      taskHeadRow(selectedTree),
      head_,
      ...(selectedTree.steps || []).map(stepNode),
    );
  }

  /** 当前选中的任务 id：优先看 store（跨视角共享），其次看已取到的树。 */
  function selectedTreeId() {
    const id = state.get().selectedTaskId;
    return typeof id === 'string' && id ? id : '';
  }

  /* —— ④ 事件流（右栏） —— */
  function eventNodes() {
    if (eventsState.unavailable) {
      return [el('p', {
        cls: 'vw-rail-empty',
        text: `事件流还拿不到数据。${eventsState.reason}`.trim(),
      })];
    }
    const events = eventsState.events;
    if (!events.length) {
      return [el('p', { cls: 'vw-rail-empty', text: '还没有事件。选中任务后，这里按时间列出工具调用与干预。' })];
    }
    return events.map((event) => {
      const kind = String(event?.kind ?? '');
      const tool = String(event?.tool ?? '');
      const callId = String(event?.call_id ?? '');
      const seq = event?.seq;
      return el('div', {
        cls: 'vw-flow-row',
        data: { phase: kind, callId },
        children: [
          el('span', { cls: 'vw-flow-time', text: formatClock(event?.ts) }),
          el('span', { cls: 'vw-flow-label', text: [kind, tool].filter(Boolean).join(' · ') || '—' }),
          el('span', { cls: 'vw-flow-seq', text: seq === undefined || seq === null ? '' : `#${seq}` }),
        ],
      });
    });
  }

  /* —— ⑤ 干预区（底部） —— */
  const pauseNotice = el('p', {
    cls: 'vw-pause-notice',
    attr: { hidden: '' },
    data: { pauseNotice: '' },
    text: PAUSE_NOTICE,
  });

  const actionNote = el('p', { cls: 'vw-action-note', attr: { hidden: '' }, data: { actionNote: '' } });

  /**
   * 反向深链的预填提示（视-6）。
   *
   * 从套件台点「建任务」过来时，这里显示「要建什么」，并给一个明确的「建这个任务」按钮。
   * **不自动创建**：跳过来是一次导航，建任务是用户按下去之后的事 ——
   * 混在一起会出现「点了一下就产生了一个没人想要的空任务」。
   */
  const draftNote = el('div', { cls: 'vw-draft', data: { draft: '' }, attr: { hidden: '' } });

  function paintDraft() {
    const draft = state.get().selectedTaskDraft;
    if (!draft) {
      draftNote.hidden = true;
      draftNote.replaceChildren();
      return;
    }
    draftNote.hidden = false;
    draftNote.replaceChildren(
      el('span', { cls: 'vw-draft-label', text: '预填' }),
      el('span', { cls: 'vw-draft-title', text: draft.title || '新任务' }),
      draft.device ? el('span', { cls: 'vw-draft-meta', text: `设备 ${draft.device}` }) : null,
      button('建这个任务', { variant: 'primary', data: { action: 'create-draft' } }),
      button('取消', { variant: 'text', data: { action: 'dismiss-draft' } }),
    );
  }
  paintDraft();

  const pauseButton = button(INTERVENTION_LABELS.pause, { data: { kind: 'pause' } });
  const resumeButton = button(INTERVENTION_LABELS.resume, { data: { kind: 'resume' } });
  const retryButton = button(INTERVENTION_LABELS.retry, { data: { kind: 'retry' } });
  const takeoverButton = button(INTERVENTION_LABELS.takeover, { data: { kind: 'takeover' } });

  /** `retry` 必须说明改了什么（ADR-009 要求记审计）。 */
  const noteInput = el('input', {
    cls: 'vw-note-input',
    attr: { type: 'text', placeholder: '说明改了什么（改参重试必填）' },
    data: { note: '' },
  });

  const pendingHost = el('div', { cls: 'vw-fleet-pending', data: { pendingList: '' } });

  const actions = el('div', { cls: 'vw-fleet-actions', children: [
    pauseButton, resumeButton, retryButton, takeoverButton, noteInput,
  ] });

  function pendingNodes() {
    if (isUnavailable()) {
      return [el('p', {
        cls: 'vw-rail-empty',
        text: `待处理的干预还拿不到数据。${failureText('pending')}`.trim(),
      })];
    }
    if (!fleetState.pending.length) {
      return [el('p', { cls: 'vw-rail-empty', text: '没有待处理的干预请求。' })];
    }
    return fleetState.pending.map((row) => {
      const kind = String(row?.kind ?? '');
      return el('div', {
        cls: 'vw-pending-row',
        // 用 `interventionKind` 而**不是** `kind`：`data-kind` 是干预按钮的语义
        // （「点它会发哪种请求」）。两者共用同一个属性名时，任何 `[data-kind]` 的
        // 遍历都会把这张只读的行也算进去，于是「按钮有几个」永远是错的。
        data: { interventionId: String(row?.intervention_id ?? ''), interventionKind: kind },
        children: [
          el('span', { cls: 'vw-pending-kind', text: INTERVENTION_LABELS[kind] || kind || '—' }),
          el('span', { cls: 'vw-pending-task', text: String(row?.task_id ?? '—') }),
          el('span', { cls: 'vw-badge', data: { tone: 'warn' }, text: String(row?.status ?? '—') }),
        ],
      });
    });
  }

  function paintInterventions() {
    const availability = interventionAvailability(selectedTree, fleetState.pending);
    const map = {
      pause: pauseButton,
      resume: resumeButton,
      retry: retryButton,
      takeover: takeoverButton,
    };
    for (const [kind, buttonEl] of Object.entries(map)) {
      const info = availability[kind];
      buttonEl.disabled = !info.enabled;
      buttonEl.title = info.why || '';
      // 不可用时要能让键盘用户也知道原因。
      buttonEl.setAttribute('aria-disabled', String(!info.enabled));
    }
    pendingHost.replaceChildren(...pendingNodes());
  }

  function showActionNote(text, tone = '') {
    actionNote.hidden = false;
    actionNote.dataset.tone = tone;
    actionNote.textContent = text;
  }

  main.append(el('div', { cls: 'vw-fleet', children: [
    draftNote,
    el('div', { cls: 'vw-fleet-workspace', children: [
      // 左：bot 列表 —— DBOS 的「工作流列表」。
      el('aside', { cls: 'vw-fleet-bots', children: [
        section('编队', '一个 bot 一行', [botHost]),
      ] }),
      // 中：任务树 / 步骤时间线 —— DBOS 的「步骤时间线」。
      el('div', { cls: 'vw-fleet-center', children: [
        section('任务树', '按 idx 排序', [treeHost]),
        section('干预', '暂停 / 继续 / 改参重试 / 接管该步', [
          pendingHost,
          actions,
          pauseNotice,
          actionNote,
        ]),
      ] }),
    ] }),
  ] }));

  /* —— 右栏：选中 step 详情 + 事件流（DBOS 的「选中项详情」） —— */
  function stepDetail(step) {
    const badge = statusBadge(step.status);
    const rows = [
      ['步骤', String(step.name ?? '') || '（未命名步骤）'],
      ['状态', `${badge.glyph} ${badge.label}`],
      ['工具', String(step.tool ?? '') || '—'],
      ['耗时', stepDurationText(step)],
      ['重试次数', Number.isFinite(step.attempts) ? String(step.attempts) : '—'],
    ];
    const blocks = [
      kv(rows),
      el('div', { cls: 'vw-io-block', children: [
        el('span', { cls: 'vw-io-label', text: '输入' }),
        el('pre', { cls: 'vw-json', text: readJson(step.input) }),
      ] }),
      el('div', { cls: 'vw-io-block', children: [
        el('span', { cls: 'vw-io-label', text: '输出' }),
        el('pre', { cls: 'vw-json', text: readJson(step.output) }),
      ] }),
    ];
    // 错误信息：只有真的有错才画这一块，没写 `error` 就不编一条。
    if (step.error) {
      blocks.push(el('div', { cls: 'vw-io-block', children: [
        el('span', { cls: 'vw-io-label', text: '错误' }),
        el('pre', { cls: 'vw-json vw-json-error', text: String(step.error) }),
      ] }));
    }
    return blocks;
  }

  ctx.renderRail((rail) => {
    const selected = state.get().selectedTaskId;
    const tree = selectedTree;
    const step = selectedStep();
    const badge = tree ? statusBadge(tree.status) : null;

    rail.replaceChildren(
      section('选中任务', selected ? '已选' : '未选', [
        selected
          ? kv([
            ['任务', selected],
            ['状态', badge ? badge.label : '—'],
            // 进度的分子必须是**已结束**的步数：done + failed + skipped。
            //
            // 只算 done + failed 会漏掉 skipped —— 而这个漏法很隐蔽：有一步 skipped 时
            // 分子永远追不上分母，进度条看着卡在 N/N+1，用户会以为任务卡住了。
            // `interaction.py::tree()` 的 counts 有五个键，`skipped` 是专门单列出来的
            // （那边注释里也写了「只数三档会让 done+failed+pending != steps」）。
            ['步骤', tree ? `${finishedSteps(tree.counts)}/${tree.counts.steps}` : '—'],
          ])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中任务。点左边 bot 列表里的一行。' }),
      ]),
      section('选中步骤', step ? statusBadge(step.status).label : null, [
        step
          ? el('div', { cls: 'vw-step-detail', data: { stepDetail: String(step.step_id ?? '') } }, stepDetail(step))
          : el('p', {
            cls: 'vw-rail-empty',
            text: selected
              ? '点中间时间线上的一步，这里显示它的输入输出、错误与重试次数。'
              : '选中任务后显示每一步的详情。',
          }),
      ]),
      section('事件流', tree ? `${eventsState.events.length} 条` : null, eventNodes()),
    );
  });

  /** 当前选中的那一步（右栏用）。 */
  function selectedStep() {
    if (!selectedTree || !selectedStepId) return null;
    return (selectedTree.steps || []).find((step) => String(step?.step_id ?? '') === selectedStepId) ?? null;
  }

  /* —— 取数 —— */

  /**
   * 唯一的取数入口。
   *
   * 走 `ensure()` 的缓存：切视角回来不重新请求（视-0 的验收项）。
   * 接口还没开时，`ensure()` 会记一次失败并保留旧值；这里把它翻译成
   * 「还没接上」而不是「没有任务」—— 两者对用户意味着完全不同的下一步。
   */
  async function fetchFleet(force = false) {
    fleetState = { ...fleetState, state: 'loading' };
    paintBots();
    paintTree();

    const forestRaw = await ensure(
      state,
      'forest',
      BOTD_ENDPOINTS.forest,
      (raw) => raw,
      '编队数据（forest）',
      { force },
    );
    const forestSlot = state.get().cache.forest;

    if (forestRaw === null && forestSlot.state === 'error') {
      fleetState = {
        state: 'ready',
        unavailable: true,
        bots: [],
        tasks: [],
        pending: [],
        reason: failureText('forest'),
      };
    } else {
      const raw = forestRaw && typeof forestRaw === 'object' ? forestRaw : {};
      fleetState = {
        state: 'ready',
        unavailable: false,
        bots: Array.isArray(raw.bots) ? raw.bots : [],
        tasks: topLevelTasksOf(raw),
        pending: [],
        reason: '',
      };

      // pending 是「等人批」的第二条证据，与 forest 平行取 —— 它挂了不该把整块拉黑。
      const pendingRaw = await ensure(
        state,
        'pending',
        BOTD_ENDPOINTS.pending,
        (payload) => payload,
        '待处理的干预（pending）',
        { force },
      );
      fleetState.pending = Array.isArray(pendingRaw?.pending) ? pendingRaw.pending : [];
    }

    paintOverview();
    paintBots();
    paintTree();
    paintInterventions();
    ctx.repaintRail();

    // 首屏没有选中项时自动选第一个有当前任务的 bot：中栏不至于一开始就是空的。
    if (!isUnavailable() && !selectedTreeId()) {
      const first = fleetState.bots.find((bot) => String(bot?.current_task_id ?? ''));
      if (first) selectTask(String(first.current_task_id));
    }
  }

  /** 选中一个任务：改 store 的 selection（下钻也只改它，不新开 store）。 */
  async function selectTask(id) {
    if (!id) return;
    state.set({ selectedTaskId: id });
    if (isUnavailable()) return;

    // 树与事件**必须强制取**：缓存按 slot 存，换任务时旧 slot 里放的是上一个任务的树。
    // 不 force 的话，点 B 会看到 A 的步骤 —— 两者都「有数据」，肉眼分不出错。
    const [treeRaw, eventsRaw] = await Promise.all([
      ensure(state, 'tree', BOTD_ENDPOINTS.tree(id), (raw) => raw, `任务 ${id} 的步骤`, { force: true }),
      ensure(state, 'events', BOTD_ENDPOINTS.events(id), (raw) => raw, `任务 ${id} 的事件`, { force: true }),
    ]);

    selectedTree = treeRaw ? normalizeTree(treeRaw) : null;
    selectedStepId = '';
    expanded.clear();

    const eventsFailed = state.get().cache.events.state === 'error';
    eventsState = {
      events: Array.isArray(eventsRaw?.events) ? eventsRaw.events : [],
      unavailable: eventsFailed,
      reason: eventsFailed ? failureText('events') : '',
    };

    paintOverview();
    paintTree();
    paintInterventions();
    ctx.repaintRail();
  }

  /** 选中一个 bot：它就是「这一行工作流」，点它的当前任务。 */
  function selectBot(bot) {
    const id = String(bot?.current_task_id ?? '');
    if (!id) {
      selectedTree = null;
      selectedStepId = '';
      eventsState = { events: [], unavailable: false, reason: '' };
      paintTree();
      paintInterventions();
      ctx.repaintRail();
      showActionNote('这个 bot 还没有当前任务。等它接一个，或去套件台建一个。', 'warn');
      return;
    }
    actionNote.hidden = true;
    selectTask(id);
  }

  /** 点一步：选中它（右栏详情）并展开/收起输入输出。 */
  function selectStep(stepId) {
    if (!stepId) return;
    selectedStepId = stepId;
    if (expanded.has(stepId)) expanded.delete(stepId);
    else expanded.add(stepId);
    paintTree();
    ctx.repaintRail();
  }

  /** 提交一条干预。成功就刷新一遍 —— 界面上「已提交」必须紧接着变成真实状态。 */
  async function sendIntervention(kind) {
    // 主键只认 tree.task_id；没有树才退回 store 里选中的那一项（显式两段，不写兼容分支）。
    let taskIdValue = selectedTree ? String(selectedTree.task_id ?? '') : '';
    if (!taskIdValue) taskIdValue = selectedTreeId();
    if (!taskIdValue) {
      showActionNote('还没有选中任务，干预不知道发给谁。', 'warn');
      return;
    }

    const note = String(noteInput.value ?? '').trim();
    // `retry` 必须说明改了什么：一条没有说明的重试，等于无法解释的输入变更。
    if (kind === 'retry' && !note) {
      showActionNote('改参重试要写明改了什么（填在右边的说明框里）。', 'warn');
      noteInput.focus?.();
      return;
    }

    // 暂停：先把「将在当前步骤完成后生效」摆到用户眼前，再说结果。
    // 不能等他点了才显示 —— 那之前他已经以为停下来了。
    if (kind === 'pause') pauseNotice.hidden = false;

    const body = interveneBody(taskIdValue, kind, note);
    showActionNote(`正在提交「${INTERVENTION_LABELS[kind] || kind}」…`);

    try {
      const response = await fetch(BOTD_ENDPOINTS.intervene, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${BOTD_ENDPOINTS.intervene}`);
      const result = await response.json();

      if (result?.ok === false) {
        // 后端明确说没接受（比如 takeover 缺审批）：照它说的写，不假装成功。
        showActionNote(
          `后端没有接受这次干预（${String(result?.status ?? '未说明')}）。${String(result?.error ?? '')}`.trim(),
          'warn',
        );
        return;
      }

      const id = String(result?.intervention_id ?? '');
      showActionNote(
        `${INTERVENTION_LABELS[kind] || kind}已提交${id ? `（${id}）` : ''}，状态 ${String(result?.status ?? 'pending')}。`
          + (kind === 'pause' ? ` ${PAUSE_NOTICE}` : ''),
      );
      noteInput.value = '';
      // 成功就刷新：用户看到的下一屏必须是数据库里的真实状态，不是我们猜的。
      await fetchFleet(true);
      if (selectedTreeId()) await selectTask(selectedTreeId());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showActionNote(`干预没有发出去：${message}。检查后端是否在跑，然后重试。`, 'bad');
    }
  }

  /* —— 交互 —— */

  botHost.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'retry-fleet') {
      fetchFleet(true);
      return;
    }
    const row = event.target.closest('[data-bot-id]');
    if (!row) return;
    const bot = fleetState.bots.find((item) => String(item?.bot_id ?? '') === row.dataset.botId);
    selectBot(bot);
  });

  botHost.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-bot-id]');
    if (!row) return;
    event.preventDefault();
    const bot = fleetState.bots.find((item) => String(item?.bot_id ?? '') === row.dataset.botId);
    selectBot(bot);
  });

  treeHost.addEventListener('click', (event) => {
    // 空态里的动作按钮：重试 / 去对话 / 去套件台。
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'retry-fleet') {
      fetchFleet(true);
      return;
    }
    if (action === 'go-chat') {
      ctx.go('/chat');
      return;
    }
    if (action === 'go-suite') {
      ctx.go('/suite');
      return;
    }
    const step = event.target.closest('[data-step-id]');
    if (step) {
      selectStep(step.dataset.stepId);
    }
  });

  treeHost.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const step = event.target.closest('[data-step-id]');
    if (!step) return;
    event.preventDefault();
    selectStep(step.dataset.stepId);
  });

  head.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="refresh"]')) {
      fetchFleet(true);
    }
  });

  actions.addEventListener('click', (event) => {
    const kind = event.target.closest('[data-kind]')?.dataset.kind;
    if (!kind) return;
    sendIntervention(kind);
  });

  /* —— 反向深链的预填：建这个任务 / 取消 —— */
  draftNote.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'dismiss-draft') {
      state.set({ selectedTaskDraft: null });
      return;
    }
    if (action === 'create-draft') {
      // 建任务要写 botd 的 task 表（接口还没开）。所以这里**不假装建成**，
      // 而是把「要建什么」留在界面上并说清卡在哪 —— 比造一条假任务强。
      draftNote.dataset.tone = 'warn';
      draftNote.append(el('span', {
        cls: 'vw-draft-meta',
        text: '建任务要写 botd 的 task 表，接口还没接上；草稿先留在这里。',
      }));
    }
  });

  /* —— 自动刷新：轮询 —— */
  let timer = null;

  /**
   * 一次轮询 = 重新取 forest + pending，再重取当前任务的树与事件。
   *
   * 只刷「现在看的这一个」，不把每个任务的树都拉一遍 —— 那样每 3 秒
   * 就是 N+2 个请求，而屏幕上只有一棵树。
   */
  async function pollTick() {
    await fetchFleet(true);
    const id = selectedTreeId();
    if (id && !isUnavailable()) await selectTask(id);
  }

  if (typeof globalThis.setInterval === 'function') {
    timer = globalThis.setInterval(() => { pollTick(); }, POLL_MS);
  }

  /* —— 订阅：选中任务变了，右栏跟着变 —— */
  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedTaskDraft')) paintDraft();
    if (!changed.has('selectedTaskId')) return;
    if (next.selectedTaskId && next.selectedTaskId !== selectedTree?.task_id) {
      // 由深链或其他视角改了选中项：同步取这一棵。
      selectTask(next.selectedTaskId);
    } else {
      ctx.repaintRail();
    }
  });

  fetchFleet();
  paintInterventions();

  return () => {
    unsubscribe();
    if (timer !== null && typeof globalThis.clearInterval === 'function') {
      globalThis.clearInterval(timer);
      timer = null;
    }
  };
}
