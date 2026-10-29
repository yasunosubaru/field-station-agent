/**
 * Message-specific derived fields that the shipped `logparsers.js` adds after field extraction.
 *
 * The generic field table describes bytes only. Several status tiles consume values that the
 * original derives in code (RXSTATUS bit flags and port maps, HWMONITOR reading names, AGC status
 * words, GIII card enums, INSPVAX extended-solution enum names). Keeping those transformations in
 * the protocol layer means view tests exercise the same records a live ReceiverSession receives.
 */

import type { Generation } from '../../session/src/session.ts';
import { readVariableString } from './decode.ts';
import {
  chanConfigListSignalType,
  giiiSatvisConstellationMap,
  satvisConstellationMap,
  updatedChanConfigListSignalType,
} from './generated-status-tables.ts';

export type StatusRecord = Record<string, unknown>;

export interface DerivedStatusRecord {
  fields: StatusRecord;
  blocks?: StatusRecord[];
}

const HW_READING_TYPES: Record<number, string> = {
  1: 'temperature',
  2: 'antennaCurrent',
  6: 'digitalCoreVoltage3V3',
  7: 'antennaVoltage',
  8: 'digitalCoreVoltage1V2',
  15: 'supplyVoltage',
  17: 'voltage1V8',
  22: 'secondaryTemperature',
  23: 'peripheralCoreVoltage',
  24: 'secondaryAntennaCurrent',
  25: 'secondaryAntennaVoltage',
};

const RX_AUX1_PORTS: Record<number, string> = {
  23: 'USB1',
  22: 'USB2',
  21: 'USB3',
  12: 'ICOM1',
  11: 'ICOM2',
  10: 'ICOM3',
  9: 'NCOM1',
  8: 'NCOM2',
  7: 'NCOM3',
};

const RX_AUX2_PORTS: Record<number, string> = {
  22: 'COM1',
  21: 'COM2',
  20: 'COM3',
  29: 'COM4',
  28: 'COM5',
  7: 'ICOM4',
  6: 'ICOM5',
  5: 'ICOM6',
  4: 'ICOM7',
};

const AGC_CARD: Record<number, string> = { 3: 'DSPC1', 4: 'DSPC2' };
const AGC_RF: Record<number, string> = { 0: 'L1', 1: 'L2', 2: 'L5', 3: 'S' };
const AGC_ACTIVE: Record<number, string> = { 0: 'False', 1: 'True' };
const AGC_BIN_SKEW: Record<number, string> = { 0: 'Not Present', 1: 'Present' };
const AGC_COLLABORATION: Record<number, string> = { 0: 'Coarse', 1: 'Fine' };
const AGC_RANGE: Record<number, string> = {
  0: 'Bits 7, 6, 5',
  1: 'Bits 7, 5, 4',
  2: 'Bits 7, 4, 3',
  3: 'Bits 7, 3, 2',
  4: 'Bits 7, 2, 1',
  5: 'Bits 7, 1, 0',
};
const AGC_NOISE_FLOOR: Record<number, string> = { 1: 'AGC', 2: 'Post Correlation' };
const AGC_OVERFLOW: Record<number, string> = {
  0: 'Less than 2 bins completely filled',
  1: '2+ Bins Completely Filled',
};
const AGC_RAIL: Record<number, string> = {
  0: 'VGA not railed',
  1: 'VGA railed for 3+ seconds',
};
const AGC_NOT_FULL: Record<number, string> = {
  0: 'One of more bins filled',
  1: 'All Bins Not Filled',
};
const AGC_EMPTY: Record<number, string> = {
  0: 'Bins contain data',
  1: 'All bins are empty',
};

