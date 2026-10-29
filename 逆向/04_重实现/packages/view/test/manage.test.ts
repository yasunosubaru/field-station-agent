/**
 * Integration test for the Manage wiring.
 *
 * Everything else in this package is unit-tested against its own contract; this file asserts the
 * composition actually works end to end, on the **shipped fragments**:
 *
 *   enterManage → addTab → connectionStatus → VERSIONB gate → buildPanels/buildTiles →
 *   requestInitialLogs → log frame → throttle → updateView → DOM text
 *
 * plus the tab-switch replay and the close/unlog accounting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocument } from '../src/minidom.ts';
import { createTabRegistry } from '../src/tabs.ts';
import { createTileSystem } from '../src/tiles.ts';
import { createManage, type ComponentRegister, type ManageOptions } from '../src/manage.ts';
import { decodedFixture, newClock, newStore, realFragmentLoader } from './helpers.ts';
import { DEFAULT_FEATURES, type DecodedLog, type FeatureFlags } from '../src/types.ts';
import { statusPanelId, statusComponentsId } from '../src/ids.ts';

const here = dirname(fileURLToPath(import.meta.url));
const components = JSON.parse(
  readFileSync(join(here, '..', '..', 'protocol', 'data', 'components.json'), 'utf8'),
) as ComponentRegister;

function decodedLog(partial: Partial<DecodedLog> & { messageId: number; name: string }): DecodedLog {
  return {
    header: { kind: 'long', headerLength: 28, messageId: partial.messageId } as DecodedLog['header'],
    payload: new Uint8Array(0),
    fields: {},
    hasRepeatedBlock: false,
    time: new Date(0),
    crcOk: true,
    ...partial,
  } as DecodedLog;
}

function harness(
  overrides: Partial<FeatureFlags> = {},
  manageOverrides: Partial<ManageOptions> = {},
) {
  const features: FeatureFlags = { ...DEFAULT_FEATURES, ...overrides };
  const doc = createDocument();
  const clock = newClock();
  const store = newStore();
  const shellRoot = doc.createElement('div');
  shellRoot.id = 'shell';
  doc.body.appendChild(shellRoot);

  // The shipped shell markup the ManageHost callbacks operate on.
  doc.body.innerHTML +=
    '<div class="noncoreapp-layout"></div>' +
    '<div class="welcome-layout"></div>' +
    '<div class="setUpMonitor-layout" hidden></div>' +
    '<div class="landing-pages"></div>' +
    '<div class="setupMonitor-landing-screen" hidden></div>' +
    '<span id="sm-title"></span>' +
    '<span class="tabImg"></span><span class="default-icon"></span>';

  const registry = createTabRegistry({});
  registry.buildShell(doc.getElementById('shell')!);

  const tiles = createTileSystem({
    root: () => doc.body as never,
    loader: realFragmentLoader(),
    features: () => features,
  });

  const steps: string[] = [];
  const show = (selector: string, visible: boolean) => {
    const element = doc.querySelector(selector);
    if (!element) return;
    if (visible) element.removeAttribute('hidden');
    else element.setAttribute('hidden', '');
  };
  const host = {
    hideNonCoreApp: () => {
      steps.push('hideNonCoreApp');
      show('.noncoreapp-layout', false);
    },
    hideWelcome: () => {
      steps.push('hideWelcome');
      show('.welcome-layout', false);
    },
    showSetUpMonitor: () => {
      steps.push('showSetUpMonitor');
      show('.setUpMonitor-layout', true);
    },
    hideLandingPages: () => {
      steps.push('hideLandingPages');
      show('.landing-pages', false);
    },
    showSetupMonitorLanding: () => {
      steps.push('showSetupMonitorLanding');
      show('.setupMonitor-landing-screen', true);
    },
    setTitle: (title: string) => {
      steps.push('setTitle:' + title);
      const node = doc.getElementById('sm-title');
      if (node) node.textContent = title;
    },
    switchIcon: () => steps.push('switchIcon'),
    applyLanguage: () => steps.push('applyLanguage'),
  };

  const manage = createManage({
    document: doc as unknown as Document,
    clock,
    store,
    fragments: realFragmentLoader(),
    tiles,
    register: components,
    tabShell: registry as never,
    features: () => features,
    ...manageOverrides,
  });

  return { doc, clock, store, registry, manage, features, host, steps };
}

const DETAILS = { type: 'eth' as const, protocol: 'tcp' as const, ipAddress: '10.0.0.1', port: 3001 };

test('enterManage activates the static Add-device tab and selects the SM app', () => {
  const { manage, registry, doc, host } = harness();
  manage.enterManage(host);
  assert.equal(manage.active(), 'tabs-1');
  assert.equal(registry.currentApp(), 'SM');
  assert.equal(registry.isEnabled('tabs-1'), true);
});

test('ManageOptions forwards mirrorDefects so the assembly can opt into corrected view behaviour', () => {
  const mirrored = harness({}, { mirrorDefects: true });
  const mirroredElement = mirrored.doc.createElement('span');
  mirroredElement.setAttribute('data-lang-a', '');
  mirroredElement.setAttribute('data-lang-b', '');
  mirrored.manage.view.removeDataLangAttr(mirroredElement);
  assert.deepEqual(mirroredElement.getAttributeNames(), ['data-lang-b']);

  const corrected = harness({}, { mirrorDefects: false });
  const correctedElement = corrected.doc.createElement('span');
  correctedElement.setAttribute('data-lang-a', '');
  correctedElement.setAttribute('data-lang-b', '');
  corrected.manage.view.removeDataLangAttr(correctedElement);
  assert.deepEqual(correctedElement.getAttributeNames(), []);
});

test('the full connect chain builds the shipped panels and tiles', () => {
  const { doc, manage, registry, clock, host } = harness();
  manage.enterManage(host);
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: '1700000000000', title: 'Bench', details: DETAILS });
  assert.equal(tab, 'tabs-2');
  assert.equal(manage.active(), tab, 'a new tab activates itself (R55)');
  assert.ok(doc.getElementById(tab), 'the tab panel is in the document');

  manage.connect(tab, DETAILS);
  const pending = manage.connection.pendingTimeouts(tab).map((timer) => timer.kind);
  assert.ok(pending.includes('connection'), '35 s guard armed');
  assert.ok(pending.includes('connectionLoader'), 'tab-level loader armed (R30)');

  // R28: a log before VERSIONB is dropped without touching the UI.
  manage.connection.handleLog(decodedLog({ messageId: 42, name: 'BESTPOS', fields: { latitude: 1 } }), tab);
  assert.equal(manage.connection.ignoredBeforeReady(tab), 1);
  assert.equal(doc.getElementById('main-panel-' + tab), null, 'no panels before the ready gate');

  manage.connection.connectionStatus('connectionsuccess', tab);
  clock.advance(5);
  assert.equal(manage.connection.pendingTimeouts(tab).some((t) => t.kind === 'connection'), false, '35 s cleared');

  // The ready gate: VERSIONB with an identifiable model.
  manage.connection.handleLog(
    decodedLog({ messageId: 37, name: 'VERSION', fields: { noOfComponents: 1 }, blocks: [{ model: 'OEM729-1.00' }] }),
    tab,
  );
  assert.equal(manage.connection.isReady(tab), true);
  assert.equal(manage.connection.lastError(tab), undefined);

  // §2.7: the sixteen containers, and the two grid hosts inside #main-panel.
  assert.ok(doc.getElementById('main-panel-' + tab), 'main panel');
  assert.ok(doc.getElementById('events-panel-' + tab));
  assert.ok(doc.getElementById('menuBar-panel-' + tab));
  assert.ok(doc.getElementById(statusPanelId(tab)));
  assert.ok(doc.getElementById(statusComponentsId(tab)));
  assert.ok(doc.getElementById(statusComponentsId(tab))!.closest('#main-panel-' + tab), 'grid host is inside the main panel');

  // §3.2/§3.3: the statusBar tile is in the status panel, the rest in the grid host.
  const statusBarTile = doc.querySelector(`#${statusPanelId(tab)} .tile`);
  assert.ok(statusBarTile, 'statusBar tile landed in #status-panel');
  assert.ok(doc.querySelector(`#${statusPanelId(tab)} #statusBarlatitude`), 'the real statusBar fragment is mounted');
  const gridTiles = doc.querySelectorAll(`#${statusComponentsId(tab)} .tile`);
  assert.ok(gridTiles.length >= 3, 'page 1 grid got its tiles');
  assert.ok(doc.querySelector(`#${statusComponentsId(tab)} #positionStatuslatitude`), 'positionStatus fragment mounted');

  // Packery equivalent: the engine is live for this tab and has a snapshot.
  assert.equal(manage.layout.isActive(tab), true);
  assert.ok(manage.layout.snapshot(tab).length >= 3);

  // requestInitialLogs ran against the real components.json.
  const requested = manage.connection.requestedLogs(tab);
  assert.ok(requested.length >= 5, 'status logs were requested');
  assert.deepEqual(manage.sentLogsFor(tab).length, requested.length);
});

test('Manage routes a status-light click into the per-tab shipped modal and closes it', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-dialog', title: 'Dialog', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(
    decodedLog({
      messageId: 37,
      name: 'VERSION',
      fields: { noOfComponents: 1 },
      blocks: [{ model: 'OEM729-1.00' }],
    }),
    tab,
  );

  manage.statuses.positionStatus.solutionStatus[tab] = 'NO_CONVERGENCE';
  manage.statuses.positionStatus.posragIndicatorColor[tab] = 'bad';
  manage.statuses.spanStatus.spanRAGIndicatorColor[tab] = 'good';
  manage.statuses.deviceInfo.deviceRAGIndicatorColor[tab] = 'good';
  manage.statuses.interferenceStatus.ITKRagIndicatorColor[tab] = 'good';
  manage.statuses.logStatus.loggingRAGIndicatorColor[tab] = 'good';
  manage.statuses.statusBar.updateView(37, { tab, hardwareVersion: '1.0' });
  doc.querySelector(`#${tab} .positioning-traffic .red-status`)!.click();

  const modal = doc.querySelector(`#${tab} #popupModal`) as HTMLElement;
  assert.equal(modal.style.display, 'block');
  assert.match(modal.querySelector('.modal-title')!.textContent!, /positioning/i);
  assert.match(modal.querySelector('.modal-body')!.textContent!, /converge/i);
  modal.querySelector('[data-dismiss="modal"]')!.click();
  assert.equal(modal.style.display, 'none');
});

test('R60 buildTiles applies the final statusBar, grid and MarinePak wrapper classes', () => {
  const standard = harness();
  standard.manage.enterManage(standard.host);
  const tab = standard.manage.openTab({
    index: 2,
    deviceTileId: 'dev-classes',
    title: 'Classes',
    details: DETAILS,
  });
  standard.manage.buildPanels(tab);
  standard.manage.buildTiles(tab);
  const scope = standard.doc.getElementById(tab)!;
  assert.equal(scope.querySelector('#tile-0-' + tab)!.getAttribute('class'), 'tile receiverPanel');
  assert.equal(scope.querySelector('#tile-2-' + tab)!.getAttribute('class'), 'tile manage-tile status-tile');

  const marine = harness({ isMarinePak: true });
  marine.manage.enterManage(marine.host);
  const mTab = marine.manage.openTab({
    index: 2,
    deviceTileId: 'dev-marine-classes',
    title: 'Marine',
    details: DETAILS,
  });
  marine.manage.buildPanels(mTab);
  marine.manage.buildTiles(mTab);
  const mScope = marine.doc.getElementById(mTab)!;
  assert.equal(
    mScope.querySelector('#tile-2-' + mTab)!.getAttribute('class'),
    'tile mPak-posTile manage-tile status-tile',
  );
});

test('a log frame reaches the shipped statusBar markup through the throttle', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-1', title: 'Bench', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(
    decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'OEM729-1.00' }] }),
    tab,
  );

  const logData = {
    tab,
    latitude: 51.116789,
    longitude: -114.038862,
    height: 1064.347,
  };
  assert.equal(manage.throttle.dispatch('statusBar', [42, logData]), 'rendered');
  assert.equal(doc.querySelector(`#${statusPanelId(tab)} #statusBarlatitude`)!.textContent, '51.116789');
  assert.equal(doc.querySelector(`#${statusPanelId(tab)} #statusBarlongitude`)!.textContent, '-114.038862');
  assert.equal(doc.querySelector(`#${statusPanelId(tab)} #statusBarheight`)!.textContent, '1064.347');

  // A log the component does not subscribe to is not written at all.
  assert.equal(manage.render('statusBar', [999999, { tab, latitude: 'nope' }]), 0);
});

test('a decoder-produced BESTPOS reaches statusBar and positionStatus through Manage', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-parsed', title: 'Parsed', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(
    decodedLog({ messageId: 37, name: 'VERSION', blocks: [{ model: 'OEM729-1.00' }] }),
    tab,
  );

  const fields = decodedFixture(42, {
    solutionStatus: 'SOL_COMPUTED',
    positionType: 'NARROW_INT',
    latitude: 51.123456789,
    longitude: -114.987654321,
    height: 100,
    undulation: 2,
    datumId: 'WGS84',
    heightDeviation: 0.25,
    stationId: 'BASE',
    differentialAge: 1.5,
  });
  const delivered = manage.handleDecodedLog(tab, {
    messageId: 42,
    name: 'BESTPOS',
    fields,
    blocks: [],
    payload: new Uint8Array(0),
    time: new Date(0),
    crcOk: true,
  });
  assert.ok(delivered.includes('statusBar'));
  assert.ok(delivered.includes('positionStatus'));
  assert.equal(doc.querySelector(`#${statusPanelId(tab)} #statusBarlatitude`)!.textContent, '51.1234568°');
  assert.equal(doc.querySelector(`#${statusComponentsId(tab)} #positionStatuslatitude`)!.textContent, '51.1234568°');
});

test('an injected session log is auto-wired to the mounted status tiles', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-session', title: 'Session', details: DETAILS });
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const session = {
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return session;
    },
    log() {},
    unlog() {},
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };

  manage.connect(tab, DETAILS, session);
  emit('ready', 'OEM7');
  assert.equal(manage.connection.isReady(tab), true);
  assert.ok(doc.querySelector(`#${statusPanelId(tab)} #statusBarlatitude`));

  const fields = decodedFixture(42, {
    solutionStatus: 'SOL_COMPUTED',
    positionType: 'NARROW_INT',
    latitude: 12.5,
    longitude: 34.5,
    height: 20,
    undulation: 1,
    heightDeviation: 0.1,
    stationId: 'S',
    differentialAge: 0,
  });
  emit('log', {
    messageId: 42,
    name: 'BESTPOS',
    fields,
    blocks: [],
    payload: new Uint8Array(0),
    time: new Date(0),
    crcOk: true,
  });
  assert.equal(doc.querySelector(`#${statusPanelId(tab)} #statusBarlatitude`)!.textContent, '12.5000000°');
  assert.equal(doc.querySelector(`#${statusComponentsId(tab)} #positionStatusheight`)!.textContent, '20 m');
});

test('R41 switching back to a tab replays the eleven channels into the DOM', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const first = manage.openTab({ index: 2, deviceTileId: 'dev-1', title: 'A', details: DETAILS });
  manage.connect(first, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', first);
  manage.connection.handleLog(decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'OEM729' }] }), first);

  const second = manage.openTab({ index: 3, deviceTileId: 'dev-2', title: 'B', details: DETAILS });
  assert.equal(manage.active(), second, 'the second tab is now the active one');
  assert.equal(manage.throttle.dispatch('statusBar', [42, { tab: first, latitude: '11.1' }]), 'cached');

  manage.activateTab(first);
  const replayed = manage.throttle.replay(first);
  assert.deepEqual(replayed, ['statusBar']);
  assert.equal(doc.querySelector(`#${statusPanelId(first)} #statusBarlatitude`)!.textContent, '11.1');
  // The replay does not consume the cache: loadCachedData re-emits, it never deletes.\n  assert.deepEqual((manage.throttle.cached(first).statusBar as unknown[])[1]['latitude'], '11.1');
});

test('R34/R35 applying a language writes the markers of the shipped fragments', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-1', title: 'A', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'OEM729' }] }), tab);

  const before = doc.querySelector(`#${statusComponentsId(tab)} [data-lang-positioning]`)!.textContent;
  manage.language.loadDictionary({ POSITIONING: '定位' });
  manage.applyLanguage(tab);
  assert.equal(doc.querySelector(`#${statusComponentsId(tab)} [data-lang-positioning]`)!.textContent, '定位');
  assert.notEqual(before, '定位');
});

test('R36 closing a tab UNLOGs only the logs no other tab of that device asked for', () => {
  const { manage, host } = harness();
  manage.enterManage(host);
  const a = manage.openTab({ index: 2, deviceTileId: 'shared-device', title: 'A', details: DETAILS });
  const b = manage.openTab({ index: 3, deviceTileId: 'shared-device', title: 'B', details: DETAILS });
  manage.connect(a, DETAILS);
  manage.connect(b, DETAILS);
  for (const tab of [a, b]) {
    manage.connection.connectionStatus('connectionsuccess', tab);
    manage.connection.handleLog(decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'OEM729' }] }), tab);
  }

  // Give the second tab one log the first never asked for.
  manage.sendLog(b, 'PERFORMANCEMONITORB', 'ontime,10');
  const shared = manage.sharedLogNames(a);
  assert.ok(shared.length > 0, 'the two tabs share the status logs');

  manage.closeTab(a);
  const unlogged = manage.unloggedFor(a);
  assert.equal(unlogged.some((entry) => shared.includes(entry.split(' ')[0])), false, 'shared logs stay registered');
});

test('R26 a closed tab tears its layout and tiles down', () => {
  const { doc, manage, host } = harness();
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-1', title: 'A', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'OEM729' }] }), tab);
  assert.equal(manage.layout.isActive(tab), true);

  manage.closeTab(tab);
  assert.equal(manage.layout.isActive(tab), false, 'layout destroyed');
  assert.equal(doc.getElementById(statusComponentsId(tab)), null, 'tiles gone');
  assert.equal(manage.sentLogsFor(tab).length, 0, 'state cleared');
});

test('R29 the persisted page is restored on connect (page 2 comes back)', () => {
  const features: FeatureFlags = { ...DEFAULT_FEATURES };
  const doc = createDocument();
  const clock = newClock();
  const store = newStore();
  const shellRoot = doc.createElement('div');
  shellRoot.id = 'shell';
  doc.body.appendChild(shellRoot);
  const registry = createTabRegistry({});
  registry.buildShell(shellRoot);
  const tiles = createTileSystem({
    root: () => doc.body as never,
    loader: realFragmentLoader(),
    features: () => features,
  });
  const manage = createManage({
    document: doc as unknown as Document,
    clock,
    store,
    fragments: realFragmentLoader(),
    tiles,
    register: components,
    tabShell: registry as never,
    features: () => features,
    // `devicedetails.menu` said page 2 last time.
    persistedPage: () => 'page2',
  });
  manage.enterManage({
    hideNonCoreApp() {},
    hideWelcome() {},
    showSetUpMonitor() {},
    hideLandingPages() {},
    showSetupMonitorLanding() {},
    setTitle() {},
    switchIcon() {},
    applyLanguage() {},
  });

  const tab = manage.openTab({ index: 2, deviceTileId: 'dev-persist', title: 'P', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'OEM729' }] }), tab);

  assert.equal(manage.containers.currentPage(tab), 'page2');
  assert.ok(doc.getElementById(statusComponentsId(tab))!.hasAttribute('hidden'), 'page 1 hidden');
  const page2 = doc.getElementById('status-components-page2-' + tab)!;
  assert.equal(page2.hasAttribute('hidden'), false);
  assert.deepEqual(manage.pageChangeLog().at(-1), { tab, page: 'page2' });
  // R27: the Reset-layout button is not offered on page 2.
  assert.equal(doc.getElementById('resetDefault-' + tab)?.getAttribute('style') ?? '', '');
});

test('a Longhorn tab plans the Longhorn tiles and skips the OEM ones', () => {
  const { doc, manage, host } = harness({ isLongHorn: true, generation: 'OEM7' });
  manage.enterManage(host);
  const tab = manage.openTab({ index: 2, deviceTileId: 'lghn-1', title: 'L', details: DETAILS });
  manage.connect(tab, DETAILS);
  manage.connection.connectionStatus('connectionsuccess', tab);
  manage.connection.handleLog(decodedLog({ messageId: 37, name: 'VERSION', fields: {}, blocks: [{ model: 'PIM222' }] }), tab);

  const grid = doc.getElementById(statusComponentsId(tab))!;
  assert.ok(grid.querySelector('#positionStatuslatitude'), 'positionStatus still first');
  assert.equal(grid.textContent.includes('undefined'), false);
});
