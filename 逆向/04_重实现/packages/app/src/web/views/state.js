/**
 * 全局唯一的 store —— 视-0「一个窗口换内容」的地基。
 *
 * ## 为什么只有一份
 *
 * 原来是「外壳 + 四个 iframe」：四个独立文档、四份状态、四次加载、靠 postMessage 通信。
 * 后果是「切视角就丢状态」—— 在对话里选了台站，切到数据又得重选一遍。
 * 第 25.5.1 节把这件事说得很直接：
 *
 * | iframe | 同一文档换内容 |
 * |---|---|
 * | 四个独立文档 | 一个文档 |
 * | 四份状态 | 一份状态 |
 * | 四次加载 | 一次加载 |
 * | postMessage 通信 | 直接函数调用 |
 *
 * 所以这里只留**一个** store 对象，挂在 `window.__FSA_STORE__` 上（见 `store()`）。
 * 视角切换只改 `view` 字段，同一份数据仍在 ——「切回来数据还在」因此是设计自带的性质，
 * 不是额外做的努力。
 *
 * ## 为什么是 `.js` 而不是 `.ts`
 *
 * 服务端（`server.ts` 的 `MIME_TYPES`）不认 `.ts`，且所有响应带 `X-Content-Type-Options: nosniff`。
 * 浏览器因此**不会**执行 `/views/state.ts`。类型只留在 `routes.ts`（那一个由 `server.ts`
 * 直接 import，走 Node 的类型剥离），浏览器侧的模块一律 `.js`。
 *
 * ## 为什么请求也归这里
 *
 * 「切视角不重新请求」要求数据活过视角切换。如果每个视角自己 fetch，切回来必然重来。
 * 所以缓存放在 store 里：`ensure()` 先看缓存，命中就不再发请求。
 *
 * 本文件不导入任何东西，浏览器直接 `import`。
 */

/* ================================================================
 * ① 常量
 * ================================================================ */

/** 唯一的模型名。纪律要求「唯一模型」，界面上必须能看出它是什么。 */
export const CANONICAL_MODEL = 'deepseek-v4.1-flash';

/** localStorage 的键。**只存用户偏好**，不存后端数据。 */
const PERSIST_KEY = 'fsa.web.shell.v1';

/** 台站「最近使用」最多记几个。 */
const RECENT_STATIONS = 6;

/* ================================================================
 * ② 初值
 * ================================================================ */

function emptySlot() {
  return { state: 'idle', value: null, error: null, at: 0 };
}

function initialState() {
  return {
    // —— 五块里与视角无关的部分 ——
    view: 'chat',
    info: {
      name: '野外台站智能体',
      version: '',
      station: '',
      stationRecent: [],
      model: CANONICAL_MODEL,
      runtime: 'A',
      connection: 'unknown',
    },
    lamps: { dbos: 'unknown', graph: 'unknown', memory: 'unknown', queue: 'unknown' },
    lampReasons: { dbos: '', graph: '', memory: '', queue: '' },
    // 密度两档（25.13.3）。切换只改行高与字号，**不重排数据**。
    density: 'comfort',
    // 右栏折叠偏好；默认展开（25.6.3 的理由：证据默认收起就没人看）。
    railCollapsed: false,

    // —— 选中项：跨视角共享，「跳来跳去不要重新选」（25.1.3） ——
    selectedTaskId: null,
    selectedBatchId: null,
    selectedAppId: 'manage',
    selectedDeviceId: null,
    /**
     * 反向深链的预填草稿（视-6）。
     *
     * 套件台点「建任务」时写进来，编队台读它来预填。只放**草稿**，不建任务 ——
     * 「跳到编队并预填」是两件事：跳过去是一次导航，建任务是用户按下去之后的事。
     * 混在一起会出现「点了一下就产生了一个没人想要的空任务」。
     */
    selectedTaskDraft: null,

    // —— 缓存 ——
    cache: {
      health: emptySlot(),
      forest: emptySlot(),
      tree: emptySlot(),
      events: emptySlot(),
      pending: emptySlot(),
    },

    /** 界面级提示（四级错误里的「错误」与「致命」）。 */
    notice: null,
  };
}

