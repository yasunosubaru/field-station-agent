import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeMessage,
  decodeRepeated,
  type RepeatLayout,
  type RichField,
  type RichSpec,
} from '../src/decode.ts';
import { deriveStatusFields } from '../src/status-fields.ts';

const here = dirname(fileURLToPath(import.meta.url));
const data = (name: string) => JSON.parse(readFileSync(join(here, '..', 'data', name), 'utf8'));

const specs: Record<string, RichSpec> = data('message-specs.json');
const layouts: Record<string, RepeatLayout> = data('repeat-layouts.json');

function writeFixtureField(
  view: DataView,
  field: RichField,
  offset: number,
  input: unknown,
): void {
  let value = input;
  if (field.enum && typeof value === 'string') value = field.enum[value] ?? value;
  const type = String(field.type);
  if (type === 'DOUBLE') return view.setFloat64(offset, Number(value), true);
  if (type === 'FLOAT') return view.setFloat32(offset, Number(value), true);
  if (type === 'ENUM' || type === 'UINT_32' || type === 'ULONG32') {
    return view.setUint32(offset, Number(value), true);
  }
  if (type === 'INT_32') return view.setInt32(offset, Number(value), true);
  if (type === 'UINT_16' || type === 'ULONG16' || type === 'SHORT') {
    return view.setUint16(offset, Number(value), true);
  }
  if (type === 'UCHAR' || type === 'HEX') return view.setUint8(offset, Number(value));
  if (type === 'ULONG64') return view.setBigUint64(offset, BigInt(String(value)), true);
  if (type.startsWith('STRING_')) {
    const length = Number(type.slice('STRING_'.length));
    const text = String(value);
    for (let index = 0; index < length; index += 1) {
      view.setUint8(offset + index, index < text.length ? text.charCodeAt(index) : 0);
    }
  }
}

function fixturePayload(
  spec: RichSpec,
  size: number,
  values: Record<string, unknown>,
): Uint8Array {
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  for (const [name, value] of Object.entries(values)) {
    const field = spec.fields[name];
    if (!field || field.offset < 0) continue;
    writeFixtureField(view, field, field.offset, value);
  }
  return payload;
}

function fixtureRepeatedPayload(
  spec: RichSpec,
  layout: RepeatLayout,
  header: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
): Uint8Array {
  const payload = fixturePayload(
    spec,
    layout.blockStart + blocks.length * layout.blockSize,
    header,
  );
  const view = new DataView(payload.buffer);
  blocks.forEach((block, index) => {
    for (const [name, value] of Object.entries(block)) {
      const field = layout.fields[name];
      if (!field) continue;
      writeFixtureField(
        view,
        field,
        layout.blockStart + index * layout.blockSize + field.offset,
        value,
      );
    }
  });
  return payload;
}

function fieldWidth(field: RichField): number {
  const type = String(field.type);
  if (type === 'DOUBLE' || type === 'ULONG64') return 8;
  if (type === 'FLOAT' || type === 'UINT_32' || type === 'ULONG32' || type === 'INT_32' || type === 'ENUM') return 4;
  if (type === 'UINT_16' || type === 'ULONG16' || type === 'SHORT') return 2;
  if (type === 'UCHAR' || type === 'HEX') return 1;
  if (type.startsWith('STRING_')) return Number(type.slice('STRING_'.length));
  return 4;
}

test('all status repeat layouts extracted from logparsers are present', () => {
  const repeatIds = Object.entries(specs)
    .filter(([, spec]) => spec.repeat === true)
    .map(([id]) => id);
  for (const id of repeatIds) {
    assert.ok(layouts[id], 'missing layout ' + id);
    assert.ok(specs[id], 'missing spec ' + id);
  }
  assert.equal(repeatIds.length, 31);
  assert.deepEqual(Object.keys(layouts).sort(), repeatIds.sort());
});

test('every generated block-relative field stays inside its declared block', () => {
  for (const [id, layout] of Object.entries(layouts)) {
    if (layout.custom) continue;
    for (const [name, field] of Object.entries(layout.fields)) {
      assert.ok(field.offset >= 0, `${id} ${name} negative offset`);
      assert.ok(
        field.offset + fieldWidth(field) <= layout.blockSize,
        `${id} ${name} exceeds blockSize ${layout.blockSize}`,
      );
    }
  }
});

