/**
 * Tests for the refresh throttle (R40/R41) and the language layer (R31–R38).
 *
 * Both modules are pure logic over the DOM, so they run against `minidom` with no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument } from '../src/minidom.ts';
import { ThrottleImpl, createThrottle, REPLAY_ORDER, tabOfPayload } from '../src/throttle.ts';
import {
  Language,
  createLanguage,
} from '../src/language.ts';
import type { FeatureFlags } from '../src/types.ts';
import { DEFAULT_FEATURES } from '../src/types.ts';
import { htmlFragment } from './helpers.ts';

/* ------------------------------------------------------------------ throttle */

function harness(active: string) {
  let activeTab = active;
  const throttle = createThrottle({
    activeTab: () => activeTab,
    setActiveTab: (tab) => {
      activeTab = tab;
    },
  });
  return { throttle, setActive: (tab: string) => (activeTab = tab) };
}

test('R40 the active-tab gate also treats tabs-1 and the empty tab as active', () => {
  const { throttle } = harness('tabs-3');
  assert.equal(throttle.isActive('tabs-3'), true);
  assert.equal(throttle.isActive('tabs-4'), false);
  const { throttle: landing } = harness('tabs-1');
  assert.equal(landing.isActive('tabs-9'), true, 'tabs-1 is the Add-device page: everyone renders');
  const { throttle: webui } = harness('');
  assert.equal(webui.isActive('tabs-9'), true, 'webui/landing renders every tab');
});

test('R40 an inactive tab keeps only its last frame and never calls the renderer', () => {
  const { throttle } = harness('tabs-3');
  const calls: unknown[][] = [];
  throttle.on('statusBar', (data) => calls.push(data));
  const result = throttle.dispatch('statusBar', [42, { tab: 'tabs-4' }]);
  assert.equal(result, 'cached');
  assert.equal(calls.length, 0);
  assert.deepEqual(throttle.cached('tabs-4').statusBar, [42, { tab: 'tabs-4' }]);
  throttle.dispatch('statusBar', [42, { tab: 'tabs-4', latitude: 'later' }]);
  assert.equal((throttle.cached('tabs-4').statusBar as unknown[])[1]['latitude'], 'later', 'last frame wins');
});

test('R40 an active tab renders immediately and keeps no cache entry', () => {
  const { throttle } = harness('tabs-3');
  const calls: unknown[][] = [];
  throttle.on('positionStatus', (data) => calls.push(data));
  assert.equal(throttle.dispatch('positionStatus', [42, { tab: 'tabs-3' }]), 'rendered');
  assert.equal(calls.length, 1);
  assert.equal(throttle.cached('tabs-3').positionStatus, undefined);
});

test('R40 pppCorrections shares the positionStatus bucket, as the original does', () => {
  const { throttle } = harness('tabs-3');
  throttle.dispatch('pppCorrections', [{ tab: 'tabs-4' }]);
  assert.ok(throttle.cached('tabs-4').positionStatus, 'pppCorrections folds into positionStatus');
});

test('R40 the tab can be carried by either payload slot', () => {
  assert.equal(tabOfPayload([42, { tab: 'tabs-7' }]), 'tabs-7');
  assert.equal(tabOfPayload([{ tab: 'tabs-7' }, 'ignored']), 'tabs-7');
  assert.equal(tabOfPayload([{ sats: [] }, 'tabs-7']), 'tabs-7', 'constellation channels pass the tab second');
  assert.equal(tabOfPayload([{ sats: [] }, 'grit-tabs-2']), 'grit-tabs-2');
  assert.equal(tabOfPayload([42, { noTab: true }]), '');
});

