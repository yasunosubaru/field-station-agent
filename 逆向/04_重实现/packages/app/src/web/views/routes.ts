/**
 * 四个视角的路由表 —— `server.ts` 与 `test/views.test.ts` 共用。
 *
 * ## 视-0 之后这表有两层含义
 *
 * 1. **服务端**：`/chat` `/fleet` `/data` `/suite` 各自返回 `layout.html` 渲染出的一份 HTML；
 * 2. **客户端**：`shell.js` 读 `content` 字段，决定主内容区画哪一块。
 *
 * ## 为什么 `frame` 改名叫 `content`
 *
 * 以前 `frame` 是「iframe 的 src」，三个视角因此被错指到别的页面：
 *
 * | 视角 | 改前（错） | 为什么错 |
 * |---|---|---|
 * | `/fleet` | `/geo/luciad-stage.html` | 那是**地图页**，而编队台是任务树 + 事件流 + 干预 |
 * | `/data` | `/config/events` | 那是**事件列表**，而数据视角是批次 / 质控 / 检索 / 评测四区 |
 * | `/suite` | `/?mode=pro` | 那是**原版首页**，而套件台是三栏六应用 + 检查器 |
 *
 * 指到「长得像的东西」上是这类改动最容易犯的错：每一页都能打开、都不报错，
 * 只是干的不是这件事。所以字段从「外链地址」改成「内容块标识」，语义一变，
 * 错指就没法再写出来了 —— `'fleet'` 只能映射到编队台那一块。
 *
 * ## 但 `frame` 这个键名还在
 *
 * `server.ts` 的 `/api/health` 直接读 `view.frame`（`views: VIEWS.map(...)`），
 * 而 `server.ts` 不归本线改。所以保留 `frame` 作为**同值别名**，值就是内容块标识；
 * 新增 `content` 作为主名。两者同源，不可能不一致。
 *
 * 本文件不导入任何 node 内置模块，浏览器侧 `import` 同样能用。
 */

export type ViewId = 'chat' | 'fleet' | 'data' | 'suite';

/** 主内容区的内容块。一个视角一块，与 `ViewId` 一一对应但不复用同一个类型： */
/** 视角是「导航项」，块是「渲染单元」，将来一个视角可以挂多块（例如设置抽屉）。 */
export type ContentBlock = 'chat' | 'fleet' | 'data' | 'suite';

export interface ViewSpec {
  id: ViewId;
  /** 地址栏里的路径，也是 `viewForPath` 的键。 */
  path: string;
  /** 左导航上的名字（短）。规格要求一行小字，所以名字要能塞进 4 个字。 */
  label: string;
  /** 左导航第二行的小字说明（第 25.4.2 节：图标 + 一行小字）。 */
  hint: string;
  /** 主内容区画哪一块。**不再是一个 URL。** */
  content: ContentBlock;
  /**
   * `content` 的同值别名。
   *
   * 只为 `server.ts::health()` 保留 —— 它读 `view.frame` 并回给 Electron 主进程与自测。
   * 值永远等于 `content`，见 `VIEWS` 的构造方式。
   */
  frame: ContentBlock;
  /** 中栏标题与 `<title>`。 */
  title: string;
  /** 左导航图标：几何符号，不用 emoji（第 25.4.2 节）。 */
  glyph: string;
  /** 归档到哪个面板文件；`shell.js` 据此动态 `import()`，首屏只加载当前视角。 */
  module: string;
}

/** 外壳页文件名；`server.ts` 与测试都读这一份。 */
export const LAYOUT_FILE = 'layout.html';

/**
 * 四个视角，顺序即左导航顺序。
 *
 * 规格第 25.4.1 节给的是「四个视角 + 设置」；设置不是一个视角，是顶栏上的一个弹层，
 * 所以这里只有四个。
 */
export const VIEWS: readonly ViewSpec[] = [
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

/** 路径 → 视角；不是视角路由就是 `undefined`（`/`、`/api/*` 原样走老逻辑）。 */
export function viewForPath(pathname: string): ViewSpec | undefined {
  const normal = pathname.replace(/\/+$/, '') || '/';
  return VIEWS.find((view) => view.path === normal);
}

/** 视角 id → 视角；`shell.js` 用 URL 里的 `?view=` 恢复视角。 */
export function viewById(id: string | null | undefined): ViewSpec | undefined {
  return VIEWS.find((view) => view.id === id);
}

/**
 * 外壳页里需要被替换的占位；测试按这份清单核对 layout.html。
 *
 * 视-0 之后不再有 `FRAME_SRC` / `FRAME_MODE`：主内容不是 iframe，没有 src 要填。
 * 换成 `VIEW_CONTENT`（内容块标识）与 `NAV_ITEMS`（左导航的四个链接，由服务端渲染进 HTML，
 * 这样即使 JS 挂了，导航也仍然可见、可点）。
 */
export const LAYOUT_TOKENS = ['VIEW_ID', 'VIEW_TITLE', 'VIEW_CONTENT', 'NAV_ITEMS'] as const;

/** 一个视角的占位取值。 */
export function layoutValues(view: ViewSpec): Record<(typeof LAYOUT_TOKENS)[number], string> {
  return {
    VIEW_ID: view.id,
    VIEW_TITLE: view.title,
    VIEW_CONTENT: view.content,
    NAV_ITEMS: navItems(view.id),
  };
}

/** 转义成 HTML 文本：视角名与说明是常量，但仍然走一遍，免得以后改成数据时漏掉。 */
function escapeHtml(value: string): string {
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
 * `aria-current="page"` 标当前项 —— 这是「三个视觉手段至少用两个」里的可访问性那一半：
 * 竖条与背景色是视觉的，`aria-current` 给读屏。
 */
export function navItems(activeId: ViewId | string): string {
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

/**
 * 把占位换成取值；未知占位原样留下，方便一眼看出模板和代码脱节。
 *
 * `NAV_ITEMS` 与其余占位一视同仁地替换 —— 但它是 HTML 片段，所以替换时不自作转义。
 * 片段由 `navItems()` 生成，来源是本文件的常量，不来自外部输入。
 */
export function renderLayout(template: string, view: ViewSpec): string {
  const values = layoutValues(view);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = (values as Record<string, string>)[key];
    return value === undefined ? match : value;
  });
}
