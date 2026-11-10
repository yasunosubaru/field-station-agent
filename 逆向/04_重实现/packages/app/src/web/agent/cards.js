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
 * 错误分类的中文标签 —— 照 `docs/contracts/agent-events.md` §3.8 的七个 class。
 *
 * 为什么要翻译：界面直接印 `capability` / `artifact` 这种枚举，用户得先去翻契约
 * 才知道该看哪里。而分类本身是**分派动作**的依据 —— 「输入参数不对」是改一句重发，
 * 「环境不通」是去看服务，两种处理方式完全不同。
 *
 * 为什么不合并成「出错了」：那样就把七个不同的下一步揉成一个没有下一步的红字。
 */
export const ERROR_CLASS_LABELS = {
  input: '输入参数不合法',
  capability: '能力不可用（工具未注册或不支持）',
  artifact: '产物 / 文件写入失败',
  environment: '环境不通（服务或连接）',
  approval: '审批被拒或已过期',
  execution: '执行期错误',
  provider: '模型侧错误',
};

/** class → 人话；没登记的原样返回，**不猜**成 `execution`（那会把未知变成误导）。 */
export function errorClassLabel(name) {
  const key = String(name == null ? '' : name);
  if (!key) return '';
  return ERROR_CLASS_LABELS[key] || key;
}

/** 参数摘要里单个值最多这么长；再长就截断 —— 摘要占两行就没人读了。 */
const ARG_VALUE_LIMIT = 40;

function clipArg(value) {
  const text = typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : String(value);
  return text.length > ARG_VALUE_LIMIT ? `${text.slice(0, ARG_VALUE_LIMIT)}…` : text;
}

/**
 * 参数摘要 —— 工具卡的第 2 个要素。
 *
 * ## 为什么要单列一行，而不是「展开看 JSON 就够了」
 *
 * 五要素里有「参数」，而参数原来只躺在折叠的 `<pre>` 里。后果很具体：
 * 「重启 WUHN 接收机」与「重启 ALIC 接收机」两张卡在**收起状态下一模一样** ——
 * 工具名相同、结果摘要都是空（还没返回）、耗时都是 0。用户得点开两张卡对比 JSON
 * 才知道自己批的是哪一台。参数摘要就是为了让收起状态也能分辨。
 *
 * ## 只取标量
 *
 * 嵌套对象与数组属于 trace：把它们塞进摘要会撑成三四行，摘要就不再是摘要。
 * 所以跳过它们 —— 宁可少显示一个键，也不让摘要变成数据浏览器（同 25.8.2 的口径）。
 */
