/**
 * 外壳：五块骨架 + 单页路由 + 视角挂载。
 *
 * ## 五块各一份
 *
 * 顶栏 / 左导航 / 主内容 / 右栏 / 底栏，全局各一份，切视角时只有主内容与右栏换内容，
 * 其余三块不动。这是「像专职工具而不是通用后台」的具体落点：顶栏的台站、模型的
 * 运行时始终在同一个位置，用户不用每个视角重新找。
 *
 * ## 为什么是单页（第 25.5.2 节，建议 B）
 *
 * 服务端多页要靠 localStorage / sessionStorage 在页间同步 store，有延迟窗口
 * （切太快会看到旧数据）。单页的代价是「自己写路由」，在这个规模上只是
 * `history.pushState` + 一个 `popstate` 监听。
 *
 * 具体做法：
 *   1. 一条最小路由：`/chat` `/fleet` `/data` `/suite` ↔ `history.pushState`；
 *   2. 首屏只加载当前视角的模块（`await import()`，各视角独立文件）；
 *   3. 切视角只从 store 读，不发新请求（`ensure()` 命中缓存）；
 *   4. 刷新页面靠 URL 恢复视角 —— 服务端已经把 `{{VIEW_ID}}` 渲染进 `body[data-view]`。
 *
 * ## 为什么导航用真链接
 *
 * 左导航是 `<a href="/fleet">`：JS 没起来时仍然能跳（退化成整页刷新，状态丢失但功能在），
 * JS 起来后 `preventDefault` 接管，变成无刷新切换。这比 `<div onclick>` 更抗故障。
 */

import { store } from './state.js';
import { VIEWS, viewById, viewForPath } from './routes.js';

/* ================================================================
 * ① 元素
 * ================================================================ */

const root = document.querySelector('[data-shell]');
const mainEl = root?.querySelector('[data-main]');
const headerEl = root?.querySelector('[data-view-head]');
const railEl = root?.querySelector('[data-rail]');
const footEl = root?.querySelector('[data-foot]');
const navEl = root?.querySelector('[data-nav]');

if (!root || !mainEl || !headerEl || !railEl || !footEl || !navEl) {
  throw new Error('外壳结构不全：需要 [data-shell] [data-main] [data-view-head] [data-rail] [data-foot] [data-nav]');
}

const state = store();

/* ================================================================
 * ② 视角模块的加载与卸载
 * ================================================================ */

/**
 * 每个视角模块导出一个 `mount(ctx)`，返回一个 `unmount()`。
 *
 * 不把 DOM 留在内存里复用，是为了让「切回来」走同一条代码路径 —— 如果只在首次挂载时
 * 渲染、之后靠缓存 DOM，就会出现「数据变了但界面没变」这类只在切回来后复现的 bug。
 */
const mounted = new Map();
let activeView = null;
let mountToken = 0;