test('PORTSTATS, ITDETECTSTATUS and LBANDTRACKSTAT samples decode from block-relative fields', () => {
  const ports = fixtureRepeatedPayload(
    specs['72'],
    layouts['72'],
    { noOfPorts: 1 },
    [{ port: 'COM1', rxChars: 11, txChars: 22, accRxChars: 33, droppedRxChars: 4 }],
  );
  const portOut = decodeRepeated(ports, specs['72'], layouts['72']);
  assert.equal(portOut.blocks[0].port, 'COM1');
  assert.equal(portOut.blocks[0].rxChars, 11);
  assert.equal(portOut.blocks[0].txChars, 22);

  const interference = fixtureRepeatedPayload(
    specs['2065'],
    layouts['2065'],
    { noOfEntries: 1 },
    [{
      rfPath: 'L1',
      detectionType: 'SPECTRALANALYSIS',
      centerFrequency: 1575.42,
      bandwidth: 10,
      power: -100,
      estimatedPower: -90,
    }],
  );
  const interferenceOut = decodeRepeated(interference, specs['2065'], layouts['2065']);
  assert.equal(interferenceOut.blocks[0].rfPath, 'L1');
  assert.equal(interferenceOut.blocks[0].detectionType, 'SPECTRALANALYSIS');
  assert.equal(interferenceOut.blocks[0].centerFrequency, Math.fround(1575.42));

  const lband = fixtureRepeatedPayload(
    specs['1201'],
    layouts['1201'],
    { noOfEntries: 1 },
    [{
      name: 'SID08',
      frequency: 1545,
      status: 2,
      'C/No': 45,
      lockTime: 100,
      biterrorRate: 0.01,
    }],
  );
  const lbandOut = decodeRepeated(lband, specs['1201'], layouts['1201']);
  assert.equal(lbandOut.blocks[0].name, 'SID08');
  assert.equal(lbandOut.blocks[0].frequency, 1545);
  assert.equal(lbandOut.blocks[0]['C/No'], 45);
  assert.equal(lbandOut.blocks[0].status, 2);
});

test('GGAQUALITY and MODELFEATURES decode fixed 8-byte records from shipped fields', () => {
  const gga = fixtureRepeatedPayload(
    specs['691'],
    layouts['691'],
    { noOfEntries: 2 },
    [
      { posType: 'PSRDIFF', quality: 1 },
      { posType: 'NARROW_INT', quality: 2 },
    ],
  );
  const ggaOut = decodeRepeated(gga, specs['691'], layouts['691']);
  assert.equal(ggaOut.truncated, false);
  assert.deepEqual(ggaOut.blocks, [
    { posType: 'PSRDIFF', quality: 1 },
    { posType: 'NARROW_INT', quality: 2 },
  ]);

  const features = fixtureRepeatedPayload(
    specs['1329'],
    layouts['1329'],
    { noOfFeatures: 2 },
    [
      { featureStatus: 7, featureType: 11 },
      { featureStatus: 8, featureType: 12 },
    ],
  );
  const featureOut = decodeRepeated(features, specs['1329'], layouts['1329']);
  assert.deepEqual(featureOut.blocks, [
    { featureStatus: 7, featureType: 11 },
    { featureStatus: 8, featureType: 12 },
  ]);
});

test('IT PSD final/detect layouts decode scaled spectral samples', () => {
  for (const id of ['1968', '2063']) {
    const payload = fixtureRepeatedPayload(
      specs[id],
      layouts[id],
      {
        status: 0x1234,
        frequencyStart: 1_100_000,
        stepSize: 1_000,
        noofSamples: 2,
      },
      [{ sample: 100 }, { sample: 200 }],
    );
    const out = decodeRepeated(payload, specs[id], layouts[id]);
    assert.equal(out.header.status, 0x1234, id);
    assert.equal(out.header.frequencyStart, 1_100_000, id);
    assert.equal(out.blocks[0].sample, 100 / 256, id);
    assert.equal(out.blocks[1].sample, 200 / 256, id);
    const derived = deriveStatusFields(
      Number(id),
      payload,
      out.header,
      out.blocks,
    );
    const samples = derived.fields.data as Array<Record<string, number>>;
    assert.equal(samples[0].sample, 100 / 256 - 200, id);
    assert.equal(samples[1].sample, 200 / 256 - 200, id);
    assert.equal(samples[0].frequency, 1_100_000, id);
    assert.equal(samples[1].frequency, 1_100_000 + 1_000 / 1_000_000, id);
    if (id === '2063') assert.equal(derived.fields.band, '1234');
  }
});

