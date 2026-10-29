/**
 * DOM id / selector composition.
 *
 * Two independent contracts live here, both taken from the original verbatim:
 *  - the container ids built by `createMainPanel` (`jarvisInterface.js:893-1141`);
 *  - the `feature+field → selector` rule of `genericView.updateView`
 *    (`genericView.js:25-77`, tabulated in `03_分析/01_Manage主界面与视图层.md §5.1`).
 *
 * These are plain functions on purpose: both the view layer and its tests must be able to
 * compute the exact string without touching the DOM.
 */

import type { TabId } from './types.ts';

export const MENU_COMPONENTS = [
  'itk',
  'deviceDetails',
  'deviceExport',
  'deviceUpdate',
  'deviceRestart',
  'terminalConsole',
  'networkingSettings',
  'displaysSettings',
  'languageSettings',
  'generalSettings',
] as const;

/** `tabs-3` → 3; `grit-tabs-3` → 3. */
export function tabIndexOf(tab: TabId): number {
  const match = /(\d+)$/.exec(tab ?? '');
  return match ? Number(match[1]) : -1;
}

export function isGritTab(tab: TabId): boolean {
  return (tab ?? '').startsWith('grit-');
}

export function deviceTileIdOf(tab: TabId): string {
  return tab;
}

/* ------------------------------------------------------------ containers */

export const fetchLoaderId = (tab: TabId): string => `fetch-loader-${tab}`;
export const eventsPanelId = (tab: TabId): string => `events-panel-${tab}`;
export const menuBarPanelId = (tab: TabId): string => `menuBar-panel-${tab}`;
export const statusPanelId = (tab: TabId): string => (isGritTab(tab) ? `grit-status-panel-${tab}` : `status-panel-${tab}`);
export const mainPanelId = (tab: TabId): string => `main-panel-${tab}`;
export const statusConfigId = (tab: TabId): string => `status-config-${tab}`;
export const statusComponentsId = (tab: TabId): string => (isGritTab(tab) ? `grit-status-components-${tab}` : `status-components-${tab}`);
export const statusComponentsPage2Id = (tab: TabId): string => (isGritTab(tab) ? `grit-status-components-page2-${tab}` : `status-components-page2-${tab}`);
export const configComponentsId = (tab: TabId): string => `config-components-${tab}`;
/**
 * `#connection-loader` — **the same id on every tab** (`jarvisInterface.js:1129`). Per R14 the
 * duplicate is disambiguated by the `#<tab> ` prefix, never by making the id unique.
 */
export const connectionLoaderId = (_tab?: TabId): string => 'connection-loader';
/** The scoped form every caller must use: `#<tab> #connection-loader`. */
export const connectionLoaderSelector = (tab: TabId): string => `#${tab} #connection-loader`;
export const tileDomId = (index: number, tab: TabId): string => `tile-${index}-${tab}`;
/** `createMenuComponents` (`jarvisInterface.js:1237-1286`): `<name>-layout_<tab>`. */
export const menuLayoutId = (name: string, tab: TabId): string => `${name}-layout_${tab}`;
/** Tile fragments ship their own page-local ids; the wrapper is what Packery sees. */
export const TILE_CLASS = 'tile manage-tile status-tile';
export const SECONDARY_TILE_CLASS = 'tile status-tile';
/** `jarvisInterface.js:1482` — the statusBar tile is *renamed* after `createTile`. */
export const RECEIVER_PANEL_CLASS = 'tile receiverPanel';
/** `jarvisInterface.js:1563` — the MarinePak positionStatus tile keeps an extra marker class. */
export const MARINEPAK_POSITION_TILE_CLASS = 'tile mPak-posTile manage-tile status-tile';

/**
 * The wrapper class each tile ends up with. `createTile` (`jarvisInterface.js:1217`) only ever
 * writes `tile status-tile`; the final class is assigned by the caller per tile
 * (`:1482` for the statusBar, `:1563-1566` for everything else), which is the only reason Packery
 * (`itemSelector: '.manage-tile'`) sees the grid tiles and not the statusBar.
 */
export function tileClassFor(index: number, spec: { name: string }, features: { isMarinePak?: boolean } = {}): string {
  if (index === 0) return RECEIVER_PANEL_CLASS;
  if (features.isMarinePak && spec.name === 'positionStatus') return MARINEPAK_POSITION_TILE_CLASS;
  return TILE_CLASS;
}

/* -------------------------------------------------------- view selector */

export interface ViewSelectorOptions {
  /** `tab === ''` only: the webui/mobile split of `genericView.js:44-60`. */
  mobile?: boolean;
}

/**
 * `updateView`'s field → selector rule. `featureName` is the component name
 * (`statusBar`, `positionStatus`, …), `field` the name as it appears in `fields`.
 *
 * The order of the original matters (`genericView.js:44-78`): the tab-scoped form is computed
 * first, and the `tab === ''` (webui / landing) forms override it afterwards.
 */
export function viewSelector(featureName: string, field: string, tab: TabId = '', opts: ViewSelectorOptions = {}): string {
  const element = `#${featureName}${field}`;

  if (tab !== '') {
    if (featureName === 'statusBar') return `#status-panel-${tab} ${element}`;
    if (featureName === 'gritStatusBar') return `#grit-status-panel-${tab} ${element}`;
    if (featureName === 'playback' || featureName === 'hot-spot') return `#playback-panel-${tab} ${element}`;
    return `#main-panel-${tab} ${element}`;
  }

  // tab === '': the landing / webui forms.
  const needsDeviceSplit = featureName.includes('Status') || featureName === 'satelliteView';
  if (featureName === 'splashScreen' || featureName === 'statusBar' || featureName === 'gritStatusBar') {
    return element;
  }
  if (needsDeviceSplit) return `${opts.mobile ? '.for-mobiles' : '.for-desktop'} ${element}`;
  return element;
}

export function elementIdFor(featureName: string, field: string): string {
  return `${featureName}${field}`;
}

/* ------------------------------------------------------------- language */

/** `setUpMonitor.html:1830, 2699` — the device type label is `data-lang-<type>-type`. */
export function deviceTypeMarker(type: string): string {
  return `data-lang-${String(type).toLowerCase()}-type`;
}

export function markerFor(key: string): string {
  return `data-lang-${key.toLowerCase()}`;
}
