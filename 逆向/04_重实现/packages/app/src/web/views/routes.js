/**
 * 四个视角的路由表 —— **浏览器与 Node 共用的同一份**。
 *
 * ## 为什么是 `.js` 而类型在 `.ts`
 *
 * 服务端（`server.ts` 的 `MIME_TYPES`）不认 `.ts`，而且所有响应都带
 * `X-Content-Type-Options: nosniff`；浏览器加载 `<script type="module" src="/views/shell.js">`
 * 之后再 `import './routes.ts'`，会拿到 `application/octet-stream` 并被严格 MIME 检查拒掉
 * （实测报：Expected a JavaScript-or-Wasm module script but the server responded with
 * a MIME type of "application/octet-stream"）。
 *
 * 所以**表本身放在 `.js` 里**，浏览器直接用；`routes.ts` 只负责在这些值上补类型
 * 并加上服务端要用的渲染函数，从本文件 re-export。这样表只有一份，
 * 不会出现「服务端认 fleet 是编队台、浏览器认它是地图页」这种撕裂。
 *
 * ## 视-0 修掉的三处错指
 *
 * | 视角 | 改前（错） | 为什么错 |
 * |---|---|---|
 * | `/fleet` | `/geo/luciad-stage.html` | 那是**地图页**，而编队台是任务树 + 事件流 + 干预 |
 * | `/data` | `/config/events` | 那是**事件列表**，而数据视角是批次 / 质控 / 检索 / 评测 |
 * | `/suite` | `/?mode=pro` | 那是**原版首页**，而套件台是三栏六应用 + 检查器 |
 *
 * 指到「长得像的东西」上是这类改动最容易犯的错：每一页都能打开、都不报错，
 * 只是干的不是这件事。所以字段从「外链地址」改成「内容块标识」，错指就没法写出来了。
 */

/** 外壳页文件名；`server.ts` 与测试都读这一份。 */
export const LAYOUT_FILE = 'layout.html';

/**
 * 四个视角，顺序即左导航顺序。
 *
 * 规格第 25.4.1 节给的是「四个视角 + 设置」；设置不是一个视角，是顶栏上的一个弹层。
 *
 * 字段说明：
 *   · `content` —— 主内容区画哪一块。**不是一个 URL。**
 *   · `frame`   —— `content` 的同值别名，只为 `server.ts::health()` 保留
 *                  （它读 `view.frame` 回给 Electron 主进程与自测；server.ts 不归本线改）。
 *   · `module`  —— 视角模块，`shell.js` 据此动态 `import()`，首屏只加载当前视角。
 */
export const VIEWS = [
  {
    id: 'chat',
    path: '/chat',
    label: '对话',
    hint: '问一句开始',
    content: 'chat',
    frame: 'chat',
    title: '对话',
    glyph: '◆',
    module: 'views/chat.js',
  },
  {
    id: 'fleet',
    path: '/fleet',
    label: '编队',
    hint: '任务与干预',
    content: 'fleet',
    frame: 'fleet',
    title: '编队',
    glyph: '▤',
    module: 'views/fleet.js',
  },
  {
    id: 'data',
    path: '/data',
    label: '数据',
    hint: '批次与回源',
    content: 'data',
    frame: 'data',
    title: '数据',
    glyph: '▦',
    module: 'views/data.js',
  },
  {
    id: 'suite',
    path: '/suite',
    label: '套件',
    hint: '六个应用',
    content: 'suite',
    frame: 'suite',
    title: '套件',
    glyph: '▣',
    module: 'views/suite.js',
  },
];

/**
 * 外壳页里需要被替换的占位；测试按这份清单核对 layout.html。
 *
 * 视-0 之后不再有 `FRAME_SRC` / `FRAME_MODE`：主内容不是 iframe，没有 src 要填。
 * 换成 `VIEW_CONTENT`（内容块标识）与 `NAV_ITEMS`（左导航四个链接，服务端渲染，
 * 这样即使 JS 挂了，导航也仍然可见、可点）。
 */
export const LAYOUT_TOKENS = ['VIEW_ID', 'VIEW_TITLE', 'VIEW_CONTENT', 'NAV_ITEMS'];

/** 路径 → 视角；不是视角路由就是 `undefined`（`/`、`/api/*` 原样走老逻辑）。 */
export function viewForPath(pathname) {
  const normal = pathname.replace(/\/+$/, '') || '/';
  return VIEWS.find((view) => view.path === normal);
}

/** 视角 id → 视角；用于深链与刷新后恢复。 */
export function viewById(id) {
  return VIEWS.find((view) => view.id === id);
}

/** 转义成 HTML 文本。视角名是常量，但仍走一遍，免得以后改成数据时漏掉。 */
function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 左导航的四个链接。
 *
 * 服务端渲染而不是客户端生成：JS 加载失败时导航仍然在，用户至少能换视角。
 * `aria-current="page"` 标当前项 —— 视觉上是竖条 + 背景色，可访问性上靠它（25.4.3）。
 */
export function navItems(activeId) {
  return VIEWS.map((view) => {
    const current = view.id === activeId ? ' aria-current="page"' : '';
    return `<a class="vw-nav-item" data-view-link="${view.id}" href="${view.path}"${current}>`
      + `<span class="vw-nav-glyph" aria-hidden="true">${escapeHtml(view.glyph)}</span>`
      + '<span class="vw-nav-text">'
      + `<span class="vw-nav-name">${escapeHtml(view.label)}</span>`
      + `<span class="vw-nav-hint">${escapeHtml(view.hint)}</span>`
      + '</span></a>';
  }).join('');
}

/** 一个视角的占位取值。 */
export function layoutValues(view) {
  return {
    VIEW_ID: view.id,
    VIEW_TITLE: view.title,
    VIEW_CONTENT: view.content,
    NAV_ITEMS: navItems(view.id),
  };
}

/**
 * 把占位换成取值；未知占位原样留下，方便一眼看出模板和代码脱节。
 *
 * `NAV_ITEMS` 是 HTML 片段，所以替换时不自作转义 —— 片段由 `navItems()` 生成，
 * 来源是本文件的常量，不来自外部输入。
 */
export function renderLayout(template, view) {
  const values = layoutValues(view);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    const value = values[key];
    return value === undefined ? match : value;
  });
}