test('ITBANDPASSBANK, SKCALIBRATESTATUS, ETHSTATUS and GIII VERSION decode block fields', () => {
  const band = fixtureRepeatedPayload(
    specs['2022'],
    layouts['2022'],
    { noOfFilterBanks: 2 },
    [
      {
        frequencyType: 1,
        minLowerFrequencyCutOff: 1.1,
        maxLowerFrequencyCutOff: 1.2,
        minUpperFrequencyCutOff: 1.3,
        maxUpperFrequencyCutOff: 1.4,
        frequencyStep: 0.1,
      },
      {
        frequencyType: 2,
        minLowerFrequencyCutOff: 2.1,
        maxLowerFrequencyCutOff: 2.2,
        minUpperFrequencyCutOff: 2.3,
        maxUpperFrequencyCutOff: 2.4,
        frequencyStep: 0.2,
      },
    ],
  );
  const bandOut = decodeRepeated(band, specs['2022'], layouts['2022']);
  assert.equal(bandOut.blocks.length, 2);
  assert.equal(bandOut.blocks[1].frequencyType, 2);
  assert.equal(bandOut.blocks[1].frequencyStep, Math.fround(0.2));

  const calibration = fixtureRepeatedPayload(
    specs['2364'],
    layouts['2364'],
    { mode: 'PASS', result: 0, noOfEntries: 2 },
    [
      { signalType: 1, spoofingCalibrationMode: 2, frontEndMode: 3, calibrationResult: 0, timeStamp: 100 },
      { signalType: 4, spoofingCalibrationMode: 5, frontEndMode: 6, calibrationResult: 1, timeStamp: 200 },
    ],
  );
  const calibrationOut = decodeRepeated(calibration, specs['2364'], layouts['2364']);
  assert.equal(calibrationOut.header.mode, 'PASS');
  assert.deepEqual(calibrationOut.blocks[1], {
    signalType: 4,
    spoofingCalibrationMode: 5,
    frontEndMode: 6,
    calibrationResult: 1,
    timeStamp: 200,
  });

  const ethernet = fixtureRepeatedPayload(
    specs['4101'],
    layouts['4101'],
    { noOfRecords: 2 },
    [
      { type: 'ETHA', mac: '00:11:22:33:44:55', reserved: 1, details: 7 },
      { type: 'ETHB', mac: 'AA:BB:CC:DD:EE:FF', reserved: 2, details: 8 },
    ],
  );
  const ethernetOut = decodeRepeated(ethernet, specs['4101'], layouts['4101']);
  assert.equal(ethernetOut.blocks[1].type, 'ETHB');
  assert.equal(ethernetOut.blocks[1].mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(ethernetOut.blocks[1].details, 8);

  const version = fixtureRepeatedPayload(
    specs['4108'],
    layouts['4108'],
    { noOfComponents: 2 },
    [
      { type: 'IOMASTER', slotId: 1, moduleId: 2, psn: 'PSN-1', hwVersion: 'HW-1' },
      { type: 'DSPC', slotId: 3, moduleId: 4, psn: 'PSN-2', hwVersion: 'HW-2' },
    ],
  );
  const versionOut = decodeRepeated(version, specs['4108'], layouts['4108']);
  assert.equal(versionOut.blocks[1].type, 'DSPC');
  assert.equal(versionOut.blocks[1].slotId, 3);
  assert.equal(versionOut.blocks[1].psn, 'PSN-2');
  assert.equal(versionOut.blocks[1].hwVersion, 'HW-2');
});

test('VALIDMODELS and AUTHCODES custom layouts decode variable-length records', () => {
  const models = new Uint8Array(52);
  const modelView = new DataView(models.buffer);
  modelView.setUint32(0, 2, true);
  let at = 4;
  for (const [model, year, month, day] of [
    ['MODEL001', 2027, 6, 15],
    ['MODEL002', 2028, 7, 16],
  ] as const) {
    models.set(Buffer.from(model), at);
    modelView.setUint32(at + 12, year, true);
    modelView.setUint32(at + 16, month, true);
    modelView.setUint32(at + 20, day, true);
    at += 24;
  }
  const modelsOut = decodeRepeated(models, specs['206'], layouts['206']);
  assert.equal(modelsOut.truncated, false);
  assert.deepEqual(modelsOut.blocks[0], {
    model: 'MODEL001',
    expyear: 2027,
    expmonth: 6,
    expday: 15,
  });
  assert.equal(modelsOut.blocks[1].model, 'MODEL002');

  const auth = new Uint8Array(72);
  const authView = new DataView(auth.buffer);
  authView.setUint32(0, 9, true);
  authView.setUint32(4, 2, true);
  authView.setUint32(8, 3, true);
  authView.setUint32(12, 1, true);
  auth.set(Buffer.from('ABCD'), 16);
  authView.setUint32(44 + 8, 5, true);
  authView.setUint32(44 + 12, 2, true);
  auth.set(Buffer.from('EFGH'), 44 + 16);
  const authOut = decodeRepeated(auth, specs['1348'], layouts['1348']);
  assert.equal(authOut.header.signatureStatus, 9);
  assert.equal(authOut.header.noOfAuthCodes, 2);
  assert.deepEqual(authOut.blocks, [
    { authCodeType: 3, authCodeValidity: 1, authCodeString: 'ABCD' },
    { authCodeType: 5, authCodeValidity: 2, authCodeString: 'EFGH' },
  ]);
});

test('INSCONFIG, ITFILTTABLE and ITPROGFILTBANK custom layouts follow nested counts', () => {
  const ins = new Uint8Array(140);
  const insView = new DataView(ins.buffer);
  insView.setUint32(0, 3, true);
  insView.setUint32(60, 1, true);
  insView.setUint32(64, 4, true); // USER translation
  insView.setUint32(68, 2, true); // input frame
  insView.setFloat32(72, 1.25, true);
  insView.setFloat32(76, -2.5, true);
  insView.setFloat32(80, 3.75, true);
  insView.setUint32(100, 1, true); // rotation count after one 36-byte translation
  insView.setUint32(104, 5, true); // MARK1 rotation
  insView.setUint32(108, 7, true);
  insView.setFloat32(112, 10.5, true);
  const insOut = decodeRepeated(ins, specs['1945'], layouts['1945']);
  assert.equal(insOut.header.noOfTranslations, 1);
  assert.equal(insOut.header.noOfRotations, 1);
  assert.equal(insOut.blocks[0].insTranslation, 'USER');
  assert.equal(insOut.blocks[0].inputFrame, 2);
  assert.equal(insOut.blocks[0].xTranslation, Math.fround(1.25));
  assert.equal(insOut.header.rotationEntries.MARK1.rotationalOffset, 'MARK1');

  const filters = new Uint8Array(60);
  const filterView = new DataView(filters.buffer);
  filterView.setUint32(0, 1, true);
  filterView.setUint32(4, 5, true); // GPSL5
  filterView.setUint32(8, 7, true);
  filterView.setUint32(12, 3, true); // CIC2
  filterView.setUint32(16, 0x1234, true);
  filterView.setUint32(20, 1, true);
  filterView.setFloat32(24, 1.1, true);
  filterView.setFloat32(28, 1.2, true);
  filterView.setUint32(32, 1, true);
  filterView.setUint32(36, 1, true);
  filterView.setUint32(40, 1, true);
  filterView.setUint32(44, 1, true);
  filterView.setFloat32(48, 1.3, true);
  filterView.setFloat32(52, 1.4, true);
  filterView.setFloat32(56, 0.1, true);
  const filterOut = decodeRepeated(filters, specs['1991'], layouts['1991']);
  assert.equal(filterOut.blocks.length, 1);
  assert.equal(filterOut.blocks[0].frequencyType, 'GPSL5');
  assert.equal(filterOut.blocks[0].ddcFilterType, 'CIC2');
  assert.equal(
    filterOut.blocks[0].progFilters[0].mode,
    'BANDPASSFILTER',
    JSON.stringify(filterOut.blocks),
  );
  assert.equal(filterOut.blocks[0].progFilters[0].lowerCutOffFrequency, Math.fround(1.3));

  const banks = new Uint8Array(40);
  const bankView = new DataView(banks.buffer);
  bankView.setUint32(0, 1, true);
  bankView.setUint32(4, 20, true);
  bankView.setUint32(8, 1, true);
  bankView.setUint32(12, 1, true);
  bankView.setFloat32(16, 2.1, true);
  bankView.setFloat32(20, 2.2, true);
  bankView.setFloat32(24, 2.3, true);
  bankView.setFloat32(28, 2.4, true);
  bankView.setFloat32(32, 0.2, true);
  bankView.setFloat32(36, 0.01, true);
  const bankOut = decodeRepeated(banks, specs['2023'], layouts['2023']);
  assert.equal(bankOut.blocks[0].frequencyType, 'NAVICL5');
  assert.equal(bankOut.blocks[0].noOfBanks, 1);
  assert.equal(bankOut.blocks[0].bank[0].progFiltMode, 'BANDPASSFILTER');
  assert.equal(bankOut.blocks[0].bank[0].frequencyStep, Math.fround(0.2));
});

test('every newly added fixed layout reports truncated when the declared count exceeds the payload', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['691', { noOfEntries: 2 }, { posType: 'SINGLE', quality: 1 }],
    ['1329', { noOfFeatures: 2 }, { featureStatus: 1, featureType: 2 }],
    [
      '1968',
      { status: 1, frequencyStart: 100, stepSize: 1, noofSamples: 2 },
      { sample: 1 },
    ],
    [
      '2063',
      { status: 1, frequencyStart: 100, stepSize: 1, noofSamples: 2 },
      { sample: 1 },
    ],
    [
      '2022',
      { noOfFilterBanks: 2 },
      {
        frequencyType: 1,
        minLowerFrequencyCutOff: 1,
        maxLowerFrequencyCutOff: 2,
        minUpperFrequencyCutOff: 3,
        maxUpperFrequencyCutOff: 4,
        frequencyStep: 1,
      },
    ],
    ['2364', { mode: 'PASS', result: 0, noOfEntries: 2 }, { signalType: 1 }],
    ['4101', { noOfRecords: 2 }, { type: 'ETHA', mac: 'X' }],
    ['4108', { noOfComponents: 2 }, { type: 'IOMASTER', psn: 'X' }],
  ];
  for (const [id, header, block] of cases) {
    const payload = fixtureRepeatedPayload(specs[id], layouts[id], header, [block]);
    const out = decodeRepeated(payload, specs[id], layouts[id]);
    assert.equal(out.declaredCount, 2, id);
    assert.equal(out.decodedCount, 1, id);
    assert.equal(out.truncated, true, id);
  }
});

