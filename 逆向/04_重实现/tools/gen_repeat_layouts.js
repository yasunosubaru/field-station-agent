#!/usr/bin/env node
/**
 * Generate protocol/data/repeat-layouts.json from the already extracted field table.
 *
 * The absolute offsets in message-specs.json come from the shipped logparsers.js tables.
 * A repeated-block layout only needs to describe which fields belong to the fixed header,
 * where the first block starts, its size, and the block-relative field offsets.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'packages', 'protocol', 'data');
const specs = JSON.parse(readFileSync(join(dataDir, 'message-specs.json'), 'utf8'));

const configs = {
  5: {
    countField: 'noOfLogs',
    blockStart: 4,
    blockSize: 36,
    fields: ['port', 'message', 'messageType', 'reserved', 'trigger', 'period', 'offset', 'hold'],
  },
  37: {
    countField: 'noOfComponents',
    blockStart: 4,
    blockSize: 108,
    fields: ['type', 'model', 'PSN', 'hardwareVersion', 'softwareVersion', 'bootVersion', 'compileDate', 'compileTime'],
  },
  206: {
    countField: 'noOfModels',
    blockStart: 4,
    blockSize: 16,
    custom: 'validModels',
    fields: [],
  },
  72: {
    countField: 'noOfPorts',
    blockStart: 4,
    blockSize: 40,
    fields: ['port', 'rxChars', 'txChars', 'accRxChars', 'droppedRxChars', 'interrupts', 'breaks', 'parErr', 'frameErr', 'rxOverruns'],
  },
  83: {
    countField: 'numberOfChannels',
    blockStart: 16,
    blockSize: 40,
    fields: ['PRN', 'glonassFrequency', 'channelTrackingStatus', 'pseudoRange', 'doppler', 'carrierNoiseRatio', 'lockTime', 'pseudoRangeResidual', 'reject', 'pseudoRangeWeight'],
  },
  691: {
    countField: 'noOfEntries',
    blockStart: 4,
    blockSize: 8,
    fields: ['posType', 'quality'],
  },
  963: {
    countField: 'noOfMeasurements',
    blockStart: 4,
    blockSize: 8,
    headerFields: ['noOfMeasurements'],
    fields: ['reading', 'status'],
  },
  1043: {
    countField: 'numberOfSatellites',
    blockStart: 16,
    blockSize: 40,
    fields: ['satelliteId', 'satelliteIdTemp', 'health', 'elevation', 'azimuth', 'trueDoppler', 'apparentDoppler'],
  },
  1148: {
    countField: 'numChans',
    blockStart: 16,
    blockSize: 4,
    fields: ['signalType'],
  },
  1194: {
    countField: 'entries',
    blockStart: 4,
    blockSize: 16,
    fields: ['system', 'satelliteID', 'satelliteIDTemp', 'status'],
  },
  1201: {
    countField: 'noOfEntries',
    blockStart: 4,
    blockSize: 60,
    fields: ['name', 'frequency', 'baud_rate', 'id', 'status', 'reserved', 'doppler', 'C/No', 'phaseStdDev', 'lockTime', 'uniqueWordBits', 'badUniqueWordBits', 'badUniqueWords', 'viterbiSymbols', 'correctedViterbi', 'biterrorRate'],
  },
  1348: {
    countField: 'noOfAuthCodes',
    blockStart: 8,
    blockSize: 8,
    custom: 'authCodes',
    fields: [],
  },
  1718: {
    countField: 'noOfEntries',
    blockStart: 4,
    blockSize: 32,
    fields: ['name', 'reserved', 'frequency', 'baud', 'logitude', 'access'],
  },
  1945: {
    countField: 'noOfTranslations',
    blockStart: 64,
    blockSize: 36,
    custom: 'insConfig',
    fields: [],
  },
  1991: {
    countField: 'noOfRecords',
    blockStart: 4,
    blockSize: 32,
    custom: 'itFilterTable',
    fields: [],
  },
  2023: {
    countField: 'noOfFrequencies',
    blockStart: 4,
    blockSize: 8,
    custom: 'itProgFilterBank',
    fields: [],
  },
  2065: {
    countField: 'noOfEntries',
    blockStart: 4,
    blockSize: 36,
    fields: ['rfPath', 'detectionType', 'centerFrequency', 'bandwidth', 'power', 'estimatedPower', 'reserved1', 'reserved2', 'reserved3'],
  },
  2075: {
    countField: 'noOfEntries',
    blockStart: 4,
    blockSize: 24,
    fields: ['name', 'syncState', 'channelStatus', 'comPort', 'decoderSyncStatus', 'decoderChannel'],
  },
  2364: {
    countField: 'noOfEntries',
    blockStart: 12,
    blockSize: 20,
    headerFields: ['mode', 'result', 'noOfEntries'],
    fields: ['signalType', 'spoofingCalibrationMode', 'frontEndMode', 'calibrationResult', 'timeStamp'],
  },
  2137: {
    countField: 'noOfDevices',
    blockStart: 4,
    blockSize: 20,
    fields: ['massStorageDevice', 'totalStorage', 'usedStorage'],
  },
  4096: {
    countField: 'noOfEntries',
    blockStart: 4,
    blockSize: 80,
    fields: ['statusWord', 'pulseWidth', 'modulus', 'bin1', 'bin2', 'bin3', 'bin4', 'bin5', 'bin6', 'noiseFloor', 'pulsesBlankedPercent', 'dcOffset'],
  },
  4101: {
    countField: 'noOfRecords',
    blockStart: 4,
    blockSize: 232,
    fields: ['type', 'mac', 'reserved', 'details'],
  },
  4098: {
    countField: 'cardsCount',
    blockStart: 20,
    blockSize: 60,
    headerFields: ['state', 'mode', 'attenSetting', 'hours', 'DSPCErrorSignal', 'cardsCount'],
    fields: ['component', 'slotId', 'moduleId', 'idleTime', 'value_1', 'value_2', 'value_3', 'value_4', 'value_5', 'value_6', 'value_7', 'value_8', 'value_9', 'value_10', 'warningWord', 'errorWord'],
  },
  4103: {
    countField: 'count',
    blockStart: 4,
    blockSize: 64,
    fields: ['PRN', 'svChan', 'sigChan', 'HWChan', 'trackType', 'PSR', 'PSRstd', 'ADR', 'AdrStd', 'dopp', 'CNO', 'lockTime', 'channelStatus'],
  },
  4106: {
    countField: 'numberOfSatellites',
    blockStart: 16,
    blockSize: 40,
    fields: ['prn', 'PRN', 'ephemValidity', 'almValidity', 'AlmValidity', 'EphemHealth', 'ephHealth', 'ephElevation', 'EphemElevation', 'ephAzimuth', 'EphemAzimuth', 'ephDop', 'EphemDop', 'almHealth', 'AlmHealth', 'almElevation', 'AlmElevation', 'almAzimuth', 'AlmAzimuth', 'almDop'],
  },
  4107: {
    countField: 'channelCount',
    blockStart: 36,
    blockSize: 52,
    fields: ['svChan', 'sigChan', 'PRN', 'TRAIMStatus', 'residual', 'svclockOffset', 'ionoCorr', 'tropoCorr', 'svPosX', 'svPosY', 'svPosZ'],
  },
  4108: {
    countField: 'noOfComponents',
    blockStart: 4,
    blockSize: 232,
    fields: ['type', 'slotId', 'moduleId', 'psn', 'hwVersion', 'swVersion', 'pbcVersion', 'sbcVersion', 'fpgaVersion', 'compDate', 'compTime', 'fwInfoTag', 'pbcInfoTag', 'sbcInfoTag'],
  },
  2022: {
    countField: 'noOfFilterBanks',
    blockStart: 4,
    blockSize: 24,
    fields: ['frequencyType', 'minLowerFrequencyCutOff', 'maxLowerFrequencyCutOff', 'minUpperFrequencyCutOff', 'maxUpperFrequencyCutOff', 'frequencyStep'],
  },
  1329: {
    countField: 'noOfFeatures',
    blockStart: 4,
    blockSize: 8,
    fields: ['featureStatus', 'featureType'],
  },
  1968: {
    countField: 'noofSamples',
    blockStart: 16,
    blockSize: 2,
    headerFields: ['status', 'frequencyStart', 'stepSize', 'noofSamples'],
    fields: ['sample'],
  },
  2063: {
    countField: 'noofSamples',
    blockStart: 16,
    blockSize: 2,
    headerFields: ['status', 'frequencyStart', 'stepSize', 'noofSamples'],
    fields: ['sample'],
  },
};

function widthOf(field) {
  const type = String(field.type);
  if (type === 'DOUBLE' || type === 'ULONG64') return 8;
  if (type === 'FLOAT' || type === 'UINT_32' || type === 'ULONG32' || type === 'INT_32' || type === 'ENUM') return 4;
  if (type === 'UINT_16' || type === 'ULONG16' || type === 'SHORT') return 2;
  if (type === 'UCHAR' || type === 'HEX') return 1;
  if (type.startsWith('STRING_')) return Number(type.split('_')[1]) || 4;
  return 4;
}

const output = {};
for (const [id, config] of Object.entries(configs)) {
  const spec = specs[id];
  if (!spec) throw new Error(`message-specs.json has no message ${id}`);
  if (!spec.fields[config.countField]) {
    throw new Error(`${id} ${spec.name}: missing count field ${config.countField}`);
  }
  for (const headerField of config.headerFields ?? []) {
    if (!spec.fields[headerField]) {
      throw new Error(`${id} ${spec.name}: missing header field ${headerField}`);
    }
  }
  const fields = {};
  for (const name of config.fields) {
    const field = spec.fields[name];
    if (!field) throw new Error(`${id} ${spec.name}: missing field ${name}`);
    if (field.offset < config.blockStart) {
      throw new Error(`${id} ${spec.name}: ${name} offset ${field.offset} is before blockStart ${config.blockStart}`);
    }
    const relativeOffset = field.offset - config.blockStart;
    if (relativeOffset + widthOf(field) > config.blockSize) {
      throw new Error(
        `${id} ${spec.name}: ${name} ends at ${relativeOffset + widthOf(field)}, ` +
        `past blockSize ${config.blockSize}`,
      );
    }
    fields[name] = {
      ...field,
      offset: relativeOffset,
    };
  }
  output[id] = {
    name: spec.name,
    countField: config.countField,
    blockStart: config.blockStart,
    blockSize: config.blockSize,
    ...(config.headerFields ? { headerFields: config.headerFields } : {}),
    ...(config.custom ? { custom: config.custom } : {}),
    fields,
  };
}

writeFileSync(join(dataDir, 'repeat-layouts.json'), JSON.stringify(output, null, 1) + '\n');
console.log(`wrote ${Object.keys(output).length} repeat layouts`);
