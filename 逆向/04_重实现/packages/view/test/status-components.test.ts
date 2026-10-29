import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument } from '../src/minidom.ts';
import { createView } from '../src/view.ts';
import { DEFAULT_FEATURES, type FeatureFlags } from '../src/types.ts';
import { createStatusBundle, MSG_ID } from '../src/status/index.ts';
import {
  decodedFixture,
  decodedRepeatedFixture,
  decodedStatusRepeatedFixture,
  englishDictionary,
  htmlFragment,
} from './helpers.ts';
import { newClock } from './helpers.ts';
import { deriveStatusFields } from '../../protocol/src/status-fields.ts';

const TAB = 'tabs-3';
const BASE: FeatureFlags = {
  ...DEFAULT_FEATURES,
  model: 'OEM729',
  generation: 'OEM7',
  spanSupported: true,
  alignSupported: true,
  radioTxSupported: true,
  terrastarSupported: true,
  spoofingSupported: true,
  loggingComponent: true,
  fileSupported: true,
  constellations: ['GPS', 'GLONASS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC', 'SBAS'],
  increasedLogLimit: true,
  positionModes: ['RTK_ROVER', 'PPP'],
};

function harness(
  components: string[],
  overrides: Partial<FeatureFlags> = {},
  contextOverrides: Partial<Parameters<typeof createStatusBundle>[0]> = {},
) {
  const english = englishDictionary();
  const features = { ...BASE, ...overrides };
  const doc = createDocument();
  const statusBar = components.filter((component) => component === 'statusBar');
  const main = components.filter((component) => component !== 'statusBar');
  const fragment = (component: string): string => {
    if (features.isGIII && ['positionStatus', 'deviceInfo', 'logStatus', 'satelliteTracking'].includes(component)) {
      return htmlFragment(component, `giii-${component}.html`);
    }
    if (features.isLongHorn && ['positionStatus', '2d-sd', 'height-sd'].includes(component)) {
      return htmlFragment(component, `lghn-${component}.html`);
    }
    if (component === '2d-sd') return htmlFragment('2d-sd', 'lghn-2d-sd.html');
    if (component === 'height-sd') return htmlFragment('height-sd', 'lghn-height-sd.html');
    return htmlFragment(component);
  };
  doc.body.innerHTML =
    `<div id="${TAB}">` +
    `<div id="status-panel-${TAB}">${statusBar.map(fragment).join('')}</div>` +
    `<div id="main-panel-${TAB}">${main.map(fragment).join('')}</div>` +
    '</div>';
  const view = createView(doc, { activeTab: () => TAB, defaultLocale: 'en-US' });
  const clock = newClock();
  const statuses = createStatusBundle({
    document: doc as unknown as Document,
    view,
    clock,
    features: () => features,
    heightUnit: () => 'MSL',
    connectionType: () => 'eth',
    componentFields: () => undefined,
    deviceTileId: () => 'device-test',
    supportedConstellations: () => features.constellations,
    userData: () => undefined,
    setUserData: () => {},
    messageName: (id) => String(id),
    distanceUnit: () => ' m',
    velocityUnit: () => ' m/s',
    translate: (key) => english[key] ?? key,
    ...contextOverrides,
  });
  return { doc, view, statuses, features, clock };
}

function bestPos(overrides: Record<string, unknown> = {}) {
  return decodedFixture(42, {
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
    satellitesTracked: 12,
    satellitesUsed: 9,
    ...overrides,
  });
}

test('statusBar renders a decoder-produced BESTPOS into the shipped status-bar fragment', () => {
  const { doc, statuses } = harness(['statusBar']);
  assert.equal(statuses.statusBar.updateView(MSG_ID.BESTPOS, { ...bestPos(), tab: TAB }), 3);
  assert.equal(doc.querySelector(`#${TAB} #statusBarlatitude`)!.textContent, '51.1234568°');
  assert.equal(doc.querySelector(`#${TAB} #statusBarlongitude`)!.textContent, '-114.9876543°');
  assert.equal(doc.querySelector(`#${TAB} #statusBarheight`)!.textContent, '100 m');

  const capacity = decodedRepeatedFixture(
    MSG_ID.FILESYSTEMCAPACITY,
    { noOfDevices: 1 },
    [{ massStorageDevice: 'INTERNAL_FLASH', totalStorage: 100, usedStorage: 37 }],
  );
  const capacityData = {
    ...capacity.header,
    ...Object.fromEntries(capacity.blocks.map((row, index) => [String(index), row])),
    blocks: capacity.blocks,
    tab: TAB,
  };
  statuses.statusBar.updateView(MSG_ID.FILESYSTEMCAPACITY, capacityData);
  assert.equal(doc.querySelector(`#${TAB} #statusBarusedStorage`)!.textContent, '37%');
  assert.equal(statuses.statusBar.getInternalFlashOnly(capacityData)?.massStorageDevice, 'INTERNAL_FLASH');
});

test('positionStatus formats the same BESTPOS and applies the solution RAG rule', () => {
  const { doc, statuses } = harness(['positionStatus']);
  statuses.positionStatus.updateStatus(MSG_ID.BESTPOS, { ...bestPos(), tab: TAB });
  assert.equal(doc.querySelector(`#${TAB} #positionStatuslatitude`)!.textContent, '51.1234568°');
  assert.equal(doc.querySelector(`#${TAB} #positionStatuslongitude`)!.textContent, '-114.9876543°');
  assert.equal(doc.querySelector(`#${TAB} #positionStatusheight`)!.textContent, '100 m');
  assert.equal(doc.querySelector(`#${TAB} #positionStatusheightDeviation`)!.textContent, '0.25 m');
  assert.equal(doc.querySelector(`#${TAB} #positionStatusstationId`)!.textContent, '"BASE"');
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'good');
  assert.equal(statuses.positionStatus.solutionStatus[TAB], 'SOL_COMPUTED');
});

test('portStatus builds rows from decoded INTERFACEMODE and PORTSTATS payloads', () => {
  const { doc, statuses } = harness(['portStatus']);
  const interfaceMode = {
    ...decodedFixture(MSG_ID.INTERFACEMODE, { rxType: 'AUTO', txType: 'AUTO', responses: 'ON' }),
    port: 'COM1',
    tab: TAB,
  };
  statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, interfaceMode);
  const stats1 = decodedStatusRepeatedFixture(
    MSG_ID.PORTSTATS,
    { noOfPorts: 1 },
    [{ port: 'COM1', rxChars: 10, txChars: 20 }],
  );
  const stats1Data = { ...stats1.fields, tab: TAB };
  statuses.portStatus.updateStatus(MSG_ID.PORTSTATS, stats1Data);
  assert.ok(doc.querySelector(`#${TAB} #COM1-status-li`));
  assert.equal(statuses.portStatus.ragColor(TAB), 'warning', 'first stats frame has no predecessor');

  const stats2 = decodedStatusRepeatedFixture(
    MSG_ID.PORTSTATS,
    { noOfPorts: 1 },
    [{ port: 'COM1', rxChars: 11, txChars: 21 }],
  );
  statuses.portStatus.updateStatus(MSG_ID.PORTSTATS, { ...stats2.fields, tab: TAB });
  assert.equal(statuses.portStatus.ragColor(TAB), 'good');
  assert.match(doc.querySelector(`#${TAB} #COM1-status-li .port-counters`)!.textContent, /11\/21/);
});

test('deviceInfo computes storage usage and hardware RAG from decoded logs', () => {
  const { doc, statuses } = harness(['deviceInfo']);
  const capacity = decodedStatusRepeatedFixture(
    MSG_ID.FILESYSTEMCAPACITY,
    { noOfDevices: 1 },
    [{ massStorageDevice: 'INTERNAL_FLASH', totalStorage: 200, usedStorage: 170 }],
  );
  statuses.deviceInfo.updateView(MSG_ID.FILESYSTEMCAPACITY, { ...capacity.fields, tab: TAB });
  assert.equal(doc.querySelector(`#${TAB} #deviceInfousedStorage`)!.textContent, '85%');
  assert.equal(statuses.deviceInfo.deviceInfoRAGColor(TAB), 'warning');

  const monitor = decodedStatusRepeatedFixture(
    963,
    { noOfMeasurements: 0 },
    [],
    'OEM7',
    100,
  );
  statuses.deviceInfo.updateView(963, { ...monitor.fields, tab: TAB });
  assert.equal(doc.querySelector(`#${TAB} #deviceInfoidleTime`)!.textContent, '50%');
  assert.equal(statuses.deviceInfo.deviceInfoRAGColor(TAB), 'warning', 'the storage warning remains');

  const lowCapacity = decodedStatusRepeatedFixture(
    MSG_ID.FILESYSTEMCAPACITY,
    { noOfDevices: 1 },
    [{ massStorageDevice: 'INTERNAL_FLASH', totalStorage: 200, usedStorage: 20 }],
  );
  statuses.deviceInfo.updateView(MSG_ID.FILESYSTEMCAPACITY, { ...lowCapacity.fields, tab: TAB });
  assert.equal(statuses.deviceInfo.deviceInfoRAGColor(TAB), 'good');
});

