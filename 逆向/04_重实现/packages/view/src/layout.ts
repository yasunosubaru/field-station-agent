/**
 * Packery-equivalent tile layout — `view/dynamicTiles/dynamicTiles.js` (and the Packery
 * instance it drives), reimplemented as one dependency-free object.
 *
 * The whole subsystem is a single grid: 3 columns, 2 px gutters, **one column per tile**
 * (`03_分析/01_Manage主界面与视图层.md §3.5`). Positions are persisted per **device tile id**,
 * never per tab, so an SM tab and a GRIT tab of the same receiver share their layout (§3.4).
 *
 * Acceptance criteria implemented here (`01_Manage主界面与视图层.md §8`; the tests carry the
 * numbers):
 *
 *  - `R19` `metricsFor()` = 3 columns, `columnWidth = floor((width-4)/3)`, `gutter = 2`;
 *    `PACKERY_OPTIONS` carries the static options of `dynamicTiles.js:309-328`, and
 *    `packeryOptionsFor()` supplies the width-dependent `columnWidth`.
 *  - `R20` a tile is always one column wide: a snapshot is `{id, position:{left, top}}` and
 *    nothing else — no width/height/span is ever written (`dynamicTiles.js:615-621, 572-578`).
 *  - `R21` the drag handle is `.status-header` (each tile's header also carries the `drag-area`
 *    class); while dragging, every `.statustiles-traffic` of the tab gets `pointer-events:none`
 *    (`dynamicTiles.js:396-417, 926-938`).
 *  - `R22` a drag always ends in `save()`, which writes
 *    `userStore.userStoreJSON.app.dynamic[deviceTileId]` (`dynamicTiles.js:440-454, 765-782`).
 *  - `R23` a changed layout shows the 10 s undo banner; `undo()` restores the snapshot taken at
 *    `dragStart` and saves the restored layout again (`dynamicTiles.js:175-275`).
 *  - `R24` the default layout is captured on first entry when it is missing, has no position
 *    data, holds a different number of items than there are tiles, holds a different id set
 *    than `dynamic`, or has every tile in the same column (`dynamicTiles.js:377-391`). The
 *    source counts `$container.children('div')`, which happily counts the undo banner as a tile;
 *    here the count is the tiles Packery actually selects. The capture keeps **DOM order** — the
 *    source pushes `$tile.position()` in DOM order (`:355-376`) while `dynamic` comes from the
 *    sorted `getCurrentLayout()`, which is why the id comparison is done on sorted sets.
 *  - `R25` layouts are ordered by `top` (a 20 px difference still counts as the same row) then
 *    by `left`, rounded to whole pixels (`dynamicTiles.js:627-639`).
 *  - `R26` `destroy()` saves before tearing the instance down (`dynamicTiles.js:887-903`).
 *
 * What the reimplementation does on purpose, and why:
 *
 *  - `deviceTileId` is passed in by `initialise()` (the source reads `jarvisInterface.tabids[tab]`);
 *    an empty id is a no-op, exactly like the `if (!tileId) return` guard of
 *    `dynamicTiles.js:285-288`.
 *  - `#resetDefault` is found by walking up from the container to the tab root instead of the
 *    source's document-wide duplicate-id selector (`dynamicTiles.js:880` uses `#<tab>
 *    #resetDefault`, and every tab ships its own `id="resetDefault"` element).
 *  - `resetButtonVisible()`: the source sets `display:block` when `isLayoutDifferent()` is
 *    **false** (`dynamicTiles.js:880`). Tracing that function (`:645-763`) shows it returns
 *    false as soon as one tile sits more than 60 px away from its default slot and true when
 *    everything is within 60 px — the *name* is inverted, not the polarity, so the observable
 *    source behaviour is already "visible once the user moved something". §6.5 `[观察]` reads
 *    it the other way round and asks for "visible when different"; this reimplementation keeps
 *    the document's wording and the source's observable behaviour, but exposes the honest name:
 *    `isDifferent(tab)` is true when the layout moved away from `defaultLayout`, and
 *    `resetButtonVisible(tab)` is exactly that. `restore()` then prefers the stored `dynamic`
 *    layout and falls back to `defaultLayout`, which is what the source's inverted
 *    `isLayoutDifferent(tab, true) ? defaultLayout : dynamic` amounts to.
 *
 * The engine is **synchronous**: the source's `setTimeout(loadLayout, 100)` /
 * `setTimeout(updateResetButtonVisibility, 1000)` only ever delay work the clock cannot observe
 * elsewhere, and the `Clock` is used where the delay *is* observable (the 10 s undo banner and
 * the 300 ms banner removal).
 *
 * Positions are read from and written to the tile's own box (inline `left`/`top`, i.e. the
 * container-relative coordinates §3.4 documents). The source mixes two coordinate spaces — its
 * default capture uses jQuery `.position()` (offset-parent relative, `:365`) while `dynamic`
 * uses Packery's `item.position` (`:615-621`) — this reimplementation uses one, the container's.
 */

