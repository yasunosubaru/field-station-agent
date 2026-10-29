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
  EXPORT_MSG,
  EVENTS_DATA_LANG_MAP,
  EVENT_MSG,
  IO_PORT_DETAILS,
  SAVE_LOG_COMMANDS,
  buildAuthCommand,
  bytesToSize,
  chooseIOPortDetails,
  filterLoadCommands,
  formatConfigurationFileName,
  formatResponseFileName,
  parseSoftloadFile,
  transformSavedConfigLines,
  versionMismatch,
} from '../src/config/index.ts';
import { DEFAULT_FEATURES, type FeatureFlags } from '../src/types.ts';
import {
  buildBinaryCommand,
  buildLongHeader,
  appendCrcLe,
  deriveStatusFields,
  readCrcLe,
  novatelCrc32,
} from '../../protocol/src/index.ts';
import { updatedChanConfigListSignalType } from '../../protocol/src/generated-status-tables.ts';
import {
  englishDictionary,
  decodedFixture,
  decodedStatusRepeatedFixture,
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

function shipped(): {
  commandsAndEnums: Record<string, { messageId: number; [key: string]: unknown }>;
  messageIdConstants: Record<string, number>;
} {
  const sandbox: {
    NovatelIdConstants: {
      commandsAndEnums: Record<string, { messageId: number }>;
      messageIdConstants: Record<string, number>;
    };
    console: Console;
  } = { NovatelIdConstants: {} as never, console };
  runInNewContext(evidence('model', 'NovatelIdConstants.js'), sandbox, { timeout: 3000 });
  return sandbox.NovatelIdConstants;
}

const SHIPPED = shipped();
const ENGLISH = englishDictionary();

interface Capture {
  binary: Array<{ tab: string; bytes: Uint8Array }>;
  raw: Array<{ tab: string; text: string }>;
  ascii: Array<{ tab: string; text: string }>;
  copied: string[];
}

interface FilesState {
  files: Map<string, string>;
  directories: Set<string>;
  openFile?: string;
  directory?: string;
}

function featureSet(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    ...DEFAULT_FEATURES,
    generation: 'OEM7',
    model: 'OEM729',
    positionModes: ['RTK'],
    loggingComponent: true,
    fileSupported: true,
    dualAntennaSupported: true,
    ...overrides,
  };
}

function harness(
  overrides: Partial<FeatureFlags> = {},
  manageOverrides: Partial<ManageOptions> = {},
) {
  const features = featureSet(overrides);
  const doc = createDocument();
  const clock = newClock(Date.UTC(2026, 9, 29, 10, 31, 59));
  const store = newStore();
  const shell = doc.createElement('div');
  shell.id = 'shell';
  doc.body.appendChild(shell);
  const registry = createTabRegistry({});
  registry.buildShell(shell);
  const tiles = createTileSystem({
    root: () => doc.body as never,
    loader: realFragmentLoader(),
    features: () => features,
  });
  const capture: Capture = { binary: [], raw: [], ascii: [], copied: [] };
  const fileState: FilesState = { files: new Map(), directories: new Set() };
  const manage = createManage({
    document: doc as unknown as Document,
    clock,
    store,
    fragments: realFragmentLoader(),
    tiles,
    register: COMPONENTS,
    tabShell: registry as never,
    features: () => features,
    commands: COMMANDS,
    portNames: PORT_NAMES,
    translate: (key) => ENGLISH[key] ?? key,
    copyText: (text) => capture.copied.push(text),
    connectedPortName: () => 'COM2',
    psn: () => 'PSN123',
    enclosure: () => 'OEM729',
    scheduleConfigResets: false,
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
    operations: {
      files: {
        defaultDocuments: () => 'C:\\Users\\Test\\Documents',
        readText: (path) => fileState.files.get(path) ?? '',
        writeText: (path, data, options) => {
          fileState.files.set(
            path,
            options?.append ? (fileState.files.get(path) ?? '') + data : data,
          );
        },
        exists: (path) => fileState.files.has(path) || fileState.directories.has(path),
        ensureDirectory: (path) => {
          fileState.directories.add(path);
        },
        chooseOpenFile: () => fileState.openFile,
        chooseDirectory: () => fileState.directory,
        chooseSaveFile: () => fileState.directory,
      },
      connection: {
        close() {},
        reestablish() {},
        deletePingPongCounter() {},
        resetSpectrumViewer() {},
        stopGiiiLogging() {},
      },
    },
    ...manageOverrides,
  });
  const tab = manage.openTab({
    index: 2,
    deviceTileId: 'dev-operations',
    title: 'Operations',
    details: { type: 'eth' },
  });
  manage.buildPanels(tab);
  return { doc, clock, store, manage, tab, features, capture, fileState };
}

function frame(bytes: Uint8Array): { msgId: number; payload: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint16(8, true);
  return { msgId: view.getUint16(4, true), payload: bytes.slice(28, 28 + length) };
}

function responseFrame(messageId: number, text: string) {
  const payload = Uint8Array.from([...text].map((value) => value.charCodeAt(0)));
  const header = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    messageType: 1,
    portAddress: 222,
  });
  const raw = new Uint8Array(header.length + payload.length);
  raw.set(header);
  raw.set(payload, header.length);
  return {
    header: { kind: 'long', headerLength: 28, messageId, messageTypeByte: 1 },
    payload,
    bytes: appendCrcLe(raw),
  };
}

test('all operational pages mount the real shipped fragments', () => {
  const h = harness();
  const checks: Array<[string, string]> = [
    ['deviceDetails', '#device-details'],
    ['deviceExport', '#export-device'],
    ['deviceUpdate', '#update-device'],
    ['deviceRestart', '#restart-device'],
    ['terminalConsole', '#terminal-console'],
    ['events', '#events-menu-sidenav'],
  ];
  for (const [page, selector] of checks) {
    assert.equal(h.manage.mountOperationalPage(h.tab, page), true, page);
    assert.ok(h.doc.querySelector(`#${h.tab} ${selector}`), `${page} mounted from shipped HTML`);
  }
  assert.equal(h.manage.configs.saveConfiguration.name, 'saveConfiguration');
  assert.equal(h.manage.configs.loadConfiguration.name, 'loadConfiguration');
});

test('operational page mounts request exactly the shipped compLogsRegister entries', () => {
  const normalize = (value: string): string => value.toUpperCase().replace(/\s+/g, '');
  for (const page of ['deviceDetails', 'deviceExport', 'deviceUpdate', 'events']) {
    const h = harness();
    assert.equal(h.manage.mountOperationalPage(h.tab, page), true);
    const expected = Object.entries(
      COMPONENTS.compLogsRegister[page] as Record<string, string>,
    ).map(([name, spec]) => normalize(`${name.slice(0, -1)} ${spec}`));
    assert.deepEqual(h.manage.sentLogsFor(h.tab).map(normalize), expected, page);
  }
  for (const page of ['terminalConsole', 'deviceRestart']) {
    const h = harness();
    assert.equal(h.manage.mountOperationalPage(h.tab, page), true);
    assert.deepEqual(h.manage.sentLogsFor(h.tab), [], page);
  }
});

test('R50 binary AUTH maps five parts and preserves the model/date branch', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceDetails');
  const page = h.manage.configs.deviceDetails;
  page.setAuthInput(h.tab, 'AAAA,BBBB,CCCC,DDDD,EEEE');
  const command = page.sendAuthCommand(h.tab);
  assert.equal(command?.kind, 'binary');
  assert.equal(h.capture.binary.length, 1);
  const decoded = frame(h.capture.binary[0].bytes);
  assert.equal(decoded.msgId, SHIPPED.commandsAndEnums.auth.messageId);
  const expected = buildBinaryCommand({
    messageId: SHIPPED.commandsAndEnums.auth.messageId,
    params: [
      { type: 'enum', value: COMMANDS.auth.enums.state.ADD, length: 4 },
      { type: 'string', value: 'AAAA', length: 4 },
      { type: 'string', value: 'BBBB', length: 4 },
      { type: 'string', value: 'CCCC', length: 4 },
      { type: 'string', value: 'DDDD', length: 4 },
      { type: 'string', value: 'EEEE', length: 4 },
    ],
  });
  assert.deepEqual(h.capture.binary[0].bytes, expected);
  const long = buildAuthCommand('1,2,3,4,5,MODEL,123456', 'OEM7');
  assert.equal(long.kind, 'binary');
  assert.equal(long.params[6].model?.[0], 'MODEL\0');
  assert.equal(long.params[7].date?.[0], '123456');
});