test('spanStatus renders decoded INSPVAX values and classifies INS_SOLUTION_GOOD green', () => {
  const { doc, statuses } = harness(['spanStatus']);
  const ins = decodedFixture(MSG_ID.INSPVAX, {
    status: 'INS_SOLUTION_GOOD',
    posType: 'INS_RTKFIXED',
    latitude: 51.1,
    longitude: -114.2,
    height: 1000,
    undulation: -16,
    azimuth: 90,
    pitch: 2.5,
    roll: -1.25,
    northVelocity: 1.2,
    eastVelocity: 0.8,
    upVelocity: -0.2,
    heightDev: 0.03,
  });
  const imu = decodedFixture(MSG_ID.CONNECTIMU, { IMUPort: 'COM1', IMUType: 'STIM300' });
  const command = decodedFixture(379, { switch: 'ENABLE' });
  statuses.spanStatus.updateSpanStatus(MSG_ID.CONNECTIMU, { ...imu, tab: TAB });
  statuses.spanStatus.updateSpanStatus(379, { ...command, tab: TAB });
  statuses.spanStatus.updateSpanStatus(MSG_ID.INSPVAX, { ...ins, tab: TAB });
  assert.equal(doc.querySelector(`#${TAB} #spanStatusstatusStr`)!.textContent, 'INS Solution Good');
  assert.equal(doc.querySelector(`#${TAB} #spanStatusazimuth`)!.textContent, '90');
  assert.equal(statuses.spanStatus.spanRAGColor(TAB), 'good');
});

test('alignStatus combines decoded config and HEADING2 into the good RAG branch', () => {
  const { doc, statuses } = harness(['alignStatus']);
  const config = {
    ...decodedFixture(MSG_ID.DUALANTENNAALIGN, { switch: 'ENABLE', obsrate: 20, posrate: 5 }),
    tab: TAB,
  };
  const heading = {
    ...decodedFixture(MSG_ID.HEADING2, {
      solStatus: 0,
      posType: 'NARROW_INT',
      length: 2,
      heading: 123.45,
      pitch: 2.5,
      hdgStdDev: 0.1,
      ptchStdDev: 0.2,
    }),
    tab: TAB,
  };
  statuses.alignStatus.updateAlignStatus(MSG_ID.DUALANTENNAALIGN, config);
  statuses.alignStatus.updateAlignStatus(MSG_ID.HEADING2, heading);
  assert.equal(doc.querySelector(`#${TAB} #alignStatusheading`)!.textContent, '123.44999694824219');
  assert.equal(doc.querySelector(`#${TAB} #alignStatuslength`)!.textContent, '2.00 m');
  assert.equal(statuses.alignStatus.ragColor(TAB), 'good');
});

test('radioStatus maps decoded READY/BUSY/ERROR/OFF states exactly', () => {
  const { doc, statuses } = harness(['radioStatus']);
  for (const [state, expected, token] of [
    ['READY', 'good', 'Radio'],
    ['BUSY', 'warning', 'Radio'],
    ['ERROR', 'bad', 'Radio'],
    ['OFF', 'idle', 'Radio - Off'],
  ] as const) {
    const parsed = decodedFixture(MSG_ID.SATELSTATUS, { state, error: 'NONE' });
    statuses.radioStatus.updateStatus(MSG_ID.SATELSTATUS, { ...parsed, tab: TAB });
    assert.equal(statuses.radioStatus.ragColor(TAB), expected);
    assert.equal(doc.querySelector(`#${TAB} .radio-pc-title`)!.textContent, token);
  }
});

test('interferenceStatus renders decoded spectral bands and warns on detection', () => {
  const { doc, statuses } = harness(['interferenceStatus']);
  const parsed = decodedStatusRepeatedFixture(
    MSG_ID.ITDETECTSTATUS,
    { noOfEntries: 1 },
    [{
      rfPath: 'L1',
      detectionType: 'SPECTRALANALYSIS',
      centerFrequency: 1575.42,
    }],
  );
  statuses.interferenceStatus.updateStatus(MSG_ID.ITDETECTSTATUS, {
    ...parsed.fields,
    tab: TAB,
  });
  assert.equal(doc.querySelector(`#${TAB} #interferenceStatusitkState`)!.textContent, 'Detected');
  assert.match(doc.querySelector(`#${TAB} .spectral-bands`)!.textContent, /L1\s*1575 MHz/);
  assert.equal(statuses.interferenceStatus.ITKRagColor(TAB), 'warning');
});

test('logStatus translates decoded FILESTATUS enums into the shipped logging rows', () => {
  const { doc, statuses } = harness(['logStatus']);
  const logs = decodedStatusRepeatedFixture(
    MSG_ID.LOGLIST,
    { noOfLogs: 1 },
    [{ port: 'FILE', message: 42, messageType: 0 }],
  );
  statuses.logStatus.updateData(MSG_ID.LOGLIST, {
    ...logs.fields,
    tab: TAB,
  });
  assert.match(doc.querySelector(`#${TAB} #logStatus-msg-list`)!.textContent!, /42/);
  const status = decodedFixture(MSG_ID.FILESTATUS, { fileStatusEnum: 'UNMOUNTED' });
  statuses.logStatus.updateLogStatus(MSG_ID.FILESTATUS, {
    ...status,
    tab: TAB,
    fileName: 'field.log',
    fileSize: 25_600,
  });
  assert.equal(doc.querySelector(`#${TAB} #logStatusfilestatus`)!.textContent, 'Active');
  assert.equal(doc.querySelector(`#${TAB} #logStatusfilename`)!.textContent, 'field.log');
  assert.equal(doc.querySelector(`#${TAB} #logStatusfilesize`)!.textContent, '26 KB');
  assert.equal(statuses.logStatus.loggingRAGColor(TAB), 'good');
});

test('agcStatus derives card/RF and warning conditions from the decoded statusWord', () => {
  const { doc, statuses } = harness(['agcStatus'], { generation: 'GIII', isGIII: true });
  const word = (3 << 28) | (1 << 25);
  const parsed = decodedStatusRepeatedFixture(
    MSG_ID.AGCINFO,
    { noOfEntries: 1 },
    [{
      statusWord: word,
      pulseWidth: 500,
      modulus: 1024,
      bin1: 1,
      bin2: 2,
      bin3: 3,
      bin4: 4,
      bin5: 5,
      bin6: 6,
    }],
    'GIII',
  );
  statuses.agcStatus.dc_updateData(MSG_ID.AGCINFO, { ...parsed.fields, tab: TAB });
  assert.match(doc.querySelector(`#${TAB} #agc-card-items`)!.textContent, /DSPC1/);
  assert.match(
    doc.querySelector(`#${TAB} .agc-display-dataContainer`)!.textContent,
    /Pulse Width\s*500/,
  );
  assert.ok(doc.querySelector(`#${TAB} .agc-info-outer.agc-header`));
  assert.ok(doc.querySelector(`#${TAB} tr.agcInfo-entries-outer td.agc-heading-outer`));
  assert.match(doc.querySelector(`#${TAB} #agcStatusPlot-${TAB}`)!.textContent, /L2/);
});

