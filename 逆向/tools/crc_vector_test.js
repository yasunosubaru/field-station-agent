// Verify the NovAtel CRC-32 (init 0, no final XOR, reflected poly 0xEDB88320)
// against the two test vectors printed in the OEM7 Commands and Logs Reference Manual (section 1.10).
function buildTable() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
}
const TABLE = buildTable();
function novatelCrc(buf) {
  let crc = 0;
  for (const b of buf) crc = (TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return crc >>> 0;
}

// --- vector 1: ASCII log body (excluding the leading '#') ---
const ascii = 'BESTPOSA,COM1,0,78.0,FINESTEERING,1427,325298.000,00000000,6145,2748;SOL_COMPUTED,SINGLE,51.11678928753,-114.03886216575,1064.3470,-16.2708,WGS84,2.3434,1.3043,4.7300,"",0.000,0.000,7,7,0,0,0,06,0,03';
const got1 = novatelCrc(Buffer.from(ascii, 'binary'));
console.log('ascii len=' + ascii.length + ' crc=0x' + got1.toString(16) + ' expect=0x9c9a92bb ' + (got1 === 0x9c9a92bb ? 'PASS' : 'FAIL'));

// --- vector 2: binary log (header + body, no CRC) ---
const hex =
  'AA44121C2A00022' + '048 00'.replace(/ /g, '') +
  '0000' + '90B4' + '9305' + 'B0AB' + 'B912' + '0000' + '0000' + '4561' + 'BC0A' + '0000' +
  '0000' + '1000' + '0000' + '1B04' +
  '50B3F28E4940' + '16FA6BBE7C82' + '5CC00060769F44' + '9F9040' + 'A62A82C1' + '3D000000' +
  '125ACB3F' + 'CD9E983F' + 'DB664040' + '00303030' + '00000000' + '00000000' + '0B0B0000' + '00060003';
// rebuild exactly from the manual listing instead of the joined string above
const bytes = [
  0xAA, 0x44, 0x12, 0x1C, 0x2A, 0x00, 0x02, 0x20, 0x48, 0x00,
  0x00, 0x00, 0x90, 0xB4, 0x93, 0x05, 0xB0, 0xAB, 0xB9, 0x12,
  0x00, 0x00, 0x00, 0x00, 0x45, 0x61, 0xBC, 0x0A, 0x00, 0x00,
  0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x1B, 0x04, 0x50, 0xB3,
  0xF2, 0x8E, 0x49, 0x40, 0x16, 0xFA, 0x6B, 0xBE, 0x7C, 0x82,
  0x5C, 0xC0, 0x00, 0x60, 0x76, 0x9F, 0x44, 0x9F, 0x90, 0x40,
  0xA6, 0x2A, 0x82, 0xC1, 0x3D, 0x00, 0x00, 0x00, 0x12, 0x5A,
  0xCB, 0x3F, 0xCD, 0x9E, 0x98, 0x3F, 0xDB, 0x66, 0x40, 0x40,
  0x00, 0x30, 0x30, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x0B, 0x0B, 0x00, 0x00, 0x00, 0x06, 0x00, 0x03,
];
const got2 = novatelCrc(Uint8Array.from(bytes));
console.log('binary len=' + bytes.length + ' crc=0x' + got2.toString(16) + ' expect=0x42dc4c48 ' + (got2 === 0x42dc4c48 ? 'PASS' : 'FAIL'));