test('R50 OEMSTAR auth is quoted ASCII and retains the special-character quirk', () => {
  assert.equal(buildAuthCommand('A-1,CODE', 'OEMSTAR').kind, 'ascii');
  const special = buildAuthCommand('A-1,CODE', 'OEM7');
  assert.equal(special.kind, 'invalid');
  const h = harness({ generation: 'OEMSTAR' });
  h.manage.mountOperationalPage(h.tab, 'deviceDetails');
  h.manage.configs.deviceDetails.setAuthInput(h.tab, 'A-1,CODE');
  h.manage.configs.deviceDetails.sendAuthCommand(h.tab);
  assert.deepEqual(h.capture.raw.at(-1)?.text, 'AUTH "A-1","CODE"\n');
  assert.ok(h.doc.querySelector(`#${h.tab} #InputAuthCode`)?.classList.contains('error-border'));
});

test('Device Details OK/ERROR response paths use the real response frame and restart loader', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceDetails');
  const page = h.manage.configs.deviceDetails;
  page.setAuthInput(h.tab, 'AAAA,BBBB');
  page.sendAuthCommand(h.tab);
  h.manage.handleCommandResponseFrame(h.tab, responseFrame(49, 'OK'));
  assert.equal(h.manage.applyingBudgetFor(h.tab), 30000);

  page.setAuthInput(h.tab, 'CCCC,DDDD');
  page.sendAuthCommand(h.tab);
  h.manage.handleCommandResponseFrame(h.tab, responseFrame(49, 'ERROR:Bad code'));
  assert.ok(h.doc.querySelector(`#${h.tab} #InputAuthCode`)?.classList.contains('error-border'));
  assert.match(
    h.doc.querySelector(`#${h.tab} .input-layout .error-info`)?.textContent ?? '',
    /^[0-9a-f]+$/,
  );
});

test('Device Details renders decoder-produced VERSION blocks from the shipped field table', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceDetails');
  const version = decodedStatusRepeatedFixture(
    37,
    { noOfComponents: 4 },
    [
      {
        type: 'GPSCARD',
        model: 'OEM729',
        PSN: 'PSN-GNSS',
        hardwareVersion: 'H1',
        softwareVersion: 'S1',
        bootVersion: 'B1',
      },
      { type: 'ENCLOSURE', PSN: 'PSN-EN' },
      { type: 'WIFI', model: 'WIFI-M', softwareVersion: 'W1$extra' },
      { type: 'Regulatory', model: 'REGION' },
    ],
    'OEM7',
  );
  h.manage.configs.deviceDetails.updateStatus(37, { ...version, tab: h.tab }, h.tab);
  assert.equal(h.doc.querySelector(`#${h.tab} #deviceDetailsgnssSerialNumber`)?.textContent, 'PSN-GNSS');
  assert.equal(h.doc.querySelector(`#${h.tab} #deviceDetailsgnssModelNumber`)?.textContent, 'OEM729');
  assert.equal(h.doc.querySelector(`#${h.tab} #deviceDetailsserialNumber`)?.textContent, 'PSN-EN');
  assert.equal(h.doc.querySelector(`#${h.tab} #deviceDetailsreceiverWifi`)?.textContent, 'WIFI-M');
  assert.equal(h.doc.querySelector(`#${h.tab} #deviceDetailswifiSoftwareVersion`)?.textContent, 'W1');
});

test('GIII Device Details mounts its shipped table and renders decoded VERSION/ETHSTATUS blocks', () => {
  const h = harness({ generation: 'GIII', isGIII: true, model: 'GIII' });
  assert.equal(h.manage.mountOperationalPage(h.tab, 'deviceDetails'), true);
  assert.ok(h.doc.querySelector(`#${h.tab} .g3-devDetails-container`));
  assert.ok(h.doc.querySelector(`#${h.tab} .g3-devicedetails-table`));
  assert.deepEqual(h.manage.sentLogsFor(h.tab), [
    'VERSION ontime,1',
    'ETHSTATUS ontime,1',
  ]);

  const version = decodedStatusRepeatedFixture(
    4108,
    { noOfComponents: 3 },
    [
      {
        type: 'IOMASTER',
        slotId: 1,
        moduleId: 11,
        psn: 'IO-PSN',
        hwVersion: 'IO-HW',
        swVersion: 'IO-SW',
        pbcVersion: 'IO-PBC',
        sbcVersion: 'IO-SBC',
        fpgaVersion: 'IO-FPGA',
        compDate: '20260101',
        compTime: '010203',
        fwInfoTag: 'IO-FW',
        pbcInfoTag: 'IO-PBI',
        sbcInfoTag: 'IO-SBI',
      },
      { type: 'DSPC', slotId: 2, moduleId: 22, psn: 'DSPC-A' },
      { type: 'DSPC', slotId: 3, moduleId: 33, psn: 'DSPC-B' },
    ],
    'GIII',
  );
  h.manage.handleDecodedLog(h.tab, { messageId: 4108, ...version });
  const table = h.doc.querySelector(`#${h.tab} .g3-devicedetails-table`)!;
  assert.equal(table.querySelector('#IOMASTER-comp-name')?.textContent, 'IO Master');
  assert.equal(table.querySelector('#DSPC1-comp-name')?.textContent?.startsWith('DSPC'), true);
  assert.equal(table.querySelector('#DSPC2-comp-name')?.textContent?.startsWith('DSPC'), true);
  assert.equal(table.querySelector('#IOMASTER-slot-id')?.textContent, '1');
  assert.equal(table.querySelector('#IOMASTER-psn')?.textContent, 'IO-PSN');
  assert.equal(table.querySelector('#IOMASTER-sbc-info-tag')?.textContent, 'IO-SBI');
  assert.equal(table.querySelector('#DSPC1-psn')?.textContent, 'DSPC-A');
  assert.equal(table.querySelector('#DSPC2-psn')?.textContent, 'DSPC-B');

  const ethernet = decodedStatusRepeatedFixture(
    4101,
    { noOfRecords: 2 },
    [
      { type: 'ETHA', mac: '00:11:22:33:44:55', details: 4 },
      { type: 'ETHB', mac: 'AA:BB:CC:DD:EE:FF', details: 5 },
    ],
    'GIII',
  );
  h.manage.handleDecodedLog(h.tab, { messageId: 4101, ...ethernet });
  assert.equal(h.doc.querySelector(`#${h.tab} #giiiEthMacAddress`)?.textContent, 'AA:BB:CC:DD:EE:FF');
  assert.equal(h.doc.querySelector(`#${h.tab} #giiiEthSpeed`)?.textContent, '100 Mbits/sec');
  assert.equal(h.doc.querySelector(`#${h.tab} #giiiEthDuplex`)?.textContent, 'Half');

  h.doc
    .querySelector(`#${h.tab} .devicedetails-info-copy-to-clipboard`)
    ?.dispatchEvent(createEvent('click'));
  assert.match(h.capture.copied.at(-1) ?? '', /^,IOMASTER,DSPC1,DSPC2\n/);
  assert.match(h.capture.copied.at(-1) ?? '', /IO-PSN/);
});

test('Device Details derives signal frequencies and authorized feature branches from decoded records', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceDetails');
  const page = h.manage.configs.deviceDetails;

  const channelBytes = new Uint8Array(8 + 4 + 3 * 8);
  const channelView = new DataView(channelBytes.buffer);
  channelView.setUint32(0, 1, true);
  channelView.setUint32(4, 1, true);
  channelView.setUint32(8, 3, true);
  const codeFor = (name: string): number =>
    Number(
      Object.entries(updatedChanConfigListSignalType).find(([, value]) => value === name)?.[0],
    );
  const channelCodes = [codeFor('GPSL1L2'), codeFor('GALE5A'), codeFor('SBASL1')];
  channelCodes.forEach((code, index) => {
    channelView.setUint32(12 + index * 8, 2, true);
    channelView.setUint32(16 + index * 8, code, true);
  });
  const channelData = deriveStatusFields(1148, channelBytes, {}, [], 'OEM7');
  page.updateStatus(1148, { ...channelData, tab: h.tab }, h.tab);
  assert.equal(h.doc.querySelector(`#${h.tab} #gpsSignals`)?.textContent, 'L1, L2');
  assert.equal(h.doc.querySelector(`#${h.tab} #galSignals`)?.textContent, 'E5');
  assert.equal(
    (h.doc.querySelector(`#${h.tab} .sbas-corrections`) as Element & { style: CSSStyleDeclaration })
      .style.display,
    'block',
  );

  const features = decodedStatusRepeatedFixture(
    1329,
    { noOfFeatures: 4 },
    [
      { featureStatus: 0, featureType: 7 },
      { featureStatus: 0, featureType: 12 },
      { featureStatus: 8, featureType: 1 },
      { featureStatus: 0, featureType: 19 },
    ],
    'OEM7',
  );
  page.updateStatus(1329, { ...features, tab: h.tab }, h.tab);
  assert.equal(
    (h.doc.querySelector(`#${h.tab} #rtkfixed`) as Element & { style: CSSStyleDeclaration }).style
      .display,
    'block',
  );
  assert.equal(
    (h.doc.querySelector(`#${h.tab} .authorization-api`) as Element & { style: CSSStyleDeclaration })
      .style.display,
    'block',
  );
  assert.equal(
    (h.doc.querySelector(`#${h.tab} .ppp-corrections`) as Element & { style: CSSStyleDeclaration })
      .style.display,
    'block',
  );
  assert.equal(h.doc.querySelector(`#${h.tab} #deviceDetailsoutputRate`)?.textContent, '100 Hz');
});