test('pppCorrections builds beam rows from decoded LBANDTRACKSTAT and subscription info', () => {
  const { doc, statuses } = harness(['pppCorrections']);
  const info = {
    ...decodedFixture(MSG_ID.TERRASTARINFO, {
      pac: 'PAC',
      subscriptionType: 1,
      subscriptionService: 1,
      serviceEndDay: 1,
      serviceEndYear: 2027,
      regionRestriction: 0,
      centerPointLatitude: 0,
      centerPointLongitude: 0,
      radius: 0,
    }),
    tab: TAB,
  };
  const track = decodedStatusRepeatedFixture(
    MSG_ID.LBANDTRACKSTAT,
    { noOfEntries: 1 },
    [{
      name: 'SID08',
      frequency: 1545,
      baud_rate: 2400,
      id: 1,
      status: 2,
      doppler: 1.5,
      'C/No': 45.5,
      phaseStdDev: 0.1,
      lockTime: 1,
      uniqueWordBits: 10,
      badUniqueWordBits: 0,
      badUniqueWords: 0,
      viterbiSymbols: 10,
      correctedViterbi: 9,
      biterrorRate: 0.001,
    }],
  );
  statuses.pppCorrections.updateStatus(MSG_ID.TERRASTARINFO, info);
  statuses.pppCorrections.updateStatus(MSG_ID.LBANDTRACKSTAT, {
    ...track.fields,
    tab: TAB,
  });
  assert.match(
    doc.querySelector(`#${TAB} #signalStrength .row.ppp-cno-val`)!.textContent!,
    /SID08.*45\.50 dB\/Hz/,
  );
  assert.equal(
    doc.querySelector(`#${TAB} #bitSuccessRate .row.ppp-cno-val .component-value`)?.textContent,
    '99.90 %',
  );
});

test('pppCorrections sorts beams together, applies disconnect widths and mirrors Show/Hide Details', () => {
  const { doc, statuses } = harness(['pppCorrections']);
  statuses.pppCorrections.updateStatus(MSG_ID.TERRASTARINFO, {
    ...decodedFixture(MSG_ID.TERRASTARINFO, { subscriptionService: 1 }),
    tab: TAB,
  });
  const track = decodedStatusRepeatedFixture(
    MSG_ID.LBANDTRACKSTAT,
    { noOfEntries: 4 },
    [
      { name: 'LOW', frequency: 1545, status: 2, 'C/No': 35, biterrorRate: 0.1 },
      { name: 'LbandCno', frequency: 1545, status: 2, 'C/No': 99, biterrorRate: 0 },
      { name: 'HIGH', frequency: 1545, status: 2, 'C/No': 45, biterrorRate: 0.001 },
      { name: 'MID', frequency: 1545, status: 2, 'C/No': 38, biterrorRate: 0.05 },
    ],
  );
  statuses.pppCorrections.updateStatus(MSG_ID.LBANDTRACKSTAT, {
    ...track.fields,
    tab: TAB,
  });
  const ids = doc
    .querySelectorAll(`#${TAB} #signalStrength .row.ppp-cno-val`)
    .map((row) => row.id);
  assert.deepEqual(ids, ['HIGH', 'MID', 'LOW']);
  assert.deepEqual(
    doc.querySelectorAll(`#${TAB} #bitSuccessRate .row.ppp-cno-val`).map((row) => row.id),
    ids,
  );
  assert.equal(doc.querySelector(`#${TAB} [id="LbandCno"]`), null);

  const button = doc.querySelector(`#${TAB} .switch-show-hide-details`)!;
  assert.ok(button.classList.contains('show-details'));
  button.click();
  assert.ok(button.classList.contains('hide-details'));
  assert.equal(button.textContent, englishDictionary().HIDE_DETAILS);
  assert.ok(
    doc
      .querySelectorAll(`#${TAB} #signalStrength .row.ppp-cno-val`)
      .every((row) => row.style.display === 'block'),
  );
  button.click();
  assert.ok(button.classList.contains('show-details'));
  assert.equal(button.textContent, englishDictionary().SHOW_DETAILS);
  assert.equal(
    doc
      .querySelectorAll(`#${TAB} #signalStrength .row.ppp-cno-val`)
      .filter((row) => row.style.display !== 'none').length,
    1,
  );

  statuses.pppCorrections.pppRagStatus[TAB].satelliteStatusStats = { access: 1, syncState: 0 };
  statuses.pppCorrections.updateStatus(MSG_ID.LBANDTRACKSTAT, {
    ...track.fields,
    tab: TAB,
  });
  for (const fill of doc.querySelectorAll(`#${TAB} #signalStrength .progress-bar-fill`)) {
    assert.match(fill.getAttribute('style') ?? '', /width:\s*0px/);
  }
  statuses.pppCorrections.resetDataObject(TAB);
  assert.ok(statuses.pppCorrections.pppRagStatus[TAB], 'resetDataObject leaves pppRagStatus intact');
});

test('satelliteView calculates VDOP from decoded PSRDOP and writes count buckets', () => {
  const { doc, statuses } = harness(['satelliteView']);
  const dop = decodedFixture(MSG_ID.PSRDOP, {
    gdop: 3,
    pdop: 2.5,
    hdop: 1.2,
    htdop: 2,
    tdop: 1,
    cutoff: 5,
    prnCount: 9,
    prnList: 1,
  });
  statuses.satelliteView.updateData(MSG_ID.PSRDOP, { ...dop, tab: TAB });
  assert.equal(doc.querySelector(`#${TAB} #satelliteViewpdop`)!.textContent, '2.500');
  assert.equal(doc.querySelector(`#${TAB} #satelliteViewhdop`)!.textContent, '1.200');
  assert.equal(doc.querySelector(`#${TAB} #satelliteViewvdop`)!.textContent, '2.193');
});

test('satelliteView places decoded SATVIS/Trackstat records in the shipped sky circle', () => {
  const { doc, statuses } = harness(['satelliteView']);
  const satvis = decodedStatusRepeatedFixture(
    MSG_ID.SATVIS2,
    { satelliteSystem: 0, numberOfSatellites: 1 },
    [{ satelliteId: 7, health: 0, elevation: 45, azimuth: 90 }],
  );
  statuses.satelliteView.updateData(MSG_ID.SATVIS2, {
    ...satvis.fields,
    tab: TAB,
  });
  const track = decodedStatusRepeatedFixture(
    MSG_ID.TRACKSTAT,
    { numberOfChannels: 1 },
    [{
      PRN: 7,
      channelTrackingStatus: 0x04,
      carrierNoiseRatio: 45,
      reject: 0,
    }],
  );
  statuses.satelliteView.updateData(MSG_ID.TRACKSTAT, {
    ...track.fields,
    tab: TAB,
  });
  const marker = doc.querySelector(`#${TAB} .satelliteview-main-circle #GPS7`) as HTMLElement;
  assert.ok(marker);
  assert.equal(marker.getAttribute('sys'), 'GPS');
  assert.equal(marker.getAttribute('prn'), '7');
  assert.equal(marker.querySelector('.customPRNnumber')?.textContent, '7');
  assert.ok(marker.classList.contains('satellite-good'));
  assert.match(marker.style.left, /^\d/);
  assert.match(marker.style.top, /^\d/);
});

test('satelliteTracking consumes decoded TRACKSTAT blocks and renders numeric signal values', () => {
  const { doc, statuses } = harness(['satelliteTracking'], { generation: 'OEM7' });
  const track = decodedStatusRepeatedFixture(
    MSG_ID.TRACKSTAT,
    { numberOfChannels: 5 },
    Array.from({ length: 5 }, (_, index) => ({
      PRN: index + 1,
      channelTrackingStatus: 0x04,
      pseudoRange: 20_000_000 + index,
      doppler: 1,
      carrierNoiseRatio: 40 + index,
      lockTime: 60,
      pseudoRangeResidual: 0.1,
      reject: 0,
      pseudoRangeWeight: 1,
    })),
  );
  const rx = {
    ...decodedFixture(MSG_ID.RXSTATUS, { rxerror: 0, noofstats: 1, rxstatus: 0, aux1status: 0, aux2status: 0, aux3status: 0, aux4status: 0 }),
    aux4statusBit: 0,
    tab: TAB,
  };
  statuses.satelliteTracking.dc_updateData(MSG_ID.RXSTATUS, rx);
  statuses.satelliteTracking.dc_updateData(MSG_ID.TRACKSTAT, {
    ...track.fields,
    tab: TAB,
  });
  assert.equal(doc.querySelectorAll(`#${TAB} .tracking-point`).length, 5);
  assert.match(doc.querySelector(`#${TAB} .satelliteTrackingChart`)!.textContent!, /GPS 1 · 40\.0 dB-Hz/);
  // satelliteTracking.js only assigns trackingRAGStatus on amber/red paths.
  assert.equal(statuses.satelliteTracking.trackingRAGStatus[TAB], undefined);

  statuses.satelliteTracking.dc_updateData(MSG_ID.RXSTATUS, {
    ...rx,
    aux4statusBit: 2,
  });
  statuses.satelliteTracking.dc_updateData(MSG_ID.TRACKSTAT, {
    ...track.fields,
    tab: TAB,
  });
  assert.equal(statuses.satelliteTracking.trackingRAGStatus[TAB], 'tracking-AUX4-Bad');
});

