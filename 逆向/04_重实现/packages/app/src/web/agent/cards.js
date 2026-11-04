/**
 * 卡片渲染 —— 事件模型 → DOM。
 *
 * 所有来自服务端的字符串都走 textContent（或经 model.renderMarkdown 转义过的 innerHTML），
 * 这里不拼未转义的用户数据。卡片的交互（审批、打开面板、折叠）通过 handlers 回调交给 index.js，
 * 卡片本身不 fetch、不碰全局状态。
 */

import {
  artifactKindLabel,
  artifactPanel,
  evidenceText,
  formatClock,
  formatDuration,
  planProgress,
  renderMarkdown,
  riskLabel,
  statusLabel,
} from './model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  chevron: '<path d="M8 10l4 4 4-4"/>',
  health: '<path d="M3 12h3.5l2 5 3.5-11 2 6h6"/>',
  chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l4-6 3 3 4-7"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.6-4.6"/>',
  ticket: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 6v12"/><path d="M13 10h4M13 14h4"/>',
  device: '<rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  export: '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
  graph: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-4 3 2 4-6"/>',
  playback: '<circle cx="12" cy="12" r="8"/><path d="M10.4 9.2l5 2.8-5 2.8z"/>',
  manage: '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/>',
  workflow: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 6h3a2 2 0 0 1 2 2v2M8 18h3a2 2 0 0 0 2-2v-2"/>',
  shield: '<path d="M12 3l7 3v6c0 5-3.2 7.2-7 9-3.8-1.8-7-4-7-9V6z"/><path d="M9.5 12l1.8 1.8L15 10"/>',
  tool: '<path d="M14.5 4.5l5 5-2.8 2.8-5-5z"/><path d="M11.4 7.6L4 15v5h5l7.4-7.4"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5"/><path d="M12 17.4h.01"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
};

export function iconSvg(key, className = 'ag-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  svg.innerHTML = ICON_PATHS[key] || ICON_PATHS.tool;
  return svg;
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

function uniqueId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ================================================================
   消息
   ================================================================ */

export function renderMessage(card) {
  const user = card.role === 'user';
  const bubble = el('div', { class: `ag-bubble${user ? ' ag-bubble-user' : ''}` });
  if (user) {
    bubble.textContent = card.content || '';
  } else if (!card.content && card.streaming) {
    bubble.appendChild(el('span', { class: 'ag-typing', 'aria-label': '正在生成' }, [
      el('i'), el('i'), el('i'),
    ]));
  } else {
    bubble.classList.add('ag-md');
    // renderMarkdown 先整体转义再拼标签，这里可以安全当 HTML 插入
    bubble.innerHTML = renderMarkdown(card.content || '');
  }
  const meta = el('div', { class: 'ag-msg-meta' }, [
    el('span', { class: 'ag-msg-who', text: user ? '我' : 'Agent' }),
    card.ts ? el('time', { class: 'ag-msg-time', datetime: card.ts, text: formatClock(card.ts) }) : null,
    card.streaming ? el('span', { class: 'ag-msg-state', text: '生成中…' }) : null,
  ]);
  return el('article', {
    class: `ag-msg ${user ? 'ag-msg-user' : 'ag-msg-assistant'}`,
    'data-card-id': card.id,
    'data-card-type': 'message',
  }, [meta, bubble]);
}

/* ================================================================
   工具卡
   ================================================================ */

function jsonPreview(args, data) {
  const payload = {};
  if (args !== null && args !== undefined) payload.arguments = args;
  if (data !== null && data !== undefined) payload.result = data;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function renderToolCard(card, handlers = {}) {
  const expanded = typeof handlers.isExpanded === 'function' ? handlers.isExpanded(card.id) : false;
  const bodyId = uniqueId('ag-tool-body');
  const status = card.status || 'running';

  const chevron = iconSvg('chevron', 'ag-chevron');

  const head = el('button', {
    type: 'button',
    class: 'ag-card-head',
    'aria-expanded': expanded ? 'true' : 'false',
    'aria-controls': bodyId,
  }, [
    el('span', { class: 'ag-tool-icon' }, [iconSvg(card.icon)]),
    el('span', { class: 'ag-tool-label', text: card.label || card.name }),
    el('code', { class: 'ag-tool-name', text: card.name || '' }),
    el('span', { class: `ag-pill ag-pill-${status}`, 'data-status': status, text: statusLabel(status) }),
    card.durationMs != null ? el('span', { class: 'ag-dur', text: formatDuration(card.durationMs) }) : null,
    chevron,
  ]);
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', open ? 'false' : 'true');
    // 折叠区当场同步：上层 setExpanded 只改状态、不保证马上重渲染，
    // 若只靠它，点开会看到箭头转了而正文不动。
    body.hidden = open;
    if (typeof handlers.setExpanded === 'function') handlers.setExpanded(card.id, !open);
  });

  const body = el('div', { class: 'ag-card-body', id: bodyId }, [
    el('div', { class: 'ag-kv' }, [
      el('span', { class: 'ag-kv-key', text: '证据' }),
      el('code', { class: 'ag-evidence', text: evidenceText(card.evidence) || '—' }),
      card.risk && card.risk !== 'low' ? el('span', { class: `ag-risk ag-risk-${card.risk}`, text: riskLabel(card.risk) }) : null,
    ]),
    el('pre', { class: 'ag-json', text: jsonPreview(card.args, card.data) }),
  ]);
  body.hidden = !expanded;

  const summary = card.summary
    ? el('p', { class: 'ag-tool-summary', text: card.summary })
    : null;

  return el('article', {
    class: `ag-card ag-tool${status === 'failed' ? ' ag-tool-failed' : ''}`,
    'data-card-id': card.id,
    'data-card-type': 'tool',
    'data-status': status,
  }, [head, summary, body]);
}