test('Device Details records the TerraStar server/auth dependency instead of faking HTTP success', () => {
  const h = harness({ terrastarSupported: true, model: 'OEMPACK' });
  h.manage.mountOperationalPage(h.tab, 'deviceDetails');
  const version = decodedStatusRepeatedFixture(
    37,
    { noOfComponents: 1 },
    [{ type: 'GPSCARD', model: 'OEMPACK', PSN: 'PSN-TS', softwareVersion: '1.0' }],
    'OEM7',
  );
  h.manage.configs.deviceDetails.updateStatus(37, { ...version, tab: h.tab }, h.tab);
  assert.deepEqual(h.manage.configs.deviceDetails.nativeRequirements(h.tab), [
    'serverConnect.getLmbdaResult + TerraStar HTTP API',
  ]);
});

test('R52 delete-all sends one wildcard FILEDELETE; selected delete spaces commands by 4 ms', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceExport');
  const page = h.manage.configs.deviceExport;
  page.updateData(EXPORT_MSG.FILE_LIST, {
    tab: h.tab,
    data: [
      { fileType: 'FILE', fileName: 'A.LOG', fileSize: 1024 },
      { fileType: 'FILE', fileName: 'B.LOG', fileSize: 2048 },
      { fileType: 'FILE', fileName: 'C.LOG', fileSize: 4096 },
    ],
  });
  page.deleteLogFiles([], h.tab, true);
  let request = frame(h.capture.binary[0].bytes);
  assert.equal(request.msgId, SHIPPED.commandsAndEnums.filedelete.messageId);
  assert.equal(String.fromCharCode(...request.payload.slice(0, 1)), '*');

  h.capture.binary.length = 0;
  page.deleteLogFiles(['A.LOG', 'B.LOG'], h.tab);
  assert.equal(h.capture.binary.length, 1);
  h.clock.advance(4);
  assert.equal(h.capture.binary.length, 2);
  assert.deepEqual(
    h.capture.binary.map((entry) => frame(entry.bytes).msgId),
    [EXPORT_MSG.FILE_DELETE, EXPORT_MSG.FILE_DELETE],
  );
  h.manage.handleCommandResponseFrame(h.tab, responseFrame(EXPORT_MSG.FILE_DELETE, 'OK'));
  h.manage.handleCommandResponseFrame(h.tab, responseFrame(EXPORT_MSG.FILE_DELETE, 'OK'));
  h.clock.advance(500);
  h.clock.advance(2500);
  assert.equal(h.doc.querySelector(`#${h.tab} .available-logs-list li`), null);
});

test('R53 USB copy serializes selected files and emits ALL for select-all', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceExport');
  const page = h.manage.configs.deviceExport;
  page.updateData(EXPORT_MSG.FILE_LIST, {
    tab: h.tab,
    data: [
      { fileType: 'FILE', fileName: 'A.LOG', fileSize: 1024 },
      { fileType: 'FILE', fileName: 'B.LOG', fileSize: 2048 },
      { fileType: 'FILE', fileName: 'C.LOG', fileSize: 4096 },
    ],
  });
  page.updateData(EXPORT_MSG.FILE_SYSTEM_STATUS, {
    tab: h.tab,
    data: [{ massStorageDevice: 'USBSTICK', massStorageStatus: 'MOUNTED' }],
  });
  page.select(h.tab, ['A.LOG', 'B.LOG']);
  assert.equal(page.copyToUsb(h.tab), true);
  assert.equal(h.capture.binary.length, 1);
  let parsed = frame(h.capture.binary[0].bytes);
  assert.equal(parsed.msgId, EXPORT_MSG.FILE_TRANSFER);
  let view = new DataView(parsed.payload.buffer, parsed.payload.byteOffset);
  assert.equal(view.getUint32(0, true), COMMANDS.filetransfer.enums.operation.COPY);
  assert.match(String.fromCharCode(...parsed.payload.slice(4)), /^A\.LOG/);
  page.updateTransferStatus(h.tab, 'FINISHED');
  assert.equal(h.capture.binary.length, 2);
  assert.match(String.fromCharCode(...frame(h.capture.binary[1].bytes).payload.slice(4)), /^B\.LOG/);

  h.capture.binary.length = 0;
  page.copyToUsb(h.tab, true);
  parsed = frame(h.capture.binary[0].bytes);
  view = new DataView(parsed.payload.buffer, parsed.payload.byteOffset);
  assert.equal(String.fromCharCode(...parsed.payload.slice(4, 7)), 'ALL');
});

test('FTP package work is an explicit operations-host requirement, not a hidden npm import', async () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceExport');
  h.fileState.directory = 'C:\\Downloads';
  h.manage.configs.deviceExport.select(h.tab, ['A.LOG']);
  h.manage.configs.deviceExport.updateData(EXPORT_MSG.IP_SERVICE, {
    tab: h.tab,
    data: [{ ipService: 'FTP_SERVER', switch: 'ENABLE' }],
  });
  h.manage.configs.deviceExport.updateData(EXPORT_MSG.IP_STATUS, {
    tab: h.tab,
    ETHA: { ipAddress: '10.0.0.2' },
  });
  await h.manage.configs.deviceExport.downloadSelected(h.tab);
  assert.deepEqual(h.manage.configs.deviceExport.nativeRequirements(h.tab), ['ftp package']);
});

test('Device Export mirrors byte sizing, USB mount gate and FTP enablement', async () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceExport');
  const page = h.manage.configs.deviceExport;
  assert.equal(bytesToSize(0), '0 KB');
  assert.equal(bytesToSize(1024), '1.00 KB');
  assert.equal(bytesToSize(123), '0.12 KB');

  page.updateData(EXPORT_MSG.FILE_LIST, {
    ...decodedFixture(2100, {
      fileType: 'FILE',
      fileName: 'B.LOG',
      fileSize: 2048,
    }),
    tab: h.tab,
    sequence: 1,
  });
  page.updateData(EXPORT_MSG.FILE_LIST, {
    ...decodedFixture(2100, {
      fileType: 'FILE',
      fileName: 'A.LOG',
      fileSize: 1024,
    }),
    tab: h.tab,
    sequence: 0,
  });
  assert.equal(h.doc.querySelector(`#${h.tab} .filescount`)?.textContent, 'Files (2)');
  assert.deepEqual(
    [...h.doc.querySelectorAll(`#${h.tab} .available-logs-list li`)].map((node) => node.id),
    ['li-A', 'li-B'],
  );
  page.select(h.tab, ['A.LOG']);
  assert.equal(page.copyToUsb(h.tab), false);
  assert.equal(h.capture.binary.length, 0);
  assert.match(
    h.doc.querySelector(`#${h.tab} #popupModal`)?.textContent ?? '',
    /No USB device found\.Please insert a USB device into the receiver/i,
  );
  h.manage.closeDialog(h.tab);

  await page.downloadSelected(h.tab);
  assert.match(h.doc.querySelector(`#${h.tab} #popupModal`)?.textContent ?? '', /FTP/i);
  assert.deepEqual(page.nativeRequirements(h.tab), []);

  h.manage.closeDialog(h.tab);
  page.updateData(EXPORT_MSG.FILE_SYSTEM_STATUS, {
    ...decodedFixture(2104, {
      massStorageDevice: 'USBSTICK',
      massStorageStatus: 'MOUNTED',
    }),
    tab: h.tab,
    sequence: 0,
  });
  page.updateData(EXPORT_MSG.IP_SERVICE, {
    ...decodedFixture(1575, { ipService: 'FTP_SERVER', switch: 'ENABLE' }),
    tab: h.tab,
    sequence: 0,
  });
  const ipPayload = new Uint8Array(64);
  const ipView = new DataView(ipPayload.buffer);
  ipView.setUint32(0, 1, true);
  ipView.setUint32(4, 2, true);
  const putString = (offset: number, value: string): number => {
    for (let index = 0; index < value.length; index += 1) {
      ipPayload[offset + index] = value.charCodeAt(index);
    }
    const next = Math.ceil((offset + value.length + 1) / 4) * 4;
    return next;
  };
  let ipOffset = putString(8, '10.0.0.2');
  ipOffset = putString(ipOffset, '255.255.255.0');
  putString(ipOffset, '10.0.0.1');
  page.updateData(EXPORT_MSG.IP_STATUS, { tab: h.tab, payload: ipPayload, sequence: 0 });
  const download = h.doc.querySelector(`#${h.tab} .download-image-btn`);
  assert.equal(download?.classList.contains('customDisableButtons'), false);
});

