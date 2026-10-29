/**
 * NovAtel CRC-32.
 *
 * Observed implementation: `01_解包/app/controller/crc.js:148-178` and
 * `01_解包/app/controller/frameCommand.js:163-184` — reflected polynomial 0xEDB88320,
 * initial value 0, no final XOR. This is CRC-32/ISO-HDLC minus init/final inversion.
 *
 * Verified against the two vectors printed in the OEM7 Commands and Logs Reference Manual,
 * section 1.10 ("ASCII log message" and "Binary checksum calculation").
 */

const CRC32_POLYNOMIAL = 0xedb88320;

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ CRC32_POLYNOMIAL : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC over a byte range. Pass `null` for the table to use the bitwise form (slower, same result). */
export function novatelCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

/** Eight lowercase hex digits, left padded with zeros — the ASCII log/command form. */
export function crcHex(crc: number): string {
  return (crc >>> 0).toString(16).padStart(8, '0');
}

/** Append the CRC as four little-endian bytes — the binary log/command form. */
export function appendCrcLe(body: Uint8Array): Uint8Array {
  const crc = novatelCrc32(body);
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, crc, true);
  return out;
}

export function readCrcLe(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}