/* ================================================================
   审批卡
   ================================================================ */

export function renderApprovalCard(card, handlers = {}) {
  const pending = card.status === 'pending';
  const buttons = [];
  const note = el('textarea', {
    class: 'ag-note',
    rows: '2',
    placeholder: '备注（可选，写进审批记录）',
    'aria-label': '审批备注',
  });
  note.value = card.note || '';

  const decide = (decision) => async () => {
    if (!pending) return;
    for (const button of buttons) button.disabled = true;
    decisionEl.hidden = false;
    decisionEl.textContent = decision === 'approved' ? '正在提交批准…' : '正在提交拒绝…';
    try {
      await handlers.onApproval?.(card, decision, note.value.trim());
    } catch (error) {
      for (const button of buttons) button.disabled = false;
      decisionEl.hidden = false;
      decisionEl.textContent = `提交失败：${(error && error.message) || error}`;
      decisionEl.dataset.tone = 'bad';
    }
  };

  const approve = el('button', {
    type: 'button',
    class: 'ag-btn ag-btn-primary',
    'data-decision': 'approved',
    text: '批准',
    onclick: decide('approved'),
  });
  const reject = el('button', {
    type: 'button',
    class: 'ag-btn ag-btn-danger',
    'data-decision': 'rejected',
    text: '拒绝',
    onclick: decide('rejected'),
  });
  buttons.push(approve, reject);
  if (!pending) for (const button of buttons) button.disabled = true;

  const decided = !pending;
  const decisionEl = el('p', {
    class: 'ag-decision',
    hidden: !decided,
    'data-tone': card.status === 'rejected' ? 'bad' : card.status === 'approved' ? 'ok' : null,
    text: decided
      ? `${card.status === 'approved' ? '已批准' : '已拒绝'}${card.decidedBy ? ` · ${card.decidedBy}` : ' · 操作员'}${card.decidedAt ? ` · ${formatClock(card.decidedAt)}` : ''}`
      : '',
  });

  return el('article', {
    class: 'ag-card ag-approval',
    'data-card-id': card.id,
    'data-card-type': 'approval',
    'data-status': card.status || 'pending',
  }, [
    el('header', { class: 'ag-approval-head' }, [
      iconSvg('shield', 'ag-icon ag-approval-icon'),
      el('h3', { text: '需要你确认' }),
      el('span', { class: `ag-risk ag-risk-${card.risk || 'medium'}`, text: riskLabel(card.risk) }),
      card.callId ? el('code', { class: 'ag-call-id', text: card.callId }) : null,
    ]),
    card.prompt ? el('p', { class: 'ag-approval-prompt', text: card.prompt }) : null,
    card.reason ? el('p', { class: 'ag-approval-reason', text: card.reason }) : null,
    pending ? el('label', { class: 'ag-note-field' }, [el('span', { text: '备注' }), note]) : null,
    el('div', { class: 'ag-actions' }, buttons),
    decisionEl,
  ]);
}

/* ================================================================
   产物 / 错误 / 计划
   ================================================================ */

