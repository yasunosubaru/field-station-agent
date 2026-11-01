/**
 * RANGECMP (v1/v2/v3/v4/v5) → RANGE field rows.
 *
 * Convert reads a compressed range log and writes it out as an ordinary `RANGEA` line, so the
 * compressed block has to be unpacked into exactly the ten fields the `RANGE` layout declares
 * (`sv_prn / sv_freq / psr / sd_psr / adr / sd_adr / dop / C_No / lock_time / c_status`).
 *
 * All five compression versions reach this file and **none of them prints under its own name** —
 * b5's summary reads `RANGE 1050 → 1112` with `RANGECMP…RANGECMP5` each `N → 0`. They differ in how
 * much work that takes:
 *
 *  - `RANGECMP` (v1, id 140, §3.160 Table 186/187) is 24-byte fixed records that already carry all
 *    ten fields, `c_status` included — `decodeRangeCmp1`;
 *  - `RANGECMP2` (1273, §3.161 Table 188-193) is per-satellite blocks with per-signal deltas —
 *    `decodeRangeCmp2`;
 *  - `RANGECMP3` (1734) has **no table in the OEM7 manual** and its payload is byte for byte the
 *    RANGECMP4 payload (measured: 12/12 records of b5), so it decodes with `decodeRangeCmp4`;
 *  - `RANGECMP4` (2050, §3.162 Table 194-204) adds system/satellite/signal masks and differential
 *    blocks — `decodeRangeCmp4`;
 *  - `RANGECMP5` (2537, §3.163 Table 205-213) is a separate design with 5-bit standard deviations
 *    and Doppler in m/s — `decodeRangeCmp5`.
 *
 * Ground truth: `samples/live-20261031/b2-20261101.sbf` (31 RANGECMP2 + 30 RANGECMP4 records) and
 * `golden-b2-20261101.ASCII`, which Convert produced from it. Every rule below was measured against
 * the 61 `RANGEA` lines Convert wrote for those records (the capture holds 699 = 638 `RANGE` + 31 +
 * 30), which pins down not just the scaling factors but the exact floating-point path and the field
 * storage width (see "Numerics" below). b5 then added v1, v3 and v5 on the same terms.
 *
 * Format: `OEM7-Commands-and-Logs-Reference-Manual.txt`
 *  - §3.161 RANGECMP2 — Table 188 (satellite block), Table 189 (signal block), Table 190/191
 *    (std-dev scaling), Table 192 (L1/E1/B1 scaling), Table 193 (signal type);
 *  - §3.162 RANGECMP4 — Table 194 (header), 195 (satellite/signal block), 196 (measurement block
 *    header), 197/198 (reference primary/secondary), 199/200 (differential primary/secondary),
 *    201 (signal bit mask), 202 (lock time), 203 (ADR std dev), 204 (pseudorange std dev);
 *  - Table 182 (channel tracking status) for the `c_status` word;
 *  - Table 145 (satellite system) for the system codes both logs carry.
 *
 * Both logs pack their bit fields **LSB first**: bit *i* of the block is `byte[i >> 3] >> (i & 7) & 1`.
 * A field of `n` bits that spans byte boundaries is the little-endian value of those bytes
 * (`RANGECMP4`'s "swap the bytes before processing" in Appendix A is that same statement).
 *
 * Numerics — measured, not guessed:
 *  - `adr` (a DOUBLE in the RANGE layout) is `-(phaserange_m / (c / f))`: the *wavelength* is the
 *    divisor, not a precomputed cycles-per-metre product. 2 697/2 697 RANGECMP2 and 2 610/2 610
 *    RANGECMP4 observations match at six decimals; `-(phaserange_m * f / c)` does not (21 and 16
 *    observations differ in the last printed digit).
 *  - `dop`, `sd_psr`, `sd_adr`, `C_No` and `lock_time` are FLOAT (4-byte) fields in the RANGE
 *    layout, and the values the suite stores there are those of `Math.fround`. Reproducing the
 *    float32 rounding is what makes the Doppler byte-exact (48 of 2 697 CMP2 and 64 of 2 610 CMP4
 *    observations land within 2e-5 of a 3-decimal tie and would otherwise print the neighbouring
 *    digit).
 *  - `C_No` for RANGECMP4 is `raw / 20` (0.05 dB-Hz steps) and its 1-decimal ties follow neither
 *    the double nor the float32 rounding alone — see `cmp4CNo`.
 *  - `lock_time` is *saturating* in RANGECMP2 (17 bits, 131 071 ms) and *bucketed* in RANGECMP4
 *    (Table 202: a 4-bit indicator names the bucket's minimum). The suite reconstructs the true
 *    lock time by carrying it forward: while the reported value (or bucket) for a signal stays the
 *    same between consecutive logs, it adds the elapsed time. Every saturated CMP2 observation
 *    (2 604 of 2 697) and every CMP4 observation prints that carry (+1.000 s per 1 s log); without
 *    it every saturated line is wrong. `lockTimeCarry()` holds that per-signal state; a plain
 *    `decodeRangeCmp2(bytes)` call (no carry) reports the field's own value, which is what the
 *    field means in isolation.
 */

/** One `RANGE` observation, named after the fields of the `RANGE` EDIE layout (`messageId` 43). */
export interface RangeObservation {
  /** `sv_prn` — Satellite PRN in RANGE numbering: SBAS 120-158/183-191, GLONASS 38-61 (slot + 37), QZSS 193-202. */
  sv_prn: number;
  /** `sv_freq` — GLONASS frequency + 7 (the compressed field itself), 0 for every other system. */
  sv_freq: number;
  /** `psr` — Pseudorange, metres. */
  psr: number;
  /** `sd_psr` — Pseudorange standard deviation, metres (FLOAT field: float32-rounded). */
  sd_psr: number;
  /** `adr` — Accumulated Doppler range, cycles. Negative, as in RANGE. */
  adr: number;
  /** `sd_adr` — ADR standard deviation, cycles (FLOAT field). */
  sd_adr: number;
  /** `dop` — Doppler, Hz (FLOAT field). L1/E1/B1-equivalent in RANGECMP2; per-signal in RANGECMP4. */
  dop: number;
  /** `C_No` — Carrier-to-noise density, dB-Hz (FLOAT field). */
  C_No: number;
  /** `lock_time` — Time of continuous tracking, **seconds** (FLOAT field; RANGE prints `131.071`). */
  lock_time: number;
  /** `c_status` — Table 182 channel tracking status word. */
  c_status: number;
}