test('variable and nested custom layouts also distinguish declared from decoded counts', () => {
  const modelHeader = layouts['206'].blockStart;
  const oneModel = new Uint8Array(modelHeader + 24);
  const modelView = new DataView(oneModel.buffer);
  modelView.setUint32(0, 2, true);
  oneModel.set(Buffer.from('MODEL001'), 4);
  modelView.setUint32(16, 2027, true);
  const modelOut = decodeRepeated(oneModel, specs['206'], layouts['206']);
  assert.equal(modelOut.declaredCount, 2);
  assert.equal(modelOut.decodedCount, 1);
  assert.equal(modelOut.truncated, true);

  const oneAuth = new Uint8Array(24);
  const authView = new DataView(oneAuth.buffer);
  authView.setUint32(4, 2, true);
  authView.setUint32(8, 1, true);
  authView.setUint32(12, 1, true);
  oneAuth.set(Buffer.from('ABCD'), 16);
  const authOut = decodeRepeated(oneAuth, specs['1348'], layouts['1348']);
  assert.equal(authOut.declaredCount, 2);
  assert.equal(authOut.decodedCount, 1);
  assert.equal(authOut.truncated, true);

  const oneInsTranslation = new Uint8Array(104);
  const insView = new DataView(oneInsTranslation.buffer);
  insView.setUint32(60, 2, true);
  insView.setUint32(64, 4, true);
  insView.setUint32(100, 0, true);
  const insOut = decodeRepeated(oneInsTranslation, specs['1945'], layouts['1945']);
  assert.equal(insOut.declaredCount, 2);
  assert.equal(insOut.decodedCount, 1);
  assert.equal(insOut.truncated, true);

  const oneFilterRecord = new Uint8Array(36);
  const filterView = new DataView(oneFilterRecord.buffer);
  filterView.setUint32(0, 2, true);
  filterView.setUint32(32, 0, true);
  const filterOut = decodeRepeated(oneFilterRecord, specs['1991'], layouts['1991']);
  assert.equal(filterOut.declaredCount, 2);
  assert.equal(filterOut.decodedCount, 1);
  assert.equal(filterOut.truncated, true);

  const oneBank = new Uint8Array(40);
  const bankView = new DataView(oneBank.buffer);
  bankView.setUint32(0, 2, true);
  bankView.setUint32(4, 0, true);
  bankView.setUint32(8, 1, true);
  const bankOut = decodeRepeated(oneBank, specs['2023'], layouts['2023']);
  assert.equal(bankOut.declaredCount, 2);
  assert.equal(bankOut.decodedCount, 1);
  assert.equal(bankOut.truncated, true);
});

