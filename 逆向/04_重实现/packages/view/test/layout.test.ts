/**
 * Tests for the Packery-equivalent layout engine (`dynamicTiles.js`).
 *
 * The tiles are built from the **shipped fragments** (`01_解包/app/view/<component>/<component>.html`)
 * inside a `#status-components-<tab>` container, so the identity classes Packery persists
 * (`position-status`, `agc-status`, …) are the real ones and not invented fixtures.
 *
 * Every test name carries the acceptance criterion it proves (R19–R26 of
 * `03_分析/01_Manage主界面与视图层.md §8`). Two of them note a source/document conflict:
 * `resetButtonVisible()` (see the R-reset test) and the capture-in-DOM-order detail of `R24`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TILE_CLASS, statusComponentsId, statusConfigId, mainPanelId, tileDomId } from '../src/ids.ts';
import {
  ITEM_SELECTOR,
  PACKERY_OPTIONS,
  POSITION_THRESHOLD,
  createLayoutEngine,
  identityClassOf,
  sortLayoutItems,
  tileElements,
} from '../src/layout.ts';
import type { LayoutEngineHandle } from '../src/layout.ts';
import { createDocument } from '../src/minidom.ts';
import type { MiniDocument, MiniElement } from '../src/minidom.ts';
import type { LayoutSnapshot } from '../src/types.ts';
import type { UserStore } from '../src/userStore.ts';
import { htmlFragment, newClock, newStore } from './helpers.ts';
import type { FakeClock } from '../src/clock.ts';

/* ------------------------------------------------------------------ fixture */

const TAB = 'tabs-3';
const OTHER_TAB = 'tabs-4';
const DEVICE = '1712345678901';

/** `#status-components-<tab>` is 1184 px wide in the console (1440 px window, side bars). */
const WIDTH = 1184;
/** floor((1184 - 2*2) / 3) — R19. */
const COLUMN_WIDTH = 393;
const COLUMN_STEP = COLUMN_WIDTH + 2;
/** `.tile{min-height:350px}`; these tiles measure 352 px tall. */
const ROW_HEIGHT = 352;
const ROW_STEP = ROW_HEIGHT + 2;

const COMPONENTS = ['positionStatus', 'agcStatus', 'deviceInfo', 'radioStatus'];
const IDENTITIES = ['position-status', 'agc-status', 'device-status', 'radio-status'];

/** The four tiles at their default grid slots, in **DOM order** (which is also sorted here). */
const GRID_LAYOUT: LayoutSnapshot = [
  { id: 'position-status', position: { left: 0, top: 0 } },
  { id: 'agc-status', position: { left: COLUMN_STEP, top: 0 } },
  { id: 'device-status', position: { left: 2 * COLUMN_STEP, top: 0 } },
  { id: 'radio-status', position: { left: 0, top: ROW_STEP } },
];

interface Fixture {
  doc: MiniDocument;
  tab: string;
  device: string;
  tabRoot: MiniElement;
  container: MiniElement;
  tiles: MiniElement[];
  clock: FakeClock;
  store: UserStore;
  engine: LayoutEngineHandle;
}

/** Reading order of the 3-column grid. */
function placeAtGridSlot(index: number, tile: MiniElement): void {
  const column = index % 3;
  const row = Math.floor(index / 3);
  tile.style.left = `${column * COLUMN_STEP}px`;
  tile.style.top = `${row * ROW_STEP}px`;
}

