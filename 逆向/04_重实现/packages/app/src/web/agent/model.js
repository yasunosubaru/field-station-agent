/**
 * Agent 工作台 · 纯函数模型层
 *
 * 这个文件里没有任何 DOM、fetch、localStorage 访问：事件 → 卡片模型、会话排序、
 * markdown 安全渲染、工具名 → 图标/标签全都只依赖入参。`node:test` 可以直接
 * `import` 它做断言（不要往这里加浏览器 API）。
 *
 * 事件契约见 docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md §2：
 *   message / tool_call / tool_result / approval / artifact / plan / error / token / done
 * 事件只追加，不改写；同一个 id 的后续事件是对前一条的补全（tool_result 补 tool_call，
 * approval 的第二次出现是决定），这里按 id 就地把卡片更新掉。
 */

/* ================================================================
   ① HTML / markdown
   ================================================================ */

/** 转义成可安全放进 HTML 文本与属性值的字符串 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只放行 http(s) / mailto / 站内绝对路径 / 锚点；其余（javascript:、data: 等）一律降级成文字 */
function isSafeHref(href) {
  const compact = String(href == null ? '' : href)
    .replace(/[\u0000-\u0020\u00a0]+/g, '')
    .toLowerCase();
  if (!compact) return false;
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/.test(compact);
}

