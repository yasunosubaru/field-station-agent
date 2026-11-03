/**
 * 设置弹窗：provider / base_url / model / api key / temperature。
 *
 * GET/POST `/api/agent/settings`（契约 §3）。key 只在保存时随请求发一次，服务端不回显，
 * 所以输入框永远是空的，用 has_key 的布尔值说明"本机有没有存过"。
 */

const PROVIDERS = [
  { value: 'fake', label: 'fake（确定性演示，不联网）' },
  { value: 'openai_compatible', label: 'openai_compatible（OpenAI 兼容 /v1）' },
  { value: 'ollama', label: 'ollama（本机 Ollama）' },
];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'value') node.value = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function field(id, label, control, hint) {
  return el('div', { class: 'ag-field' }, [
    el('label', { for: id, text: label }),
    control,
    hint ? el('p', { class: 'ag-field-hint', text: hint }) : null,
  ]);
}

/**
 * @param {object} options
 * @param {object} options.api createApi() 的实例
 * @param {(settings:object)=>void} [options.onSaved]
 * @returns {Promise<void>}
 */
export function openSettings(options = {}) {
  const api = options.api;
  const previousFocus = document.activeElement;

  const provider = el('select', { class: 'ag-input-line', id: 'ag-set-provider' },
    PROVIDERS.map((item) => el('option', { value: item.value, text: item.label })));

  const baseUrl = el('input', { class: 'ag-input-line', id: 'ag-set-base', type: 'text', placeholder: 'https://api.example.com', spellcheck: 'false' });
  const model = el('input', { class: 'ag-input-line', id: 'ag-set-model', type: 'text', placeholder: '模型名，例如 gpt-4o-mini', spellcheck: 'false' });
  const apiKey = el('input', { class: 'ag-input-line', id: 'ag-set-key', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const temperature = el('input', {
    class: 'ag-input-line',
    id: 'ag-set-temp',
    type: 'number',
    min: '0',
    max: '2',
    step: '0.1',
    value: '0.2',
  });

  const status = el('p', { class: 'ag-set-status', role: 'status', 'aria-live': 'polite' });
  const keyState = el('p', { class: 'ag-field-hint', text: '正在读取…' });

  const saveBtn = el('button', { type: 'submit', class: 'ag-btn ag-btn-primary', text: '保存' });
  const cancelBtn = el('button', { type: 'button', class: 'ag-btn ag-btn-ghost', text: '取消', onclick: () => close() });
  const reloadBtn = el('button', {
    type: 'button',
    class: 'ag-btn ag-btn-ghost',
    text: '重新读取',
    onclick: () => load(),
  });

  const form = el('form', { class: 'ag-modal-form', novalidate: true, onsubmit: (event) => { event.preventDefault(); save(); } }, [
    field('ag-set-provider', 'Provider', provider),
    field('ag-set-base', 'Base URL', baseUrl, 'openai_compatible 用；ollama 一般填 http://127.0.0.1:11434'),
    field('ag-set-model', 'Model', model),
    field('ag-set-key', 'API Key', apiKey, '只写入本机 secrets.bin，接口不回显'),
    keyState,
    field('ag-set-temp', 'Temperature', temperature, '0–2，越大越发散'),
    status,
    el('div', { class: 'ag-modal-actions' }, [reloadBtn, cancelBtn, saveBtn]),
  ]);

  const dialog = el('div', {
    class: 'ag-modal-card',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'ag-set-title',
  }, [
    el('header', { class: 'ag-modal-head' }, [
      el('h2', { id: 'ag-set-title', text: 'Agent 设置' }),
      el('button', { type: 'button', class: 'ag-modal-x', 'aria-label': '关闭', text: '×', onclick: () => close() }),
    ]),
    form,
  ]);

  const overlay = el('div', {
    class: 'ag-modal',
    onclick: (event) => {
      if (event.target === overlay) close();
    },
  }, [dialog]);

  let closed = false;

  function setStatus(text, tone) {
    status.textContent = text || '';
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  function setBusy(busy) {
    saveBtn.disabled = busy;
    reloadBtn.disabled = busy;
    saveBtn.textContent = busy ? '保存中…' : '保存';
  }

  async function load() {
    setStatus('');
    setBusy(true);
    try {
      const data = (await api.getSettings()) || {};
      provider.value = data.provider || 'fake';
      baseUrl.value = data.base_url || '';
      model.value = data.model || '';
      temperature.value = data.temperature == null ? '0.2' : String(data.temperature);
      apiKey.value = '';
      apiKey.placeholder = data.has_key ? '已保存（留空表示不修改）' : '未设置';
      keyState.textContent = data.has_key
        ? '本机已存过 key；输入新值才会覆盖。'
        : '本机还没有 key。';
      keyState.dataset.tone = data.has_key ? 'ok' : 'warn';
      if (data.fake_fallback) {
        setStatus('当前已回退到 fake：真实 provider 没有可用的 key 或地址。', 'warn');
      }
    } catch (error) {
      setStatus(`读取设置失败：${(error && error.message) || error}`, 'bad');
      saveBtn.disabled = true;
    } finally {
      setBusy(false);
      if (!closed) provider.focus();
    }
  }

  async function save() {
    const payload = {
      provider: provider.value,
      base_url: baseUrl.value.trim(),
      model: model.value.trim(),
      temperature: Number(temperature.value),
    };
    if (!Number.isFinite(payload.temperature)) payload.temperature = 0.2;
    if (apiKey.value.trim()) payload.api_key = apiKey.value.trim();

    setBusy(true);
    setStatus('');
    try {
      const result = await api.saveSettings(payload);
      const settings = (result && result.settings) || payload;
      setStatus('已保存。', 'ok');
      options.onSaved?.(settings, payload);
      close();
    } catch (error) {
      setStatus(`保存失败：${(error && error.message) || error}`, 'bad');
      saveBtn.disabled = false;
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try {
        previousFocus.focus();
      } catch {
        /* 焦点元素可能已经不在了 */
      }
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...dialog.querySelectorAll('button, input, select, textarea')]
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKeydown, true);
  load();

  return Promise.resolve();
}
