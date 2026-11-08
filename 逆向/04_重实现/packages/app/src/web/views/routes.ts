/**
 * 四个视角路由表的**类型层** —— 数据与函数都在 `routes.js` 里。
 *
 * ## 为什么拆成 .js + .ts 两个文件
 *
 * 同一份表有两种消费者：
 *
 *   · `server.ts`（Node）：`import { VIEWS, renderLayout } from './web/views/routes.ts'`，
 *     走 Node 的类型剥离，`tsc` 也要能在这里查类型；
 *   · `shell.js`（浏览器）：只能 `import './routes.js'` —— 服务端不认 `.ts` 且带 `nosniff`，
 *     实测浏览器会报 `Expected a JavaScript-or-Wasm module script but the server responded
 *     with a MIME type of "application/octet-stream"`。
 *
 * 如果直接写两个文件各存一份表，迟早会一边改了另一边忘 —— 那种撕裂是静默的：
 * 服务端说 `/fleet` 是编队台，浏览器还按地图页画。所以**表只有一份，在 `.js` 里**，
 * 本文件不定义任何数据，只把类型贴上去再 re-export。
 *
 * `server.ts` 与本文件的所有 importers 一行都不用改。
 */

import {
  LAYOUT_FILE as RAW_LAYOUT_FILE,
  LAYOUT_TOKENS as RAW_LAYOUT_TOKENS,
  VIEWS as RAW_VIEWS,
  layoutValues as rawLayoutValues,
  navItems as rawNavItems,
  renderLayout as rawRenderLayout,
  viewById as rawViewById,
  viewForPath as rawViewForPath,
} from './routes.js';

export type ViewId = 'chat' | 'fleet' | 'data' | 'suite';

/**
 * 主内容区的内容块。
 *
 * 与 `ViewId` 一一对应但**不复用同一个类型**：视角是「导航项」，块是「渲染单元」，
 * 将来一个视角可以挂多块（例如设置抽屉）。
 */
export type ContentBlock = 'chat' | 'fleet' | 'data' | 'suite';

/** 占位清单；测试按这份清单核对 `layout.html`。 */
export type LayoutToken = 'VIEW_ID' | 'VIEW_TITLE' | 'VIEW_CONTENT' | 'NAV_ITEMS';

export interface ViewSpec {
  id: ViewId;
  /** 地址栏里的路径，也是 `viewForPath` 的键。 */
  path: string;
  /** 左导航上的短名（规格要求一行小字，名字要能塞进 4 个字）。 */
  label: string;
  /** 左导航第二行的小字说明（图标 + 一行小字，25.4.2）。 */
  hint: string;
  /** 主内容区画哪一块。**不是一个 URL。** */
  content: ContentBlock;
  /** `content` 的同值别名，只为 `server.ts::health()` 保留。 */
  frame: ContentBlock;
  /** `<title>` 与主内容页头的名字。 */
  title: string;
  /** 左导航图标：几何符号，不用 emoji（25.4.2）。 */
  glyph: string;
  /** 视角模块路径，`shell.js` 据此动态 `import()`。 */
  module: string;
}

export const LAYOUT_FILE: string = RAW_LAYOUT_FILE;

export const LAYOUT_TOKENS: readonly LayoutToken[] = RAW_LAYOUT_TOKENS as readonly LayoutToken[];

export const VIEWS: readonly ViewSpec[] = RAW_VIEWS as readonly ViewSpec[];

/** 路径 → 视角；不是视角路由就是 `undefined`。 */
export const viewForPath = rawViewForPath as (pathname: string) => ViewSpec | undefined;

/** 视角 id → 视角。 */
export const viewById = rawViewById as (id: string | null | undefined) => ViewSpec | undefined;

/** 左导航的四个链接（HTML 片段，服务端渲染）。 */
export const navItems = rawNavItems as (activeId: ViewId | string) => string;

/** 一个视角的占位取值。 */
export const layoutValues = rawLayoutValues as (
  view: ViewSpec,
) => Record<LayoutToken, string>;

/** 把占位换成取值。 */
export const renderLayout = rawRenderLayout as (template: string, view: ViewSpec) => string;