test('VERSION decodes its component blocks', () => {
  const layout = layouts['37'];
  const payload = new Uint8Array(layout.blockStart + 2 * layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 2, true);
  // block 0
  dv.setUint32(4, 2, true); // type
  payload.set(Buffer.from('OEM729-1.00'), 4 + 4);
  payload.set(Buffer.from('PSN0001'), 4 + 20);
  payload.set(Buffer.from('1.00'), 4 + 36);
  // block 1
  dv.setUint32(4 + 108, 20, true);
  payload.set(Buffer.from('IMU-1'), 4 + 108 + 4);

  const out = decodeRepeated(payload, specs['37'], layout);
  assert.equal(out.header.noOfComponents, 2);
  assert.equal(out.blocks.length, 2);
  assert.equal(out.blocks[0].model, 'OEM729-1.00');
  assert.equal(out.blocks[0].PSN, 'PSN0001');
  assert.equal(out.blocks[0].hardwareVersion, '1.00');
  assert.equal(out.blocks[1].model, 'IMU-1');
  assert.equal(out.truncated, false);
});

test('TRACKSTAT decodes one block per channel', () => {
  const layout = layouts['83'];
  const payload = new Uint8Array(layout.blockStart + 2 * layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 3, true); // solutionStatus (enum value, no mapping hit -> stays numeric)
  dv.setUint32(4, 16, true); // positionType
  dv.setFloat32(8, 5, true); // cutoff
  dv.setUint32(12, 2, true); // numberOfChannels
  // channel 0
  dv.setUint16(16 + 0, 5, true); // PRN
  dv.setUint32(16 + 4, 0x1234, true); // channelTrackingStatus
  dv.setFloat64(16 + 8, 22000000.5, true); // pseudoRange
  dv.setFloat32(16 + 20, 45.5, true); // C/N0
  // channel 1
  dv.setUint16(16 + 40, 12, true);

  const out = decodeRepeated(payload, specs['83'], layout);
  assert.equal(out.header.numberOfChannels, 2);
  assert.equal(out.blocks.length, 2);
  assert.equal(out.blocks[0].PRN, 5);
  assert.equal(out.blocks[0].channelTrackingStatus, 0x1234);
  assert.equal(out.blocks[0].carrierNoiseRatio, 45.5);
  assert.equal(out.blocks[1].PRN, 12);
});