/** Speed of light in m/s (the constant both logs' scale notes imply). */
const C = 299792458;

/** Table 190 / Table 204 (`Pseudorange Std Dev`, identical in both tables), index → metres. */
const PSR_STD = [0.02, 0.03, 0.045, 0.066, 0.099, 0.148, 0.22, 0.329, 0.491, 0.732, 1.092, 1.629, 2.43, 3.625, 5.409];

/**
 * Table 191 (`Std Dev ADR scaling`, RANGECMP2), index → cycles.
 *
 * Index 15 is documented as "> 0.22230"; the sample never carries it, so the value used is the
 * table's own last entry (the printed 3-decimal field saturates either way).
 */
const ADR_STD_CMP2 = [0.00391, 0.00521, 0.00696, 0.00929, 0.01239, 0.01654, 0.02208, 0.02947, 0.03933, 0.05249, 0.07006, 0.0935, 0.1248, 0.16656, 0.2223];

/**
 * `ADR Std Dev` for RANGECMP4, index → cycles.
 *
 * Table 203's values are four-decimal *upper bounds* (`0 ≤ 0.0039`, `1 ≤ 0.0052`, …), and that
 * four-decimal rounding cannot decide the third printed digit for index 5 and 7: the golden file
 * prints `0.016` and `0.029` where the table's own 0.0165 / 0.0295 print `0.017` / `0.030`. The two
 * entries below are the values the oracle pins (0.0165 stored as a float32 rounds down to 0.016,
 * and 0.02947 prints 0.029); indices 1-4 and 6 agree with Table 203 as printed. Note that this is
 * *not* the RANGECMP2 table — the same index 5 prints `0.017` from a RANGECMP2 record in the same
 * capture, so the two logs really do carry two tables.
 *
 * Index 0 is the third measured entry and the only one that is *below* Table 203's bound: b5 prints
 * `0.003` for it (one observation, in both the RANGECMP3 and RANGECMP4 logs of epoch 17142), where
 * the bound 0.0039 would print `0.004`. Indices 1 and 2 in the same records print `0.005` and
 * `0.007`, i.e. the bound itself, so the suite's first entry is a value of its own and not a
 * different rounding rule.
 */
const ADR_STD_CMP4 = [0.003, 0.00521, 0.00696, 0.00929, 0.01239, 0.0165, 0.02208, 0.02947, 0.03933, 0.05249, 0.07006, 0.0935, 0.1248, 0.16656, 0.2223];

/** Table 202 (`Lock time`), indicator → minimum lock time in ms; RANGECMP4 only. */
const LOCK_MIN_MS = [0, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

/**
 * Table 145 (`Satellite system`): the 5-bit code both logs carry in their satellite block.
 *
 * `status` is the same system's value in the Table 182 `c_status` word, which uses a different
 * enumeration (0 GPS, 1 GLONASS, 2 SBAS, 3 Galileo, 4 BeiDou, 5 QZSS, 6 NavIC, 7 Other).
 */
interface SystemInfo {
  name: string;
  status: number;
}

const SYSTEMS: Record<number, SystemInfo> = {
  0: { name: 'GPS', status: 0 },
  1: { name: 'GLONASS', status: 1 },
  2: { name: 'SBAS', status: 2 },
  5: { name: 'Galileo', status: 3 },
  6: { name: 'BeiDou', status: 4 },
  7: { name: 'QZSS', status: 5 },
  9: { name: 'NavIC', status: 6 },
};

/** Table 182 bit 21-25 (`Signal type`) — the value that goes into `c_status`. */
interface SignalInfo {
  /** Table 182 signal-type code. */
  status: number;
  /**
   * Carrier frequency in Hz. A function when the frequency depends on the satellite (GLONASS,
   * whose channels are spaced 0.5625 MHz on G1 and 0.4375 MHz on G2 around 1602 / 1246.4375 MHz).
   */
  freq: number | ((glonass: number) => number);
  /** Doppler divisor: the "L1/E1/B1 scale factor" of Table 192, i.e. f(L1/E1/B1) / f(signal). */
  l1Scale: number | ((glonass: number) => number);
}

/** GLONASS G1/G2 frequency for a "frequency channel + 7" value (0..15 in CMP2, 0..20 in CMP4). */
function glonassG1(channel7: number): number {
  return 1602e6 + (channel7 - 7) * 0.5625e6;
}
function glonassG2(channel7: number): number {
  return 1246.4375e6 + (channel7 - 7) * 0.4375e6;
}

/**
 * Table 193 (RANGECMP2 signal types) joined with Table 182 (the status code) and Table 192 (the
 * L1/E1/B1 scale factor) — plus Table 201 for RANGECMP4, whose signal mask carries the same
 * signal *names* with different bit positions.
 *
 * Only some entries are exercised by the capture: GPS L1CA/L2Y/L2C/L5Q, BeiDou B1D1I/B1D2I/B2D1I/
 * B2AP/B2B_I, QZSS L1CA/L1CB/L2C/L5Q. The rest are transcribed from the tables and never checked
 * against the oracle, because this receiver did not track them.
 */
const SIGNALS: Record<string, Record<number, SignalInfo>> = {
  GPS: {
    1: { status: 0, freq: 1575420000, l1Scale: 1 }, // L1CA
    4: { status: 9, freq: 1227600000, l1Scale: 154 / 120 }, // L2Y  (L2P(Y) semi-codeless)
    5: { status: 17, freq: 1227600000, l1Scale: 154 / 120 }, // L2CM
    7: { status: 14, freq: 1176450000, l1Scale: 154 / 115 }, // L5Q
    15: { status: 16, freq: 1575420000, l1Scale: 1 }, // L1C
    // Not a RANGECMP2 code (Table 193 has no plain L2P): only Table 201's GPS bit 6 asks for it,
    // and Table 182 gives it its own status value (5, distinct from L2P(Y)'s 9).
    104: { status: 5, freq: 1227600000, l1Scale: 154 / 120 }, // L2P
  },
  GLONASS: {
    1: { status: 0, freq: glonassG1, l1Scale: 1 }, // L1CA
    3: { status: 1, freq: glonassG2, l1Scale: (g) => glonassG1(g) / glonassG2(g) }, // L2CA
    4: { status: 5, freq: glonassG2, l1Scale: (g) => glonassG1(g) / glonassG2(g) }, // L2P
    6: { status: 6, freq: 1202025000, l1Scale: (g) => glonassG1(g) / 1202025000 }, // L3Q
  },
  SBAS: {
    1: { status: 0, freq: 1575420000, l1Scale: 1 }, // L1CA
    2: { status: 6, freq: 1176450000, l1Scale: 154 / 115 }, // L5I
  },
  Galileo: {
    1: { status: 2, freq: 1575420000, l1Scale: 1 }, // E1C
    2: { status: 12, freq: 1176450000, l1Scale: 154 / 115 }, // E5AQ
    3: { status: 17, freq: 1207140000, l1Scale: 154 / 118 }, // E5BQ
    4: { status: 20, freq: 1191795000, l1Scale: 154 / 116.5 }, // AltBOCQ
    5: { status: 7, freq: 1278750000, l1Scale: 154 / 125 }, // E6C
    12: { status: 6, freq: 1278750000, l1Scale: 154 / 125 }, // E6B
  },
  BeiDou: {
    1: { status: 0, freq: 1561098000, l1Scale: 1 }, // B1D1I
    2: { status: 4, freq: 1561098000, l1Scale: 1 }, // B1D2I
    3: { status: 1, freq: 1207140000, l1Scale: 1526 / 1180 }, // B2D1I
    4: { status: 5, freq: 1207140000, l1Scale: 1526 / 1180 }, // B2D2I
    13: { status: 2, freq: 1268520000, l1Scale: 1526 / 1240 }, // B3D1I
    16: { status: 6, freq: 1268520000, l1Scale: 1526 / 1240 }, // B3D2I
    19: { status: 7, freq: 1575420000, l1Scale: 1526 / 1540 }, // B1CP
    20: { status: 9, freq: 1176450000, l1Scale: 1526 / 1150 }, // B2AP
    21: { status: 11, freq: 1207140000, l1Scale: 1526 / 1180 }, // B2B_I
  },
  QZSS: {
    1: { status: 0, freq: 1575420000, l1Scale: 1 }, // L1CA
    2: { status: 24, freq: 1575420000, l1Scale: 1 }, // L1CB
    3: { status: 17, freq: 1227600000, l1Scale: 154 / 120 }, // L2CM
    4: { status: 14, freq: 1176450000, l1Scale: 154 / 115 }, // L5Q
    8: { status: 16, freq: 1575420000, l1Scale: 1 }, // L1C
    10: { status: 28, freq: 1278750000, l1Scale: 154 / 125 }, // L6D
    11: { status: 27, freq: 1278750000, l1Scale: 154 / 125 }, // L6P
  },
  NavIC: {
    1: { status: 0, freq: 1176450000, l1Scale: 1 }, // L5SPS
  },
};

/** RANGECMP4 Table 201 (`Signal bit mask`) bit number → Table 193's RANGECMP2 signal-type code. */
const CMP4_SIGNAL_BITS: Record<string, Record<number, number>> = {
  GPS: { 1: 1, 4: 4, 5: 5, 6: 104, 7: 7, 15: 15 }, // L1CA, L2Y, L2C, L2P, L5Q, L1C
  GLONASS: { 1: 1, 3: 3, 4: 4, 6: 6 },
  SBAS: { 1: 1, 2: 2 },
  Galileo: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 12: 12 },
  BeiDou: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 13, 6: 16, 7: 19, 9: 20, 11: 21 },
  QZSS: { 1: 1, 2: 2, 3: 3, 4: 4, 8: 15, 10: 10, 11: 11 },
  NavIC: { 1: 1 },
};