test('satelliteTracking expands current CHANCONFIG signals into one bar trace per signal', () => {
  const { doc, statuses } = harness(['satelliteTracking'], { generation: 'OEM7' });
  const payload = new Uint8Array(8 + 4 + 16 + 4 + 8);
  const bytes = new DataView(payload.buffer);
  bytes.setUint32(0, 1, true); // setInUse = first config
  bytes.setUint32(4, 2, true); // two configurations
  bytes.setUint32(8, 2, true); // current config contains two signal records
  bytes.setUint32(12, 8, true);
  bytes.setUint32(16, 0, true); // GPSL1
  bytes.setUint32(20, 8, true);
  bytes.setUint32(24, 5, true); // GPSL5
  bytes.setUint32(28, 1, true); // non-current config
  bytes.setUint32(32, 4, true);
  bytes.setUint32(36, 0, true);
  const chan = deriveStatusFields(1148, payload, {}, [], 'OEM7').fields;
  statuses.satelliteTracking.dc_updateData(MSG_ID.CHANCONFIGLIST, { ...chan, tab: TAB });
  assert.deepEqual(statuses.satelliteTracking.supportedSignals[TAB].get('GPS'), ['L1CA', 'L5']);

  const satvis = decodedStatusRepeatedFixture(
    MSG_ID.SATVIS2,
    { satelliteSystem: 0, numberOfSatellites: 1 },
    [{ satelliteId: 7, health: 0, elevation: 45, azimuth: 120 }],
  );
  statuses.satelliteTracking.dc_updateData(MSG_ID.SATVIS2, { ...satvis.fields, tab: TAB });

  const statusFor = (signal: number, channel: number) =>
    0x04 | (signal << 21) | (channel << 5);
  const track = decodedStatusRepeatedFixture(
    MSG_ID.TRACKSTAT,
    { numberOfChannels: 2 },
    [
      {
        PRN: 7,
        channelTrackingStatus: statusFor(0, 3),
        carrierNoiseRatio: 44,
        lockTime: 120,
        reject: 0,
      },
      {
        PRN: 7,
        channelTrackingStatus: statusFor(14, 5),
        carrierNoiseRatio: 0,
        lockTime: 10,
        reject: 99,
      },
    ],
  );
  const captured: Array<{ data: LogData[]; layout: LogData }> = [];
  const runtime = globalThis as typeof globalThis & {
    Plotly?: { react?: (id: string, data: LogData[], layout: LogData) => unknown };
  };
  const prior = runtime.Plotly;
  runtime.Plotly = {
    react: (_id, data, layout) => {
      captured.push({ data, layout });
    },
  };
  try {
    statuses.satelliteTracking.dc_updateData(MSG_ID.TRACKSTAT, {
      ...track.fields,
      tab: TAB,
    });
  } finally {
    runtime.Plotly = prior;
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].data.length, 2, 'one trace for each current CHANCONFIG signal');
  assert.equal(captured[0].data[0].name, 'Data-0');
  assert.equal(captured[0].data[1].name, 'Data-1');
  assert.deepEqual(captured[0].data[0].x, ['<b>7</b>|45°']);
  assert.deepEqual(captured[0].data[0].y, [44]);
  assert.deepEqual(captured[0].data[1].y, [0]);
  assert.equal(statuses.satelliteTracking.trackingData[TAB].PRIMARY!.GPS[0].channelNumber, 3);
  assert.match(
    doc.querySelector(`#${TAB} .trackingTileYLabel`)!.textContent!,
    /Carrier-to-noise Ratio/,
  );
});

test('satelliteTracking lock-time graph applies the shipped display scale and persists graph choice', () => {
  const { doc, statuses } = harness(['satelliteTracking'], { generation: 'OEM7' });
  statuses.satelliteTracking.resetTrackingUI(TAB);
  const graph = doc.querySelector(`#${TAB} #lockTime`) as HTMLElement;
  graph.click();
  assert.equal(statuses.satelliteTracking.ui[TAB].graph, 'lockTime');
  assert.match(doc.querySelector(`#${TAB} .trackingTileYLabel`)!.textContent!, /Lock Time/);

  const track = decodedStatusRepeatedFixture(
    MSG_ID.TRACKSTAT,
    { numberOfChannels: 1 },
    [{
      PRN: 2,
      channelTrackingStatus: 0x04,
      carrierNoiseRatio: 44,
      lockTime: 5000,
      reject: 0,
    }],
  );
  const captured: LogData[] = [];
  const runtime = globalThis as typeof globalThis & {
    Plotly?: { react?: (id: string, data: LogData[], layout: LogData) => unknown };
  };
  const prior = runtime.Plotly;
  runtime.Plotly = {
    react: (_id, data) => {
      captured.push(...data);
    },
  };
  try {
    statuses.satelliteTracking.dc_updateData(MSG_ID.TRACKSTAT, {
      ...track.fields,
      tab: TAB,
    });
  } finally {
    runtime.Plotly = prior;
  }
  assert.deepEqual(captured[0].y, [3650], 'lock times over an hour sit just above the 3600 line');
  assert.deepEqual(statuses.satelliteTracking.highestLowestData[TAB]?.GPS ?? [], []);
});

test('satelliteTracking Plotly hover fills and hides the shipped context menu', () => {
  const { doc, statuses } = harness(['satelliteTracking'], { generation: 'OEM7' });
  const track = decodedStatusRepeatedFixture(
    MSG_ID.TRACKSTAT,
    { numberOfChannels: 1 },
    [{
      PRN: 7,
      channelTrackingStatus: 0x04,
      carrierNoiseRatio: 45,
      lockTime: 125,
      reject: 0,
    }],
  );
  const handlers: Record<string, (event: LogData) => void> = {};
  const runtime = globalThis as typeof globalThis & {
    Plotly?: {
      react?: (id: string, data: LogData[], layout: LogData) => {
        on: (name: string, fn: (event: LogData) => void) => void;
      };
    };
  };
  const prior = runtime.Plotly;
  runtime.Plotly = {
    react: () => ({
      on: (name, fn) => {
        handlers[name] = fn;
      },
    }),
  };
  try {
    statuses.satelliteTracking.dc_updateData(MSG_ID.TRACKSTAT, {
      ...track.fields,
      tab: TAB,
    });
  } finally {
    runtime.Plotly = prior;
  }
  handlers.plotly_hover({
    points: [{ customdata: [7, 180, 0, 'L1CA'], x: '<b>7</b>|45°' }],
    event: { clientX: 50, clientY: 60 },
  });
  const menu = doc.querySelector(`#${TAB} .satellite-info-contextmenu`) as HTMLElement;
  assert.equal(menu.style.display, 'block');
  assert.equal(menu.querySelector('#contextSatellitePRNno')?.textContent, '7');
  assert.match(menu.querySelector('.satellite-data-entries')!.textContent!, /GPS L1CA/);
  assert.match(menu.querySelector('.satellite-data-entries')!.textContent!, /45\.0 dB-Hz/);
  handlers.plotly_unhover({});
  assert.equal(menu.style.display, 'none');
});

test('satelliteTracking preserves the no-GPS AUX4 branch and exposes dialog lifecycle hooks', () => {
  const { statuses } = harness(['satelliteTracking'], { generation: 'OEM7' });
  const rx = {
    ...decodedFixture(MSG_ID.RXSTATUS, {
      rxerror: 0,
      noofstats: 1,
      rxstatus: 0,
      aux1status: 0,
      aux2status: 0,
      aux3status: 0,
      aux4status: 2,
    }),
    aux4statusBit: 2,
    tab: TAB,
  };
  const glonass = decodedStatusRepeatedFixture(
    MSG_ID.TRACKSTAT,
    { numberOfChannels: 1 },
    [{
      PRN: 12,
      channelTrackingStatus: (1 << 16) | 0x04,
      carrierNoiseRatio: 40,
      reject: 0,
    }],
  );
  statuses.satelliteTracking.dc_updateData(MSG_ID.RXSTATUS, rx);
  statuses.satelliteTracking.dc_updateData(MSG_ID.TRACKSTAT, {
    ...glonass.fields,
    tab: TAB,
  });
  assert.equal(statuses.satelliteTracking.decodeTrackingStatusRagMessages(TAB), 'tracking-AUX4-Bad');

  statuses.satelliteTracking.satelliteDialogOpen[TAB] = true;
  statuses.satelliteTracking.dataDialogClosed(TAB);
  assert.equal(statuses.satelliteTracking.satelliteDialogOpen[TAB], false);
  assert.doesNotThrow(() => statuses.satelliteTracking.handleTabClick(TAB));
});