test('TRACKSTAT derives the antenna from the SBF message-type bit', () => {
  const layout = layouts['83'];
  const payload = new Uint8Array(layout.blockStart + layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(12, 1, true);
  dv.setUint16(16, 5, true);
  const out = decodeRepeated(payload, specs['83'], layout);

  assert.equal(
    deriveStatusFields(83, payload, out.header, out.blocks, 'OEM7', 0, false).fields.antenna,
    'PRIMARY',
  );
  assert.equal(
    deriveStatusFields(83, payload, out.header, out.blocks, 'OEM7', 0, true).fields.antenna,
    'SECONDARY',
  );
});

test('CHANCONFIGLIST follows grouped 8-byte signal records and selects setInUse', () => {
  // Two configurations: GPS+GPSL5 (in use), then a non-current GPS L1 record.
  const payload = new Uint8Array(8 + (4 + 16) + (4 + 8));
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 1, true); // setInUse: 1-based
  dv.setUint32(4, 2, true); // numOfChanConfig
  dv.setUint32(8, 2, true); // first config: numOfSignalTypes
  dv.setUint32(12, 3, true); // first record numChans
  dv.setUint32(16, 0, true); // GPSL1
  dv.setUint32(20, 2, true); // first record numChans (same HW channel group)
  dv.setUint32(24, 5, true); // GPSL5
  dv.setUint32(28, 1, true); // second config: numOfSignalTypes
  dv.setUint32(32, 1, true);
  dv.setUint32(36, 0, true);

  const out = decodeRepeated(payload, specs['1148'], layouts['1148']);
  const derived = deriveStatusFields(1148, payload, out.header, out.blocks, 'OEM7');
  const all = derived.fields.allChanConfigData as Array<Record<string, unknown>>;
  const current = derived.fields.currentChanConfigData as Array<Record<string, unknown>>;

  assert.deepEqual(all.map((row) => row.signalType), ['GPSL1', 'GPSL5', 'GPSL1']);
  assert.deepEqual(current.map((row) => row.signalType), ['GPSL1', 'GPSL5']);
  assert.equal(current[0].numChans, 3);
  assert.equal(current[1].numChans, 2);
  assert.equal(derived.fields.numOfChanConfig, 2);
  assert.equal(derived.fields.setInUse, 1);
});

