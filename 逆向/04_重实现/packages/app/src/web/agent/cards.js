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

/**
 * 从真实返回里挑 3–4 个「最能改变判断」的数字做摘要。
 *
 * 规格 25.8.2 把理由说得很直接：这是「结论的支撑」，不是「数据浏览器」。
 * 用户要的是「这次调用大概说明了什么」，细节在 trace 里。
 *
 * 所以**不是**把返回全摊开（`p05 p25 p75 p95 mad` 那些进 trace），而是：
 *   · 样本量 / 行数 —— 决定可信不可信；
 *   · 核心指标（中位数、比率）—— 结论本身；
 *   · 缺测 / 丢弃数 —— 决定能不能用。
 *
 * ## 为什么只取命中清单的字段
 *
 * 第一版是「命中的排前面，没命中的按原顺序补足到 4 个」。实测立刻出问题：
 * `robust_stats` 的返回里 `p05` 排在第 4 位，于是摘要显示成
 * `n=86,400 · cn0_median=44.2 · missing=604 · p05=30` —— 分位数挤掉了
 * 真正该看的字段，正是规格点名不要进摘要的那一类。
 *
 * 现在改成**只从清单里取**：取不满 4 个就少显示几个，宁可信息少，
 * 也不让「无关数字占掉一个位置」。挑不到就返回空数组，由调用方决定不显示摘要行。
 */
const SUMMARY_PREFERRED = [
  // 样本量：决定可信不可信
  'n', 'rows', 'total', 'count', 'samples',
  // 核心指标：结论本身
  'cn0_median', 'median', 'mean', 'rate', 'ratio', 'value', 'health', 'score',
  // 缺测 / 丢弃：决定能不能用
  'missing', 'missing_rate', 'dropped', 'failed', 'errors',
];

export function resultSummary(data, limit = 4) {
  if (data === null || data === undefined) return [];
  if (typeof data !== 'object') return [{ key: '', text: String(data) }];

  const picked = [];
  const seen = new Set();
  for (const key of SUMMARY_PREFERRED) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    // 只挑标量：对象与数组是细节，属于 trace，不属于摘要。
    if (value === null || typeof value === 'object') continue;
    seen.add(key);
    picked.push([key, value]);
    if (picked.length >= limit) break;
  }
  if (!picked.length) return [];

  return picked.map(([key, value]) => {
    const text = typeof value === 'number'
      ? (Number.isInteger(value) ? value.toLocaleString('en-US') : String(value))
      : String(value);
    return { key, text };
  });
}

/**
 * 工具卡 —— 五个必需元素（规格 25.8.1）。
 *
 * | # | 元素 | 为什么 |
 * |---|---|---|
 * | 1 | 工具名 | 等宽字体，一眼分辨 `robust_stats` 与 `slope_stats` |
 * | 2 | 状态 + 耗时 | 同一行右侧，右对齐，让一列卡片能对齐 |
 * | 3 | 结果摘要 | 只显示 3–4 个关键数字，不是全部返回 |
 * | 4 | 展开入口 | 叫「查看 trace」，不是「详情」 |
 * | 5 | call_id | 铺在背景里（浅色小字），不抢眼，但**必须在** ——
 *               它是回源的唯一入口（规格 6.3 规矩三） |
 */
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
    // 标签与名字同名时只显示一次 —— `label` 默认就是 `name`，两处都分会重复。
    el('span', {
      class: 'ag-tool-label',
      text: card.label && card.label !== card.name ? card.label : '',
    }),
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

  const summaryParts = Array.isArray(card.summary)
    ? card.summary.map((part) => ({ key: '', text: String(part) }))
    : resultSummary(card.data);

  const summaryLine = summaryParts.length
    ? el('p', { class: 'ag-tool-summary' }, summaryParts.flatMap((part, index) => {
      const nodes = [];
      if (index > 0) nodes.push(el('span', { class: 'ag-tool-sep', text: '·' }));
      if (part.key) nodes.push(el('span', { class: 'ag-tool-key', text: `${part.key}=` }));
      nodes.push(el('span', { class: 'ag-tool-val', text: part.text }));
      return nodes;
    }))
    : null;

  // 「查看 trace」是展开入口的名字 —— 规格明确不要叫「详情」。
  const traceButton = el('button', {
    type: 'button',
    class: 'ag-tool-trace',
    text: '查看 trace',
    'aria-label': `${card.name || '工具'} 的调用详情`,
  });
  traceButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (typeof handlers.onTrace === 'function') {
      handlers.onTrace(card);
      return;
    }
    // 没有 trace 处理器时退化成就地展开 —— 不要让按钮点了没反应。
    head.click();
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

  return el('article', {
    class: `ag-card ag-tool${status === 'failed' ? ' ag-tool-failed' : ''}`,
    'data-card-id': card.id,
    'data-card-type': 'tool',
    'data-status': status,
    // call_id 同时进属性：回源跳转与测试都按它找，不必去解析背景小字。
    'data-call-id': card.callId || null,
  }, [
    head,
    summaryLine,
    el('div', { class: 'ag-tool-foot' }, [traceButton]),
    body,
    // call_id 铺在卡片底部背景里：浅色小字，不抢眼，但一定在。
    card.callId ? el('code', { class: 'ag-call-id ag-tool-call-id', title: `call_id ${card.callId}`, text: card.callId }) : null,
  ]);
}