function buildFixture(
  options: {
    tab?: string;
    device?: string;
    components?: string[];
    place?: (index: number, tile: MiniElement) => void;
    width?: number;
    /** Share one store between two tabs to prove the layout is keyed by device tile id. */
    store?: UserStore;
  } = {},
): Fixture {
  const tab = options.tab ?? TAB;
  const device = options.device ?? DEVICE;
  const components = options.components ?? COMPONENTS;
  const doc = createDocument();

  const tabRoot = doc.createElement('div');
  tabRoot.id = tab;
  tabRoot.className = 'tab-view';

  const mainPanel = doc.createElement('div');
  mainPanel.id = mainPanelId(tab);

  const statusConfig = doc.createElement('div');
  statusConfig.id = statusConfigId(tab);
  statusConfig.className = 'row status-config';
  statusConfig.innerHTML =
    '<div class="reset-default-layout col-xs-6" id="resetDefault">' +
    '<a data-lang-reset-default-layout id="status-default">Reset layout to default</a></div>';

  const container = doc.createElement('div');
  container.id = statusComponentsId(tab);
  container.className = 'status-components manage-status-components';
  container.__rect = { width: options.width ?? WIDTH };

  mainPanel.append(statusConfig, container);
  tabRoot.appendChild(mainPanel);
  doc.body.appendChild(tabRoot);

  const tiles = components.map((component, index) => {
    const tile = doc.createElement('div');
    tile.className = TILE_CLASS;
    tile.id = tileDomId(index, tab);
    tile.innerHTML = htmlFragment(component);
    tile.__rect = { height: ROW_HEIGHT };
    (options.place ?? placeAtGridSlot)(index, tile);
    container.appendChild(tile);
    return tile;
  });

  const clock = newClock();
  const store = options.store ?? newStore();
  const engine = createLayoutEngine({ clock, store });
  return { doc, tab, device, tabRoot, container, tiles, clock, store, engine };
}

/** `initialisePackery(tab)` — the tabids guard makes this the only way in. */
function open(fixture: Fixture, device = fixture.device): void {
  fixture.engine.initialise(fixture.tab, device, fixture.container);
}

function resetControl(fixture: Fixture): MiniElement {
  const button = fixture.tabRoot.querySelector('#resetDefault');
  assert.ok(button, 'fixture must ship #resetDefault');
  return button;
}

function idsOf(layout: LayoutSnapshot): string[] {
  return layout.map((item) => item.id);
}

function positionsById(layout: LayoutSnapshot): Map<string, { left: number; top: number }> {
  return new Map(layout.map((item) => [item.id, item.position]));
}

/* ---------------------------------------------------------------------- R19 */

test('R19 metricsFor: 3 columns, floor((width-4)/3) px columns, 2 px gutter', () => {
  const { engine } = buildFixture();

  assert.deepEqual(engine.metricsFor(WIDTH), { columns: 3, columnWidth: COLUMN_WIDTH, gutter: 2 });
  assert.deepEqual(engine.metricsFor(1000), { columns: 3, columnWidth: 332, gutter: 2 });
  // The formula is copied verbatim, so a container narrower than the gutters yields a negative
  // column width instead of a guarded 0 (`dynamicTiles.js:312-313`).
  assert.deepEqual(engine.metricsFor(2), { columns: 3, columnWidth: -1, gutter: 2 });

  assert.equal(ITEM_SELECTOR, '.manage-tile');
  assert.deepEqual(PACKERY_OPTIONS, {
    itemSelector: '.manage-tile',
    transitionDuration: 0,
    resize: false,
    initLayout: true,
    stagger: 0,
    isOriginLeft: true,
    isOriginTop: true,
    percentPosition: false,
  });
  assert.deepEqual(engine.packeryOptionsFor(WIDTH), {
    ...PACKERY_OPTIONS,
    columnWidth: COLUMN_WIDTH,
    gutter: 2,
  });
});

/* ---------------------------------------------------------------------- R20 */

test('R20 a tile is always one column wide: {id, position:{left,top}} and nothing else', () => {
  const f = buildFixture();
  open(f);
  f.engine.moveTo(f.tab, 'position-status', 2, 1);

  const snapshot = f.engine.snapshot(f.tab);
  assert.equal(snapshot.length, 4);
  for (const item of snapshot) {
    assert.deepEqual(Object.keys(item), ['id', 'position'], 'exactly id + position (R20: no span)');
    assert.deepEqual(Object.keys(item.position), ['left', 'top']);
    for (const forbidden of ['width', 'height', 'span', 'columns', 'rows', 'order', 'x', 'y']) {
      assert.ok(!(forbidden in item), `${forbidden} must never be persisted`);
    }
  }

  // Round-tripping the persisted bytes must be lossless — the file only ever holds this shape.
  const text = JSON.stringify(snapshot);
  assert.equal(JSON.stringify(JSON.parse(text)), text);
  assert.equal(JSON.stringify(f.store.json.app.dynamic[f.device]), text, 'the stored blob is byte-identical');
});