/** LSB-first bit reader over the compressed block. */
class BitReader {
  private readonly bytes: Uint8Array;
  bit = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get bitsLeft(): number {
    return this.bytes.length * 8 - this.bit;
  }

  /** Unsigned field of `count` bits (≤ 53 bits fits a double exactly; wider reads stay a BigInt). */
  read(count: number): number {
    if (count <= 32) {
      let value = 0;
      for (let i = 0; i < count; i++) {
        const at = this.bit + i;
        const byte = this.bytes[at >>> 3] ?? 0;
        if ((byte >>> (at & 7)) & 1) value += 2 ** i;
      }
      this.bit += count;
      return value;
    }
    let value = 0n;
    for (let i = 0; i < count; i++) {
      const at = this.bit + i;
      const byte = this.bytes[at >>> 3] ?? 0;
      if ((byte >>> (at & 7)) & 1) value |= 1n << BigInt(i);
    }
    this.bit += count;
    return Number(value);
  }

  /** Two's-complement field of `count` bits. */
  signed(count: number): number {
    const value = this.read(count);
    const signBit = 2 ** (count - 1);
    return value >= signBit ? value - 2 ** count : value;
  }

  /** Raw bits of a wide field, so the caller can test the "not locked" sentinel exactly. */
  wide(count: number): bigint {
    let value = 0n;
    for (let i = 0; i < count; i++) {
      const at = this.bit + i;
      const byte = this.bytes[at >>> 3] ?? 0;
      if ((byte >>> (at & 7)) & 1) value |= 1n << BigInt(i);
    }
    this.bit += count;
    return value;
  }
}

/**
 * Per-signal lock-time carry.
 *
 * Both compressed logs report the lock time coarsely (a saturating millisecond counter in
 * RANGECMP2, a 4-bit bucket in RANGECMP4), so the only way the suite can print the growing values
 * the golden file holds (`131.071, 132.071, …`) is to keep the last reported value per signal and
 * add the elapsed time while it does not change. Feeding the same object to consecutive
 * `decodeRangeCmp2` / `decodeRangeCmp4` calls reproduces that; omitting it gives the field's own
 * value.
 */
export interface LockTimeCarry {
  readonly entries: Map<string, { reported: number; lockMs: number; epochMs: number }>;
}

export function lockTimeCarry(): LockTimeCarry {
  return { entries: new Map() };
}

function carriedLock(carry: LockTimeCarry | undefined, key: string, reported: number, baseMs: number, epochMs: number | undefined): number {
  if (!carry || epochMs === undefined) return baseMs;
  const previous = carry.entries.get(key);
  let lockMs = baseMs;
  if (previous && previous.reported === reported) lockMs = previous.lockMs + (epochMs - previous.epochMs);
  carry.entries.set(key, { reported, lockMs, epochMs });
  return lockMs;
}

export interface RangeCmpOptions {
  /**
   * Epoch of the log that carries this block, in milliseconds of GPS week. Only used by the
   * lock-time carry; pass it together with `lockTimeCarry()` state to reproduce the suite.
   */
  epochMs?: number;
  /** Carry state shared across consecutive logs (`lockTimeCarry()`). */
  lockCarry?: LockTimeCarry;
}

