/**
 * 四个视角的路由表 —— `server.ts` 与 `test/views.test.ts` 共用。
 *
 * 一个视角 = 一条路由 + 一份外壳页（`layout.html`）+ 中栏 iframe 的默认地址。
 * 外壳页是同一份文件，服务器只替换 `{{VIEW_ID}}` / `{{VIEW_TITLE}}` / `{{FRAME_SRC}}`
 * 等占位，四个视角因此不可能长得不一样。
 *
 * 本文件不导入任何东西（也没有 node:*），浏览器侧 import 同样能用。
 */

export type ViewId = 'chat' | 'fleet' | 'data' | 'suite';

export interface ViewSpec {
  id: ViewId;
  /** 地址栏里的路径，也是 `viewForPath` 的键。 */
  path: string;
  /** 左导航上的名字（短）。 */
  label: string;
  /** 中栏标题与 `<title>`。 */
  title: string;
  /** 左侧导航的第二行说明。 */
  hint: string;
  /** 中栏 iframe 的默认地址——必须是现有页面，不改它们。 */
  frame: string;
  /**
   * 现有页面自带的模式开关（`web/index.html` 的 `[data-mode-switch]`）。
   * 空串表示这个页面没有模式开关。外壳页在 iframe load 后按它点一次，
   * 因为 `index.html` 目前**不读** `?mode=pro`（只认 localStorage 的 `fsa-mode`），
   * 所以 `/suite` 的 `?mode=pro` 只是给未来的 index 留的，真正切模式的是这一下点击。
   */
  mode: 'agent' | 'pro' | '';
}

/** 外壳页文件名；`server.ts` 与测试都读这一份。 */
export const LAYOUT_FILE = 'layout.html';

/** 四个视角，顺序即左导航顺序。 */
export const VIEWS: readonly ViewSpec[] = [
  {
    id: 'chat',
    path: '/chat',
    label: '对话',
    title: '对话 · Agent 工作台',
    hint: '会话 / 工具 / 产物',
    // 现有 `/` 就是 Agent 工作台；iframe 直接挂它。
    frame: '/',
    mode: 'agent',
  },
  {
    id: 'fleet',
    path: '/fleet',
    label: '机队',
    title: '机队 · 台站总览',
    hint: '地图 / 台站位置',
    // 目前唯一的独立地图页是 GRIT 的 Luciad 舞台；等专用机队页落地后换这一行。
    frame: '/geo/luciad-stage.html',
    mode: '',
  },
  {
    id: 'data',
    path: '/data',
    label: '数据',
    title: '数据 · 记录与事件',
    hint: '接收机记录 / 事件',
    // 现有可独立打开的“数据”页面是配置壳里的 Events；专用数据页落地后换。
    frame: '/config/events',
    mode: '',
  },
  {
    id: 'suite',
    path: '/suite',
    label: '套件台',
    title: '套件台 · NovAtel 外壳',
    hint: '原版套件（NovAtel）',
    // `/?mode=pro` 先写进 src（未来的 index.html 可以直接认），当前由 mode: 'pro' 点击切换。
    frame: '/?mode=pro',
    mode: 'pro',
  },
];

/** 路径 → 视角；不是视角路由就是 `undefined`（`/`、`/api/*` 原样走老逻辑）。 */
export function viewForPath(pathname: string): ViewSpec | undefined {
  const normal = pathname.replace(/\/+$/, '') || '/';
  return VIEWS.find((view) => view.path === normal);
}

/** 外壳页里需要被替换的占位；测试按这份清单核对 layout.html。 */
export const LAYOUT_TOKENS = ['VIEW_ID', 'VIEW_TITLE', 'VIEW_HINT', 'FRAME_SRC', 'FRAME_MODE'] as const;

/** 一个视角的占位取值。 */
export function layoutValues(view: ViewSpec): Record<(typeof LAYOUT_TOKENS)[number], string> {
  return {
    VIEW_ID: view.id,
    VIEW_TITLE: view.title,
    VIEW_HINT: view.hint,
    FRAME_SRC: view.frame,
    FRAME_MODE: view.mode,
  };
}

/** 把占位换成取值；未知占位原样留下，方便一眼看出模板和代码脱节。 */
export function renderLayout(template: string, view: ViewSpec): string {
  const values = layoutValues(view);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = (values as Record<string, string>)[key];
    return value === undefined ? match : value;
  });
}
