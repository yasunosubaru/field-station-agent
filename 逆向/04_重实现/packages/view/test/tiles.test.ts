/**
 * Tile system tests — `03_分析/01_Manage主界面与视图层.md §3.2` (the plan), §3.3 (the identity class)
 * and R17/R18.
 *
 * The fragments are the **real** unpacked ones (`test/helpers.ts#realFragmentLoader`), so
 * "`identityClassOf(wrapper)` returns `position-status`" is checked against
 * `01_解包/app/view/positionStatus/positionStatus.html`, not against a fixture.
 *
 * **Where the source contradicts the analysis document, the source wins** (the task's rule), and
 * each divergence is called out where it is asserted:
 *
 *  1. §3.2's row "standard OEM (incl. MarinePak)" is verbatim the *MarinePak* branch order
 *     (`:1570-1684`) — absence of `deviceInfo`, `pppCorrections` before `satelliteView`. The plain
 *     OEM branch (`:1686-1831`) adds `deviceInfo` and puts `interferenceStatus`/`logStatus` before
 *     `satelliteView`, with `pppCorrections` after it. Both are implemented; `isMarinePak` chooses.
 *  2. §3.2's GIII row (`positionStatus → agcStatus`) is the branch at `:1857-1933`, which is
 *     **unreachable**: it sits inside `if (connectionReady[tab] && !getIsLongHorn && !getIsGIII)`
 *     (`:1452`, `:1495`). The live flow is `:2100-2176` and is implemented instead.
 *  3. §3.3 has no row for `satelliteTracking` although its first div is `satelliteTracking-status`,
 *     which *does* satisfy `dynamicTiles.js:502-505` — so it is a layout identity after all.
 *  4. §3.3 records the statusBar tile's first class as `row status-bar`, which is not an identity
 *     class; `identityClassOf` therefore returns `undefined` for it, as the original does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTileSystem,
  fragmentPathFor,
  identityClassToken,
  planTiles,
  tileTargetId,
} from '../src/tiles.ts';
import { statusComponentsId, statusComponentsPage2Id, statusPanelId } from '../src/ids.ts';
import { createDocument } from '../src/minidom.ts';
import { DEFAULT_FEATURES, type FeatureFlags, type TileSpec } from '../src/types.ts';
import { htmlFragment, realFragmentLoader } from './helpers.ts';

const MAX_STANDARD: FeatureFlags = {
  ...DEFAULT_FEATURES,
  generation: 'OEM7',
  terrastarSupported: true,
  alignSupported: true,
  spanSupported: true,
  radioTxSupported: true,
  positionModes: ['RTK_ROVER', 'PPP'],
};

const MARINE_PAK: FeatureFlags = { ...DEFAULT_FEATURES, isMarinePak: true, positionModes: ['RTK_ROVER'] };
const LONGHORN: FeatureFlags = { ...DEFAULT_FEATURES, isLongHorn: true };
const GIII: FeatureFlags = { ...DEFAULT_FEATURES, isGIII: true };

const MODELS: Array<[string, FeatureFlags]> = [
  ['standard', DEFAULT_FEATURES],
  ['standard (all optional tiles)', MAX_STANDARD],
  ['marinePak', MARINE_PAK],
  ['longhorn', LONGHORN],
  ['giii', GIII],
];

/** The identity classes §3.3 tabulates, keyed by component name. */
const IDENTITY: Record<string, string> = {
  positionStatus: 'position-status',
  deviceInfo: 'device-status',
  spanStatus: 'span-status',
  alignStatus: 'align-status',
  portStatus: 'port-status',
  logStatus: 'log-status',
  radioStatus: 'radio-status',
  interferenceStatus: 'interference-status',
  pppCorrections: 'pppCorrection-status',
  agcStatus: 'agc-status',
  '2d-sd': '2d-sd-status',
  'height-sd': 'height-sd-status',
  satelliteView: 'satellite-view',
};

function names(features: FeatureFlags): string[] {
  return planTiles(features).map((spec) => spec.name);
}

/** A tab panel with just the three tile containers `mount` resolves. */
function tileHost(tab: string): { doc: ReturnType<typeof createDocument>; host: any } {
  const doc = createDocument();
  const host = doc.createElement('div');
  host.id = tab;
  doc.body.appendChild(host);
  for (const id of [statusPanelId(tab), statusComponentsId(tab), statusComponentsPage2Id(tab)]) {
    const container = doc.createElement('div');
    container.id = id;
    host.appendChild(container);
  }
  return { doc, host };
}

