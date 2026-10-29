/**
 * Field decoding, driven by tables extracted from `01_解包/app/model/logparsers.js`.
 *
 * The original reads every field through `getData()` (`logparsers.js:624-692`) with an offset
 * relative to the **start of the payload** (it adds `NovatelIdConstants.MessageHeaderLength` = 28
 * unconditionally, even for short-header logs).
 *
 * Fidelity rules worth keeping:
 *  - `SHORT` is decoded as **unsigned** 16-bit (`getUint16`), despite the name.
 *  - a read that would run past the end returns `0` instead of throwing.
 *  - fixed strings are read as raw bytes with NULs removed (no UTF-8 handling).
 */

export type FieldType =
  | 'UCHAR'
  | 'DOUBLE'
  | 'ENUM'
  | 'FLOAT'
  | 'HEX'
  | 'UINT_16'
  | 'UINT_32'
  | 'INT_32'
  | 'ULONG16'
  | 'ULONG32'
  | 'ULONG64'
  | 'SHORT'
  | 'STRING_4'
  | 'STRING_8'
  | 'STRING_12'
  | 'STRING_16'
  | 'STRING_18'
  | 'ustringvariable';

/** Legacy spec shape: `{ field: [TYPE, offset] }` (the extracted `xxxJSON` tables). */
export type FieldSpec = Record<string, [FieldType, number]>;

/** Rich spec shape: per-field type, offset, optional scale and enum table. */
export interface RichField {
  type: FieldType | string;
  offset: number;
  scale?: number;
  enum?: Record<string, number>;
  note?: string;
}

export interface RichSpec {
  name?: string;
  /** True when the message carries a repeated block that needs a bespoke decoder. */
  repeat?: boolean;
  fields: Record<string, RichField>;
}

export interface DecodeOptions {
  /** Bytes of header already removed; pass 0 when `payload` is already the payload slice. */
  headerOffset?: number;
  transform?: (field: string, raw: unknown) => unknown;
}

const STRING_LENGTHS: Record<string, number> = {
  STRING_4: 4,
  STRING_8: 8,
  STRING_12: 12,
  STRING_16: 16,
  STRING_18: 18,
};

function readRaw(dv: DataView, byteLength: number, type: string, at: number): unknown {
  if (at < 0 || at + 1 > byteLength) return 0;
  switch (type) {
    case 'ENUM':
    case 'UINT_32':
    case 'ULONG32':
      return dv.getUint32(at, true);
    case 'DOUBLE':
      return dv.getFloat64(at, true);
    case 'FLOAT':
      return dv.getFloat32(at, true);
    case 'UCHAR':
    case 'HEX':
      return dv.getUint8(at);
    case 'UINT_16':
    case 'ULONG16':
    case 'SHORT':
      return dv.getUint16(at, true);
    case 'INT_32':
      return dv.getInt32(at, true);
    case 'ULONG64':
      return dv.getBigUint64(at, true).toString(10);
    case 'ustringvariable':
      return readVariableString(dv, at);
    default: {
      const len = STRING_LENGTHS[type];
      if (len === undefined) return 0;
      return readFixedString(dv, at, len);
    }
  }
}

export function decodeFields(
  bytes: Uint8Array,
  spec: FieldSpec,
  options: DecodeOptions = {},
): Record<string, unknown> {
  const headerOffset = options.headerOffset ?? 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, unknown> = {};
  for (const [field, [type, offset]] of Object.entries(spec)) {
    const raw = readRaw(dv, bytes.byteLength, type, headerOffset + offset);
    out[field] = options.transform ? options.transform(field, raw) : raw;
  }
  return out;
}

/**
 * Decode with a rich spec: applies `scale` and maps `enum` values.
 * Fields whose offset is negative are descriptive only ("<readingType>") and are skipped.
 */
export function decodeMessage(
  bytes: Uint8Array,
  spec: RichSpec,
  options: DecodeOptions = {},
): Record<string, unknown> {
  const headerOffset = options.headerOffset ?? 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, unknown> = {};
  for (const [field, def] of Object.entries(spec.fields)) {
    if (def.offset < 0) continue;
    let value = readRaw(dv, bytes.byteLength, def.type, headerOffset + def.offset);
    if (def.enum && typeof value === 'number') {
      const byName = def.enum;
      for (const [name, num] of Object.entries(byName)) {
        if (num === value) {
          value = name;
          break;
        }
      }
    }
    if (def.scale !== undefined && typeof value === 'number') value = value * def.scale;
    out[field] = options.transform ? options.transform(field, value) : value;
  }
  return out;
}

