import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { createDocument, createEvent } from '../src/minidom.ts';
import { createTabRegistry } from '../src/tabs.ts';
import { createTileSystem } from '../src/tiles.ts';
import { createManage, type ManageOptions } from '../src/manage.ts';
import {
  COMMAND_RESPONSE,
  CONFIG_LANGUAGE_PAGE_NAMES,
  CONFIG_PAGE_NAMES,
  LONGHORN_DEFAULT_CONFIG,
  LOGGING_MSG,
  NETWORK_MSG,
  POSITION_MSG,
  SPAN_MSG,
  parseLonghornConfig,
} from '../src/config/index.ts';
import { DEFAULT_FEATURES, type FeatureFlags } from '../src/types.ts';
import { buildBinaryCommand } from '../../protocol/src/command.ts';
import { buildLongHeader } from '../../protocol/src/header.ts';
import { appendCrcLe } from '../../protocol/src/crc.ts';
import {
  decodedFixture,
  englishDictionary,
  evidence,
  newClock,
  newStore,
  realFragmentLoader,
} from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const COMMANDS = JSON.parse(
  readFileSync(join(here, '..', '..', 'protocol', 'data', 'commands.json'), 'utf8'),
) as Record<string, { messageId: number; enums: Record<string, Record<string, number>> }>;
const PORT_NAMES = JSON.parse(
  readFileSync(join(here, '..', '..', 'protocol', 'data', 'portnames.json'), 'utf8'),
) as string[];
const COMPONENTS = JSON.parse(
  readFileSync(join(here, '..', '..', 'protocol', 'data', 'components.json'), 'utf8'),
);

interface ShippedConstants {
  commandsAndEnums: typeof COMMANDS;
  messageIdConstants: Record<string, number>;
  correctionLogsIds: Record<string, number[]>;
}

function shippedConstants(): ShippedConstants {
  const sandbox: { NovatelIdConstants: ShippedConstants; console: Console } = {
    NovatelIdConstants: {} as ShippedConstants,
    console,
  };
  runInNewContext(evidence('model', 'NovatelIdConstants.js'), sandbox, { timeout: 3000 });
  return sandbox.NovatelIdConstants;
}

const SHIPPED = shippedConstants();
for (const entry of Object.values(SHIPPED.commandsAndEnums)) {
  const record = entry as unknown as Record<string, unknown>;
  record.enums = Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => key !== 'messageId' && value && typeof value === 'object',
    ),
  );
}
const ENGLISH = englishDictionary();

interface Capture {
  binary: Array<{ tab: string; bytes: Uint8Array }>;
  raw: Array<{ tab: string; text: string }>;
  ascii: Array<{ tab: string; text: string }>;
}

interface ConfigHarness {
  doc: ReturnType<typeof createDocument>;
  clock: ReturnType<typeof newClock>;
  store: ReturnType<typeof newStore>;
  manage: ReturnType<typeof createManage>;
  tab: string;
  capture: Capture;
  features: FeatureFlags;
}

function features(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    ...DEFAULT_FEATURES,
    model: 'OEM729',
    alignSupported: true,
    spanSupported: true,
    radioTxSupported: true,
    dualAntennaSupported: true,
    spoofingSupported: true,
    loggingComponent: true,
    fileSupported: true,
    positionModes: ['RTK', 'PPP', 'SBAS'],
    ...overrides,
  };
}

function configHarness(
  overrides: Partial<FeatureFlags> = {},
  manageOverrides: Partial<ManageOptions> = {},
): ConfigHarness {
  const activeFeatures = features(overrides);
  const doc = createDocument();
  const clock = newClock();
  const store = newStore();
  const shell = doc.createElement('div');
  shell.id = 'shell';
  doc.body.appendChild(shell);
  const registry = createTabRegistry({});
  registry.buildShell(shell);
  const tiles = createTileSystem({
    root: () => doc.body as never,
    loader: realFragmentLoader(),
    features: () => activeFeatures,
  });
  const capture: Capture = { binary: [], raw: [], ascii: [] };
  const manage = createManage({
    document: doc as unknown as Document,
    clock,
    store,
    fragments: realFragmentLoader(),
    tiles,
    register: COMPONENTS,
    tabShell: registry as never,
    features: () => activeFeatures,
    commands: COMMANDS,
    portNames: PORT_NAMES,
    translate: (key) => ENGLISH[key] ?? key,
    configTransport: {
      sendBinary(tab, bytes) {
        capture.binary.push({ tab, bytes });
      },
      sendRaw(tab, text) {
        capture.raw.push({ tab, text });
      },
      sendAsciiFrame(tab, text) {
        capture.ascii.push({ tab, text });
      },
    },
    connectedPortName: () => 'COM2',
    viewportHeight: 900,
    scheduleConfigResets: false,
    ...manageOverrides,
  });
  const tab = manage.openTab({
    index: 2,
    deviceTileId: 'device-config',
    title: 'Config',
    details: { type: 'eth' },
  });
  manage.buildPanels(tab);
  return { doc, clock, store, manage, tab, capture, features: activeFeatures };
}

function header(bytes: Uint8Array): { msgId: number; payload: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint16(8, true);
  return { msgId: view.getUint16(4, true), payload: bytes.slice(28, 28 + length) };
}

function param(
  value: string | number,
  type: Parameters<typeof buildBinaryCommand>[0]['params'][number]['type'],
  length: number,
) {
  return { value, type, length };
}

function commandResponsePayload(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
}

function commandResponseFrame(messageId: number, text: string) {
  const payload = commandResponsePayload(text);
  const header = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    messageType: 1,
    portAddress: 222,
  });
  const raw = new Uint8Array(header.length + payload.length);
  raw.set(header, 0);
  raw.set(payload, header.length);
  const bytes = appendCrcLe(raw);
  return {
    header: { kind: 'long', headerLength: 28, messageId, messageTypeByte: 1 },
    payload,
    bytes,
  };
}