test('§3.2 standard: creation order, page 1 + the page-2 tracking plot', () => {
  // `:1500` creates the page-2 tile at index 1, *before* page 1 (`:1559`), so this order is also
  // the order of the `tile-<index>-<tab>` ids. §3.2's row omits `deviceInfo`; the source has it
  // (`:1687`), and `satelliteView` precedes `pppCorrections` only in the plain-OEM branch.
  assert.deepEqual(names(DEFAULT_FEATURES), [
    'statusBar',
    'satelliteTracking',
    'positionStatus',
    'deviceInfo',
    'interferenceStatus', // :1694 — rxGen is OEM7
    'satelliteView', // :1714
    'logStatus', // :1781
    'portStatus', // :1792
  ]);
  assert.deepEqual(planTiles(DEFAULT_FEATURES).map((spec) => spec.page), ['', 'page2', '', '', '', '', '', '']);
});

test('§3.2 standard: every conditional tile appears once its flag is set', () => {
  assert.deepEqual(names(MAX_STANDARD), [
    'statusBar',
    'satelliteTracking',
    'positionStatus',
    'deviceInfo',
    'interferenceStatus',
    'satelliteView',
    'pppCorrections', // isTerrastarSupported && no NONE position mode
    'alignStatus',
    'spanStatus',
    'logStatus',
    'portStatus',
    'radioStatus', // :1806 — polled until getIsRadioTxSupported answers
  ]);
});

test('§3.2 standard: OEM6/OEMSTAR swap interferenceStatus for logStatus in one slot', () => {
  const oem6 = planTiles({ ...DEFAULT_FEATURES, generation: 'OEM6' }).map((spec) => spec.name);
  assert.deepEqual(oem6, ['statusBar', 'satelliteTracking', 'positionStatus', 'deviceInfo', 'logStatus', 'satelliteView', 'portStatus']);
  assert.equal(oem6.filter((name) => name === 'logStatus').length, 1, ':1703 else-if, not a second log tile');
  const oemstar = planTiles({ ...DEFAULT_FEATURES, generation: 'OEMSTAR' }).map((spec) => spec.name);
  assert.deepEqual(oemstar, oem6);
  // The OEM6/OEMSTAR guard covers interferenceStatus and logStatus only: `pppCorrections` needs
  // the terrastar flag and a position mode other than NONE, generation or not (:1721-1730).
  assert.equal(
    names({ ...DEFAULT_FEATURES, generation: 'OEM6', terrastarSupported: true }).includes('pppCorrections'),
    true,
  );
  assert.equal(
    names({ ...DEFAULT_FEATURES, generation: 'OEM6', terrastarSupported: true, positionModes: ['NONE'] }).includes('pppCorrections'),
    false,
  );
});

test('§3.2 marinePak: the order the document tabulates, without deviceInfo', () => {
  // This is §3.2's "standard OEM (incl. MarinePak)" row as documented — positionStatus,
  // [pppCorrections], satelliteView, [alignStatus], [spanStatus], [interferenceStatus], logStatus,
  // portStatus, [radioStatus] — because that row was read off `:1570-1684`, the MarinePak branch.
  assert.deepEqual(names(MARINE_PAK), [
    'statusBar',
    'satelliteTracking',
    'positionStatus',
    'pppCorrections',
    'satelliteView',
    'interferenceStatus',
    'logStatus',
    'portStatus',
  ]);
  assert.equal(names(MARINE_PAK).includes('deviceInfo'), false, 'the MarinePak branch never builds one');
  assert.deepEqual(
    names({ ...MARINE_PAK, alignSupported: true, spanSupported: true, radioTxSupported: true }),
    ['statusBar', 'satelliteTracking', 'positionStatus', 'pppCorrections', 'satelliteView', 'alignStatus', 'spanStatus', 'interferenceStatus', 'logStatus', 'portStatus', 'radioStatus'],
  );
  // a MarinePak receiver whose position modes include NONE gets no pppCorrections tile (:1572)
  assert.equal(names({ ...MARINE_PAK, positionModes: ['NONE'] }).includes('pppCorrections'), false);
  assert.equal(names({ ...MARINE_PAK, generation: 'OEM6' }).includes('interferenceStatus'), false);
});

test('§3.2 longhorn: the five page-1 tiles and no page 2', () => {
  assert.deepEqual(names(LONGHORN), ['statusBar', 'positionStatus', '2d-sd', 'height-sd', 'deviceInfo', 'satelliteView']);
  assert.equal(planTiles(LONGHORN).some((spec) => spec.page === 'page2'), false);
});

test('§3.2 giii: the live flow (:2100-2176), not the unreachable twin', () => {
  // The document's GIII row (`positionStatus → agcStatus`) is the dead branch inside the
  // `!isLongHorn && !isGIII` guard (:1857-1933). The reachable one adds deviceInfo, satelliteView
  // and logStatus and still ends with agcStatus, so the documented order survives as a subsequence.
  assert.deepEqual(names(GIII), ['statusBar', 'positionStatus', 'deviceInfo', 'satelliteView', 'logStatus', 'agcStatus', 'satelliteTracking']);
  const documented = names(GIII).filter((name) => name === 'positionStatus' || name === 'agcStatus');
  assert.deepEqual(documented, ['positionStatus', 'agcStatus']);
  assert.equal(planTiles(GIII).at(-1)!.page, 'page2', 'the tracking plot is the page-2 tile');
});