/** Fixed-length string with NULs stripped (`getString(n).replace(/\0/g,'')`). */
export function readFixedString(dv: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const at = offset + i;
    if (at >= dv.byteLength) break;
    const b = dv.getUint8(at);
    if (b !== 0) s += String.fromCharCode(b);
  }
  return s;
}

/**
 * Variable-length NUL-terminated string plus the offset of the next field.
 *
 * Mirrors `getData`'s `ustringvariable` branch: after the NUL, skip to a 4-byte boundary and then
 * advance one more word when already aligned (`logparsers.js:664-691`, `getNextOffesetBasedonLength`
 * at `:731-748`).
 */
export function readVariableString(dv: DataView, offset: number): { value: string; offset: number } {
  let s = '';
  let at = offset;
  while (at < dv.byteLength) {
    const ch = dv.getUint8(at);
    if (ch === 0) {
      let rem = s.length % 4;
      if (rem > 0) {
        rem = 4 - rem;
        at += rem;
      }
      if (rem === 0) at += 4;
      return { value: s, offset: at };
    }
    s += String.fromCharCode(ch);
    at += 1;
  }
  return { value: s, offset: at };
}

/** Cached loader for `data/parser-tables.json`. */
export interface ParserTables {
  typeConstants: Record<string, string>;
  tables: Record<string, FieldSpec>;
  duplicates?: Array<Record<string, unknown>>;
}

/**
 * Describes a repeated payload (`data/repeat-layouts.json`): either a fixed
 * header plus equal-stride blocks, or a `custom` decoder for variable/nested
 * records such as AUTHCODES and INSCONFIG.
 */
export interface RepeatLayout {
  name?: string;
  /** Name of the decoded header field holding the block count. */
  countField: string;
  /**
   * Explicit fixed-header fields. Defaults to every field whose absolute offset is before
   * `blockStart`; HWMONITOR needs this because its idleTime absolute offset lies after the first
   * record but is still payload-level data, not part of each 8-byte measurement.
   */
  headerFields?: string[];
  /** Absolute payload offset of the first block. */
  blockStart: number;
  /** Bytes per block; for custom layouts this is the base record overhead. */
  blockSize: number;
  /**
   * Optional bespoke decoder for records whose length is not fixed or whose
   * nested counts make a single stride insufficient. Fixed layouts omit this.
   */
  custom?:
    | 'validModels'
    | 'authCodes'
    | 'insConfig'
    | 'itFilterTable'
    | 'itProgFilterBank';
  /** Block-relative field table. */
  fields: Record<string, RichField>;
}

export interface RepeatedResult {
  header: Record<string, unknown>;
  blocks: Array<Record<string, unknown>>;
  declaredCount: number;
  /** Blocks actually decoded; smaller than `declaredCount` when the payload is truncated. */
  decodedCount: number;
  truncated: boolean;
}

/**
 * Decode a repeated-block message. Header fields are those whose absolute offset falls before
 * `layout.blockStart`; everything at or after it belongs to the block.
 */
export function decodeRepeated(
  bytes: Uint8Array,
  spec: RichSpec,
  layout: RepeatLayout,
): RepeatedResult {
  if (layout.custom) {
    return decodeCustomRepeated(bytes, spec, layout);
  }
  const header: Record<string, unknown> = {};
  const headerSpec: RichSpec = { fields: {} };
  const explicitHeader = layout.headerFields ? new Set(layout.headerFields) : undefined;
  for (const [field, def] of Object.entries(spec.fields)) {
    if (def.offset < 0) continue;
    if (explicitHeader) {
      if (!explicitHeader.has(field)) continue;
    } else if (def.offset >= layout.blockStart) {
      continue;
    }
    headerSpec.fields[field] = def;
  }
  Object.assign(header, decodeMessage(bytes, headerSpec));

  const declaredCount = Number(header[layout.countField] ?? 0);
  const capacity = Math.max(0, Math.floor((bytes.byteLength - layout.blockStart) / layout.blockSize));
  const count = Math.max(0, Math.min(Number.isFinite(declaredCount) ? declaredCount : capacity, capacity));

  const blocks: Array<Record<string, unknown>> = [];
  const blockSpec: RichSpec = { fields: layout.fields };
  for (let i = 0; i < count; i++) {
    const start = layout.blockStart + i * layout.blockSize;
    const slice = bytes.subarray(start, start + layout.blockSize);
    blocks.push(decodeMessage(slice, blockSpec));
  }
  return {
    header,
    blocks,
    declaredCount,
    decodedCount: blocks.length,
    truncated: capacity < (Number.isFinite(declaredCount) ? declaredCount : capacity),
  };
}

