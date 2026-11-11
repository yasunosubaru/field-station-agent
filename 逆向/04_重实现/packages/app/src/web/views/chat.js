/**
 * 对话视角 —— Bot-9：自由对话 + 下钻。
 *
 * ## 结构（照 Claude Code / OpenChamber 的对话台）
 *
 *   ┌──────────┬───────────────────────────────┬─────────┐
 *   │ 会话侧栏 │ 消息流（用户 / 助手 / 工具 / 审批）│ 右栏    │
 *   │ 新建会话 │ …                             │ 工具数  │
 *   │ 会话列表 │ 输入区（Ctrl+Enter 发送）      │ 耗时    │
 *   └──────────┴───────────────────────────────┴─────────┘
 *
 * 左栏与中栏由本文件画（`main` 里再分两列），右栏仍交给外壳的 `renderRail`。
 *
 * ## 它接的是什么
 *
 * `/api/agent/*`（Node 代理 → `tools/agent_server.py`，30 个工具、会话与设置都现成）。
 *
 *   · **自由对话**：发一句 → 建会话（或复用）→ SSE 流式回包 → 消息与工具卡进流；
 *   · **下钻**：选中某个任务步之后，消息发到**那一步的会话**里，而不是新开一个；
 *   · **回看**：左侧点一个历史会话 → `GET /sessions/:id` 的 `events` 折回同一套卡片。
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
  buildCards,
  relativeTime,
  sessionTitle,
  sortSessions,
} from '../agent/model.js';
import {
  renderMessage,
  renderToolCard,
  renderApprovalCard,
  renderErrorCard,
} from '../agent/cards.js';

/** agent server 的接口前缀（Node 代理会转发到 Python）。 */
export const AGENT_PREFIX = '/api/agent';

/** 输入区的一行提示。写在界面上而不是只写 placeholder —— 回车语义必须能被看见。 */
export const KEY_HINT = 'Ctrl+Enter 发送 · Enter 换行';

/** 一次会话在界面上的一份快照。 */
function emptyThread() {
  return { sessionId: '', title: '', cards: [], streaming: false };
}

/**
 * 一个值 → 折起来给人看的文本。
 *
 * `undefined` / `null` 各自说清是哪一种：前者是「还没有这个字段」，后者是「字段是空值」。
 * 两种都印「—」会让「工具还没返回」与「工具返回了 null」看起来一样。
 */
