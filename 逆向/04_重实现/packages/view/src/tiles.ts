/**
 * Tile system — `jarvisInterface.createTile` (`01_解包/app/jarvisInterface.js:1215-1235`), the
 * per-model tile set of `03_分析/01_Manage主界面与视图层.md §3.2` and the Packery *identity class*
 * convention of `§3.3` (`dynamicTiles.js:502-505`).
 *
 * Three contracts are implemented here and nowhere else:
 *
 *  - **Placement (R17).** `createTile(tab, index, page)`: `index === 0` → `#status-panel-<tab>`,
 *    `page === 'page2'` → `#status-components-page2-<tab>`, otherwise `#status-components-<tab>`.
 *    The wrapper starts as `tile status-tile` (`ids.SECONDARY_TILE_CLASS`) and its id is
 *    `tile-<index>-<tab>`; `manage-tile` is added *by the layout engine*, never here.
 *  - **Mounting (R18).** `FragmentLoader.load()`'s real fragment is written into the wrapper, so the
 *    fragment's **first child div** *is* the wrapper's first child div. That element's class list
 *    must contain a `*-status` token (or `satellite-view`) or the tile never enters a layout
 *    snapshot (`dynamicTiles.js:502-505`) — which is exactly what `identityClassOf()` computes.
 *  - **The plan (§3.2).** `planTiles(features)` is decided by `FeatureFlags` only; where the
 *    analysis document and the source disagree, the **source wins** and the test file records the
 *    divergence with line numbers (the task's rule). Two such divergences exist:
 *    1. §3.2's "standard OEM (incl. MarinePak)" row is the *MarinePak* branch order verbatim
 *       (`:1570-1684`); the plain OEM branch (`:1686-1831`) also creates `deviceInfo` and puts
 *       `interferenceStatus`/`logStatus` before `satelliteView`, with `pppCorrections` after it.
 *    2. §3.2's GIII row (`positionStatus → agcStatus`) is the **unreachable** branch at
 *       `:1857-1933` — it sits inside `if (!getIsLongHorn && !getIsGIII)` (`:1452`, `:1495`). The
 *       live GIII flow is `:2100-2176`: `positionStatus`, `deviceInfo`, `satelliteView`,
 *       `logStatus`, `agcStatus` on page 1 and `satelliteTracking` on page 2.
 *
 * Fragments are model-dependent *per tile*, not by a uniform prefix (`createComponent`'s fourth
 * argument, `:4779-4816`): Longhorn takes `lghn-<name>.html` for positionStatus/2d-sd/height-sd
 * only, and GIII takes `giii-<name>.html` for positionStatus/deviceInfo/logStatus/satelliteTracking
 * only — `agcStatus` and `satelliteView` ship in the plain form for every model.
 */

import {
  SECONDARY_TILE_CLASS,
  statusComponentsId,
  statusComponentsPage2Id,
  statusPanelId,
  tileDomId,
} from './ids.ts';
import {
  DEFAULT_FEATURES,
  type FeatureFlags,
  type FragmentLoader,
  type TabId,
  type TilePage,
  type TileSpec,
  type TileSystem,
} from './types.ts';

/* ------------------------------------------------------------------------ DOM surface */

interface TileNode {
  id: string;
  className: string;
  tagName: string;
  innerHTML: string;
  readonly firstElementChild: TileNode | null;
  readonly children: TileNode[];
  readonly ownerDocument: { createElement(tagName: string): TileNode };
  appendChild(node: unknown): unknown;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TileNode | null;
  remove(): void;
}

/** The only thing the tile system needs from the page: a way to resolve a container id. */
export interface TileDomRoot {
  querySelector(selector: string): TileNode | null;
}

/* --------------------------------------------------------------------- the tile plan (§3.2) */

function tile(name: string, identityClass: string, page: TilePage = ''): TileSpec {
  return { name, identityClass, page };
}

/**
 * `GenricPositioModes.NONE` is `0` in the original (`NovatelIdConstants.js:1009-1020`) while
 * `FeatureFlags.positionModes` is typed `string[]`, so both spellings of "no position mode" are
 * accepted here.
 */
const NONE_MODES = new Set(['NONE', '0']);

function allowsPppCorrections(features: FeatureFlags): boolean {
  return !features.positionModes.some((mode) => NONE_MODES.has(String(mode)));
}

/** `rxGen != "OEM6" && rxGen != "OEMSTAR"` — the guard of interferenceStatus and logStatus. */
function supportsInterference(features: FeatureFlags): boolean {
  return features.generation !== 'OEM6' && features.generation !== 'OEMSTAR';
}