test('BESTSATS uses the SATVIS constellation ids and offsets GLONASS PRNs by 37', () => {
  const layout = layouts['1194'];
  const payload = new Uint8Array(layout.blockStart + 3 * layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 3, true);
  dv.setUint32(4, 5, true); // GALILEO
  dv.setUint16(8, 12, true);
  dv.setUint32(4 + 16, 7, true); // QZSS
  dv.setUint16(8 + 16, 193, true);
  dv.setUint32(4 + 32, 1, true); // GLONASS
  dv.setUint16(8 + 32, 10, true);
  const out = decodeRepeated(payload, specs['1194'], layout);
  const derived = deriveStatusFields(1194, payload, out.header, out.blocks);
  assert.deepEqual(
    derived.blocks?.map((row) => [row.system, row.satelliteID]),
    [
      ['GALILEO', 12],
      ['QZSS', 193],
      ['GLONASS', 47],
    ],
  );
});

test('CARDSTATUS exposes the fan block after the card records', () => {
  const layout = layouts['4098'];
  const fanCountAt = layout.blockStart + layout.blockSize;
  const payload = new Uint8Array(fanCountAt + 4 + 8);
  const dv = new DataView(payload.buffer);
  dv.setUint16(0, 2, true); // Operational
  dv.setUint16(2, 0, true); // Normal
  dv.setUint32(16, 1, true); // one card
  dv.setUint32(20, 1, true); // IOMASTER
  dv.setUint32(48, 0, true); // no warning word bits
  dv.setUint32(52, 0, true);
  dv.setUint32(fanCountAt, 2, true);
  dv.setInt16(fanCountAt + 4, 4200, true);
  dv.setInt16(fanCountAt + 6, 0, true);
  dv.setInt16(fanCountAt + 8, 0, true);
  dv.setInt16(fanCountAt + 10, 1, true);

  const out = decodeRepeated(payload, specs['4098'], layout);
  const derived = deriveStatusFields(4098, payload, out.header, out.blocks, 'GIII');
  assert.equal(derived.fields.state, 'Operational');
  assert.equal(derived.fields.mode, 'Normal');
  assert.equal(derived.fields.fansCount, 2);
  assert.deepEqual(derived.fields.fansData, [
    { fanSpeed: 4200, fanFailed: 0 },
    { fanSpeed: 0, fanFailed: 1 },
  ]);
});

test('SATVIS2 decodes one block per satellite', () => {
  const layout = layouts['1043'];
  const payload = new Uint8Array(layout.blockStart + 3 * layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 0, true); // GPS
  dv.setUint32(8, 1, true); // almanac flag
  dv.setUint32(12, 3, true); // numberOfSatellites
  for (let i = 0; i < 3; i++) {
    const base = 16 + i * 40;
    dv.setUint32(base + 0, 10 + i, true); // satelliteId
    dv.setUint32(base + 4, 0, true); // health
    dv.setFloat64(base + 8, 30 + i, true); // elevation
    dv.setFloat64(base + 16, 100 + i, true); // azimuth
  }

  const out = decodeRepeated(payload, specs['1043'], layout);
  assert.equal(out.header.numberOfSatellites, 3);
  assert.deepEqual(out.blocks.map((b) => b.satelliteId), [10, 11, 12]);
  assert.deepEqual(out.blocks.map((b) => b.elevation), [30, 31, 32]);
  assert.equal(out.blocks[2].azimuth, 102);
});