test('§3.3: every plan uses the identity class the table names', () => {
  for (const [label, features] of MODELS) {
    for (const spec of planTiles(features)) {
      if (spec.name === 'statusBar') {
        // §3.3: the statusBar tile's first div is `row status-bar` — not a Packery identity.
        assert.equal(spec.identityClass, 'row status-bar');
        continue;
      }
      if (spec.name === 'satelliteTracking') {
        // §3.3 has no row for it; the class still satisfies dynamicTiles.js:502-505.
        assert.equal(spec.identityClass, 'satelliteTracking-status');
        continue;
      }
      assert.equal(spec.identityClass, IDENTITY[spec.name], `${label}: ${spec.name}`);
    }
    assert.equal(planTiles(features)[0].name, 'statusBar', `${label}: index 0 is always the statusBar tile`);
  }
});

test('R18: createComponent picks lghn- / giii- fragments per tile, not per model', () => {
  const spec = (name: string, page: '' | 'page2' = ''): TileSpec => ({ name, identityClass: 'x-status', page });
  assert.equal(fragmentPathFor(spec('positionStatus'), DEFAULT_FEATURES), './../positionStatus/positionStatus.html');
  assert.equal(fragmentPathFor(spec('positionStatus'), LONGHORN), './../positionStatus/lghn-positionStatus.html');
  assert.equal(fragmentPathFor(spec('2d-sd'), LONGHORN), './../2d-sd/lghn-2d-sd.html');
  assert.equal(fragmentPathFor(spec('height-sd'), LONGHORN), './../height-sd/lghn-height-sd.html');
  // createComponent is called *without* the fourth argument for these two (:2134, :2160)
  assert.equal(fragmentPathFor(spec('deviceInfo'), LONGHORN), './../deviceInfo/deviceInfo.html');
  assert.equal(fragmentPathFor(spec('satelliteView'), GIII), './../satelliteView/satelliteView.html');
  assert.equal(fragmentPathFor(spec('agcStatus'), GIII), './../agcStatus/agcStatus.html');
  assert.equal(fragmentPathFor(spec('positionStatus'), GIII), './../positionStatus/giii-positionStatus.html');
  assert.equal(fragmentPathFor(spec('logStatus'), GIII), './../logStatus/giii-logStatus.html');
  assert.equal(fragmentPathFor(spec('satelliteTracking', 'page2'), GIII), './../satelliteTracking/giii-satelliteTracking.html');
});

test('every tile of every model resolves to a real shipped fragment', () => {
  const loader = realFragmentLoader();
  for (const [label, features] of MODELS) {
    for (const spec of planTiles(features)) {
      const path = fragmentPathFor(spec, features);
      const text = loader.load(path); // throws when the fragment does not exist
      assert.ok(text.trim().length > 0, `${label}: ${path}`);
    }
  }
});

test('R18: positionStatus / portStatus / satelliteView ship the promised identity class', () => {
  const doc = createDocument();
  const holder = doc.createElement('div');
  for (const [component, expected] of [
    ['positionStatus', 'position-status'],
    ['portStatus', 'port-status'],
    // §3.3's special case: `satellite-view` does not end in `-status` (dynamicTiles.js:504).
    ['satelliteView', 'satellite-view'],
  ] as Array<[string, string]>) {
    holder.innerHTML = htmlFragment(component);
    const first = holder.firstElementChild!;
    assert.equal(first.className, expected, `${component}.html`);
    assert.equal(identityClassToken(first.getAttribute('class')), expected);
  }
});

test('R18: identityClassOf reads the *first child div* exactly as dynamicTiles does', () => {
  const doc = createDocument();
  const box = doc.createElement('div');
  // a text node first, then the row div, then something else: the rule is `find('> div').first()`
  box.innerHTML = '\n  <div class="row status-bar"></div><div class="position-status"></div>';
  assert.equal(identityClassToken(box.children[0].getAttribute('class')), undefined, 'row/status-bar is not an identity');
  box.innerHTML = '<span class="ignored-status"></span><div class="port-status"></div>';
  assert.equal(identityClassToken(box.children[1].getAttribute('class')), 'port-status');
  assert.equal(identityClassToken(null), undefined);
  assert.equal(identityClassToken(''), undefined);
});