import type { Clock } from './clock.ts';
import { TILE_CLASS } from './ids.ts';
import type {
  DeviceTileId,
  GridMetrics,
  LayoutEngine,
  LayoutItem,
  LayoutSnapshot,
  TabId,
  UserStoreLike,
} from './types.ts';

/* ---------------------------------------------------------------- constants */

/** `dynamicTiles.js:309-313`: `totalGutters = 2`, `gutterSize = 2`, `availableWidth / 3`. */
export const PACKERY_COLUMNS = 3;
export const PACKERY_GUTTER = 2;
export const PACKERY_TOTAL_GUTTERS = 2;

/**
 * The tile wrapper class Packery selects. Derived from `ids.TILE_CLASS`
 * (`tile status-tile manage-tile`) so the class list has one source of truth.
 */
const MANAGE_TILE_CLASS =
  TILE_CLASS.split(/\s+/).find((token) => token === 'manage-tile') ?? 'manage-tile';
export const ITEM_SELECTOR = '.' + MANAGE_TILE_CLASS;

/** The static Packery options of `dynamicTiles.js:316-327`, verbatim (R19). */
export const PACKERY_OPTIONS = {
  itemSelector: ITEM_SELECTOR,
  transitionDuration: 0,
  resize: false,
  initLayout: true,
  stagger: 0,
  isOriginLeft: true,
  isOriginTop: true,
  percentPosition: false,
} as const;

/** The identity class of the satellite view tile (`dynamicTiles.js:363`). */
export const SATELLITE_VIEW_CLASS = 'satellite-view';

/** `dynamicTiles.js:629` — tops within this many px count as the same row (R25). */
export const ROW_THRESHOLD = 20;

/** `dynamicTiles.js:652` — how far a tile may drift before the layout counts as changed. */
export const POSITION_THRESHOLD = 60;

/** `.tile{min-height:350px}` (`style.css:379-390`) — the row height when nothing is measured. */
export const TILE_MIN_HEIGHT = 350;

/** `dynamicTiles.js:398, 926-938` — the drag handle and the hover hook live on this element. */
export const DRAG_HANDLE_SELECTOR = '.status-header';
export const DRAG_AREA_CLASS = 'drag-area';

/** `dynamicTiles.js:414-435`. */
export const DRAG_Z_INDEX = '1004';
export const TRAFFIC_SELECTOR = '.statustiles-traffic';

/** `dynamicTiles.js:151-192`: the banner, its `show` class, 10 s life, 300 ms removal. */
export const UNDO_BANNER_CLASS = 'undo-banner';
export const UNDO_BANNER_SHOW_CLASS = 'show';
export const UNDO_BANNER_TIMEOUT_MS = 10000;
export const UNDO_BANNER_REMOVE_MS = 300;

/** `jarvisInterface.js:1035-1044` — the reset control of `#status-config-<tab>`. */
export const RESET_BUTTON_ID = 'resetDefault';

/** `userStore.userStoreJSON.app.dynamic` / `.defaultLayout`. */
export type LayoutBucket = 'dynamic' | 'defaultLayout';

