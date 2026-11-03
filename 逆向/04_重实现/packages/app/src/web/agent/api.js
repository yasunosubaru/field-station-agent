/**
 * Agent HTTP 客户端 —— 全部走 Node 代理的 `/api/agent/*`（契约 §4）。
 *
 * 这里只做三件事：拼请求、读 SSE、把失败归一成 AgentError。
 * 状态码 / 离线判断放在一个地方，UI 才不会把"服务没起来"画成"没有数据"。
 */

const BASE = '/api/agent';

/** 统一错误：status 0 = 网络层失败（服务没启动），offline 供 UI 决定是否显示离线态 */
export class AgentError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AgentError';
    this.status = Number(options.status) || 0;
    this.class = options.class || (options.offline ? 'environment' : 'execution');
    this.offline = Boolean(options.offline);
    this.body = options.body === undefined ? null : options.body;
  }
}

export function isOffline(error) {
  return Boolean(error && (error.offline || error.status === 503 || error.status === 502 || error.status === 504));
}

function offlineError(message) {
  return new AgentError(message || 'Agent 服务未启动', { offline: true, class: 'environment' });
}

async function readBody(response) {
  const type = response.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) return await response.json();
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  } catch {
    return null;
  }
}

async function failure(response) {
  const body = await readBody(response);
  const message = (body && (body.error || body.message)) || `HTTP ${response.status}`;
  const offline = response.status === 502 || response.status === 503 || response.status === 504
    || /agent server unavailable/i.test(String(message));
  return new AgentError(message, {
    status: response.status,
    class: (body && body.class) || (offline ? 'environment' : 'execution'),
    offline,
    body,
  });
}

/**
 * SSE 读取器：把字节流切成事件。POST + 流式响应拿不到 EventSource，
 * 所以自己按 `\n\n` 分帧，`event:` 与 `data:` 逐行读（契约 §2：event: agent / done）。
 */
export function createSseParser(handle) {
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const flush = () => {
    const raw = dataLines.join('\n');
    const name = eventName || 'message';
    eventName = '';
    dataLines = [];
    if (!raw) return;
    if (raw === '[DONE]') {
      handle({ type: 'done' }, name);
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      handle({ type: 'error', class: 'execution', message: `无法解析的 SSE 数据：${raw.slice(0, 200)}` }, name);
      return;
    }
    if (Array.isArray(payload)) {
      for (const item of payload) if (item && typeof item === 'object') handle(item, name);
      return;
    }
    if (payload && typeof payload === 'object') handle(payload, name);
  };

  const takeLine = (line) => {
    if (line === '') {
      flush();
      return;
    }
    if (line.startsWith(':')) return; // 注释 / 心跳
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        let line = buffer.slice(0, index);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(index + 1);
        takeLine(line);
        index = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer) {
        takeLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
        buffer = '';
      }
      flush();
    },
  };
}

function withTimeout(signal, ms) {
  if (!ms || ms <= 0) return { signal, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * @param {typeof fetch} [fetchImpl] 便于测试注入
 */
export function createApi(fetchImpl) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(method, path, body, options = {}) {
    const init = { method, headers: { Accept: 'application/json' }, signal: options.signal };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const guard = withTimeout(options.signal, options.timeoutMs == null ? 20000 : options.timeoutMs);
    let response;
    try {
      response = await doFetch(`${BASE}${path}`, { ...init, signal: guard.signal });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new AgentError('请求超时：Agent 服务没有在预期时间内应答', { class: 'environment', offline: true });
      }
      throw offlineError('Agent 服务未启动（连不上 /api/agent）');
    } finally {
      guard.cancel();
    }
    if (!response.ok) throw await failure(response);
    return readBody(response);
  }

  return {
    /** GET /health —— 服务在不在、用的哪个 provider/model */
    health: (options) => request('GET', '/health', undefined, { timeoutMs: 15000, ...options }),

    listSessions: (options) => request('GET', '/sessions', undefined, options),

    createSession: (title, options) => request('POST', '/sessions', title ? { title } : {}, options),

    getSession: (id, options) => request('GET', `/sessions/${encodeURIComponent(id)}`, undefined, options),

    getArtifacts: (id, options) => request('GET', `/sessions/${encodeURIComponent(id)}/artifacts`, undefined, options),

    getSettings: (options) => request('GET', '/settings', undefined, { timeoutMs: 15000, ...options }),

    saveSettings: (payload, options) => request('POST', '/settings', payload || {}, options),

    listTools: (options) => request('GET', '/tools', undefined, { timeoutMs: 15000, ...options }),

    /** 决定审批：POST /sessions/:id/approval {approval_id, decision, note?} */
    approval: (sessionId, payload, options) => request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/approval`,
      payload,
      options,
    ),

    cancel: (sessionId, options) => request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
      options,
    ),

    /**
     * 发消息并消费 SSE。onEvent 收到的是契约 §2 的原始事件对象；
     * 非 2xx 一律抛 AgentError（离线态由 isOffline 判断）。
     */
    async sendMessage(sessionId, payload, options = {}) {
      let response;
      try {
        response = await doFetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(payload || {}),
          signal: options.signal,
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new AgentError('已取消', { class: 'input' });
        }
        throw offlineError('Agent 服务未启动（连不上 /api/agent）');
      }
      if (!response.ok) throw await failure(response);

      const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
      const type = response.headers.get('content-type') || '';

      // 服务端如果退回普通 JSON（比如一次性返回 events 数组），也照常消化
      if (!response.body || !type.includes('text/event-stream')) {
        const body = await readBody(response);
        const events = Array.isArray(body) ? body : (body && Array.isArray(body.events) ? body.events : null);
        if (events) {
          for (const event of events) if (event && typeof event === 'object') onEvent(event);
          onEvent({ type: 'done' });
          return;
        }
        throw new AgentError('服务端没有返回事件流', { status: response.status, class: 'execution', body });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const parser = createSseParser((event, name) => {
        onEvent(event, name);
      });
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
      } catch (error) {
        if (error && error.name === 'AbortError') throw new AgentError('已取消', { class: 'input' });
        throw new AgentError(`事件流中断：${(error && error.message) || error}`, { class: 'execution' });
      }
    },
  };
}

/** 产物下载地址：优先服务端给的 url，其次契约里约定的会话产物路径 */
export function artifactUrl(sessionId, artifact) {
  if (!artifact) return '';
  if (artifact.url) return String(artifact.url);
  if (artifact.download_url) return String(artifact.download_url);
  const name = String(artifact.name || '').split('/').pop();
  return `${BASE}/sessions/${encodeURIComponent(sessionId || '')}/artifacts/${encodeURIComponent(name)}`;
}