/* ================================================================
   审批卡
   ================================================================ */

/**
 * 审批卡 —— 四个必需元素（规格 25.9.1 + 6.3）。
 *
 * | # | 元素 | 为什么 |
 * |---|---|---|
 * | 1 | 风险等级 | `[high]` 这样的标，一眼看出轻重 |
 * | 2 | 动作描述 + **后果** | 两件事**必须分开写** —— 「归档」听起来无害，但「写 120 MB 到磁盘」可能是用户不想的 |
 * | 3 | 批准 / 拒绝 | 批准在前（大概率是批准），但拒绝不做成红色大按钮（会让人不敢拒绝） |
 * | 4 | 查看证据 | 让用户能当场核对，而不是盲批 |
 *
 * ## 规矩二：拒绝必须填理由（规格 6.3 + 25.9.2）
 *
 * 这条是硬要求，不是建议：
 *
 * | 不填理由 | 填了理由 |
 * |---|---|
 * | 事后无法解释「为什么没做」 | 能查 |
 * | 无法判断「是不是误点」 | 能看出意图 |
 *
 * 所以点「拒绝」不是直接提交，而是先展开一个必填的理由框；
 * 空着点提交按钮**不生效**，且给出明确的错误提示。
 * 但「不是必填长文本」—— 填「1」或「暂不」都算，只要能区分「我看到了并且拒绝了」。
 */