function standardPlan(features: FeatureFlags): TileSpec[] {
  const interference = supportsInterference(features);
  const specs: TileSpec[] = [
    tile('statusBar', 'row status-bar'), // index 0, `#status-panel-<tab>` (`:1479-1483`)
    // `:1500` — page 2 is filled *first*, at index 1, so `tile-1-<tab>` is the tracking plot.
    tile('satelliteTracking', 'satelliteTracking-status', 'page2'),
    tile('positionStatus', 'position-status'), // :1559
    tile('deviceInfo', 'device-status'), // :1687 — absent from the MarinePak branch
  ];
  // `:1694-1712`: one slot, either interference (OEM7+) or logStatus (OEM6/OEMSTAR).
  if (interference) specs.push(tile('interferenceStatus', 'interference-status'));
  else specs.push(tile('logStatus', 'log-status'));
  specs.push(tile('satelliteView', 'satellite-view')); // :1714
  if (allowsPppCorrections(features) && features.terrastarSupported) {
    specs.push(tile('pppCorrections', 'pppCorrection-status')); // :1721-1730
  }
  if (features.alignSupported) specs.push(tile('alignStatus', 'align-status')); // :1731-1750
  if (features.spanSupported) specs.push(tile('spanStatus', 'span-status')); // :1753-1769
  if (interference) specs.push(tile('logStatus', 'log-status')); // :1781-1790
  specs.push(tile('portStatus', 'port-status')); // :1792-1800
  if (features.radioTxSupported) specs.push(tile('radioStatus', 'radio-status')); // :1806-1831
  return specs;
}

/** `:1570-1684` — the branch §3.2 tabulates. It has no `deviceInfo` tile. */
function marinePakPlan(features: FeatureFlags): TileSpec[] {
  const interference = supportsInterference(features);
  const specs: TileSpec[] = [
    tile('statusBar', 'row status-bar'),
    tile('satelliteTracking', 'satelliteTracking-status', 'page2'),
    tile('positionStatus', 'position-status'), // :1559-1568 (mPak-posTile)
  ];
  if (allowsPppCorrections(features)) specs.push(tile('pppCorrections', 'pppCorrection-status')); // :1570-1579
  specs.push(tile('satelliteView', 'satellite-view')); // :1580-1586
  if (features.alignSupported) specs.push(tile('alignStatus', 'align-status')); // :1587-1606
  if (features.spanSupported) specs.push(tile('spanStatus', 'span-status')); // :1609-1621
  if (interference) specs.push(tile('interferenceStatus', 'interference-status')); // :1625-1633
  if (interference) specs.push(tile('logStatus', 'log-status')); // :1634-1643
  specs.push(tile('portStatus', 'port-status')); // :1644-1652
  if (features.radioTxSupported) specs.push(tile('radioStatus', 'radio-status')); // :1659-1684
  return specs;
}

/** `:1971-2016` — page 2 (`#status-pages2`) is hidden for Longhorn (`:1555-1557`, `:1918-1920`). */
function longhornPlan(): TileSpec[] {
  return [
    tile('statusBar', 'row status-bar'),
    tile('positionStatus', 'position-status'), // :1985 — lghn-positionStatus.html
    tile('2d-sd', '2d-sd-status'), // :1991
    tile('height-sd', 'height-sd-status'), // :1997
    tile('deviceInfo', 'device-status'), // :2002
    tile('satelliteView', 'satellite-view'), // :2008
  ];
}

/** `:2100-2176` — the live GIII flow (see the header note about §3.2's dead twin). */
function giiiPlan(): TileSpec[] {
  return [
    tile('statusBar', 'row status-bar'),
    tile('positionStatus', 'position-status'), // :2118 — giii-positionStatus.html
    tile('deviceInfo', 'device-status'), // :2125 — giii-deviceInfo.html
    tile('satelliteView', 'satellite-view'), // :2134
    tile('logStatus', 'log-status'), // :2142 — giii-logStatus.html
    tile('agcStatus', 'agc-status'), // :2160
    tile('satelliteTracking', 'satelliteTracking-status', 'page2'), // :2175
  ];
}

/**
 * §3.2's tile set for one receiver, in creation order — which is also the order of the
 * `tile-<index>-<tab>` ids the original stamps on them. Flags only; no global state, no DOM.
 */
export function planTiles(features: FeatureFlags): TileSpec[] {
  if (features.isLongHorn) return longhornPlan();
  if (features.isGIII) return giiiPlan();
  return features.isMarinePak ? marinePakPlan(features) : standardPlan(features);
}

/* ------------------------------------------------------------------ fragment paths (R18) */