/* ================================================================
 * ③ 偏好持久化
 * ================================================================ */

function readPersisted() {
  try {
    const raw = globalThis.localStorage?.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 隐私模式 / 配额满 / 被手改坏：偏好读不到不是错误，退回默认值即可。
    return {};
  }
}

function writePersisted(state) {
  try {
    globalThis.localStorage?.setItem(PERSIST_KEY, JSON.stringify({
      view: state.view,
      density: state.density,
      railCollapsed: state.railCollapsed,
      station: state.info.station,
      stationRecent: state.info.stationRecent,
      selectedAppId: state.selectedAppId,
    }));
  } catch {
    // 存不下就算了：偏好丢失只影响下次打开，不影响本次使用。
  }
}

/* ================================================================
 * ④ store
 * ================================================================ */

/**
 * 一个极小的可订阅状态容器。
 *
 * `changed` 是给订阅者省事儿的：底栏灯变了不必重画主内容。没有框架时，
 * 这个集合比「整页重绘」便宜得多，也比「四个模块各自判断」可靠。
 */
export function createStore() {
  const base = initialState();
  const saved = readPersisted();

  let state = {
    ...base,
    view: typeof saved.view === 'string' ? saved.view : base.view,
    density: saved.density === 'compact' ? 'compact' : base.density,
    railCollapsed: saved.railCollapsed === true,
    selectedAppId: typeof saved.selectedAppId === 'string' ? saved.selectedAppId : base.selectedAppId,
    info: {
      ...base.info,
      station: typeof saved.station === 'string' ? saved.station : '',
      stationRecent: Array.isArray(saved.stationRecent)
        ? saved.stationRecent.filter((name) => typeof name === 'string').slice(0, RECENT_STATIONS)
        : [],
    },
  };

  const listeners = new Set();

  /** 对外快照。每次 `set` 换新对象，「变没变」可以靠引用比较。 */
  function get() {
    return state;
  }

  function set(patch) {
    const changed = new Set();
    for (const key of Object.keys(patch)) {
      if (state[key] !== patch[key]) changed.add(key);
    }
    if (changed.size === 0) return;
    state = { ...state, ...patch };
    if (changed.has('view') || changed.has('density') || changed.has('railCollapsed')
      || changed.has('selectedAppId')) {
      writePersisted(state);
    }
    for (const listener of listeners) listener(state, changed);
  }

  /** 深层改 `info`：`set({info})` 会整块换掉，容易漏字段。 */
  function patchInfo(patch) {
    set({ info: { ...state.info, ...patch } });
  }

  /** 深层改灯；`reason` 省缺时不动原因文本。 */
  function patchLamp(key, value, reason) {
    set({
      lamps: { ...state.lamps, [key]: value },
      lampReasons: reason === undefined
        ? state.lampReasons
        : { ...state.lampReasons, [key]: reason },
    });
  }

  /** 把台站记进「最近使用」，最近的在前，去重，最多六个。 */
  function rememberStation(station) {
    if (!station) return;
    const rest = state.info.stationRecent.filter((name) => name !== station);
    patchInfo({ station, stationRecent: [station, ...rest].slice(0, RECENT_STATIONS) });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { get, set, patchInfo, patchLamp, rememberStation, subscribe };
}

/* ================================================================
 * ⑤ 取数（带缓存）
 * ================================================================ */

/**
 * 统一的失败描述：错误提示三要素（发生了什么 / 错误码 / 该做什么）。
 *
 * 第 25.14.4 节把「An error occurred」列为不可接受；这里强制每条失败都带齐三样。
 */
export function describeFailure(error, what) {
  if (error instanceof Error) {
    const found = /(\b[0-9]{3}\b)/.exec(error.message);
    const offline = /Failed to fetch|NetworkError|ERR_CONNECTION/i.test(error.message);
    return {
      what,
      code: found ? found[1] : (offline ? 'E_OFFLINE' : 'E_NETWORK'),
      hint: offline ? '后端没在跑：检查 /api/health 的端口，然后重试。' : '重试一次；仍然失败就查看日志。',
    };
  }
  return { what, code: 'E_UNKNOWN', hint: '重试一次；仍然失败就查看日志。' };
}

/** 取一次 JSON。只做 GET：视-0 不写任何东西。 */
export async function getJson(url, signal) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

/**
 * 有缓存就返回缓存，没有才发请求 —— 「切视角不重新请求」的落点。
 *
 * 缓存命中时同步返回，界面不会先闪一下空白。
 */
export async function ensure(store, slot, url, map, what, options = {}) {
  const current = store.get().cache[slot];
  if (!options.force && current.state === 'ready' && current.value !== null) {
    return current.value;
  }
  store.set({ cache: { ...store.get().cache, [slot]: { ...current, state: 'loading' } } });
  try {
    const raw = await getJson(url, options.signal);
    const value = map(raw);
    store.set({
      cache: { ...store.get().cache, [slot]: { state: 'ready', value, error: null, at: Date.now() } },
    });
    return value;
  } catch (error) {
    store.set({
      cache: {
        ...store.get().cache,
        [slot]: {
          state: 'error',
          // 保留旧值：查询失败时继续显示上次结果并标注过期，比清空更有用。
          value: current.value,
          error: describeFailure(error, what),
          at: current.at,
        },
      },
    });
    return current.value;
  }
}

/* ================================================================
 * ⑥ 单例
 * ================================================================ */

let singleton = null;

/**
 * 整个应用只有一个 store，所以这里做单例。
 *
 * **为什么不能每个入口各 `createStore()` 一次**：第 6.2.7 节把这条列为本条最大的技术风险 ——
 * 「对话页改了 store，编队页读不到」。ES module 每次 `import` 拿到的是同一实例，但只要有
 * 一处写成 `createStore()` 就变成两份。挂到 `window` 上还有第二个作用：浏览器控制台里
 * 可以直接 `__FSA_STORE__.get()` 验「状态真的共享」（第 6.2.5 节的验法就靠这个）。
 */
export function store() {
  if (!singleton) {
    singleton = createStore();
    globalThis.__FSA_STORE__ = singleton;
  }
  return singleton;
}

/* ================================================================
 * ⑦ 小工具
 * ================================================================ */

/**
 * 任务的稳定主键。
 *
 * ⚠ **只认 `task_id`**。A 线 Bot-7 把 `task.id` 改名成 `task.task_id`；这里不留
 * `task.task_id || task.id` 的兼容分支 —— 兼容分支会让代码永远留着脏东西，
 * 还会把「字段没对上」这件事静默降级成「看起来能用」。写死新名之后，一旦对不上，
 * 界面会立刻露出空值，而不是悄悄退回旧字段继续跑。
 */
export function taskId(task) {
  return task && typeof task.task_id === 'string' ? task.task_id : '';
}

/**
 * 把毫秒折算成人能一眼比较的耗时。
 *
 * 规格第 25.10.3 节点名「耗时」列是本条最该留的一列，因为用户判断「正常不正常」主要靠它。
 * 所以这里不返回 `0.0032s` 这种，而是取两档有效数字：
 *   < 1s  → `412ms`
 *   < 60s → `3.2s` / `12.4s`
 *   < 1h  → `1m20s`
 *   ≥ 1h  → `2h05m`
 */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes - hours * 60).padStart(2, '0')}m`;
}

/** 两个 ISO 时间戳之间差多少毫秒；任一缺失返回 `null`（不猜）。 */
export function elapsedMs(from, to) {
  if (!from) return null;
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * 数字按千分位显示。
 *
 * 配 `.num` 的等宽数字用（视觉规矩一）。`86400` → `86,400`，
 * 让一列数字能一眼比大小。
 */
export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** 比例：`0.007` → `0.70%`。小数位固定两位，方便一列对齐。 */
export function formatPercent(ratio, digits = 2) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 字节数 → 人读。单位另起一档（视觉规矩二），所以这里返回 `{value, unit}`。 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return { value: '—', unit: '' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  const digits = index === 0 ? 0 : 1;
  return { value: value.toFixed(digits), unit: units[index] };
}

/** 只取 `HH:MM`（事件流的时间列）。没有时间戳时返回 `—`，不编一个出来。 */
export function formatClock(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