test('GIII satellite tracking converts MEASUREMENTDATA and SATPOS records into the shared track/visibility model', () => {
  const { doc, statuses } = harness(['satelliteTracking'], {
    generation: 'GIII',
    isGIII: true,
    model: 'GIII',
    constellations: ['GPS', 'GALILEO', 'NAVIC'],
  });
  statuses.satelliteTracking.dc_updateData(MSG_ID.CHANCONFIGLIST, {
    tab: TAB,
    currentChanConfigData: [],
  });
  const satpos = decodedStatusRepeatedFixture(
    MSG_ID.GIII_SATPOS,
    { satelliteSystem: 0, numberOfSatellites: 1 },
    [{
      prn: 7,
      PRN: 7,
      almHealth: 0,
      ephElevation: 40,
      ephAzimuth: 200,
      almDop: 0,
    }],
    'GIII',
  );
  statuses.satelliteTracking.dc_updateData(MSG_ID.GIII_SATPOS, {
    ...satpos.fields,
    tab: TAB,
  });
  const measurement = decodedStatusRepeatedFixture(
    MSG_ID.GIII_MEASUREMENTDATA,
    { count: 1 },
    [{
      PRN: 7,
      svChan: 4,
      trackType: 4,
      PSR: 20_000_000,
      PSRstd: 0.1,
      dopp: 1,
      CNO: 70,
      lockTime: 120,
    }],
    'GIII',
  );
  const captured: LogData[][] = [];
  const runtime = globalThis as typeof globalThis & {
    Plotly?: { react?: (id: string, data: LogData[], layout: LogData) => unknown };
  };
  const prior = runtime.Plotly;
  runtime.Plotly = {
    react: (_id, data) => {
      captured.push(data);
    },
  };
  try {
    statuses.satelliteTracking.dc_updateData(MSG_ID.GIII_MEASUREMENTDATA, {
      ...measurement.fields,
      tab: TAB,
    });
  } finally {
    runtime.Plotly = prior;
  }
  assert.equal(statuses.satelliteTracking.trackingData[TAB].PRIMARY!.GPS[0].cno, 60);
  assert.equal(statuses.satelliteTracking.trackingData[TAB].PRIMARY!.GPS[0].channelNumber, 4);
  assert.equal(statuses.satelliteTracking.visibilityData[TAB].GPS[0].elevation, 40);
  assert.equal(captured.at(-1)![0].name, 'Data-0');
  assert.equal(statuses.satelliteTracking.decodeTrackingStatusRagMessages(TAB), 'nofixgiiitrackingred');
  assert.ok(doc.querySelector(`#${TAB} .giiisatelliteTrackingStatus .red-status`));
});

test('longhornStatusUI renders SD values and positions from parsed receiver records', () => {
  const { doc, statuses } = harness(['2d-sd', 'height-sd', 'positionStatus'], { isLongHorn: true });
  const gst = {
    MessageID: 222,
    Data: [{ STDLatitude: 0.01, STDLongitude: 0.02, STDAltitude: 0.03 }],
  };
  statuses.longhornStatusUI.uiUpdate(gst, TAB);
  assert.match(doc.querySelector(`#${TAB} .2d-sd-container`)!.textContent, /2D SD: 2\.24 cm/);
  assert.match(doc.querySelector(`#${TAB} .height-sd-container`)!.textContent, /Height SD: 3\.00 cm/);
  assert.equal(doc.querySelector(`#${TAB} #positionStatusstandard2D`)!.textContent, '2.24 cm');

  statuses.longhornStatusUI.uiUpdate(
    { messageId: MSG_ID.BESTPOS, fields: bestPos(), tab: TAB },
    TAB,
  );
  assert.equal(doc.querySelector(`#${TAB} #positionStatuslatitude`)!.textContent, '51.1234568°');
});

test('statusBar combines positioning and device RAG with the original precedence', () => {
  const { doc, statuses } = harness(['statusBar']);
  statuses.positionStatus.posragIndicatorColor[TAB] = 'warning';
  statuses.spanStatus.spanRAGIndicatorColor[TAB] = 'good';
  statuses.deviceInfo.deviceRAGIndicatorColor[TAB] = 'bad';
  statuses.interferenceStatus.ITKRagIndicatorColor[TAB] = 'good';
  statuses.logStatus.loggingRAGIndicatorColor[TAB] = 'good';
  statuses.statusBar.updateView(MSG_ID.VERSION, {
    tab: TAB,
    hardwareVersion: '1.2.3',
  });
  assert.equal(
    (doc.querySelector(`#${TAB} .positioning-traffic .yellow-status`) as HTMLElement).style.display,
    'block',
  );
  assert.equal(
    (doc.querySelector(`#${TAB} .device-traffic .red-status`) as HTMLElement).style.display,
    'block',
  );
});

test('statusBar preserves RXSTATUS missing-bit behaviour and spoofing markers', () => {
  const { doc, statuses } = harness(['statusBar']);
  statuses.statusBar.updateView(MSG_ID.SKDETECTCONFIG, { tab: TAB, mode: 'ENABLE' });
  const rx = decodedFixture(MSG_ID.RXSTATUS, {
    rxerror: 0,
    noofstats: 1,
    rxstatus: 0,
    aux1status: 0,
    aux2status: 0,
    aux3status: 0,
    aux4status: 0,
  });
  statuses.statusBar.updateView(MSG_ID.RXSTATUS, { ...rx, tab: TAB });
  const spoofing = doc.querySelector(`#${TAB} #statusBarspoofing`)!;
  assert.equal(spoofing.textContent, '--');
  assert.equal(spoofing.hasAttribute('data-lang-not-detected'), false);
  assert.equal(statuses.statusBar.state.spoofingRAGColor[TAB], 'good');
});

test('statusBar copies the configured-position markup from positionStatus', () => {
  const { doc, statuses } = harness(['statusBar', 'positionStatus']);
  const source = doc.querySelector(`#${TAB} #positionStatusConfiguredPosition`)!;
  source.innerHTML = '<span id="RTKstatus" class="posmodes RTK">RTK</span>';
  statuses.statusBar.updateView(MSG_ID.BESTPOS, { ...bestPos(), tab: TAB });
  const copied = doc.querySelector(`#${TAB} #statusBarConfiguredPosition`)!;
  assert.equal(copied.innerHTML, '<span id="RTKstatus" class="posmodes RTK elidedText">RTK</span>');
  assert.ok(copied.querySelector('span')!.classList.contains('elidedText'));
});

test('statusBar red positioning light opens the decoded diagnostic dialog', () => {
  let opened: LogData | undefined;
  const { doc, statuses } = harness(
    ['statusBar', 'positionStatus'],
    {},
    {
      openDialog: (options) => {
        opened = options as unknown as LogData;
      },
    },
  );
  statuses.positionStatus.solutionStatus[TAB] = 'NO_CONVERGENCE';
  statuses.positionStatus.posragIndicatorColor[TAB] = 'bad';
  statuses.spanStatus.spanRAGIndicatorColor[TAB] = 'good';
  statuses.deviceInfo.deviceRAGIndicatorColor[TAB] = 'good';
  statuses.interferenceStatus.ITKRagIndicatorColor[TAB] = 'good';
  statuses.logStatus.loggingRAGIndicatorColor[TAB] = 'good';
  statuses.statusBar.updateView(MSG_ID.VERSION, { tab: TAB, hardwareVersion: '1.0' });
  doc.querySelector(`#${TAB} .positioning-traffic .red-status`)!.click();
  const english = englishDictionary();
  assert.equal(opened?.title, `${english.POSITIONING} - ${english.WHY_IS_THIS_RED}`);
  assert.match(String(opened?.content), new RegExp(english.NO_CONVERGENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('positionStatus covers red, survey, PSRDIFF and PPP warning branches', () => {
  const { statuses } = harness(['positionStatus']);
  statuses.positionStatus.updateStatus(MSG_ID.BESTPOS, {
    ...bestPos({ solutionStatus: 'INSUFFICIENT_OBS' }),
    tab: TAB,
  });
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'bad');

  statuses.positionStatus.updateStatus(MSG_ID.BESTPOS, {
    ...bestPos({ positionType: 'PPP_CONVERGING' }),
    tab: TAB,
    configuredPositionModes: ['PPP'],
  });
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'warning');

  statuses.positionStatus.positionStatusObj[TAB].aveposData = { posaveStatus: 'INPROGRESS' };
  statuses.positionStatus.updateStatus(MSG_ID.BESTPOS, {
    ...bestPos({ positionType: 'NARROW_INT' }),
    tab: TAB,
    configuredPositionModes: ['RTK ROVER'],
  });
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'warning');
});

test('positionStatus ranks configured modes in RTK PPP PSRDIFF SBAS order and maps NTRIP to RTK', () => {
  const { doc, statuses } = harness(['positionStatus']);
  statuses.positionStatus.solutionStatus[TAB] = 'SOL_COMPUTED';
  statuses.positionStatus.positionType[TAB] = 'NARROW_INT';
  statuses.positionStatus.updatePositionModes(
    ['SBAS', 'RTK ROVER'],
    ['NTRIP CLIENT'],
    TAB,
  );
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'good');
  assert.ok(doc.querySelector(`#${TAB} .RTK.activePosMode`));
  assert.equal((doc.querySelector(`#${TAB} #RTK`) as HTMLElement).style.display, 'inline-block');

  statuses.positionStatus.updatePositionModes(['RTK ROVER', 'SBAS'], ['SBAS'], TAB);
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'warning');
});