test('the bundle exposes fourteen page implementations and mounts all eight standard shipped fragments', () => {
  const h = configHarness({ isMarinePak: true });
  assert.deepEqual(h.manage.configs.pageNames(), [...CONFIG_PAGE_NAMES]);
  assert.equal(CONFIG_PAGE_NAMES.length, 14);
  assert.equal(h.manage.statusConfigClick('menuConfig', h.tab), true);
  const mounted = h.manage.mountedConfigPages(h.tab);
  assert.deepEqual(mounted, [
    'positionConfig',
    'portConfig',
    'loggingConfig',
    'alignConfig',
    'spanConfig',
    'radioConfig',
    'gnssConfig',
    'spoofingConfiguration',
  ]);
  const root = h.doc.getElementById(h.tab)!;
  assert.ok(root.querySelector('#positionConfiguration'));
  assert.ok(root.querySelector('#portConfiguration'));
  assert.ok(root.querySelector('#loggingConfiguration'));
  assert.ok(root.querySelector('#alignConfiguration'));
  assert.ok(root.querySelector('#spanConfiguration'));
  assert.ok(root.querySelector('#radioConfiguration'));
  assert.ok(root.querySelector('#gnssConfiguration'));
  assert.ok(root.querySelector('#stageOneView'));
  const requested = h.manage.sentLogsFor(h.tab).map((entry) => entry.split(' ')[0]);
  assert.ok(requested.includes('INTERFACEMODE'));
  assert.ok(requested.includes('FILESTATUS'));
  assert.ok(requested.includes('SATELSTATUS'));
});

test('GIII mounts the shipped giii logging fragment, dismisses the notice and routes restart', () => {
  let restarts = 0;
  const h = configHarness(
    { isGIII: true, generation: 'GIII', positionModes: ['NONE'] },
    {
      restartReceiver: (tab, kind) => {
        assert.equal(tab, 'tabs-2');
        assert.equal(kind, 'giii');
        restarts += 1;
      },
    },
  );
  h.manage.statusConfigClick('menuConfig', h.tab);
  assert.deepEqual(h.manage.mountedConfigPages(h.tab), ['giiiLoggingConfig']);
  const root = h.doc.getElementById(h.tab)!;
  assert.ok(root.querySelector('#giii-loggingConfiguration'));
  assert.equal(root.querySelectorAll('#config-tabs').length, 0);
  (root.querySelector('#giii-loggingDismiss-btn') as HTMLElement).click();
  assert.equal(
    (root.querySelector('.giii-logging-restart-container') as HTMLElement).style.display,
    'none',
  );
  (root.querySelector('#giii-loggingRestart-btn') as HTMLElement).click();
  assert.equal(restarts, 1);
});

test('Longhorn switches Positioning/Logging and mounts each shipped lghn fragment', () => {
  const h = configHarness({ isLongHorn: true, generation: 'OEM7' });
  h.manage.statusConfigClick('menuConfig', h.tab);
  const root = h.doc.getElementById(h.tab)!;
  assert.ok(root.querySelector('#lghn-posconfig-mainlist'));
  assert.equal(h.manage.selectConfigPage(h.tab, 'logging'), true);
  assert.ok(h.manage.mountedConfigPages(h.tab).includes('lghnLoggingConfig'));
  assert.ok(root.querySelector('#logging-switch'));
  assert.equal((root.querySelector(`#config-log-${h.tab}`) as HTMLElement).style.display, 'block');
  assert.equal((root.querySelector(`#config-pos-${h.tab}`) as HTMLElement).style.display, 'none');
  assert.equal(h.manage.selectConfigPage(h.tab, 'positioning'), true);
  assert.equal((root.querySelector(`#config-pos-${h.tab}`) as HTMLElement).style.display, 'block');
});

test('the settings pages mount the real networking/general/language/spanInstallation fragments', () => {
  const h = configHarness();
  const root = h.doc.getElementById(h.tab)!;
  const append = (id: string) => {
    const node = h.doc.createElement('div');
    node.id = id;
    root.appendChild(node);
    return node;
  };
  append(`networkingSettings-layout_${h.tab}`);
  append(`generalSettings-layout_${h.tab}`);
  append(`languageSettings-layout_${h.tab}`);
  append(`spanInstallation-component-${h.tab}`);
  assert.equal(h.manage.configs.networking.mount(h.tab), true);
  assert.equal(h.manage.configs.general.mount(h.tab), true);
  assert.equal(h.manage.configs.language.mount(h.tab), true);
  assert.equal(h.manage.configs.spanInstallation.mount(h.tab), true);
  assert.ok(root.querySelector('#networking-details'));
  assert.ok(root.querySelector('#general-settings'));
  assert.ok(root.querySelector('#language-settings'));
  assert.ok(root.querySelector('#spanInstallation'));
});

test('all fourteen pages expose default/current/pending dictionaries and discard restores baseline', () => {
  const h = configHarness();
  for (const name of CONFIG_PAGE_NAMES) {
    const page = h.manage.configs.page(name);
    assert.ok(page, name);
    const state = (page as unknown as {
      state: {
        setPending(tab: string, id: number, key: string, value: unknown, baseline: unknown): void;
        updateCurrent(tab: string, id: number, value: unknown): void;
      };
      commit(tab: string): void;
    }).state;
    state.updateCurrent(h.tab, 999, { tab: h.tab, value: 1 });
    page.reset(h.tab);
    state.setPending(h.tab, 999, 'value', 2, 1);
    assert.equal(page.isDirty(h.tab), true, `${name} tracks a pending value`);
    assert.deepEqual(page.changedData(h.tab)['999'], { value: 2 });
    page.discard(h.tab);
    assert.equal(page.isDirty(h.tab), false);
    assert.deepEqual(page.currentData(h.tab)['999'], { tab: h.tab, value: 1 });
  }
});

test('R4 namespaces only the shipped position/span/align/logging ids that collide across tabs', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const root = h.doc.getElementById(h.tab)!;
  assert.ok(root.querySelector(`#collapseinputsource-${h.tab}`), 'the mounted panel is suffixed');
  assert.ok(root.querySelector(`#collapsepriAntenna-${h.tab}`));
  const label = root.querySelector(`#config-span-${h.tab} .toggle-switch label[for]`);
  assert.ok(label);
  assert.match(label.getAttribute('for') ?? '', new RegExp(`-${h.tab}$`));
});