test('Device Export select-all uses the wildcard once and clears the shipped list', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceExport');
  const page = h.manage.configs.deviceExport;
  page.updateData(EXPORT_MSG.FILE_LIST, {
    tab: h.tab,
    data: [
      { fileType: 'FILE', fileName: 'A.LOG', fileSize: 1024 },
      { fileType: 'FILE', fileName: 'B.LOG', fileSize: 2048 },
    ],
  });
  page.toggleSelectAll(h.tab);
  assert.equal(page.selectedFiles(h.tab).length, 2);
  page.confirmDelete(h.tab);
  const yes = [...h.doc.querySelectorAll(`#${h.tab} #popupModal button`)].find(
    (node) => node.textContent?.toLowerCase() === 'yes',
  );
  yes?.dispatchEvent(createEvent('click'));
  assert.equal(h.capture.binary.length, 1);
  assert.equal(frame(h.capture.binary[0].bytes).msgId, EXPORT_MSG.FILE_DELETE);
  assert.equal(String.fromCharCode(...frame(h.capture.binary[0].bytes).payload.slice(0, 1)), '*');
  h.clock.advance(2000);
  assert.equal(h.doc.querySelector(`#${h.tab} .available-logs-list li`), null);
  assert.equal(
    (h.doc.querySelector(`#${h.tab} .nologs-label`) as Element & { style: CSSStyleDeclaration }).style
      .display,
    'block',
  );
});

test('softload parsing keeps S0 records and coalesces contiguous S3 data with a final commit', () => {
  const text = [
    'S0~P~DATA4',
    'S30900000000AABBCC',
    'S30900000002CCDDEE',
    'S30900000010AABBCC',
    'S70500000000FA',
  ].join('\n');
  const parsed = parseSoftloadFile(text, 'OEM7');
  assert.equal(parsed.isWebContent, true);
  assert.deepEqual(parsed.steps.map((step) => step.kind), [
    'srec',
    'data',
    'data',
    'srec',
    'commit',
  ]);
  const first = parsed.steps[1];
  assert.equal(first.kind, 'data');
  if (first.kind === 'data') {
    assert.equal(first.offset, 0);
    assert.deepEqual([...first.data], [0xaa, 0xbb, 0xcc, 0xdd]);
  }
});

test('Device Update starts with SOFTLOADRESET, sends production frames, and stops on ERROR', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceUpdate');
  const page = h.manage.configs.deviceUpdate;
  page.setFile(h.tab, {
    name: 'firmware.hex',
    text: 'S0~P~M7QP\nS30900000000AABBCC\nS70500000000FA',
  });
  assert.equal(page.start(h.tab), true);
  assert.equal(frame(h.capture.binary[0].bytes).msgId, SHIPPED.commandsAndEnums.softloadreset.messageId);
  assert.deepEqual(h.capture.raw.slice(0, 1).map((entry) => entry.text), [
    'unlogall thisport_30 true\n',
  ]);
  h.manage.handleCommandResponse(h.tab, SHIPPED.commandsAndEnums.softloadreset.messageId, COMMAND_RESPONSE.UNKNOWN);
  assert.equal(h.capture.binary.length, 1);
  h.manage.configs.commands.removeFeature('deviceUpdate');
  page.start(h.tab);
  h.manage.handleCommandResponse(h.tab, SHIPPED.commandsAndEnums.softloadreset.messageId, COMMAND_RESPONSE.OK);
  assert.equal(frame(h.capture.binary.at(-1)!.bytes).msgId, SHIPPED.commandsAndEnums.softloadsrec.messageId);
  const before = h.capture.binary.length;
  h.manage.handleCommandResponse(h.tab, SHIPPED.commandsAndEnums.softloadsrec.messageId, COMMAND_RESPONSE.ERROR);
  assert.equal(h.capture.binary.length, before);
});

test('R54 SOFTLOADDATA carries contiguous raw bytes in a 28-byte header with a valid CRC', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceUpdate');
  const page = h.manage.configs.deviceUpdate;
  page.setFile(h.tab, {
    name: 'firmware.hex',
    text: 'S30900000000AABBCC',
  });
  page.start(h.tab);
  page.handleDeviceUpdateCommandResponse(1, h.tab);
  const raw = h.capture.binary.at(-1)!.bytes;
  const parsed = frame(raw);
  assert.equal(parsed.msgId, SHIPPED.commandsAndEnums.softloaddata.messageId);
  const view = new DataView(parsed.payload.buffer, parsed.payload.byteOffset);
  assert.equal(view.getUint32(0, true), 0);
  assert.equal(view.getUint32(4, true), 2);
  assert.deepEqual([...parsed.payload.slice(8)], [0xaa, 0xbb]);
  assert.equal(readCrcLe(raw, raw.length - 4), novatelCrc32(raw.slice(0, -4)));
  assert.equal(raw[0], 0xaa);
  assert.equal(raw[1], 0x44);
  assert.equal(raw[2], 0x12);
  assert.equal(raw[3], 28);
  assert.equal(raw[7], 222);
});

test('Device Update COMPLETE runs restart; status >=16 closes as ERROR', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceUpdate');
  const page = h.manage.configs.deviceUpdate;
  page.setFile(h.tab, { name: 'firmware.hex', text: 'S0~P~M7QP' });
  page.start(h.tab);
  page.updateData(1235, { tab: h.tab, status: 'COMPLETE' });
  assert.ok(h.capture.binary.some((entry) => frame(entry.bytes).msgId === SHIPPED.commandsAndEnums.reset.messageId));

  h.capture.binary.length = 0;
  page.setFile(h.tab, { name: 'firmware.hex', text: 'S0~P~M7QP' });
  page.start(h.tab);
  page.updateData(1235, { tab: h.tab, status: 'BAD_IMAGE_CRC' });
  assert.equal(
    h.capture.binary.some((entry) => frame(entry.bytes).msgId === SHIPPED.commandsAndEnums.reset.messageId),
    false,
  );

  h.capture.binary.length = 0;
  page.setFile(h.tab, { name: 'firmware.hex', text: 'S0~P~M7QP' });
  page.start(h.tab);
  page.updateData(1235, { tab: h.tab, status: 16 });
  assert.equal(
    h.capture.binary.some((entry) => frame(entry.bytes).msgId === SHIPPED.commandsAndEnums.reset.messageId),
    false,
  );
});

test('Device Update renders VERSION blocks and mounts the Longhorn PIMTP-owned fragment', () => {
  const standard = harness();
  standard.manage.mountOperationalPage(standard.tab, 'deviceUpdate');
  const version = decodedStatusRepeatedFixture(
    37,
    { noOfComponents: 2 },
    [
      { type: 'GPSCARD', model: 'OEM729', softwareVersion: 'FW-7.1' },
      { type: 'DB_WWWISO', softwareVersion: 'WEB-2.5' },
    ],
    'OEM7',
  );
  standard.manage.configs.deviceUpdate.updateData(37, { ...version, tab: standard.tab });
  assert.equal(
    standard.doc.querySelector(`#${standard.tab} #deviceUpdatehardwareVersion`)?.textContent,
    'FW-7.1',
  );
  assert.equal(
    standard.doc.querySelector(`#${standard.tab} #deviceUpdatesoftwareVersion`)?.textContent,
    'WEB-2.5',
  );

  const longhorn = harness({ isLongHorn: true, model: 'PIM222A' });
  longhorn.manage.mountOperationalPage(longhorn.tab, 'deviceUpdate');
  assert.ok(longhorn.doc.querySelector(`#${longhorn.tab} #lghn-update-device`));
  assert.equal(
    longhorn.doc.querySelector(`#${longhorn.tab} .update-firmware-1`)?.getAttribute('readonly'),
    '',
  );
  const page = longhorn.manage.configs.deviceUpdate;
  page.setLonghornFile(longhorn.tab, 'MAIN', { name: 'main.shex', text: 'S0~P~DATA4' });
  page.setLonghornFile(longhorn.tab, 'ME1', { name: 'engine1.bin', text: 'BIN' });
  assert.equal(
    (longhorn.doc.querySelector(`#${longhorn.tab} .update-engine-1`) as Element & { value: string })
      .value,
    'engine1.bin',
  );
  assert.equal(page.startLonghorn(longhorn.tab), false);
  assert.deepEqual(page.hostRequirements(longhorn.tab), [
    'Edie.inputstream_api + Edie.pimtpframer_api(PIMTP UPDATE_BEGIN/UPDATE_DATA)',
  ]);
  assert.equal(longhorn.capture.binary.length, 0);

  page.setLonghornFile(longhorn.tab, 'MAIN', { name: 'main.hex', text: 'not-shex' });
  assert.equal(page.startLonghorn(longhorn.tab), false);
  assert.ok(
    longhorn.doc
      .querySelector(`#${longhorn.tab} .lghn-device-update-file-path`)
      ?.classList.contains('error-text'),
  );
});

