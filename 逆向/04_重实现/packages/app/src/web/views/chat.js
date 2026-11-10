/**
 * 对话视角 —— Bot-9：自由对话 + 下钻。
 *
 * ## 它现在是什么
 *
 * 接 `/api/agent/*`（Node 代理 → `tools/agent_server.py`，30 个工具、会话与设置都现成）。
 *
 *   · **自由对话**：发一句 → 建会话（或复用）→ SSE 流式回包 → 消息与工具卡进流；
 *   · **下钻**：选中某个任务步之后，消息发到**那一步的会话**里，而不是新开一个。
 *
 * ## 下钻的关键约束（用户要求的原话）
 *
 * > 下钻**不新开 store，只改 selection**
 *
 * 所以下钻只改 `state.selectedTaskId`（以及会话 id），界面还是同一个界面、
 * 同一份 store、同一份消息流。切走再切回来，对话还在 —— 因为它在 store 里，
 * 不在 DOM 里。
 *
 * ## 为什么消息流自己维护而不交给 agent 模块
 *
 * `web/agent/*` 是**另一套**界面（原版 Agent 工作台，用 iframe 那一版留下的）。
 * 视-0 把中栏改成同一文档换内容之后，两套不能同时渲染同一块。这里重画一份更小的：
 * 只做「消息 + 工具卡 + 审批卡」，卡片复用 `web/agent/cards.js` 的渲染函数，
 * 避免同一张卡有两种长相。
 */

import { el, section, kv, button } from './dom.js';
import { formatDuration } from './state.js';
import {
  renderMessage,
  renderToolCard,
  renderApprovalCard,
  renderErrorCard,
} from '../agent/cards.js';

/** agent server 的接口前缀（Node 代理会转发到 Python）。 */
export const AGENT_PREFIX = '/api/agent';

/** 一次会话在界面上的一份快照。 */
function emptyThread() {
  return { sessionId: '', cards: [], streaming: false };
}