const GIII_COMPONENT: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'IOMASTER',
  2: 'DSPC',
  3: 'RFCC',
  4: 'RFDC',
};
const GIII_STATE: Record<number, string> = {
  0: 'OFF',
  1: 'Configuration',
  2: 'Operational',
  3: 'Maintenance',
  4: 'Boot',
};
const GIII_MODE: Record<number, string> = { 0: 'Normal', 1: 'Failed' };
const GIII_CLOCK: Record<number, string> = { 0: 'Not Computed', 1: 'Computed' };
const GIII_SIGNAL: Record<number, string> = {
  0: 'L1 C/A GPS',
  1: 'L2 P(Y)',
  2: 'L1 C',
  3: 'L2 C',
  4: 'L5 GPS',
  5: 'L1 C/A SBAS',
  6: 'L5 SBAS',
  7: 'L5',
  8: 'S',
  64: 'E1 GALILEO',
  65535: 'Unknown',
};

const INSPVAX_STATUS: Record<number, string> = {
  0: 'INS_INACTIVE',
  1: 'INS_ALIGNING',
  2: 'INS_HIGH_VARIANCE',
  3: 'INS_SOLUTION_GOOD',
  6: 'INS_SOLUTION_FREE',
  7: 'INS_ALIGNMENT_COMPLETE',
  8: 'DETERMINING_ORIENTATION',
  9: 'WAITING_INITIALPOS',
  10: 'WAITING_AZIMUTH',
  11: 'INITIALIZING_BIASES',
  12: 'MOTION_DETECT',
  14: 'WAITING_ALIGNMENTORIENTATION',
};
const INSPVAX_ALIGNMENT: Record<number, string> = {
  0: 'Incomplete',
  1: 'Static',
  2: 'Kinematic',
  3: 'Dual Antenna',
  4: 'User Command',
  5: 'NVM Seed',
};

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function enumValue(value: unknown, table: Record<number, string>): unknown {
  const key = numeric(value);
  return table[key] ?? value;
}

function sourceBit(value: unknown, bit: number): number {
  const reversed = value.toString(2).split('').reverse().join('');
  return parseInt(reversed[bit]);
}

function deriveRxStatus(fields: StatusRecord): void {
  const rxstatus = numeric(fields.rxstatus);
  const aux1 = numeric(fields.aux1status);
  const aux2 = numeric(fields.aux2status);
  const aux3 = numeric(fields.aux3status);
  const aux4 = numeric(fields.aux4status);

  fields.rxstatus2bit = sourceBit(rxstatus, 2);
  fields.rxstatus3bit = sourceBit(rxstatus, 3);
  fields.rxstatus9bit = sourceBit(rxstatus, 9);
  fields.rxstatus15bit = sourceBit(rxstatus, 15);
  fields.rxstatus17bit = sourceBit(rxstatus, 17);

  const aux3Reversed = aux3.toString(2).split('').reverse().join('');
  fields.aux3status25bit = aux3Reversed.length > 24 ? parseInt(aux3Reversed[25]) : parseInt(aux3Reversed);
  fields.aux4statusBit = aux4 & 0x03;

  const aux1Reversed = aux1 === 0 ? '' : aux1.toString(2).split('').reverse().join('');
  fields.aux1status30bit = aux1Reversed.length > 30 && aux1Reversed[30] === '1' ? 1 : 0;
  fields.aux1status31bit = aux1Reversed.length > 31 && aux1Reversed[31] === '1' ? 1 : 0;

  const ports: Array<{ port: string; bits: number }> = [];
  for (let bit = 0; bit < 32; bit += 1) {
    if (RX_AUX1_PORTS[bit] !== undefined) {
      ports.push({ port: RX_AUX1_PORTS[bit], bits: (aux1 >>> bit) & 1 });
    }
  }
  for (let bit = 0; bit < 32; bit += 1) {
    if (RX_AUX2_PORTS[bit] !== undefined) {
      ports.push({ port: RX_AUX2_PORTS[bit], bits: (aux2 >>> bit) & 1 });
    }
  }
  fields.portsRxData = ports;
  fields.aux1status30Bit = fields.aux1status30bit;
  fields.aux1status31Bit = fields.aux1status31bit;
  fields.rxstatus17Bit = fields.rxstatus17bit;
  fields.noOfStats = fields.noofstats;
}

