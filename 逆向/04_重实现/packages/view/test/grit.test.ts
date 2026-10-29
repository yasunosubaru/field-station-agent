/**
 * GRIT Monitor: the assertions behind `03_分析/05_GRIT-Monitor.md §8`.
 *
 * Everything that can be checked against shipped material is: the log register comes from
 * `data/grit-comp-logs-register.json` (extracted from `gritJarvisInterface.js:158-291`), the
 * fragments come from `01_解包/app/view/GRIT/**`, and the byte/unit maths follows §5.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocument, type MiniDocument } from '../src/minidom.ts';
import {
  GRIT_LOG_REGISTER,
  gritLogRequests,
  buildGritShell,
  createGritBundle,
  type GritContext,
} from '../src/grit/index.ts';
import { GRIT_REPLAY_ORDER, REPLAY_ORDER } from '../src/throttle.ts';
import { realFragmentLoader, newClock, newStore } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shippedRegister = JSON.parse(
  readFileSync(join(here, '..', 'data', 'grit-comp-logs-register.json'), 'utf8'),
) as Record<string, Record<string, string>>;

function harness(tab = 'grit-tabs-2') {
  const doc = createDocument() as MiniDocument;
  const host = doc.createElement('div');
  host.id = tab;
  doc.body.appendChild(host);
  const sent: Array<{ tab: string; name: string; spec: string }> = [];
  const context: GritContext = {
    document: doc as unknown as Document,
    fragments: realFragmentLoader(),
    clock: newClock(),
    store: newStore(),
    translate: (key: string) => key,
    deviceTileId: () => '1700000000000',
    connectionType: () => 'Network',
    transport: { sendBinary() {}, sendAscii() {}, sendRaw() {} } as never,
    sendLog: (target, name, spec) => sent.push({ tab: target, name, spec }),
  };
  const bundle = createGritBundle({ context });
  const shell = bundle.buildPanels(tab, host as unknown as Element);
  return { doc, host, bundle, shell, context, sent, tab };
}

/* ------------------------------------------------------------- registry */

test('R14 the register is the shipped one, component for component', () => {
  const shipped = Object.entries(shippedRegister).sort(([a], [b]) => a.localeCompare(b));
  const ours = Object.entries(GRIT_LOG_REGISTER).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(ours.map(([name]) => name), shipped.map(([name]) => name),
    'gritCompLogsRegister has 14 components in gritJarvisInterface.js:158-291');
  for (const [component, logs] of shipped) {
    const expected = Object.entries(logs)
      .map(([key, spec]) => `${key}=${spec.replace(/\s+/g, '')}`)
      .sort();
    const actual = Object.entries(GRIT_LOG_REGISTER[component] ?? {})
      .map(([key, spec]) => `${key}=${spec.replace(/\s+/g, '')}`)
      .sort();
    assert.deepEqual(actual, expected, `${component} drifted from the shipped register`);
  }
});

test('R14 log commands are `<NAME> <TRIGGER> <PERIOD>` with the trailing `b` stripped', () => {
  const requests = gritLogRequests(['gritStatusBar']);
  assert.equal(requests[0].name, 'RXCONFIG');
  assert.equal(requests[0].trigger, 'ONCHANGED');
  assert.equal(requests[0].period, 0);
  const bestpos = requests.find((request) => request.name === 'BESTPOS');
  assert.deepEqual(bestpos, { name: 'BESTPOS', trigger: 'ONTIME', period: 1 });
});

test('R14 there is no de-duplication: LOGLIST is requested by three components and kept three times', () => {
  const statusBarRows = gritLogRequests(['gritStatusBar']);
  assert.equal(statusBarRows.length, 23, 'the shipped gritStatusBar register has 23 log rows');
  const loglist = gritLogRequests().filter((request) => request.name === 'LOGLIST');
  assert.equal(loglist.length, 3, 'gritStatusBar + gritRagIndicators + gritEvents each ask for LOGLIST');
  assert.ok(gritLogRequests().length > 24, 'every component is swept, not just gritStatusBar');
});

/* ---------------------------------------------------------------- shell */