export function mount(ctx) {
  const { main, head, state } = ctx;

  /**
   * 对话自己的一份运行态。
   *
   * 与全局 store 分开的只有「这次会话的消息列表」—— 它是易变的、按会话隔离的。
   * 选中项（`selectedTaskId` / 下钻目标）仍然在全局 store 里共享，
   * 这是「下钻只改 selection」的落点。
   */
  let thread = emptyThread();
  let expanded = new Set();
  let controller = null;

  /* —— 页头：视角名 + 会话标题 + 操作（附录 C.7「对话 → 会话标题」） —— */
  const titleEl = el('span', { cls: 'vw-view-context', data: { sessionTitle: '' }, text: '新会话' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '对话' }),
    titleEl,
    el('div', { cls: 'vw-view-head-actions', children: [
      button('清空', { variant: 'text', data: { action: 'clear' } }),
    ] }),
  );

  /* —— 消息流 —— */
  const stream = el('div', { cls: 'vw-chat-stream', data: { chatStream: '' } });

  /**
   * 空态：三个例子覆盖三类能力（查数据 / 查统计 / 查知识）。
   *
   * 规格 25.1.1 的第一条是「打开就能问」——所以例子必须**填进输入框**而不是别的动作。
   */
  const EXAMPLES = [
    { text: 'WUHN 昨天数据怎么样', kind: '查数据' },
    { text: 'ALIC 这个月的缺测率', kind: '查统计' },
    { text: '帮我查一下规程 4.2 条', kind: '查知识' },
  ];

  function paintEmpty() {
    stream.replaceChildren(el('div', { cls: 'vw-chat-hero', children: [
      el('p', { cls: 'vw-chat-hero-title', text: '野外台站智能体' }),
      el('p', { cls: 'vw-chat-hero-note', text: '问一句开始。' }),
      el('p', { cls: 'vw-chat-hero-examples-label', text: '例：' }),
      el('ul', {
        cls: 'vw-chat-hero-examples',
        children: EXAMPLES.map((example) => el('li', {
          cls: 'vw-chat-hero-example',
          children: [
            el('button', {
              cls: 'vw-chat-example-btn',
              text: example.text,
              attr: { type: 'button' },
              data: { example: example.text },
            }),
            el('span', { cls: 'unit', text: example.kind }),
          ],
        })),
      }),
    ] }));
  }

  /* —— 输入区 —— */
  const input = el('textarea', {
    cls: 'vw-chat-input',
    attr: { rows: '2', placeholder: '输入…（Ctrl+Enter 发送）', 'aria-label': '输入消息' },
  });
  const send = button('发送', { variant: 'primary', data: { action: 'send' } });
  const composer = el('form', {
    cls: 'vw-chat-composer',
    attr: { 'data-chat-composer': '' },
    children: [input, send],
  });

  main.append(stream);
  paintEmpty();

  /* ================================================================
   * 渲染消息
   * ================================================================ */

  /** 卡片 id 前缀：同一个会话里多次刷不冲突。 */
  let cardSeq = 0;
  const nextCardId = () => `c${++cardSeq}`;

  function paintThread() {
    if (!thread.cards.length) {
      paintEmpty();
      return;
    }
    const nodes = thread.cards.map((card) => {
      switch (card.type) {
        case 'message':
          return renderMessage(card);
        case 'tool':
          return renderToolCard(card, {
            isExpanded: (id) => expanded.has(id),
            setExpanded: (id, open) => { if (open) expanded.add(id); else expanded.delete(id); },
            onTrace: (tool) => {
              // 「查看 trace」= 展开这张卡自己的折叠区。没有独立的 trace 面板时
              // 就地展开是最诚实的做法 —— 它确实就是那次调用的完整返回。
              expanded.add(tool.id);
              paintThread();
            },
          });
        case 'approval':
          return renderApprovalCard(card, {
            onApproval: decideApproval,
            onEvidence: (item) => {
              // 证据就在同名 call_id 的工具卡里。滚到它并展开。
              const target = thread.cards.find((entry) => entry.type === 'tool' && entry.callId === item.callId);
              if (target) {
                expanded.add(target.id);
                paintThread();
                stream.querySelector(`[data-card-id="${target.id}"]`)?.scrollIntoView({ block: 'nearest' });
              }
            },
          });
        case 'error':
          return renderErrorCard(card, {});
        default:
          return null;
      }
    }).filter(Boolean);

    stream.replaceChildren(...nodes, ...toolsEmptyNote());
    // 审批未决时禁用输入框（规矩一）。
    syncApprovalGate();
    // 右栏的工具调用数 / 总耗时 / 证据 call_id 都随消息流变，这里一并刷新。
    ctx.repaintRail();
    // 新消息进来时贴到底部 —— 但只在用户本来就在底部时才贴，别抢滚动。
    stream.scrollTop = stream.scrollHeight;
  }

  /**
   * 空态：这一轮**真的一次工具调用都没有**时，明确写一句。
   *
   * ## 为什么不能留白
   *
   * 没有这句，界面上就是「Agent 说了一句话」。而「这一轮没调工具」和
   * 「调了但卡片没画出来」在视觉上完全一样 —— 前者是正常（模型直接答了），
   * 后者是 bug。留白把这两种状态混成一种，出问题时没人能第一眼区分。
   *
   * ## 三个条件缺一不可
   *
   * | 条件 | 少了它会怎样 |
   * |---|---|
   * | 已经有助手回话 | 刚发出消息、还没回话时写「本轮没有工具调用」，是在提前下结论 |
   * | 没有工具卡 | 有工具卡还写这句，就是明着说谎 |
   * | 不在流式生成中 | 生成中本来还没有工具卡，那时写这句同样是在撒谎 |
   *
   * 返回数组而不是节点：调用方直接展开进 `replaceChildren`，不需要判空。
   */
  function toolsEmptyNote() {
    if (thread.streaming) return [];
    const hasAssistant = thread.cards.some((card) => card.type === 'message' && card.role === 'assistant');
    const hasTool = thread.cards.some((card) => card.type === 'tool');
    if (!hasAssistant || hasTool) return [];
    return [el('p', {
      cls: 'vw-chat-tools-empty',
      data: { chatToolsEmpty: '' },
      attr: { role: 'status' },
      text: '本轮没有工具调用',
    })];
  }

  /**
   * 规矩一：审批卡未决时禁用输入框，并说明原因。
   *
   * 为什么必须禁：审批没处理又发一条新消息，会出现「两个操作并发」——
   * 而其中一个还没被批准，事后没人能说清顺序。
   *
   * 为什么还要说明原因：灰掉但不说为什么比不禁用更糟，用户会以为界面坏了。
   */
  function syncApprovalGate() {
    const pending = thread.cards.find((card) => card.type === 'approval' && card.status === 'pending');
    const blocked = Boolean(pending);
    input.disabled = blocked;
    composer.classList.toggle('is-gated', blocked);
    syncGateNote(blocked);
  }

  const gateNote = el('p', { cls: 'ag-gate-note', attr: { hidden: '' }, role: 'status' });
  const composerHost = el('div', { cls: 'vw-chat-composer-host' }, [gateNote, composer]);
  main.append(composerHost);

  function syncGateNote(blocked) {
    if (blocked) {
      gateNote.hidden = false;
      gateNote.textContent = '需要先处理上面的审批 — 批准或拒绝之后才能继续发消息。';
      return;
    }
    gateNote.hidden = true;
    gateNote.textContent = '';
  }

  /* ================================================================
   * 与 agent server 通信
   * ================================================================ */

  /**
   * 建会话。
   *
   * `task_id` 只在**下钻**时带：那时消息要落到那一步的会话里，而不是新开一个。
   * 这是「下钻不新开 store、只改 selection」在后端那一侧的对应动作 ——
   * 界面上什么都没变，只是会话指向换了。
   */
  async function ensureSession() {
    if (thread.sessionId) return thread.sessionId;
    const drill = state.get().selectedTaskId;
    const response = await fetch(`${AGENT_PREFIX}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drill ? { title: `下钻 ${drill}`, task_id: drill } : {}),
    });
    if (!response.ok) throw new Error(`建会话失败：HTTP ${response.status}`);
    const body = await response.json();
    // 实测字段是 `session_id`（不是 `id`）；两种都收，免得下次改名又断。
    thread.sessionId = body.session_id || body.id || '';
    return thread.sessionId;
  }

  /**
   * 发一句话并消费 SSE。
   *
   * 为什么用 SSE 而不是轮询：规格 37.5 要求九种事件同一个出口，而工具卡、审批卡
   * 都是「事件到了就要立刻出现」的东西 —— 轮询会让它们迟一步，而这一步正好是
   * 用户最需要看到「AI 正在调工具」的时候。
   */
  async function sendMessage(text) {
    if (!text.trim() || thread.streaming) return;
    if (thread.cards.some((card) => card.type === 'approval' && card.status === 'pending')) return;

    // 先把用户这句话贴上去：等回包再贴会让人觉得「点了没反应」。
    thread.cards.push({ type: 'message', id: nextCardId(), role: 'user', content: text, ts: new Date().toISOString() });
    thread.streaming = true;
    send.disabled = true;
    input.value = '';
    paintThread();

    controller = new AbortController();
    try {
      const sessionId = await ensureSession();
      if (!sessionId) throw new Error('会话没有 id');
      // 会话刚建好：右栏要显示它的 id（那是「这一轮属于哪个会话」的唯一凭据）。
      ctx.repaintRail();

      const response = await fetch(`${AGENT_PREFIX}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`发送失败：HTTP ${response.status}`);

      await consumeStream(response);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      thread.cards.push({
        type: 'error',
        id: nextCardId(),
        // renderErrorCard 读的是 message / errorClass（见 agent/cards.js），
        // 这里的字段名必须对上，否则卡片会显示「没有给出原因」。
        message: `这一句没有发出去：${error && error.message ? error.message : String(error)}。检查 agent 服务是否在跑（/api/agent/health），然后重试。`,
        errorClass: 'network',
        ts: new Date().toISOString(),
      });
    } finally {
      thread.streaming = false;
      send.disabled = false;
      controller = null;
      paintThread();
    }
  }

  /** 逐条读 SSE。事件格式与 `docs/contracts/agent-events.md` 同一套。 */
  async function consumeStream(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('响应里没有可读的流');

    const decoder = new TextDecoder();
    let buffer = '';
    let assistant = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件。
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = parseSseBlock(raw);
        if (event) assistant = applyAgentEvent(event, assistant);
        split = buffer.indexOf('\n\n');
      }
    }
  }

  /**
   * 一个 SSE 块 → `{ type, data }`；注释行（`: keepalive`）返回 null。
   *
   * 两处实测差异（都吃过亏）：
   *   ① 事件名是通用的 `event: agent`，**真正的类型在 `data.type` 里**；
   *   ② 流式增量叫 `token` + `delta`，不是契约里写的 `text`。
   * 所以类型优先取 `data.type`，取不到才回落到 SSE 的 `event:` 名。
   */
  function parseSseBlock(raw) {
    let sseType = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) sseType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return null;
    const joined = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(joined);
    } catch {
      // 不是 JSON 的 data 行不当成错误：有的实现会发纯文本。
      return { type: sseType, data: { text: joined } };
    }
    const type = (data && typeof data === 'object' && typeof data.type === 'string')
      ? data.type
      : sseType;
    return { type, data };
  }

  /**
   * 把一条事件折进消息流。
   *
   * 九种事件（规格 37.5）：text / tool_call / tool_result / approval_request /
   * approval_result / error / done / token / status。这里认得的那几种各归各位，
   * 认不得的**不丢** —— 记进最后一条消息的 `unknown` 里，方便排查。
   */
  function applyAgentEvent(event, assistant) {
    const { type, data } = event;
    const now = new Date().toISOString();

    /*
     * 流式增量。
     *
     * 实测 agent server 的序列是：
     *   message(user) → token×N → **message(assistant, 完整文本)** → done
     *
     * 所以 `token` 是增量，而最后那条 `message` 是**整段重发**。两者都追加就变成
     * 两份一模一样的话（实测就是这样）。这里让 `message` 走「替换」分支。
     */
    if (type === 'text' || type === 'delta' || type === 'token') {
      const piece = data.text ?? data.delta ?? data.content ?? '';
      if (!piece) return assistant;
      if (!assistant) {
        assistant = { type: 'message', id: nextCardId(), role: 'assistant', content: piece, ts: now, streaming: true };
        thread.cards.push(assistant);
      } else {
        assistant.content += piece;
      }
      paintThread();
      return assistant;
    }

    if (type === 'message') {
      const who = data.role || 'assistant';
      const full = data.content ?? data.text ?? '';
      // 用户那条已经由发消息时贴过了，这里不重复。
      if (who === 'user') return assistant;
      if (!full) return assistant;
      if (assistant) {
        // 完整文本到达：以它为准（它比拼接的增量更可信 —— 增量的分片可能丢一片）。
        assistant.content = full;
        assistant.streaming = false;
      } else {
        assistant = { type: 'message', id: nextCardId(), role: 'assistant', content: full, ts: now, streaming: false };
        thread.cards.push(assistant);
      }
      paintThread();
      return assistant;
    }

    if (type === 'tool_call') {
      thread.cards.push({
        type: 'tool',
        id: nextCardId(),
        name: data.name || '工具',
        // `tool_call` 事件本身**不带 call_id**（实测），它在 `tool_result` 的
        // `evidence.call_id` 里。所以这里先留空，等结果事件按 `id` 匹配回来。
        callId: data.call_id || data.callId || data.evidence?.call_id || '',
        // 事件里的 `id`（如 `c-f4927bff`）是**这次调用的 id**，用来把
        // tool_call 与 tool_result 配成一对 —— 不是 call_id，但同样唯一。
        callRef: data.id || '',
        status: 'running',
        risk: data.risk || '',
        args: data.arguments ?? data.args ?? null,
      });
      paintThread();
      return null;
    }

    if (type === 'tool_result') {
      /*
       * 找到这次调用的那张卡并就地更新 —— 不新加一张，否则一次调用会出现两张。
       *
       * 匹配键有讲究（实测两次才对）：
       *   ① 事件里的 `id`（`c-f4927bff`）在 tool_call 与 tool_result 上是同一个；
       *   ② **call_id 不在顶层**，它在 `evidence.call_id`（如 `t0001`）。
       * 第一版读 `data.call_id` 得到空串，于是匹配不上 —— 表现是卡片永远停在
       * 「运行中」，而消息流已经结束。控制台没有报错，只有一张不动的卡。
       */
      const callId = data.call_id || data.callId || data.evidence?.call_id || '';
      const callRef = data.id || '';
      const card = [...thread.cards].reverse().find((entry) => {
        if (entry.type !== 'tool') return false;
        if (callRef) return entry.callRef === callRef;
        if (callId) return entry.callId === callId;
        return entry.status === 'running';
      }) || [...thread.cards].reverse().find(
        (entry) => entry.type === 'tool' && entry.status === 'running',
      );

      if (card) {
        card.status = data.ok === false || data.error ? 'failed' : 'ok';
        card.data = data.data ?? data.result ?? null;
        card.durationMs = data.duration_ms ?? data.durationMs ?? null;
        // call_id 在结果事件里才出现，补上（它是回源的唯一入口）。
        if (callId) card.callId = callId;
        // 失败时把原因也带上 —— `{"ok":false,"summary":"未获批准，工具未执行"}`
        // 里 summary 才是人要看的那句。
        if (card.status === 'failed' && data.summary) card.note = data.summary;
      }
      paintThread();
      return null;
    }

    /*
     * 审批事件 —— 类型就叫 `approval`（不是 `approval_request`，实测）。
     *
     * 同一条审批会**发两次**：一次 `status: "pending"`，决定后再发一次
     * `status: "rejected"` 带 `decision` / `decided_at` / `note`。
     * 所以按 `id` 复用同一张卡，不能每次新加一张。
     *
     * 字段对应（实测样本）：
     *   {"type":"approval","id":"a-689a55d5","call_id":"c-3d561b10","risk":"high",
     *    "reason":"用户要求重启设备","prompt":"是否允许执行 workflow_run？…",
     *    "status":"pending"}
     * `prompt` 是「做什么」，`reason` 是「为什么」。两者都不是「后果」——
     * 后果得从工具调用的参数推，所以 `impact` 留空时界面不编一个。
     */
    if (type === 'approval' || type === 'approval_request') {
      const approvalId = data.id || data.approval_id || nextCardId();
      const existing = thread.cards.find(
        (entry) => entry.type === 'approval' && entry.id === approvalId,
      );
      const status = data.status === 'pending' ? 'pending' : (data.decision || data.status || 'pending');
      const patch = {
        type: 'approval',
        id: approvalId,
        status,
        risk: data.risk || 'medium',
        // 「做什么」：prompt 已经把那句话写全了，直接用它。
        prompt: data.prompt || data.action || '',
        // 「后果」：后端没给就不编。`reason` 是「为什么」不是「后果」，
        // 混进去会让用户把「用户要求重启」当成「会中断采集」。
        impact: data.impact || data.consequence || '',
        // 为什么要审批 —— 单独一行显示，因为它回答的是另一个问题。
        reason: data.reason || '',
        /*
         * 「谁申请」—— 四要素里的第一个。
         *
         * 真字段是 `requested_by`（`runtimes/impl.py` 的 `can_use_tool` 回调发的就是它）。
         * 后端那条路径没有这个字段时留空，卡片会明写「未提供申请方」——
         * 不填「系统」糊过去，那会让「不知道谁要的」看起来像「系统要的」。
         */
        requestedBy: data.requested_by || data.requestedBy || '',
        callId: data.call_id || data.callId || '',
        args: data.arguments ?? data.args ?? null,
        /*
         * 决定时刻 —— 真字段是 `decided_at`。
         *
         * 决定事件（orchestrator 的第二次 `approval`）带 `decided_at`，但第一版没读它，
         * 于是已决卡永远显示不出「什么时候批的」。审计要能回看，时间戳是必需要的。
         */
        decidedAt: data.decided_at || data.decidedAt || '',
        // 谁批的：`approval` 决定事件不发这个字段（`approval.result` 才发 `by`），
        // 读不到就留空，卡片会退回「操作员」而不是编一个名字。
        decidedBy: data.decided_by || data.decidedBy || data.by || '',
      };
      /*
       * 合并时**空值不覆盖已有值**。
       *
       * 一条审批会发两次：`pending` 一次（带 prompt / reason / requested_by），
       * 决定后一次（只带 status / decision / decided_at）。
       * 无条件 `Object.assign` 会用第二次的空 `requested_by` / `impact` 把第一次的
       * 冲掉 —— 表现是「点了拒绝之后，申请人和后果那两行没了」，
       * 而这正是审计最需要留着的那两行。
       */
      const merge = (target, source) => {
        for (const [key, value] of Object.entries(source)) {
          if (value === '' && target[key]) continue;
          target[key] = value;
        }
      };
      if (existing) merge(existing, patch);
      else thread.cards.push(patch);
      paintThread();
      return null;
    }

    if (type === 'approval_result') {
      const card = thread.cards.find(
        (entry) => entry.type === 'approval' && entry.id === (data.approval_id || data.id),
      );
      if (card) {
        card.status = data.decision || data.status || 'approved';
        card.decidedBy = data.by || '操作员';
        card.decidedAt = now;
      }
      paintThread();
      return null;
    }

    if (type === 'error') {
      /*
       * 错误分类的**真字段是 `class`**，不是 `kind`。
       *
       * 后端 `orchestrator._Emitter.error()` 发的是
       *   {"type": "error", "class": "capability", "message": "...", "ts": "..."}
       * 第一版读 `data.kind` —— 那个字段不存在，于是**每张错误卡都显示 `execution`**，
       * 看起来「有分类」，其实那只是兜底默认值。和 08f10c0 修的三处是同一类错：
       * 字段名猜错 → 不报错 → 静悄悄失效。
       *
       * `kind` 只留作兼容兜底，且排在真字段后面。
       */
      const errorClass = data.class || data.kind || '';
      /*
       * 这条 error 是不是某次工具失败的那半张嘴？
       *
       * orchestrator 对一次工具失败是**先发 `tool_result(ok:false)`、再发 `error`**：
       *   tool_result → {"ok":false, "summary":"未获批准，工具未执行", "data":{}}
       *   error       → {"class":"approval", "message":"未获批准，工具未执行"}
       * 分类只在后一条上。把分类补到那张失败的工具卡上，并**不再另插一张错误卡** ——
       * 同一句话印两遍是噪音，而且会让人以为是两次不同的失败。
       *
       * 只在「最近一张工具卡是失败的、且还没分类」时才这样接，避免把
       * 一句全局的运行错误安到上一次成功调用头上。
       */
      const lastTool = [...thread.cards].reverse().find((entry) => entry.type === 'tool');
      const absorbs = Boolean(lastTool && lastTool.status === 'failed' && !lastTool.errorClass);
      if (absorbs) {
        lastTool.errorClass = errorClass;
      } else {
        thread.cards.push({
          type: 'error',
          id: nextCardId(),
          message: [data.message || '出错', data.code || '', data.hint || ''].filter(Boolean).join(' · '),
          // 没有分类就不编：`renderErrorCard` 会显示「没有给出原因」之外的原样枚举。
          errorClass: errorClass || 'execution',
          ts: now,
        });
      }
      paintThread();
      return assistant;
    }

    if (type === 'done') {
      if (assistant) assistant.streaming = false;
      paintThread();
      return null;
    }

    // 认不得的事件不丢，挂到最后一条消息上 —— 静默丢弃会让「少了一截」无从排查。
    if (assistant) {
      assistant.unknown = assistant.unknown || [];
      assistant.unknown.push(type);
    }
    return assistant;
  }

  /** 审批结论。拒绝必须带理由（规矩二），理由随请求一起上去。 */
  async function decideApproval(card, decision, payload) {
    const sessionId = thread.sessionId;
    if (!sessionId) throw new Error('没有当前会话');
    const response = await fetch(
      `${AGENT_PREFIX}/sessions/${encodeURIComponent(sessionId)}/approval`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_id: card.id,
          decision,
          note: payload?.note || '',
          reason: payload?.reason || '',
        }),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    card.status = decision;
    card.decidedBy = '操作员';
    card.decidedAt = new Date().toISOString();
    paintThread();
  }

  /* ================================================================
   * 下钻
   * ================================================================ */

  /**
   * 下钻到某个任务步。
   *
   * **只改 selection**：`state.selectedTaskId` 换掉，会话 id 清空 —— 下一条消息
   * 会带着新的 `task_id` 建会话。界面、store、消息流都不重开。
   *
   * 为什么清空会话 id 而不复用：会话是按 `task_id` 隔离的，复用会把两个任务的
   * 上下文混在一起 —— 那种混法在审计上查不出来（消息都对，只是不属于同一个任务）。
   */
  function drillInto(taskId) {
    if (!taskId) return;
    state.set({ selectedTaskId: taskId });
    thread = emptyThread();
    expanded = new Set();
    titleEl.textContent = `下钻 ${taskId}`;
    paintThread();
    input.focus();
  }

  /* ================================================================
   * 右栏
   * ================================================================ */

  ctx.renderRail((rail) => {
    const selected = state.get().selectedTaskId;
    const toolCount = thread.cards.filter((card) => card.type === 'tool').length;
    const totalMs = thread.cards
      .filter((card) => card.type === 'tool' && typeof card.durationMs === 'number')
      .reduce((sum, card) => sum + card.durationMs, 0);
    const callIds = thread.cards
      .filter((card) => card.type === 'tool' && card.callId)
      .map((card) => card.callId);

    // 「退出下钻」的按钮每次重建，所以监听要绑在**新建的那颗**上，
    // 而不是绑在 rail 容器上一次就以为管用（容器内容会被整体替换）。
    const exitButton = button('退出下钻', { variant: 'text', data: { action: 'exit-drill' } });
    exitButton.addEventListener('click', () => {
      state.set({ selectedTaskId: null });
      thread = emptyThread();
      expanded = new Set();
      titleEl.textContent = '新会话';
      paintThread();
      ctx.repaintRail();
    });

    rail.replaceChildren(
      section('当前任务', selected ? '下钻中' : null, [
        selected
          ? kv([['任务', selected]])
          : el('p', { cls: 'vw-rail-empty', text: '还没有选中的任务。' }),
        selected ? exitButton : null,
      ]),
      section('本次会话', null, [
        kv([
          ['工具调用', String(toolCount)],
          ['总耗时', totalMs ? formatDuration(totalMs) : '—'],
          ['会话', thread.sessionId || '未建'],
        ]),
      ]),
      section('证据', callIds.length ? `${callIds.length} 条` : null, [
        // 右栏列 call_id（附录 C.2 点四）：用户要能「顺着证据查」。
        callIds.length
          ? el('div', { cls: 'vw-rail-calls' }, callIds.map((id) => el('code', { cls: 'ag-call-id', text: id })))
          : el('p', { cls: 'vw-rail-empty', text: '工具调用之后，这里列出它们的 call_id。' }),
      ]),
    );
  });

  /* ================================================================
   * 事件
   * ================================================================ */

  stream.addEventListener('click', (event) => {
    const example = event.target.closest('[data-example]');
    if (!example) return;
    input.value = example.dataset.example ?? '';
    input.focus();
  });

  head.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'clear') {
      controller?.abort();
      thread = emptyThread();
      expanded = new Set();
      titleEl.textContent = state.get().selectedTaskId ? `下钻 ${state.get().selectedTaskId}` : '新会话';
      paintThread();
      ctx.repaintRail();
      input.focus();
    }
  });

  ctx.rail.addEventListener?.('click', (event) => {
    if (event.target.closest('[data-action="exit-drill"]')) {
      state.set({ selectedTaskId: null });
      thread = emptyThread();
      titleEl.textContent = '新会话';
      paintThread();
    }
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  /* —— 订阅 —— */
  const unsubscribe = state.subscribe((next, changed) => {
    if (changed.has('selectedTaskId')) {
      // 从别处（编队台点了一行、深链进来）改了选中项 → 下钻过去。
      // 这里**不新建任何东西**，只是把会话指过去。
      if (next.selectedTaskId && next.selectedTaskId !== thread.sessionTask) {
        drillInto(next.selectedTaskId);
      }
      ctx.repaintRail();
    }
  });

  titleEl.textContent = state.get().selectedTaskId ? `下钻 ${state.get().selectedTaskId}` : '新会话';

  return () => {
    unsubscribe();
    controller?.abort();
  };
}