/**
 * Table 182 channel tracking status.
 *
 * Every bit is filled from RANGECMP2 flags that also exist in the compressed block. Two values are
 * *not* in the block and had to be measured:
 *  - the tracking state (bits 0-4) is 4 (`Phase lock loop tracking`) for the primary signal of a
 *    satellite and 11 (`Aided phase lock loop tracking`) for the others — 992 and 1 674 of the
 *    2 697 CMP2 observations, with no third value;
 *  - the grouping bit (bit 20) is always 1.
 */
function statusWord(systemStatus: number, channel: number, primary: boolean, phaseLock: boolean, parity: boolean, codeLock: boolean, correlator: number, signalType: number, halfCycle: boolean): number {
  let status = primary ? 4 : 11;
  status |= (channel & 0x1f) << 5;
  if (phaseLock) status |= 1 << 10;
  if (parity) status |= 1 << 11;
  if (codeLock) status |= 1 << 12;
  status |= (correlator & 7) << 13;
  status |= (systemStatus & 0xf) << 16;
  status |= 1 << 20; // grouping
  status |= (signalType & 0x1f) << 21;
  if (primary) status |= 1 << 27;
  if (halfCycle) status |= 1 << 28;
  return status >>> 0;
}

/**
 * Unpack one `RANGECMP2` payload (Table 188 satellite blocks, each followed by its Table 189
 * signal blocks) into RANGE observations.
 *
 * Layout, in bits: the first 32 are the byte count (`# bytes`, the payload the log declares);
 * after it a satellite block is 80 bits and every signal block is 96 bits. Reading the satellite
 * block as 12 bytes (the natural guess from a 96-bit signal block) does not work: it walks 15
 * satellites and 98 signals out of a block that holds 32 and 87, and overruns the payload by 64
 * bits. 80 bits consumes the 1 364-byte block exactly.
 */
export function decodeRangeCmp2(bytes: Uint8Array, options: RangeCmpOptions = {}): RangeObservation[] {
  if (bytes.length < 4) return [];
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const body = bytes.subarray(4, Math.min(bytes.length, 4 + declared));
  const reader = new BitReader(body);
  const rows: RangeObservation[] = [];

  while (reader.bitsLeft >= 80) {
    const channel = reader.read(8);
    const prn = reader.read(8);
    const glonass = reader.read(4);
    const system = reader.read(5);
    reader.read(1); // reserved
    const psrBase = reader.read(29);
    const dopBase = reader.signed(21);
    const signalCount = reader.read(4);

    const info = SYSTEMS[system];
    if (!info) {
      // An unknown system code leaves the signal blocks unreadable (their scaling is per system),
      // so the rest of this record is dropped rather than guessed.
      break;
    }

    for (let s = 0; s < signalCount && reader.bitsLeft >= 96; s++) {
      const signalType = reader.read(5);
      const phaseLock = reader.read(1) === 1;
      const parity = reader.read(1) === 1;
      const codeLock = reader.read(1) === 1;
      const lockMs = reader.read(17);
      const correlator = reader.read(4);
      const primary = reader.read(1) === 1;
      const halfCycle = reader.read(1) === 1;
      reader.read(1); // reserved
      const cno = reader.read(5);
      const psrStd = reader.read(4);
      const adrStd = reader.read(4);
      const psrDiff = reader.read(14);
      const adrDiff = reader.read(20);
      const dopDiff = reader.signed(17);

      const signal = SIGNALS[info.name]?.[signalType];
      if (!signal) continue;
      const freq = typeof signal.freq === 'function' ? signal.freq(glonass) : signal.freq;
      const l1Scale = typeof signal.l1Scale === 'function' ? signal.l1Scale(glonass) : signal.l1Scale;
      const wavelength = C / freq;

      const psr = psrBase + psrDiff / 128;
      const phase = psrBase + adrDiff / 2048;
      const lockKey = `cmp2:${channel}:${signalType}`;
      const lock = carriedLock(options.lockCarry, lockKey, lockMs, lockMs, options.epochMs);

      rows.push({
        sv_prn: info.name === 'GLONASS' ? prn + 37 : prn,
        sv_freq: glonass,
        psr,
        sd_psr: Math.fround(PSR_STD[psrStd] ?? PSR_STD[14]),
        adr: -(phase / wavelength),
        sd_adr: Math.fround(ADR_STD_CMP2[adrStd] ?? ADR_STD_CMP2[14]),
        // Table 189: "all Doppler values are scaled to the L1/E1 equivalent value".
        dop: Math.fround((dopBase + dopDiff / 256) / l1Scale),
        C_No: Math.fround(20 + cno),
        lock_time: Math.fround(lock / 1000),
        c_status: statusWord(info.status, channel, primary, phaseLock, parity, codeLock, correlator, signal.status, halfCycle),
      });
    }
  }
  return rows;
}

/** Sentinel of "no pseudorange" in a RANGECMP4 primary block (Table 197, 37 bits, all ones). */
const CMP4_NO_PSR = 0x1fffffffffn;
/** Sentinel of "no phaserange" in a RANGECMP4 primary block (Table 197: −(2²³−1)). */
const CMP4_NO_PHASE = -(2 ** 23 - 1);
/** Sentinel of "no pseudorange" in a RANGECMP4 secondary block (Table 198: −(2²⁰−1)). */
const CMP4_NO_PSR_DIFF = -(2 ** 20 - 1);

/**
 * RANGECMP4 `C/No`, in dB-Hz.
 *
 * The field is 11 bits at 0.05 dB-Hz, so a value like 41.05 lands exactly on a 1-decimal tie and
 * the printed digit depends on the last bits of the stored number. Neither plain form reproduces
 * the oracle: `raw / 20` misprints the 30 field values whose double sits 1.4e-15 *below* a tie
 * (823 → `41.1` where the golden says `41.2`), and the float32 round-trip misprints the 32 whose
 * double sits above one (1037 → `51.8` where the golden says `51.9`). Taking the larger of the two
 * reproduces all 308 distinct values seen in the capture (2 610 observations); the two sets are
 * disjoint, and every non-tie value is identical under both. Mechanically the suite prints
 * `max(double, float32)` — it never prints below the exact quotient.
 */
function cmp4CNo(raw: number): number {
  const value = raw / 20;
  return Math.max(value, Math.fround(value));
}