test('GNSS sends the shipped ELEVATIONCUTOFF and PPSCONTROL payloads in id order', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.gnss;
  page.updateData(1735, { tab: h.tab, constellation: 'ALL', angle: 10, reserved: 0 });
  page.updateData(613, { tab: h.tab, switch: 'ENABLE', polarity: 'POSITIVE', period: 1, pulsewidth: 1000 });
  page.reset(h.tab);
  page.setElevation(h.tab, 15.5);
  page.setPps(h.tab, 'switch', 'DISABLE');
  page.apply(h.tab);

  assert.equal(h.capture.binary.length, 2);
  const elevation = header(h.capture.binary[0].bytes);
  const pps = header(h.capture.binary[1].bytes);
  assert.equal(elevation.msgId, SHIPPED.commandsAndEnums.elevationcutoff.messageId);
  assert.equal(pps.msgId, SHIPPED.commandsAndEnums.ppscontrol.messageId);
  let view = new DataView(elevation.payload.buffer, elevation.payload.byteOffset, elevation.payload.byteLength);
  assert.equal(view.getUint32(0, true), SHIPPED.commandsAndEnums.elevationcutoff.enums.constellation.ALL);
  assert.equal(view.getFloat32(4, true), 15.5);
  assert.equal(view.getUint32(8, true), 0);
  view = new DataView(pps.payload.buffer, pps.payload.byteOffset, pps.payload.byteLength);
  assert.equal(view.getUint32(0, true), SHIPPED.commandsAndEnums.ppscontrol.enums.switch.DISABLE);
  assert.equal(view.getUint32(4, true), SHIPPED.commandsAndEnums.ppscontrol.enums.polarity.POSITIVE);
  assert.equal(view.getFloat64(8, true), 1);
  assert.equal(view.getUint32(16, true), 1000);
});

test('the shipped GNSS Apply and Cancel buttons drive the same page state as the public API', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.gnss;
  page.updateData(1735, { tab: h.tab, angle: 10 });
  page.reset(h.tab);
  page.setElevation(h.tab, 17);
  (h.doc.querySelector(`#${h.tab} #gnssConfigApply`) as HTMLElement).click();
  assert.equal(h.capture.binary.length, 1);
  assert.equal(header(h.capture.binary[0].bytes).msgId, SHIPPED.commandsAndEnums.elevationcutoff.messageId);

  h.capture.binary.length = 0;
  page.setElevation(h.tab, 18);
  (h.doc.querySelector(`#${h.tab} #gnssConfigCancel`) as HTMLElement).click();
  const modal = h.doc.querySelector(`#${h.tab} #popupModal`) as HTMLElement;
  assert.equal(modal.style.display, 'block');
  modal.querySelectorAll('.modal-footer button')[0].click();
  assert.equal(page.isDirty(h.tab), false);
  assert.equal(h.capture.binary.length, 0);
});

test('the command coordinator keeps UNKNOWN incomplete and reaches ERROR through the real response path', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.gnss;
  page.updateData(1735, { tab: h.tab, angle: 10 });
  page.updateData(613, { tab: h.tab, switch: 'ENABLE', polarity: 'POSITIVE' });
  page.reset(h.tab);
  page.setElevation(h.tab, 20);
  page.setPps(h.tab, 'polarity', 'NEGATIVE');
  page.apply(h.tab);

  h.manage.handleCommandResponse(h.tab, 1735, COMMAND_RESPONSE.UNKNOWN);
  h.manage.handleCommandResponse(h.tab, 613, COMMAND_RESPONSE.OK);
  assert.equal(h.manage.configs.commands.pendingFeatures().length, 2);

  h.manage.handleCommandResponse(h.tab, 1735, COMMAND_RESPONSE.OK);
  assert.equal(h.manage.configs.commands.pendingFeatures().length, 2, 'UNKNOWN remains in the response vector');
  h.manage.configs.commands.removeFeature('gnssConfig');
  page.apply(h.tab);
  h.manage.handleCommandResponse(h.tab, 1735, COMMAND_RESPONSE.OK);
  h.manage.handleCommandResponse(h.tab, 613, COMMAND_RESPONSE.OK);
  assert.equal(h.manage.configs.commands.pendingFeatures().length, 0);
  h.clock.advance(2000);

  page.setElevation(h.tab, 25);
  page.apply(h.tab);
  const completions = h.manage.configs.handleResponse(1735, COMMAND_RESPONSE.ERROR, h.tab, '4e4f');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].response, COMMAND_RESPONSE.ERROR);
  assert.equal(h.manage.configs.commands.pendingFeatures().length, 0);
});

test('a real binary response frame decodes OK/ERROR and dispatches completed feature callbacks', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.gnss;
  page.updateData(1735, { tab: h.tab, angle: 10 });
  page.reset(h.tab);
  page.setElevation(h.tab, 11);
  page.apply(h.tab);

  const ok = commandResponseFrame(1735, 'OK');
  assert.equal(h.manage.handleCommandResponseFrame(h.tab, ok), COMMAND_RESPONSE.OK);
  h.clock.advance(2000);
  assert.equal(page.isDirty(h.tab), false);
  assert.equal(page.currentData(h.tab)['1735'].angle, 11);

  page.setElevation(h.tab, 12);
  page.apply(h.tab);
  const error = commandResponseFrame(1735, 'ERROR:Message is invalid');
  assert.equal(h.manage.handleCommandResponseFrame(h.tab, error), COMMAND_RESPONSE.ERROR);
  h.clock.advance(2000);
  assert.equal(page.isDirty(h.tab), true, 'an ERROR leaves the pending value for correction');
});

test('an injected session response event reaches the configuration coordinator end to end', () => {
  const h = configHarness();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const session = {
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return session;
    },
    sendBytes() {},
    sendRaw() {},
    sendAscii() {},
  };
  h.manage.connect(h.tab, { type: 'eth' }, session);
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.gnss;
  page.updateData(1735, { tab: h.tab, angle: 10 });
  page.reset(h.tab);
  page.setElevation(h.tab, 14);
  page.apply(h.tab);
  for (const listener of listeners.get('response') ?? []) {
    listener(commandResponseFrame(1735, 'OK'));
  }
  assert.equal(h.manage.configs.commands.pendingFeatures().length, 0);
  h.clock.advance(2000);
  assert.equal(page.isDirty(h.tab), false);
});