test('R55/R56 restart, factory reset, Lua erase and MarinePak status are explicit', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'deviceRestart');
  const page = h.manage.configs.deviceRestart;
  page.resetFunc(h.tab);
  let parsed = frame(h.capture.binary[0].bytes);
  assert.equal(parsed.msgId, SHIPPED.commandsAndEnums.reset.messageId);
  assert.equal(new DataView(parsed.payload.buffer, parsed.payload.byteOffset).getUint32(0, true), 0);
  h.capture.raw.length = 0;
  page.clearLUAData(h.tab);
  assert.deepEqual(h.capture.raw.map((entry) => entry.text), [
    'SOFTLOADRESET\n',
    'SOFTLOADSREC "S0~P~M7QP,M7QPB,OEM718D,OEM718DC,OEM719,OEM719A,OEM719B,OEM719C,OEM719D,OEM719AC,OEM719BC,OEM719N,OEM729,OEM729R,OEM729C,OEM729RC,OEM7500,OEM7500C,OEM7600,OEM7600C,OEM7700,OEM7700C,OEM7720,OEM7720C,PIM7500,PIM7500C"\n',
    'SOFTLOADSREC "S0~V~DEV-LOAD"\n',
    'SOFTLOADSREC "S0~T~DATA1"\n',
    'SOFTLOADSREC "S30900000000FFFFFFFFFA"\n',
    'SOFTLOADCOMMIT\n',
  ]);

  const marine = harness({ isMarinePak: true });
  marine.manage.mountOperationalPage(marine.tab, 'deviceRestart');
  marine.manage.configs.deviceRestart.fresetFunc(marine.tab);
  assert.equal(marine.manage.configs.deviceRestart.getMarinePakFresetActiveFlag(marine.tab), false);
  marine.clock.advance(30000);
  assert.equal(marine.manage.configs.deviceRestart.getMarinePakFresetActiveFlag(marine.tab), true);
  marine.manage.configs.deviceRestart.handleLuaStatusCommandResponse(
    '<ERROR:Message is invalid for this model\r\n',
    marine.tab,
  );
  assert.equal(marine.manage.configs.deviceRestart.getLuaScriptSuccessful(marine.tab), false);

  const lua = harness({ isMarinePak: true });
  lua.manage.mountOperationalPage(lua.tab, 'deviceRestart');
  lua.manage.configs.deviceRestart.fresetFunc(lua.tab);
  lua.clock.advance(30000);
  lua.capture.raw.length = 0;
  lua.manage.handleSessionText(lua.tab, 'autoexec.lua COMPLETED');
  assert.deepEqual(lua.capture.raw.map((entry) => entry.text), [
    'LUA START factoryreset.lua\n',
  ]);

  const giii = harness({ isGIII: true, generation: 'GIII' });
  giii.manage.mountOperationalPage(giii.tab, 'deviceRestart');
  giii.manage.configs.deviceRestart.resetFunc(giii.tab);
  assert.deepEqual(giii.capture.raw.map((entry) => entry.text), [
    'LOG  VERSIONB ONTIME 1\n',
    'RESET\n',
  ]);
  assert.equal(giii.manage.applyingBudgetFor(giii.tab), 60000);

  const ui = harness();
  ui.manage.mountOperationalPage(ui.tab, 'deviceRestart');
  ui.doc.querySelector(`#${ui.tab} #erase-nvm`)?.dispatchEvent(createEvent('click'));
  ui.doc.querySelector(`#${ui.tab} #restartBtn`)?.dispatchEvent(createEvent('click'));
  assert.equal(ui.capture.binary.length, 0);
  const yes = [...ui.doc.querySelectorAll(`#${ui.tab} #popupModal button`)].find(
    (node) => node.textContent?.toLowerCase() === 'yes',
  );
  yes?.dispatchEvent(createEvent('click'));
  assert.equal(ui.capture.raw[0]?.text, 'SOFTLOADRESET\n');
  assert.equal(frame(ui.capture.binary[0]?.bytes).msgId, SHIPPED.commandsAndEnums.reset.messageId);
});

test('Longhorn reset requires the PIMTP native framer and records the missing evidence', () => {
  const h = harness({ isLongHorn: true });
  h.manage.mountOperationalPage(h.tab, 'deviceRestart');
  h.manage.configs.deviceRestart.longhornResetFunc(h.tab);
  assert.deepEqual(h.manage.configs.deviceRestart.nativeRequirements(h.tab), [
    'Edie.pimtpframer_api().getresetframe()',
  ]);
});

test('R57/R59 save conversion filters real model ports and comments every shipped keyword', () => {
  const saveSource = evidence('view', 'js', 'saveConfiguration.js');
  const shippedLogs = [...saveSource.matchAll(/^\s*\d+:\s*"(LOG [^"]+)"/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual([...SAVE_LOG_COMMANDS], shippedLogs);
  const ports = chooseIOPortDetails('OEM729', 'OEM729', 'OEM729', false);
  assert.deepEqual(ports, IO_PORT_DETAILS.OEM729);
  const converted = transformSavedConfigLines(
    [
      '<INTERFACEMODE COM1 NOVATEL NOVATEL ON',
      '<INTERFACEMODE COM9 NOVATEL NOVATEL ON',
      '<NVMUSERDATA 0',
      '<IPCONFIG ETHA DHCP',
    ],
    'VERSION',
    ports,
  );
  assert.ok(converted.some((line) => line.includes('INTERFACEMODE COM1')));
  assert.equal(converted.some((line) => line.includes('COM9')), false);
  assert.ok(converted.some((line) => line.startsWith('/* NVMUSERDATA 0')));
  assert.ok(converted.some((line) => line.startsWith('/* IPCONFIG')));
  const version = transformSavedConfigLines(['< VERSION OEM729 1.0'], 'VERSION', ports);
  assert.ok(version.some((line) => line.startsWith('/* VERSION')));
});

test('R58/R60 save capture uses exact log timing, filename and append-only file host', () => {
  const h = harness();
  const driver = h.manage.configs.saveConfiguration;
  driver.getLogVersionData({ hardwareVersion: 'OEM729' }, h.tab);
  assert.equal(driver.start(h.tab, h.features, 'PSN123', 'OEM729'), true);
  assert.equal(h.capture.raw.length, SAVE_LOG_COMMANDS.length - 1);
  assert.equal(driver.getSaveConfigActive(h.tab), true);
  h.clock.advance(2000);
  assert.equal(h.capture.raw.at(-1)?.text, 'LOG RXCONFIG\n');
  h.clock.advance(1500);
  assert.deepEqual(h.capture.raw.slice(-2).map((entry) => entry.text), [
    'SAVECONFIG\n',
    'RESET\n',
  ]);
  assert.equal(
    driver.getSaveConfigActive(h.tab),
    false,
    'saveCheck is cleared in the 500 ms callback at t=3500',
  );
  assert.equal(
    formatConfigurationFileName('PSN123', new Date(2026, 9, 29, 10, 31, 59)),
    'PSN123_2026-10-29_10-31-59.cfg',
  );
  const extracted = driver.processIncomingData('< VERSION OEM729 1.0', h.tab);
  assert.deepEqual(extracted, []);
  const closed = driver.processIncomingData('[', h.tab);
  assert.ok(closed.some((line) => line.startsWith('/* VERSION')));
  assert.equal(
    closed.filter((line) => line.startsWith('/* VERSION')).length,
    1,
    'saveConfiguration.addLineToConfig appends each captured line once',
  );
  const savedPath =
    driver.getDefaultExportDir() +
    '\\' +
    driver.getFileName(h.tab);
  assert.match(h.fileState.files.get(savedPath) ?? '', /VERSION/);
  driver.placeLogRequest(h.tab);
  assert.ok(driver.getDefaultExportDir().startsWith('C:\\Users\\Test\\Documents'));
});