function projectedFields(
  spec: RichSpec,
  names: string[],
  base: number,
  offsetsAreRelative: boolean,
): RichSpec {
  const fields: Record<string, RichField> = {};
  for (const name of names) {
    const field = spec.fields[name];
    if (!field) continue;
    fields[name] = {
      ...field,
      offset: offsetsAreRelative ? field.offset : field.offset - base,
    };
  }
  return { fields };
}

function repeatedResult(
  header: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
  declaredCount: number,
  truncated = false,
): RepeatedResult {
  return {
    header,
    blocks,
    declaredCount,
    decodedCount: blocks.length,
    truncated: truncated || blocks.length < declaredCount,
  };
}

function decodeCustomRepeated(
  bytes: Uint8Array,
  spec: RichSpec,
  layout: RepeatLayout,
): RepeatedResult {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (layout.custom) {
    case 'validModels': {
      const declaredCount = dv.byteLength >= 4 ? dv.getUint32(0, true) : 0;
      const header = { noOfModels: declaredCount };
      const blocks: Array<Record<string, unknown>> = [];
      let offset = layout.blockStart;
      let truncated = false;
      for (let index = 0; index < declaredCount; index += 1) {
        if (offset >= bytes.byteLength) {
          truncated = true;
          break;
        }
        const model = readVariableString(dv, offset);
        if (offset + 24 > bytes.byteLength) {
          truncated = true;
          break;
        }
        blocks.push({
          model: model.value,
          expyear: dv.getUint32(offset + 12, true),
          expmonth: dv.getUint32(offset + 16, true),
          expday: dv.getUint32(offset + 20, true),
        });
        offset = model.offset + 12;
      }
      return repeatedResult(header, blocks, declaredCount, truncated);
    }
    case 'authCodes': {
      const declaredCount = dv.byteLength >= 8 ? dv.getUint32(4, true) : 0;
      const headerFields = decodeMessage(
        bytes,
        projectedFields(spec, ['signatureStatus', 'noOfAuthCodes'], 0, false),
      );
      if (headerFields.signatureStatus === undefined && bytes.byteLength >= 4) {
        headerFields.signatureStatus = dv.getUint32(0, true);
      }
      const blocks: Array<Record<string, unknown>> = [];
      let offset = 0;
      let truncated = false;
      for (let index = 0; index < declaredCount; index += 1) {
        if (offset + 16 >= bytes.byteLength) {
          truncated = true;
          break;
        }
        const record = decodeMessage(
          bytes.subarray(offset),
          projectedFields(spec, ['authCodeType', 'authCodeValidity'], 0, false),
        );
        const string = readVariableString(dv, offset + 16);
        if (!string.value && offset + 16 >= bytes.byteLength) {
          truncated = true;
          break;
        }
        blocks.push({ ...record, authCodeString: string.value });
        offset = string.offset + 20;
      }
      return repeatedResult(headerFields, blocks, declaredCount, truncated);
    }
    case 'insConfig': {
      const headerNames = [
        'IMUType',
        'mapping',
        'initAlignmentVelocity',
        'heaveWindow',
        'profile',
        'enabledUpdates',
        'alignmentMode',
        'relativeInsOutputFrame',
        'relativeInsOutputDir',
        'insReceiverStatus',
        'insSeedEnabled',
        'insSeedValidation',
        'noOfTranslations',
      ];
      const header = decodeMessage(
        bytes,
        projectedFields(spec, headerNames, 0, false),
      );
      const declaredCount = Number(header.noOfTranslations ?? 0);
      const translationNames = [
        'insTranslation',
        'inputFrame',
        'xTranslation',
        'yTranslation',
        'zTranslation',
        'xTranslationSD',
        'yTranslationSD',
        'zTranslationSD',
        'translationSource',
      ];
      const rotationNames = [
        'rotationalOffset',
        'frame',
        'xRotation',
        'yRotation',
        'zRotation',
        'xRotationSD',
        'yRotationSD',
        'zRotationSD',
        'rotationSource',
      ];
      const translationSpec = projectedFields(spec, translationNames, 0, true);
      const rotationSpec = projectedFields(spec, rotationNames, 0, true);
      const translations: Array<Record<string, unknown>> = [];
      const translationEntries: Record<string, unknown> = {};
      let offset = layout.blockStart;
      let truncated = false;
      for (let index = 0; index < declaredCount; index += 1) {
        if (offset + layout.blockSize > bytes.byteLength) {
          truncated = true;
          break;
        }
        const entry = decodeMessage(bytes.subarray(offset), translationSpec);
        translations.push(entry);
        translationEntries[String(entry.insTranslation)] = entry;
        offset += layout.blockSize;
      }
      header.transalationEntries = translationEntries;
      if (offset + 4 > bytes.byteLength) {
        header.noOfRotations = 0;
        header.rotationEntries = {};
        return repeatedResult(header, translations, declaredCount, true);
      }
      const rotationCount = dv.getUint32(offset, true);
      header.noOfRotations = rotationCount;
      offset += 4;
      const rotations: Record<string, unknown> = {};
      for (let index = 0; index < rotationCount; index += 1) {
        if (offset + 36 > bytes.byteLength) {
          truncated = true;
          break;
        }
        const entry = decodeMessage(bytes.subarray(offset), rotationSpec);
        rotations[String(entry.rotationalOffset)] = entry;
        offset += 36;
      }
      header.rotationEntries = rotations;
      return repeatedResult(header, translations, declaredCount, truncated);
    }
    case 'itFilterTable': {
      const header = decodeMessage(
        bytes,
        projectedFields(spec, ['noOfRecords'], 0, false),
      );
      const declaredCount = Number(header.noOfRecords ?? 0);
      const recordNames = [
        'frequencyType',
        'encoderId',
        'ddcFilterType',
        'statusWord',
        'globalSwitch',
        'globalLowerCutOffFrequency',
        'globalUpperCutOffFrequency',
        'noOfProgFilters',
      ];
      const progNames = [
        'switch',
        'progFilterId',
        'mode',
        'lowerCutOffFrequency',
        'upperCutOffFrequency',
        'notchWidth',
      ];
      const recordSpec = projectedFields(spec, recordNames, layout.blockStart, false);
      const progSpec = projectedFields(spec, progNames, 36, false);
      const blocks: Array<Record<string, unknown>> = [];
      let offset = layout.blockStart;
      let truncated = false;
      for (let index = 0; index < declaredCount; index += 1) {
        if (offset + layout.blockSize > bytes.byteLength) {
          truncated = true;
          break;
        }
        const record = decodeMessage(bytes.subarray(offset), recordSpec);
        const filterCount = Number(record.noOfProgFilters ?? 0);
        let filterOffset = offset + 32;
        const progFilters: Array<Record<string, unknown>> = [];
        for (let filter = 0; filter < filterCount; filter += 1) {
          if (filterOffset + 24 > bytes.byteLength) {
            truncated = true;
            break;
          }
          progFilters.push(decodeMessage(bytes.subarray(filterOffset), progSpec));
          filterOffset += 24;
        }
        blocks.push({ ...record, progFilters });
        offset += 32 + filterCount * 24;
      }
      return repeatedResult(header, blocks, declaredCount, truncated);
    }
    case 'itProgFilterBank': {
      const header = decodeMessage(
        bytes,
        projectedFields(spec, ['noOfFrequencies'], 0, false),
      );
      const declaredCount = Number(header.noOfFrequencies ?? 0);
      const bankNames = [
        'progFiltMode',
        'minLowerFrequencyCutOff',
        'maxLowerFrequencyCutOff',
        'minUpperFrequencyCutOff',
        'maxUpperFrequencyCutOff',
        'frequencyStep',
        'notchWidth',
      ];
      const bankSpec = projectedFields(spec, bankNames, 12, false);
      const blocks: Array<Record<string, unknown>> = [];
      let offset = layout.blockStart;
      let truncated = false;
      for (let index = 0; index < declaredCount; index += 1) {
        if (offset + 8 > bytes.byteLength) {
          truncated = true;
          break;
        }
        const frequencyTypeValue = readRaw(
          dv,
          bytes.byteLength,
          spec.fields.frequencyType.type,
          offset,
        );
        const frequencyType = mapEnum(spec.fields.frequencyType, frequencyTypeValue);
        const noOfBanks = dv.getUint32(offset + 4, true);
        let bankOffset = offset + 8;
        const banks: Array<Record<string, unknown>> = [];
        for (let bank = 0; bank < noOfBanks; bank += 1) {
          if (bankOffset + 28 > bytes.byteLength) {
            truncated = true;
            break;
          }
          banks.push(decodeMessage(bytes.subarray(bankOffset), bankSpec));
          bankOffset += 28;
        }
        blocks.push({ frequencyType, noOfBanks, bank: banks });
        offset += 8 + noOfBanks * 28;
      }
      return repeatedResult(header, blocks, declaredCount, truncated);
    }
    default:
      throw new Error(`unknown repeat layout decoder: ${layout.custom}`);
  }
}

function mapEnum(field: RichField, value: unknown): unknown {
  if (!field.enum || typeof value !== 'number') return value;
  for (const [name, number] of Object.entries(field.enum)) {
    if (number === value) return name;
  }
  return value;
}

export function findSpec(tables: ParserTables, tableName: string): FieldSpec {
  const spec = tables.tables[tableName];
  if (!spec) throw new Error('unknown parser table: ' + tableName);
  return spec;
}
