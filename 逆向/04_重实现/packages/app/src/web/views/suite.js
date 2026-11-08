/**
 * 套件视角 —— 视-4。
 *
 * ## 改前是什么
 *
 * `/suite` 的 iframe 指向 `/?mode=pro`，也就是**原版首页**。套件台不存在。
 *
 * ## 改后是什么（第 25.12 节 / 附录 C.6）
 *
 * 三栏：
 *
 * ```
 * ┌────────┬────────────────────────────────┬──────────────┐
 * │ 六个   │      中内容（当前应用）         │  右检查器     │
 * │ 应用   │                                │              │
 * └────────┴────────────────────────────────┴──────────────┘
 * ```
 *
 * ## 六个应用 = 五个核心 + Perception
 *
 * 第 18.8 节专门记了一次事故：「把 Manage 的分区标签当成六个应用」。
 * 所以清单写死成六个，且 Perception 要**视觉分隔** —— 它是 `nonCoreApp`，
 * 可能没装。没装时显示「未安装」+ 一个「安装」按钮，不是灰掉不说为什么。
 *
 * ## 检查器（25.12.3 / 25.12.4）
 *
 * 四列：字段名 / 原版位置 / B 侧位置 / 状态。
 *
 * **`matched` 必须「不出眼」**（灰、`·`）。这条很反直觉，理由是：
 * 用户关心的是**对不上的**。一屏 100 个绿的会让 3 个橙淹没掉。
 *
 * 检查器为什么要在用户界面上（而不是只给开发者）：它证明「我们没丢信息」、
 * 能当面验算、截图就是验收证据。可以默认折叠，但不能没有。
 *
 * ## 数据从哪来
 *
 * 对照表是 `tools/suite_field_parity.py` 生成的 `docs/operations/suite-field-parity.md`
 * （38 KB）。**服务端当前不提供它**（`server.ts` 里没有 docs 路由），所以：
 *
 *   · `INSPECTOR_ENDPOINT` 一处可改；
 *   · 拿不到时检查器显示「还没有字段对照表」并说清来源，**不假装全 matched**。
 *
 * 解析函数 `parseParityMarkdown()` 与端点分开，接口一旦返回同一份 markdown 就能直接用；
 * 它也被测试直接验（喂真实文件的前几行）。
 */

import { el, empty, section, kv, button, tag, table, headActions } from './dom.js';

/**
 * 六个应用。顺序即导航顺序。
 *
 * `core: false` 的那一个（Perception）视觉上要分隔（附录 C.6 点一），
 * 且未安装时显示「未安装」而不是假装能点。
 */
export const APPS = [
  { id: 'manage', label: 'Manage', core: true, installed: true, note: '设备 / 状态 / 日志' },
  { id: 'playback', label: 'Playback', core: true, installed: true, note: '回放与导出' },
  { id: 'convert', label: 'Convert', core: true, installed: true, note: '格式转换' },
  { id: 'grit', label: 'GRIT', core: true, installed: true, note: '实时显示' },
  { id: 'graph', label: 'Graph', core: true, installed: true, note: '图与报表' },
  { id: 'perception', label: 'Perception', core: false, installed: false, note: '非核心' },
];

/** 五个核心应用。测试按它断言「六个 = 五个核心 + Perception」。 */
export const CORE_APPS = APPS.filter((app) => app.core);

/**
 * 检查器的三种状态。
 *
 * 第 25.12.3 节把配色说得很具体，而且给了一条反直觉的要求：
 * **`matched` 要灰（不出眼）**。理由是用户关心的是**对不上的** ——
 * 一屏 100 个绿会让 3 个橙淹没掉。所以 `matched` 用 `·` + 灰，
 * `b_only` 用 `+` + 蓝，`a_only` 用 `−` + 橙。
 */
export const FIELD_STATES = {
  matched: { glyph: '·', label: 'matched', tone: 'quiet' },
  b_only: { glyph: '+', label: 'b_only', tone: 'add' },
  a_only: { glyph: '−', label: 'a_only', tone: 'miss' },
  unverified: { glyph: '?', label: 'unverified', tone: 'quiet' },
};

/** 字段对照表的来源。服务端当前不提供，接口定了只改这一处。 */
export const INSPECTOR_ENDPOINT = '/api/suite/field-parity';

/**
 * 解析 `suite-field-parity.md`。
 *
 * 只认两样东西：
 *   1. 结论区那张表（`| 总数 | 131 | ... |` 这类），取四个计数；
 *   2. 对照表的数据行（`| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |`）。
 *
 * 为什么不去解析整份文档：检查器只要「四列 + 三个统计」，其余是给人读的论述。
 * 解析得越少，产物格式一变就越不容易崩。
 */