test('positionStatus GIII RXCOMMANDS extracts FIX coordinates and clock RAG', () => {
  const { doc, statuses } = harness(['positionStatus', 'statusBar'], {
    generation: 'GIII',
    isGIII: true,
  });
  statuses.positionStatus.updateGIIIStatus(MSG_ID.GIII_RXCOMMANDS, {
    tab: TAB,
    configData: ['FIX 2 51.1234567 -114.7654321 123.456'],
  });
  assert.equal(doc.querySelector(`#${TAB} #positionStatuslatitude`)!.textContent, '51.1234567°');
  assert.equal(doc.querySelector(`#${TAB} #positionStatuslongitude`)!.textContent, '-114.7654321°');
  assert.equal(doc.querySelector(`#${TAB} #positionStatusheight`)!.textContent, '123.46 m');
  assert.equal(doc.querySelector(`#${TAB} #statusBarheightGIII`)!.textContent, '123.46 m');

  statuses.positionStatus.updateGIIIStatus(MSG_ID.GIII_TIMESOLUTION, {
    tab: TAB,
    clockModel: 'Computed',
    signalType: 'L1 C/A GPS',
    clockOffset: 1.25,
    offsetStd: 0.1,
    clockDrift: 0.02,
  });
  assert.equal(statuses.positionStatus.posRAGColor(TAB), 'good');
});

test('portStatus filters unsupported ports, removes NONE ports and flags RX overflow red', () => {
  const { doc, statuses } = harness(['portStatus']);
  statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, {
    tab: TAB,
    port: 'FILE',
    rxType: 'AUTO',
    txType: 'AUTO',
  });
  assert.equal(doc.querySelector(`#${TAB} #port-dynamic-list`)!.children.length, 0);

  statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, {
    tab: TAB,
    port: 'COM2',
    rxType: 'AUTO',
    txType: 'AUTO',
  });
  statuses.portStatus.updateStatus(MSG_ID.PORTSTATS, {
    tab: TAB,
    port: 'COM2',
    rxChars: 1,
    txChars: 1,
  });
  statuses.portStatus.updateData(MSG_ID.RXSTATUS, {
    tab: TAB,
    portsRxData: [{ port: 'COM2', bits: 1 }],
  });
  assert.equal(statuses.portStatus.ragColor(TAB), 'bad');
  assert.ok(doc.querySelector(`#${TAB} #COM2-port-input.red-status`));
});

test('portStatus applies OEM638, PwrPak7/MarinePak and connected-port exclusions', () => {
  const oldOem = harness(['portStatus'], { model: 'OEM729' });
  oldOem.statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, {
    tab: TAB,
    port: 'COM6',
    rxType: 'AUTO',
    txType: 'AUTO',
    sequence: 0,
  });
  assert.equal(oldOem.doc.querySelector(`#${TAB} #COM6-status-li`), null);

  const oem638 = harness(['portStatus'], { model: 'OEM638' });
  oem638.statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, {
    tab: TAB,
    port: 'COM6',
    rxType: 'AUTO',
    txType: 'AUTO',
    sequence: 0,
  });
  assert.ok(oem638.doc.querySelector(`#${TAB} #COM6-status-li`));

  const marine = harness(['portStatus'], { model: 'PwrPak7D', isMarinePak: true });
  for (const port of ['COM4', 'USB1', 'ETH1']) {
    marine.statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, {
      tab: TAB,
      port,
      rxType: 'AUTO',
      txType: 'AUTO',
      sequence: 0,
    });
  }
  assert.equal(marine.doc.querySelector(`#${TAB} #COM4-status-li`), null);
  assert.equal(marine.doc.querySelector(`#${TAB} #USB1-status-li`), null);
  assert.ok(marine.doc.querySelector(`#${TAB} #ETH1-status-li`));

  const connected = harness(
    ['portStatus'],
    { model: 'PwrPak7D', isMarinePak: true },
    { connectedPortName: () => 'ETH2' },
  );
  connected.statuses.portStatus.updateData(MSG_ID.INTERFACEMODE, {
    tab: TAB,
    port: 'ETH2',
    rxType: 'AUTO',
    txType: 'AUTO',
    sequence: 0,
  });
  assert.equal(connected.doc.querySelector(`#${TAB} #ETH2-status-li`), null);
});

test('deviceInfo threshold boundaries and OEMSTAR voltage quirks are preserved', () => {
  const { doc, statuses } = harness(['deviceInfo']);
  statuses.deviceInfo.fsDictionary[TAB] = { storageUsage: 90 };
  statuses.deviceInfo.updateView(MSG_ID.RXSTATUS, { tab: TAB, rxstatus3bit: 0 });
  assert.equal(statuses.deviceInfo.deviceInfoRAGColor(TAB), 'warning');
  statuses.deviceInfo.fsDictionary[TAB] = { storageUsage: 91 };
  statuses.deviceInfo.updateView(MSG_ID.RXSTATUS, { tab: TAB, rxstatus3bit: 0 });
  assert.equal(statuses.deviceInfo.deviceInfoRAGColor(TAB), 'bad');

  const star = harness(['deviceInfo'], { generation: 'OEMSTAR' });
  star.statuses.deviceInfo.updateView(963, {
    tab: TAB,
    noOfMeasurements: 2,
    reading: 0,
    status: 0,
    idleTime: 20,
    antennaVoltage: 3.3,
    antennaCurrent: 0.01,
  });
  assert.equal(star.doc.querySelector(`#${TAB} #deviceInfoantennaVoltage`)!.textContent, '--');
  assert.equal(star.doc.querySelector(`#${TAB} #deviceInfoantennaCurrent`)!.textContent, '--');
  assert.equal(
    (star.doc.querySelector(`#${TAB} .antenna-power`) as HTMLElement).style.display,
    'block',
  );
});

test('deviceInfo GIII cards collapse duplicate module slots and emit parameterized red diagnostics', () => {
  const { doc, statuses } = harness(['deviceInfo'], { generation: 'GIII', isGIII: true });
  const cards = decodedStatusRepeatedFixture(
    MSG_ID.GIII_CARDSTATUS,
    { state: 'Configuration', mode: 'Normal', attenSetting: 4, cardsCount: 3 },
    [
      { component: 'RFCC', moduleId: 2, idleTime: 5, value_1: 50, warningWord: 0 },
      { component: 'IOMASTER', moduleId: 1, idleTime: 5, value_1: 40, warningWord: 0 },
      { component: 'IOMASTER', moduleId: 1, idleTime: 90, value_1: 10, warningWord: 1 },
    ],
    'GIII',
  );
  statuses.deviceInfo.updateView(MSG_ID.GIII_CARDSTATUS, {
    ...cards.fields,
    tab: TAB,
  });
  assert.equal(doc.querySelectorAll(`#${TAB} .giii-card-entries .device-iomaster`).length, 2);
  assert.equal(doc.querySelector(`#${TAB} .giii-card-entries .cpu-usage`)?.textContent?.includes('CPU Usage'), true);
  assert.ok(doc.querySelector(`#${TAB} #deviceInfoState[data-lang-configuration]`));
  assert.equal(
    statuses.deviceInfo.deviceInfoRAGColor(TAB),
    'bad',
    JSON.stringify(statuses.deviceInfo.RAGTexts[TAB]),
  );
  assert.deepEqual(statuses.deviceInfo.decodeDeviceStatusRagMessages(TAB)?.red, [
    { CPUUSAGE_RED_PARAMETER: 'IOMaster ' },
  ]);
});