/* ------------------------------------------------------------------ helpers */

/** Every element child that Packery would take as an item (`.manage-tile`). */
export function tileElements(container: Element): Element[] {
  return Array.from(container.children).filter((child) => child.classList.contains(MANAGE_TILE_CLASS));
}

/**
 * The identity Packery persists for a tile: the first (in class order) token of the tile's
 * **first child div** that ends in `-status`, or `satellite-view`
 * (`dynamicTiles.js:360-364, 502-505`). A tile without such a token never enters a snapshot (R18).
 */
export function identityClassOf(tile: Element): string | undefined {
  const first = tile.firstElementChild;
  const attribute = first?.getAttribute('class');
  if (!first || !attribute) return undefined;
  return attribute
    .split(/\s+/)
    .filter(Boolean)
    .find((token) => token.endsWith('-status') || token === SATELLITE_VIEW_CLASS);
}

/** The tile's measured position, rounded to whole pixels (R25). */
export function positionOf(tile: Element): { left: number; top: number } {
  const rect = tile.getBoundingClientRect();
  return { left: Math.round(rect.left), top: Math.round(rect.top) };
}

/**
 * `hasPositionData()` of `dynamicTiles.js:345-351`: an array whose first item carries
 * `position.left` / `position.top` (R24).
 */
export function hasPositionData(layout: unknown): boolean {
  if (!Array.isArray(layout) || layout.length === 0) return false;
  const first = layout[0] as Partial<LayoutItem> | undefined;
  if (!first || typeof first !== 'object' || !first.position) return false;
  return typeof first.position.left === 'number' && typeof first.position.top === 'number';
}

/**
 * `getCurrentLayout()`'s sort (`dynamicTiles.js:627-639`): same row when the tops differ by at
 * most `rowThreshold`, then by `left`; otherwise by `top` (R25). Copied verbatim — including the
 * fact that the comparator is not a total order, which is why the tests use unambiguous grids.
 */
export function sortLayoutItems(items: readonly LayoutItem[], rowThreshold = ROW_THRESHOLD): LayoutSnapshot {
  return [...items].sort((a, b) => {
    const topDiff = Math.abs(a.position.top - b.position.top);
    if (topDiff <= rowThreshold) return a.position.left - b.position.left;
    return a.position.top - b.position.top;
  });
}

/** Every tile of the container that Packery sees, in DOM order — the shape `defaultLayout` keeps. */
export function captureLayout(container: Element): LayoutSnapshot {
  const items: LayoutItem[] = [];
  for (const tile of tileElements(container)) {
    const id = identityClassOf(tile);
    if (!id) continue;
    items.push({ id, position: positionOf(tile) });
  }
  return items;
}

/** Grid slot → pixel position: `left = column*(columnWidth+gutter)`, `top = row*(rowHeight+gutter)`. */
export function gridPosition(
  column: number,
  row: number,
  metrics: GridMetrics,
  rowHeight = TILE_MIN_HEIGHT,
): { left: number; top: number } {
  return {
    left: Math.round(column * (metrics.columnWidth + metrics.gutter)),
    top: Math.round(row * (rowHeight + metrics.gutter)),
  };
}

/** `hasLayoutChanged()` of `dynamicTiles.js:526-544`. */
function layoutChanged(before: LayoutSnapshot, after: LayoutSnapshot): boolean {
  if (before.length !== after.length) return true;
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index];
    const b = after[index];
    if (a.id !== b.id || a.position.left !== b.position.left || a.position.top !== b.position.top) return true;
  }
  return false;
}

/** `$(...).css(name, value)`; an empty value removes the declaration, like the real `style`. */
function setStyle(element: Element, name: string, value: string): void {
  (element as HTMLElement).style.setProperty(name, value);
}

/**
 * Write a saved position onto the tile, the way `applyLayout()` does
 * (`dynamicTiles.js:829-834`): an item without a `position` is only reordered, never placed.
 */