export function parseParityMarkdown(markdown) {
  const text = String(markdown || '');
  const rows = [];
  const summary = { matched: 0, b_only: 0, a_only: 0, unverified: 0, total: 0 };

  const lines = text.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // 对照表的表头：`| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |`
    if (/^\|\s*字段\s*\|/.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      // 分隔行 `| --- | --- |` 跳过。
      if (/^\|\s*-{3,}/.test(trimmed)) continue;
      if (!trimmed.startsWith('|')) { inTable = false; continue; }

      const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 5) continue;
      const [name, page, bPos, aPos, verdict] = cells;
      const clean = verdict.replace(/[`*]/g, '');
      if (!(clean in FIELD_STATES)) continue;
      rows.push({
        name: name.replace(/[`*]/g, ''),
        page,
        b: bPos === '—' || bPos === '-' ? '' : bPos.replace(/`/g, ''),
        a: aPos === '—' || aPos === '-' ? '' : aPos.replace(/`/g, ''),
        verdict: clean,
      });
      continue;
    }

    // 结论区：`| \`matched\` | 52 | 62 |` 这种。取**去重字段**那一列（判分口径）。
    const summaryMatch = /^\|\s*`?(matched|b_only|a_only|unverified)`?[^|]*\|\s*\**(\d+)\**\s*\|/.exec(trimmed);
    if (summaryMatch) {
      summary[summaryMatch[1]] = Number(summaryMatch[2]);
    }
  }

  for (const row of rows) summary[row.verdict] = Math.max(summary[row.verdict], 0);
  summary.total = summary.matched + summary.b_only + summary.a_only + summary.unverified;
  return { rows, summary };
}