function deriveAgcStatus(fields: StatusRecord): void {
  const word = numeric(fields.statusWord) >>> 0;
  fields.cardId = AGC_CARD[(word >>> 28) & 0xf] ?? fields.cardId;
  fields.rfType = AGC_RF[(word >>> 25) & 0x7] ?? fields.rfType;
  fields.activeFlag = AGC_ACTIVE[(word >>> 24) & 1] ?? fields.activeFlag;
  fields.binSkew = AGC_BIN_SKEW[(word >>> 23) & 1] ?? fields.binSkew;
  fields.AGCCollaboration = AGC_COLLABORATION[(word >>> 21) & 0x3] ?? fields.AGCCollaboration;
  fields.ADCRange = AGC_RANGE[(word >>> 18) & 0x7] ?? fields.ADCRange;
  fields.noiseFloorCalMethod = AGC_NOISE_FLOOR[(word >>> 15) & 0x7] ?? fields.noiseFloorCalMethod;
  fields.binCountOverflow = AGC_OVERFLOW[(word >>> 14) & 1] ?? fields.binCountOverflow;
  fields.railGain = AGC_RAIL[(word >>> 13) & 1] ?? fields.railGain;
  fields.binsNotFull = AGC_NOT_FULL[(word >>> 12) & 1] ?? fields.binsNotFull;
  fields.binsEmpty = AGC_EMPTY[(word >>> 11) & 1] ?? fields.binsEmpty;
}

function deriveChannelConfig(
  fields: StatusRecord,
  payload: Uint8Array,
  generation: Generation,
): StatusRecord[] {
  if (payload.byteLength < 8) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const setInUse = view.getUint32(0, true);
  const configCount = view.getUint32(4, true);
  const names =
    generation === 'OEM6' || generation === 'OEMSTAR'
      ? chanConfigListSignalType
      : updatedChanConfigListSignalType;
  const all: StatusRecord[] = [];
  const current: StatusRecord[] = [];
  let offset = 8;
  for (
    let configIndex = 0;
    configIndex < configCount && offset + 4 <= payload.byteLength;
    configIndex += 1
  ) {
    const signalCount = view.getUint32(offset, true);
    offset += 4;
    for (
      let signalIndex = 0;
      signalIndex < signalCount && offset + 8 <= payload.byteLength;
      signalIndex += 1
    ) {
      const numChans = view.getUint32(offset, true);
      const signalTypeCode = view.getUint32(offset + 4, true);
      const signalType = (names as Record<string, string>)[String(signalTypeCode)];
      offset += 8;
      if (!signalType) continue;
      const row = { numChans, signalType, signalTypeCode, configIndex };
      all.push(row);
      if (setInUse === configIndex + 1) current.push(row);
    }
  }
  fields.setInUse = setInUse;
  fields.numOfChanConfig = configCount;
  fields.allChanConfigData = all;
  fields.currentChanConfigData = current;
  fields.numChans = all.at(-1)?.numChans ?? 0;
  return all;
}

function deriveCardStatusFans(
  fields: StatusRecord,
  payload: Uint8Array,
): StatusRecord[] {
  const cardsCount = numeric(fields.cardsCount);
  const countAt = 20 + cardsCount * 60;
  if (countAt + 4 > payload.byteLength) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fanCount = view.getUint32(countAt, true);
  const fans: StatusRecord[] = [];
  let offset = countAt + 4;
  for (let index = 0; index < fanCount && offset + 4 <= payload.byteLength; index += 1) {
    fans.push({
      fanSpeed: view.getInt16(offset, true),
      fanFailed: view.getInt16(offset + 2, true),
    });
    offset += 4;
  }
  fields.fansCount = fanCount;
  return fans;
}