test('createGritMainPanel builds the GRIT containers in order, with no SM status/config rows', () => {
  const { host } = harness();
  const children = [...(host as unknown as { children: Array<{ id: string; className: string }> }).children];
  assert.deepEqual(
    children.slice(0, 4).map((node) => node.id),
    ['grit-events-panel-grit-tabs-2', 'grit-menuBar-panel-grit-tabs-2', 'grit-status-panel-grit-tabs-2', 'main-panel-grit-tabs-2'],
    'gritJarvisInterface.js:438-597 order',
  );
  const main = children[3] as unknown as { children: Array<{ id: string }> };
  const nested = main.children.map((node) => node.id);
  assert.ok(nested.includes('fetch-loader-grit-tabs-2'));
  assert.ok(nested.includes('grit-status-components-grit-tabs-2'));
  assert.ok(nested.includes('grit-config-components-grit-tabs-2'));
  assert.ok(main.children.every((node) => !/^status-config-/.test(node.id)), 'GRIT has no page1/page2 bar');
});

test('the GRIT shell carries the Spoofing config tab, the two modals and the loader', () => {
  const { doc } = harness();
  assert.ok(doc.getElementById('spoofingConfig'), 'Spoofing pill (gritJarvisInterface.js:438-597)');
  assert.ok(doc.getElementById('grit-config-spoofing-grit-tabs-2'));
  assert.ok(doc.getElementById('tabs-popup'));
  assert.ok(doc.getElementById('POIpopupModal'));
  const loader = doc.getElementById('connection-loader') as unknown as { style: { display: string } };
  assert.equal(loader.style.display, 'none');
});

test('mount loads the shipped GRIT fragments into their containers', () => {
  const { bundle, shell, tab } = harness();
  bundle.mount(tab, {
    generation: 'OEM7', model: 'OEM729', isLongHorn: false, isGIII: false, isMarinePak: false,
    alignSupported: false, spanSupported: false, radioTxSupported: false, terrastarSupported: false,
    dualAntennaSupported: false, increasedLogLimit: false, spoofingSupported: true, fileSupported: true,
    positionModes: [],
  } as never);
  assert.deepEqual(bundle.mounted(tab), [
    'gritStatusBar', 'gritMenuBar', 'gritEvents', 'spectrumViewer',
    'interferenceToolKit', 'pointsOfInterest', 'spoofingConfiguration',
  ]);
  const status = shell.statusTile as unknown as { firstElementChild: { className: string } | null };
  assert.ok(status.firstElementChild, 'gritStatusBar.html was injected');
  assert.match(shell.spectrumTile.className, /status-tile/);
});

/* --------------------------------------------------------- dispatch gate */