function placeTile(tile: Element, position: { left: number; top: number } | undefined): void {
  if (!position) return;
  setStyle(tile, 'left', `${Math.round(position.left)}px`);
  setStyle(tile, 'top', `${Math.round(position.top)}px`);
}

/** Walk up from the container until the tab root (`#tabs-3` / `#grit-tabs-3`) is found. */
function tabRootOf(container: Element, tab: TabId): Element {
  let node: Element | null = container;
  while (node) {
    if (node.id === tab) return node;
    node = node.parentElement;
  }
  return container;
}

/* ------------------------------------------------------------------- engine */

export interface LayoutEngineOptions {
  clock: Clock;
  store: UserStoreLike;
  /** `featuresList.getIsLongHorn(tab)` — a Longhorn tab has no Packery and no reset button. */
  isLongHorn?: (tab: TabId) => boolean;
  /** `__()`; only the undo banner text goes through it. */
  translate?: (key: string) => string;
  /** Row height when a tile has no measurable height (`.tile{min-height:350px}`). */
  rowHeight?: number;
}

/** `LayoutEngine` plus the drag hooks R21 asks for and two test-facing readers. */
export interface LayoutEngineHandle extends LayoutEngine {
  /** `dragStart`: captures `previousState` and disables pointer events on the traffic dots. */
  beginDrag(tab: TabId, identityClass?: string): void;
  /** `dragEnd` + `dragItemPositioned`: restores pointer events, saves, shows the undo banner. */
  endDrag(tab: TabId): void;
  /** The snapshot in R25 order (same list `snapshot()` returns). */
  sortedItems(tab: TabId): LayoutSnapshot;
  banner(tab: TabId): Element | undefined;
  /** R19, complete option object including the dynamic column width. */
  packeryOptionsFor(containerWidth: number): typeof PACKERY_OPTIONS & {
    columnWidth: number;
    gutter: number;
  };
}

interface DragOperation {
  previousState: LayoutSnapshot;
  /** The identity the drag started on; the source stores the whole class string here. */
  dragged: string;
}

interface Instance {
  deviceTileId: DeviceTileId;
  container: Element;
  lastOperation: DragOperation | null;
  dragging: boolean;
  raisedTile: Element | null;
  undoHandle: number | null;
  bannerHandle: number | null;
}

export class PackeryLayoutEngine implements LayoutEngineHandle {
  /** Mirrors `updateResetButtonVisibility` + `saveLayout` being called on every layout change. */
  onLayoutChange?: (tab: TabId) => void;

  private readonly clock: Clock;
  private readonly store: UserStoreLike;
  private readonly longHorn: (tab: TabId) => boolean;
  private readonly translate: (key: string) => string;
  private readonly fallbackRowHeight: number;
  private readonly instances = new Map<TabId, Instance>();

  constructor(options: LayoutEngineOptions) {
    this.clock = options.clock;
    this.store = options.store;
    this.longHorn = options.isLongHorn ?? (() => false);
    this.translate = options.translate ?? ((key: string) => key);
    this.fallbackRowHeight = options.rowHeight ?? TILE_MIN_HEIGHT;
  }

  /* ------------------------------------------------------------ lifecycle */

  /** R19. `columnWidth = floor((containerWidth - totalGutters*gutter) / 3)`, `gutter = 2`. */
  metricsFor(containerWidth: number): GridMetrics {
    const available = containerWidth - PACKERY_TOTAL_GUTTERS * PACKERY_GUTTER;
    return {
      columns: PACKERY_COLUMNS,
      columnWidth: Math.floor(available / PACKERY_COLUMNS),
      gutter: PACKERY_GUTTER,
    };
  }

  /** Complete option set the source hands to `$container.packery()` (`:316-328`). */
  packeryOptionsFor(containerWidth: number): typeof PACKERY_OPTIONS & {
    columnWidth: number;
    gutter: number;
  } {
    const metrics = this.metricsFor(containerWidth);
    return { ...PACKERY_OPTIONS, columnWidth: metrics.columnWidth, gutter: metrics.gutter };
  }