/* ---------------------------------------------------------------------- R21 */

test('R21 the drag handle is .status-header.drag-area; moveTo lands on the grid slot; traffic is inert', () => {
  const f = buildFixture();

  // The shipped fragment itself carries both the class and the hover hook.
  const shipped = f.tiles[0].querySelector('.status-header');
  assert.ok(shipped);
  assert.ok(shipped.classList.contains('drag-area'), 'the shipped header is a drag-area (dynamicTiles.js:926)');

  open(f);
  const handle = f.tiles[0].querySelector('.status-header')!;
  const traffic = f.tiles[0].querySelector('.statustiles-traffic')!;
  assert.ok(traffic);

  f.engine.beginDrag(f.tab, 'position-status');
  assert.equal(handle.style.cursor, 'url(../images/ic_cursor_drag_24.svg)');
  assert.equal(f.tiles[0].style.zIndex, '1004');
  assert.equal(traffic.style.pointerEvents, 'none', 'dragStart disables the traffic dots');

  f.engine.moveTo(f.tab, 'position-status', 2, 1);
  assert.equal(traffic.style.pointerEvents, 'none', 'still inert mid-drag');
  assert.equal(f.tiles[0].style.left, `${2 * COLUMN_STEP}px`);
  assert.equal(f.tiles[0].style.top, `${ROW_STEP}px`);

  f.engine.endDrag(f.tab);
  assert.equal(traffic.style.pointerEvents, '', 'dragEnd restores pointer events');
  assert.equal(f.tiles[0].style.zIndex, '', 'dragEnd clears the raised z-index');
});

test('R21 initialise normalises the handle: a stripped .status-header regains drag-area', () => {
  const f = buildFixture();
  const handle = f.tiles[1].querySelector('.status-header')!;
  handle.classList.remove('drag-area');

  open(f);

  assert.equal(handle.classList.contains('drag-area'), true);
  assert.equal(handle.style.cursor, 'url(../images/ic_cursor_drag_24.svg)');
});

/* ---------------------------------------------------------------------- R22 */

test('R22 a drag saves under the device tile id, and two tabs of that device share the layout', () => {
  const first = buildFixture();
  // SM ↔ GRIT: a second tab of the same receiver, reading the same store.
  const second = buildFixture({ tab: OTHER_TAB, store: first.store });
  open(first);
  open(second);

  first.engine.moveTo(first.tab, 'position-status', 2, 1);
  const moved = first.engine.snapshot(first.tab);
  assert.notDeepEqual(moved, GRID_LAYOUT);

  assert.deepEqual(first.store.json.app.dynamic[DEVICE], moved, 'keyed by the device tile id');
  assert.equal(first.store.json.app.dynamic[first.tab], undefined, 'never keyed by the tab id');
  assert.equal(first.store.json.app.dynamic[second.tab], undefined);
  assert.deepEqual(first.store.json.app.defaultLayout[DEVICE], GRID_LAYOUT, 'the default is untouched');

  second.engine.restore(second.tab);
  assert.deepEqual(second.engine.snapshot(second.tab), moved, 'the second tab inherits the same slots');
  assert.equal(second.engine.deviceTileId(second.tab), DEVICE);
});

/* ---------------------------------------------------------------------- R23 */