export function renderApprovalCard(card, handlers = {}) {
  const pending = card.status === 'pending';
  // 审批结论一旦落下就不再可改：批准是「已经发生的事」，允许改会让审计失效（25.9.3）。
  const decided = !pending;

  const buttons = [];
  const decisionEl = el('p', {
    class: 'ag-decision',
    hidden: !decided,
    'data-tone': card.status === 'rejected' ? 'bad' : card.status === 'approved' ? 'ok' : null,
    text: decided
      ? `${card.status === 'approved' ? '已批准' : '已拒绝'}${card.decidedBy ? ` · ${card.decidedBy}` : ' · 操作员'}${card.decidedAt ? ` · ${formatClock(card.decidedAt)}` : ''}`
      : '',
  });

  /* —— 拒绝的理由框：默认收起，点「拒绝」才出现 —— */
  const reasonField = el('label', { class: 'ag-reason-field', hidden: true }, [
    el('span', { class: 'ag-reason-label', text: '拒绝理由（必填）' }),
    el('textarea', {
      class: 'ag-note',
      rows: '2',
      placeholder: '写一句就够，例如「暂不」「时间不对」——只要能说明你看过了',
      'aria-label': '拒绝理由',
      'aria-required': 'true',
    }),
  ]);
  const reasonInput = reasonField.querySelector('textarea');
  const reasonError = el('p', { class: 'ag-reason-error', hidden: true, 'data-tone': 'bad' });

  const noteField = el('label', { class: 'ag-note-field' }, [
    el('span', { text: '备注' }),
    el('textarea', {
      class: 'ag-note',
      rows: '2',
      placeholder: '备注（可选，写进审批记录）',
      'aria-label': '审批备注',
    }),
  ]);
  const note = noteField.querySelector('textarea');
  note.value = card.note || '';

  /** 提交。`decision === 'rejected'` 时先验理由。 */
  const submit = async (decision) => {
    if (!pending) return;

    if (decision === 'rejected') {
      const reason = reasonInput.value.trim();
      if (!reason) {
        // 空理由不提交 —— 但要**说清为什么没提交**，不能静默不动。
        reasonError.hidden = false;
        reasonError.textContent = '拒绝必须填一句理由：事后要靠它解释「为什么没做」。';
        reasonInput.focus();
        return;
      }
      reasonError.hidden = true;
    }

    for (const button of buttons) button.disabled = true;
    decisionEl.hidden = false;
    decisionEl.textContent = decision === 'approved' ? '正在提交批准…' : '正在提交拒绝…';
    // 拒绝时把理由一起送上去：它要进审批记录，不能只留在界面上。
    const payload = decision === 'rejected'
      ? { note: note.value.trim(), reason: reasonInput.value.trim() }
      : { note: note.value.trim() };
    try {
      await handlers.onApproval?.(card, decision, payload);
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
    onclick: () => submit('approved'),
  });
  const reject = el('button', {
    type: 'button',
    // 次要色，**不是红色大按钮** —— 那会让人不敢拒绝（附录 C.3 点四）。
    class: 'ag-btn ag-btn-quiet',
    'data-decision': 'rejected',
    text: '拒绝',
    onclick: () => {
      // 第一次点只展开理由框，不提交。
      if (reasonField.hidden) {
        reasonField.hidden = false;
        reasonInput.focus();
        return;
      }
      submit('rejected');
    },
  });
  const evidence = el('button', {
    type: 'button',
    class: 'ag-btn ag-btn-text',
    'data-action': 'evidence',
    text: '查看证据',
    onclick: () => {
      if (typeof handlers.onEvidence === 'function') {
        handlers.onEvidence(card);
        return;
      }
      // 没有证据面板时退化成展开 JSON —— 不能让这个按钮点了没反应。
      const detail = el('pre', { class: 'ag-json', text: jsonPreview(card.args, card.evidence) });
      decisionEl.hidden = false;
      decisionEl.dataset.tone = 'neutral';
      decisionEl.replaceWith(detail);
    },
  });
  buttons.push(approve, reject);
  if (!pending) for (const button of buttons) button.disabled = true;

  return el('article', {
    // 已决的卡片不带 `ag-approval-pending`：那个类是「需要我」的橙底，
    // 而决定已经落下，还染着橙底会让人以为还得再点一次。
    class: `ag-card ag-approval${pending ? ' ag-approval-pending' : ' ag-approval-decided'}`,
    'data-card-id': card.id,
    'data-card-type': 'approval',
    'data-status': card.status || 'pending',
    // 未决标记：对话页据此禁用输入框（规矩一）。
    'data-pending': pending ? 'true' : null,
  }, [
    el('header', { class: 'ag-approval-head' }, [
      iconSvg('shield', 'ag-icon ag-approval-icon'),
      el('h3', { text: '需要你批准' }),
      el('span', { class: `ag-risk ag-risk-${card.risk || 'medium'}`, text: riskLabel(card.risk) }),
      card.callId ? el('code', { class: 'ag-call-id', text: card.callId }) : null,
    ]),
    // 「做什么」与「后果」分两行写 —— 这是 25.9.1 点明的要求。
    card.prompt ? el('p', { class: 'ag-approval-prompt' }, [
      el('span', { class: 'ag-approval-what', text: card.prompt }),
    ]) : null,
    card.reason || card.impact ? el('p', { class: 'ag-approval-impact' }, [
      el('span', { class: 'ag-approval-impact-label', text: '影响' }),
      el('span', { text: card.impact || card.reason }),
    ]) : null,
    pending ? noteField : null,
    pending ? reasonField : null,
    reasonError,
    el('div', { class: 'ag-actions' }, [...buttons, evidence]),
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
