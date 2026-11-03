/**
 * Agent 工作台 —— 装配层。
 *
 * 左栏会话 / 中栏对话 / 右栏上下文，全部靠 `ctx` 之外的 /api/agent/* 拿数据；
 * 事件流按契约 §2 折成卡片（model.js），卡片 DOM 在 cards.js，输入区在 composer.js。
 * 这里只负责状态与副作用：选会话、发消息、审批、切面板、快捷键、离线态。
 */

import { artifactUrl, createApi, isOffline } from './api.js';
import {
  COMMANDS,
  SUGGESTIONS,
  applyEvent,
  buildCards,
  collectArtifacts,
  deriveSessionTitle,
  describeHealth,
  formatDuration,
  recentTools,
  relativeTime,
  sessionTitle,
  sortSessions,
  statusLabel,
} from './model.js';
import { renderCard, iconSvg } from './cards.js';
import { createComposer } from './composer.js';
import { openSettings } from './settings.js';

const STORE = {
  session: 'fsa-agent-session',
  theme: 'fsa-agent-theme',
  aliases: 'fsa-agent-aliases',
  hidden: 'fsa-agent-hidden',
  filter: 'fsa-agent-filter',
};

function readStore(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    /* 隐私模式：记不住就只影响下次打开 */
  }
}

function readJson(key, fallback) {
  const raw = readStore(key, null);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    writeStore(key, JSON.stringify(value));
  } catch {
    /* 循环引用不会出现，这里只是兜底 */
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'html') node.innerHTML = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/* ================================================================
   骨架
   ================================================================ */

const SKELETON = `
  <div class="ag-layout" id="ag-layout">
    <aside class="ag-left" id="ag-left" aria-label="会话">
      <div class="ag-left-head">
        <h2 class="ag-rail-title">会话</h2>
        <button type="button" class="ag-btn ag-btn-ghost ag-new" data-act="new-session">新建</button>
      </div>
      <div class="ag-filter">
        <input type="search" id="ag-filter" class="ag-input-line" placeholder="筛选会话" aria-label="筛选会话">
      </div>
      <ul class="ag-sessions" id="ag-sessions" role="list"></ul>
      <div class="ag-left-foot">
        <button type="button" class="ag-btn ag-btn-ghost" data-act="settings">设置</button>
        <button type="button" class="ag-btn ag-btn-ghost" data-act="pro">专业面板</button>
      </div>
    </aside>

    <section class="ag-main" aria-label="对话">
      <header class="ag-main-head">
        <div class="ag-main-titles">
          <h1 id="ag-title">新会话</h1>
          <p class="ag-sub" id="ag-sub">把任务交给 Agent：它调用工具、出示证据，高风险动作先问你。</p>
        </div>
        <div class="ag-main-actions">
          <span class="ag-model-inline" id="ag-model-inline"></span>
          <button type="button" class="ag-btn ag-btn-ghost" data-act="new-session">＋ 新会话</button>
        </div>
      </header>

      <div class="ag-thread" id="ag-thread">
        <div class="ag-thread-inner">
          <div class="ag-offline" id="ag-offline" hidden>
            <h2>Agent 服务未启动</h2>
            <p class="ag-offline-text" id="ag-offline-text">本地 Agent 没有应答。它在第一次请求时才启动，失败通常意味着 Python 或它的依赖缺了。</p>
            <div class="ag-offline-actions">
              <button type="button" class="ag-btn ag-btn-primary" data-act="retry">重试连接</button>
              <button type="button" class="ag-btn ag-btn-ghost" data-act="settings">检查设置</button>
            </div>
          </div>

          <div class="ag-empty" id="ag-empty" hidden>
            <div class="ag-empty-mark" aria-hidden="true"></div>
            <h2>从一件具体的事开始</h2>
            <p class="ag-sub">Agent 会调用台站工具、贴出证据；涉及设备动作时会停下来等你批准。</p>
            <div class="ag-chips" id="ag-suggestions"></div>
            <p class="ag-empty-hint">试试输入 <code>/</code> 看命令，<code>@</code> 选设备 · Ctrl+K 打开命令面板 · Ctrl+N 新会话</p>
          </div>

          <div class="ag-list" id="ag-list"></div>
        </div>
      </div>

      <div class="ag-composer-host" id="ag-composer-host"></div>
      <div class="ag-live" id="ag-live" aria-live="polite" aria-atomic="false"></div>
    </section>

    <aside class="ag-right" id="ag-right" aria-label="上下文">
      <section class="ag-rail-sec">
        <h2 class="ag-rail-title">当前设备</h2>
        <div class="ag-rail-body" id="ag-device-body"><p class="ag-muted">—</p></div>
      </section>
      <section class="ag-rail-sec">
        <h2 class="ag-rail-title">最近工具</h2>
        <div class="ag-rail-body" id="ag-tools-body"><p class="ag-muted">还没有调用</p></div>
      </section>
      <section class="ag-rail-sec ag-rail-grow">
        <h2 class="ag-rail-title">产物 <span class="ag-count" id="ag-artifact-count"></span></h2>
        <div class="ag-rail-body" id="ag-artifacts-body"><p class="ag-muted">还没有产物</p></div>
      </section>
      <footer class="ag-rail-foot"><span id="ag-health-line">连接中…</span></footer>
    </aside>
  </div>
  <div class="ag-toasts" id="ag-toasts" aria-live="polite" aria-atomic="false"></div>
`;