test('logStatus GIII has no firmware-active state without local logging', () => {
  const { doc, statuses } = harness(['logStatus', 'statusBar'], {
    generation: 'GIII',
    isGIII: true,
    loggingComponent: true,
  });
  statuses.logStatus.updateLogStatus(MSG_ID.FILESTATUS, {
    ...decodedFixture(MSG_ID.FILESTATUS, { fileStatusEnum: 'UNMOUNTED' }),
    tab: TAB,
    fileName: 'firmware.log',
    fileSize: 1000,
  });
  assert.equal(statuses.logStatus.loggingRAGColor(TAB), 'idle');
  assert.equal(doc.querySelector(`#${TAB} .logging-pc-title`)!.textContent, 'Logging - Off');
});

test('Longhorn GGA drives mode lights and NMEA 227 stops overriding GGA time', () => {
  const { doc, statuses } = harness(['statusBar', 'positionStatus'], { isLongHorn: true });
  statuses.longhornStatusUI.uiUpdate({
    MessageID: 218,
    Data: [{
      Quality: 52,
      Latitude: '5107.407407',
      NS: 78,
      Longitude: '11402.331486',
      EW: 87,
      AntennaAlt: 100,
      UTCHHMMSSss: '123519',
    }],
  }, TAB);
  assert.equal(statuses.longhornStatusUI.positionStatusRAG[TAB], 'good');
  assert.ok(doc.querySelector(`#${TAB} .RTK.activePosMode`));
  assert.equal(doc.querySelector(`#${TAB} #positionStatuslatitude`)!.textContent, '51.1234568°');
  const before = doc.querySelector(`#${TAB} #statusBartime`)?.textContent;
  statuses.longhornStatusUI.uiUpdate({
    MessageID: 227,
    Data: [{ UTCHHMMSSss: '010203' }],
  }, TAB);
  assert.equal(doc.querySelector(`#${TAB} #statusBartime`)?.textContent, before);
});

test('Longhorn GSA/GSV snapshots feed the shared satellite sky plot and used/not-used colours', () => {
  const { doc, statuses } = harness(['satelliteView'], { isLongHorn: true });
  statuses.longhornStatusUI.uiUpdate({
    MessageID: 221,
    Data: [{ NMEA_TRAKERID: 'GP', PRN: [7] }],
  }, TAB);
  statuses.longhornStatusUI.uiUpdate({
    MessageID: 223,
    MessageName: 'GPGSV',
    Data: [{
      NMEA_TRAKERID: 'GP',
      MessageNumber: 1,
      NumberSatellites: 1,
      PNR: 7,
      Azimuth: 90,
      Elevation: 45,
      SNR: 45,
    }],
  }, TAB);
  const marker = doc.querySelector(`#${TAB} .satelliteview-main-circle #GPS7`);
  assert.ok(marker);
  assert.ok(marker!.classList.contains('satellite-good'));
  assert.equal(statuses.satelliteView.ragColor(TAB), 'bad', 'one used satellite is below the four-satellite threshold');
});

test('Longhorn CPU red waits five seconds, while temperature red is immediate', () => {
  const { statuses, clock } = harness(['statusBar', 'deviceInfo'], { isLongHorn: true });
  const cpu = {
    MessageID: 2353,
    Data: [{ MessageIdentifier: 4, MessageText: 'CPU 10 Temperature 60 Voltage 3.3' }],
  };
  statuses.longhornStatusUI.uiUpdate(cpu, TAB);
  assert.equal(statuses.longhornStatusUI.deviceInfoRAG[TAB], 'good');
  clock.advance(4999);
  assert.equal(statuses.longhornStatusUI.deviceInfoRAG[TAB], 'good');
  clock.advance(1);
  assert.equal(statuses.longhornStatusUI.deviceInfoRAG[TAB], 'bad');
  assert.deepEqual(statuses.longhornStatusUI.decodeDeviceStatusRagMessages(TAB)?.red, [
    'CPUUSAGE_RED',
  ]);

  statuses.longhornStatusUI.uiUpdate({
    MessageID: 2353,
    Data: [{ MessageIdentifier: 3, MessageNumber: 1, MessageText: '00000002' }],
  }, TAB);
  assert.deepEqual(statuses.longhornStatusUI.decodeDeviceStatusRagMessages(TAB)?.red, [
    'CPUUSAGE_RED',
    'TEMPERATURE_RED',
  ]);
});

test('Longhorn SD radios switch units and scale the Plotly y-axis without persisting a global choice', () => {
  const { doc, statuses } = harness(['2d-sd', 'height-sd'], { isLongHorn: true });
  const layouts: LogData[] = [];
  const runtime = globalThis as typeof globalThis & {
    Plotly?: { react?: (id: string, data: LogData[], layout: LogData) => unknown };
  };
  const prior = runtime.Plotly;
  runtime.Plotly = {
    react: (_id, _data, layout) => {
      layouts.push(layout);
    },
  };
  try {
    statuses.longhornStatusUI.createPlot(TAB);
    const input = doc.querySelector(`#${TAB} #sd-1m`) as HTMLInputElement;
    input.click();
  } finally {
    runtime.Plotly = prior;
  }
  assert.equal(statuses.longhornStatusUI.sdScale[TAB], 1);
  assert.equal(statuses.longhornStatusUI.sdUnit[TAB], 'meters');
  const latestSdLayout = layouts.filter((layout) => (layout.colorscale as string) === '#A00214').at(-1)!;
  assert.deepEqual((latestSdLayout.yaxis as LogData).range, [0, 1]);
  assert.equal(
    ((latestSdLayout.yaxis as LogData).title as LogData).text,
    'Meters',
  );
});

test('spanStatus distinguishes inactive-as-bad, amber states and IMU communication failure', () => {
  const { statuses } = harness(['spanStatus']);
  const imu = { tab: TAB, IMUPort: 'COM1', IMUType: 'STIM300' };
  const command = { tab: TAB, switch: 'ENABLE' };
  statuses.spanStatus.updateSpanStatus(MSG_ID.CONNECTIMU, imu);
  statuses.spanStatus.updateSpanStatus(379, command);
  statuses.spanStatus.updateSpanStatus(MSG_ID.RXSTATUS, {
    tab: TAB,
    rxstatus17Bit: 0,
    aux1status30Bit: 0,
    aux1status31Bit: 0,
  });
  statuses.spanStatus.updateSpanStatus(MSG_ID.INSPVAX, {
    ...decodedFixture(MSG_ID.INSPVAX, {
      status: 'INS_INACTIVE',
      posType: 'INS_RTKFIXED',
      latitude: 1,
      longitude: 2,
      height: 3,
    }),
    tab: TAB,
  });
  assert.equal(statuses.spanStatus.spanRAGColor(TAB), 'bad');

  statuses.spanStatus.updateSpanStatus(MSG_ID.INSPVAX, {
    ...decodedFixture(MSG_ID.INSPVAX, {
      status: 'INS_ALIGNING',
      posType: 'INS_RTKFIXED',
      latitude: 1,
      longitude: 2,
      height: 3,
    }),
    tab: TAB,
  });
  assert.equal(statuses.spanStatus.spanRAGColor(TAB), 'warning');

  statuses.spanStatus.updateSpanStatus(MSG_ID.RXSTATUS, {
    tab: TAB,
    rxstatus17Bit: 1,
    aux1status30Bit: 0,
    aux1status31Bit: 0,
  });
  assert.equal(statuses.spanStatus.spanRAGColor(TAB), 'bad');
});

test('alignStatus mixed switch configuration follows the original branch order', () => {
  const { statuses } = harness(['alignStatus']);
  statuses.alignStatus.updateAlignStatus(MSG_ID.HEADING2, {
    tab: TAB,
    solStatus: 1,
    length: 2,
    heading: 10,
    pitch: 1,
    hdgStdDev: 0.1,
    ptchStdDev: 0.2,
  });
  statuses.alignStatus.updateAlignStatus(MSG_ID.DUALANTENNAALIGN, {
    tab: TAB,
    switch: 'ENABLE',
  });
  statuses.alignStatus.updateAlignStatus(MSG_ID.ALIGNAUTOMATION, {
    tab: TAB,
    option: 'DISABLE',
  });
  assert.equal(statuses.alignStatus.ragColor(TAB), 'bad');
  statuses.alignStatus.resetData(TAB);
  statuses.alignStatus.updateAlignStatus(MSG_ID.DUALANTENNAALIGN, {
    tab: TAB,
    switch: 'DISABLE',
  });
  assert.equal(statuses.alignStatus.ragColor(TAB), 'idle');
});