test('ALIGN uses posrate=1 and the three shipped hard-coded automation values', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.align;
  page.updateData(1761, { tab: h.tab, switch: 'DISABLE', obsrate: 10 });
  page.updateData(1082, { tab: h.tab, headingoffsetindeg: 0, pitchoffsetindeg: 0 });
  page.updateData(2214, { tab: h.tab, option: 'DISABLE', datarate: 1 });
  page.updateData(1323, { tab: h.tab, option: 'DISABLE', datarate: 10 });
  page.reset(h.tab);
  page.setChanged(h.tab, 1761, 'switch', 'ENABLE');
  page.setChanged(h.tab, 1082, 'headingoffsetindeg', 1.25);
  page.setChanged(h.tab, 2214, 'option', 'ENABLE');
  page.setChanged(h.tab, 1323, 'option', 'ENABLE');
  page.apply(h.tab);

  assert.equal(h.capture.binary.length, 4);
  assert.deepEqual(
    h.capture.binary.map((entry) => header(entry.bytes).msgId),
    [
      SHIPPED.commandsAndEnums.dualantennaalign.messageId,
      SHIPPED.commandsAndEnums.headingoffset.messageId,
      SHIPPED.commandsAndEnums.wifialignautomation.messageId,
      SHIPPED.commandsAndEnums.alignautomation.messageId,
    ],
  );
  const dual = header(h.capture.binary[0].bytes).payload;
  const dualView = new DataView(dual.buffer, dual.byteOffset, dual.byteLength);
  assert.equal(dualView.getUint32(8, true), 1);
  const wifi = header(h.capture.binary[2].bytes).payload;
  const wifiView = new DataView(wifi.buffer, wifi.byteOffset, wifi.byteLength);
  assert.equal(wifiView.getUint32(4, true), 1);
  assert.equal(wifiView.getUint32(8, true), SHIPPED.commandsAndEnums.wifialignautomation.enums.rover_icom.ICOM1);
  assert.equal(wifiView.getUint32(16, true), SHIPPED.commandsAndEnums.wifialignautomation.enums.headingextboption.ON);
  assert.equal(wifiView.getUint32(20, true), SHIPPED.commandsAndEnums.wifialignautomation.enums.interfacemode.NOVATELX);
});

test('R24/R25 port data waits in 1 s polls and sends the CRC-framed send abcd probe', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.ports;
  page.updateData(3, { tab: h.tab, port: 'COM2', rxType: 'NOVATEL', txType: 'NOVATEL' });
  page.updateData(5, { tab: h.tab, noOfLogs: 0 });
  page.checkAndUpdatePortConfigDefaultData(h.tab);
  assert.equal(page.isPortConfigDataAvailable(h.tab), false);
  assert.equal(h.capture.ascii.at(-1)?.text, 'send abcd');
  page.updateData(1246, { tab: h.tab, data: [{ port: 'COM2', baud: 115200 }] });
  h.clock.advance(1000);
  assert.equal(page.isPortConfigDataAvailable(h.tab), false);
  page.updateData(1344, { tab: h.tab, endPoint: '', entryData: '' });
  h.clock.advance(1000);
  assert.equal(page.isPortConfigDataAvailable(h.tab), true);
  assert.equal((h.doc.querySelector(`#${h.tab} #connection-loader`) as HTMLElement).style.display, 'none');
});

test('R27 a format change on an existing PORT message emits UNLOG before LOG', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.ports;
  page.updateData(5, {
    tab: h.tab,
    COM2: { BESTPOS: { messageID: 42, format: 'Binary' } },
  });
  page.reset(h.tab);
  page.setLog(h.tab, 'COM2', 'BESTPOS', {
    messageID: 42,
    format: 'ASCII',
    trigger: 'ONTIME',
    period: 1,
  });
  page.apply(h.tab);
  assert.equal(h.capture.binary.length, 2);
  assert.equal(header(h.capture.binary[0].bytes).msgId, SHIPPED.commandsAndEnums.unlog.messageId);
  assert.equal(header(h.capture.binary[1].bytes).msgId, SHIPPED.commandsAndEnums.log.messageId);
  const unlog = header(h.capture.binary[0].bytes).payload;
  const log = header(h.capture.binary[1].bytes).payload;
  assert.equal(new DataView(unlog.buffer, unlog.byteOffset).getUint8(6), 0);
  assert.equal(new DataView(log.buffer, log.byteOffset).getUint8(6), 32);
});

test('R28 rejects an NCOM protocol change without domain, port and mount point', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.ports;
  page.updateData(3, { tab: h.tab, port: 'NCOM1', rxType: 'NOVATEL', txType: 'NOVATEL' });
  page.updateData(5, { tab: h.tab, noOfLogs: 0 });
  page.updateData(1246, { tab: h.tab, data: [] });
  page.updateData(1248, { tab: h.tab, port: 'NCOM1', protocol: 'TCP', endpoint: '' });
  page.updateData(1249, { tab: h.tab, port: 'NCOM1', endpoint: '' });
  page.updateData(1344, { tab: h.tab, endPoint: '' });
  page.reset(h.tab);
  page.setInterface(h.tab, 'NCOM1', { rxType: 'AUTO', txType: 'NOVATEL' });
  assert.equal(page.applyButtonCheck(h.tab), false);
  assert.equal(page.apply(h.tab), undefined);
  assert.equal(h.capture.binary.length, 0);
});

test('R26 changing the connected port to NONE/NONE discards replies and raises the loader budget to 20 s', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.ports;
  page.updateData(3, {
    tab: h.tab,
    port: 'COM2',
    rxType: 'NOVATEL',
    txType: 'NOVATEL',
  });
  page.updateData(5, { tab: h.tab, noOfLogs: 0 });
  page.updateData(1246, { tab: h.tab, data: [] });
  page.updateData(1344, { tab: h.tab, endPoint: '' });
  page.reset(h.tab);
  page.setConnectedPortAddress('#SENDR,COM2_30,0,0,0;', h.tab);
  page.setInterface(h.tab, 'COM2', { rxType: 'NONE', txType: 'NONE' });
  page.apply(h.tab);
  assert.equal(page.connectedComPort.get(h.tab)?.discardResponse, true);
  assert.equal(h.manage.applyingBudgetFor(h.tab), 20000);
  page.handlePortConfigCommandResponse(2, h.tab);
  assert.equal(h.manage.configs.commands.pendingFeatures().length, 1, 'the response is discarded');
});