export function argumentSummary(args, limit = 3) {
  if (args === null || args === undefined) return [];
  if (typeof args !== 'object') return [{ key: '', text: clipArg(args) }];
  if (Array.isArray(args)) return [];

  const picked = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    if (typeof value === 'string' && !value.trim()) continue;
    picked.push({ key, text: clipArg(value) });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 摘要 → 「key=value · key=value」这一行；没有键时只显示值。 */
function summaryLine(parts, className, slot) {
  return el('p', { class: className, 'data-part': slot }, parts.flatMap((part, index) => {
    const nodes = [];
    if (index > 0) nodes.push(el('span', { class: 'ag-tool-sep', text: '·' }));
    if (part.key) nodes.push(el('span', { class: 'ag-tool-key', text: `${part.key}=` }));
    nodes.push(el('span', { class: 'ag-tool-val', text: part.text }));
    return nodes;
  }));
}

/**
 * 工具卡 —— 五个必需元素（规格 25.8.1），每个都带 `data-part` 便于测试断言。
 *
 * | # | 元素 | `data-part` | 为什么 |
 * |---|---|---|---|
 * | 1 | 工具名 | `name` | 等宽字体，一眼分辨 `robust_stats` 与 `slope_stats` |
 * | 2 | 参数摘要 | `args` | 让**收起状态**也能分辨「重启 WUHN」与「重启 ALIC」 |
 * | 3 | 结果摘要 | `result` | 只显示 3–4 个关键数字，不是全部返回 |
 * | 4 | 耗时 | `duration` | 用户判断「正常不正常」的依据；运行中也要占位 |
 * | 5 | 成功 / 失败 | `status` | 失败还要带**真实错误分类**，不是一句「出错了」 |
 *
 * 另有不在五要素内但必须有的两样：
 *   · 展开入口 —— 叫「查看 trace」，不是「详情」；
 *   · call_id —— 铺在背景里（浅色小字），不抢眼，但**必须在**：
 *     它是回源的唯一入口（规格 6.3 规矩三）。
 *
 * ## 空槽也要画
 *
 * 运行中的卡没有结果、没有耗时。第一版是「没有就不画」，于是运行中的卡只有
 * 两个要素 —— 五要素变成了「成功之后才有五要素」。现在每个槽位恒定存在，
 * 没内容时写「等待返回」/「—」，读卡的人不会以为界面漏画了。
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
    // ① 工具名
    el('code', { class: 'ag-tool-name', 'data-part': 'name', text: card.name || '' }),
    // ⑤ 成功 / 失败。失败时文案要说「失败」，不能只靠颜色。
    el('span', {
      class: `ag-pill ag-pill-${status}`,
      'data-part': 'status',
      'data-status': status,
      text: statusLabel(status),
    }),
    // ④ 耗时。运行中没有耗时，但槽位要在 —— 否则五要素变成「成功之后才有」。
    el('span', {
      class: 'ag-dur',
      'data-part': 'duration',
      'data-missing': card.durationMs == null ? 'true' : null,
      text: card.durationMs == null ? '—' : formatDuration(card.durationMs),
    }),
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

  /*
   * ② 参数摘要 —— 让**收起状态**也能分辨「重启 WUHN」与「重启 ALIC」。
   *
   * 这三个值一个都不能省：工具名相同、结果还没回来、耗时都是 0 的两张卡，
   * 唯一的差别就在参数上。没有这一行，用户得点开两张卡对比 JSON 才知道自己批哪台。
   */
  const argParts = Array.isArray(card.argSummary)
    ? card.argSummary.map((part) => ({ key: '', text: String(part) }))
    : argumentSummary(card.args);
  const argsLine = argParts.length
    ? summaryLine(argParts, 'ag-tool-args', 'args')
    // 「无参数」不是留白：留白会被读成「界面没画出来」，而这确实是全部信息。
    : el('p', { class: 'ag-tool-args ag-tool-args-empty', 'data-part': 'args' }, [
      el('span', { class: 'ag-tool-val', text: '无参数' }),
    ]);

  /* ③ 结果摘要 —— 只显示 3–4 个关键数字，不是全部返回。 */
  const summaryParts = Array.isArray(card.summary)
    ? card.summary.map((part) => ({ key: '', text: String(part) }))
    : resultSummary(card.data);
  const resultLine = summaryParts.length
    ? summaryLine(summaryParts, 'ag-tool-summary', 'result')
    // 运行中：写明「等待返回」，不空着 —— 空着分不清「还没回」与「回了但没摘要」。
    : el('p', { class: 'ag-tool-summary ag-tool-summary-pending', 'data-part': 'result' }, [
      el('span', { class: 'ag-tool-val', text: status === 'running' ? '等待返回…' : '返回里没有可摘要的标量' }),
    ]);

  /*
   * 失败时的原因（`note`）与**真实错误分类**。
   *
   * agent server 的 `tool_result` 形如
   *   {"ok": false, "summary": "未获批准，工具未执行", "data": {}, ...}
   * `data` 是空的，真正要看的是 `summary` 那句。只显示「失败」而不给原因，
   * 用户没法判断是「没批准」还是「工具坏了」—— 这两种的处理方式完全不同。
   *
   * 分类（`errorClass`）来自紧随其后的 `error` 事件（`{"type":"error","class":...}`），
   * 由 chat.js 接到这张卡上。分类是**分派动作**的依据：「输入参数不合法」改一句重发，
   * 「环境不通」去看服务。所以它必须显示，且不能糊成「出错了」。
   */
  const noteLine = card.note
    ? el('p', { class: 'ag-tool-note' }, [el('span', { text: card.note })])
    : null;

  const classLine = status === 'failed'
    ? el('p', {
      class: 'ag-tool-error-class',
      'data-error-class': card.errorClass || null,
      'data-missing': card.errorClass ? null : 'true',
    }, [
      el('span', { class: 'ag-tool-error-class-label', text: '错误分类' }),
      el('code', {
        class: 'ag-tool-error-class-value',
        // 后端没给分类就说「未提供分类」，**不编一个 execution 糊过去** ——
        // 那会让人以为分类系统在工作，实际只是默认值。
        text: card.errorClass ? errorClassLabel(card.errorClass) : '未提供分类',
      }),
      card.errorClass && card.errorClass !== errorClassLabel(card.errorClass)
        ? el('code', { class: 'ag-tool-error-class-raw', text: card.errorClass })
        : null,
    ])
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
    'data-error-class': card.errorClass || null,
    // call_id 同时进属性：回源跳转与测试都按它找，不必去解析背景小字。
    'data-call-id': card.callId || null,
  }, [
    head,
    argsLine,
    resultLine,
    noteLine,
    classLine,
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
 * 审批卡 —— 四个必需元素（规格 25.9.1 + 6.3），每个都带 `data-part`。
 *
 * | # | 元素 | `data-part` | 为什么 |
 * |---|---|---|---|
 * | 1 | 谁申请 | `who` | 「谁批的」有记录（`decidedBy`）而「谁要的」没有，事后追不出高风险操作的来源 |
 * | 2 | 要做什么 + **后果** | `what` | 两件事**必须分开写** —— 「归档」听起来无害，但「写 120 MB 到磁盘」可能是用户不想的 |
 * | 3 | 风险等级 | `risk` | `[高风险]` 这样的标，一眼看出轻重 |
 * | 4 | 批准 / 拒绝 | `decision` | 批准在前（大概率是批准），但拒绝不做成红色大按钮（会让人不敢拒绝） |
 *
 * 另有不在四要素内但必须有的：查看证据（让用户能当场核对，而不是盲批）。
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
      // ③ 风险等级。
      el('span', {
        class: `ag-risk ag-risk-${card.risk || 'medium'}`,
        'data-part': 'risk',
        text: riskLabel(card.risk),
      }),
      card.callId ? el('code', { class: 'ag-call-id', text: card.callId }) : null,
    ]),
    /*
     * ① 谁申请 —— 四要素里的「申请人」。
     *
     * 字段是后端的 `requested_by`（`runtimes/impl.py` 的 `can_use_tool` 回调就这么发）。
     * 没有它，「谁批的」有记录（`decidedBy`）而「谁要的」没有 —— 事后追一条高风险
     * 操作是从哪来的，只能靠猜。所以这一行**恒定存在**：没给就明写「未提供申请方」，
     * 不填「系统」糊过去（那会让「不知道谁要的」看起来像「系统要的」）。
     */
    el('p', {
      class: 'ag-approval-who',
      'data-part': 'who',
      'data-missing': card.requestedBy ? null : 'true',
    }, [
      el('span', { class: 'ag-approval-who-label', text: '申请方' }),
      card.requestedBy
        ? el('code', { class: 'ag-approval-who-value', text: card.requestedBy })
        : el('span', { class: 'ag-approval-who-value', text: '未提供申请方' }),
    ]),
    // ② 做什么 —— 与「后果」分两行写，这是 25.9.1 点明的要求。
    el('p', { class: 'ag-approval-prompt', 'data-part': 'what' }, [
      el('span', {
        class: 'ag-approval-what',
        // 后端连 prompt 都没给时也不能留白：那一格是「要做什么」，
        // 空着等于让用户盲批。
        text: card.prompt || '（后端没有给出动作描述）',
      }),
    ]),
    // 「为什么要审批」是第三个问题，与「做什么 / 后果」都不同。
    // 后端给了 `reason` 就单独一行 —— 混进 prompt 会让人读不出重点。
    card.reason ? el('p', { class: 'ag-approval-reason' }, [
      el('span', { class: 'unit', text: '依据' }),
      el('span', { text: card.reason }),
    ]) : null,
    // 「影响」只在后端真给了 `impact` 时显示。没有就不编 ——
    // 把 `reason` 混进来会让人以为「用户要求重启」等于「会中断采集」。
    card.impact ? el('p', { class: 'ag-approval-impact' }, [
      el('span', { class: 'ag-approval-impact-label', text: '影响' }),
      el('span', { text: card.impact }),
    ]) : null,
    pending ? noteField : null,
    pending ? reasonField : null,
    reasonError,
    // ④ 批准 / 拒绝两个动作（外加「查看证据」，它让用户能当场核对而不是盲批）。
    el('div', { class: 'ag-actions', 'data-part': 'decision' }, [...buttons, evidence]),
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