test('R41 replay walks the eleven channels in the original order', () => {
  assert.deepEqual(
    REPLAY_ORDER.map(([channel]) => channel),
    [
      'statusBar',
      'positionStatus',
      'alignStatus',
      'deviceInfo',
      'radioStatus',
      'spanStatus',
      'constellationTrackstat',
      'constellationChanconfiglist',
      'constellationSatvis',
      'constellationBestsats',
      'satelliteTracking',
    ],
  );

  const { throttle } = harness('tabs-3');
  const order: string[] = [];
  for (const [channel] of REPLAY_ORDER) throttle.on(channel, () => order.push(channel));

  // Cache one frame per channel from a background tab…
  const payloads: Record<string, unknown[]> = {
    statusBar: [42, { tab: 'tabs-4' }],
    positionStatus: [42, { tab: 'tabs-4' }],
    alignStatus: [1, { tab: 'tabs-4' }],
    deviceInfo: [963, { tab: 'tabs-4' }],
    radioStatus: [1, { tab: 'tabs-4' }],
    spanStatus: [1, { tab: 'tabs-4' }],
    constellationTrackstat: [{ sats: [] }, 'tabs-4'],
    constellationChanconfiglist: [{ chans: [] }, 'tabs-4'],
    constellationSatvis: [{ sats: [] }, 'tabs-4'],
    constellationBestsats: [{ sats: [] }, 'tabs-4'],
    satelliteTracking: [83, { tab: 'tabs-4' }],
    // cached but never replayed:
    portStatus: [1, { tab: 'tabs-4' }],
    logStatus: [1, { tab: 'tabs-4' }],
  };
  for (const [channel, payload] of Object.entries(payloads)) throttle.dispatch(channel, payload);

  const replayed = throttle.replay('tabs-4');
  assert.deepEqual(replayed, REPLAY_ORDER.map(([channel]) => channel));
  assert.deepEqual(order, replayed);
  assert.equal(throttle.replayCount('tabs-4'), 1);
});

test('R41 replay is a no-op for a tab with nothing cached', () => {
  const { throttle } = harness('tabs-3');
  throttle.on('statusBar', () => {
    throw new Error('must not render');
  });
  assert.deepEqual(throttle.replay('tabs-99'), []);
});

/* ------------------------------------------------------------------ language */

test('R31 the dictionary is additive like jsIn.addDict, and clearDictionary is the fix', () => {
  const lang = createLanguage();
  lang.loadDictionary({ A: 'first', B: 'only-in-first' }, 'en');
  assert.equal(lang.translate('A'), 'first');
  lang.loadDictionary({ A: 'second' }, 'de');
  assert.equal(lang.translate('A'), 'second');
  assert.equal(lang.translate('B'), 'only-in-first', 'the stale key survives, exactly as shipped');
  assert.equal(lang.translate('MISSING'), 'MISSING', 'unknown keys fall back to the key itself');
  lang.clearDictionary();
  assert.equal(lang.dictionarySize(), 0);
  assert.equal(lang.translate('B'), 'B');
});

test('R33 language resolution matches languageName lowercased, and falls back to en', () => {
  const lang = createLanguage();
  lang.loadLanguageSettings({
    en: { languageName: 'English', filePath: '../languageSupport/en.js' },
    cn: { languageName: 'Chinese', filePath: '../languageSupport/cn.js' },
    de: { languageName: 'German', filePath: '../languageSupport/de.js' },
  });
  assert.equal(lang.resolveLanguageId('English'), 'en');
  assert.equal(lang.resolveLanguageId('english'), 'en');
  assert.equal(lang.resolveLanguageId('Chinese'), 'cn');
  // The persisted preference is a DOM id like `german-lang`, so the first segment is the name.
  assert.equal(lang.resolveLanguageId('german-lang'), 'de');
  // ISO codes do NOT match: `de-DE` → 'de' != 'german' → the original silently falls back to en.
  assert.equal(lang.resolveLanguageId('de-DE'), 'en');
  assert.equal(lang.resolveLanguageId('zh-CN'), 'en', 'Chinese is registered as cn, so zh-CN misses');
  assert.equal(lang.resolveLanguageId('klingon'), 'en');
  assert.equal(lang.resolvedFilePath('German'), '../languageSupport/de.js');
});

test('R34 the status fan-out is 20 components in the shipped order', () => {
  const lang = createLanguage();
  const ran: string[] = [];
  const order = lang.registerStatusFanOut((name) => () => ran.push(name));
  assert.equal(order.length, 20);
  assert.deepEqual(order, [
    'statusBar',
    'positionStatus',
    'portStatus',
    'satelliteView',
    'deviceInfo',
    'interferenceStatus',
    'logStatus',
    'radioStatus',
    'events',
    'menuBar',
    'pppCorrections',
    'loadConfiguration',
    'saveConfiguration',
    'deviceDetails',
    'deviceExport',
    'satelliteTracking',
    'alignStatus',
    'spanStatus',
    'agcStatus',
    'generalSettings',
  ]);
  assert.deepEqual(lang.processLanguage('tabs-3'), order);
  assert.deepEqual(ran, order);
});