function deriveInspvax(fields: StatusRecord): void {
  const extended = numeric(fields.extendedSolution) >>> 0;
  if (Number.isFinite(extended)) {
    fields.converged = (extended >>> 25) & 1 ? 'Converged' : 'Not Converged';
    fields.alignment = INSPVAX_ALIGNMENT[(extended >>> 3) & 0x7] ?? 'Incomplete';
  }
  if (typeof fields.status === 'number') fields.status = INSPVAX_STATUS[numeric(fields.status)] ?? fields.status;
  if (fields.posType === 'NONE') fields.posType = 'None';
  else if (fields.posType === 'SINGLE') fields.posType = 'Single';
}

function deriveFileStatus(fields: StatusRecord, payload: Uint8Array): void {
  if (payload.byteLength < 8) return;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  fields.fileStatusEnum = view.getUint32(4, true);
  let name = '';
  let at = 8;
  while (at < payload.byteLength) {
    const ch = view.getUint8(at);
    if (ch === 0) break;
    name += String.fromCharCode(ch);
    at += 1;
  }
  fields.fileName = name;
  const sizeAt = 128 - name.length + at;
  if (sizeAt + 4 <= payload.byteLength) fields.fileSize = view.getUint32(sizeAt, true);
}

/**
 * Apply the post-field-extraction transformations performed by `logparsers.js`.
 * The input block records are mutated in the same order as the source arrays.
 */