test('R61–R65 load filtering, version check, retry/SaveConfig/Reset and response report', () => {
  assert.deepEqual(
    filterLoadCommands(
      '/* VERSION OEM729 1.0 */\nRESET\nSAVECONFIG\nSERIALCONFIG COM2 115200\nICOMCONFIG COM2 TCP\nLOG BESTPOS ONCHANGED',
      'COM2',
    ),
    ['LOG BESTPOS ONCHANGED'],
  );
  assert.deepEqual(
    versionMismatch('/* VERSION OEM729 1.0 */', {
      hardwareVersion: 'OEM729',
      model: 'OEM729',
      softwareVersion: '2.0',
    }),
    ['Firmware version'],
  );
  assert.equal(
    formatResponseFileName('sample', new Date(2026, 9, 29, 10, 31, 59)),
    'sample_2026-10-29_10-31-59_responses.txt',
  );

  const h = harness();
  const load = h.manage.configs.loadConfiguration;
  h.capture.ascii.length = 0;
  load.start('LOG BESTPOS ONCHANGED\nLOG TIME ONTIME 1', h.tab, {
    currentPort: 'COM2',
    versions: { hardwareVersion: 'OEM729', model: 'OEM729', softwareVersion: '1.0' },
    responseBaseName: 'sample',
    responseDirectory: 'C:\\Load',
  });
  load.step(h.tab);
  assert.equal(h.capture.ascii[0].text, 'LOG BESTPOS ONCHANGED');
  load.processResponses(['#LOGR,COM2_30,0,', '<OK*'], h.tab);
  load.step(h.tab);
  assert.equal(h.capture.ascii[1].text, 'LOG TIME ONTIME 1');
  load.processResponses(['#LOGR,COM2_30,0,', '<OK*'], h.tab);
  load.step(h.tab);
  assert.equal(h.capture.ascii[2].text, 'SAVECONFIG');
  load.processResponses(['#SAVECONFIGR,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;', '<OK*1234'], h.tab);
  load.step(h.tab);
  assert.equal(h.capture.ascii[3].text, 'RESET');
  assert.ok(load.responseReport(h.tab).some((entry) => entry.command === 'SAVECONFIG'));
});

test('R63/R64 load times out at 30 s and ERROR:Profile Active suppresses RESET', () => {
  const timeoutHarness = harness();
  const timeout = timeoutHarness.manage.configs.loadConfiguration;
  timeout.start('LOG BESTPOS ONCHANGED', timeoutHarness.tab, {
    currentPort: 'COM2',
    versions: { hardwareVersion: 'OEM729', model: 'OEM729', softwareVersion: '1.0' },
    responseBaseName: 'timeout',
    responseDirectory: 'C:\\Load',
  });
  timeout.step(timeoutHarness.tab);
  timeoutHarness.clock.advance(30000);
  assert.equal(timeout.getLoadConfigActive(timeoutHarness.tab), false);

  const h = harness();
  const load = h.manage.configs.loadConfiguration;
  load.start('LOG BESTPOS ONCHANGED', h.tab, {
    currentPort: 'COM2',
    versions: { hardwareVersion: 'OEM729', model: 'OEM729', softwareVersion: '1.0' },
    responseBaseName: 'profile',
    responseDirectory: 'C:\\Load',
  });
  load.step(h.tab);
  load.processResponses(['#LOGR,COM2_30,0,', '<OK*'], h.tab);
  load.step(h.tab);
  assert.equal(h.capture.ascii.at(-1)?.text, 'SAVECONFIG');
  load.processResponses(
    ['#SAVECONFIGR,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;', '<ERROR:Profile Active.*'],
    h.tab,
  );
  const before = h.capture.ascii.length;
  load.step(h.tab);
  assert.equal(h.capture.ascii.length, before);
  assert.equal(load.getLoadConfigActive(h.tab), false);
});

test('Load configuration distinguishes UNKNOWN, ERROR and OK responses through the production driver', () => {
  const unknown = harness();
  const unknownLoad = unknown.manage.configs.loadConfiguration;
  unknownLoad.start('LOG BESTPOS ONCHANGED', unknown.tab, {
    currentPort: 'COM2',
    versions: { hardwareVersion: 'OEM729', model: 'OEM729', softwareVersion: '1.0' },
    responseBaseName: 'unknown',
    responseDirectory: 'C:\\Load',
  });
  unknownLoad.step(unknown.tab);
  unknownLoad.processResponses(['#LOGR,COM2_30,0,', '<UNKNOWN*'], unknown.tab);
  unknownLoad.step(unknown.tab);
  assert.equal(unknown.capture.ascii.at(-1)?.text, 'SAVECONFIG');
  unknownLoad.processResponses(
    ['#SAVECONFIGR,THISPORT_30,0,', '<ERROR:Profile Active.*'],
    unknown.tab,
  );
  unknownLoad.step(unknown.tab);
  assert.equal(unknownLoad.getLoadConfigActive(unknown.tab), false);
  assert.deepEqual(
    unknownLoad.responseReport(unknown.tab).map(({ command, status }) => ({
      command: command.split(' ')[0],
      status,
    })),
    [
      { command: 'LOG', status: 'UNKNOWN' },
      { command: 'SAVECONFIG', status: 'ERROR:Profile Active.' },
    ],
  );
  const unknownResponsePath = unknownLoad.responseFile(unknown.tab);
  assert.ok(unknownResponsePath);
  assert.ok(
    unknown.fileState.files.has(unknownResponsePath),
    JSON.stringify([...unknown.fileState.files.keys()]),
  );
  const unknownReport = unknown.fileState.files.get(unknownResponsePath) ?? '';
  assert.doesNotMatch(unknownReport, /LOG BESTPOS/);
  assert.match(unknownReport, /SAVECONFIG --> Failure\(ERROR:Profile Active\.\)/);

  const failed = harness();
  const failedLoad = failed.manage.configs.loadConfiguration;
  failedLoad.start('LOG TIME ONTIME 1', failed.tab, {
    currentPort: 'COM2',
    versions: { hardwareVersion: 'OEM729', model: 'OEM729', softwareVersion: '1.0' },
    responseBaseName: 'failed',
    responseDirectory: 'C:\\Load',
  });
  failedLoad.step(failed.tab);
  failedLoad.processResponses(['#LOGR,COM2_30,0,', '<ERROR:Bad log*'], failed.tab);
  failedLoad.step(failed.tab);
  assert.equal(failed.capture.ascii.at(-1)?.text, 'SAVECONFIG');
  failedLoad.processResponses(
    ['#SAVECONFIGR,THISPORT_30,0,', '<ERROR:Profile Active.*'],
    failed.tab,
  );
  failedLoad.step(failed.tab);
  const failedReport = failed.fileState.files.get(failedLoad.responseFile(failed.tab)!) ?? '';
  assert.match(failedReport, /LOG --> Failure\(ERROR:Bad log\)/);
});

test('.cfg file chooser first offers the shipped optional FRESET branch', async () => {
  const h = harness();
  const configPath = 'C:\\Configs\\sample.cfg';
  h.fileState.openFile = configPath;
  h.fileState.files.set(configPath, 'LOG BESTPOS ONCHANGED');
  assert.deepEqual(
    await h.manage.chooseAndLoadConfigurationFile(h.tab, {
      hardwareVersion: 'OEM729',
      model: 'OEM729',
      softwareVersion: '1.0',
    }),
    [],
  );
  const no = [...h.doc.querySelectorAll(`#${h.tab} #popupModal button`)].find(
    (node) => node.textContent?.toLowerCase() === 'no',
  );
  no?.dispatchEvent(createEvent('click'));
  assert.equal(h.manage.configs.loadConfiguration.getLoadConfigActive(h.tab), true);
  h.manage.configs.loadConfiguration.step(h.tab);
  assert.equal(h.capture.ascii.at(-1)?.text, 'LOG BESTPOS ONCHANGED');
  assert.match(
    h.manage.configs.loadConfiguration.responseFile(h.tab) ?? '',
    /sample_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_responses\.txt$/,
  );

  const reset = harness();
  reset.fileState.openFile = configPath;
  reset.fileState.files.set(configPath, 'LOG TIME ONTIME 1');
  await reset.manage.chooseAndLoadConfigurationFile(reset.tab, {
    hardwareVersion: 'OEM729',
    model: 'OEM729',
    softwareVersion: '1.0',
  });
  const yes = [...reset.doc.querySelectorAll(`#${reset.tab} #popupModal button`)].find(
    (node) => node.textContent?.toLowerCase() === 'yes',
  );
  yes?.dispatchEvent(createEvent('click'));
  assert.equal(reset.capture.ascii.at(-1)?.text, 'FRESET');
  assert.equal(reset.capture.raw.at(-1)?.text, '\n');
  assert.equal(reset.manage.configs.loadConfiguration.getLoadConfigActive(reset.tab), true);
  reset.clock.advance(31_000);
  reset.manage.configs.loadConfiguration.step(reset.tab);
  assert.equal(reset.capture.ascii.at(-1)?.text, 'LOG TIME ONTIME 1');
});