function serialize(value) {
  if (value === undefined) return '（暂无）';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 复制到剪贴板。够用就返回 true；失败**不抛**，由调用方决定怎么提示。 */
async function copyText(value) {
  const text = String(value == null ? '' : value);
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒 / 非安全上下文：往下走兜底 */
  }
  // 兜底：临时 textarea + execCommand。Electron 里这条反而是常走的那条。
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    document.body.appendChild(holder);
    holder.select();
    const ok = document.execCommand('copy');
    holder.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
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
  /**
   * 哪些折叠块是展开的，键是 `${卡片 id}:${槽}`。
   *
   * 与 `expanded` 分开：`expanded` 管的是 `renderToolCard` 自己那块 trace 折叠区，
   * 这里的两个槽（入参 / 返回）是对话台额外画的。两件事混用一个 Set，
   * 就会出现「展开了入参，trace 也莫名其妙张开了」。
   */
  let openFolds = new Set();
  let controller = null;
  /** 待发送的附件（占位：后端没有上传端点，只把文件名当文字带上去）。 */
  let attachments = [];
  /** 左侧会话列表的快照。 */
  let sessions = [];
  let sessionsNote = '';
  let copySeq = 0;

  /* —— 页头：视角名 + 会话标题 + 操作（附录 C.7「对话 → 会话标题」） —— */
  const titleEl = el('span', { cls: 'vw-view-context', data: { sessionTitle: '' }, text: '新会话' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '对话' }),
    titleEl,
    el('div', { cls: 'vw-view-head-actions', children: [
      button('清空', { variant: 'text', data: { action: 'clear' }, title: '清空当前会话的界面（服务端的会话记录不动）' }),
    ] }),
  );

  /* ================================================================
   * 三栏骨架
   * ================================================================ */

  const sessionList = el('ul', { cls: 'vw-chat-session-list', data: { chatSessionList: '' }, attr: { role: 'list' } });

  const newSessionBtn = button('新建会话', {
    variant: 'primary',
    data: { chatNewSession: '' },
    title: '清掉当前界面，下一句会开一个新会话',
  });

  const sidebar = el('aside', {
    cls: 'vw-chat-sessions',
    data: { chatSessions: '' },
    attr: { 'aria-label': '会话' },
  }, [
    el('div', { cls: 'vw-chat-sessions-head', children: [
      el('h2', { cls: 'vw-chat-sessions-title', text: '会话' }),
      newSessionBtn,
    ] }),
    sessionList,
  ]);

  /* —— 消息流 —— */
  const stream = el('div', { cls: 'vw-chat-stream', data: { chatStream: '' }, attr: { role: 'log', 'aria-live': 'polite' } });

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

  /* ================================================================
   * 输入区
   * ================================================================ */

  const input = el('textarea', {
    cls: 'vw-chat-input',
    attr: {
      rows: '2',
      placeholder: '输入…（Ctrl+Enter 发送）',
      'aria-label': '输入消息',
      'aria-describedby': 'vw-chat-key-hint',
    },
  });

  const send = button('发送', { variant: 'primary', data: { chatSend: '' } });

  /*
   * 附件：**占位但真的有 handler**。
   *
   * 后端目前没有上传端点，所以这里不假装上传成功 —— 选中的文件名变成 chip、
   * 标「未上传」，并在发送时作为一行文字带进消息里。用户知道发生了什么，
   * 模型也知道这几个文件只是名字。
   */
  const filePicker = el('input', {
    cls: 'vw-chat-file',
    attr: { type: 'file', multiple: true, hidden: '', 'aria-label': '选择附件' },
  });
  const attachBtn = button('附件', {
    variant: 'quiet',
    data: { chatAttach: '' },
    title: '选择附件（后端暂无上传端点，只把文件名作为文字带进消息）',
  });

  const clearInputBtn = button('清空输入', {
    variant: 'quiet',
    data: { chatClearInput: '' },
    title: '只清输入框与附件，不动会话',
  });

  const chips = el('ul', { cls: 'vw-chat-attachments', data: { chatAttachments: '' }, attr: { hidden: '' } });

  const composer = el('form', {
    cls: 'vw-chat-composer',
    attr: { 'data-chat-composer': '' },
    children: [
      chips,
      el('div', { cls: 'vw-chat-composer-row', children: [input, send] }),
      el('div', { cls: 'vw-chat-composer-tools', children: [
        attachBtn,
        clearInputBtn,
        filePicker,
        el('span', { cls: 'vw-chat-key-hint', attr: { id: 'vw-chat-key-hint' }, text: KEY_HINT }),
      ] }),
    ],
  });

  const gateNote = el('p', { cls: 'ag-gate-note', attr: { hidden: '' }, role: 'status' });
  const composerHost = el('div', { cls: 'vw-chat-composer-host' }, [gateNote, composer]);

  const column = el('section', { cls: 'vw-chat-main', data: { chatMain: '' } }, [stream, composerHost]);

  const shell = el('div', { cls: 'vw-chat', data: { chatShell: '' } }, [sidebar, column]);

  main.append(shell);
  paintEmpty();
  renderAttachments();
  paintSessions();

  /* ================================================================
   * 渲染消息
   * ================================================================ */

  /** 卡片 id 前缀：同一个会话里多次刷不冲突。 */
  let cardSeq = 0;
  const nextCardId = () => `c${++cardSeq}`;

  /**
   * 重画消息流。
   *
   * ## 一个必须记住的坑（`input.disabled` 卡死）
   *
   * 这里曾经是「空流就 `paintEmpty(); return;`」—— 于是**审批门不会被重新同步**。
   * 表现：审批卡未决时输入框被禁用，此时点「清空」（或下钻、退出下钻），消息流空了，
   * 但输入框**永久停在 disabled**。页面上明明没有任何审批卡可点，用户却敲不进字；
   * 而点示例按钮仍然有效（它是脚本直接写 `.value`，绕过键盘）——
   * 正是「click 有效、打字无效」那个症状。
   *
   * 所以 `syncApprovalGate()` 必须在**空流分支之外**调用，一次都不能省。
   */
  function paintThread() {
    if (!thread.cards.length) {
      paintEmpty();
    } else {
      const nodes = thread.cards.map((card) => {
        switch (card.type) {
          case 'message':
            return paintMessage(card);
          case 'tool':
            return paintTool(card);
          case 'approval':
            return renderApprovalCard(card, {
              onApproval: decideApproval,
              onEvidence: (item) => {
                // 证据就在同名 call_id 的工具卡里。滚到它并展开。
                const target = thread.cards.find((entry) => entry.type === 'tool' && entry.callId === item.callId);
                if (target) {
                  expanded.add(target.id);
                  paintThread();
                  stream.querySelector(`[data-card-id="${target.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
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
    }

    // 审批未决时禁用输入框（规矩一）。空流也要同步 —— 否则门永远开着。
    syncApprovalGate();
    syncSending();
    // 右栏的工具调用数 / 总耗时 / 证据 call_id 都随消息流变，这里一并刷新。
    ctx.repaintRail();
    // 新消息进来时贴到底部 —— 但只在用户本来就在底部时才贴，别抢滚动。
    stream.scrollTop = stream.scrollHeight;
  }

  /**
   * 一条消息。
   *
   * 用户 / 助手的视觉区分由 `agent/cards.js` 的 `.ag-msg-user` / `.ag-bubble-user` 决定
   * （用户靠右、有底色；助手占满宽）。这里只补一件卡片模块不该管的事：
   * **流式生成时末尾的光标** —— 它是「还在写」的唯一实时证据。
   */
  function paintMessage(card) {
    const node = renderMessage(card);
    if (card.role !== 'user' && card.streaming) {
      const bubble = node.querySelector?.('.ag-bubble');
      if (bubble) {
        bubble.append(el('span', { cls: 'vw-chat-cursor', data: { chatCursor: '' }, attr: { 'aria-hidden': 'true' } }));
      }
    }
    return node;
  }

  /* ================================================================
   * 工具卡：卡片本身 + 两折详情 + 可复制的 call_id
   * ================================================================ */

  /**
   * 一张工具卡 = `renderToolCard` 画的那张 + 下面这条详情带。
   *
   * ## 为什么详情带放在卡片外面
   *
   * `cards.js` 的折叠区把「入参 + 返回」合成一段 JSON 展示，那是**trace 视角**（全量）。
   * 这里要的是两个各自独立的折叠：入参、返回 —— 看「我批准的是什么参数」时不该被
   * 一大段返回挤走。两者用途不同，所以不做成同一个折叠；`查看 trace` 仍然展开全量。
   *
   * 卡片本身只有一张（`[data-card-type="tool"]` 仍然只出现一次），
   * 详情带是它的兄弟节点，不嵌套 —— 免得同一份数据被画两遍还互相干扰折叠状态。
   */
  function paintTool(card) {
    const article = renderToolCard(card, {
      isExpanded: (id) => expanded.has(id),
      setExpanded: (id, open) => { if (open) expanded.add(id); else expanded.delete(id); },
      onTrace: (tool) => {
        // 「查看 trace」= 展开这张卡自己的折叠区。没有独立的 trace 面板时
        // 就地展开是最诚实的做法 —— 它确实就是那次调用的完整返回。
        expanded.add(tool.id);
        paintThread();
      },
    });

    const detail = el('div', { cls: 'vw-chat-tool-detail', data: { toolDetail: card.id } }, [
      paintFold('入参', serialize(card.args), 'args', card.id),
      paintFold('返回', serialize(card.data), 'result', card.id),
      card.callId ? paintCallId(card.callId) : null,
    ]);

    return el('div', { cls: 'vw-chat-tool', data: { toolWrap: card.id } }, [article, detail]);
  }

  /** 一个折叠块：按钮 + 默认收起的内容。 */
  function paintFold(label, text, slot, ownerId) {
    const key = `${ownerId}:${slot}`;
    const open = openFolds.has(key);
    const body = el('pre', { cls: 'vw-chat-fold-body', attr: { hidden: open ? null : '' }, text });
    const headBtn = el('button', {
      cls: `vw-chat-fold-head${open ? ' is-open' : ''}`,
      text: label,
      attr: { type: 'button', 'aria-expanded': open ? 'true' : 'false' },
      data: { fold: slot, foldOwner: ownerId },
    });
    headBtn.addEventListener('click', () => {
      const nowOpen = headBtn.getAttribute('aria-expanded') === 'true';
      headBtn.setAttribute('aria-expanded', nowOpen ? 'false' : 'true');
      // 当场同步折叠体：只改状态不重画，点开要立刻看到内容。
      body.hidden = nowOpen;
      headBtn.classList.toggle('is-open', !nowOpen);
      // 状态也要落进 openFolds —— 否则下一次重画会把用户刚展开的那块收回去。
      if (nowOpen) openFolds.delete(key);
      else openFolds.add(key);
    });
    return el('div', { cls: 'vw-chat-fold', data: { foldSlot: slot } }, [headBtn, body]);
  }

  /**
   * 证据行：call_id + 复制。
   *
   * 规格 6.3 规矩三 —— call_id 是回源的唯一入口，所以它必须**能被拿走**
   * （贴进工单、贴进日志），而不只是能被看见。复制失败也说出来，不静默。
   */
  function paintCallId(callId) {
    const copy = el('button', {
      cls: 'vw-chat-copy',
      text: '复制',
      attr: { type: 'button', 'aria-label': `复制 call_id ${callId}` },
      data: { copyCall: callId },
    });
    copy.addEventListener('click', async () => {
      const ok = await copyText(callId);
      copy.textContent = ok ? '已复制' : '复制失败';
      copy.dataset.copied = ok ? 'true' : 'false';
      const token = ++copySeq;
      setTimeout(() => {
        if (token !== copySeq) return;
        copy.textContent = '复制';
        delete copy.dataset.copied;
      }, 1400);
    });
    return el('p', { cls: 'vw-chat-evidence' }, [
      el('span', { cls: 'vw-chat-evidence-label', text: 'call_id' }),
      el('code', { cls: 'ag-call-id', text: callId }),
      copy,
    ]);
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
   *
   * 为什么判断依据只能是「消息流里有没有未决卡」：另存一份 `pendingApproval` 布尔，
   * 就会在清空 / 下钻 / 换会话时漏掉复位 —— 那正是输入框被锁死的那条路。
   */
  function syncApprovalGate() {
    const pending = thread.cards.find((card) => card.type === 'approval' && card.status === 'pending');
    const blocked = Boolean(pending);
    input.disabled = blocked;
    composer.classList.toggle('is-gated', blocked);
    syncGateNote(blocked);
  }

  function syncGateNote(blocked) {
    if (blocked) {
      gateNote.hidden = false;
      gateNote.textContent = '需要先处理上面的审批 — 批准或拒绝之后才能继续发消息。';
      return;
    }
    gateNote.hidden = true;
    gateNote.textContent = '';
  }

  /**
   * 发送中：只禁「发送」与「附件」。
   *
   * **不禁输入框**。理由有两条：一是这一版最容易踩的坑就是输入框被锁死（见 paintThread），
   * 二是生成中用户往往已经在写下一句，锁掉文本域等于逼他等。回车在生成中会被
   * `sendMessage` 挡掉，所以不会并发两条请求。
   */
  function syncSending() {
    const busy = thread.streaming;
    send.disabled = busy;
    attachBtn.disabled = busy;
    composer.classList.toggle('is-busy', busy);
    composer.setAttribute('aria-busy', busy ? 'true' : 'false');
    send.textContent = busy ? '生成中…' : '发送';
  }

  /* ================================================================
   * 左侧：会话列表
   * ================================================================ */

  function paintSessions() {
    const rows = sortSessions(sessions).filter((item) => item && item.id);
    if (!rows.length) {
      sessionList.replaceChildren(el('li', { cls: 'vw-chat-session-empty' }, [
        el('p', {
          cls: 'vw-chat-session-empty-text',
          text: sessionsNote || '还没有会话。发一句就会建一个。',
        }),
      ]));
      return;
    }
    sessionList.replaceChildren(...rows.map((session) => {
      const active = session.id === thread.sessionId;
      const open = el('button', {
        cls: 'vw-chat-session-open',
        attr: { type: 'button', 'aria-current': active ? 'true' : null },
        data: { sessionId: session.id },
        children: [
          el('span', { cls: 'vw-chat-session-title', text: sessionTitle(session) }),
          el('span', { cls: 'vw-chat-session-time unit', text: relativeTime(session.updated_at) || '—' }),
        ],
      });
      open.addEventListener('click', () => { void openSession(session.id); });
      return el('li', {
        cls: `vw-chat-session${active ? ' is-active' : ''}`,
        data: { sessionRow: session.id },
        children: [open],
      });
    }));
  }

  async function loadSessions() {
    try {
      const response = await fetch(`${AGENT_PREFIX}/sessions`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      sessions = Array.isArray(body?.sessions) ? body.sessions : [];
      sessionsNote = '';
    } catch (error) {
      // 列表拉不到不是致命错误：仍能新建会话并发消息。但要说出来，不能空着了事。
      sessions = [];
      sessionsNote = `会话列表没拉到（${error && error.message ? error.message : String(error)}）。仍可直接发消息。`;
    }
    paintSessions();
  }

  /**
   * 打开一个历史会话。
   *
   * `GET /sessions/:id` 返回 `{session, events}`；`events` 用 `agent/model.js` 的
   * `buildCards` 折回同一套卡片 —— 回放与实时走同一份渲染函数，界面上不会出现
   * 「历史会话长得不一样」。
   *
   * 回放出来的 `call_id` 在 `evidence.call_id` 里（与实时事件同一处），补到卡片上，
   * 右栏的证据列表才认得它。
   */
  async function openSession(sessionId) {
    if (!sessionId) return;
    controller?.abort();
    try {
      const response = await fetch(`${AGENT_PREFIX}/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      thread = emptyThread();
      // 换了一个会话：上一条会话里展开的卡不该继续张着（它们已经不在列表里了）。
      expanded = new Set();
      openFolds = new Set();
      thread.sessionId = (body?.session && (body.session.id || body.session.session_id)) || sessionId;
      thread.title = (body?.session && body.session.title) || '';
      thread.cards = replayCards(body?.events);
      revokeCopyTokens();
      titleEl.textContent = thread.title || `会话 ${String(thread.sessionId).slice(0, 8)}`;
    } catch (error) {
      thread.cards.push({
        type: 'error',
        id: nextCardId(),
        message: `这个会话没有打开：${error && error.message ? error.message : String(error)}。可以点「新建会话」重开一个。`,
        errorClass: 'network',
        ts: new Date().toISOString(),
      });
    }
    paintThread();
    paintSessions();
  }

  /** `events` → 卡片。复用 agent/model.js 的事件折叠，回放与实时同一套字段。 */
  function replayCards(events) {
    const cards = buildCards(Array.isArray(events) ? events : []);
    let seq = 0;
    return cards.map((card) => {
      seq += 1;
      const next = { ...card, id: card.id || `h${seq}` };
      if (next.type === 'tool') {
        const evidenceId = next.evidence && next.evidence.call_id;
        next.callId = evidenceId || next.callId || '';
        // 回放里失败原因的原文在 summary（与实时 tool_result 同一字段）。
        if (next.status === 'failed' && !next.note && typeof next.summary === 'string') next.note = next.summary;
      }
      return next;
    });
  }

  function revokeCopyTokens() {
    copySeq += 1;
  }

  /** 开一个新会话：只清界面，服务端的会话等第一句话才建。 */
  function resetThread() {
    controller?.abort();
    revokeCopyTokens();
    thread = emptyThread();
    expanded = new Set();
    openFolds = new Set();
    titleEl.textContent = state.get().selectedTaskId ? `下钻 ${state.get().selectedTaskId}` : '新会话';
    paintThread();
    paintSessions();
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

    /*
     * 附件只是**名字**：后端没有上传端点，所以把文件名作为一行文字带上去，
     * 让模型知道自己看到的是什么，也让审计里留下「这句话提到了哪些文件」。
     */
    const carried = attachments.length
      ? `（附件（未上传）：${attachments.map((file) => file.name).join('、')}）\n`
      : '';
    const outgoing = carried + text;

    // 先把用户这句话贴上去：等回包再贴会让人觉得「点了没反应」。
    thread.cards.push({ type: 'message', id: nextCardId(), role: 'user', content: outgoing, ts: new Date().toISOString() });
    thread.streaming = true;
    send.disabled = true;
    input.value = '';
    attachments = [];
    renderAttachments();
    paintThread();

    controller = new AbortController();
    try {
      const sessionId = await ensureSession();
      if (!sessionId) throw new Error('会话没有 id');
      // 会话刚建好：右栏要显示它的 id（那是「这一轮属于哪个会话」的唯一凭据），
      // 左侧列表也要把它排进来（新建的会话下一次刷新才在服务端出现，先本地补一条）。
      rememberSession(sessionId, outgoing);
      ctx.repaintRail();
      paintSessions();

      const response = await fetch(`${AGENT_PREFIX}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ text: outgoing }),
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

  /** 新会话在服务端已存在之后，本地先把它放进列表，不必等下一次全量刷新。 */
  function rememberSession(sessionId, firstText) {
    const existing = sessions.find((item) => item.id === sessionId);
    const title = firstText.split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
    const row = { id: sessionId, title: title.slice(0, 24), updated_at: new Date().toISOString() };
    if (existing) Object.assign(existing, row);
    else sessions.unshift(row);
    thread.title = row.title;
    titleEl.textContent = row.title || `会话 ${String(sessionId).slice(0, 8)}`;
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
       * 而那正是审计最需要留着的那两行。
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
      // 一轮结束后刷新一次列表：服务端刚把 updated_at / 标题写好。
      void loadSessions();
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
    openFolds = new Set();
    revokeCopyTokens();
    titleEl.textContent = `下钻 ${taskId}`;
    paintThread();
    paintSessions();
    input.focus();
  }

  /* ================================================================
   * 右栏
   * ================================================================ */

  ctx.renderRail((rail) => {
    const selected = state.get().selectedTaskId;
    const toolCards = thread.cards.filter((card) => card.type === 'tool');
    const totalMs = toolCards
      .filter((card) => typeof card.durationMs === 'number')
      .reduce((sum, card) => sum + card.durationMs, 0);
    const callIds = toolCards
      .filter((card) => card.callId)
      .map((card) => card.callId);

    // 「退出下钻」的按钮每次重建，所以监听要绑在**新建的那颗**上，
    // 而不是绑在 rail 容器上一次就以为管用（容器内容会被整体替换）。
    const exitButton = button('退出下钻', { variant: 'text', data: { action: 'exit-drill' } });
    exitButton.addEventListener('click', () => {
      state.set({ selectedTaskId: null });
      thread = emptyThread();
      expanded = new Set();
      openFolds = new Set();
      revokeCopyTokens();
      titleEl.textContent = '新会话';
      paintThread();
      paintSessions();
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
          ['工具调用', String(toolCards.length)],
          ['总耗时', totalMs ? formatDuration(totalMs) : '—'],
          ['会话', thread.sessionId || '未建'],
          ['状态', thread.streaming ? '生成中' : (thread.sessionId ? '就绪' : '空闲')],
        ]),
      ]),
      section('证据', callIds.length ? `${callIds.length} 条` : null, [
        // 右栏列 call_id（附录 C.2 点四）：用户要能「顺着证据查」。
        // 点一下滚到那张卡 —— 否则几十条 id 只能靠肉眼找。
        callIds.length
          ? el('div', { cls: 'vw-rail-calls' }, callIds.map((id) => el('button', {
            cls: 'vw-rail-call',
            attr: { type: 'button', title: `定位到 call_id ${id} 的卡片` },
            data: { evidenceId: id },
            children: [el('code', { cls: 'ag-call-id', text: id })],
          })))
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
    if (action === 'clear') resetThread();
  });

  newSessionBtn.addEventListener('click', () => {
    resetThread();
    input.focus();
  });

  ctx.rail?.addEventListener?.('click', (event) => {
    if (event.target.closest('[data-action="exit-drill"]')) {
      state.set({ selectedTaskId: null });
      thread = emptyThread();
      expanded = new Set();
      openFolds = new Set();
      revokeCopyTokens();
      titleEl.textContent = '新会话';
      paintThread();
      paintSessions();
      return;
    }
    const evidence = event.target.closest('[data-evidence-id]');
    if (evidence) {
      const id = evidence.dataset.evidenceId;
      const target = thread.cards.find((card) => card.type === 'tool' && card.callId === id);
      if (!target) return;
      expanded.add(target.id);
      // 两个槽都打开：用户点证据是来核对的，「滚过去但内容还收着」等于没核对。
      openFolds.add(`${target.id}:args`);
      openFolds.add(`${target.id}:result`);
      paintThread();
      stream.querySelector(`[data-card-id="${target.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage(input.value);
  });

  /*
   * 发送按钮**必须单独接 click**。
   *
   * 为什么：`button()` 造出来的 `<button>` 没有 `type`，而 HTML 默认在表单里是
   * `type="submit"` —— 但本项目 `button()` 显式写了 `type="button"`（见 dom.js），
   * 于是点它**不触发 form 的 submit 事件**。实测：点击后 `fetch` 一次都没发出
   * （网络面板 reqs 为空），界面停在空态，看起来就是「点了没反应」。
   *
   * 两条路都保留：回车走 submit、点按钮走 click，谁先到都能发。
   */
  send.addEventListener('click', (event) => {
    event.preventDefault();
    void sendMessage(input.value);
  });

  composer.addEventListener('click', (event) => {
    const drop = event.target.closest('[data-action="drop-attach"]');
    if (!drop) return;
    const index = Number(drop.dataset.index);
    if (Number.isInteger(index) && index >= 0) {
      attachments.splice(index, 1);
      renderAttachments();
    }
  });

  attachBtn.addEventListener('click', () => {
    // 真 DOM 上打开文件选择框；桩环境没有 click，静默跳过即可（不是错误）。
    if (typeof filePicker.click === 'function') filePicker.click();
  });

  filePicker.addEventListener('change', () => {
    const picked = Array.from(filePicker.files || []);
    attachments = picked.map((file) => ({ name: file && file.name ? String(file.name) : '未命名文件' }));
    renderAttachments();
    input.focus();
  });

  clearInputBtn.addEventListener('click', () => {
    input.value = '';
    attachments = [];
    renderAttachments();
    input.focus();
  });

  /**
   * 键盘：Ctrl+Enter 发送，Enter 换行。
   *
   * ## 必须先放掉输入法组合态
   *
   * 中文输入时按 Enter 是「上屏」，此时 `keydown` 会带着 `isComposing = true`
   * （或 `keyCode === 229`）。不判它就会在上屏那一下直接发出去半句话 ——
   * 这是中文场景里最典型的「回车把话截断」。
   */
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void sendMessage(input.value);
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

  /* ================================================================
   * 附件 chip
   * ================================================================ */

  /**
   * 重画附件条。
   *
   * 三个信息一个都不能省：文件名（是哪个）、「未上传」（后端没有上传端点，它只是名字）、
   * 移除（选错了要能撤）。少了第二个，用户会以为文件已经传上去了。
   */
  function renderAttachments() {
    chips.hidden = attachments.length === 0;
    if (!attachments.length) {
      chips.replaceChildren();
      return;
    }
    chips.replaceChildren(...attachments.map((file, index) => el('li', {
      cls: 'vw-chat-attach',
      data: { attachIndex: index },
      children: [
        el('span', { cls: 'vw-chat-attach-name', text: file.name }),
        el('span', { cls: 'vw-chat-attach-note unit', text: '未上传' }),
        el('button', {
          cls: 'vw-chat-attach-drop',
          text: '移除',
          attr: { type: 'button', 'aria-label': `移除附件 ${file.name}` },
          data: { action: 'drop-attach', index: String(index) },
        }),
      ],
    })));
  }

  // 首屏拉一次会话列表。拉不到不影响发消息，列表里会写清原因。
  void loadSessions();

  return () => {
    unsubscribe();
    controller?.abort();
  };
}