test('a payload shorter than the declared count reports truncation instead of inventing blocks', () => {
  const layout = layouts['1043'];
  const payload = new Uint8Array(layout.blockStart + 1 * layout.blockSize);
  new DataView(payload.buffer).setUint32(12, 5, true); // claims five satellites
  const out = decodeRepeated(payload, specs['1043'], layout);
  assert.equal(out.declaredCount, 5);
  assert.equal(out.decodedCount, 1);
  assert.equal(out.truncated, true);
});

test('HWMONITOR keeps its payload-level idleTime and names each reading like logparsers', () => {
  const layout = layouts['963'];
  const payload = new Uint8Array(layout.blockStart + 2 * layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 2, true);
  dv.setFloat32(4, 42.5, true);
  dv.setUint32(8, (1 << 8) | 0, true);
  dv.setFloat32(12, 3.3, true);
  dv.setUint32(16, (7 << 8) | 2, true);

  const decoded = decodeRepeated(payload, specs['963'], layout);
  const out = deriveStatusFields(963, payload, decoded.header, decoded.blocks, 'OEM7', 100);
  assert.equal(out.fields.noOfMeasurements, 2);
  assert.equal(out.fields.temperature, 42.5);
  assert.equal(out.fields.temperatureBound, 0);
  assert.equal(out.fields.antennaVoltage, 3.299999952316284);
  assert.equal(out.fields.antennaVoltageBound, 2);
  assert.equal(out.fields.idleTime, 50);
  assert.equal((out.fields.data as unknown[]).length, 2);
});

test('RXSTATUS derives every bit and auxiliary port consumed by the status tiles', () => {
  const spec = specs['93'];
  const payload = new Uint8Array(80);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, (1 << 2) | (1 << 3) | (1 << 9) | (1 << 15) | (1 << 17), true);
  dv.setUint32(24, (1 << 30) | (1 << 31) | (1 << 23), true);
  dv.setUint32(40, 1 << 22, true);
  dv.setUint32(56, 1 << 25, true);
  dv.setUint32(72, 2, true);
  const raw = specs['93'];
  const fields = decodeMessage(payload, raw);
  const out = deriveStatusFields(93, payload, fields).fields;
  assert.deepEqual(
    [out.rxstatus2bit, out.rxstatus3bit, out.rxstatus9bit, out.rxstatus15bit, out.rxstatus17Bit],
    [1, 1, 1, 1, 1],
  );
  assert.equal(out.aux1status30Bit, 1);
  assert.equal(out.aux1status31Bit, 1);
  assert.equal(out.aux3status25bit, 1);
  assert.equal(out.aux4statusBit, 2);
  assert.deepEqual(
    (out.portsRxData as Array<{ port: string; bits: number }>).filter((entry) => entry.bits === 1),
    [
      { port: 'USB1', bits: 1 },
      { port: 'COM1', bits: 1 },
    ],
  );
});

test('AGCINFO statusWord derivation matches every enum used by the AGC tile', () => {
  const layout = layouts['4096'];
  const payload = new Uint8Array(layout.blockStart + layout.blockSize);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 1, true);
  const word =
    (3 << 28) |
    (1 << 25) |
    (1 << 24) |
    (1 << 23) |
    (1 << 21) |
    (2 << 18) |
    (1 << 15) |
    (1 << 14) |
    (0 << 13) |
    (1 << 12) |
    (0 << 11);
  dv.setUint32(4, word, true);
  dv.setUint32(12, 500, true);
  const decoded = decodeRepeated(payload, specs['4096'], layout);
  const out = deriveStatusFields(4096, payload, decoded.header, decoded.blocks).fields;
  const row = (out.data as Array<Record<string, unknown>>)[0];
  assert.equal(row.cardId, 'DSPC1');
  assert.equal(row.rfType, 'L2');
  assert.equal(row.activeFlag, 'True');
  assert.equal(row.binSkew, 'Present');
  assert.equal(row.AGCCollaboration, 'Fine');
  assert.equal(row.ADCRange, 'Bits 7, 4, 3');
  assert.equal(row.noiseFloorCalMethod, 'AGC');
  assert.equal(row.binCountOverflow, '2+ Bins Completely Filled');
  assert.equal(row.railGain, 'VGA not railed');
  assert.equal(row.binsNotFull, 'All Bins Not Filled');
  assert.equal(row.binsEmpty, 'Bins contain data');
});