test('R23 SAVECONFIG replies never enter a feature response vector', () => {
  const h = configHarness();
  const commands = h.manage.configs.commands;
  commands.setCurrentFeature('probe');
  commands.place('probe', 'saveconfig', [], h.tab);
  assert.deepEqual(commands.responses('probe', SHIPPED.commandsAndEnums.saveconfig.messageId), []);
  assert.deepEqual(commands.handleResponse(19, COMMAND_RESPONSE.OK, h.tab), []);
  assert.deepEqual(commands.responses('probe', 19), []);
});

test('R29 derives NTRIP SERVER/CLIENT and protocol V2 from the changed formats and credentials', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.ports;
  page.updateData(3, { tab: h.tab, port: 'NCOM1', rxType: 'NOVATEL', txType: 'NOVATEL' });
  page.updateData(1249, {
    tab: h.tab,
    port: 'NCOM1',
    endpoint: 'caster',
    ntripport: '2101',
    mountpoint: 'BASE',
    username: 'u',
    password: 'p',
  });
  page.updateData(5, { tab: h.tab, noOfLogs: 0 });
  page.updateData(1246, { tab: h.tab, data: [] });
  page.updateData(1248, { tab: h.tab, port: 'NCOM1' });
  page.reset(h.tab);
  page.setInterface(h.tab, 'NCOM1', { rxType: 'RTCMV3', txType: 'RTCMV3' });
  page.apply(h.tab);
  const ntrip = h.capture.binary
    .map((entry) => header(entry.bytes))
    .find((entry) => entry.msgId === SHIPPED.commandsAndEnums.ntripconfig.messageId);
  assert.ok(ntrip);
  const view = new DataView(ntrip.payload.buffer, ntrip.payload.byteOffset);
  assert.equal(view.getUint32(4, true), SHIPPED.commandsAndEnums.ntripconfig.enums.type.SERVER);
  assert.equal(view.getUint32(8, true), SHIPPED.commandsAndEnums.ntripconfig.enums.protocol.V2);
});

test('R30/R31 position validation uses generation bounds and ±90/±360/manual height limits', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.positions;
  page.updateData(42, { tab: h.tab, operatingMode: 'Transmit' });
  page.reset(h.tab);
  page.setSurvey(h.tab, { surveyType: 'survey-auto', surveyTime: 0.5, accuracy: 101 });
  assert.equal(page.apply(h.tab), undefined);
  page.setSurvey(h.tab, { surveyTime: 1, accuracy: 0 });
  assert.notEqual(page.apply(h.tab), 2);
  page.setSurvey(h.tab, {
    surveyType: 'survey-manual',
    latitude: 90.0001,
    longitude: 0,
    height: 0,
  });
  assert.equal(page.apply(h.tab), undefined);
  page.setSurvey(h.tab, { latitude: 90, longitude: -360, height: -1000 });
  assert.notEqual(page.apply(h.tab), 2);
});

test('R32 Transmit↔Receive opens the confirmation and sends nothing until YES', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.positions;
  page.updateData(42, { tab: h.tab, operatingMode: 'Receive' });
  page.reset(h.tab);
  page.setMode(h.tab, 'Transmit');
  assert.equal(page.onApplyButtonClick(h.tab), false);
  const modal = h.doc.querySelector(`#${h.tab} #popupModal`) as HTMLElement;
  assert.equal(modal.style.display, 'block');
  assert.equal(h.capture.binary.length, 0);
  const buttons = modal.querySelectorAll('.modal-footer button');
  assert.ok(buttons.length >= 2);
  buttons[0].click();
  assert.ok(h.capture.binary.length > 0);
});

test('R33/R34 RTCMV3-MSM becomes RTCMV3 and uses the selected MSM log table', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.positions;
  page.updateData(42, { tab: h.tab, operatingMode: 'Standalone' });
  page.reset(h.tab);
  page.setMode(h.tab, 'Transmit');
  page.setSurvey(h.tab, {
    correctionType: 'RTCMV3-MSM',
    msmCorrectionType: 'MSM4',
    selectedPorts: ['COM2'],
  });
  page.apply(h.tab);
  const parsed = h.capture.binary.map((entry) => header(entry.bytes));
  const interfaceMode = parsed.find(
    (entry) => entry.msgId === SHIPPED.commandsAndEnums.interfacemode.messageId,
  );
  assert.ok(interfaceMode);
  const ifView = new DataView(
    interfaceMode.payload.buffer,
    interfaceMode.payload.byteOffset,
    interfaceMode.payload.byteLength,
  );
  assert.equal(
    ifView.getUint32(8, true),
    SHIPPED.commandsAndEnums.interfacemode.enums.txtype.RTCMV3,
  );
  const logs = parsed
    .filter((entry) => entry.msgId === SHIPPED.commandsAndEnums.log.messageId)
    .map((entry) => new DataView(entry.payload.buffer, entry.payload.byteOffset).getUint16(4, true));
  assert.deepEqual(logs, [...SHIPPED.correctionLogsIds.MSM4]);
  assert.equal(page.correctionLogIds('MSM4').length, logs.length);
});