/**
 * Table 195: the satellite mask's bit index → the PRN RANGE would print for that satellite.
 *
 * Table 12 (`PRN numbers for commands and logs`) is what decides this, and it gives RANGECMP4 a
 * *different* GLONASS numbering from RANGE: the compressed log carries 1-24 (slots), RANGE prints
 * 38-61, i.e. slot + 37. GPS (1-32), Galileo (1-36), BeiDou (1-63) and NavIC (1-14) are the same
 * in both, SBAS numbers its first band from 120 (`Bit 0 = PRN 120`) and puts PRNs 183-191 at bit
 * *prn − 130*, and QZSS is offset by 193 (the capture's mask sets bits 1-6 for the satellites
 * RANGE prints as 194-199). The GLONASS offset is not covered by the capture — it contains no
 * GLONASS observations — but it is what Appendix A's worked example shows (mask slot 1 → RANGE
 * row `38`).
 */
function cmp4Prn(system: string, bit: number): number {
  switch (system) {
    case 'SBAS':
      return bit <= 38 ? bit + 120 : bit + 130;
    case 'QZSS':
      return bit + 193;
    case 'GLONASS':
      return bit + 38;
    default:
      return bit + 1;
  }
}

/** One reference measurement kept for a later differential block (Tables 199/200). */
interface ReferenceMeasurement {
  epochMs: number;
  psr: number;
  phase: number;
  dop: number;
}

/**
 * Unpack one `RANGECMP4` payload into RANGE observations.
 *
 * The log is a header of system bits, then per system: a 64-bit satellite mask, a 16-bit signal
 * mask, the `m × n` "included signals" matrix, and finally the measurement blocks — one header
 * per satellite (`Data Format Flag`, `Ref Data Block ID`, plus the 5-bit GLONASS frequency number
 * for a reference GLONASS block) and one block per signal flagged in its row of the matrix. The
 * first signal of a satellite carries the absolute (primary) block of Table 197/199, the others
 * the differential (secondary) block of Table 198/200.
 *
 * Note the two different bit-numbering conventions the tables use: the GNSS header and the
 * satellite mask are 0-based (bit 0 = GPS / PRN 1), while Table 201's signal mask is 1-based
 * (bit 1 = L1CA and bit 0 is never set) — Appendix A's worked example (0x0092 = L1CA, L2Y, L5Q)
 * only decodes under that reading.
 *
 * Caveat, stated rather than papered over: all 30 RANGECMP4 records in the capture fall on whole
 * seconds and are therefore Reference logs, so the differential blocks (Tables 199/200) are
 * implemented from the tables alone and are not covered by any oracle line.
 */
export function decodeRangeCmp4(bytes: Uint8Array, options: RangeCmpOptions = {}): RangeObservation[] {
  if (bytes.length < 4) return [];
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const body = bytes.subarray(4, Math.min(bytes.length, 4 + declared));
  const reader = new BitReader(body);
  const rows: RangeObservation[] = [];
  const store = referenceStore(options);
  const epochMs = options.epochMs;

  const gnss = reader.read(16);
  for (let systemBit = 0; systemBit < 16; systemBit++) {
    if (!((gnss >>> systemBit) & 1)) continue;
    const info = SYSTEMS[systemBit];
    if (!info) {
      // An unknown system code (Table 145 has gaps at 3, 4 and 8) makes the measurement blocks
      // unreadable: their shape depends on the system. Everything after it would be decoded off a
      // wrong bit offset, so the record stops here.
      break;
    }

    const satellites = reader.wide(64);
    const signalMask = reader.read(16);
    const prns: number[] = [];
    for (let i = 0; i < 64; i++) if ((satellites >> BigInt(i)) & 1n) prns.push(cmp4Prn(info.name, i));
    const signalBits: number[] = [];
    for (let i = 1; i < 16; i++) if ((signalMask >>> i) & 1) signalBits.push(i);
    const included = reader.wide(prns.length * signalBits.length);
    const isGlonass = info.name === 'GLONASS';

    for (let row = 0; row < prns.length; row++) {
      const dataFormat = reader.read(1);
      reader.read(3); // Ref Data Block ID
      let glonass = 0;
      if (isGlonass && dataFormat === 0) glonass = reader.read(5);

      let primaryPsr = 0;
      let primaryDop = 0;
      let primary = true;
      for (let column = 0; column < signalBits.length; column++) {
        if (!((included >> BigInt(row * signalBits.length + column)) & 1n)) continue;
        const signalType = CMP4_SIGNAL_BITS[info.name]?.[signalBits[column]];
        const signal = signalType === undefined ? undefined : SIGNALS[info.name]?.[signalType];
        if (!signal) {
          // Without the signal's frequency neither its ADR nor its Doppler can be scaled, and the
          // measurement block's shape depends on whether it is the satellite's first signal. Stop
          // here rather than emit rows decoded off a wrong bit offset.
          return rows;
        }
        const freq = typeof signal.freq === 'function' ? signal.freq(glonass) : signal.freq;
        const wavelength = C / freq;

        const parity = reader.read(1) === 1;
        const halfCycle = reader.read(1) === 1;
        const cnoRaw = reader.read(11);
        const lockIndex = reader.read(4);
        const psrStd = reader.read(4);
        const adrStd = reader.read(4);

        let psr: number;
        let phase: number;
        let dop: number;
        let codeLock = true;
        let phaseLock = true;

        if (dataFormat === 0) {
          // Tables 197/198: absolute for the satellite's first signal, relative to it afterwards.
          if (primary) {
            const psrRaw = reader.wide(37);
            codeLock = psrRaw !== CMP4_NO_PSR;
            psr = Number(psrRaw) * 0.0005;
            const phaseDiff = reader.signed(23);
            phaseLock = phaseDiff !== CMP4_NO_PHASE;
            phase = psr + phaseDiff * 0.0001;
            dop = reader.signed(26) * 0.0001;
            primaryPsr = psr;
            primaryDop = dop;
          } else {
            const psrDiff = reader.signed(20);
            codeLock = psrDiff !== CMP4_NO_PSR_DIFF;
            psr = primaryPsr + psrDiff * 0.0005;
            const phaseDiff = reader.signed(23);
            phaseLock = phaseDiff !== CMP4_NO_PHASE;
            phase = psr + phaseDiff * 0.0001;
            dop = primaryDop + reader.signed(14) * 0.0001;
          }
        } else {
          // Tables 199/200: offsets from the *predicted* reference measurement, i.e. the reference
          // value carried forward by its own Doppler. Untested — see the note above.
          const psrDiff = reader.signed(19);
          const phaseDiff = reader.signed(16);
          const dopDiff = reader.signed(primary ? 18 : 14);
          const reference = store?.get(`${info.name}:${prns[row]}:${signalType}`);
          const dt = reference && epochMs !== undefined ? (epochMs - reference.epochMs) / 1000 : 0;
          const predictedPsr = reference ? reference.psr + reference.dop * dt : 0;
          const predictedPhase = reference ? reference.phase + reference.dop * dt : 0;
          codeLock = psrDiff !== -(2 ** 19 - 1);
          phaseLock = phaseDiff !== -(2 ** 16 - 1);
          psr = predictedPsr + psrDiff * 0.0005;
          phase = predictedPhase + phaseDiff * 0.0001;
          dop = (reference ? reference.dop : 0) + dopDiff * 0.0001;
          if (primary) {
            primaryPsr = psr;
            primaryDop = dop;
          }
        }

        if (dataFormat === 0 && store) {
          store.set(`${info.name}:${prns[row]}:${signalType}`, { epochMs: epochMs ?? 0, psr, phase, dop });
        }

        const lockKey = `cmp4:${info.name}:${prns[row]}:${signalType}`;
        const lockMs = carriedLock(options.lockCarry, lockKey, lockIndex, LOCK_MIN_MS[lockIndex], epochMs);
        rows.push({
          sv_prn: prns[row],
          sv_freq: isGlonass ? glonass : 0,
          psr,
          sd_psr: Math.fround(PSR_STD[psrStd] ?? PSR_STD[14]),
          // The phase range is in metres for this log too, so the cycle count divides by the
          // wavelength exactly as in RANGECMP2.
          adr: -(phase / wavelength),
          // "If phase is not locked, the ADR std and lock time are set to zero" (§3.162).
          sd_adr: Math.fround(phaseLock ? (ADR_STD_CMP4[adrStd] ?? ADR_STD_CMP4[14]) : 0),
          // Doppler is reported in m/s for the signal's own carrier; RANGE's sign convention is the
          // negative of it, and RANGE's units are Hz.
          dop: Math.fround(-(dop / wavelength)),
          C_No: cmp4CNo(cnoRaw),
          lock_time: Math.fround(phaseLock ? lockMs / 1000 : 0),
          // RANGECMP4 has no SV channel (bit 5-9 reports 0) and no correlator type (bits 13-15 = 0).
          c_status: statusWord(info.status, 0, primary, phaseLock, parity, codeLock, 0, signal.status, halfCycle),
        });
        primary = false;
      }
    }
  }
  return rows;
}