  /**
   * `initialisePackery(tab)` (`dynamicTiles.js:277-488`): bind the packery instance to the
   * container, capture the default layout, then restore the saved one.
   */
  initialise(tab: TabId, deviceTileId: DeviceTileId, container: Element): void {
    // `if (!tileId) return;` — without the device tile id every entry point is a no-op.
    if (!tab || !deviceTileId || !container) return;

    if (this.longHorn(tab)) {
      // `dynamicTiles.js:279-282`: hide `.reset-default-layout` and build nothing.
      const root = tabRootOf(container, tab);
      const target = root.querySelector('.reset-default-layout') ?? root.querySelector('#' + RESET_BUTTON_ID);
      if (target) setStyle(target, 'display', 'none');
      return;
    }

    // `dynamicTiles.js:291-301`: an existing instance is destroyed before the new one is built.
    if (this.instances.has(tab)) this.destroy(tab);

    const instance: Instance = {
      deviceTileId,
      container,
      lastOperation: null,
      dragging: false,
      raisedTile: null,
      undoHandle: null,
      bannerHandle: null,
    };
    this.instances.set(tab, instance);

    // `dynamicTiles.js:329-333`: the drag handle is the tile header, and it is the hover hook.
    for (const tile of tileElements(container)) {
      const handle = tile.querySelector(DRAG_HANDLE_SELECTOR);
      if (!handle) continue;
      setStyle(handle, 'cursor', 'url(../images/ic_cursor_drag_24.svg)');
      handle.classList.add(DRAG_AREA_CLASS);
    }

    this.captureDefaults(tab);
    this.restore(tab);
  }

  /* ----------------------------------------------------------- accessors */

  isActive(tab: TabId): boolean {
    return this.instances.has(tab);
  }

  container(tab: TabId): Element | undefined {
    return this.instances.get(tab)?.container;
  }

  deviceTileId(tab: TabId): DeviceTileId | undefined {
    return this.instances.get(tab)?.deviceTileId;
  }

  /* ------------------------------------------------------------ snapshot */

  /** R25: the current DOM layout, sorted, rounded to whole pixels, `{id, position}` only (R20). */
  snapshot(tab: TabId): LayoutSnapshot {
    const instance = this.instances.get(tab);
    if (!instance) return [];
    return sortLayoutItems(captureLayout(instance.container));
  }

  sortedItems(tab: TabId): LayoutSnapshot {
    return this.snapshot(tab);
  }

  /* ---------------------------------------------------------- persistence */

  /** `saveLayout(tab)` (`dynamicTiles.js:765-782`): key is the **device** tile id (R22). */
  save(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const layout = this.snapshot(tab);
    this.store.set(['app', 'dynamic', instance.deviceTileId], layout);
    this.updateResetButton(tab);
  }

  /** `loadLayout(tab)` (`dynamicTiles.js:784-797`): the stored user layout, else the default. */
  restore(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const layout = this.readLayout('dynamic', instance.deviceTileId) ?? this.readLayout('defaultLayout', instance.deviceTileId);
    if (layout) this.applyLayout(tab, layout);
    this.updateResetButton(tab);
  }

  /** `#status-default` click (`dynamicTiles.js:457-473`). */
  reset(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const defaults = this.readLayout('defaultLayout', instance.deviceTileId);
    if (!defaults) return;
    this.store.set(['app', 'dynamic', instance.deviceTileId], defaults);
    this.applyLayout(tab, defaults);
    instance.lastOperation = null;
    this.hideBanner(tab);
    this.updateResetButton(tab);
    this.onLayoutChange?.(tab);
  }