test('Terminal split routing, LOGR formatting and virtual port rewrite follow R66–R69', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'terminalConsole');
  const terminal = h.manage.configs.terminal;
  terminal.updateData('#BESTPOS,COM2,1;first*1234\r\n', h.tab);
  assert.equal(terminal.lines(h.tab).length, 0);
  terminal.resetDataObject(h.tab);
  terminal.updateData('#LOGR,COM2_30,0,0,UNKNOWN;second*5678\r\n', h.tab);
  assert.equal(terminal.lines(h.tab).length, 1);
  assert.match(terminal.lines(h.tab)[0].text, /<second\n\[COM2\]/);
  h.capture.raw.length = 0;
  terminal.executeCommand('log bestposb ontime 1', h.tab);
  assert.deepEqual(h.capture.raw[0].text, 'log COM2_28 bestposb ontime 1\n');
  terminal.executeCommand('unlog bestposb', h.tab);
  assert.equal(h.capture.raw.at(-1)?.text, 'log thisport_30 loglistb once 0\n');
});

test('R70 terminal limits are 2000 OEM, 1000 GIII, 500 Longhorn and trim oldest lines', () => {
  const oem = harness();
  oem.manage.mountOperationalPage(oem.tab, 'terminalConsole');
  for (let index = 0; index < 2005; index += 1) {
    oem.manage.configs.terminal.updateData(`<OK:${index}\r\n`, oem.tab);
  }
  assert.equal(oem.manage.configs.terminal.lines(oem.tab).length, 2000);
  assert.equal(oem.manage.configs.terminal.maxLines(oem.tab), 2000);
  assert.equal(harness({ isGIII: true }).manage.configs.terminal.maxLines('tabs-2'), 1000);
  assert.equal(
    harness({ isLongHorn: true }).manage.configs.terminal.maxLines('tabs-2'),
    500,
  );
});

test('Terminal mounts GIII/Longhorn variants and preserves their apply/native boundaries', () => {
  const giii = harness(
    { generation: 'GIII', isGIII: true, model: 'GIII' },
    { giiiDataPortState: () => 'Configuration' },
  );
  giii.manage.mountOperationalPage(giii.tab, 'terminalConsole');
  assert.ok(giii.doc.querySelector(`#${giii.tab} #giii-terminal-console`));
  giii.capture.raw.length = 0;
  giii.manage.configs.terminal.applyGiiiState(giii.tab);
  assert.equal(giii.capture.raw.at(-1)?.text, 'CHANGESTATE OPERATIONAL\n');

  const operational = harness(
    { generation: 'GIII', isGIII: true, model: 'GIII' },
    { giiiDataPortState: () => 'Operational' },
  );
  operational.manage.mountOperationalPage(operational.tab, 'terminalConsole');
  operational.manage.configs.terminal.applyGiiiState(operational.tab);
  assert.match(
    operational.doc.querySelector(`#${operational.tab} #popupModal`)?.textContent ?? '',
    /restart/i,
  );
  assert.equal(operational.capture.raw.length, 0);

  const quotes = harness({ generation: 'OEM6' });
  quotes.manage.mountOperationalPage(quotes.tab, 'terminalConsole');
  quotes.manage.configs.terminal.executeCommand('MODEL OEM729', quotes.tab);
  quotes.manage.configs.terminal.executeCommand('AUTH A,B,C', quotes.tab);
  assert.deepEqual(quotes.capture.raw.slice(-2).map((entry) => entry.text), [
    'MODEL "OEM729"\n',
    'AUTH "A","B","C"\n',
  ]);

  const longhorn = harness({ isLongHorn: true, model: 'PIM222A' });
  longhorn.manage.mountOperationalPage(longhorn.tab, 'terminalConsole');
  assert.ok(longhorn.doc.querySelector(`#${longhorn.tab} #lghn-terminal-console`));
  longhorn.manage.configs.terminal.executeCommand('HELP', longhorn.tab);
  assert.deepEqual(longhorn.manage.configs.terminal.nativeRequirements(longhorn.tab), [
    'Edie.pimtpframer_api terminal command frame',
  ]);
});

test('Terminal Save and Record use the injected file-save host without collapsing response bytes', async () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'terminalConsole');
  const terminal = h.manage.configs.terminal;
  terminal.executeCommand('log bestposb ontime 1', h.tab);
  terminal.updateData('<OK\r\n', h.tab);
  h.fileState.directory = 'C:\\Console.txt';
  assert.equal(await terminal.saveOutput(h.tab), 'C:\\Console.txt');
  assert.equal(
    h.fileState.files.get('C:\\Console.txt'),
    'log bestposb ontime 1\r\n<OK\r\n',
  );

  h.fileState.directory = 'C:\\Console.gps';
  terminal.startRecording(h.tab);
  terminal.updateData('#LOGR,COM2_30,0;RAW*1234\r\n', h.tab);
  await terminal.stopRecording(h.tab);
  assert.match(h.fileState.files.get('C:\\Console.gps') ?? '', /#LOGR,COM2_30,0;RAW\*1234/);
  assert.doesNotMatch(h.fileState.files.get('C:\\Console.gps') ?? '', /undefined/);
});

test('Terminal command files are consumed one line per second and skip only semicolon comments', async () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'terminalConsole');
  h.fileState.openFile = 'C:\\commands.txt';
  h.fileState.files.set('C:\\commands.txt', 'log bestposb ontime 1\n; ignored\nlog time ontime 1');
  h.capture.raw.length = 0;
  await h.manage.configs.terminal.loadCommands(h.tab);
  assert.equal(h.capture.raw.length, 0);
  h.clock.advance(1000);
  assert.equal(h.capture.raw.at(-1)?.text, 'log COM2_28 bestposb ontime 1\n');
  h.clock.advance(1000);
  assert.equal(h.capture.raw.length, 1);
  h.clock.advance(1000);
  assert.equal(h.capture.raw.at(-1)?.text, 'log time ontime 1\n');
});

test('R71/R72 events map severity classes and cap decided history at 100', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'events');
  const page = h.manage.configs.events;
  page.updateData(EVENT_MSG.RXSTATUS, {
    tab: h.tab,
    spoofing: 'DETECTED',
    time: new Date(1_000),
  });
  assert.equal(page.getSMeventsCount(h.tab), 1);
  page.updateData(EVENT_MSG.RXSTATUS, {
    tab: h.tab,
    spoofing: 'OK',
    time: new Date(2_000),
  });
  const ended = Object.values(page.getEventHandlerObject(h.tab)).find((entry) => !entry.alive);
  assert.ok(ended);
  assert.equal(ended?.state, 'Poor');
  assert.ok(h.doc.querySelector(`#${h.tab} .history-events-layout li.Poor.eventElement`));
  assert.ok(h.doc.querySelector(`#${h.tab} .history-events-layout li.Poor .red-status`));

  for (let index = 0; index < 105; index += 1) {
    const stamp = 10_000 + index * 2000;
    page.updateData(EVENT_MSG.RXSTATUS, {
      tab: h.tab,
      spoofing: 'DETECTED',
      time: new Date(stamp),
    });
    page.updateData(EVENT_MSG.RXSTATUS, {
      tab: h.tab,
      spoofing: 'OK',
      time: new Date(stamp + 1000),
    });
  }
  assert.equal(
    Object.values(page.getEventHandlerObject(h.tab)).filter((entry) => !entry.alive).length,
    100,
  );
});

test('Events consumes decoder-produced TRACKSTAT blocks and emits the GPS tracking warning', () => {
  const h = harness({ constellations: ['GPS'] });
  h.manage.mountOperationalPage(h.tab, 'events');
  const track = decodedStatusRepeatedFixture(
    83,
    { numberOfChannels: 3 },
    [
      { satSystem: 'GPS', PRN: 1, channelTrackingStatus: 0x00000025 },
      { satSystem: 'GPS', PRN: 2, channelTrackingStatus: 0x00000025 },
      { satSystem: 'GPS', PRN: 3, channelTrackingStatus: 0x00000025 },
    ],
    'OEM7',
  );
  h.manage.configs.events.updateData(83, {
    ...track,
    tab: h.tab,
    time: new Date(Date.UTC(2026, 9, 29, 1, 2, 3)),
  });
  const events = Object.values(h.manage.configs.events.getEventHandlerObject(h.tab));
  const warning = events.find((entry) => entry.description === 'data-lang-gps-tracking-less');
  assert.ok(warning);
  assert.equal(warning?.alive, true);
  assert.equal(warning?.state, 'Poor');

  const healthy = decodedStatusRepeatedFixture(
    83,
    { numberOfChannels: 4 },
    [
      { satSystem: 'GPS', PRN: 1, channelTrackingStatus: 0x00000004 },
      { satSystem: 'GPS', PRN: 2, channelTrackingStatus: 0x00000004 },
      { satSystem: 'GPS', PRN: 3, channelTrackingStatus: 0x00000004 },
      { satSystem: 'GPS', PRN: 4, channelTrackingStatus: 0x00000004 },
    ],
    'OEM7',
  );
  h.manage.configs.events.updateData(83, {
    ...healthy,
    tab: h.tab,
    time: new Date(Date.UTC(2026, 9, 29, 1, 2, 4)),
  });
  assert.equal(
    Object.values(h.manage.configs.events.getEventHandlerObject(h.tab)).filter(
      (entry) => entry.alive && entry.description === 'data-lang-gps-tracking-less',
    ).length,
    0,
  );
});