async function mountView(view) {
  if (activeView === view.id) return;
  const token = ++mountToken;
  activeView = view.id;

  // 先卸上一个：它的订阅必须在离开时断掉，否则会在后台继续改 DOM。
  for (const [id, unmount] of mounted) {
    unmount();
    mounted.delete(id);
  }

  document.body.setAttribute('data-view', view.id);
  mainEl.setAttribute('data-content', view.content);
  mainEl.setAttribute('aria-busy', 'true');
  // 主内容先清空再挂。空态由各视角自己画（规格要求四种空态互相区分）。
  mainEl.replaceChildren();
  headerEl.replaceChildren();

  let mod;
  try {
    /*
     * `module` 字段形如 `views/chat.js`（相对 **web 根**，见 routes.js），
     * 本文件挂在 `/views/shell.js`。实测三种写法等价：
     *   new URL('../views/chat.js', '/views/shell.js') -> /views/chat.js
     *   new URL('./chat.js',        '/views/shell.js') -> /views/chat.js
     * 保留 `../` 形式（与 routes.js 的口径一致），但**不要**简化成 `./chat.js`：
     * 那样一旦 module 值带上 `views/` 前缀就会拼成 `/views/views/chat.js`。
     */
    mod = await import(new URL(`../${view.module}`, import.meta.url).href);
  } catch (error) {
    // 模块加载失败必须说清「哪一块没起来」，并且**不能让外壳跟着挂掉** ——
    // 顶栏、左导航、右栏、底栏都还能用，用户至少能切走。
    mainEl.setAttribute('aria-busy', 'false');
    renderBlockError(mainEl, view, error);
    return;
  }
  if (token !== mountToken) return; // 期间又切了视角：这份结果作废

  try {
    const unmount = mod.mount({
      view,
      state,
      main: mainEl,
      head: headerEl,
      rail: railEl,
      foot: footEl,
      /** 由视角自己声明右栏内容：右栏「跟着视角变」，但**不是清空重填**（25.6.1）。 */
      renderRail: (render) => registerRail(view.id, render),
      /**
       * 重画右栏。
       *
       * 视角里 store 一变就要调它 —— 右栏内容是从 store 读的，重画一次就同步了。
       * 比让每个视角自己去找 DOM 节点改要可靠：节点结构是视角自己画的，
       * 但「谁负责重画」这件事只有壳知道。
       */
      repaintRail: paintRail,
      /** 跳到另一个视角（跨视角跳，25.1.3）。 */
      go: navigate,
      /** 选中一个任务后同步到 store，供编队 / 对话共用。 */
      selectTask: (taskId) => state.set({ selectedTaskId: taskId }),
    });
    mounted.set(view.id, typeof unmount === 'function' ? unmount : () => {});
  } catch (error) {
    renderBlockError(mainEl, view, error);
  } finally {
    mainEl.setAttribute('aria-busy', 'false');
  }
}

/** 一块内容起不来时的兜底：说清是哪块、错误码、下一步做什么（25.14.4）。 */
function renderBlockError(host, view, error) {
  const message = error instanceof Error ? error.message : String(error);
  const box = document.createElement('div');
  box.className = 'vw-block-error';
  box.setAttribute('role', 'alert');
  box.innerHTML = '<p class="vw-block-error-what"></p>'
    + '<p class="vw-block-error-code"></p>'
    + '<p class="vw-block-error-hint"></p>';
  box.querySelector('.vw-block-error-what').textContent = `「${view.label}」这一块没能加载：${message}`;
  box.querySelector('.vw-block-error-code').textContent = `E_VIEW_MODULE · ${view.module}`;
  box.querySelector('.vw-block-error-hint').textContent =
    '其它视角仍然可用（点左导航切走）。要恢复这一块，刷新页面；仍然失败就查看控制台与 /api/health。';
  host.replaceChildren(box);
}

/* ================================================================
 * ③ 右栏
 * ================================================================ */

const railRenderers = new Map();

function registerRail(viewId, render) {
  railRenderers.set(viewId, render);
  if (viewId === activeView) paintRail();
}

/**
 * 重画右栏。
 *
 * 「跟着视角变」不等于「清空重填」：渲染函数从 store 读，切回来时同一份数据还在，
 * 画出来的就是原样（第 25.6.1 节）。
 */
function paintRail() {
  const render = railRenderers.get(activeView);
  railEl.replaceChildren();
  if (!render) {
    const empty = document.createElement('p');
    empty.className = 'vw-rail-empty';
    empty.textContent = '这一视角没有右栏内容。';
    railEl.append(empty);
    return;
  }
  try {
    render(railEl);
  } catch (error) {
    const box = document.createElement('p');
    box.className = 'vw-rail-empty';
    box.textContent = `右栏渲染失败：${error instanceof Error ? error.message : String(error)}`;
    railEl.replaceChildren(box);
  }
}

/* ================================================================
 * ④ 底栏（四个状态灯，全局一份）
 * ================================================================ */

/** 灯的显示文案。`unknown` 必须和「坏的」区分开 —— 还没问过后端不等于后端挂了。 */
const LAMP_LABEL = {
  ok: '正常',
  idle: '空闲',
  degraded: '降级',
  down: '不可用',
  unknown: '未知',
};