test('R23 a changed layout shows the undo banner for 10 s; undo() restores and saves the previous snapshot', () => {
  const f = buildFixture();
  open(f);
  const before = f.engine.snapshot(f.tab);

  f.engine.moveTo(f.tab, 'position-status', 2, 1);
  const moved = f.engine.snapshot(f.tab);

  assert.notDeepEqual(moved, before);
  assert.equal(f.engine.undoBannerVisible(f.tab), true);
  assert.deepEqual(f.store.json.app.dynamic[DEVICE], moved, 'R22: the drag end saved');
  assert.deepEqual(
    f.clock.pending().map((timer) => timer.delay),
    [10000],
    'the banner hides itself after 10 s (dynamicTiles.js:189)',
  );

  const banner = f.engine.banner(f.tab)!;
  assert.ok(banner.querySelector('[data-lang-tile-repositioned]'), 'banner text is a language marker');
  assert.ok(banner.querySelector('[data-lang-undo]'), 'banner button is a language marker');

  f.engine.undo(f.tab);
  assert.deepEqual(f.engine.snapshot(f.tab), before, 'undo restores the dragStart snapshot');
  assert.deepEqual(f.store.json.app.dynamic[DEVICE], before, 'and writes the restored layout again');
  assert.equal(f.engine.undoBannerVisible(f.tab), false);
  assert.deepEqual(f.clock.pending().map((timer) => timer.delay), [300], 'the banner node is dropped 300 ms later');

  // Auto-hide: the same gesture, but nobody clicks Undo.
  f.engine.moveTo(f.tab, 'agc-status', 1, 1);
  assert.equal(f.engine.undoBannerVisible(f.tab), true);
  f.clock.advance(10000);
  assert.equal(f.engine.undoBannerVisible(f.tab), false, 'gone after 10 s');
  f.clock.advance(300);
  assert.equal(f.engine.banner(f.tab), undefined, 'and removed from the DOM');

  // The banner's own button calls undo(). (The second gesture above was never undone, so the
  // reference is whatever the layout looks like right now, not the original `before`.)
  const preClick = f.engine.snapshot(f.tab);
  f.engine.moveTo(f.tab, 'device-status', 0, 1);
  const afterSecondMove = f.engine.snapshot(f.tab);
  const undoButton = f.engine.banner(f.tab)!.querySelector('button')!;
  undoButton.click();
  assert.notDeepEqual(f.engine.snapshot(f.tab), afterSecondMove);
  assert.deepEqual(f.engine.snapshot(f.tab), preClick);
  assert.deepEqual(f.store.json.app.dynamic[DEVICE], preClick, 'the click path saves too');
});

/* ---------------------------------------------------------------------- R24 */

test('R24 (missing entry) captures defaultLayout from the DOM, in DOM order not sorted order', () => {
  const f = buildFixture({
    // DOM order deliberately differs from the sorted order: tile 0 sits in the second row.
    place: (index, tile) => {
      const slots: Array<[number, number]> = [
        [0, 1],
        [1, 0],
        [2, 0],
        [0, 0],
      ];
      const [column, row] = slots[index];
      tile.style.left = `${column * COLUMN_STEP}px`;
      tile.style.top = `${row * ROW_STEP}px`;
    },
  });
  open(f);

  const captured: LayoutSnapshot = [
    { id: 'position-status', position: { left: 0, top: ROW_STEP } },
    { id: 'agc-status', position: { left: COLUMN_STEP, top: 0 } },
    { id: 'device-status', position: { left: 2 * COLUMN_STEP, top: 0 } },
    { id: 'radio-status', position: { left: 0, top: 0 } },
  ];
  assert.deepEqual(f.store.json.app.defaultLayout[DEVICE], captured, 'captured in DOM order (dynamicTiles.js:355-376)');
  assert.deepEqual(f.store.json.app.dynamic[DEVICE], captured, 'dynamic is seeded too when absent');
  assert.deepEqual(idsOf(f.engine.snapshot(f.tab)), ['radio-status', 'agc-status', 'device-status', 'position-status'], 'snapshots are sorted');
  assert.deepEqual(f.store.json.app.defaultLayout[f.tab], undefined);
});

test('R24 (no position data) recaptures when the stored items carry no position', () => {
  const f = buildFixture();
  const withoutPositions = IDENTITIES.map((id) => ({ id })) as unknown as LayoutSnapshot;
  f.store.set(['app', 'defaultLayout', DEVICE], withoutPositions);
  f.store.set(['app', 'dynamic', DEVICE], withoutPositions);

  open(f);

  assert.deepEqual(f.store.json.app.defaultLayout[DEVICE], GRID_LAYOUT);
});

test('R24 (count mismatch) recaptures when the stored item count is not the tile count', () => {
  const f = buildFixture();
  const two = GRID_LAYOUT.slice(0, 2);
  f.store.set(['app', 'defaultLayout', DEVICE], two);
  f.store.set(['app', 'dynamic', DEVICE], two);

  open(f);

  assert.equal(f.store.json.app.defaultLayout[DEVICE].length, 4);
  assert.deepEqual(f.store.json.app.defaultLayout[DEVICE], GRID_LAYOUT);
});