/** Table 187 (`StdDev-PSR values`, RANGECMP only), code → metres. */
const PSR_STD_CMP1 = [0.05, 0.075, 0.113, 0.169, 0.253, 0.38, 0.57, 0.854, 1.281, 2.375, 4.75, 9.5, 19, 38, 76, 152];

/**
 * Table 182 `Signal type` code → the signal, per system.
 *
 * RANGECMP2/4 carry a *compressed* signal code that has to be translated (Table 193 / Table 201);
 * RANGECMP carries the Table 182 code itself in its channel status word, so this is the same table
 * read the other way round. Every code is unique inside its system, which is what makes the lookup
 * unambiguous.
 */
const SIGNAL_BY_STATUS: Record<string, Record<number, SignalInfo>> = (() => {
  const byStatus: Record<string, Record<number, SignalInfo>> = {};
  for (const [system, signals] of Object.entries(SIGNALS)) {
    const map: Record<number, SignalInfo> = {};
    for (const info of Object.values(signals)) map[info.status] = info;
    byStatus[system] = map;
  }
  return byStatus;
})();

/** Table 182 bit 16-19 (`Satellite system`) → the `SYSTEMS` entry whose name indexes `SIGNALS`. */
const SYSTEM_BY_STATUS: Record<number, SystemInfo> = (() => {
  const byStatus: Record<number, SystemInfo> = {};
  for (const info of Object.values(SYSTEMS)) byStatus[info.status] = info;
  return byStatus;
})();

/** Table 186 `ADR` roll modulus: `MAX_VALUE = 8388608`, and the rolled field is 32 bits wide. */
const CMP1_ADR_MAX = 8388608;

/**
 * Unpack one `RANGECMP` (version 1, message id 140) payload into RANGE observations.
 *
 * The log is the oldest of the five: a `ULONG` observation count followed by that many fixed
 * **24-byte** records (Table 186), each carrying all ten RANGE fields already — no per-system
 * blocks, no signal masks, no differential blocks. So unlike RANGECMP2/4 nothing has to be
 * reconstructed except two derived quantities:
 *
 *  - **`sd_psr`** comes from Table 187 (12 m steps at the top, 0.05 m at the bottom), not from
 *    Table 190/204, which is why the same observation prints `0.050` here and `0.045` for
 *    RANGECMP2 in the same capture;
 *  - **`adr`** is the 32-bit accumulation in cycles with its roll count restored. Table 186 gives
 *    the recipe (`ADR_ROLLS = (PSR / WAVELENGTH + ADR) / MAX_VALUE`, rounded away from zero, then
 *    `CORRECTED_ADR = ADR - MAX_VALUE × ADR_ROLLS`); the wavelength is the *signal's own* one, and
 *    getting that wrong is what makes an L2 observation look like a 20 000 000-cycle discontinuity
 *    (b5: 13 records, 897 observations, every one reproduces its golden value).
 *
 * `c_status` is the record's own 32-bit channel status word, verbatim — the log already stores the
 * Table 182 word, so this decoder invents none of the bits that RANGECMP2/4 have to synthesise.
 */