test('R35 FILE uses fileconfig on OEM7 and logfile on OEM6 with their opposite OPEN values', () => {
  const oem7 = configHarness();
  oem7.manage.statusConfigClick('menuConfig', oem7.tab);
  const p7 = oem7.manage.configs.positions;
  p7.updateData(42, { tab: oem7.tab, operatingMode: 'Standalone' });
  p7.reset(oem7.tab);
  p7.setMode(oem7.tab, 'Transmit');
  p7.setSurvey(oem7.tab, { selectedPorts: ['FILE'] });
  p7.apply(oem7.tab);
  const file7 = oem7.capture.binary
    .map((entry) => header(entry.bytes))
    .filter((entry) => entry.msgId === SHIPPED.commandsAndEnums.fileconfig.messageId)
    .at(-1);
  assert.ok(file7);
  assert.equal(
    new DataView(file7.payload.buffer, file7.payload.byteOffset).getUint32(0, true),
    SHIPPED.commandsAndEnums.fileconfig.enums.fileOperation.OPEN,
  );

  const oem6 = configHarness({ generation: 'OEM6' });
  oem6.manage.statusConfigClick('menuConfig', oem6.tab);
  const p6 = oem6.manage.configs.positions;
  p6.updateData(42, { tab: oem6.tab, operatingMode: 'Standalone' });
  p6.reset(oem6.tab);
  p6.setMode(oem6.tab, 'Transmit');
  p6.setSurvey(oem6.tab, { selectedPorts: ['FILE'] });
  p6.apply(oem6.tab);
  const file6 = oem6.capture.binary
    .map((entry) => header(entry.bytes))
    .filter((entry) => entry.msgId === SHIPPED.commandsAndEnums.logfile.messageId)
    .at(-1);
  assert.ok(file6);
  assert.equal(
    new DataView(file6.payload.buffer, file6.payload.byteOffset).getUint32(0, true),
    SHIPPED.commandsAndEnums.logfile.enums.fileOperation.OPEN,
  );
});

test('R36/R37 SPAN sends IMU events before connect and fans translation to ANT1, ANT2 and USER', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.span;
  page.setPage(h.tab, {
    imuType: 'BOSCH_SMI130',
    imuPort: 'SPI',
    insPosition: 'ant1',
    dualAntenna: true,
    hardwareVersion: 'OEM7500',
  });
  page.setConnectImu(h.tab, {
    IMUType: '(7500 EVK) Bosch SMI130',
    IMUPort: 'SPI',
  });
  page.apply(h.tab);
  const ids = h.capture.binary.map((entry) => header(entry.bytes).msgId);
  const eventId = SHIPPED.commandsAndEnums.setimuevent.messageId;
  const connectId = SHIPPED.commandsAndEnums.connectimu.messageId;
  assert.deepEqual(ids.slice(0, 5), [eventId, eventId, connectId, SHIPPED.commandsAndEnums.inscommand.messageId, SHIPPED.commandsAndEnums.setinstranslation.messageId]);
  assert.deepEqual(h.capture.raw.map((entry) => entry.text), [
    'SPICONTROL IMU CS2\n',
    'SPICONTROL IMU2 CS1\n',
  ]);
  const translations = ids.filter((id) => id === SHIPPED.commandsAndEnums.setinstranslation.messageId);
  assert.equal(translations.length, 3, 'ANT1 + ANT2 + USER when dual antenna and ant1 is selected');
});

test('R38/R39 logging uses FILE on board and hard-codes FILEROTATECONFIG maxFileSize=4096', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.logging;
  page.selectStorage(h.tab, 'Onboard');
  page.setFileRotation(h.tab, { maxFileTime: 30, diskFullAction: 'OVERWRITE' });
  page.setLog(h.tab, 'BESTPOS', {
    messageID: 42,
    format: 'Binary',
    trigger: 'ONTIME',
    period: 1,
  });
  page.apply(h.tab);
  const parsed = h.capture.binary.map((entry) => header(entry.bytes));
  assert.deepEqual(
    parsed.slice(0, 3).map((entry) => entry.msgId),
    [
      SHIPPED.commandsAndEnums.fileconfig.messageId,
      SHIPPED.commandsAndEnums.filerotateconfig.messageId,
      SHIPPED.commandsAndEnums.log.messageId,
    ],
  );
  const rotation = parsed[1].payload;
  const view = new DataView(rotation.buffer, rotation.byteOffset);
  assert.equal(view.getUint16(0, true), 30);
  assert.equal(view.getUint16(2, true), 4096);
  const log = parsed[2].payload;
  assert.equal(new DataView(log.buffer, log.byteOffset).getUint32(0, true), 224);
});

test('R40 stopping the last onboard log closes FILECONFIG before releasing component logs', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.logging;
  page.selectStorage(h.tab, 'Onboard');
  page.updateData(5, { tab: h.tab, BESTPOS: { messageID: 42, format: 'Binary' } });
  page.stopLog(h.tab, 'BESTPOS', 'Binary', 1);
  const ids = h.capture.binary.map((entry) => header(entry.bytes).msgId);
  assert.deepEqual(ids, [
    SHIPPED.commandsAndEnums.unlog.messageId,
    SHIPPED.commandsAndEnums.fileconfig.messageId,
  ]);
  const close = header(h.capture.binary[1].bytes).payload;
  assert.equal(
    new DataView(close.buffer, close.byteOffset).getUint32(0, true),
    SHIPPED.commandsAndEnums.fileconfig.enums.fileOperation.CLOSE,
  );
});

test('radio detection tries COM2/COM3/COM1, logs on READY and applies SATEL4 frequency in Hz', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.radio;
  page.detectRadio(h.tab);
  assert.equal(header(h.capture.binary[0].bytes).msgId, SHIPPED.commandsAndEnums.sateldetect.messageId);
  page.updateData(2205, { tab: h.tab, state: 'BUSY' });
  h.clock.advance(20_000);
  const detectIds = h.capture.binary
    .map((entry) => header(entry.bytes))
    .filter((entry) => entry.msgId === SHIPPED.commandsAndEnums.sateldetect.messageId);
  assert.ok(detectIds.length >= 2);
  page.updateData(2205, { tab: h.tab, state: 'READY' });
  h.clock.advance(1000);
  assert.ok(
    h.capture.binary.some(
      (entry) => header(entry.bytes).msgId === SHIPPED.commandsAndEnums.satelstartupdetect.messageId,
    ),
  );

  page.updateData(37, {
    tab: h.tab,
    RADIO: { type: 'RADIO', model: 'EASy' },
  });
  page.reset(h.tab);
  page.setSatel4(h.tab, { frequencyMHz: 410.125, compatibilityMode: 7, txPower: 10 });
  page.apply(h.tab);
  const satel4 = h.capture.binary
    .map((entry) => header(entry.bytes))
    .find((entry) => entry.msgId === SHIPPED.commandsAndEnums.satel4config.messageId);
  assert.ok(satel4);
  const view = new DataView(satel4.payload.buffer, satel4.payload.byteOffset);
  assert.equal(view.getUint32(8, true), 410_125_000);
  assert.equal(view.getUint32(16, true), SHIPPED.commandsAndEnums.satel4config.enums.baseType.TRIMBLE);
});