/** `createComponent` is called with `isLongHornOrGIII = true` for exactly these GIII tiles. */
const GIII_VARIANTS = new Set(['positionStatus', 'deviceInfo', 'logStatus', 'satelliteTracking']);
/** …and for exactly these Longhorn tiles. */
const LONGHORN_VARIANTS = new Set(['positionStatus', '2d-sd', 'height-sd']);

/** `./../<name>/<name>.html`, plus the `lghn-` / `giii-` variants `createComponent` switches to. */
export function fragmentPathFor(spec: TileSpec, features: FeatureFlags): string {
  if (features.isGIII && GIII_VARIANTS.has(spec.name)) return `./../${spec.name}/giii-${spec.name}.html`;
  if (features.isLongHorn && LONGHORN_VARIANTS.has(spec.name)) return `./../${spec.name}/lghn-${spec.name}.html`;
  return `./../${spec.name}/${spec.name}.html`;
}

/* ---------------------------------------------------------------------- identity class (§3.3) */

/**
 * `dynamicTiles.js:502-505` verbatim: first direct-child **div** of the tile, then the first class
 * token that ends in `-status` or is `satellite-view`. `undefined` means "this tile has no layout
 * identity" (the statusBar tile, whose first div is `row status-bar`).
 */
export function identityClassToken(className: string | null | undefined): string | undefined {
  if (!className) return undefined;
  return className
    .split(/\s+/)
    .find((token) => token.endsWith('-status') || token === 'satellite-view');
}

/* --------------------------------------------------------------------------- placement (R17) */

/** `createTile`'s three-way target (`:1219-1234`), for GRIT tabs included (`ids.ts` does that). */
export function tileTargetId(tab: TabId, spec: TileSpec, index: number): string {
  if (index === 0) return statusPanelId(tab);
  if (spec.page === 'page2') return statusComponentsPage2Id(tab);
  return statusComponentsId(tab);
}

/* ------------------------------------------------------------------------------ the system */

export interface TileSystemOptions {
  /** Resolves `#status-panel-<tab>` … — the document, or the scope the panels were built in. */
  root?: () => TileDomRoot | null | undefined;
  /** The real fragment reader (`test/helpers.ts#realFragmentLoader` in tests). */
  loader?: FragmentLoader;
  /** Model of the tab; drives the `lghn-`/`giii-` fragment variants. */
  features?: () => FeatureFlags;
  /** Overrides `fragmentPathFor` (tests, GRIT). */
  fragmentPath?: (spec: TileSpec, features: FeatureFlags) => string;
}

export function createTileSystem(options: TileSystemOptions = {}): TileSystem {
  const rootOf = options.root ?? ((): TileDomRoot | null => null);
  const featuresOf = options.features ?? ((): FeatureFlags => DEFAULT_FEATURES);
  const loader: FragmentLoader =
    options.loader ??
    {
      load(): string {
        throw new Error('tiles: no FragmentLoader was supplied');
      },
    };
  const mounted = new Map<TabId, TileNode[]>();

  function list(tab: TabId): TileNode[] {
    const existing = mounted.get(tab);
    if (existing) return existing;
    const created: TileNode[] = [];
    mounted.set(tab, created);
    return created;
  }

  return {
    plan: (features) => planTiles(features),

    mount(tab: TabId, spec: TileSpec, index: number): Element {
      const targetId = tileTargetId(tab, spec, index);
      const target = rootOf()?.querySelector('#' + targetId);
      if (!target) throw new Error(`tiles: container #${targetId} is missing for ${spec.name}`);

      const wrapper = target.ownerDocument.createElement('div');
      wrapper.className = SECONDARY_TILE_CLASS; // R17: 'tile status-tile', never 'manage-tile'
      wrapper.id = tileDomId(index, tab);
      const features = featuresOf();
      const path = options.fragmentPath ? options.fragmentPath(spec, features) : fragmentPathFor(spec, features);
      wrapper.innerHTML = loader.load(path); // R18: the fragment's first div becomes our first div
      target.appendChild(wrapper);
      list(tab).push(wrapper);
      return wrapper as unknown as Element;
    },

    mounted: (tab) => [...(mounted.get(tab) ?? [])] as unknown as Element[],

    identityClassOf(tileElement: Element): string | undefined {
      const node = tileElement as unknown as TileNode;
      const firstDiv = node.children.find((child) => child.tagName.toLowerCase() === 'div');
      if (!firstDiv) return undefined;
      return identityClassToken(firstDiv.getAttribute('class'));
    },

    unmount(tab: TabId): void {
      for (const tile of mounted.get(tab) ?? []) tile.remove();
      mounted.delete(tab);
    },
  };
}