test('R17: placement is index 0 → status-panel, page2 → page2, else page 1', () => {
  const page2: TileSpec = { name: 'satelliteTracking', identityClass: 'satelliteTracking-status', page: 'page2' };
  const page1: TileSpec = { name: 'portStatus', identityClass: 'port-status', page: '' };
  assert.equal(tileTargetId('tabs-3', page1, 0), statusPanelId('tabs-3'));
  assert.equal(tileTargetId('tabs-3', page2, 1), statusComponentsPage2Id('tabs-3'));
  assert.equal(tileTargetId('tabs-3', page1, 4), statusComponentsId('tabs-3'));
  // GRIT tabs use the `grit-` twins, which `ids.ts` already handles.
  assert.equal(tileTargetId('grit-tabs-3', page1, 0), 'grit-status-panel-grit-tabs-3');
  assert.equal(tileTargetId('grit-tabs-3', page2, 1), 'grit-status-components-page2-grit-tabs-3');
});

test('R17/R18: mount creates the wrapper, mounts the real fragment and reports its identity', () => {
  const { doc } = tileHost('tabs-3');
  const tiles = createTileSystem({ root: () => doc, loader: realFragmentLoader() });
  const plan = tiles.plan(DEFAULT_FEATURES);
  const wrappers = plan.map((spec, index) => tiles.mount('tabs-3', spec, index));

  assert.equal(wrappers.length, plan.length);
  assert.equal((wrappers[0] as any).id, 'tile-0-tabs-3');
  // R17: `manage-tile` is the layout engine's doing (`ids.TILE_CLASS`), never the tile's own.
  assert.equal((wrappers[0] as any).className, 'tile status-tile');

  const byId = (index: number): any => doc.getElementById(`tile-${index}-tabs-3`);
  assert.equal(byId(0).parentElement.id, statusPanelId('tabs-3'), 'index 0 lives in the status panel');
  assert.equal(byId(1).parentElement.id, statusComponentsPage2Id('tabs-3'), 'satelliteTracking is a page-2 tile');
  assert.equal(doc.getElementById('tile-1-tabs-3')!.firstElementChild!.className, 'satelliteTracking-status');
  for (const index of [2, 3, 4, 5, 6, 7]) {
    assert.equal(byId(index).parentElement.id, statusComponentsId('tabs-3'), `tile ${index}`);
  }

  // The statusBar's first child div is `row status-bar` (§3.3), so it has no layout identity…
  assert.equal(byId(0).firstElementChild.className, 'row status-bar');
  assert.equal(tiles.identityClassOf(wrappers[0]), undefined);
  // …while a real tile reports the class Packery keys its layout on.
  assert.equal(byId(2).firstElementChild.className, 'position-status');
  assert.equal(tiles.identityClassOf(byId(2)), 'position-status');
  assert.ok(byId(2).querySelector('#positionStatuslatitude'), 'the fragment itself is inside the wrapper');
});

test('plan ⊗ fragment: every mountable tile reports exactly the identity the plan promises', () => {
  for (const [label, features] of MODELS) {
    const { doc } = tileHost('tabs-3');
    const tiles = createTileSystem({ root: () => doc, loader: realFragmentLoader(), features: () => features });
    const plan = planTiles(features);
    const wrappers = plan.map((spec, index) => tiles.mount('tabs-3', spec, index));
    plan.forEach((spec, index) => {
      const identity = tiles.identityClassOf(wrappers[index]);
      if (spec.name === 'statusBar') {
        assert.equal(identity, undefined, `${label}: the statusBar tile has no layout identity`);
        return;
      }
      assert.equal(identity, spec.identityClass, `${label}: ${spec.name}`);
    });
  }
});

test('mounted() keeps mount order and unmount() drops the whole tab', () => {
  const { doc } = tileHost('tabs-3');
  const tiles = createTileSystem({ root: () => doc, loader: realFragmentLoader() });
  const plan = planTiles(DEFAULT_FEATURES);
  plan.forEach((spec, index) => tiles.mount('tabs-3', spec, index));

  assert.deepEqual(
    tiles.mounted('tabs-3').map((tile) => (tile as any).id),
    plan.map((_spec, index) => `tile-${index}-tabs-3`),
  );
  assert.equal(tiles.mounted('tabs-8').length, 0);

  tiles.unmount('tabs-3');
  assert.deepEqual(tiles.mounted('tabs-3'), []);
  assert.equal(doc.querySelectorAll('[id]').filter((element) => element.id.startsWith('tile-')).length, 0);
});

test('mount refuses to guess when the container is missing', () => {
  const doc = createDocument();
  const tiles = createTileSystem({ root: () => doc, loader: realFragmentLoader() });
  const spec: TileSpec = { name: 'portStatus', identityClass: 'port-status', page: '' };
  assert.throws(() => tiles.mount('tabs-3', spec, 4), /container #status-components-tabs-3 is missing/);
  assert.throws(() => createTileSystem().mount('tabs-3', spec, 4), /container #status-components-tabs-3 is missing/);
});