export function renderArtifactCard(card, handlers = {}) {
  const panel = artifactPanel(card);
  return el('article', {
    class: 'ag-card ag-artifact',
    'data-card-id': card.id,
    'data-card-type': 'artifact',
  }, [
    el('span', { class: 'ag-artifact-icon' }, [iconSvg('file')]),
    el('div', { class: 'ag-artifact-main' }, [
      el('span', { class: 'ag-artifact-name', text: card.name }),
      el('span', { class: 'ag-artifact-meta' }, [
        el('span', { class: 'ag-kind', text: artifactKindLabel(card.kind) }),
        card.sha256 ? el('code', { class: 'ag-sha', title: card.sha256, text: `sha256 ${card.sha256.slice(0, 12)}…` }) : null,
        card.path ? el('code', { class: 'ag-path', title: card.path, text: card.path }) : null,
      ]),
    ]),
    el('div', { class: 'ag-artifact-actions' }, [
      el('a', {
        class: 'ag-btn ag-btn-ghost',
        href: handlers.artifactUrl ? handlers.artifactUrl(card) : '#',
        download: card.name || '',
        title: card.path ? `下载 ${card.path}` : '下载产物',
        text: '下载',
        onclick: (event) => {
          if (typeof handlers.onDownload === 'function') handlers.onDownload(event, card);
        },
      }),
      el('button', {
        type: 'button',
        class: 'ag-btn ag-btn-ghost',
        text: `在${panelLabel(panel)}打开`,
        onclick: () => handlers.onOpenPanel?.(panel, card),
      }),
    ]),
  ]);
}

function panelLabel(panel) {
  const table = { playback: ' Playback ', graph: ' Graph ', workflows: ' Workflows ', manage: ' Manage ' };
  return table[panel] || '专业面板';
}

export function renderErrorCard(card, handlers = {}) {
  const errorClass = String(card.errorClass || 'execution');
  return el('article', {
    class: 'ag-card ag-error',
    'data-card-id': card.id,
    'data-card-type': 'error',
    'data-error-class': errorClass,
  }, [
    el('header', { class: 'ag-error-head' }, [
      iconSvg('alert', 'ag-icon ag-error-icon'),
      el('h3', { text: '执行失败' }),
      el('span', { class: 'ag-error-class', text: errorClass }),
      card.ts ? el('time', { class: 'ag-msg-time', datetime: card.ts, text: formatClock(card.ts) }) : null,
    ]),
    el('p', { class: 'ag-error-text', text: card.message || '没有给出原因' }),
    errorClass === 'environment'
      ? el('button', {
        type: 'button',
        class: 'ag-btn ag-btn-ghost',
        text: '查看设置',
        onclick: () => handlers.onOpenSettings?.(),
      })
      : null,
  ]);
}

const PLAN_MARK = { todo: '○', doing: '◐', done: '●', blocked: '⊘' };

export function renderPlanCard(card) {
  const progress = planProgress(card);
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const bar = el('div', {
    class: 'ag-plan-bar',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': String(progress.total || 0),
    'aria-valuenow': String(progress.done),
    'aria-label': '计划进度',
  }, [el('span', { class: 'ag-plan-fill', style: `width:${percent}%` })]);

  return el('article', {
    class: 'ag-card ag-plan',
    'data-card-id': card.id,
    'data-card-type': 'plan',
  }, [
    el('header', { class: 'ag-plan-head' }, [
      el('h3', { text: '执行计划' }),
      el('span', { class: 'ag-plan-count', text: `${progress.done}/${progress.total}` }),
    ]),
    bar,
    el('ol', { class: 'ag-plan-list' }, (card.items || []).map((item) =>
      el('li', { class: `ag-plan-item ag-plan-${item.status}` }, [
        el('span', { class: 'ag-plan-mark', 'aria-hidden': 'true', text: PLAN_MARK[item.status] || '○' }),
        el('span', { class: 'ag-plan-title', text: item.title }),
        el('span', { class: 'ag-plan-state', text: { todo: '待办', doing: '进行中', done: '完成', blocked: '受阻' }[item.status] || '' }),
      ]))),
  ]);
}

/** 卡片分发；未知类型不渲染（事件模型只允许这几种，未知就是有问题，别猜） */
export function renderCard(card, handlers) {
  switch (card && card.type) {
    case 'message': return renderMessage(card);
    case 'tool': return renderToolCard(card, handlers);
    case 'approval': return renderApprovalCard(card, handlers);
    case 'artifact': return renderArtifactCard(card, handlers);
    case 'plan': return renderPlanCard(card, handlers);
    case 'error': return renderErrorCard(card, handlers);
    default: return null;
  }
}