const LAMP_NAME = { dbos: 'DBOS', graph: '图', memory: '记忆', queue: '队列' };

function paintFoot() {
  const { lamps, lampReasons, info } = state.get();
  footEl.replaceChildren();

  for (const key of ['dbos', 'graph', 'memory', 'queue']) {
    const value = lamps[key];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vw-lamp';
    button.dataset.lamp = key;
    button.dataset.state = value;
    // 第 25.7.1 节：黄色（降级）比红色更常见也更重要 —— 红色是「坏了」，用户知道要修；
    // 黄色是「降级」，用户可能不知道自己在用不可靠的结果。所以每个灯都必须能点开看原因。
    button.title = lampReasons[key] || `${LAMP_NAME[key]}：${LAMP_LABEL[value]}`;
    button.setAttribute('aria-label', `${LAMP_NAME[key]} ${LAMP_LABEL[value]}${lampReasons[key] ? `：${lampReasons[key]}` : ''}`);

    const dot = document.createElement('span');
    dot.className = 'vw-lamp-dot';
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'vw-lamp-name';
    name.textContent = LAMP_NAME[key];

    const text = document.createElement('span');
    text.className = 'vw-lamp-text';
    text.textContent = LAMP_LABEL[value];

    button.append(dot, name, text);
    if (lampReasons[key]) {
      const reason = document.createElement('span');
      reason.className = 'vw-lamp-reason';
      reason.textContent = lampReasons[key];
      button.append(reason);
    }
    footEl.append(button);
  }

  // 右侧：连接状态与本次的 token 用量。token 放在底栏而不是顶栏，因为顶栏已经五样了（25.3.2）。
  const tail = document.createElement('span');
  tail.className = 'vw-foot-tail';
  tail.textContent = info.connection === 'connected' ? '已连接'
    : info.connection === 'connecting' ? '连接中…'
      : info.connection === 'offline' ? '未连接' : '—';
  tail.dataset.connection = info.connection;
  footEl.append(tail);
}

/* ================================================================
 * ⑤ 顶栏（五样，全局一份）
 * ================================================================ */

function paintHeaderInfo() {
  const { info } = state.get();
  const set = (selector, text) => {
    const node = root.querySelector(selector);
    if (node) node.textContent = text;
  };
  set('[data-info-version]', info.version ? `v${info.version}` : 'v—');
  set('[data-info-station]', info.station || '未选择');
  set('[data-info-model]', info.model || CANONICAL_FALLBACK);
  set('[data-info-runtime]', `${info.runtime} 侧`);
  const conn = root.querySelector('[data-info-connection]');
  if (conn) {
    conn.dataset.connection = info.connection;
    conn.textContent = info.connection === 'connected' ? '已连接'
      : info.connection === 'connecting' ? '连接中…'
        : info.connection === 'offline' ? '未连接' : '—';
  }
  // 台站选择器的「最近使用」必须在最上面（25.3.3）：90% 的操作针对最近那一两个台站。
  const picker = root.querySelector('[data-station-picker]');
  if (picker) {
    picker.replaceChildren();
    // 占位项永远在：清空 options 会让下拉变成一个没有可选项的空壳。
    picker.append(new Option(info.station || '未选择', ''));
    const recent = info.stationRecent.filter((name) => name !== info.station);
    if (recent.length) {
      const group = document.createElement('optgroup');
      group.label = '最近使用';
      for (const name of recent) group.append(new Option(name, name));
      picker.append(group);
    }
    picker.value = '';
    picker.addEventListener('change', () => {
      if (picker.value) state.rememberStation(picker.value);
    });
  }
}

const CANONICAL_FALLBACK = 'deepseek-v4.1-flash';

/* ================================================================
 * ⑥ 路由
 * ================================================================ */

/** 当前 URL 对应的视角；认不出就退回对话。 */
function currentView() {
  return viewForPath(location.pathname) ?? VIEWS[0];
}

