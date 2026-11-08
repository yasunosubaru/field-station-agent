/**
 * 套件视角 —— 视-0 建三栏骨架，视-4 填六个应用与检查器。
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
 * 所以清单必须写死成六个，且 Perception 要**视觉分隔** —— 它是 `nonCoreApp`，
 * 可能没装。没装时显示「未安装 · [安装]」，不是灰掉不说为什么。
 *
 * ## 本阶段做对了什么
 *
 * 三栏结构、六个应用、Perception 的分隔与未安装态、检查器的四列与 matched 不出眼。
 * 中内容（每个应用的实际界面）与真实字段对照表在视-4 接。
 */

import { el, empty, section, kv, table, button, tag, headActions } from './dom.js';

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
 * 一屏 100 个绿的会让 3 个橙淹没掉。所以这里 `matched` 用 `·` + 灰，
 * `b_only` 用 `+` + 蓝，`a_only` 用 `−` + 橙。
 */
export const FIELD_STATES = {
  matched: { glyph: '·', label: 'matched', tone: 'quiet' },
  b_only: { glyph: '+', label: 'b_only', tone: 'add' },
  a_only: { glyph: '−', label: 'a_only', tone: 'miss' },
};

export function mount(ctx) {
  const { main, head, state } = ctx;

  /* —— 页头：视角名 + 当前应用 + 操作 —— */
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
    }
  }
  paintApps();

  /* —— 中栏：当前应用的内容 —— */
  const appHost = el('div', { cls: 'vw-app-body', data: { appBody: '' } });

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

    // 已装的应用：三个块（设备 / 状态 / 日志），与原版一致 —— 那是设-1 的验收口径。
    // 视-0 只画骨架与占位，真实数据在视-4 接。
    appHost.replaceChildren(el('div', { cls: 'vw-app-panels', children: [
      section('设备', null, [
        empty('还没有设备列表。', '连上接收机后，这里按在线 / 离线列出。'),
      ]),
      section('状态', null, [
        kv([
          ['端口', '—'],
          ['波特率', '—'],
          ['跟踪', '—'],
        ]),
      ]),
      section('日志', null, [
        el('p', { cls: 'vw-rail-empty', text: '连上接收机后，这里显示最近几条 INFO / WARN。' }),
      ]),
    ] }));
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
    el('div', { cls: 'vw-suite', children: [appList, el('div', { cls: 'vw-suite-main', children: [appHost, appActions] })] }),
  );

  /* —— 右栏：检查器（第 25.12.3 节四列） —— */
  ctx.renderRail((rail) => {
    // 检查器四列：字段名 / 原版位置 / B 侧位置 / 状态。
    // 现在还没有对照表（视-4 生成），所以给一个说清真话的空态 —— 不假装全 matched。
    const rows = [];
    rail.replaceChildren(
      section('检查器', '字段对照', [
        rows.length
          ? table(
            [{ label: '字段' }, { label: '原版' }, { label: 'B 侧' }, { label: '状态' }],
            rows,
          )
          : el('p', { cls: 'vw-rail-empty', text: '还没有字段对照表。视-4 接上之后，每个字段一条：原版位置 / B 侧位置 / 状态。' }),
      ]),
      section('统计', null, [
        // 检查器底部统计（附录 C.6 点五）：让用户一眼看到「这一页对不对得上」。
        kv([
          ['matched', '—'],
          ['b_only', '—'],
          ['a_only', '—'],
        ]),
        el('p', { cls: 'vw-rail-empty', text: 'matched 显示为灰 —— 用户关心的是对不上的那几条。' }),
      ]),
    );
  });

  /* —— 交互 —— */
  appList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-app-id]');
    if (!item || item.disabled) return;
    state.set({ selectedAppId: item.dataset.appId });
  });

  const unsubscribe = state.subscribe((next, changed) => {
    if (!changed.has('selectedAppId')) return;
    paintApps();
    paintAppBody();
    ctx.repaintRail();
  });

  return () => unsubscribe();
}