test('R12 only GRIT message ids reach the components', () => {
  const { bundle, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  assert.deepEqual(bundle.handleLog(tab, 42, { tab, latitude: 1, longitude: 2 }), ['gritEvents', 'pointsOfInterest']);
  assert.deepEqual(bundle.handleLog(tab, 3, { tab }), [], 'INTERFACEMODE is in gritCompRegister, not the dispatch');
});

/* ------------------------------------------------------------ spectrum */

test('R19 samples are raw/256 - 200 dBm: raw 18944 → -126.0', () => {
  const { bundle, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  bundle.spectrumViewer.ingest(1968, {
    tab, sequence: 0, frequencyStart: 1575.42, stepSize: 2000,
    data: [{ sample: 18944 }, { sample: 18944 }],
  }, tab);
  const samples = bundle.spectrumViewer.samples.get(tab)!;
  assert.equal(samples[0].power, -126);
});

test('R20 bin 0…n frequency is start + n*step/1e6 MHz', () => {
  const { bundle, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  bundle.spectrumViewer.ingest(1968, {
    tab, sequence: 0, frequencyStart: 1575.42, stepSize: 2000,
    data: [{ sample: 18944 }, { sample: 18944 }, { sample: 18944 }],
  }, tab);
  const samples = bundle.spectrumViewer.samples.get(tab)!;
  assert.equal(samples[0].frequency, 1575.42);
  assert.equal(samples[1].frequency, 1575.422);
  assert.equal(samples[2].frequency, 1575.424);
});

test('R22 only sequenceId 0 draws, and a repeated sequenceId inside one frame-set is dropped', () => {
  const { bundle, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  const frame = { tab, frequencyStart: 1000, stepSize: 1000, data: [{ sample: 18944 }] };
  assert.equal(bundle.spectrumViewer.ingest(2063, { ...frame, sequence: 7 }, tab), true, 'non-zero chunks are buffered');
  assert.equal(bundle.spectrumViewer.ingest(2063, { ...frame, sequence: 7 }, tab), false, 'a repeated chunk is dropped');
  assert.equal(bundle.spectrumViewer.ingest(1968, { ...frame, sequence: 0 }, tab), true, 'sequenceId 0 draws');
  assert.ok((bundle.spectrumViewer.samples.get(tab) ?? []).length >= 2, 'the buffered chunks are merged and drawn');
});

test('R26/R27 the advanced settings keep the documented bounds', () => {
  const { bundle, tab } = harness();
  const view = bundle.spectrumViewer;
  assert.deepEqual(view.getAdvSettingInfo(tab), { updateRate: 1, spectrumResolution: 1, timeAveraging: 10, detectionSensitivity: 5 });
  assert.equal(view.setAdvSettingInfo({ spectrumResolution: 3 }, tab).spectrumResolution, 1, 'only 1/2/4/8/16/32/64');
  assert.equal(view.setAdvSettingInfo({ spectrumResolution: 64, updateRate: 0.1 }, tab).updateRate, 0.2);
  assert.equal(view.setAdvSettingInfo({ spectrumResolution: 32, updateRate: 0.05 }, tab).updateRate, 0.1);
  assert.equal(view.setAdvSettingInfo({ spectrumResolution: 1, updateRate: 0 }, tab).updateRate, 0.05);
  view.setPlotType(tab, 'waterfallPlot');
  assert.ok(view.setAdvSettingInfo({ updateRate: 0.05 }, tab).updateRate >= 1, 'waterfall forces ≥ 1 s');
});

test('R28 a Serial connection pins ITSPECTRALANALYSIS to 1K/10/5', () => {
  const { bundle, tab, context } = harness();
  (context as unknown as { connectionType: () => string }).connectionType = () => 'Serial';
  const settings = bundle.spectrumViewer.getAdvSettingInfo(tab);
  assert.deepEqual(settings, { updateRate: 1, spectrumResolution: 1, timeAveraging: 10, detectionSensitivity: 5 });
});

/* --------------------------------------------------------------- status */

test('R38 spoofing text has three states: uncalibrated, disabled, then bit 9', () => {
  const { bundle, doc, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  const text = (id: string) => (doc.getElementById(id) as unknown as { textContent: string }).textContent;

  bundle.statusBar.updateView(93, { tab, rxstatus9bit: 1, rxstatus15bit: 0, aux3status25bit: 1 }, false);
  assert.equal(text('gritStatusBarspoofing'), 'Not calibrated');

  bundle.statusBar.updateView(93, { tab, rxstatus9bit: 1, rxstatus15bit: 0, aux3status25bit: 0 }, false);
  bundle.statusBar.updateView(2358, { tab, mode: 'DISABLE' }, false);
  assert.equal(text('gritStatusBarspoofing'), 'Detection disabled');

  bundle.statusBar.updateView(2358, { tab, mode: 'ENABLE' }, false);
  assert.equal(text('gritStatusBarspoofing'), 'Detected');

  bundle.statusBar.updateView(93, { tab, rxstatus9bit: 0, rxstatus15bit: 1, aux3status25bit: 0 }, false);
  assert.equal(text('gritStatusBarspoofing'), 'Not detected');
  assert.equal(text('gritStatusBarjamming'), 'Detected');
});

test('R47 CPU 81–90 is amber, >90 is red, and fewer than 4 satellites is a red position', () => {
  const { bundle, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  const rag = () => bundle.statusBar.gritRagIndicatorDetection(tab);

  bundle.statusBar.updateView(963, { tab, idleTime: 50 }, false);
  bundle.statusBar.updateView(42, { tab, satellitesUsed: 9, positionType: 'RTK' }, false);
  assert.deepEqual(rag(), { position: 'good', device: 'good' });

  bundle.statusBar.updateView(963, { tab, idleTime: 85 }, false);
  assert.equal(rag().device, 'warning');
  bundle.statusBar.updateView(963, { tab, idleTime: 95 }, false);
  assert.equal(rag().device, 'bad');

  bundle.statusBar.updateView(42, { tab, satellitesUsed: 3, positionType: 'RTK' }, false);
  assert.equal(rag().position, 'bad');
});

test('R48 one interference source is amber, two or more are red', () => {
  const { bundle, tab } = harness();
  bundle.mount(tab, { spoofingSupported: true, fileSupported: true } as never);
  const rag = () => bundle.statusBar.gritRagIndicatorDetection(tab);
  bundle.statusBar.updateView(42, { tab, satellitesUsed: 9 }, false);

  bundle.statusBar.updateView(2065, { tab, data: [{ detectionType: 'SPECTRALANALYSIS' }] }, false);
  assert.equal(rag().device, 'warning');

  bundle.statusBar.updateView(93, { tab, rxstatus9bit: 0, rxstatus15bit: 1, aux3status25bit: 0 }, false);
  assert.equal(rag().device, 'bad');
});

/* ----------------------------------------------------------------- POI */

test('R18 refactorPOIObjects de-duplicates by six decimal places, first entry wins', () => {
  const { bundle, tab } = harness();
  const base = { radius: 10, notification: 'entry' as const, visible: 'show' as const, status: 'active' as const, type: 'manual' };
  const out = bundle.pointsOfInterest.refactorPOIObjects({
    a: { ...base, name: 'a', lat: 30.1234567, lng: 114.1234567 },
    b: { ...base, name: 'b', lat: 30.1234568, lng: 114.1234568 },
    c: { ...base, name: 'c', lat: 31, lng: 115 },
  });
  assert.deepEqual(Object.keys(out), ['a', 'c']);
});

test('R39/R40 name ≤ 16 chars, radius 0…99999, and no duplicate name across manual+triggers', () => {
  const { bundle, context, tab } = harness();
  const base = { notification: 'entry' as const, visible: 'show' as const, status: 'active' as const, type: 'manual' };
  const ok = { ...base, name: 'home', radius: 50, lat: 30, lng: 114 };
  assert.equal(bundle.pointsOfInterest.save(tab, 'manual', ok), true);
  assert.equal(bundle.pointsOfInterest.save(tab, 'triggers', { ...ok, name: 'seventeen-chars-xx' }), false);
  assert.equal(bundle.pointsOfInterest.save(tab, 'triggers', { ...ok, name: 'mark1', radius: 100000, type: 'MARK1POS' }), false);
  assert.equal(bundle.pointsOfInterest.save(tab, 'triggers', { ...ok, name: 'mark2', type: 'MARK2POS' }), true);
  assert.equal(bundle.pointsOfInterest.save(tab, 'manual', { ...ok, name: 'mark2' }), false, 'duplicate across both maps');
  const stored = context.store.getData<Record<string, unknown>>(['app', 'poi', '1700000000000']);
  assert.ok(stored, 'the record is persisted through userStore');
});

test('R42 a POI entry needs horSpeed > 0.1 and an active, notifying record', () => {
  const { bundle, tab } = harness();
  const poi = { name: 'site', radius: 100, lat: 30, lng: 114, notification: 'entry' as const, visible: 'show' as const, status: 'active' as const, type: 'manual' };
  bundle.pointsOfInterest.save(tab, 'manual', poi);
  const events = () => Object.values(bundle.events.current.get(tab) ?? {}).length;
  assert.equal(events(), 0);
  bundle.pointsOfInterest.updateData({ latitude: 31, longitude: 115, horSpeed: 1.5 }, 42, tab);
  assert.equal(events(), 0, 'still outside the radius');
  bundle.pointsOfInterest.updateData({ latitude: 30, longitude: 114, horSpeed: 0.05 }, 42, tab);
  assert.equal(events(), 0, 'too slow to count as an entry');
  bundle.pointsOfInterest.updateData({ latitude: 30, longitude: 114, horSpeed: 1.5 }, 42, tab);
  assert.equal(events(), 1, 'a real entry raises one ENTERED_INTO event');
  assert.equal(
    Object.values(bundle.events.current.get(tab) ?? {})[0].description,
    'ENTERED_INTO',
  );
});

/* ------------------------------------------------------------- replay */

test('R16 the GRIT replay is three channels, separate from the eleven of loadCachedData', () => {
  assert.equal(REPLAY_ORDER.length, 11);
  assert.deepEqual(GRIT_REPLAY_ORDER.map(([channel]) => channel), ['gritStatusBar', 'spectrumPlot', 'gritPositionStatusmodes']);
});