test('R24 (id set mismatch) recaptures when defaultLayout ids differ from dynamic ids', () => {
  const f = buildFixture();
  const stale: LayoutSnapshot = [
    { id: 'alpha-status', position: { left: 0, top: 0 } },
    { id: 'beta-status', position: { left: COLUMN_STEP, top: 0 } },
    { id: 'gamma-status', position: { left: 2 * COLUMN_STEP, top: 0 } },
    { id: 'delta-status', position: { left: 0, top: ROW_STEP } },
  ];
  f.store.set(['app', 'defaultLayout', DEVICE], stale);
  f.store.set(['app', 'dynamic', DEVICE], GRID_LAYOUT);

  open(f);

  assert.deepEqual(idsOf(f.store.json.app.defaultLayout[DEVICE]).sort(), [...IDENTITIES].sort());
});

test('R24 (every tile in one column) recaptures even when the ids and the count are right', () => {
  const f = buildFixture();
  const flat: LayoutSnapshot = IDENTITIES.map((id, index) => ({ id, position: { left: 0, top: index * ROW_STEP } }));
  f.store.set(['app', 'defaultLayout', DEVICE], flat);
  f.store.set(['app', 'dynamic', DEVICE], flat);

  open(f);

  const captured = f.store.json.app.defaultLayout[DEVICE];
  assert.deepEqual(captured, GRID_LAYOUT);
  assert.ok(captured.some((item) => item.position.left > 0), 'a real default has several columns');
});

test('R24 (valid default) keeps the stored defaultLayout untouched', () => {
  const f = buildFixture();
  f.store.set(['app', 'defaultLayout', DEVICE], GRID_LAYOUT);
  f.store.set(['app', 'dynamic', DEVICE], GRID_LAYOUT);

  open(f);

  assert.deepEqual(f.store.json.app.defaultLayout[DEVICE], GRID_LAYOUT);
  assert.deepEqual(f.engine.snapshot(f.tab), GRID_LAYOUT);
});

/* ---------------------------------------------------------------------- R25 */

test('R25 order is top (20 px counts as the same row) then left, rounded to whole pixels', () => {
  const high = { id: 'a-status', position: { left: 600, top: 0 } };
  const sameRow19 = { id: 'b-status', position: { left: 0, top: 19 } };
  const sameRow20 = { id: 'b-status', position: { left: 0, top: 20 } };
  const nextRow21 = { id: 'b-status', position: { left: 0, top: 21 } };

  assert.deepEqual(idsOf(sortLayoutItems([high, sameRow19])), ['b-status', 'a-status'], '19 px → same row → by left');
  assert.deepEqual(idsOf(sortLayoutItems([high, sameRow20])), ['b-status', 'a-status'], '20 px → same row (<= threshold)');
  assert.deepEqual(idsOf(sortLayoutItems([high, nextRow21])), ['a-status', 'b-status'], '21 px → other row → by top');

  const f = buildFixture({
    // One row, fractional lefts: the snapshot has to round and to order by left.
    place: (index, tile) => {
      tile.style.left = index === 0 ? '12.4px' : index === 1 ? '12.6px' : `${index * COLUMN_STEP}px`;
      tile.style.top = '0px';
    },
  });
  open(f);

  const positions = positionsById(f.engine.snapshot(f.tab));
  assert.deepEqual(positions.get('position-status'), { left: 12, top: 0 }, '12.4 → 12');
  assert.deepEqual(positions.get('agc-status'), { left: 13, top: 0 }, '12.6 → 13');
  for (const position of positions.values()) {
    assert.ok(Number.isInteger(position.left) && Number.isInteger(position.top));
  }
  assert.deepEqual(idsOf(f.engine.snapshot(f.tab)), IDENTITIES, 'same row → ordered by left');
});

/* ---------------------------------------------------------------------- R26 */