export function deriveStatusFields(
  messageId: number,
  payload: Uint8Array,
  header: StatusRecord,
  blocks?: StatusRecord[],
  generation: Generation = 'OEM7',
  frameIdleTimeRaw?: number,
  secondaryAntenna = false,
): DerivedStatusRecord {
  const fields: StatusRecord = { ...header };
  const rows = blocks ? [...blocks] : undefined;
  if (rows) {
    fields.data = rows;
    for (let index = 0; index < rows.length; index += 1) fields[String(index)] = rows[index];
  }

  switch (messageId) {
    case 83:
      if (rows) {
        const visible = rows.filter((row) => numeric(row.PRN) !== 0);
        visible.forEach((row) => {
          const status = numeric(row.channelTrackingStatus) >>> 0;
          row.satSystem = ['GPS', 'GLONASS', 'SBAS', 'GALILEO', 'BEIDOU', 'QZSS', 'NAVIC', 'OTHER'][
            (status >>> 16) & 0x7
          ];
        });
        fields.data = visible;
        fields.numberOfChannels = visible.length;
      }
      fields.antenna = secondaryAntenna ? 'SECONDARY' : 'PRIMARY';
      break;
    case 1194:
      rows?.forEach((row) => {
        const system = numeric(row.system);
        row.system =
          (satvisConstellationMap as Record<string, string>)[String(system)] ??
          row.system;
        if (row.system === 'GLONASS') row.satelliteID = numeric(row.satelliteIDTemp) + 37;
      });
      break;
    case 1201:
      rows?.forEach((row) => {
        row.trackingState = numeric(row.status) & 0x03;
        if (/[^\w\s.]/.test(String(row.name ?? ''))) row.name = '';
      });
      break;
    case 1968:
    case 2063:
      if (rows) {
        const frequencyStart = numeric(fields.frequencyStart);
        const step = numeric(fields.stepSize) / 1_000_000;
        const samples = rows.map((row, index) => ({
          sample: numeric(row.sample) - 200,
          frequency: frequencyStart + index * step,
        }));
        rows.splice(0, rows.length, ...samples);
        fields.data = rows;
        for (let index = 0; index < rows.length; index += 1) {
          fields[String(index)] = rows[index];
        }
      }
      if (messageId === 2063) fields.band = numeric(fields.status).toString(16);
      break;
    case 93:
      deriveRxStatus(fields);
      break;
    case 963:
      if (rows) {
        rows.forEach((row, index) => {
          const status = numeric(row.status);
          const readingType =
            generation === 'OEMSTAR'
              ? HW_READING_TYPES[index]
              : HW_READING_TYPES[(status >>> 8) & 0xff];
          if (readingType) {
            fields[readingType] = row.reading;
            fields[`${readingType}Bound`] = status & 0xff;
          }
        });
      }
      fields.idleTime = 100 - numeric(frameIdleTimeRaw ?? fields.idleTime) / 2;
      break;
    case 1043: {
      const satelliteSystem =
        (satvisConstellationMap as Record<string, string>)[String(fields.satelliteSystem)] ??
        fields.satelliteSystem;
      fields.satelliteSystem = satelliteSystem;
      if (satelliteSystem === 'GLONASS') {
        rows?.forEach((row) => {
          if (row.satelliteIdTemp !== undefined) {
            row.satelliteId = numeric(row.satelliteIdTemp) + 37;
          }
        });
      }
      break;
    }
    case 2127:
      deriveFileStatus(fields, payload);
      break;
    case 1465:
      deriveInspvax(fields);
      break;
    case 1148: {
      const all = deriveChannelConfig(fields, payload, generation);
      if (rows) rows.splice(0, rows.length, ...all);
      fields.data = all;
      break;
    }
    case 4096:
      rows?.forEach(deriveAgcStatus);
      break;
    case 1249: {
      if (payload.byteLength >= 12) {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        let offset = 12;
        for (const key of ['endpoint', 'mountpoint', 'userName', 'password']) {
          const result = readVariableString(dv, offset);
          fields[key] = result.value;
          offset = result.offset;
        }
        if (offset + 4 <= payload.byteLength) fields.bindInterface = dv.getUint32(offset, true);
      }
      break;
    }
    case 4105: {
      if (payload.byteLength >= 4) {
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const count = dv.getUint32(0, true);
        let offset = 4;
        const commands: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const start = offset;
          let command = '';
          while (offset < payload.byteLength && dv.getUint8(offset) !== 0) {
            command += String.fromCharCode(dv.getUint8(offset));
            offset += 1;
          }
          commands.push(command);
          offset = start + command.length + 1;
        }
        fields.count = count;
        fields.configData = commands;
      }
      break;
    }
    case 4098:
      fields.state = enumValue(fields.state, GIII_STATE);
      fields.mode = enumValue(fields.mode, GIII_MODE);
      if (rows) {
        rows.forEach((row) => {
          row.idleTime = 100 - numeric(row.idleTime);
          row.component = enumValue(row.component, GIII_COMPONENT);
        });
        fields.cardsData = rows;
      }
      fields.fansData = deriveCardStatusFans(fields, payload);
      break;
    case 4103:
      if (rows) {
        rows.forEach((row) => {
          row.rejectcode = numeric(row.channelStatus) >>> 24;
        });
        fields.channelData = rows;
        fields.channelCount = rows.length;
      }
      break;
    case 4106:
      if (rows) {
        fields.channelData = rows;
        fields.channelCount = rows.length;
      }
      fields.satelliteSystem =
        (giiiSatvisConstellationMap as Record<string, string>)[
          String(fields.satelliteSystem)
        ] ?? fields.satelliteSystem;
      fields.satSystem = fields.satelliteSystem;
      fields.satVis = fields.satVisibility;
      fields.compAlm = fields.almanacFlag;
      break;
    case 4107:
      fields.clockModel = enumValue(fields.clockModel, GIII_CLOCK);
      fields.signalType = GIII_SIGNAL[numeric(fields.signalType)] ?? '--';
      fields.clockDrift = Number(fields.clockDrift).toFixed(20);
      if (rows) {
        fields.channelData = rows;
        fields.channelCount = rows.length;
      }
      break;
    default:
      break;
  }
  return { fields, blocks: rows };
}
