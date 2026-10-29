/**
 * Binary command construction.
 *
 * Mirrors `01_解包/app/controller/frameCommand.js:59-138` (`binaryCommand` + `fill_command_request`)
 * and `01_解包/app/jarvisInterface.js:5349-5413` (`frameUnlogDataMap` / `frameLogDataMap`).
 *
 * Every binary command is a 28-byte long header + payload + 4-byte little-endian CRC.
 */

import { buildLongHeader, PORT_ADDRESS_THISPORT_30 } from './header.ts';
import { appendCrcLe } from './crc.ts';

export type ParamType =
  | 'enum'
  | 'ulong'
  | 'short'
  | 'ushort'
  | 'float'
  | 'double'
  | 'novatelchar'
  | 'string'
  | 'char'
  | 'boolean';

export interface CommandParam {
  type: ParamType;
  value: string | number;
  /** Declared byte width. For 'string' the application derives it from the padded value. */
  length: number;
}

/**
 * Parameter padding rules, copied verbatim from `binaryCommand` (`frameCommand.js:62-80`):
 *  - not a multiple of 4  -> pad with NUL up to the next multiple of 4
 *  - already a multiple of 4 and does not already end in NUL -> append **four** NULs
 */
export function padStringValue(value: string): { value: string; length: number } {
  if (value.length % 4 !== 0) {
    let padded = value;
    const pad = 4 - (value.length % 4);
    for (let i = 0; i < pad; i++) padded += '\0';
    return { value: padded, length: padded.length };
  }
  if (value.charAt(value.length - 1) !== '\0') {
    const padded = value + '\0\0\0\0';
    return { value: padded, length: padded.length };
  }
  return { value, length: value.length };
}

export interface BuildBinaryCommandOptions {
  messageId: number;
  params: CommandParam[];
  portAddress?: number;
  messageType?: number;
  sequence?: number;
}

export function buildBinaryCommand(options: BuildBinaryCommandOptions): Uint8Array {
  const params = options.params.map((p) =>
    p.type === 'string' ? { ...p, ...padStringValue(String(p.value)) } : p,
  );
  const payloadLength = params.reduce((sum, p) => sum + p.length, 0);
  const header = buildLongHeader({
    messageId: options.messageId,
    payloadLength,
    messageType: options.messageType ?? 0,
    portAddress: options.portAddress ?? PORT_ADDRESS_THISPORT_30,
    sequence: options.sequence ?? 0,
  });

  const out = new Uint8Array(header.length + payloadLength);
  out.set(header, 0);
  const dv = new DataView(out.buffer);
  let offset = header.length;
  for (const p of params) {
    writeParam(dv, offset, p);
    offset += p.length;
  }
  return appendCrcLe(out);
}

function writeParam(dv: DataView, offset: number, p: CommandParam): void {
  switch (p.type) {
    case 'enum':
    case 'ulong':
      dv.setUint32(offset, Number(p.value) >>> 0, true);
      break;
    case 'short':
      dv.setInt16(offset, Number(p.value), true);
      break;
    case 'ushort':
      dv.setUint16(offset, Number(p.value), true);
      break;
    case 'float':
      dv.setFloat32(offset, Number(p.value), true);
      break;
    case 'double':
      dv.setFloat64(offset, Number(p.value), true);
      break;
    case 'char':
      dv.setUint8(offset, Number(p.value) & 0xff);
      break;
    case 'novatelchar': {
      const s = String(p.value);
      for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i) & 0xff);
      break;
    }
    case 'string': {
      const s = String(p.value);
      for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i) & 0xff);
      break;
    }
    case 'boolean':
      // The original `fill_command_request` has no branch for 'boolean' and therefore writes
      // nothing; the bytes stay zero. Reproduced deliberately (see R-notes) and flagged by the
      // caller through `unsupportedParamTypes()`.
      break;
  }
}

/** Param types the original silently leaves unwritten. */
export function unsupportedParamTypes(params: CommandParam[]): ParamType[] {
  return params.filter((p) => p.type === 'boolean').map((p) => p.type);
}

// ---- LOG / UNLOG payload layouts ------------------------------------------------------------

export interface LogRequest {
  /** Port address, e.g. 222 for THISPORT_30. */
  portAddress: number;
  messageId: number;
  /** false = binary log, true = ASCII log (message type byte 32). */
  ascii: boolean;
  /** ONNEW | ONCHANGED | ONTIME | ONNEXT | ONCE | ONMARK | ONALL */
  trigger: string;
  periodSeconds: number;
  offsetSeconds?: number;
  /** HOLD | NOHOLD */
  hold?: string;
  triggerValues: Record<string, number>;
  holdValues: Record<string, number>;
}

/** `LOG` command payload: port, id, type, reserved, trigger, period, offset, hold (32 bytes). */
export function buildLogCommand(req: LogRequest, logCommandId = 1): Uint8Array {
  const triggerValue = req.triggerValues[req.trigger.toUpperCase()];
  if (triggerValue === undefined) throw new Error('unknown trigger: ' + req.trigger);
  const holdName = (req.hold ?? 'HOLD').toUpperCase();
  const holdValue = req.holdValues[holdName] ?? 0;
  const period = req.trigger.toUpperCase() === 'ONTIME' ? req.periodSeconds : 0;

  return buildBinaryCommand({
    messageId: logCommandId,
    params: [
      { type: 'enum', value: req.portAddress, length: 4 },
      { type: 'ushort', value: req.messageId, length: 2 },
      { type: 'char', value: req.ascii ? 32 : 0, length: 1 },
      { type: 'char', value: 0, length: 1 }, // reserved
      { type: 'enum', value: triggerValue, length: 4 },
      { type: 'double', value: period, length: 8 },
      { type: 'double', value: req.offsetSeconds ?? 0, length: 8 },
      { type: 'enum', value: holdValue, length: 4 },
    ],
  });
}

/** `UNLOG` command payload: port, id, type, reserved (8 bytes). Message id 36 (`UNLOGALL` is 38). */
export function buildUnlogCommand(
  args: { portAddress: number; messageId: number; ascii?: boolean },
  unlogCommandId = 36,
): Uint8Array {
  return buildBinaryCommand({
    messageId: unlogCommandId,
    params: [
      { type: 'enum', value: args.portAddress, length: 4 },
      { type: 'ushort', value: args.messageId, length: 2 },
      { type: 'char', value: args.ascii ? 32 : 0, length: 1 },
      { type: 'char', value: 0, length: 1 },
    ],
  });
}