test('R26 destroy saves first, then tears the instance down', () => {
  const f = buildFixture();
  open(f);
  f.engine.moveTo(f.tab, 'position-status', 2, 1);
  const live = f.engine.snapshot(f.tab);

  // A deliberately stale value proves *destroy* saves: it is overwritten on the way out.
  f.store.set(['app', 'dynamic', DEVICE], [{ id: 'stale-status', position: { left: 1, top: 1 } }]);
  f.engine.destroy(f.tab);

  assert.deepEqual(f.store.json.app.dynamic[DEVICE], live, 'saveLayout ran before the teardown');
  assert.equal(f.engine.isActive(f.tab), false);
  assert.equal(f.engine.container(f.tab), undefined);
  assert.equal(f.engine.deviceTileId(f.tab), undefined);
  assert.deepEqual(f.engine.snapshot(f.tab), []);
});

/* ------------------------------------------------- reset button + isDifferent */

test('R23/§6.5 resetButtonVisible: shown exactly when the layout differs from defaultLayout', () => {
  // Source trace: `updateResetButtonVisibility` (`dynamicTiles.js:878-881`) sets
  // `display:block` when `isLayoutDifferent()` is **false**, and `isLayoutDifferent()`
  // (`:645-763`) returns false as soon as one tile sits more than 60 px away from its default
  // slot — the name is inverted, the polarity is not, so the source is already "visible once the
  // user moved something". §6.5 `[观察]` reads the same call the other way round and asks for
  // "visible when different". This reimplementation takes the document's wording, keeps that
  // observable behaviour and exposes the honest name: isDifferent() = moved away from default.
  const f = buildFixture();
  open(f);

  assert.equal(f.engine.isDifferent(f.tab), false);
  assert.equal(f.engine.resetButtonVisible(f.tab), false);
  assert.equal(resetControl(f).style.display, 'none', 'a default layout has nothing to reset to');

  f.engine.moveTo(f.tab, 'position-status', 2, 1);
  assert.equal(f.engine.isDifferent(f.tab), true);
  assert.equal(f.engine.resetButtonVisible(f.tab), true);
  assert.equal(resetControl(f).style.display, 'block');

  f.engine.reset(f.tab);
  assert.deepEqual(f.engine.snapshot(f.tab), GRID_LAYOUT);
  assert.deepEqual(f.store.json.app.dynamic[DEVICE], GRID_LAYOUT, 'reset writes [...defaultLayout]');
  assert.equal(f.engine.resetButtonVisible(f.tab), false);
  assert.equal(resetControl(f).style.display, 'none');
  assert.equal(f.engine.undoBannerVisible(f.tab), false, 'reset hides the banner');

  // The 60 px drift threshold of `dynamicTiles.js:652`.
  const shifted = (drift: number): LayoutSnapshot =>
    GRID_LAYOUT.map((item) =>
      item.id === 'position-status'
        ? { id: item.id, position: { left: item.position.left + drift, top: item.position.top } }
        : item,
    );
  f.store.set(['app', 'dynamic', DEVICE], shifted(POSITION_THRESHOLD));
  assert.equal(f.engine.isDifferent(f.tab), false, '60 px is still "the same"');
  f.store.set(['app', 'dynamic', DEVICE], shifted(POSITION_THRESHOLD + 1));
  assert.equal(f.engine.isDifferent(f.tab), true, '61 px is not');

  f.store.set(['app', 'dynamic', DEVICE], GRID_LAYOUT.slice(0, 2));
  assert.equal(f.engine.isDifferent(f.tab), true, 'a different item count is different');

  f.store.set(['app', 'defaultLayout', DEVICE], undefined);
  assert.equal(f.engine.isDifferent(f.tab), false, 'without a default there is nothing to reset to');
});

/* ------------------------------------------------------------- restore/reflow */

test('restore prefers the stored dynamic layout and falls back to defaultLayout', () => {
  const f = buildFixture();
  const moved: LayoutSnapshot = GRID_LAYOUT.map((item) =>
    item.id === 'radio-status' ? { id: item.id, position: { left: COLUMN_STEP, top: ROW_STEP } } : item,
  );
  f.store.set(['app', 'defaultLayout', DEVICE], GRID_LAYOUT);
  f.store.set(['app', 'dynamic', DEVICE], moved);

  open(f);

  assert.deepEqual(f.engine.snapshot(f.tab), sortLayoutItems(moved));
  assert.deepEqual(f.store.json.app.defaultLayout[DEVICE], GRID_LAYOUT, 'R24: a valid default is kept');

  const g = buildFixture();
  g.store.set(['app', 'defaultLayout', DEVICE], GRID_LAYOUT);
  open(g);
  assert.deepEqual(g.engine.snapshot(g.tab), GRID_LAYOUT, 'no dynamic entry → the default is laid out');
});