test('interferenceStatus handles disabled and statistical-only input', () => {
  const { doc, statuses } = harness(['interferenceStatus']);
  // The harness config callback is replaced by exercising the real statusBar state.
  statuses.statusBar.state.itDetectConfigData[TAB] = 'NONE';
  const disabled = decodedStatusRepeatedFixture(
    MSG_ID.ITDETECTSTATUS,
    { noOfEntries: 0 },
    [],
  );
  statuses.interferenceStatus.updateStatus(MSG_ID.ITDETECTSTATUS, {
    ...disabled.fields,
    tab: TAB,
  });
  assert.equal(doc.querySelector(`#${TAB} #interferenceStatusitkState`)!.textContent, 'Disabled');
  assert.equal(statuses.interferenceStatus.ITKRagColor(TAB), undefined);

  statuses.statusBar.state.itDetectConfigData[TAB] = 'L1';
  statuses.interferenceStatus.updateStatus(MSG_ID.ITDETECTSTATUS, {
    ...decodedStatusRepeatedFixture(
      MSG_ID.ITDETECTSTATUS,
      { noOfEntries: 1 },
      [{
        rfPath: 'L1',
        detectionType: 'STATISTICALANALYSIS',
        centerFrequency: 1,
      }],
    ).fields,
    tab: TAB,
  });
  assert.equal(doc.querySelector(`#${TAB} #interferenceStatusitkState`)!.textContent, 'Not Detected');
  assert.equal(statuses.interferenceStatus.ITKRagColor(TAB), 'good');
});

test('AGC pulse width and bin flags produce each shipped RAG branch', () => {
  // AGCINFO's textual flags are derived from statusWord by logparsers.js. Drive the
  // decoder with their real bit positions; unknown string properties on a decoder
  // fixture are intentionally ignored.
  const dspc1L2 = (3 << 28) | (1 << 25);
  const cases: Array<[LogData, string | undefined]> = [
    [{ pulseWidth: 0, statusWord: dspc1L2 }, 'bad'],
    [{ pulseWidth: 1000, statusWord: dspc1L2 }, 'bad'],
    [{ pulseWidth: 500, statusWord: dspc1L2 | (1 << 13) }, 'bad'],
    [{ pulseWidth: 950, statusWord: dspc1L2 }, 'warning'],
    [{ pulseWidth: 500, statusWord: dspc1L2 | (1 << 23) }, 'warning'],
    [
      {
        pulseWidth: 500,
        statusWord: dspc1L2,
      },
      'good',
    ],
  ];
  for (const [overrides, expected] of cases) {
    const { doc, statuses } = harness(['agcStatus'], { generation: 'GIII', isGIII: true });
    const parsed = decodedStatusRepeatedFixture(
      MSG_ID.AGCINFO,
      { noOfEntries: 1 },
      [{ modulus: 1024, ...overrides }],
      'GIII',
    );
    statuses.agcStatus.dc_updateData(MSG_ID.AGCINFO, {
      ...parsed.fields,
      tab: TAB,
    });
    assert.ok(statuses.agcStatus.AGCUIData[TAB].DSPC1.L2);
    const className = { good: 'green-status', warning: 'yellow-status', bad: 'red-status' }[expected!];
    const visible = doc
      .querySelectorAll(`#${TAB} .agcStatus span`)
      .filter((element) => element.classList.contains(className) && element.style.display !== 'none');
    assert.equal(
      visible.length,
      1,
      `${String(expected)} ${doc.querySelector(`#${TAB} .agcStatus`)?.outerHTML ?? 'missing'}`,
    );
  }
});

test('AGC switches cards, reuses the plot, localizes diagnostic text and opens the detail dialog', () => {
  let dialogOptions: LogData | undefined;
  const { doc, statuses } = harness(
    ['agcStatus'],
    { generation: 'GIII', isGIII: true },
    {
      openDialog: (options) => {
        dialogOptions = options as unknown as LogData;
      },
    },
  );
  const base = (3 << 28) | (1 << 25);
  const data = decodedStatusRepeatedFixture(
    MSG_ID.AGCINFO,
    { noOfEntries: 2 },
    [
      {
        statusWord: base,
        pulseWidth: 0,
        modulus: 1024,
        bin1: 1,
        bin2: 2,
        bin3: 3,
        bin4: 4,
        bin5: 5,
        bin6: 6,
        pulsesBlankedPercent: 1.25,
      },
      {
        statusWord: (4 << 28) | (0 << 25),
        pulseWidth: 500,
        modulus: 2048,
        bin1: 6,
        bin2: 5,
        bin3: 4,
        bin4: 3,
        bin5: 2,
        bin6: 1,
      },
    ],
    'GIII',
  );
  const calls: string[] = [];
  const runtime = globalThis as typeof globalThis & {
    Plotly?: {
      newPlot?: (id: string, data: LogData[], layout: LogData) => { on: () => void };
      react?: (id: string, data: LogData[], layout: LogData) => { on: () => void };
    };
  };
  const prior = runtime.Plotly;
  runtime.Plotly = {
    newPlot: (_id, _data, layout) => {
      calls.push(`new:${String((layout.margin as LogData).t)}`);
      return { on: () => {} };
    },
    react: () => {
      calls.push('react');
      return { on: () => {} };
    },
  };
  try {
    statuses.agcStatus.dc_updateData(MSG_ID.AGCINFO, {
      ...data.fields,
      tab: TAB,
    });
    doc.querySelector(`#${TAB} #DSPC2-card`)!.click();
  } finally {
    runtime.Plotly = prior;
  }

  assert.deepEqual(calls, ['new:10', 'react']);
  assert.deepEqual(statuses.agcStatus.AGCUIData[TAB].DSPC2.L1.statusWord >>> 0, (4 << 28));
  assert.equal(statuses.agcStatus.RAGIndicatorColor[TAB], 'bad');
  const english = englishDictionary();
  assert.deepEqual(statuses.agcStatus.AGCStatusRAGMessages(TAB), [
    english.AGC_PULSE_WIDTH_IS.replace('%1', '0'),
  ]);
  assert.equal(doc.querySelector(`#${TAB} .L1-entry label`)?.textContent, 'L1');
  assert.equal((statuses.agcStatus.agcPlotData[TAB][0].y as number[])[0], 6);

  doc.querySelector(`#${TAB} .view-agc-detailed-info`)!.click();
  assert.equal(dialogOptions?.title, english.VIEW_AGC_DETAILED_INFO);
  assert.match(String(dialogOptions?.content), /agcInfo-header/);
  assert.match(String(dialogOptions?.content), /agcStatusPopupPlot-tabs-3/);
  assert.match(String(dialogOptions?.content), /Pulse Width/);
});

test('status processLanguage methods cover every diagnostic marker they own', () => {
  const cases: Array<{
    component: string;
    marker: string;
    key: string;
    run: (statuses: ReturnType<typeof harness>['statuses']) => void;
  }> = [
    { component: 'radioStatus', marker: 'why-this-amber', key: 'WHY_IS_THIS_AMBER', run: (s) => s.radioStatus.processLanguage() },
    { component: 'alignStatus', marker: 'why-this-red', key: 'WHY_IS_THIS_RED', run: (s) => s.alignStatus.processLanguage() },
    { component: 'spanStatus', marker: 'why-this-amber', key: 'WHY_IS_THIS_AMBER', run: (s) => s.spanStatus.processLanguage() },
    { component: 'interferenceStatus', marker: 'need-help', key: 'NEED_HELP', run: (s) => s.interferenceStatus.processLanguage() },
    { component: 'deviceInfo', marker: 'need-help', key: 'NEED_HELP', run: (s) => s.deviceInfo.processLanguage() },
    { component: 'portStatus', marker: 'why-this-red', key: 'WHY_IS_THIS_RED', run: (s) => s.portStatus.processLanguage() },
    { component: 'logStatus', marker: 'why-this-red', key: 'WHY_IS_THIS_RED', run: (s) => s.logStatus.processLanguage() },
    { component: 'satelliteView', marker: 'need-help', key: 'NEED_HELP', run: (s) => s.satelliteView.processLanguage() },
  ];
  const english = englishDictionary();
  for (const entry of cases) {
    const { doc, statuses } = harness([entry.component]);
    const marker = doc.createElement('span');
    marker.setAttribute(`data-lang-${entry.marker}`, '');
    doc.body.appendChild(marker);
    entry.run(statuses);
    assert.equal(marker.textContent, english[entry.key], `${entry.component} ${entry.marker}`);
  }
});