/**
 * 切视角。
 *
 * `push: false` 用于 `popstate`（浏览器前进/后退已经在改历史了）。
 */
function navigate(path, options = {}) {
  const view = viewForPath(path);
  if (!view) return;
  if (options.push !== false && location.pathname !== view.path) {
    history.pushState({ view: view.id }, '', view.path);
  }
  state.set({ view: view.id });
  // 左导航高亮：竖条 + 背景色 + aria-current，三个手段用满（25.4.3 要求至少两个）。
  for (const link of navEl.querySelectorAll('[data-view-link]')) {
    const isCurrent = link.dataset.viewLink === view.id;
    if (isCurrent) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  mountView(view);
  document.title = `${view.title} · 野外台站智能体`;
}

/* ================================================================
 * ⑦ 事件
 * ================================================================ */

navEl.addEventListener('click', (event) => {
  const link = event.target.closest('[data-view-link]');
  if (!link) return;
  // 新标签页 / 中键 / 带修饰键：让浏览器自己处理，别劫持用户的习惯。
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate(link.getAttribute('href') ?? '/chat');
});

window.addEventListener('popstate', () => navigate(location.pathname, { push: false }));

/* 右栏折叠：默认展开，可折成 0（25.6.3）。偏好记在 store 里（落 localStorage）。 */
const railToggle = root.querySelector('[data-rail-toggle]');
railToggle?.addEventListener('click', () => {
  const next = !state.get().railCollapsed;
  state.set({ railCollapsed: next });
  railToggle.setAttribute('aria-expanded', String(!next));
});

/* 折叠后的 8px 抓手也要能点回来 —— 完全消失就找不回来了（25.6.3）。 */
railEl.addEventListener('click', () => {
  if (!state.get().railCollapsed) return;
  state.set({ railCollapsed: false });
});

/*
 * 窄屏的「详情」抽屉（25.6.2 / 附录 C.8）。
 *
 * 与「折叠」是两件事：折叠是用户主动收起来，抽屉是**宽度不够**时的形态。
 * 所以状态分开存：`data-rail-state` 取 `expanded` / `collapsed` / `drawer`。
 */
const drawerOpen = root.querySelector('[data-rail-drawer-open]');

function setDrawer(open) {
  document.body.dataset.railState = open ? 'drawer' : 'expanded';
  drawerOpen?.setAttribute('aria-expanded', String(open));
  // 抽屉是覆盖层：打开时主内容仍然在下面，但焦点要能进去。
  if (open) railEl.querySelector('button, [href], input, select, textarea, [tabindex]')?.focus();
}

drawerOpen?.addEventListener('click', () => {
  setDrawer(document.body.dataset.railState !== 'drawer');
});

/* 密度切换：只改行高与字号，**不重排数据**（25.13.3 的验收项）。 */
const densityToggle = root.querySelector('[data-density-toggle]');
densityToggle?.addEventListener('click', () => {
  const next = state.get().density === 'compact' ? 'comfort' : 'compact';
  state.set({ density: next });
  densityToggle.textContent = next === 'compact' ? '紧凑' : '舒适';
  densityToggle.setAttribute('aria-pressed', String(next === 'compact'));
});

/* Ctrl+K：命令面板（切视角）。视-0 只做视角切换，跳任务留给视-2。 */
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const order = VIEWS.map((view) => view.id);
    const index = order.indexOf(activeView);
    navigate(VIEWS[(index + 1) % VIEWS.length].path);
  }
  if (event.key === 'Escape') {
    // 关掉任何打开着的弹层：抽屉优先（它是覆盖层，先关它才自然）。
    if (document.body.dataset.railState === 'drawer') {
      setDrawer(false);
    } else if (state.get().railCollapsed === false && document.body.dataset.railDrawer === 'open') {
      document.body.dataset.railDrawer = '';
    }
  }
});

/* ================================================================
 * ⑧ 订阅
 * ================================================================ */

