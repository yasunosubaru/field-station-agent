/**
 * Tests for the rendering contract. Where possible they run against the **shipped markup**
 * (`test/helpers.ts#htmlFragment`), so a selector rule is checked against the real ids and
 * classes instead of a fixture we invented.
 *
 * Acceptance criteria: R39, R42 of `03_分析/01_Manage主界面与视图层.md §8`, plus §5.1/§5.3/§5.4.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument } from '../src/minidom.ts';
import { View, createView } from '../src/view.ts';
import * as ids from '../src/ids.ts';
import { htmlFragment } from './helpers.ts';

function mount(body: string): { doc: ReturnType<typeof createDocument>; host: unknown } {
  const doc = createDocument();
  doc.body.innerHTML = body;
  return { doc, host: doc.body };
}

function statusBarDoc(activeTab = 'tabs-3') {
  const doc = createDocument();
  doc.body.innerHTML = `<div id="status-panel-${activeTab}">${htmlFragment('statusBar')}</div>`;
  const view = createView(doc, { activeTab: () => activeTab });
  return { doc, view, activeTab };
}

test('R39 the selector rule of §5.1 is reproduced for every feature family', () => {
  const view = new View(createDocument(), { activeTab: () => 'tabs-3' });
  assert.equal(view.selectorFor('statusBar', 'latitude', 'tabs-3'), '#status-panel-tabs-3 #statusBarlatitude');
  assert.equal(view.selectorFor('positionStatus', 'latitude', 'tabs-3'), '#main-panel-tabs-3 #positionStatuslatitude');
  assert.equal(view.selectorFor('gritStatusBar', 'time', 'grit-tabs-2'), '#grit-status-panel-grit-tabs-2 #gritStatusBartime');
  assert.equal(view.selectorFor('playback', 'progressBlue', 'tabs-4'), '#playback-panel-tabs-4 #playbackprogressBlue');
  assert.equal(view.selectorFor('hot-spot', 'x', 'tabs-4'), '#playback-panel-tabs-4 #hot-spotx');
  // tab === '' splits on device class for the Status-features, and is bare otherwise.
  assert.equal(view.selectorFor('positionStatus', 'latitude', ''), '.for-desktop #positionStatuslatitude');
  assert.equal(view.selectorFor('satelliteView', 'dop', ''), '.for-desktop #satelliteViewdop');
  assert.equal(view.selectorFor('statusBar', 'latitude', ''), '#statusBarlatitude');
  assert.equal(view.selectorFor('splashScreen', 'x', ''), '#splashScreenx');
  assert.equal(view.selectorFor('configureDevice', 'x', ''), '#configureDevicex');
});

test('R39 a non-active tab is dropped before any DOM work', () => {
  const { view } = statusBarDoc('tabs-3');
  const written = view.updateView({ tab: 'tabs-9', latitude: '51.1' }, 'latitude', 'statusBar');
  assert.equal(written, 0);
});

test('R39 updateView writes into the shipped statusBar markup', () => {
  const { doc, view } = statusBarDoc('tabs-3');
  const written = view.updateView(
    { tab: 'tabs-3', latitude: '51.116789', longitude: '-114.038862' },
    'latitude,longitude',
    'statusBar',
  );
  assert.equal(written, 2);
  assert.equal(doc.querySelector('#statusBarlatitude')!.textContent, '51.116789');
  assert.equal(doc.querySelector('#statusBarlongitude')!.textContent, '-114.038862');
});

test('R39 fields absent from the payload are skipped, not blanked', () => {
  const { doc, view } = statusBarDoc('tabs-3');
  assert.equal(doc.querySelector('#statusBarWeek')!.textContent, '--');
  const written = view.updateView({ tab: 'tabs-3', latitude: '1' }, 'latitude,Week', 'statusBar');
  assert.equal(written, 1);
  assert.equal(doc.querySelector('#statusBarWeek')!.textContent, '--', 'not part of the payload');
});

test('default mirror writes undefined/null exactly as the DOM coercion does', () => {
  const { doc, view } = statusBarDoc('tabs-3');
  view.updateView({ tab: 'tabs-3', latitude: undefined, longitude: null }, 'latitude,longitude', 'statusBar');
  assert.equal(doc.querySelector('#statusBarlatitude')!.textContent, 'undefined');
  assert.equal(doc.querySelector('#statusBarlongitude')!.textContent, 'null');
});

test('explicit corrected mode writes undefined/null as empty text', () => {
  const doc = createDocument();
  doc.body.innerHTML = `<div id="status-panel-tabs-3">${htmlFragment('statusBar')}</div>`;
  const view = createView(doc, { activeTab: () => 'tabs-3', mirrorDefects: false });
  view.updateView({ tab: 'tabs-3', latitude: undefined, longitude: null }, 'latitude,longitude', 'statusBar');
  assert.equal(doc.querySelector('#statusBarlatitude')!.textContent, '');
  assert.equal(doc.querySelector('#statusBarlongitude')!.textContent, '');
});

test('R42 the element cache is bucketed per tab+feature and drops with the tab', () => {
  const { view } = statusBarDoc('tabs-3');
  const other = createView(createDocument(), { activeTab: () => 'tabs-3' });
  view.updateView({ tab: 'tabs-3', latitude: '1' }, 'latitude', 'statusBar');
  assert.deepEqual(view.cacheKeys(), ['tabs-3statusBar']);
  view.updateView({ tab: 'tabs-3', latitude: '2' }, 'latitude', 'positionStatus');
  assert.deepEqual(view.cacheKeys().sort(), ['tabs-3positionStatus', 'tabs-3statusBar']);
  view.deleteElementIds('tabs-3');
  assert.deepEqual(view.cacheKeys(), []);
  assert.deepEqual(other.cacheKeys(), [], 'a different tab keeps its own cache');
});

test('R42 solStatus and headingTitle are never cached', () => {
  const doc = createDocument();
  doc.body.innerHTML = `<div id="main-panel-tabs-3">${htmlFragment('positionStatus')}</div>`;
  const view = createView(doc, { activeTab: () => 'tabs-3' });
  view.updateView({ tab: 'tabs-3', solStatus: 'SOL_COMPUTED', headingTitle: 'H' }, 'solStatus,headingTitle', 'positionStatus');
  const bucket =
    (view as unknown as { elementIds: Record<string, Record<string, unknown>> }).elementIds['tabs-3positionStatus'] ?? {};
  assert.equal(bucket.solStatus, undefined);
  assert.equal(bucket.headingTitle, undefined);
});

test('default mirror keeps writing to the cached element after it leaves the DOM', () => {
  const doc = createDocument();
  doc.body.innerHTML = `<div id="status-panel-tabs-3"><span id="statusBarlatitude">--</span></div>`;
  const view = createView(doc, { activeTab: () => 'tabs-3' });
  view.updateView({ tab: 'tabs-3', latitude: '1' }, 'latitude', 'statusBar');
  // Replace the whole inner markup: the cached node is now detached.
  doc.body.innerHTML = `<div id="status-panel-tabs-3"><span id="statusBarlatitude">--</span></div>`;
  view.updateView({ tab: 'tabs-3', latitude: '2' }, 'latitude', 'statusBar');
  assert.equal(doc.querySelector('#statusBarlatitude')!.textContent, '--');
});

test('corrected mode re-queries a cached element that left the DOM', () => {
  const doc = createDocument();
  doc.body.innerHTML = `<div id="status-panel-tabs-3"><span id="statusBarlatitude">--</span></div>`;
  const view = createView(doc, { activeTab: () => 'tabs-3', mirrorDefects: false });
  view.updateView({ tab: 'tabs-3', latitude: '1' }, 'latitude', 'statusBar');
  doc.body.innerHTML = `<div id="status-panel-tabs-3"><span id="statusBarlatitude">--</span></div>`;
  view.updateView({ tab: 'tabs-3', latitude: '2' }, 'latitude', 'statusBar');
  assert.equal(doc.querySelector('#statusBarlatitude')!.textContent, '2');
});

test('§5.3 RAG state maps to the four status classes', () => {
  const view = new View(createDocument(), {});
  assert.equal(view.ragClass('good'), 'green-status');
  assert.equal(view.ragClass('warning'), 'yellow-status');
  assert.equal(view.ragClass('bad'), 'red-status');
  assert.equal(view.ragClass('idle'), 'grey-status');
  assert.equal(view.ragClass('nonsense'), '');
});

test('§5.3 the traffic lights of a real tile toggle as the original does', () => {
  const doc = createDocument();
  doc.body.innerHTML = `<div id="tabs-3">${htmlFragment('positionStatus')}</div>`;
  const view = createView(doc, { activeTab: () => 'tabs-3' });
  const scope = '#tabs-3 .positionStatus.statustiles-traffic span';

  view.updateStatusIndicatorClrAndText('positionStatus', 'bad', 'tabs-3');
  const visible = doc.querySelectorAll(scope).filter((el) => el.style.display !== 'none');
  assert.equal(visible.length, 1);
  assert.ok(visible[0].classList.contains('red-status'));
  assert.equal(visible[0].style.display, 'block');

  view.updateStatusIndicatorClrAndText('positionStatus', 'good', 'tabs-3');
  const nowVisible = doc.querySelectorAll(scope).filter((el) => el.style.display !== 'none');
  assert.equal(nowVisible.length, 1);
  assert.ok(nowVisible[0].classList.contains('green-status'));
  assert.equal(nowVisible[0].style.display, 'block');

  // `grey-status` is not in the shipped markup, so `idle` shows nothing (faithful, not a bug we fix).
  view.updateStatusIndicatorClrAndText('positionStatus', 'idle', 'tabs-3');
  assert.equal(doc.querySelectorAll(scope).filter((el) => el.style.display !== 'none').length, 0);
});

test('§5.4 formatToSystemLocale pins the fraction digits and never groups', () => {
  const view = new View(createDocument(), { defaultLocale: 'en-US', activeTab: () => 'tabs-3' });
  assert.equal(view.formatToSystemLocale(1234.5, 2), '1234.50');
  assert.equal(view.formatToSystemLocale(1234567.891, 1), '1234567.9');
  assert.equal(view.formatToSystemLocale(0, 0), '0');

  const german = new View(createDocument(), { defaultLocale: 'de-DE', localeOf: () => 'de-DE' });
  assert.equal(german.getCommaLocale('tabs-3'), 'de-DE');
  assert.equal(german.formatToSystemLocale(1234.5, 2), '1234,50', 'comma decimal separator');
});

test('§5.4 getCommaLocale only returns the comma locales, otherwise the default', () => {
  const view = new View(createDocument(), { defaultLocale: 'en-US', localeOf: () => 'en-US' });
  assert.equal(view.getCommaLocale('tabs-3'), 'en-US');
  const french = new View(createDocument(), { defaultLocale: 'fr-FR', localeOf: () => 'fr-FR' });
  assert.equal(french.getCommaLocale('tabs-3'), 'fr-FR');
  const czech = new View(createDocument(), { localeOf: () => 'cs-CZ' });
  assert.equal(czech.getCommaLocale('tabs-3'), 'cs-CZ');
});

test('§5.4 verticalDop reproduces the worked example and the 9999 passthrough', () => {
  const view = new View(createDocument(), {});
  assert.ok(Math.abs(view.verticalDop(2.5, 1.2) - 2.1931712) < 1e-6);
  assert.equal(view.verticalDop(9999, 9999), 9999);
  assert.equal(view.verticalDop(1, 2), 9999, 'negative radicand falls back to 9999');
});

test('default mirror reproduces removeDataLangAttr skipping every other live attribute', () => {
  const doc = createDocument();
  const view = createView(doc, {});
  const element = doc.createElement('span');
  element.setAttribute('data-lang-warning', '');
  element.setAttribute('data-lang-title-interferenceStatusAmber', '');
  element.setAttribute('data-lang-good', '');
  element.setAttribute('data-lang', '');
  element.setAttribute('class', 'keep-me');
  view.removeDataLangAttr(element);
  assert.deepEqual(element.getAttributeNames(), [
    'data-lang-title-interferenceStatusAmber',
    'data-lang',
    'class',
  ]);
});

test('corrected mode removes every data-lang marker', () => {
  const doc = createDocument();
  const view = createView(doc, { mirrorDefects: false });
  const element = doc.createElement('span');
  element.setAttribute('data-lang-warning', '');
  element.setAttribute('data-lang-title-interferenceStatusAmber', '');
  element.setAttribute('data-lang-good', '');
  element.setAttribute('data-lang', '');
  element.setAttribute('class', 'keep-me');
  view.removeDataLangAttr(element);
  assert.deepEqual(element.getAttributeNames(), ['class']);
});

test('default mirror addDataLangAttr only adds the new marker', () => {
  const doc = createDocument();
  const view = createView(doc, {});
  const element = doc.createElement('span');
  element.setAttribute('data-lang-old', 'x');
  view.addDataLangAttr(element, 'data-lang-new');
  assert.deepEqual(element.getAttributeNames(), ['data-lang-old', 'data-lang-new']);
  assert.equal(element.getAttribute('data-lang-new'), '');
});

test('corrected mode addDataLangAttr clears old markers first', () => {
  const doc = createDocument();
  const view = createView(doc, { mirrorDefects: false });
  const element = doc.createElement('span');
  element.setAttribute('data-lang-old', 'x');
  view.addDataLangAttr(element, 'data-lang-new');
  assert.deepEqual(element.getAttributeNames(), ['data-lang-new']);
});

test('R47 the device-type label is a per-type marker, not a literal string', () => {
  const { deviceTypeMarker, markerFor } = ids;
  assert.equal(deviceTypeMarker('Network'), 'data-lang-network-type');
  assert.equal(deviceTypeMarker('Serial'), 'data-lang-serial-type');
  assert.equal(deviceTypeMarker('USB'), 'data-lang-usb-type');
  assert.equal(deviceTypeMarker('USB'), deviceTypeMarker('usb'), 'the type is lowercased');
  assert.equal(markerFor('Error'), 'data-lang-error');
  assert.equal(markerFor('WHY-THIS-AMBER'), 'data-lang-why-this-amber');
});

test('the selector rule resolves against the shipped positionStatus markup', () => {
  const { doc } = mount(`<div id="main-panel-tabs-3">${htmlFragment('positionStatus')}</div>`);
  assert.ok(doc.querySelector('#main-panel-tabs-3 #positionStatuslatitude'), 'declared as `id = "…"` with spaces');
  assert.ok(doc.querySelector('#main-panel-tabs-3 #positionStatusheight'));
});