test('reflow re-applies the current layout in order and changes nothing', () => {
  const f = buildFixture();
  open(f);
  f.engine.moveTo(f.tab, 'position-status', 2, 1);
  const before = f.engine.snapshot(f.tab);

  f.engine.reflow(f.tab);

  assert.deepEqual(f.engine.snapshot(f.tab), before);
  assert.deepEqual(idsOf(before), ['agc-status', 'device-status', 'radio-status', 'position-status']);
  assert.deepEqual(
    Array.from(tileElements(f.container)).map((tile) => tile.id),
    ['tile-1-tabs-3', 'tile-2-tabs-3', 'tile-3-tabs-3', 'tile-0-tabs-3'],
    'the DOM follows the layout order',
  );
});

test('onLayoutChange fires once per real change, not for a drag that moved nothing', () => {
  const f = buildFixture();
  const seen: string[] = [];
  f.engine.onLayoutChange = (tab) => seen.push(tab);
  open(f);

  f.engine.beginDrag(f.tab, 'position-status');
  f.engine.endDrag(f.tab);
  assert.deepEqual(seen, [], 'a drag that ends where it started is not a change');
  assert.equal(f.engine.undoBannerVisible(f.tab), false);

  f.engine.moveTo(f.tab, 'position-status', 2, 1);
  assert.deepEqual(seen, [f.tab]);

  f.engine.undo(f.tab);
  assert.deepEqual(seen, [f.tab, f.tab]);
});

/* --------------------------------------------------------------- no-op guards */

test('initialise is a no-op without a device tile id (the tabids guard)', () => {
  const f = buildFixture();

  f.engine.initialise(f.tab, '', f.container);

  assert.equal(f.engine.isActive(f.tab), false);
  assert.equal(f.engine.container(f.tab), undefined);
  assert.equal(f.store.json.app.defaultLayout[DEVICE], undefined);
  assert.equal(f.store.json.app.dynamic[DEVICE], undefined);
});

test('a Longhorn tab builds no instance and hides the reset control', () => {
  const f = buildFixture();
  const engine = createLayoutEngine({ clock: f.clock, store: f.store, isLongHorn: (tab) => tab === f.tab });

  engine.initialise(f.tab, DEVICE, f.container);

  assert.equal(engine.isActive(f.tab), false);
  const layoutRow = f.tabRoot.querySelector('.reset-default-layout');
  assert.ok(layoutRow);
  assert.equal(layoutRow.style.display, 'none');
});

test('R21/R25 grid slot maths uses the tile height, falling back to .tile{min-height:350px}', () => {
  const f = buildFixture();
  f.tiles[0].__rect = { height: 400 };
  f.tiles[1].__rect = null; // nothing measurable: no style height, no __rect
  open(f);

  f.engine.moveTo(f.tab, 'position-status', 0, 1);
  assert.equal(f.tiles[0].style.left, '0px');
  assert.equal(f.tiles[0].style.top, `${400 + 2}px`, 'row height 400 + gutter');

  f.engine.moveTo(f.tab, 'agc-status', 2, 1);
  assert.equal(f.tiles[1].style.top, `${350 + 2}px`, 'fallback row height 350');
  assert.equal(f.tiles[1].style.left, `${2 * COLUMN_STEP}px`);
});

test('a tile whose first div has no *-status class never enters a snapshot (R18 event in R20)', () => {
  const f = buildFixture();
  const stray = f.doc.createElement('div');
  stray.className = TILE_CLASS;
  stray.innerHTML = '<div class="plain-block">not a status tile</div>';
  stray.style.left = '500px';
  stray.style.top = '900px';
  f.container.appendChild(stray);

  open(f);

  assert.equal(identityClassOf(stray), undefined);
  assert.deepEqual(idsOf(f.engine.snapshot(f.tab)), IDENTITIES);
  // The stray tile is left where it is; it is not in any persisted layout either.
  assert.equal(f.store.json.app.defaultLayout[DEVICE].length, 4);
  assert.equal(stray.style.top, '900px');
});