/**
 * 只重画受影响的那一块。
 *
 * 这是「没有框架也能保持界面和数据一致」的关键：副作用只在一个地方发生，
 * 并且按 `changed` 集合分流。整页重绘会让输入框丢焦点，是切视角之外最烦人的毛病。
 */
state.subscribe((next, changed) => {
  if (changed.has('info')) {
    paintHeaderInfo();
    paintFoot();
  }
  if (changed.has('lamps') || changed.has('lampReasons')) paintFoot();
  if (changed.has('railCollapsed')) {
    // 只在宽屏形态下反映折叠；窄屏由抽屉状态决定（两者互不覆盖）。
    if (document.body.dataset.railState !== 'drawer') {
      document.body.dataset.railState = next.railCollapsed ? 'collapsed' : 'expanded';
    }
    railToggle?.setAttribute('aria-expanded', String(!next.railCollapsed));
  }
  if (changed.has('density')) {
    // **必须写在 body 上**：CSS 的选择器是 `body[data-view][data-density="compact"]`
    // （views.css L52）。原先写的是 `document.documentElement.dataset.density`，
    // 而 `<html>` 上没有 `data-view`，两条选择器都匹配不上 ——
    // 于是点「紧凑」只有按钮文字变了，行高字号一动不动（实测）。
    document.body.dataset.density = next.density;
  }
  // 视角自己的模块已经通过 `state.subscribe` 各自订阅；这里只管全局那几块。
});

/* ================================================================
 * ⑨ 启动
 * ================================================================ */

/** 从 URL 里取 `?view=` 或路径判断当前视角，刷新后停在同一个地方（25.5.2 第 4 条）。 */
function boot() {
  document.documentElement.dataset.density = state.get().density;
  document.body.dataset.railState = state.get().railCollapsed ? 'collapsed' : 'expanded';
  railToggle?.setAttribute('aria-expanded', String(!state.get().railCollapsed));
  densityToggle?.setAttribute('aria-pressed', String(state.get().density === 'compact'));
  if (densityToggle) {
    densityToggle.textContent = state.get().density === 'compact' ? '紧凑' : '舒适';
  }

  paintHeaderInfo();
  paintFoot();

  // 服务端已经把 data-view 渲染进 body；这里用 URL 再对一次，防止直接访问 `/`
  // 时 body 停在 chat 而 URL 是别的。
  const view = currentView();
  state.set({ view: view.id });
  navigate(view.path, { push: false });

  // 深链参数在这一步消费：`?device=` → 套件台选中设备，`?job=` → 编队台选中任务。
  applyDeepLink();
}

/**
 * 消费深链参数。
 *
 * Electron 主进程把 `fsa://device/<id>` 送到 `/suite?device=<id>`、
 * `fsa://job/<id>` 送到 `/fleet?job=<id>`（见 `shell/electron/deeplink.js`）。
 * 页面这一侧只做**一件事**：把 id 写进 store 的 selection。
 *
 * 为什么不新建 store、也不开一个「深链模式」：规格 25.15 说深链只是「选中某个东西」，
 * 而选中项本来就在 store 里共享（视-0）。这样从深链进来之后切视角、下钻、返回，
 * 全都是同一个选择 —— 也正是 Bot-9「下钻只改 selection」的同一条原则。
 *
 * 参数解析完就从地址栏抹掉：留着它，用户每按一次刷新都会被「重新深链」一次，
 * 而他可能已经在界面上换了选择 —— 那会被强行改回去。
 */
function applyDeepLink() {
  const params = new URLSearchParams(location.search);
  const device = params.get('device');
  const job = params.get('job');
  if (!device && !job) return;

  const patch = {};
  if (device) patch.selectedDeviceId = device;
  if (job) patch.selectedTaskId = job;
  state.set(patch);

  // 抹掉参数，保留路径。
  history.replaceState({ view: state.get().view }, '', location.pathname);
}

boot();

/* 暴露给控制台与测试：验「状态真的跨视角共享」时要用（第 6.2.5 节）。 */
globalThis.__FSA_SHELL__ = { navigate, store: state, viewById, ViewIds: VIEWS.map((view) => view.id) };