test('R34 GIII substitutes satelliteTracking and appends giiiLogStatus', () => {
  const giii: FeatureFlags = { ...DEFAULT_FEATURES, isGIII: true, generation: 'GIII' };
  const lang = createLanguage({ features: () => giii });
  const order = lang.registerStatusFanOut(() => () => {});
  assert.equal(order.length, 23, '3 GIII components replace satelliteTracking (20 - 1 + 3 = 22), plus giiiLogStatus');
  assert.ok(order.includes('giiiSatelliteTracking'));
  assert.ok(order.includes('giiiTerminalConsole'));
  assert.ok(order.includes('giiiDeviceDetails'));
  assert.ok(order.includes('giiiLogStatus'));
  assert.ok(!order.includes('satelliteTracking'));
  assert.ok(order.indexOf('giiiLogStatus') > order.indexOf('generalSettings'), 'appended last');
});

test('R34 GRIT prepends its own component', () => {
  const lang = createLanguage({ gritActive: () => true });
  const order = lang.registerStatusFanOut(() => () => {});
  assert.equal(order[0], 'gritJarvisInterface');
  assert.equal(order.length, 21);
});

test('R34 the config fan-out is 9 modules plus the conditional groups', () => {
  const plain = createLanguage();
  assert.deepEqual(plain.registerConfigFanOut(() => () => {}), [
    'positionConfig',
    'positioningConfig',
    'portConfig',
    'loggingConfig',
    'radioConfig',
    'alignConfig',
    'spanConfig',
    'gnssConfig',
    'interferenceToolKit',
  ]);

  const longhorn = createLanguage({ features: () => ({ ...DEFAULT_FEATURES, isLongHorn: true }) });
  const lh = longhorn.registerConfigFanOut(() => () => {});
  assert.equal(lh.length, 12);
  assert.ok(lh.includes('lghnPositionConfig') && lh.includes('longhornStatusUI') && lh.includes('lghn_deviceUpdate'));

  const giii = createLanguage({ features: () => ({ ...DEFAULT_FEATURES, isGIII: true }) });
  const g = giii.registerConfigFanOut(() => () => {});
  assert.ok(g.includes('giiiLoggingConfig'));
  assert.ok(!g.includes('loggingConfig'), 'loggingConfig is swapped out for GIII');

  const marine = createLanguage({ features: () => ({ ...DEFAULT_FEATURES, isMarinePak: true }) });
  assert.ok(marine.registerConfigFanOut(() => () => {}).includes('spoofingConfiguration'));
});

test('R32 applyUserLanguagePreference ignores the tab argument but still runs the fan-out', () => {
  const lang = createLanguage();
  const seen: Array<string | undefined> = [];
  lang.register('statusBar', (tab) => seen.push(tab));
  lang.loadLanguageSettings({ en: { languageName: 'English', filePath: 'en.js' } });
  const ran = lang.applyUserLanguagePreference('English', 'tabs-3');
  assert.deepEqual(ran, ['statusBar']);
  assert.deepEqual(seen, ['tabs-3'], 'the tab is forwarded to the components (the original ignores it entirely)');
  assert.equal(lang.currentLanguage(), 'en');
});

test('R35/R37 markers are listed and applied only when the dictionary knows the key', () => {
  const doc = createDocument();
  doc.body.innerHTML = `<div>${htmlFragment('positionStatus')}</div>`;
  const lang = createLanguage();
  const markers = lang.markers(doc);
  assert.ok(markers.includes('data-lang-positioning'));
  assert.ok(markers.includes('data-lang-operating-mode'));
  assert.equal(markers.every((name) => name.startsWith('data-lang')), true);
  // Shipped-fragment fact worth knowing: positionStatus.html's two "why this amber / why this red"
  // links are inside an HTML comment (`:12-13`), so those markers never exist in the DOM.
  assert.ok(!markers.includes('data-lang-why-this-amber'));
  assert.equal(doc.querySelector('[data-lang-why-this-amber]'), null);

  const before = doc.querySelector('[data-lang-positioning]')!.textContent;
  assert.equal(lang.applyMarkers(doc), 0, 'nothing to write without a dictionary');
  assert.equal(doc.querySelector('[data-lang-positioning]')!.textContent, before, 'shipped text untouched');

  lang.loadDictionary({ POSITIONING: '定位', 'OPERATING-MODE': '工作模式' });
  const written = lang.applyMarkers(doc);
  assert.equal(written, 2);
  assert.equal(doc.querySelector('[data-lang-positioning]')!.textContent, '定位');
  assert.equal(doc.querySelector('[data-lang-operating-mode]')!.textContent, '工作模式');
});

test('R37 the same marker set is reported for a document with no markers at all', () => {
  const doc = createDocument();
  doc.body.innerHTML = '<div><span>plain</span></div>';
  const lang = new Language();
  assert.deepEqual(lang.markers(doc), []);
  assert.equal(lang.applyMarkers(doc), 0);
});