  /** `getCurrentLayout()` compared against `defaultLayout` (see the header for the polarity). */
  isDifferent(tab: TabId): boolean {
    const instance = this.instances.get(tab);
    if (!instance) return false;
    const current = this.readLayout('dynamic', instance.deviceTileId);
    const defaults = this.readLayout('defaultLayout', instance.deviceTileId);
    if (!current || !defaults || !current.length || !defaults.length) return false;
    if (current.length !== defaults.length) return true;

    const defaultById = new Map<string, LayoutItem>();
    for (const item of defaults) if (!defaultById.has(item.id)) defaultById.set(item.id, item);
    for (const item of current) {
      const reference = defaultById.get(item.id);
      if (!reference) return true;
      const left = item.position?.left;
      const top = item.position?.top;
      const referenceLeft = reference.position?.left;
      const referenceTop = reference.position?.top;
      // A layout item without a numeric position is malformed; treat it as "different" rather
      // than letting `undefined - undefined` slide through as NaN (which is never > threshold).
      if (typeof left !== 'number' || typeof top !== 'number') return true;
      if (typeof referenceLeft !== 'number' || typeof referenceTop !== 'number') return true;
      if (Math.abs(left - referenceLeft) > POSITION_THRESHOLD) return true;
      if (Math.abs(top - referenceTop) > POSITION_THRESHOLD) return true;
    }
    // Positions match within the threshold; a different *order* (the default is captured in DOM
    // order, the current layout is sorted) is not a difference.
    return false;
  }

  /** See `isDifferent()`. The source hides this behind an inverted name (`dynamicTiles.js:880`). */
  resetButtonVisible(tab: TabId): boolean {
    return this.isDifferent(tab);
  }

  /* ---------------------------------------------------------------- drag */

  /** `dragStart` (`dynamicTiles.js:405-417`). */
  beginDrag(tab: TabId, identityClass?: string): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    instance.dragging = true;
    instance.lastOperation = {
      previousState: this.snapshot(tab),
      dragged: identityClass ?? '',
    };
    this.setTrafficPointerEvents(tab, 'none');