test('Events consumes Longhorn 2353 RX/device/idle messages and 223 GSV tracking', () => {
  const h = harness({ isLongHorn: true, model: 'PIM222A' });
  h.manage.mountOperationalPage(h.tab, 'events');
  const page = h.manage.configs.events;

  page.updateData(EVENT_MSG.LONGHORN_NMEA, {
    tab: h.tab,
    MessageIdentifier: 2,
    MessageNumber: 1,
    invalidModel: 1,
    invalidAuthCode: 1,
  });
  let events = Object.values(page.getEventHandlerObject(h.tab));
  assert.equal(
    events.filter((event) => event.alive && event.description === 'data-lang-invalid-model').length,
    1,
  );
  assert.equal(
    events.filter(
      (event) => event.alive && event.description === 'data-lang-invalid-authcode',
    ).length,
    1,
  );

  page.updateData(EVENT_MSG.LONGHORN_NMEA, {
    tab: h.tab,
    MessageIdentifier: 2,
    MessageNumber: 1,
    invalidModel: 0,
    invalidAuthCode: 0,
  });
  events = Object.values(page.getEventHandlerObject(h.tab));
  assert.equal(
    events.filter(
      (event) => !event.alive && event.description === 'data-lang-invalid-model',
    ).length,
    1,
  );

  page.updateData(EVENT_MSG.LONGHORN_NMEA, {
    tab: h.tab,
    MessageIdentifier: 3,
    MessageNumber: 1,
    antennaVoltage: 1,
    temperature: 1,
    com1BufferOverrun: 1,
    com2BufferOverrun: 0,
  });
  events = Object.values(page.getEventHandlerObject(h.tab));
  assert.ok(events.some((event) => event.description === 'data-lang-lghn-ant-vol-warning'));
  assert.ok(events.some((event) => event.description === 'data-lang-tcxo-warning'));
  assert.ok(events.some((event) => event.description === 'data-lang-com1-buffer-overrun'));

  page.updateData(EVENT_MSG.LONGHORN_NMEA, {
    tab: h.tab,
    MessageIdentifier: 4,
    MessageNumber: 1,
    idleTime: 5,
  });
  assert.equal(
    Object.values(page.getEventHandlerObject(h.tab)).some(
      (event) => event.description === 'data-lang-high-cpu',
    ),
    false,
  );
  h.clock.advance(5000);
  assert.equal(
    Object.values(page.getEventHandlerObject(h.tab)).filter(
      (event) => event.alive && event.description === 'data-lang-high-cpu',
    ).length,
    1,
  );

  page.updateData(EVENT_MSG.NMEA_GSV, {
    tab: h.tab,
    Data: [
      { system: 'GPS', PNR: 1, rejectCodes: ['0'] },
      { system: 'GPS', PNR: 2, rejectCodes: ['0'] },
    ],
  });
  assert.ok(
    Object.values(page.getEventHandlerObject(h.tab)).some(
      (event) => event.alive && event.description === 'data-lang-gps-tracking-less',
    ),
  );
});

test('R73 event export includes only ended filtered events with the shipped UTC timestamp shape', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'events');
  const page = h.manage.configs.events;
  page.updateData(EVENT_MSG.RXSTATUS, {
    tab: h.tab,
    spoofing: 'DETECTED',
    time: new Date(Date.UTC(2026, 9, 29, 1, 2, 3)),
  });
  page.updateData(EVENT_MSG.RXSTATUS, {
    tab: h.tab,
    spoofing: 'OK',
    time: new Date(Date.UTC(2026, 9, 29, 1, 3, 3)),
  });
  page.setFilter(h.tab, ['poorEvents']);
  const output = page.exportData(h.tab);
  assert.match(output, /29-10-2026 09:02:03 to 29-10-2026 09:03:03 UTC/);
  assert.match(output, /Spoofing is being detected/);
  page.setFilter(h.tab, ['goodEvents']);
  assert.equal(page.exportData(h.tab), '');

  const longhorn = harness({ isLongHorn: true });
  longhorn.manage.mountOperationalPage(longhorn.tab, 'events');
  longhorn.manage.configs.events.updateData(EVENT_MSG.RXSTATUS, {
    tab: longhorn.tab,
    spoofing: 'DETECTED',
    time: new Date(1_000),
  });
  longhorn.manage.configs.events.updateData(EVENT_MSG.RXSTATUS, {
    tab: longhorn.tab,
    spoofing: 'OK',
    time: new Date(2_000),
  });
  longhorn.manage.configs.events.setFilter(longhorn.tab, ['poorEvents']);
  const longhornOutput = longhorn.manage.configs.events.exportData(longhorn.tab);
  assert.match(
    longhornOutput,
    /29-10-2026 18:31:59 to 29-10-2026 18:31:59 - Spoofing is being detected/,
  );
  assert.doesNotMatch(longhornOutput, /undefined|UTC/);
});

test('Events history limit, clear and snooze controls follow the shipped fragment', () => {
  const h = harness();
  h.manage.mountOperationalPage(h.tab, 'events');
  const page = h.manage.configs.events;
  for (let index = 0; index < 7; index += 1) {
    page.updateData(EVENT_MSG.RXSTATUS, {
      tab: h.tab,
      spoofing: 'DETECTED',
      time: new Date(10_000 + index * 2000),
    });
    page.updateData(EVENT_MSG.RXSTATUS, {
      tab: h.tab,
      spoofing: 'OK',
      time: new Date(11_000 + index * 2000),
    });
  }
  page.setHistoryLimit(h.tab, 5);
  assert.equal(
    [...h.doc.querySelectorAll(`#${h.tab} .history-events-layout li.eventElement`)].filter(
      (node) => (node as Element & { style: CSSStyleDeclaration }).style.display !== 'none',
    ).length,
    5,
  );

  const poorDelete = h.doc.querySelector(`#${h.tab} .delete-list #poorEvents`);
  poorDelete?.dispatchEvent(createEvent('click'));
  h.doc
    .querySelector(`#${h.tab} #clearEventsBtn`)
    ?.dispatchEvent(createEvent('click'));
  assert.equal(
    Object.values(page.getEventHandlerObject(h.tab)).filter((event) => !event.alive).length,
    0,
  );

  h.doc
    .querySelector(`#${h.tab} .event-notifications-off`)
    ?.dispatchEvent(createEvent('click'));
  assert.equal(
    (h.doc.querySelector(`#${h.tab} .events-snooze-options`) as Element & {
      style: CSSStyleDeclaration;
    }).style.display,
    'block',
  );
  h.doc.querySelector(`#${h.tab} .snooze-time`)?.dispatchEvent(createEvent('click'));
  const snooze = h.doc.querySelector(`#${h.tab} .events-snooze-info`);
  assert.equal(snooze?.textContent, ENGLISH.NOTIFICATIONS_TURNED_OFF.replace('%1', '30'));
  assert.equal((snooze as Element & { style: CSSStyleDeclaration }).style.display, 'block');
  h.clock.advance(30 * 60_000);
  assert.equal((snooze as Element & { style: CSSStyleDeclaration }).style.display, 'none');
});

test('LonghornStatusUI forwards completed 223 GSV records into Events', () => {
  const h = harness({ isLongHorn: true, model: 'PIM222A' });
  h.manage.mountOperationalPage(h.tab, 'events');
  h.manage.handleLonghornData(h.tab, {
    MessageID: 223,
    Data: [
      { NMEA_TRAKERID: 'GP', PNR: 1, NumberSatellites: 2, MessageNumber: 1 },
      { NMEA_TRAKERID: 'GP', PNR: 2, NumberSatellites: 2, MessageNumber: 1 },
    ],
  });
  assert.ok(
    Object.values(h.manage.configs.events.getEventHandlerObject(h.tab)).some(
      (event) => event.alive && event.description === 'data-lang-gps-tracking-less',
    ),
  );
});
