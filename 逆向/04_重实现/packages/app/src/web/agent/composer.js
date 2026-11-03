/**
 * 输入区：多行自增高、附件（路径文本）、@设备、/ 命令、Enter 发送、Shift+Enter 换行、Esc 取消。
 *
 * 组件只负责"把用户想说的话变成 onSubmit({text, attachments})"，发送/取消/命令语义由 index.js 决定。
 * 附件按契约只传路径文本，不做上传。
 */

import { COMMANDS, matchCommands, openTrigger } from './model.js';

const MAX_HEIGHT = 220;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * @param {object} options
 * @param {(payload:{text:string,attachments:string[]})=>void} options.onSubmit
 * @param {()=>void} [options.onStop]
 * @param {(command:object)=>void} [options.onCommand]
 * @param {()=>boolean} [options.onEscape] 返回 true 表示这次 Esc 已被上层消费（例如收起侧栏）
 * @param {()=>Array<{label:string,value:string,hint?:string}>} [options.devices]
 */
export function createComposer(options = {}) {
  const attachments = [];
  let busy = false;
  let pop = null; // {kind:'command'|'device', items:[], index:0, start:number, end:number}
  let idSeq = 0;

  const listId = `ag-pop-${++idSeq}`;

  const popEl = el('div', {
    class: 'ag-pop',
    id: listId,
    role: 'listbox',
    hidden: true,
    'aria-label': '候选',
  });

  const input = el('textarea', {
    class: 'ag-input',
    rows: '1',
    placeholder: '问问台站：健康度、质控、导出报告… 输入 / 看命令，@ 选设备',
    'aria-label': '给 Agent 的消息',
    'aria-autocomplete': 'list',
    'aria-controls': listId,
    spellcheck: 'false',
    autocomplete: 'off',
  });

  const attachList = el('div', { class: 'ag-attachments', hidden: true });

  const attachInput = el('input', {
    class: 'ag-input-line',
    type: 'text',
    placeholder: '粘贴文件绝对路径，回车添加（只作为文本附件，不上传）',
    'aria-label': '附件路径',
  });
  const attachRow = el('div', { class: 'ag-attach-row', hidden: true }, [
    attachInput,
    el('button', { type: 'button', class: 'ag-btn ag-btn-ghost', text: '添加', onclick: () => commitAttachment() }),
  ]);

  const sendBtn = el('button', {
    type: 'button',
    class: 'ag-btn ag-btn-primary ag-send',
    'data-act': 'send',
    text: '发送',
    disabled: true,
    onclick: () => submit(),
  });
  const stopBtn = el('button', {
    type: 'button',
    class: 'ag-btn ag-btn-danger ag-send',
    'data-act': 'stop',
    text: '停止',
    hidden: true,
    onclick: () => options.onStop?.(),
  });

  const bar = el('div', { class: 'ag-bar' }, [
    el('div', { class: 'ag-bar-left' }, [
      el('button', {
        type: 'button',
        class: 'ag-tool-btn',
        'data-act': 'attach',
        title: '添加附件路径',
        'aria-label': '添加附件路径',
        onclick: () => toggleAttachRow(),
      }, [el('span', { 'aria-hidden': 'true', text: '+' }), document.createTextNode(' 附件')]),
      el('button', {
        type: 'button',
        class: 'ag-tool-btn',
        'data-act': 'device',
        title: '插入设备引用',
        'aria-haspopup': 'listbox',
        onclick: () => {
          input.focus();
          openDevicePopover('');
        },
      }, ['@ 设备']),
      el('button', {
        type: 'button',
        class: 'ag-tool-btn',
        'data-act': 'command',
        title: '命令面板 (Ctrl+K)',
        'aria-haspopup': 'listbox',
        onclick: () => openCommandPalette(),
      }, ['/ 命令']),
    ]),
    el('div', { class: 'ag-bar-right' }, [
      el('span', { class: 'ag-hint', text: 'Enter 发送 · Shift+Enter 换行 · Esc 取消' }),
      stopBtn,
      sendBtn,
    ]),
  ]);

  const wrap = el('div', { class: 'ag-input-wrap' }, [popEl, attachList, input, attachRow, bar]);
  const root = el('div', { class: 'ag-composer' }, [wrap]);

  /* ---------------- 自增高 ---------------- */

  function resize() {
    input.style.height = 'auto';
    const next = Math.min(input.scrollHeight || 0, MAX_HEIGHT);
    input.style.height = `${Math.max(next, 24)}px`;
    input.style.overflowY = (input.scrollHeight || 0) > MAX_HEIGHT ? 'auto' : 'hidden';
  }

  function syncSend() {
    sendBtn.disabled = busy || input.value.trim() === '';
  }

  /* ---------------- 附件 ---------------- */

  function toggleAttachRow(force) {
    const show = force == null ? attachRow.hidden : force;
    attachRow.hidden = !show;
    if (show) attachInput.focus();
  }

  function commitAttachment() {
    const value = attachInput.value.trim();
    if (!value) {
      toggleAttachRow(false);
      return;
    }
    if (!attachments.includes(value)) attachments.push(value);
    attachInput.value = '';
    renderAttachments();
    toggleAttachRow(false);
    input.focus();
  }

  function renderAttachments() {
    attachList.innerHTML = '';
    attachList.hidden = attachments.length === 0;
    attachments.forEach((path, index) => {
      attachList.appendChild(el('span', { class: 'ag-chip', title: path }, [
        el('span', { class: 'ag-chip-text', text: path.split(/[\\/]/).pop() || path }),
        el('button', {
          type: 'button',
          class: 'ag-chip-x',
          'aria-label': `移除附件 ${path}`,
          text: '×',
          onclick: () => {
            attachments.splice(index, 1);
            renderAttachments();
          },
        }),
      ]));
    });
  }

  /* ---------------- 候选面板 ---------------- */

  function positionOfTrigger(text, kind) {
    const caret = input.selectionStart == null ? text.length : input.selectionStart;
    if (kind === 'command') {
      const match = /(^|\s)\/([\w-]*)$/.exec(text.slice(0, caret));
      if (!match) return null;
      const start = caret - match[2].length - 1;
      return { start, end: caret };
    }
    const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
    if (!match) return null;
    return { start: caret - match[2].length - 1, end: caret };
  }

  function paintPopover() {
    popEl.innerHTML = '';
    if (!pop) {
      popEl.hidden = true;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (!pop.items.length) {
      popEl.hidden = false;
      popEl.appendChild(el('div', { class: 'ag-pop-empty', text: pop.kind === 'device' ? '没有发现设备（/api/ports 为空）' : '没有匹配的命令' }));
      return;
    }
    popEl.hidden = false;
    popEl.setAttribute('aria-label', pop.kind === 'device' ? '设备' : '命令');
    pop.items.forEach((item, index) => {
      const option = el('button', {
        type: 'button',
        id: `${listId}-${index}`,
        class: `ag-pop-item${index === pop.index ? ' is-active' : ''}`,
        role: 'option',
        'aria-selected': index === pop.index ? 'true' : 'false',
        onmousedown: (event) => {
          event.preventDefault();
          choose(index);
        },
      }, [
        el('span', { class: 'ag-pop-label', text: item.label }),
        item.hint ? el('span', { class: 'ag-pop-hint', text: item.hint }) : null,
      ]);
      popEl.appendChild(option);
    });
    const active = popEl.querySelector('.is-active');
    if (active) input.setAttribute('aria-activedescendant', active.id);
  }

  function openPopover(kind, items, start, end) {
    pop = { kind, items, index: 0, start, end };
    paintPopover();
  }

  function commandItems(list) {
    return (list || []).map((command) => ({ ...command, label: `/${command.name}` }));
  }

  function closePopover() {
    pop = null;
    paintPopover();
  }

  function openCommandPalette() {
    input.focus();
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const matches = commandItems(matchCommands(input.value.slice(0, start)));
    openPopover('command', matches.length ? matches : commandItems(COMMANDS), start, start);
  }

  function openDevicePopover(query) {
    const devices = typeof options.devices === 'function' ? options.devices() || [] : [];
    const q = String(query || '').toLowerCase();
    const items = devices
      .filter((device) => !q || `${device.label} ${device.value}`.toLowerCase().includes(q))
      .map((device) => ({ label: device.label, hint: device.hint || device.value, value: device.value }));
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    // 没有正在输入的 `@`（从按钮打开）就插到光标处，不要吃掉前面的字
    const range = positionOfTrigger(input.value, 'device') || { start: caret, end: caret };
    openPopover('device', items, range.start, range.end);
  }

  function choose(index) {
    if (!pop) return;
    const item = pop.items[index];
    if (!item) {
      closePopover();
      return;
    }
    if (pop.kind === 'command') {
      const text = input.value;
      input.value = `${text.slice(0, pop.start)}${text.slice(pop.end)}`.trimStart();
      closePopover();
      resize();
      syncSend();
      options.onCommand?.(item);
      return;
    }
    const text = input.value;
    const inserted = `@${item.value} `;
    input.value = `${text.slice(0, pop.start)}${inserted}${text.slice(pop.end)}`;
    const caret = pop.start + inserted.length;
    closePopover();
    input.focus();
    input.setSelectionRange(caret, caret);
    resize();
    syncSend();
  }

  function move(delta) {
    if (!pop || !pop.items.length) return;
    pop.index = (pop.index + delta + pop.items.length) % pop.items.length;
    paintPopover();
    const active = popEl.querySelector('.is-active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- 提交 ---------------- */

  function submit() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    closePopover();
    toggleAttachRow(false);
    options.onSubmit?.({ text, attachments: attachments.slice() });
  }

  function clear() {
    input.value = '';
    attachments.length = 0;
    renderAttachments();
    closePopover();
    resize();
    syncSend();
  }

  /* ---------------- 事件 ---------------- */

  input.addEventListener('input', () => {
    resize();
    syncSend();
    const trigger = openTrigger(input.value, input.selectionStart == null ? input.value.length : input.selectionStart);
    if (!trigger) {
      if (pop) closePopover();
      return;
    }
    if (trigger.kind === 'command') {
      const range = positionOfTrigger(input.value, 'command');
      openPopover('command', commandItems(matchCommands(`/${trigger.query}`)), range.start, range.end);
    } else {
      openDevicePopover(trigger.query);
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (pop && pop.items.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(pop.index);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopover();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!attachRow.hidden) {
        toggleAttachRow(false);
        return;
      }
      if (options.onEscape?.()) return;
      options.onStop?.();
    }
  });

  input.addEventListener('blur', () => {
    // 焦点移到候选上的 mousedown 已 preventDefault；这里延迟关闭，点选仍然生效
    setTimeout(() => {
      if (pop && !popEl.contains(document.activeElement)) closePopover();
    }, 120);
  });

  attachInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitAttachment();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      toggleAttachRow(false);
      input.focus();
    }
  });

  root.addEventListener('click', () => {
    if (!pop) input.focus();
  });

  /* ---------------- 对外接口 ---------------- */

  renderAttachments();
  resize();
  syncSend();

  return {
    element: root,
    input,
    focus: () => input.focus(),
    setBusy(next) {
      busy = Boolean(next);
      stopBtn.hidden = !busy;
      sendBtn.hidden = busy;
      sendBtn.disabled = busy || input.value.trim() === '';
    },
    getBusy: () => busy,
    getValue: () => input.value,
    setValue(value) {
      input.value = value == null ? '' : String(value);
      resize();
      syncSend();
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    },
    addAttachment(path) {
      const value = String(path || '').trim();
      if (!value || attachments.includes(value)) return;
      attachments.push(value);
      renderAttachments();
    },
    getAttachments: () => attachments.slice(),
    clear,
    openCommandPalette,
    destroy() {
      root.remove();
    },
  };
}