    if (identityClass) {
      const tile = this.tileOf(tab, identityClass);
      if (tile) {
        instance.raisedTile = tile;
        setStyle(tile, 'z-index', DRAG_Z_INDEX);
      }
    }
  }

  /** `dragEnd` + `dragItemPositioned` (`dynamicTiles.js:425-454`). */
  endDrag(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;

    this.setTrafficPointerEvents(tab, '');
    if (instance.raisedTile) {
      setStyle(instance.raisedTile, 'z-index', '');
      instance.raisedTile = null;
    }
    instance.dragging = false;

    const previousState = instance.lastOperation?.previousState;
    // `dragItemPositioned` calls `saveLayout` before it looks at the new state.
    this.save(tab);
    const newState = this.snapshot(tab);
    if (previousState && layoutChanged(previousState, newState)) {
      this.showBanner(tab);
      this.updateResetButton(tab);
      this.onLayoutChange?.(tab);
    }
  }

  /**
   * Simulates a drag: place `identityClass` at the 0-based grid slot (`column`, `row`).
   * A call made outside a drag runs the whole gesture (`dragStart` … `dragEnd`), which is what a
   * pointer drag looks like from the outside; inside a drag it only moves the tile (R21).
   */
  moveTo(tab: TabId, identityClass: string, column: number, row: number): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const tile = this.tileOf(tab, identityClass);
    if (!tile) return;

    const ownGesture = !instance.dragging;
    if (ownGesture) this.beginDrag(tab, identityClass);

    const metrics = this.metricsFor(this.containerWidth(instance.container));
    placeTile(tile, gridPosition(column, row, metrics, this.rowHeightOf(tile)));

    if (ownGesture) this.endDrag(tab);
  }

  /* -------------------------------------------------------------- undo */

  /** R23: restore the `dragStart` snapshot and save the restored layout again. */
  undo(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const operation = instance.lastOperation;
    if (!operation || !operation.previousState.length) return;

    this.applyLayout(tab, operation.previousState);
    this.save(tab);
    instance.lastOperation = null;
    this.hideBanner(tab);
    this.updateResetButton(tab);
    this.onLayoutChange?.(tab);
  }

  undoBannerVisible(tab: TabId): boolean {
    const banner = this.banner(tab);
    return !!banner && banner.classList.contains(UNDO_BANNER_SHOW_CLASS);
  }

  banner(tab: TabId): Element | undefined {
    const root = this.tabRoot(tab);
    return root?.querySelector('.' + UNDO_BANNER_CLASS) ?? undefined;
  }

  /* ------------------------------------------------------------ reflow */

  /**
   * `ResizeObserver` → `instance.layout()` (`dynamicTiles.js:75-77`). The shim has no layout
   * engine, so this re-applies the DOM's own absolute positions in R25 order: it is the
   * idempotent "lay the tiles out again" step of a resize.
   */
  reflow(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    this.applyLayout(tab, this.snapshot(tab));
    this.updateResetButton(tab);
  }

  /** R26: `deletePackeryInstances(tab)` — save first, then drop the instance. */
  destroy(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;

    this.save(tab);

    this.setTrafficPointerEvents(tab, '');
    if (instance.undoHandle !== null) this.clock.clearTimeout(instance.undoHandle);
    if (instance.bannerHandle !== null) this.clock.clearTimeout(instance.bannerHandle);
    this.instances.delete(tab);
  }

  /* ------------------------------------------------------------ private */

  /** R24 — the five capture conditions of `dynamicTiles.js:377-383`. */
  private captureDefaults(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const { deviceTileId, container } = instance;

    const tileCount = tileElements(container).length;
    const stored = this.readLayout('defaultLayout', deviceTileId);
    const dynamic = this.readLayout('dynamic', deviceTileId);
    const idsOf = (layout: LayoutSnapshot | undefined): string =>
      (layout ?? [])
        .map((item) => item.id)
        .sort()
        .join();
    const everyLeftEqual =
      !!stored &&
      hasPositionData(stored) &&
      stored.every((item) => item.position?.left === stored[0].position?.left);

    const needsDefault =
      !stored ||
      !hasPositionData(stored) ||
      stored.length !== tileCount ||
      // The source compares `Object.values(default).map(id)` against `dynamic`; a missing
      // `dynamic` entry throws there (`Object.values(undefined)`), which the outer try/catch
      // swallows. Here a missing entry simply counts as "different".
      idsOf(stored) !== idsOf(dynamic) ||
      everyLeftEqual;
    if (!needsDefault) return;

    // `dynamicTiles.js:355-376` captures in **DOM order**, not sorted — `dynamic` is sorted.
    const captured = captureLayout(container);
    this.store.set(['app', 'defaultLayout', deviceTileId], captured);
    // `dynamicTiles.js:386-387` only fills in `dynamic` when the key is absent — a malformed
    // existing entry is left alone (its missing positions are simply not applied).
    if (!dynamic) this.store.set(['app', 'dynamic', deviceTileId], captured);
    this.updateResetButton(tab);
  }

  /** `applyLayout()` / `applyTileState()` (`dynamicTiles.js:546-593, 799-876`). */
  private applyLayout(tab: TabId, layout: LayoutSnapshot): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const container = instance.container;
    const tiles = tileElements(container);

    const byIdentity = new Map<string, Element>();
    for (const tile of tiles) {
      const identity = identityClassOf(tile);
      if (identity && !byIdentity.has(identity)) byIdentity.set(identity, tile);
    }

    const ordered: Element[] = [];
    const placed = new Set<Element>();
    for (const item of layout) {
      const tile = byIdentity.get(item.id);
      if (!tile) continue;
      byIdentity.delete(item.id);
      placeTile(tile, item.position);
      ordered.push(tile);
      placed.add(tile);
    }
    // `$container.empty()` then "append any remaining tiles" — they keep their DOM order.
    for (const tile of tiles) if (!placed.has(tile)) ordered.push(tile);
    for (const tile of ordered) container.appendChild(tile);
  }

  private tileOf(tab: TabId, identityClass: string): Element | undefined {
    const instance = this.instances.get(tab);
    if (!instance) return undefined;
    for (const tile of tileElements(instance.container)) {
      if (identityClassOf(tile) === identityClass) return tile;
    }
    return undefined;
  }

  private setTrafficPointerEvents(tab: TabId, value: string): void {
    const root = this.tabRoot(tab);
    if (!root) return;
    for (const element of Array.from(root.querySelectorAll(TRAFFIC_SELECTOR))) setStyle(element, 'pointer-events', value);
  }

  private tabRoot(tab: TabId): Element | undefined {
    const instance = this.instances.get(tab);
    if (!instance) return undefined;
    return tabRootOf(instance.container, tab);
  }

  private updateResetButton(tab: TabId): void {
    const root = this.tabRoot(tab);
    const button = root?.querySelector('#' + RESET_BUTTON_ID);
    if (!button) return;
    setStyle(button, 'display', this.resetButtonVisible(tab) ? 'block' : 'none');
  }

  /** `showUndoBanner(tab)` (`dynamicTiles.js:175-192`). */
  private showBanner(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const banner = this.banner(tab) ?? this.createBanner(tab, instance.container);
    if (!banner) return;
    if (instance.bannerHandle !== null) {
      this.clock.clearTimeout(instance.bannerHandle);
      instance.bannerHandle = null;
    }
    banner.classList.add(UNDO_BANNER_SHOW_CLASS);
    if (instance.undoHandle !== null) this.clock.clearTimeout(instance.undoHandle);
    instance.undoHandle = this.clock.setTimeout(() => {
      instance.undoHandle = null;
      this.hideBanner(tab);
    }, UNDO_BANNER_TIMEOUT_MS);
  }

  /** `createUndoBanner(tab)` (`dynamicTiles.js:150-173`). */
  private createBanner(tab: TabId, container: Element): Element | undefined {
    const document = container.ownerDocument;
    if (!document) return undefined;

    const banner = document.createElement('div');
    banner.classList.add(UNDO_BANNER_CLASS);

    const message = document.createElement('span');
    message.textContent = this.translate('TILE_REPOSITIONED');
    message.setAttribute('data-lang-tile-repositioned', '');

    const button = document.createElement('button');
    button.textContent = this.translate('UNDO');
    button.setAttribute('data-lang-undo', '');
    button.addEventListener('click', (event: Event) => {
      event.preventDefault();
      const instance = this.instances.get(tab);
      if (instance && instance.undoHandle !== null) {
        this.clock.clearTimeout(instance.undoHandle);
        instance.undoHandle = null;
      }
      this.undo(tab);
    });

    banner.appendChild(message);
    banner.appendChild(button);
    container.appendChild(banner);
    return banner;
  }

  /** `hideUndoBanner(tab)` (`dynamicTiles.js:194-210`). */
  private hideBanner(tab: TabId): void {
    const instance = this.instances.get(tab);
    if (!instance) return;
    const banner = this.banner(tab);
    if (banner) {
      banner.classList.remove(UNDO_BANNER_SHOW_CLASS);
      if (instance.bannerHandle !== null) this.clock.clearTimeout(instance.bannerHandle);
      instance.bannerHandle = this.clock.setTimeout(() => {
        instance.bannerHandle = null;
        banner.remove();
      }, UNDO_BANNER_REMOVE_MS);
    }
    if (instance.undoHandle !== null) {
      this.clock.clearTimeout(instance.undoHandle);
      instance.undoHandle = null;
    }
  }

  private readLayout(bucket: LayoutBucket, deviceTileId: DeviceTileId): LayoutSnapshot | undefined {
    const value = this.store.getData<LayoutSnapshot>(['app', bucket, deviceTileId]);
    return Array.isArray(value) ? value : undefined;
  }

  private containerWidth(container: Element): number {
    const width = (container as HTMLElement).clientWidth;
    return typeof width === 'number' && width > 0 ? width : container.getBoundingClientRect().width;
  }

  private rowHeightOf(tile: Element): number {
    const height = tile.getBoundingClientRect().height;
    return height > 0 ? height : this.fallbackRowHeight;
  }
}

/** R19-R26 in one call: `manage.ts` builds one engine for the whole view layer. */
export function createLayoutEngine(options: LayoutEngineOptions): LayoutEngineHandle {
  return new PackeryLayoutEngine(options);
}