export function mount(ctx) {
  const { main, head, state } = ctx;

  /** 检查器数据：`null` 表示还没拿到。 */
  let inspector = null;
  let inspectorError = null;

  /* —— 页头：视角名 + 当前应用 + 操作（附录 C.7「套件 → 当前应用」） —— */
  const currentAppLabel = el('span', { cls: 'vw-sec-meta', data: { currentApp: '' }, text: 'Manage' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '套件' }),
    el('div', { cls: 'vw-view-context', children: [currentAppLabel] }),
    headActions([
      button('刷新', { variant: 'quiet', data: { action: 'refresh' } }),
      button('嵌入原版', { variant: 'quiet', data: { action: 'embed' } }),
    ]),
  );

  /* —— 左栏：六个应用 —— */
  const appList = el('nav', { cls: 'vw-app-list', attr: { 'aria-label': '套件应用' } });

  function paintApps() {
    const selected = state.get().selectedAppId;
    appList.replaceChildren();
    let sawNonCore = false;
    for (const app of APPS) {
      // Perception 之前插一条分隔线：它是 nonCoreApp，可能没装（附录 C.6 点一）。
      if (!app.core && !sawNonCore) {
        sawNonCore = true;
        appList.append(el('div', { cls: 'vw-app-sep', attr: { role: 'separator' } }));
      }
      const isCurrent = app.id === selected;
      const item = el('button', {
        cls: `vw-app-item${isCurrent ? ' vw-app-item-current' : ''}${app.core ? '' : ' vw-app-item-noncore'}`,
        attr: {
          type: 'button',
          'aria-pressed': String(isCurrent),
          disabled: !app.installed,
          title: app.installed ? app.note : '未安装',
        },
        data: { appId: app.id },
        children: [
          el('span', { cls: 'vw-app-glyph', attr: { 'aria-hidden': 'true' }, text: '▣' }),
          el('span', { cls: 'vw-app-label', text: app.label }),
        ],
      });
      if (!app.installed) {
        // 未装必须说出来，并且给下一步动作 —— 灰掉但不说为什么是最差的做法。
        item.append(el('span', { cls: 'vw-app-missing', text: '未安装' }));
      }
      appList.append(item);
      // 未装的应用在它自己那一行下面给「安装」，而不是把整行做成死按钮。
      if (!app.installed) {
        appList.append(el('button', {
          cls: 'vw-app-install',
          attr: { type: 'button' },
          data: { action: 'install', appId: app.id },
          text: `安装 ${app.label}`,
        }));
      }
    }
  }
  paintApps();

  /* —— 中栏：当前应用的内容 —— */
  const appHost = el('div', { cls: 'vw-app-body', data: { appBody: '' } });

  /**
   * 每个应用的三块内容。
   *
   * 附录 C.6 点二：「这三块应该和原版一致」（那是设-1 的验收）。
   * 这里只画结构与空态 —— 真实数据要 `packages/view` 的原版片段或
   * `panels/*.js` 的数据通道，那些不在本条的范围内。
   */
  const APP_BLOCKS = {
    manage: [
      { title: '设备', body: () => empty('还没有设备列表。', '连上接收机后，这里按在线 / 离线列出。') },
      { title: '状态', body: () => kv([['端口', '—'], ['波特率', '—'], ['跟踪', '—']]) },
      { title: '日志', body: () => el('p', { cls: 'vw-rail-empty', text: '连上接收机后，这里显示最近几条 INFO / WARN。' }) },
    ],
    playback: [
      { title: '记录', body: () => empty('还没有可回放的记录。', '在 Manage 里收到数据后，这里能按时间轴回放。') },
      { title: '时间轴', body: () => kv([['起点', '—'], ['终点', '—'], ['帧数', '—']]) },
      { title: '导出', body: () => el('p', { cls: 'vw-rail-empty', text: '选定区间后可以导出帧。' }) },
    ],
    convert: [
      { title: '输入', body: () => empty('还没有选抓包。', '选一份抓包后，这里显示格式与记录数。') },
      { title: '输出设置', body: () => kv([['格式', '—'], ['时间区间', '—'], ['采样率', '—']]) },
      { title: '结果', body: () => el('p', { cls: 'vw-rail-empty', text: '转换完成后这里给行数与产物路径。' }) },
    ],
    grit: [
      { title: '位置概览', body: () => empty('还没有定位数据。', '收到 BESTPOS 后这里显示位置与卫星数。') },
      { title: '频谱', body: () => kv([['中心频率', '—'], ['带宽', '—'], ['信噪比', '—']]) },
      { title: '地图', body: () => el('p', { cls: 'vw-rail-empty', text: '有定位点后在这里画轨迹。' }) },
    ],
    graph: [
      { title: '最近工程', body: () => empty('还没有图工程。', '从抓包新建一个工程后，这里按时间列出。') },
      { title: '图表', body: () => kv([['图表数', '—'], ['时间范围', '—'], ['数据行', '—']]) },
      { title: '导出', body: () => el('p', { cls: 'vw-rail-empty', text: '可以导出 CSV / KML / PDF。' }) },
    ],
    perception: [
      { title: '说明', body: () => empty('Perception 是非核心应用。', '它不在五个核心应用里，可以单独安装。') },
    ],
  };

  function paintAppBody() {
    const selected = state.get().selectedAppId;
    const app = APPS.find((entry) => entry.id === selected) ?? APPS[0];
    currentAppLabel.textContent = app.label;

    if (!app.installed) {
      appHost.replaceChildren(empty(
        `${app.label} 未安装。`,
        '它是非核心应用（nonCoreApp），可以单独装。装好之后这一栏会显示它的实际界面。',
        button(`安装 ${app.label}`, { variant: 'primary', data: { action: 'install', appId: app.id } }),
      ));
      return;
    }

    const blocks = APP_BLOCKS[app.id] ?? APP_BLOCKS.manage;
    appHost.replaceChildren(el('div', { cls: 'vw-app-panels' }, blocks.map((block) => section(
      block.title,
      null,
      [block.body()],
    ))));
  }
  paintAppBody();

  /* —— 中栏底部：三个按钮（附录 C.6 点四） —— */
  const appActions = el('div', { cls: 'vw-app-actions', children: [
    // 「建任务」就是视-6 的反向深链（跳到编队并预填）。
    button('建任务', { variant: 'primary', data: { action: 'new-task' } }),
    button('刷新', { data: { action: 'refresh' } }),
    button('嵌入原版', { data: { action: 'embed' } }),
  ] });

  main.append(
    el('div', { cls: 'vw-suite', children: [
      appList,
      el('div', { cls: 'vw-suite-main', children: [appHost, appActions] }),
    ] }),
  );

  /* —— 右栏：检查器（第 25.12.3 节四列） —— */
  ctx.renderRail((rail) => {
    const header = section('检查器', '字段对照', [
      inspector && inspector.rows.length
        ? el('div', { cls: 'vw-inspector-wrap', children: [
          table(
            [{ label: '字段' }, { label: '原版' }, { label: 'B 侧' }, { label: '状态' }],
            inspector.rows.slice(0, 200).map((row) => {
              const stateInfo = FIELD_STATES[row.verdict];
              return [
                el('span', { cls: 'vw-field-name', title: `${row.page} · ${row.name}`, text: row.name }),
                // 位置列：等宽小字，能逐字读。没有就 `—`（那一侧本来没有这个字段）。
                el('span', { cls: 'vw-path', title: row.a || '', text: shortPath(row.a) }),
                el('span', { cls: 'vw-path', title: row.b || '', text: shortPath(row.b) }),
                tag(`${stateInfo.glyph} ${stateInfo.label}`, stateInfo.tone),
              ];
            }),
          ),
        ] })
        : el('p', {
          cls: 'vw-rail-empty',
          text: inspectorError
            ? `还没有字段对照表。${inspectorError}`
            : '字段对照表由 tools/suite_field_parity.py 生成到 docs/operations/suite-field-parity.md；'
              + '服务端还没提供它，所以这里先空着 —— 不假装全 matched。',
        }),
    ]);

    const stats = section('统计', null, [
      kv([
        ['matched', inspector ? String(inspector.summary.matched) : '—'],
        ['b_only', inspector ? String(inspector.summary.b_only) : '—'],
        ['a_only', inspector ? String(inspector.summary.a_only) : '—'],
      ]),
      // 让用户一眼看到「这一页对不对得上」（附录 C.6 点五）。
      inspector && inspector.summary.total
        ? el('p', {
          cls: inspector.summary.b_only + inspector.summary.a_only === 0 ? 'vw-ok-note' : 'vw-warn',
          text: inspector.summary.b_only + inspector.summary.a_only === 0
            ? `${inspector.summary.total}/${inspector.summary.total} 对得上`
            : `对不上 ${inspector.summary.b_only + inspector.summary.a_only} 条（${inspector.summary.b_only} B 独占 / ${inspector.summary.a_only} A 独占）`,
        })
        : null,
      el('p', { cls: 'vw-rail-empty', text: 'matched 显示为灰 —— 用户关心的是对不上的那几条。' }),
    ]);

    rail.replaceChildren(header, stats);
  });

  /**
   * 位置路径缩到能读的最短形式。
   *
   * 右栏 280px 放四列，完整路径会把每列挤成「一个字一行」——实测就是这样，
   * 完全不可读。所以只留「文件名:行号」，全路径进 `title`（悬停可看、可复制）。
   * 这也符合检查器的用途：用户要判断「两侧是不是同一个地方」，不是要读完整路径。
   */
  function shortPath(value) {
    if (!value) return '—';
    const match = /([^\\/]+:\d+)$/.exec(value);
    return match ? match[1] : value.split(/[\\/]/).filter(Boolean).slice(-1)[0] || value;
  }

  /* —— 检查器取数 —— */

  async function fetchInspector(force = false) {
    try {
      const response = await fetch(INSPECTOR_ENDPOINT, {
        headers: { Accept: 'text/markdown, text/plain' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const markdown = await response.text();
      inspector = parseParityMarkdown(markdown);
      inspectorError = null;
    } catch (error) {
      inspector = null;
      inspectorError = `接口 ${INSPECTOR_ENDPOINT} 返回 ${error && error.message ? error.message : '失败'}。`;
    }
    ctx.repaintRail();
  }

  /* —— 交互 —— */

  appList.addEventListener('click', (event) => {
    const install = event.target.closest('[data-action="install"]');
    if (install) {
      // 安装要走 RPA / 原版安装器，不在界面里假装。
      state.set({ selectedAppId: install.dataset.appId });
      return;
    }
    const item = event.target.closest('[data-app-id]');
    if (!item || item.disabled) return;
    state.set({ selectedAppId: item.dataset.appId });
  });

  const handleAction = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'new-task') {
      // 反向深链（视-6）：把当前设备带到编队台，交给它预填。
      // 只改 selection，不新开 store —— 与「下钻」同一条原则。
      const device = state.get().selectedDeviceId;
      const app = APPS.find((entry) => entry.id === state.get().selectedAppId);
      state.set({
        selectedTaskDraft: {
          title: device ? `${app?.label || '套件'} · ${device}` : '从套件台建任务',
          device: device || '',
          app: app?.id || '',
        },
      });
      ctx.go('/fleet');
    }
    if (action === 'refresh') {
      paintAppBody();
      fetchInspector(true);
    }
  };

  head.addEventListener('click', handleAction);
  appActions.addEventListener('click', handleAction);

  const unsubscribe = state.subscribe((next, changed) => {
    if (!changed.has('selectedAppId')) return;
    paintApps();
    paintAppBody();
    ctx.repaintRail();
  });

  fetchInspector();

  return () => unsubscribe();
}