test('networking emits IPCONFIG/SAVEETHERNETDATA, DNS+save, and the hotspot mode formula', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.networking;
  page.updateData(1243, { tab: h.tab, mode: 'STATIC', ipAddress: '10.0.0.2', netmask: '255.255.255.0', gateway: '10.0.0.1' });
  page.updateData(1244, { tab: h.tab, ipAddress: '8.8.8.8' });
  page.updateData(2144, { tab: h.tab, mode: 'CLIENT' });
  page.reset(h.tab);
  page.setEthernet(h.tab, 'mode', 'DHCP');
  page.setDns(h.tab, '1.1.1.1');
  page.setHotspot(h.tab, 'mode', 'ON');
  page.apply(h.tab);
  const ids = h.capture.binary.map((entry) => header(entry.bytes).msgId);
  assert.deepEqual(ids, [
    SHIPPED.commandsAndEnums.ipConfig.messageId,
    SHIPPED.commandsAndEnums.saveethernetdata.messageId,
    SHIPPED.commandsAndEnums.dnsConfig.messageId,
    SHIPPED.commandsAndEnums.saveethernetdata.messageId,
    SHIPPED.commandsAndEnums.wifimode.messageId,
  ]);
  const ip = header(h.capture.binary[0].bytes).payload;
  const ipView = new DataView(ip.buffer, ip.byteOffset);
  assert.equal(ipView.getUint32(4, true), SHIPPED.commandsAndEnums.ipConfig.enums.mode.DHCP);
  assert.equal(ip[8], 0, 'DHCP clears ipAddress before dispatch');
  assert.equal(
    new DataView(header(h.capture.binary.at(-1)!.bytes).payload.buffer).getUint32(0, true),
    SHIPPED.commandsAndEnums.wifimode.enums.mode.CONCURRENT,
  );
});

test('general, language and spanInstallation apply only to userStore', () => {
  const h = configHarness();
  let language = '';
  const general = h.manage.configs.general;
  general.setHeightUnit(h.tab, 'Ellipsoidal');
  general.apply(h.tab);
  assert.equal(h.store.getData(['app', 'heightUnits', 'device-config']), 'Ellipsoidal');

  const languagePage = h.manage.configs.language;
  languagePage.selectLanguage(h.tab, 'cn-lang');
  languagePage.apply(h.tab);
  assert.equal(h.store.json.language, 'cn-lang');

  const install = h.manage.configs.spanInstallation;
  assert.equal(install.setInstallation(h.tab, 'maxHeight', 999.991), false);
  assert.equal(install.setInstallation(h.tab, 'maxHeight', 1000), false);
  install.setInstallation(h.tab, 'maxHeight', 2.5);
  install.apply(h.tab);
  assert.equal(
    h.store.getData(['app', 'spanInstallation', 'device-config', 'maxHeight']),
    2.5,
  );
  assert.equal(h.capture.binary.length, 0);
  void language;
});

test('R83 displays forwards to spanInstallation and R85 keeps the 14-day update interval', () => {
  const h = configHarness();
  h.manage.configs.spanInstallation.setInstallation(h.tab, 'maxWidth', 1.25);
  assert.equal(h.manage.configs.displays.isDataChanged(h.tab), true);
  h.manage.configs.displays.resetdisplaySettingsUI(h.tab);
  assert.equal(h.manage.configs.displays.isDataChanged(h.tab), false);
  assert.equal(h.manage.configs.autoUpdates.intervalSeconds, 1_209_600);
});

test('spoofing uses SKCALIBRATE START and SKDETECTCONFIG ENABLE/DISABLE', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  const page = h.manage.configs.spoofing;
  page.setToggle(h.tab, true);
  page.calibrate(h.tab);
  const parsed = h.capture.binary.map((entry) => header(entry.bytes));
  assert.deepEqual(
    parsed.map((entry) => entry.msgId),
    [
      SHIPPED.commandsAndEnums.skdetectconfig.messageId,
      SHIPPED.commandsAndEnums.skcalibrate.messageId,
    ],
  );
  assert.equal(
    new DataView(parsed[1].payload.buffer, parsed[1].payload.byteOffset).getUint32(4, true),
    SHIPPED.commandsAndEnums.skcalibrate.enums.option.ALL,
  );
});

test('Longhorn parses the real InterfaceMode/INSRotation/SetVehicleParameters line grammar', () => {
  const text = [
    'InterfaceMode:COM1,PIMTP,PIMTP',
    'InterfaceMode:COM2,RTCMV3,NMEA,OFF',
    'BaudRate:COM1,230400',
    'INSRotation:rbv,1.1,2.2,3.3,0.1,0.2,0.3',
    'SetVehicleParameters:2.703,1.560,1.560,FRONT_WHEEL_ACKERMANN,0',
  ].join('\r\n');
  const parsed = parseLonghornConfig(text);
  assert.equal(parsed.PORTS.com1, 'PIMTP');
  assert.equal(parsed.PORTS.com2, 'NMEA');
  assert.equal(parsed.BAUDRATES.COM1.baudrate, '230400');
  assert.equal(parsed.SPAN.imu.imuRotationalOffset_X, '1.1');
  assert.equal(parsed.SPAN.imu.imuRotationalOffset_Xdeviation, '0.1');
  assert.equal(parsed.VEHICLE_PARAMETERS.steeringMethods, 'FRONT_WHEEL_ACKERMANN');
  assert.equal(parsed.RTK.inputFormat, 'RTCMV3');
  assert.equal(parsed.RTK.inputPort, 'com2');
  assert.deepEqual(LONGHORN_DEFAULT_CONFIG.PORTS, { com1: 'PIMTP', com2: 'NMEA' });
});