function anchorHtml(label, href, plain) {
  const raw = String(href == null ? '' : href).trim();
  const check = plain == null ? raw : String(plain).trim();
  if (!isSafeHref(check)) return label;
  return `<a href="${raw}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function codeBlockHtml(fence) {
  const lang = String(fence.lang || '').trim().split(/[.#\s]/)[0];
  const label = lang ? `<span class="ag-code-lang">${escapeHtml(lang)}</span>` : '';
  return `<div class="ag-code">${label}<pre><code>${fence.body.replace(/\n$/, '')}</code></pre></div>`;
}

/** 行内：code → 链接 → 粗体。输入已转义，输出仍是安全 HTML。 */
function renderInline(text, fences) {
  const codes = [];
  let out = String(text).replace(/`([^`\n]+)`/g, (_match, body) => {
    codes.push(body);
    return `\u0001C${codes.length - 1}\u0001`;
  });

  // [文字](地址)：地址不安全时只留文字。安全判定用还原后的明文，输出的仍是转义过的 href。
  out = out.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_match, label, href) => {
    const raw = href
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return anchorHtml(label, href, raw);
  });

  // 裸链接：排除刚生成的 <a href="…"> 里的地址（前面是 " 或 >）
  out = out.replace(/(^|[\s(（])(https?:\/\/[^\s<>()（）"']+)/g, (match, lead, url) => {
    const tail = /[.,;:!?。，；：！？]$/.test(url) ? url.slice(-1) : '';
    const clean = tail ? url.slice(0, -1) : url;
    return `${lead}<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
  });

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  return out.replace(/\u0001C(\d+)\u0001/g, (_match, index) => {
    const body = codes[Number(index)];
    return body === undefined ? '' : `<code>${body}</code>`;
  }).replace(/\u0000F(\d+)\u0000/g, (_match, index) => codeBlockHtml(fences[Number(index)] || { body: '' }));
}

/**
 * 极简 markdown：先整体转义（所以原始 HTML 永远不会生效），再处理
 * 围栏代码块 / 行内 code / 粗体 / 列表 / 标题 / 链接。够读 Agent 的回答，
 * 不引第三方库。
 */
export function renderMarkdown(text) {
  if (text == null || text === '') return '';
  const escaped = escapeHtml(String(text).replace(/\r\n?/g, '\n'));

  const fences = [];
  const withFences = escaped.replace(/```([\w+.#-]*)\n?([\s\S]*?)```/g, (_match, lang, body) => {
    fences.push({ lang, body });
    return `\u0000F${fences.length - 1}\u0000`;
  });

  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map((line) => renderInline(line, fences)).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item) => `<li>${renderInline(item, fences)}</li>`).join('');
    blocks.push(`<${list.tag}>${items}</${list.tag}>`);
    list = null;
  };

  for (const line of withFences.split('\n')) {
    if (/^\u0000F\d+\u0000$/.test(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push(renderInline(line.trim(), fences));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(`<h${level}>${renderInline(heading[2], fences)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(bullet ? bullet[1] : ordered[1]);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push('<hr>');
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.join('\n');
}

/* ================================================================
   ② 工具目录 → 图标 / 中文标签
   ================================================================ */

/** 图标 key 与 web/agent/cards.js 里的 SVG 表对应；未知图标落到 'tool' */
const TOOL_META = {
  station_health: { icon: 'health', label: '台站健康度', risk: 'low' },
  device_heartbeat: { icon: 'health', label: '设备心跳', risk: 'low' },
  robust_stats: { icon: 'chart', label: '稳健统计', risk: 'low' },
  slip_detect: { icon: 'chart', label: '滑移检测', risk: 'low' },
  continuity_verdict: { icon: 'check', label: '连续性判定', risk: 'low' },
  magnitude_verdict: { icon: 'check', label: '幅度判定', risk: 'low' },
  knowledge_search: { icon: 'search', label: '知识检索', risk: 'low' },
  create_work_order: { icon: 'ticket', label: '创建工单', risk: 'medium' },
  list_work_orders: { icon: 'ticket', label: '工单列表', risk: 'low' },
  execute_device_action: { icon: 'device', label: '设备操作', risk: 'high' },
  archive_export: { icon: 'export', label: '归档导出', risk: 'low' },

  native_captures: { icon: 'file', label: '抓包列表', risk: 'low' },
  native_records: { icon: 'file', label: '报文记录', risk: 'low' },
  native_ports: { icon: 'device', label: '串口列表', risk: 'low' },
  native_convert: { icon: 'export', label: '格式转换', risk: 'medium' },
  native_graph_projects: { icon: 'graph', label: '图谱工程', risk: 'low' },
  native_graph_files: { icon: 'graph', label: '图谱文件', risk: 'low' },
  native_graph_pdf: { icon: 'graph', label: '图谱 PDF', risk: 'low' },
  native_live_status: { icon: 'device', label: '实时连接状态', risk: 'low' },
  native_live_connect: { icon: 'device', label: '连接实时链路', risk: 'medium' },
  native_live_command: { icon: 'device', label: '实时指令', risk: 'medium' },
  native_playback_info: { icon: 'playback', label: '回放信息', risk: 'low' },

  workflow_list: { icon: 'workflow', label: '流程目录', risk: 'low' },
  workflow_describe: { icon: 'workflow', label: '流程说明', risk: 'low' },
  workflow_run: { icon: 'workflow', label: '运行流程', risk: 'medium' },
  workflow_status: { icon: 'workflow', label: '流程状态', risk: 'low' },
  workflow_gate: { icon: 'shield', label: '流程审批门', risk: 'high' },
  workflow_resume: { icon: 'workflow', label: '流程恢复', risk: 'medium' },
  workflow_cancel: { icon: 'workflow', label: '取消流程', risk: 'medium' },
  workflow_artifacts: { icon: 'export', label: '流程产物', risk: 'low' },
};

export const TOOL_NAMES = Object.keys(TOOL_META);

/** 工具名 → { icon, label, risk }；没登记的名字原样显示，不编造中文名 */
export function toolMeta(name) {
  const key = String(name == null ? '' : name);
  const known = TOOL_META[key];
  if (known) return { name: key, icon: known.icon, label: known.label, risk: known.risk, known: true };
  return { name: key, icon: 'tool', label: key || '工具', risk: 'low', known: false };
}

export function riskLabel(risk) {
  if (risk === 'high') return '高风险';
  if (risk === 'medium') return '中风险';
  return '低风险';
}

export function statusLabel(status) {
  const table = { running: '运行中', ok: '成功', failed: '失败', approval: '待审批', blocked: '已拒绝' };
  return table[status] || '运行中';
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatClock(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeTime(iso, now) {
  const stamp = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(stamp)) return '';
  const current = Number.isFinite(now) ? now : Date.now();
  const diff = Math.max(0, current - stamp);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  const date = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ================================================================
   ③ 产物 → 专业面板
   ================================================================ */

const KIND_LABELS = { pdf: 'PDF', csv: 'CSV', json: 'JSON', png: 'PNG', html: 'HTML' };

export function artifactKindLabel(kind) {
  return KIND_LABELS[String(kind || '').toLowerCase()] || String(kind || '文件').toUpperCase();
}

const TOOL_PANEL = [
  [/^native_graph_/, 'graph'],
  [/^native_playback_/, 'playback'],
  [/^playback_/, 'playback'],
  [/^workflow_/, 'workflows'],
  [/^archive_export$/, 'workflows'],
  [/^native_(captures|records|ports|convert|live_)/, 'manage'],
  [/^(station_|device_|robust_|slip_|continuity_|magnitude_|knowledge_|create_work_order|list_work_orders)/, 'manage'],
];

const KIND_PANEL = { pdf: 'graph', png: 'graph', csv: 'graph', json: 'manage', html: 'workflows' };

/**
 * 产物该在哪个专业面板打开：先看产出它的工具（证据更准），
 * 没有 source_call 时按 kind 落到 playback|graph|workflows|manage。
 */
export function artifactPanel(artifact) {
  const source = String((artifact && (artifact.source_call_tool || artifact.tool)) || '');
  for (const [pattern, panel] of TOOL_PANEL) {
    if (pattern.test(source)) return panel;
  }
  const kind = String((artifact && artifact.kind) || '').toLowerCase();
  return KIND_PANEL[kind] || 'manage';
}

/* ================================================================
   ④ 事件 → 卡片
   ================================================================ */

function asObjects(items) {
  return Array.isArray(items)
    ? items.filter((item) => item && typeof item === 'object').map((item) => ({
      title: String(item.title == null ? '' : item.title),
      status: ['todo', 'doing', 'done', 'blocked'].includes(item.status) ? item.status : 'todo',
    }))
    : [];
}

function indexOfCard(list, predicate) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (predicate(list[i], i)) return i;
  }
  return -1;
}

function findTool(list, id) {
  const key = String(id == null ? '' : id);
  if (!key) return -1;
  return indexOfCard(list, (card) => card.type === 'tool' && (card.id === key || card.callId === key));
}

/**
 * 追加/更新一张卡片。纯函数：返回新数组，未改动的卡片保持同一引用
 * （UI 靠引用比较只重画变了的那几条）。
 */
export function applyEvent(cards, event) {
  const list = Array.isArray(cards) ? cards.slice() : [];
  if (!event || typeof event !== 'object') return list;
  const type = String(event.type || '');
  const id = event.id == null ? '' : String(event.id);

  if (type === 'meta') return list;

  if (type === 'token') {
    const text = String(event.delta == null ? '' : event.delta);
    const key = id || 'stream';
    let index = indexOfCard(list, (card) => card.type === 'message' && card.id === key);
    if (index < 0) index = indexOfCard(list, (card) => card.type === 'message' && card.role === 'assistant' && card.streaming === true);
    if (index >= 0) {
      const card = list[index];
      list[index] = { ...card, content: (card.content || '') + text, streaming: true };
    } else {
      list.push({ type: 'message', id: key, role: 'assistant', content: text, ts: event.ts || null, streaming: true });
    }
    return list;
  }

  if (type === 'done') {
    return list.map((card) => (card.type === 'message' && card.streaming ? { ...card, streaming: false } : card));
  }

  if (type === 'message') {
    const role = event.role === 'user' ? 'user' : 'assistant';
    const content = String(event.content == null ? '' : event.content);
    // 本地乐观消息与服务端回放的同一条消息合并，避免出现两遍
    if (role === 'user') {
      const pending = indexOfCard(list, (card) => card.type === 'message' && card.role === 'user' && card.pending && card.content === content);
      if (pending >= 0) {
        list[pending] = { ...list[pending], id: id || list[pending].id, content, pending: false, ts: event.ts || list[pending].ts };
        return list;
      }
    }
    const existing = id ? indexOfCard(list, (card) => card.type === 'message' && card.id === id) : -1;
    if (existing >= 0) {
      // 收尾的 message 事件是权威文本，覆盖流式拼出来的那份
      list[existing] = { ...list[existing], content, role, streaming: false, ts: event.ts || list[existing].ts };
      return list;
    }
    list.push({
      type: 'message',
      id: id || `m-${list.length}`,
      role,
      content,
      ts: event.ts || null,
      streaming: false,
    });
    return list;
  }

  if (type === 'tool_call') {
    const meta = toolMeta(event.name);
    const card = {
      type: 'tool',
      id: id || `call-${list.length}`,
      callId: id,
      name: meta.name,
      label: meta.label,
      icon: meta.icon,
      risk: event.risk || meta.risk,
      status: 'running',
      args: event.args == null ? null : event.args,
      ts: event.ts || null,
      summary: '',
      data: null,
      evidence: null,
      ok: null,
      durationMs: null,
    };
    const existing = findTool(list, card.id);
    if (existing >= 0) list[existing] = { ...list[existing], ...card };
    else list.push(card);
    return list;
  }

  if (type === 'tool_result') {
    const index = findTool(list, id);
    const ok = event.ok !== false;
    const patch = {
      status: ok ? 'ok' : 'failed',
      ok,
      summary: String(event.summary == null ? '' : event.summary),
      data: event.data === undefined ? null : event.data,
      evidence: event.evidence || null,
      durationMs: Number.isFinite(Number(event.duration_ms)) ? Number(event.duration_ms) : null,
    };
    if (index >= 0) {
      list[index] = { ...list[index], ...patch };
      return list;
    }
    // 没有对应 tool_call（重放旧会话时可能）就补一张结果卡
    const meta = toolMeta(event.name);
    list.push({
      type: 'tool',
      id: id || `result-${list.length}`,
      callId: id,
      name: meta.name,
      label: meta.label,
      icon: meta.icon,
      risk: event.risk || meta.risk,
      args: null,
      ts: event.ts || null,
      ...patch,
    });
    return list;
  }

  if (type === 'approval') {
    const status = ['approved', 'rejected'].includes(event.status) ? event.status : 'pending';
    const callId = event.call_id == null ? '' : String(event.call_id);
    const key = id || `approval-${list.length}`;
    let index = indexOfCard(list, (card) => card.type === 'approval' && card.id === key);
    if (index < 0 && callId) index = indexOfCard(list, (card) => card.type === 'approval' && card.callId === callId && card.status === 'pending');
    if (index >= 0) {
      list[index] = {
        ...list[index],
        id: key,
        callId: callId || list[index].callId,
        risk: event.risk || list[index].risk,
        reason: event.reason == null ? list[index].reason : String(event.reason),
        prompt: event.prompt == null ? list[index].prompt : String(event.prompt),
        status,
        decidedBy: event.by || list[index].decidedBy || null,
        decidedAt: event.ts || (status === 'pending' ? null : list[index].decidedAt),
        note: event.note == null ? list[index].note : String(event.note),
      };
    } else {
      list.push({
        type: 'approval',
        id: key,
        callId,
        risk: event.risk || 'medium',
        reason: String(event.reason == null ? '' : event.reason),
        prompt: String(event.prompt == null ? '' : event.prompt),
        status,
        ts: event.ts || null,
        decidedBy: event.by || null,
        decidedAt: status === 'pending' ? null : event.ts || null,
        note: event.note == null ? '' : String(event.note),
      });
    }
    // 审批挂在某次工具调用上：调用卡的状态跟着走
    const toolIndex = findTool(list, callId);
    if (toolIndex >= 0) {
      const tool = list[toolIndex];
      if (tool.status !== 'ok' && tool.status !== 'failed') {
        list[toolIndex] = {
          ...tool,
          status: status === 'pending' ? 'approval' : status === 'approved' ? 'running' : 'failed',
        };
      }
    }
    return list;
  }

  if (type === 'artifact') {
    const key = id || String(event.name || `artifact-${list.length}`);
    const index = indexOfCard(list, (card) => card.type === 'artifact' && card.id === key);
    const card = {
      type: 'artifact',
      id: key,
      name: String(event.name || '产物'),
      kind: String(event.kind || '').toLowerCase(),
      path: String(event.path || ''),
      sha256: String(event.sha256 || ''),
      sourceCall: event.source_call == null ? '' : String(event.source_call),
      bytes: Number.isFinite(Number(event.bytes)) ? Number(event.bytes) : null,
      ts: event.ts || null,
    };
    if (index >= 0) list[index] = { ...list[index], ...card };
    else list.push(card);
    return list;
  }

  if (type === 'plan') {
    const items = asObjects(event.items);
    const key = id || 'plan';
    const index = indexOfCard(list, (card) => card.type === 'plan' && card.id === key);
    if (index >= 0) list[index] = { ...list[index], items, ts: event.ts || list[index].ts };
    else list.push({ type: 'plan', id: key, items, ts: event.ts || null });
    return list;
  }

  if (type === 'error') {
    const errorClass = String(event.class || 'execution');
    list.push({
      type: 'error',
      id: id || `error-${list.length}`,
      errorClass,
      message: String(event.message == null ? '' : event.message),
      ts: event.ts || null,
    });
    return list;
  }

  return list;
}

/** 一次性把整段事件（GET /sessions/:id 的返回）折成卡片 */
export function buildCards(events) {
  let cards = [];
  for (const event of Array.isArray(events) ? events : []) cards = applyEvent(cards, event);
  return cards;
}

/* ================================================================
   ⑤ 会话 / 右栏派生数据
   ================================================================ */

export function sortSessions(sessions) {
  return (Array.isArray(sessions) ? sessions.slice() : []).sort((a, b) => {
    const ta = Date.parse((a && a.updated_at) || '') || 0;
    const tb = Date.parse((b && b.updated_at) || '') || 0;
    if (tb !== ta) return tb - ta;
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  });
}

export function sessionTitle(session, alias) {
  if (alias) return String(alias);
  const title = session && session.title ? String(session.title).trim() : '';
  if (title) return title;
  return session && session.id ? `会话 ${String(session.id).slice(0, 8)}` : '未命名会话';
}

/** 从第一句用户消息里取一个会话名（仅用于本地别名/新建时建议的标题） */
export function deriveSessionTitle(text) {
  const first = String(text == null ? '' : text).split('\n').find((line) => line.trim()) || '';
  const plain = first
    .replace(/```+/g, ' ')
    .replace(/[`*_>#\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '新会话';
  return plain.length > 24 ? `${plain.slice(0, 24)}…` : plain;
}

export function recentTools(cards, limit = 6) {
  const tools = (Array.isArray(cards) ? cards : []).filter((card) => card.type === 'tool');
  return tools.slice(-Math.max(0, limit)).reverse();
}

export function collectArtifacts(cards) {
  return (Array.isArray(cards) ? cards : [])
    .filter((card) => card.type === 'artifact')
    .slice()
    .reverse();
}

export function planProgress(card) {
  const items = (card && card.items) || [];
  const done = items.filter((item) => item.status === 'done').length;
  return { done, total: items.length };
}

/** /health 的返回 → 顶栏 chip 文案；ok=false / 缺字段时不编造 */
export function describeHealth(health) {
  if (!health || health.ok === false) {
    return { ok: false, provider: '', model: '', label: 'Agent 未就绪', detail: '—', tools: 0, version: '' };
  }
  const provider = String(health.provider || '');
  const model = String(health.model || '');
  const tools = Array.isArray(health.tools) ? health.tools.length : Number(health.tools) || 0;
  const label = [provider || 'agent', model].filter(Boolean).join(' · ');
  return {
    ok: Boolean(provider || model),
    provider,
    model,
    label: label || 'Agent 就绪',
    detail: tools ? `${tools} 个工具` : '工具目录未知',
    tools,
    version: String(health.version || ''),
  };
}

/** 证据行：agent:call_id（契约 §2 的 evidence 结构） */
export function evidenceText(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const parts = [];
  if (evidence.agent) parts.push(String(evidence.agent));
  if (evidence.call_id) parts.push(String(evidence.call_id));
  return parts.join(':');
}

/* ================================================================
   ⑥ / 命令
   ================================================================ */

export const COMMANDS = [
  { name: 'help', hint: '列出命令与快捷键', kind: 'local' },
  { name: 'health', hint: '检查台站健康度与心跳', kind: 'prompt', prompt: '用 station_health 和 device_heartbeat 检查台站健康度，列出异常并给出建议。' },
  { name: 'qc', hint: '对当前抓包跑质控并给出判定', kind: 'prompt', prompt: '对当前抓包跑一遍质控：robust_stats、slip_detect、continuity_verdict、magnitude_verdict，最后给出结论和证据。' },
  { name: 'export', hint: '把质控结果导出 PDF 归档', kind: 'prompt', prompt: '把最近一次质控结果导出成 PDF 报告并归档，给出产物路径与 sha256。' },
  { name: 'restart', hint: '重启设备（高风险，需审批）', kind: 'prompt', prompt: '重启当前设备。这是高风险操作，先说明影响与回滚方式，再请求审批。' },
  { name: 'new', hint: '新建会话', kind: 'action', action: 'new-session' },
  { name: 'settings', hint: '打开 Agent 设置', kind: 'action', action: 'settings' },
];

/** 以 `/` 开头时返回匹配的命令；否则返回空数组 */
export function matchCommands(text) {
  const value = String(text == null ? '' : text);
  if (!value.startsWith('/')) return [];
  const query = value.slice(1).split(/\s/)[0].toLowerCase();
  return COMMANDS.filter((command) => !query || command.name.startsWith(query) || command.hint.includes(query));
}

/** 输入框里是否刚敲出一个需要弹面板的 `/` 或 `@`（前面是空白或行首） */
export function openTrigger(text, caret) {
  const value = String(text == null ? '' : text);
  const at = Number.isFinite(caret) ? caret : value.length;
  const head = value.slice(0, at);
  const slash = /(^|\s)\/([\w-]*)$/.exec(head);
  if (slash) return { kind: 'command', query: slash[2] };
  const device = /(^|\s)@([^\s@]*)$/.exec(head);
  if (device) return { kind: 'device', query: device[2] };
  return null;
}

/* ================================================================
   ⑦ 建议 chip（空态）
   ================================================================ */

export const SUGGESTIONS = [
  { id: 'health', label: '健康度', hint: '看台站与设备是否正常', prompt: '检查一下台站健康度：调用 station_health 和 device_heartbeat，把异常和证据列出来。' },
  { id: 'qc', label: '质控', hint: '跑一遍数据质控', prompt: '对当前抓包跑质控，给出连续性与幅度判定。' },
  { id: 'pdf', label: '导出 PDF', hint: '把结果做成报告', prompt: '把最近的质控/图谱结果导出成 PDF 报告，并给出下载链接。' },
  { id: 'restart', label: '重启', hint: '高风险，需要审批', prompt: '重启当前设备。先说明影响，再走审批。' },
];