export function decodeRangeCmp1(bytes: Uint8Array, options: RangeCmpOptions = {}): RangeObservation[] {
  if (bytes.length < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Unlike every other RANGECMP version this header is the **observation count**, not a byte count
  // (Table 186 field 2: `Ulong`, "number of satellite observations with information to follow").
  const declared = view.getUint32(0, true);
  const body = bytes.subarray(4, Math.min(bytes.length, 4 + declared * 24));
  const reader = new BitReader(body);
  const rows: RangeObservation[] = [];
  const epochMs = options.epochMs;

  while (reader.bitsLeft >= 192) {
    const status = reader.read(32);
    const dopRaw = reader.signed(28);
    const psrRaw = reader.read(36);
    const adrRaw = reader.signed(32);
    const psrStd = reader.read(4);
    const adrStd = reader.read(4);
    const prn = reader.read(8);
    const lockRaw = reader.read(21);
    const cnoRaw = reader.read(5);
    const glonass = reader.read(6);
    reader.read(16); // reserved

    const system = SYSTEM_BY_STATUS[(status >>> 16) & 0xf];
    const signal = system ? SIGNAL_BY_STATUS[system.name]?.[(status >>> 21) & 0x1f] : undefined;
    if (!signal) {
      // Without the signal's carrier neither the ADR roll count nor anything else can be scaled;
      // the record is 24 bytes wide, so the next one still starts where it says it does.
      continue;
    }
    const freq = typeof signal.freq === 'function' ? signal.freq(glonass) : signal.freq;
    const wavelength = C / freq;

    const psr = psrRaw / 128;
    const adr = adrRaw / 256 - CMP1_ADR_MAX * Math.round((psr / wavelength + adrRaw / 256) / CMP1_ADR_MAX);

    rows.push({
      sv_prn: prn,
      sv_freq: glonass,
      psr,
      sd_psr: Math.fround(PSR_STD_CMP1[psrStd] ?? PSR_STD_CMP1[15]),
      adr,
      // Table 186: `StdDev-ADR` = (n+1)/512 cycles.
      sd_adr: Math.fround((adrStd + 1) / 512),
      dop: Math.fround(dopRaw / 256),
      C_No: Math.fround(20 + cnoRaw),
      // 21 bits of 1/32 s (Table 186 caps the field at 2 097 151 = 65 535.96875 s). A saturated
      // value is carried forward exactly like RANGECMP2's, so the printed lock times keep growing.
      lock_time: Math.fround(carriedLock(options.lockCarry, `cmp1:${status & 0x1f}:${(status >>> 21) & 0x1f}`, lockRaw, lockRaw * 31.25, epochMs) / 1000),
      c_status: status,
    });
  }
  return rows;
}

/**
 * Table 212 (`Phaserange standard deviation`, RANGECMP5), 5-bit index → cycles.
 *
 * The table prints four-decimal upper bounds of `(1/256)·exp(x/(3.65·√3))`, which is what makes
 * b5 print `0.014` for index 8 (0.01385) where the same observation arrives from RANGECMP4 as
 * `0.016` — the two logs carry two different standard-deviation scales, not two indices of one.
 */
const ADR_STD_CMP5 = Array.from({ length: 32 }, (_, x) => (1 / 256) * Math.exp(x / (3.65 * Math.sqrt(3))));

/**
 * Table 213 (`Pseudorange standard deviation`, RANGECMP5), 5-bit index → metres.
 *
 * `0.020·exp(0.4x)` up to 14, `5.409·exp(0.24(x−14))` above it; the first fifteen entries are the
 * same numbers as Table 190/204 (`PSR_STD`), which is why an observation's `sd_psr` does not change
 * between compression versions while its `sd_adr` does.
 */
const PSR_STD_CMP5 = Array.from({ length: 32 }, (_, x) => (x <= 14 ? 0.02 * Math.exp(0.4 * x) : 5.409 * Math.exp(0.24 * (x - 14))));

/** Sentinel of "not locked" in a RANGECMP5 block (Tables 208/209: `-2^n − 1`). */
const CMP5_NO_PSR = 0x1fffffffffn;
const CMP5_NO_PHASE = -(2 ** 23 - 1);
const CMP5_NO_PSR_DIFF = -(2 ** 20 - 1);
const CMP5_NO_PHASE_DIFF = -(2 ** 23 - 1);
const CMP5_NO_DOP = -(2 ** 27 - 1);
const CMP5_NO_DOP_DIFF = -(2 ** 15 - 1);

/**
 * Unpack one `RANGECMP5` payload into RANGE observations (§3.163, message id 2537).
 *
 * Structure (Tables 205-210): a 16-bit `GNSS` header naming the systems present, then one block per
 * system in bit order — a 64-bit satellite mask, a 16-bit signal mask, and the `m × n` "included
 * signals" matrix — and only then the measurements: one 4-bit header per satellite (9 bits for
 * GLONASS, whose slot number rides there), followed by one block per signal set in that satellite's
 * row. The **first** signal of a satellite carries the primary block of Table 208 (absolute
 * pseudorange, phase as a 23-bit difference from it, Doppler); the rest carry Table 209, which is
 * differential against the same satellite's primary value.
 *
 * Units differ from the other compressed logs, and the printed RANGE fields are what proves it:
 * Doppler is in **m/s** (0.0001) rather than Hz, the phaserange difference is in **metres** (0.0001)
 * and the C/No step is 0.05 dB-Hz like RANGECMP4's. RANGE wants Hz and cycles, so this routine
 * divides by the signal's own wavelength exactly as the RANGECMP2/4 paths do; all 12 records of b5
 * (828 observations) reproduce the golden `RANGE` rows byte for byte, including the 46 whose
 * Doppler lands on a printing tie.
 */
export function decodeRangeCmp5(bytes: Uint8Array, options: RangeCmpOptions = {}): RangeObservation[] {
  if (bytes.length < 4) return [];
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const body = bytes.subarray(4, Math.min(bytes.length, 4 + declared));
  const reader = new BitReader(body);
  const rows: RangeObservation[] = [];
  const epochMs = options.epochMs;

  const gnss = reader.read(16);
  for (let systemBit = 0; systemBit < 16; systemBit++) {
    if (!((gnss >>> systemBit) & 1)) continue;
    const info = SYSTEMS[systemBit];
    if (!info) break;

    const satellites = reader.wide(64);
    const signalMask = reader.read(16);
    const prns: number[] = [];
    for (let i = 0; i < 64; i++) if ((satellites >> BigInt(i)) & 1n) prns.push(cmp4Prn(info.name, i));
    const signalBits: number[] = [];
    for (let i = 1; i < 16; i++) if ((signalMask >>> i) & 1) signalBits.push(i);
    const included = reader.wide(prns.length * signalBits.length);
    const isGlonass = info.name === 'GLONASS';

    for (let row = 0; row < prns.length; row++) {
      reader.read(1); // Data format flag (1 = reserved)
      reader.read(3); // Reserved
      const glonass = isGlonass ? reader.read(5) : 0;

      let primaryPsr = 0;
      let primaryDop = 0;
      let primary = true;
      for (let column = 0; column < signalBits.length; column++) {
        if (!((included >> BigInt(row * signalBits.length + column)) & 1n)) continue;
        const signalType = CMP4_SIGNAL_BITS[info.name]?.[signalBits[column]];
        const signal = signalType === undefined ? undefined : SIGNALS[info.name]?.[signalType];
        if (!signal) return rows;
        const freq = typeof signal.freq === 'function' ? signal.freq(glonass) : signal.freq;
        const wavelength = C / freq;

        const parity = reader.read(1) === 1;
        const halfCycle = reader.read(1) === 1;
        const quality = reader.read(11);
        const lockIndex = reader.read(4);
        const psrStd = reader.read(5);
        const adrStd = reader.read(5);

        let psr: number;
        let phase: number;
        let dop: number;
        let codeLock = true;
        let phaseLock = true;
        if (primary) {
          const psrRaw = reader.wide(37);
          codeLock = psrRaw !== CMP5_NO_PSR;
          psr = Number(psrRaw) * 0.0005;
          const phaseDiff = reader.signed(23);
          phaseLock = phaseDiff !== CMP5_NO_PHASE;
          phase = psr + phaseDiff * 0.0001;
          const dopRaw = reader.signed(28);
          dop = dopRaw === CMP5_NO_DOP ? 0 : dopRaw * 0.0001;
          primaryPsr = psr;
          primaryDop = dop;
        } else {
          const psrDiff = reader.signed(20);
          codeLock = psrDiff !== CMP5_NO_PSR_DIFF;
          psr = primaryPsr + psrDiff * 0.0005;
          const phaseDiff = reader.signed(23);
          phaseLock = phaseDiff !== CMP5_NO_PHASE_DIFF;
          phase = psr + phaseDiff * 0.0001;
          const dopDiff = reader.signed(16);
          // Table 209 says 0.0002 m/s per count (±6.554 over 16 bits); the wire and the suite use
          // 0.0001 — measured on 460 secondary rows in b5, where 0.0002 puts 424 of them off by
          // 1–20 counts' worth (0.002–0.13 Hz) and 0.0001 reproduces every one of them.
          dop = primaryDop + dopDiff * 0.0001;
        }

        const lockKey = `cmp5:${info.name}:${prns[row]}:${signalType}`;
        const lockMs = carriedLock(options.lockCarry, lockKey, lockIndex, LOCK_MIN_MS[lockIndex], epochMs);
        rows.push({
          sv_prn: prns[row],
          sv_freq: isGlonass ? glonass : 0,
          psr,
          sd_psr: Math.fround(PSR_STD_CMP5[psrStd] ?? PSR_STD_CMP5[30]),
          // Table 212 index 31 is documented as "> 0.44940" (i.e. open-ended); the formula below is
          // what the other 31 indices are, and it is the only value the sample never reaches.
          adr: -(phase / wavelength),
          sd_adr: Math.fround(phaseLock ? (ADR_STD_CMP5[adrStd] ?? ADR_STD_CMP5[31]) : 0),
          dop: Math.fround(-(dop / wavelength)),
          C_No: cmp4CNo(quality),
          lock_time: Math.fround(phaseLock ? lockMs / 1000 : 0),
          c_status: statusWord(info.status, 0, primary, phaseLock, parity, codeLock, 0, signal.status, halfCycle),
        });
        primary = false;
      }
    }
  }
  return rows;
}

/**
 * Reference measurements for differential blocks, kept beside the lock carry so a differential
 * record can find the reference it points at.
 */
const referenceStores = new WeakMap<LockTimeCarry, Map<string, ReferenceMeasurement>>();

function referenceStore(options: RangeCmpOptions): Map<string, ReferenceMeasurement> | undefined {
  if (!options.lockCarry) return undefined;
  let store = referenceStores.get(options.lockCarry);
  if (!store) {
    store = new Map();
    referenceStores.set(options.lockCarry, store);
  }
  return store;
}

/**
 * Repack decoded observations into the `RANGE` payload the ASCII writer already knows
 * (stride 44: u16 prn, u16 freq, f64 psr, f32 sd_psr, f64 adr, f32 sd_adr, f32 dop, f32 C/No,
 * f32 lock_time, u32 c_status). Convert prints a compressed record as an ordinary `RANGEA` line,
 * so the cleanest wiring is to hand the existing RANGE layout a rebuilt payload instead of
 * duplicating its header/format/CRC code.
 */
import { exactFixed } from './ascii-log.ts';

export function buildRangePayload(observations: readonly RangeObservation[]): Uint8Array {
  const out = new Uint8Array(4 + observations.length * 44);
  const view = new DataView(out.buffer);
  view.setUint32(0, observations.length, true);
  observations.forEach((obs, index) => {
    const at = 4 + index * 44;
    view.setUint16(at, obs.sv_prn & 0xffff, true);
    view.setUint16(at + 2, obs.sv_freq & 0xffff, true);
    view.setFloat64(at + 4, obs.psr, true);
    view.setFloat32(at + 12, roundForPrint(obs.sd_psr, 3), true);
    view.setFloat64(at + 16, obs.adr, true);
    view.setFloat32(at + 24, roundForPrint(obs.sd_adr, 3), true);
    view.setFloat32(at + 28, roundForPrint(obs.dop, 3), true);
    view.setFloat32(at + 32, roundForPrint(obs.C_No, 1), true);
    view.setFloat32(at + 36, roundForPrint(obs.lock_time, 3), true);
    view.setUint32(at + 40, obs.c_status >>> 0, true);
  });
  return out;
}

/** Next float32 above `value` (so the tie can be nudged to the neighbour the suite stores). */
function nextFloat32(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const bits = view.getUint32(0);
  view.setUint32(0, bits + 1);
  return view.getFloat32(0);
}

/**
 * The RANGE fields are FLOAT (4-byte), and the suite prints them with 1–3 decimals. When a decoded
 * value sits exactly on a printing tie, the *double* the decompressor produced prints one way and
 * its float32 neighbour the other — and the suite prints the neighbour that keeps the double's
 * digit (`RANGECMP4` C/No `raw/20` hits this 30 times in `b2`: 1037 → 51.85 must print `51.9`).
 * This picks the float32 whose rendering equals the double's rendering.
 */
function roundForPrint(value: number, digits: number): number {
  const exact = exactFixed(value, digits);
  const rounded = Math.fround(value);
  if (exactFixed(rounded, digits) === exact) return rounded;
  const up = nextFloat32(rounded);
  if (exactFixed(up, digits) === exact) return up;
  return rounded;
}