test('generic dialog mirrors the missing-key TypeError and corrected mode leaves a usable button', () => {
  const mirrored = configHarness();
  mirrored.manage.statusConfigClick('menuConfig', mirrored.tab);
  assert.throws(
    () =>
      mirrored.manage.createDialog(
        {
          title: 'Title',
          content: 'Body',
          buttons: [{ text: 'not in any dictionary' }],
        },
        { tab: mirrored.tab },
      ),
    /toLowerCase/,
  );

  const corrected = configHarness({}, { mirrorDefects: false });
  corrected.manage.statusConfigClick('menuConfig', corrected.tab);
  assert.doesNotThrow(() =>
    corrected.manage.createDialog(
      {
        title: 'Title',
        content: 'Body',
        buttons: [{ text: 'not in any dictionary' }],
      },
      { tab: corrected.tab },
    ),
  );
  assert.equal(corrected.doc.querySelectorAll(`#${corrected.tab} #popupModal .modal-footer button`).length, 1);
});

test('generic dialog reverse-maps the shipped title and content text back to data-lang markers', () => {
  const h = configHarness();
  h.manage.language.loadDictionary(ENGLISH);
  h.manage.statusConfigClick('menuConfig', h.tab);
  h.manage.createDialog(
    {
      title: ENGLISH.CANCEL,
      content: ENGLISH.UNSAVED_POPUP_MSG,
      buttons: [{ text: ENGLISH.NO, dataLang: 'data-lang-no', class: 'darkBtn' }],
    },
    { tab: h.tab },
  );
  const title = h.doc.querySelector(`#${h.tab} #popupModal .modal-title`)!;
  assert.ok(title.hasAttribute('data-lang-cancel'));
  const paragraph = h.doc.querySelector(`#${h.tab} #popupModal .modal-body p`)!;
  assert.ok(paragraph.hasAttribute('data-lang-unsaved-popup'));
  const button = h.doc.querySelector(`#${h.tab} #popupModal .modal-footer button`)!;
  assert.ok(button.hasAttribute('data-lang-no'));
  assert.ok(button.classList.contains('darkBtn'));
});

test('popupPositionCalculation centers vertically, caps at 80% and raises / scrolls the body', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  h.manage.createDialog({ title: 'Tall', content: 'Body', buttons: [] }, { tab: h.tab });
  const content = h.doc.querySelector(`#${h.tab} #popupModal .modal-content`) as HTMLElement;
  content.style.height = '900px';
  const position = h.manage.view.popupPositionCalculation(h.tab, false, false, 1000);
  assert.equal(position.viewHeight, 810);
  assert.equal(position.maxDialogHeight, 648);
  assert.equal(position.maxBodyHeight, 648);
  assert.equal(position.overflowY, 'auto');
  assert.equal(position.popupTop, '70px');
  assert.equal(position.dialogTop, 0);
});

test('hide.bs.modal is vetoed while edit-com-config has unsaved data', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  h.manage.createDialog({ title: 'Edit', content: 'Body', buttons: [] }, { tab: h.tab });
  const dialog = h.doc.querySelector(`#${h.tab} #popupModal .modal-dialog`)!;
  dialog.classList.add('edit-com-config');
  h.manage.view.setDialogDirty(h.tab, 'edit-com-config', true);
  const modal = h.doc.querySelector(`#${h.tab} #popupModal`)!;
  const event = createEvent('hide.bs.modal');
  assert.equal(modal.dispatchEvent(event), false);
  assert.equal(event.defaultPrevented, true);
});

test('page1/page2/config switching uses real visibility and warns before discarding config changes', () => {
  const h = configHarness();
  assert.equal(h.manage.statusConfigClick('menuConfig', h.tab), true);
  const root = h.doc.getElementById(h.tab)!;
  assert.equal((root.querySelector(`#config-components-${h.tab}`) as HTMLElement).style.display, 'block');
  assert.equal((root.querySelector(`#status-components-${h.tab}`) as HTMLElement).style.display, 'none');

  const gnss = h.manage.configs.gnss;
  gnss.updateData(1735, { tab: h.tab, angle: 10 });
  gnss.reset(h.tab);
  gnss.setElevation(h.tab, 12);
  assert.equal(h.manage.statusConfigClick('statusPage1', h.tab), false);
  const modal = h.doc.querySelector(`#${h.tab} #popupModal`) as HTMLElement;
  assert.equal(modal.style.display, 'block');
  modal.querySelectorAll('.modal-footer button')[0].click();
  assert.equal(h.manage.isConfigOpen(h.tab), false);
  assert.equal((root.querySelector(`#config-components-${h.tab}`) as HTMLElement).style.display, 'none');
  assert.equal(h.manage.containers.currentPage(h.tab), '');
});

test('configComponentsProcessLanguage applies the mounted page markers from the real HTML', () => {
  const h = configHarness();
  h.manage.statusConfigClick('menuConfig', h.tab);
  h.manage.language.loadDictionary({ PORTS: '端口' });
  const registered = h.manage.language.registeredComponents();
  for (const name of CONFIG_LANGUAGE_PAGE_NAMES) {
    assert.ok(registered.includes(name), `configComponentsProcessLanguage registered ${name}`);
  }
  const ran = h.manage.language.processLanguage(h.tab);
  assert.ok(ran.includes('portConfig'));
  const marker = h.doc.querySelector(`#${h.tab} #portConfiguration [data-lang-ports]`);
  assert.ok(marker);
  assert.equal(marker.textContent, '端口');
});

test('R5 schedules the 300 ms page reset, 800 ms SPAN reset and Longhorn 100 ms reset', () => {
  const standard = configHarness({}, { scheduleConfigResets: true });
  standard.manage.statusConfigClick('menuConfig', standard.tab);
  assert.ok(standard.clock.pending().some((timer) => timer.delay === 300));
  standard.clock.advance(300);
  assert.equal(
    (standard.doc.querySelector(`#${standard.tab} #connection-loader`) as HTMLElement).style.display,
    'none',
  );
  standard.manage.selectConfigPage(standard.tab, 'span');
  assert.ok(standard.clock.pending().some((timer) => timer.delay === 800));
  standard.clock.advance(800);

  const longhorn = configHarness(
    { isLongHorn: true },
    { scheduleConfigResets: true },
  );
  longhorn.manage.statusConfigClick('menuConfig', longhorn.tab);
  assert.ok(longhorn.clock.pending().some((timer) => timer.delay === 100));
});
