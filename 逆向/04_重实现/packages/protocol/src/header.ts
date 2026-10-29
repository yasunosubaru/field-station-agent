/**
 * NovAtel SBF message headers.
 *
 * Long header (28 bytes) — OEM7 Commands and Logs Reference Manual, Table 4, cross-checked
 * against `01_解包/app/controller/frameCommand.js:6-56` (`toem4header`).
 *
 * Short header (12 bytes) — Table 9, cross-checked against
 * `01_解包/app/controller/genericparser.js:112-126` and `01_解包/app/jarvisInterface.js:6391-6392`.
 */

export const SYNC_1 = 0xaa;
export const SYNC_2 = 0x44;
export const SYNC_BINARY_FULL = 0x12;
export const SYNC_BINARY_SHORT = 0x13;

export const LONG_HEADER_LENGTH = 28;
export const SHORT_HEADER_LENGTH = 12;

/** `THISPORT_30` — the port address the application stamps on every outgoing binary command. */
export const PORT_ADDRESS_THISPORT_30 = 222;
/** `THISPORT` — what the manual tells you to use for ASCII/binary commands. */
export const PORT_ADDRESS_THISPORT = 192;

export type MessageFormat = 'binary' | 'ascii' | 'abbreviated-ascii' | 'reserved';

export interface LongHeader {
  kind: 'long';
  headerLength: 28;
  messageId: number;
  /** Raw byte 6: bits 0-4 measurement source, bits 5-6 format, bit 7 response. */
  messageTypeByte: number;
  format: MessageFormat;
  isResponse: boolean;
  /** Bit 0 of message type: log came from the secondary antenna. */
  secondaryAntenna: boolean;
  portAddress: number;
  payloadLength: number;
  sequence: number;
  /** Idle time as reported (0..200); divide by 2 for percent. */
  idleTimeRaw: number;
  timeStatus: number;
  week: number;
  milliseconds: number;
  receiverStatus: number;
  reserved: number;
  softwareVersion: number;
}

export interface ShortHeader {
  kind: 'short';
  headerLength: 12;
  /** Note: the short header carries no message-id-width sync `msgType`/port field. */
  messageId: number;
  payloadLength: number;
  week: number;
  milliseconds: number;
}

export type SbfHeader = LongHeader | ShortHeader;

/** Total frame length (header + payload + 4 CRC bytes). */
export function frameLength(header: SbfHeader): number {
  return header.headerLength + header.payloadLength + 4;
}

export function formatOf(messageTypeByte: number): MessageFormat {
  switch ((messageTypeByte >> 5) & 0b11) {
    case 0:
      return 'binary';
    case 1:
      return 'ascii';
    case 2:
      return 'abbreviated-ascii';
    default:
      return 'reserved';
  }
}

/**
 * Parse a header at `offset`. Returns `null` when the sync or the length fields are not
 * self-consistent; returns `'need-more'` when fewer than `headerLength` bytes are available.
 */
export function parseHeader(bytes: Uint8Array, offset = 0): SbfHeader | 'need-more' | null {
  if (bytes[offset] !== SYNC_1 || bytes[offset + 1] !== SYNC_2) return null;
  const sync3 = bytes[offset + 2];
  if (sync3 === SYNC_BINARY_FULL) {
    if (bytes.length - offset < LONG_HEADER_LENGTH) return 'need-more';
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, LONG_HEADER_LENGTH);
    const messageTypeByte = dv.getUint8(6);
    return {
      kind: 'long',
      headerLength: LONG_HEADER_LENGTH,
      messageId: dv.getUint16(4, true),
      messageTypeByte,
      format: formatOf(messageTypeByte),
      isResponse: (messageTypeByte & 0x80) !== 0,
      secondaryAntenna: (messageTypeByte & 0x01) !== 0,
      portAddress: dv.getUint8(7),
      payloadLength: dv.getUint16(8, true),
      sequence: dv.getUint16(10, true),
      idleTimeRaw: dv.getUint8(12),
      timeStatus: dv.getUint8(13),
      week: dv.getUint16(14, true),
      milliseconds: dv.getUint32(16, true),
      receiverStatus: dv.getUint32(20, true),
      reserved: dv.getUint16(24, true),
      softwareVersion: dv.getUint16(26, true),
    };
  }
  if (sync3 === SYNC_BINARY_SHORT) {
    if (bytes.length - offset < SHORT_HEADER_LENGTH) return 'need-more';
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, SHORT_HEADER_LENGTH);
    return {
      kind: 'short',
      headerLength: SHORT_HEADER_LENGTH,
      messageId: dv.getUint16(4, true),
      payloadLength: dv.getUint8(3),
      week: dv.getUint16(6, true),
      milliseconds: dv.getUint32(8, true),
    };
  }
  return null;
}

export interface BuildLongHeaderOptions {
  messageId: number;
  payloadLength: number;
  messageType?: number;
  portAddress?: number;
  sequence?: number;
  idleTimeRaw?: number;
  timeStatus?: number;
  week?: number;
  milliseconds?: number;
  receiverStatus?: number;
  reserved?: number;
  softwareVersion?: number;
}

/** Serialise a long header. Defaults reproduce `toem4header` defaults exactly. */
export function buildLongHeader(opts: BuildLongHeaderOptions): Uint8Array {
  const out = new Uint8Array(LONG_HEADER_LENGTH);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, SYNC_1);
  dv.setUint8(1, SYNC_2);
  dv.setUint8(2, SYNC_BINARY_FULL);
  dv.setUint8(3, LONG_HEADER_LENGTH);
  dv.setUint16(4, opts.messageId, true);
  dv.setUint8(6, opts.messageType ?? 0x00);
  dv.setUint8(7, opts.portAddress ?? PORT_ADDRESS_THISPORT_30);
  dv.setUint16(8, opts.payloadLength, true);
  dv.setUint16(10, opts.sequence ?? 0, true);
  dv.setUint8(12, opts.idleTimeRaw ?? 0);
  dv.setUint8(13, opts.timeStatus ?? 0);
  dv.setUint16(14, opts.week ?? 0, true);
  dv.setUint32(16, opts.milliseconds ?? 0, true);
  dv.setUint32(20, opts.receiverStatus ?? 0, true);
  dv.setUint16(24, opts.reserved ?? 0, true);
  dv.setUint16(26, opts.softwareVersion ?? 0, true);
  return out;
}