/* ================================================================
   mount
   ================================================================ */

export async function mount(root, ctx = {}) {
  if (!root || root.dataset.agentMounted === '1') return () => {};
  root.dataset.agentMounted = '1';
  root.classList.add('agent-panel');

  const api = createApi();
  const shellApi = ctx && ctx.api && typeof ctx.api.get === 'function' ? ctx.api : null;

  const state = {
    sessions: [],
    aliases: readJson(STORE.aliases, {}),
    hidden: new Set(readJson(STORE.hidden, [])),
    currentId: null,
    cards: [],
    busy: false,
    streaming: false,
    health: null,
    offline: null,
    devices: [],
    live: null,
    extraArtifacts: [],
    expanded: new Set(),
    filter: readStore(STORE.filter, '') || '',
    controller: null,
    destroyed: false,
  };

  root.innerHTML = SKELETON;

  const els = {
    layout: root.querySelector('#ag-layout'),
    left: root.querySelector('#ag-left'),
    right: root.querySelector('#ag-right'),
    thread: root.querySelector('#ag-thread'),
    list: root.querySelector('#ag-list'),
    empty: root.querySelector('#ag-empty'),
    offline: root.querySelector('#ag-offline'),
    offlineText: root.querySelector('#ag-offline-text'),
    suggestions: root.querySelector('#ag-suggestions'),
    sessions: root.querySelector('#ag-sessions'),
    filter: root.querySelector('#ag-filter'),
    title: root.querySelector('#ag-title'),
    sub: root.querySelector('#ag-sub'),
    modelInline: root.querySelector('#ag-model-inline'),
    deviceBody: root.querySelector('#ag-device-body'),
    toolsBody: root.querySelector('#ag-tools-body'),
    artifactsBody: root.querySelector('#ag-artifacts-body'),
    artifactCount: root.querySelector('#ag-artifact-count'),
    healthLine: root.querySelector('#ag-health-line'),
    composerHost: root.querySelector('#ag-composer-host'),
    live: root.querySelector('#ag-live'),
    toasts: root.querySelector('#ag-toasts'),
  };

  if (els.filter) els.filter.value = state.filter;

  /* ---------------- 主题（Agent 自己一套，默认深色） ---------------- */

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.body.setAttribute('data-agent-theme', next);
    writeStore(STORE.theme, next);
    const button = document.getElementById('fsa-theme');
    if (button) {
      button.setAttribute('aria-label', next === 'dark' ? '切换到浅色主题' : '切换到深色主题');
      button.setAttribute('title', next === 'dark' ? '浅色主题' : '深色主题');
      button.dataset.theme = next;
      button.innerHTML = next === 'dark'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.7 8.7 0 1 0 10.7 10.7z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>';
    }
  }

  applyTheme(readStore(STORE.theme, 'dark'));

  /* 产品条上的按钮：模型 chip / 设置 / 主题 / 窄屏侧栏开关 */
  function bindBar() {
    document.getElementById('fsa-model-chip')?.addEventListener('click', () => openSettingsDialog());
    document.getElementById('fsa-settings')?.addEventListener('click', () => openSettingsDialog());
    document.getElementById('fsa-theme')?.addEventListener('click', () => {
      applyTheme(document.body.getAttribute('data-agent-theme') === 'light' ? 'dark' : 'light');
    });
    document.getElementById('fsa-toggle-left')?.addEventListener('click', () => {
      const open = els.layout?.classList.toggle('is-left');
      // 窄屏同时开两侧会把中栏挤没，开一边就收另一边
      if (open && window.innerWidth <= 800) els.layout?.classList.remove('is-right');
    });
    document.getElementById('fsa-toggle-right')?.addEventListener('click', () => {
      const open = els.layout?.classList.toggle('is-right');
      if (open && window.innerWidth <= 800) els.layout?.classList.remove('is-left');
    });
  }

  bindBar();

  /* ---------------- 提示 ---------------- */

  function toast(message, tone = 'info') {
    if (!els.toasts) return;
    const node = el('div', { class: 'ag-toast', 'data-tone': tone, text: message });
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.dataset.leaving = '1';
      setTimeout(() => node.remove(), 220);
    }, 3200);
  }

  /* ---------------- 会话列表 ---------------- */

  function titleOf(sessionId) {
    const session = state.sessions.find((item) => item.id === sessionId);
    return sessionTitle(session || { id: sessionId }, state.aliases[sessionId]);
  }

  function visibleSessions() {
    const rows = sortSessions(state.sessions).filter((item) => item && item.id && !state.hidden.has(item.id));
    const query = state.filter.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((item) => titleOf(item.id).toLowerCase().includes(query));
  }

  function renderSessions() {
    if (!els.sessions) return;
    els.sessions.innerHTML = '';
    const rows = visibleSessions();
    if (!rows.length) {
      els.sessions.appendChild(el('li', { class: 'ag-session-empty' }, [
        el('p', { class: 'ag-muted', text: state.sessions.length ? '没有匹配的会话' : '还没有会话，发一条消息就会建一个' }),
      ]));
      return;
    }
    for (const session of rows) {
      const active = session.id === state.currentId;
      const item = el('li', { class: `ag-session${active ? ' is-active' : ''}`, 'data-id': session.id }, [
        el('button', {
          type: 'button',
          class: 'ag-session-open',
          'aria-current': active ? 'true' : null,
          onclick: () => selectSession(session.id),
        }, [
          el('span', { class: 'ag-session-title', text: titleOf(session.id), title: titleOf(session.id) }),
          el('span', { class: 'ag-session-time', text: relativeTime(session.updated_at) }),
        ]),
        el('button', {
          type: 'button',
          class: 'ag-session-more',
          'aria-label': `会话操作：${titleOf(session.id)}`,
          'aria-haspopup': 'menu',
          text: '⋯',
          onclick: (event) => {
            event.stopPropagation();
            toggleSessionMenu(item, session);
          },
        }),
      ]);
      els.sessions.appendChild(item);
    }
  }

  function toggleSessionMenu(item, session) {
    const existing = item.querySelector('.ag-session-menu');
    if (existing) {
      existing.remove();
      return;
    }
    for (const open of els.sessions.querySelectorAll('.ag-session-menu')) open.remove();
    const menu = el('div', { class: 'ag-session-menu', role: 'menu' }, [
      el('button', {
        type: 'button',
        role: 'menuitem',
        class: 'ag-menu-item',
        text: '重命名',
        onclick: (event) => {
          event.stopPropagation();
          menu.remove();
          startRename(item, session);
        },
      }),
      el('button', {
        type: 'button',
        role: 'menuitem',
        class: 'ag-menu-item ag-menu-danger',
        text: '从列表移除',
        onclick: (event) => {
          event.stopPropagation();
          menu.remove();
          hideSession(session.id);
        },
      }),
    ]);
    item.appendChild(menu);
  }

  function startRename(item, session) {
    const open = item.querySelector('.ag-session-open');
    if (!open) return;
    const current = titleOf(session.id);
    const input = el('input', { class: 'ag-input-line ag-rename', type: 'text', value: current, 'aria-label': '会话名称' });
    const applyRename = () => {
      const value = input.value.trim();
      if (value && value !== current) {
        state.aliases[session.id] = value;
        writeJson(STORE.aliases, state.aliases);
        toast('已保存本机别名：接口契约没有重命名端点，服务端标题未改动', 'warn');
      }
      renderAll();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        applyRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renderAll();
      }
    });
    open.replaceWith(input);
    input.focus();
    input.select();
  }

  function hideSession(id) {
    state.hidden.add(id);
    writeJson(STORE.hidden, [...state.hidden]);
    if (state.currentId === id) {
      state.currentId = null;
      state.cards = [];
      writeStore(STORE.session, null);
    }
    renderAll();
    toast('已从本机列表移除（会话文件仍在：契约没有删除端点）', 'warn');
  }

  async function loadSessions() {
    const data = await api.listSessions();
    state.sessions = (data && data.sessions) || [];
    renderSessions();
    return state.sessions;
  }

  /* ---------------- 线程渲染 ---------------- */

  function setEmpty(visible) {
    if (els.empty) els.empty.hidden = !visible;
    if (els.list) els.list.hidden = Boolean(visible);
  }

  function renderHeader() {
    if (!els.title) return;
    els.title.textContent = state.currentId ? titleOf(state.currentId) : '新会话';
    const session = state.currentId ? state.sessions.find((item) => item.id === state.currentId) : null;
    if (state.currentId && session && session.updated_at) {
      els.sub.textContent = `更新于 ${relativeTime(session.updated_at)} · ${state.cards.length} 条事件`;
    } else if (state.currentId) {
      els.sub.textContent = `${state.cards.length} 条事件`;
    } else {
      els.sub.textContent = '把任务交给 Agent：它调用工具、出示证据、高风险动作先问你。';
    }
  }

  function renderAll() {
    renderSessions();
    renderHeader();
    setEmpty(state.cards.length === 0 && !state.offline);
    renderThread([], true);
    renderRight();
  }

  const handlers = {
    isExpanded: (id) => state.expanded.has(id),
    setExpanded: (id, open) => {
      if (open) state.expanded.add(id);
      else state.expanded.delete(id);
    },
    artifactUrl: (card) => artifactUrl(state.currentId, card),
    /**
     * 下载产物。契约里没有产物下载路由，先按 /api/agent/sessions/:id/artifacts/<name> 试；
     * 404 时不去假装成功，直接把本机路径说出来（卡上也有）。
     */
    onDownload: async (event, card) => {
      event.preventDefault();
      const href = artifactUrl(state.currentId, card);
      try {
        const response = await fetch(href, { headers: { Accept: '*/*' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = card.name || 'artifact';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (error) {
        toast(`下载失败：${(error && error.message) || error}。产物在本机：${card.path || '（事件没给路径）'}`, 'bad');
      }
    },
    onOpenPanel: (panel, card) => {
      document.dispatchEvent(new CustomEvent('fsa:open-tab', { detail: { tab: panel, artifact: card } }));
      toast(`已切到专业面板：${panel}`, 'info');
    },
    onOpenSettings: () => openSettingsDialog(),
    onApproval: async (card, decision, note) => {
      if (!state.currentId) throw new Error('没有当前会话');
      await api.approval(state.currentId, {
        approval_id: card.id,
        decision,
        ...(note ? { note } : {}),
      });
      commit(applyEvent(state.cards, {
        type: 'approval',
        id: card.id,
        call_id: card.callId,
        risk: card.risk,
        status: decision,
        by: '操作员',
        note: note || '',
        ts: new Date().toISOString(),
      }));
      toast(decision === 'approved' ? '已批准，等待执行结果' : '已拒绝，动作不会执行', decision === 'approved' ? 'ok' : 'warn');
    },
  };

  function renderThread(prevCards, force = false) {
    if (!els.list) return;
    const cards = state.cards;
    const children = els.list.children;
    if (force) {
      els.list.innerHTML = '';
      for (const card of cards) {
        const node = renderCard(card, handlers);
        if (node) els.list.appendChild(node);
      }
      return;
    }
    for (let i = 0; i < cards.length; i += 1) {
      if (prevCards[i] === cards[i] && children[i]) continue;
      const node = renderCard(cards[i], handlers);
      if (!node) continue;
      const existing = children[i];
      if (existing) existing.replaceWith(node);
      else els.list.appendChild(node);
    }
    while (children.length > cards.length) children[children.length - 1].remove();
  }

  function stickToBottom() {
    if (!els.thread) return false;
    const distance = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight;
    return distance < 96;
  }

  function scrollToBottom() {
    if (!els.thread) return;
    els.thread.scrollTop = els.thread.scrollHeight;
  }

  let liveTimer = 0;
  function updateLiveRegion() {
    if (!els.live) return;
    const last = [...state.cards].reverse().find((card) => card.type === 'message' && card.role === 'assistant');
    if (!last) {
      els.live.textContent = '';
      return;
    }
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = 0;
      if (state.destroyed) return;
      const text = String(last.content || '').replace(/\s+/g, ' ').trim();
      els.live.textContent = text ? text.slice(-600) : '';
    }, 400);
  }

  /** 折叠后的统一入口：只在引用变化时重画，token 追加不会整篇重建 */
  function commit(nextCards, options = {}) {
    const prev = state.cards;
    state.cards = Array.isArray(nextCards) ? nextCards : [];
    const stick = options.forceScroll || stickToBottom();
    renderThread(prev, options.force === true);
    setEmpty(state.cards.length === 0 && !state.offline);
    updateLiveRegion();
    if (stick) scrollToBottom();
    renderHeader();
    scheduleRight();
  }

  let rightFrame = 0;
  function scheduleRight() {
    if (rightFrame) return;
    rightFrame = window.requestAnimationFrame(() => {
      rightFrame = 0;
      if (!state.destroyed) renderRight();
    });
  }

  /* ---------------- 右栏 ---------------- */

  function allArtifacts() {
    const fromCards = collectArtifacts(state.cards).map((card) => ({
      id: card.id,
      name: card.name,
      kind: card.kind,
      path: card.path,
      url: '',
      bytes: card.bytes,
    }));
    const seen = new Set(fromCards.map((item) => item.name));
    const extra = state.extraArtifacts
      .filter((item) => item && item.name && !seen.has(item.name))
      .map((item) => ({ ...item }));
    return [...fromCards, ...extra];
  }

  function artifactHref(item) {
    return artifactUrl(state.currentId, item);
  }

  function renderRight() {
    if (!els.deviceBody) return;

    // 当前设备：有实时连接优先，其次串口列表第一条；都没有就如实留空
    els.deviceBody.innerHTML = '';
    const live = state.live;
    if (live && (live.connected || live.port || live.device)) {
      const name = live.device || live.friendly_name || live.port || '(已连接)';
      els.deviceBody.appendChild(el('div', { class: 'ag-device' }, [
        el('span', { class: 'ag-dot', 'data-tone': live.connected ? 'ok' : 'warn' }),
        el('span', { class: 'ag-device-name', text: String(name) }),
      ]));
      els.deviceBody.appendChild(el('p', { class: 'ag-muted', text: live.connected ? '实时链路已连接' : '链路未连接' }));
    } else if (state.devices.length) {
      for (const device of state.devices.slice(0, 4)) {
        els.deviceBody.appendChild(el('div', { class: 'ag-device' }, [
          el('span', { class: 'ag-dot', 'data-tone': 'idle' }),
          el('span', { class: 'ag-device-name', text: device.label, title: device.value }),
        ]));
      }
      els.deviceBody.appendChild(el('p', { class: 'ag-muted', text: '串口存在，尚未建立实时连接' }));
    } else {
      els.deviceBody.appendChild(el('p', { class: 'ag-muted', text: '—' }));
    }

    // 最近工具
    els.toolsBody.innerHTML = '';
    const tools = recentTools(state.cards, 6);
    if (!tools.length) {
      els.toolsBody.appendChild(el('p', { class: 'ag-muted', text: '还没有调用' }));
    } else {
      for (const tool of tools) {
        els.toolsBody.appendChild(el('button', {
          type: 'button',
          class: 'ag-tool-row',
          title: `${tool.name} · ${statusLabel(tool.status)}`,
          onclick: () => scrollToCard(tool.id),
        }, [
          el('span', { class: 'ag-tool-row-icon' }, [iconSvg(tool.icon, 'ag-icon')]),
          el('span', { class: 'ag-tool-row-name', text: tool.label || tool.name }),
          el('span', { class: `ag-pill ag-pill-${tool.status}`, text: statusLabel(tool.status) }),
          tool.durationMs != null ? el('span', { class: 'ag-dur', text: formatDuration(tool.durationMs) }) : null,
        ]));
      }
    }

    // 产物
    const artifacts = allArtifacts();
    els.artifactCount.textContent = artifacts.length ? String(artifacts.length) : '';
    els.artifactsBody.innerHTML = '';
    if (!artifacts.length) {
      els.artifactsBody.appendChild(el('p', { class: 'ag-muted', text: '还没有产物' }));
    } else {
      for (const item of artifacts) {
        els.artifactsBody.appendChild(el('div', { class: 'ag-artifact-row' }, [
          el('span', { class: 'ag-artifact-name', text: item.name, title: item.name }),
          el('span', { class: 'ag-artifact-row-actions' }, [
            el('a', {
              class: 'ag-mini',
              href: artifactHref(item),
              download: item.name || '',
              text: '下载',
            }),
          ]),
        ]));
      }
    }

    els.healthLine.textContent = state.offline
      ? 'Agent 未连接'
      : state.health
        ? `${state.health.provider || 'agent'}${state.health.model ? ` · ${state.health.model}` : ''}${state.health.version ? ` · v${state.health.version}` : ''}`
        : '连接中…';
  }

  function scrollToCard(id) {
    if (!els.list) return;
    const node = els.list.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 900);
  }

  /* ---------------- 离线态 ---------------- */

  function setOffline(error) {
    state.offline = error || null;
    if (els.offline) els.offline.hidden = !error;
    if (els.offlineText && error) {
      els.offlineText.textContent = String((error && error.message) || error)
        + '。它通常在第一次 /api/agent 请求时启动；若反复失败，看一眼工具目录与 Python 环境。';
    }
    if (error) {
      if (els.list) els.list.hidden = true;
      if (els.empty) els.empty.hidden = true;
      if (composer) {
        composer.element.classList.add('is-disabled');
        composer.input.disabled = true;
        composer.setBusy(false);
      }
    } else {
      if (els.list) els.list.hidden = false;
      if (composer) {
        composer.element.classList.remove('is-disabled');
        composer.input.disabled = false;
      }
    }
    renderBar();
    scheduleRight();
  }

  /* ---------------- 顶栏（index.html 里的产品条） ---------------- */

  function renderBar() {
    const chip = document.getElementById('fsa-model-chip');
    if (chip) {
      const health = describeHealth(state.health);
      chip.textContent = state.offline ? '未连接 · 点此设置' : health.label;
      chip.dataset.state = state.offline ? 'offline' : 'ok';
      chip.title = state.offline
        ? 'Agent 服务未启动；点开检查设置'
        : `${health.detail}${health.version ? ` · v${health.version}` : ''}`;
    }
    const device = document.getElementById('fsa-device');
    if (device) {
      const live = state.live;
      const name = (live && (live.device || live.friendly_name || live.port))
        || (state.devices[0] && state.devices[0].label)
        || '';
      device.textContent = name || '未连接设备';
      device.dataset.empty = name ? 'false' : 'true';
    }
    if (els.modelInline) {
      const health = describeHealth(state.health);
      els.modelInline.textContent = state.offline ? '未连接' : health.label;
    }
  }

  /* ---------------- 消息 / 会话 ---------------- */

  async function selectSession(id) {
    if (window.innerWidth <= 800) els.layout?.classList.remove('is-left');
    if (state.busy) {
      toast('正在生成，先按 Esc 停止再切换会话', 'warn');
      return;
    }
    if (id === state.currentId && state.cards.length) return;
    state.currentId = id;
    writeStore(STORE.session, id);
    els.title.textContent = titleOf(id);
    renderSessions();
    try {
      const data = await api.getSession(id);
      const events = (data && (data.events || (data.session && data.session.events))) || [];
      state.extraArtifacts = [];
      commit(buildCards(events), { force: true, forceScroll: true });
      setOffline(null);
      renderSessions();
      fetchExtras(id);
    } catch (error) {
      if (isOffline(error)) setOffline(error);
      else {
        commit(applyEvent(state.cards, {
          type: 'error',
          class: error.class || 'execution',
          message: `读取会话失败：${error.message}`,
        }));
      }
    }
  }

  async function fetchExtras(id) {
    const collect = async (fn) => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };
    const artifacts = await collect(() => api.getArtifacts(id));
    if (state.destroyed || state.currentId !== id) return;
    const rows = (artifacts && (artifacts.artifacts || artifacts.files)) || [];
    if (Array.isArray(rows)) {
      state.extraArtifacts = rows.filter((item) => item && item.name);
      scheduleRight();
    }
  }

  async function newSession() {
    if (state.busy) {
      toast('正在生成，先按 Esc 停止', 'warn');
      return;
    }
    try {
      const created = await api.createSession();
      const id = (created && (created.session_id || created.id)) || null;
      if (!id) throw new Error('新建会话没有返回 session_id');
      state.currentId = id;
      state.cards = [];
      state.extraArtifacts = [];
      writeStore(STORE.session, id);
      setOffline(null);
      await loadSessions();
      renderAll();
      composer?.focus();
    } catch (error) {
      if (isOffline(error)) setOffline(error);
      else toast(`新建会话失败：${error.message}`, 'bad');
    }
  }

  async function send({ text, attachments }) {
    const value = String(text == null ? '' : text).trim();
    if (!value) return;
    if (state.offline) {
      toast('Agent 服务未启动：先重试连接', 'bad');
      return;
    }
    if (state.busy) return;

    state.busy = true;
    state.streaming = true;
    composer?.setBusy(true);

    try {
      if (!state.currentId) {
        const created = await api.createSession(deriveSessionTitle(value));
        const id = (created && (created.session_id || created.id)) || null;
        if (!id) throw new Error('新建会话没有返回 session_id');
        state.currentId = id;
        writeStore(STORE.session, id);
        await loadSessions();
      }

      const sessionId = state.currentId;
      const optimistic = {
        type: 'message',
        id: `local-${Date.now()}`,
        role: 'user',
        content: value,
        ts: new Date().toISOString(),
        pending: true,
        streaming: false,
      };
      commit([...state.cards, optimistic], { forceScroll: true });
      composer?.clear();

      const controller = new AbortController();
      state.controller = controller;
      const payload = { text: value };
      if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;

      await api.sendMessage(sessionId, payload, {
        signal: controller.signal,
        onEvent: (event) => {
          commit(applyEvent(state.cards, event));
        },
      });
    } catch (error) {
      if (error && (error.class === 'input' || /已取消/.test(String(error.message)))) {
        // 取消后本地乐观消息别停在"未确认"状态
        commit(state.cards.map((card) => (card.pending ? { ...card, pending: false } : card)));
        toast('已取消本次生成', 'warn');
      } else if (isOffline(error)) {
        setOffline(error);
      } else {
        commit(applyEvent(state.cards, {
          type: 'error',
          class: error.class || 'execution',
          message: (error && error.message) || String(error),
        }));
      }
    } finally {
      state.busy = false;
      state.streaming = false;
      state.controller = null;
      if (!state.offline) composer?.setBusy(false);
      composer?.focus();
      loadSessions().catch(() => {});
    }
  }

  async function stop() {
    if (!state.busy) return;
    const id = state.currentId;
    toast('正在停止…', 'warn');
    if (id) {
      try {
        await api.cancel(id);
      } catch (error) {
        toast(`取消请求失败：${error.message}（本地已中断）`, 'bad');
      }
    }
    try {
      state.controller?.abort();
    } catch {
      /* 已经结束 */
    }
  }

  /* ---------------- 命令 ---------------- */

  function showHelp() {
    const lines = [
      '**命令**',
      '',
      ...COMMANDS.map((command) => `- \`/${command.name}\` — ${command.hint}`),
      '',
      '**快捷键**',
      '',
      '- `Enter` 发送，`Shift+Enter` 换行',
      '- `Ctrl+N` 新会话，`Ctrl+K` 命令面板',
      '- `Esc` 停止生成；输入框里 `Esc` 关掉候选 / 附件行',
      '',
      '**约定**：工具结果一律带证据（`agent:call_id`）；高风险动作会先弹审批卡，批准后才会真的执行。',
    ];
    commit([...state.cards, {
      type: 'message',
      id: `help-${Date.now()}`,
      role: 'assistant',
      content: lines.join('\n'),
      ts: new Date().toISOString(),
      streaming: false,
    }], { forceScroll: true });
  }

  function handleCommand(command) {
    if (!command) return;
    if (command.kind === 'action') {
      if (command.action === 'new-session') newSession();
      else if (command.action === 'settings') openSettingsDialog();
      return;
    }
    if (command.name === 'help') {
      showHelp();
      return;
    }
    if (command.prompt) send({ text: command.prompt, attachments: [] });
  }

  /* ---------------- 设置 ---------------- */

  function openSettingsDialog() {
    openSettings({
      api,
      onSaved: (settings) => {
        toast('设置已保存', 'ok');
        if (settings) {
          state.health = {
            ...(state.health || {}),
            provider: settings.provider || (state.health && state.health.provider) || '',
            model: settings.model || '',
            ok: true,
          };
          renderBar();
        }
        refreshHealth();
      },
    });
  }

  /* ---------------- health / 设备 ---------------- */

  async function refreshHealth() {
    try {
      const health = await api.health();
      state.health = health && health.ok === false ? null : health;
      setOffline(null);
      renderBar();
      scheduleRight();
      return true;
    } catch (error) {
      if (isOffline(error)) setOffline(error);
      else toast(`健康检查失败：${error.message}`, 'bad');
      return false;
    }
  }

  async function loadContext() {
    const get = shellApi ? (path) => shellApi.get(path) : (path) => fetch(path).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    try {
      const ports = await get('/api/ports');
      const rows = (ports && ports.ports) || [];
      state.devices = rows.map((row) => ({
        label: row.friendlyName || row.path || '串口',
        value: row.path || row.friendlyName || '',
      })).filter((row) => row.value);
    } catch {
      state.devices = [];
    }
    try {
      state.live = await get('/api/live/status');
    } catch {
      state.live = null;
    }
    renderBar();
    scheduleRight();
  }

  /* ---------------- 输入区 ---------------- */

  function closeSidePanels() {
    if (!els.layout) return false;
    const open = els.layout.classList.contains('is-left') || els.layout.classList.contains('is-right');
    els.layout.classList.remove('is-left', 'is-right');
    return open;
  }

  const composer = createComposer({
    onSubmit: (payload) => send(payload),
    onStop: () => stop(),
    onEscape: () => closeSidePanels(),
    onCommand: (command) => handleCommand(command),
    devices: () => state.devices.map((device) => ({
      label: device.label,
      hint: device.value,
      value: device.value,
    })),
  });
  if (els.composerHost) els.composerHost.appendChild(composer.element);

  /* ---------------- 空态建议 ---------------- */

  if (els.suggestions) {
    for (const suggestion of SUGGESTIONS) {
      els.suggestions.appendChild(el('button', {
        type: 'button',
        class: 'ag-chip-suggest',
        title: suggestion.hint,
        onclick: () => send({ text: suggestion.prompt, attachments: [] }),
      }, [
        el('span', { class: 'ag-chip-suggest-label', text: suggestion.label }),
        el('span', { class: 'ag-chip-suggest-hint', text: suggestion.hint }),
      ]));
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  root.addEventListener('click', (event) => {
    const action = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (!action || !root.contains(action)) return;
    const act = action.getAttribute('data-act');
    if (act === 'new-session') newSession();
    else if (act === 'settings') openSettingsDialog();
    else if (act === 'retry') boot();
    else if (act === 'pro') {
      document.dispatchEvent(new CustomEvent('fsa:mode', { detail: { mode: 'pro' } }));
    }
  });

  els.filter?.addEventListener('input', () => {
    state.filter = els.filter.value;
    writeStore(STORE.filter, state.filter);
    renderSessions();
  });

  // 点空白处收起会话菜单
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.ag-session-menu') || target.closest('.ag-session-more')) return;
    for (const menu of root.querySelectorAll('.ag-session-menu')) menu.remove();
  });

  const onKeydown = (event) => {
    if (document.body.getAttribute('data-mode') !== 'agent') return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      newSession();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      composer.openCommandPalette();
      return;
    }
    if (event.key === 'Escape' && state.busy && !event.defaultPrevented) {
      // 输入框自己会处理它拿到的那次 Esc；焦点在别处时由这里兜住
      const target = event.target;
      const inComposer = target instanceof Node && composer.element.contains(target);
      if (!inComposer) stop();
      return;
    }
    if (event.key === 'Escape') closeSidePanels();
  };
  document.addEventListener('keydown', onKeydown);

  const onMode = (event) => {
    const mode = event && event.detail && event.detail.mode;
    if (mode === 'agent') {
      refreshHealth();
      composer.focus();
    }
  };
  document.addEventListener('fsa:mode', onMode);

  const onTab = (event) => {
    const detail = (event && event.detail) || {};
    if (!detail.tab) return;
    // 产物细节存进 sessionStorage，专业面板要跳转时能读到；这里只负责记一下
    try {
      if (detail.artifact) window.sessionStorage.setItem('fsa-agent-artifact', JSON.stringify(detail.artifact));
    } catch {
      /* 存不进去不影响切换 */
    }
  };
  document.addEventListener('fsa:open-tab', onTab);

  /* ---------------- 启动 ---------------- */

  let bootToken = 0;
  async function boot() {
    const token = ++bootToken;
    els.title.textContent = state.currentId ? titleOf(state.currentId) : '新会话';
    try {
      const health = await api.health();
      if (state.destroyed || token !== bootToken) return;
      state.health = health && health.ok === false ? null : health;
      setOffline(null);
      await loadSessions();
      if (state.destroyed || token !== bootToken) return;

      const stored = readStore(STORE.session, null);
      const rows = visibleSessions();
      const exists = stored && !state.hidden.has(stored) && state.sessions.some((item) => item.id === stored);
      const target = exists ? stored : (rows[0] ? rows[0].id : null);
      if (target) {
        state.currentId = target;
        writeStore(STORE.session, target);
        const data = await api.getSession(target);
        if (state.destroyed || token !== bootToken) return;
        const events = (data && (data.events || (data.session && data.session.events))) || [];
        commit(buildCards(events), { force: true, forceScroll: true });
        fetchExtras(target);
        renderSessions();
      } else {
        renderAll();
      }
      renderBar();
      composer.focus();
    } catch (error) {
      if (state.destroyed) return;
      setOffline(error);
      renderSessions();
    }
  }

  renderSessions();
  renderAll();
  loadContext();
  boot();

  /* ---------------- 清理 ---------------- */

  return function unmount() {
    state.destroyed = true;
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('fsa:mode', onMode);
    document.removeEventListener('fsa:open-tab', onTab);
    if (liveTimer) clearTimeout(liveTimer);
    if (rightFrame) window.cancelAnimationFrame(rightFrame);
    try {
      state.controller?.abort();
    } catch {
      /* 已结束 */
    }
    root.dataset.agentMounted = '0';
  };
}
