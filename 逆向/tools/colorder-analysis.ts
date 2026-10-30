/**
 * `_Mean` / `Signals_*` 两组列序的取证与假设检验。
 *
 * 只读两样东西：
 *   - golden：`00_来源/samples/graph/export/csv/{GNSS Signal Strength,Satellites and Signals}.csv`
 *   - 输入抓包：`00_来源/samples/convert/clean-9600.gps`（RANGE 100 条）
 *
 * 输出：
 *   1. 两组列的实际顺序 + 拆成 (system, signal) / (system, prn) 元组；
 *   2. 候选规则的"匹配数/总数"（序列整体相等 / 相邻对 / 全排列逆序对）；
 *   3. 反解失败时，把"靶序"打印出来供后续脚本复用。
 *
 * 运行：node 逆向/tools/colorder-analysis.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCapture, field } from '../04_重实现/packages/graph/src/capture.ts';
import { RANGE_SIGNALS } from '../04_重实现/packages/graph/src/range-charts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REVERSE = join(here, '..');
const CSV_DIR = join(REVERSE, '00_来源', 'samples', 'graph', 'export', 'csv');
const CAPTURE = join(REVERSE, '00_来源', 'samples', 'convert', 'clean-9600.gps');

// ---------------------------------------------------------------- golden 列名

function headerOf(file: string): string[] {
  const text = readFileSync(join(CSV_DIR, file), 'utf8');
  const lines = text.split('\r\n');
  // 6 行 `#` 注释，第 7 行（下标 6）是表头
  return lines[6].split(',');
}

/** `GPS_L1_CA_27` → `{ name: 'GPS_L1_CA', prn: 27 }`（列名末尾的数字是 PRN）。 */
function splitSatellite(header: string): { name: string; prn: number } | null {
  const match = /^([A-Z0-9_]+?)_(\d+)$/.exec(header);
  return match ? { name: match[1], prn: Number(match[2]) } : null;
}

const meanHeaders = headerOf('GNSS Signal Strength.csv')
  .filter((h) => h.endsWith('_Mean'))
  .map((h) => h.slice(0, -'_Mean'.length));

const signalsHeaders = headerOf('Satellites and Signals.csv')
  .filter((h) => h.startsWith('Signals_') && h !== 'Signals_Total')
  .map((h) => h.slice('Signals_'.length));

const satelliteHeaders = headerOf('GNSS Signal Strength.csv')
  .slice(1)
  .filter((h) => !h.endsWith('_Mean'));

// ---------------------------------------------------------------- system / signal

const SYSTEM_OF_NAME: Record<string, number> = {};
for (const [system, table] of Object.entries(RANGE_SIGNALS)) {
  for (const info of Object.values(table)) SYSTEM_OF_NAME[info.name] = Number(system);
}

function systemOf(name: string): number {
  const system = SYSTEM_OF_NAME[name];
  if (system === undefined) throw new Error(`列名 ${name} 不在 RANGE_SIGNALS 表里`);
  return system;
}

const SYSTEM_NAME: Record<number, string> = { 0: 'GPS', 4: 'BEIDOU', 5: 'QZSS' };

/**
 * `ALL_SIGNAL` 的真实编号，取自 linux `graph-node-wrapper.node` 里连续的信号名字符串表
 * （`@0x8c49...`，`GPS_L1_CA` 起、`UNKNOWN_SIGNAL` 止），按出现次序 0 基编号。
 * 逐卫星列用的 `RANGE_SIGNALS.rank` 是**另一套**编号（来自 Windows 模块的 72 名字表），
 * 两套在这里都当候选键试。
 */
const ALL_SIGNAL_LINUX: Record<string, number> = {};
{
  const names = [
    'GPS_L1_CA', 'GPS_L1_CD', 'GPS_L1_CP', 'GPS_L1_CX', 'GPS_L1_P', 'GPS_L1_PY',
    'GPS_L2_CA', 'GPS_L2_P', 'GPS_L2_PY', 'GPS_L2_CM', 'GPS_L2_CL', 'GPS_L2_CX',
    'GPS_L5_I', 'GPS_L5_Q', 'GPS_L5_X',
    'GLONASS_L1_CA', 'GLONASS_L1_P', 'GLONASS_L2_CA', 'GLONASS_L2_P', 'GLONASS_L3_Q', // 15..19 (6 个，含 20 空位)
    'GALILEO_E1_B', 'GALILEO_E1_C', 'GALILEO_E1_X', 'GALILEO_E5A_I', 'GALILEO_E5A_Q', 'GALILEO_E5A_X',
    'GALILEO_E5B_I', 'GALILEO_E5B_Q', 'GALILEO_E5B_X', 'GALILEO_E5ALTBOC_I', 'GALILEO_E5ALTBOC_Q',
    'GALILEO_E5ALTBOC_X', 'GALILEO_E6_C', 'GALILEO_E6_B', 'GALILEO_E6_X',
    'BEIDOU_B1I_D1', 'BEIDOU_B1I_D2', 'BEIDOU_B1C_P', 'BEIDOU_B1C_D', 'BEIDOU_B1C_X',
    'BEIDOU_B2A_P', 'BEIDOU_B2A_D', 'BEIDOU_B2A_X', 'BEIDOU_B2I_D1', 'BEIDOU_B2I_D2',
    'BEIDOU_B2B_I', 'BEIDOU_B3I_D1', 'BEIDOU_B3I_D2',
    'QZSS_L1_CA', 'QZSS_L1_CD', 'QZSS_L1_CP', 'QZSS_L1_CX', 'QZSS_L2_CM', 'QZSS_L2_CL',
    'QZSS_L2_CX', 'QZSS_L5_I', 'QZSS_L5_Q', 'QZSS_L5_X', 'QZSS_L6_P', 'QZSS_L6_D', 'QZSS_L6_X',
    'SBAS_L1_CA', 'SBAS_L5_I', 'SBAS_L5_Q', 'SBAS_L5_X',
  ];
  names.forEach((name, index) => { ALL_SIGNAL_LINUX[name] = index; });
}

// ---------------------------------------------------------------- RANGE 观测

interface Obs {
  system: number;
  signal: number;
  prn: number;
  /** 0 基的"观测块序号"：把 100 条 RANGE 的 obs[] 依次摊平后计数。 */
  block: number;
  /** 该观测自身的 `c_status`。 */
  cStatus: number;
  record: number;
}

const capture = loadCapture(CAPTURE);
const ranges = capture.byName('RANGE');

function obsOf(record: (typeof ranges)[number], recordIndex: number, blockStart: number): Obs[] {
  const count = field(record, 'obs.count');
  const out: Obs[] = [];
  for (let i = 0; i < count; i++) {
    const cStatus = field(record, `obs[${i}].c_status`);
    out.push({
      system: (cStatus >> 16) & 7,
      signal: (cStatus >> 21) & 0x1f,
      prn: field(record, `obs[${i}].sv_prn`),
      block: blockStart + i,
      cStatus,
      record: recordIndex,
    });
  }
  return out;
}

const allObs: Obs[] = [];
let block = 0;
ranges.forEach((record, index) => {
  const list = obsOf(record, index, block);
  block += list.length;
  allObs.push(...list);
});

/** 每组 (system, signal) 的第一次出现（block 序号）、出现次数、C/No 均值、c_status 集合。 */
interface GroupStat {
  system: number;
  signal: number;
  name: string;
  firstBlock: number;
  firstRecord: number;
  count: number;
  cnoMean: number;
  cStatusLow: Set<number>;
  cStatusAll: Set<number>;
  minPrn: number;
  maxPrn: number;
}

const stats = new Map<string, GroupStat>();
for (const obs of allObs) {
  const info = RANGE_SIGNALS[obs.system]?.[obs.signal];
  if (!info) throw new Error(`未知 system/signal ${obs.system}/${obs.signal}`);
  const key = `${obs.system}:${obs.signal}`;
  let stat = stats.get(key);
  if (!stat) {
    stat = {
      system: obs.system,
      signal: obs.signal,
      name: info.name,
      firstBlock: obs.block,
      firstRecord: obs.record,
      count: 0,
      cnoMean: 0,
      cStatusLow: new Set(),
      cStatusAll: new Set(),
      minPrn: obs.prn,
      maxPrn: obs.prn,
    };
    stats.set(key, stat);
  }
  stat.count += 1;
  stat.cnoMean += field(ranges[obs.record], `obs[${obs.block - blockStartOf(obs.record)}].C_No`);
  stat.cStatusLow.add(obs.cStatus & 0x3f);
  stat.cStatusAll.add(obs.cStatus);
  stat.minPrn = Math.min(stat.minPrn, obs.prn);
  stat.maxPrn = Math.max(stat.maxPrn, obs.prn);
}
function blockStartOf(recordIndex: number): number {
  let start = 0;
  for (let i = 0; i < recordIndex; i++) start += field(ranges[i], 'obs.count');
  return start;
}
for (const stat of stats.values()) stat.cnoMean /= stat.count;

/** 每颗卫星（system, prn）的信号枚举位次，用于逐卫星列规则。 */
const rankOf = (system: number, signal: number): number => RANGE_SIGNALS[system][signal].rank;

// ---------------------------------------------------------------- 比较工具

const eq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const adjacentHits = (a: string[], b: string[]) => {
  let hits = 0;
  for (let i = 0; i + 1 < b.length; i++) if (a[i] === b[i] && a[i + 1] === b[i + 1]) hits++;
  return hits;
};
const exactPositions = (a: string[], b: string[]) => a.reduce((n, v, i) => n + (v === b[i] ? 1 : 0), 0);

function report(label: string, candidate: string[], target: string[]): void {
  const ok = eq(candidate, target);
  console.log(
    `  ${ok ? 'OK' : '--'} ${label.padEnd(34)} pos ${exactPositions(candidate, target)}/${target.length}` +
      `  adj ${adjacentHits(candidate, target)}/${Math.max(0, target.length - 1)}` +
      `  ${ok ? '(exact)' : ''}`,
  );
  if (!ok) console.log(`      ${candidate.join(' ')}`);
}

/** 把列名列表按 constellation 切段（golden 里就是按 system 分组的）。 */
function bySystem(names: string[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const name of names) {
    const system = systemOf(name);
    if (!out.has(system)) out.set(system, []);
    out.get(system)!.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- 主输出

console.log('='.repeat(96));
console.log('1. golden column order (as shipped)');
console.log('='.repeat(96));

for (const [file, names, suffix] of [
  ['GNSS Signal Strength.csv', meanHeaders, '_Mean'],
  ['Satellites and Signals.csv', signalsHeaders, 'Signals_'],
] as const) {
  console.log(`\n${file}  (${names.length} cols, ${suffix}*)`);
  let index = 0;
  for (const [system, list] of bySystem(names)) {
    console.log(`  ${SYSTEM_NAME[system]} (system=${system}):`);
    for (const name of list) {
      const stat = [...stats.values()].find((s) => s.name === name)!;
      console.log(
        `    [${String(index++).padStart(2)}] ${name.padEnd(16)}` +
          ` (system=${stat.system}, signal=${String(stat.signal).padStart(2)})` +
          `  firstBlock=${String(stat.firstBlock).padStart(3)}` +
          `  n=${stat.count}` +
          `  cnoMean=${stat.cnoMean.toFixed(3)}` +
          `  PRN ${stat.minPrn}..${stat.maxPrn}`,
      );
    }
  }
}

console.log('\nper-satellite columns (control group, solved): ' + satelliteHeaders.length + ' cols');
console.log('  first 12: ' + satelliteHeaders.slice(0, 12).map((h) => {
  const s = splitSatellite(h)!;
  return `${s.name}_${s.prn}`;
}).join(' '));

// ---------------------------------------------------------------- 假设检验

console.log('\n' + '='.repeat(96));
console.log('2. candidate rules vs the golden order');
console.log('='.repeat(96));

for (const [label, target] of [
  ['GNSS Signal Strength（_Mean）', meanHeaders],
  ['Satellites and Signals（Signals_*）', signalsHeaders],
] as const) {
  console.log(`\n### ${label}`);
  const grouped = bySystem(target);
  for (const [system, list] of grouped) {
    const present = [...stats.values()].filter((s) => s.system === system);
    const tag = `${SYSTEM_NAME[system]}: ${list.join(' ')}`;
    console.log(`  ${tag}`);
    const pick = (order: GroupStat[]) => order.filter((s) => s.system === system).map((s) => s.name);
    report('enum-rank asc', pick([...present].sort((a, b) => rankOf(a.system, a.signal) - rankOf(b.system, b.signal))), list);
    report('first-appearance asc', pick([...present].sort((a, b) => a.firstBlock - b.firstBlock)), list);
    report('c_status&0x3f asc', pick([...present].sort((a, b) => [...a.cStatusLow][0] - [...b.cStatusLow][0])), list);
    report('signal value asc', pick([...present].sort((a, b) => a.signal - b.signal)), list);
    report('count desc', pick([...present].sort((a, b) => b.count - a.count || a.signal - b.signal)), list);
    report('cno mean desc', pick([...present].sort((a, b) => b.cnoMean - a.cnoMean)), list);
    report('min PRN asc', pick([...present].sort((a, b) => a.minPrn - b.minPrn)), list);
  }
}

// ---------------------------------------------------------------- 哈希族

const u32 = (x: number) => x >>> 0;
const mul32 = (a: number, b: number) => Math.imul(a, b) >>> 0;

function fnv1a32(bytes: number[], seed = 0): number {
  let h = (seed || 0x811c9dc5) >>> 0;
  for (const b of bytes) {
    h = (h ^ b) >>> 0;
    h = mul32(h, 0x01000193);
  }
  return h >>> 0;
}
function fnv1a64To32(bytes: number[], seed = 0): number {
  // MSVC std::hash<string> 是 FNV-1a 64，最后截到 32 位（bucket 取模用 size_t，这里两者都试）
  let h = BigInt(seed || 0) || 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const b of bytes) {
    h = (h ^ BigInt(b)) & 0xffffffffffffffffn;
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return Number(h & 0xffffffffn) >>> 0;
}
function djb2(bytes: number[], h = 5381): number {
  for (const b of bytes) h = (mul32(h, 33) + b) >>> 0;
  return h >>> 0;
}
function sdbm(bytes: number[]): number {
  let h = 0;
  for (const b of bytes) h = (b + (h << 6) + (h << 16) - h) >>> 0;
  return h >>> 0;
}
function java31(bytes: number[]): number {
  let h = 0;
  for (const b of bytes) h = (mul32(h, 31) + b) >>> 0;
  return h >>> 0;
}
function murmur3_32(bytes: number[], seed: number): number {
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const blocks = bytes.length >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
    k = mul32(k, c1);
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = mul32(k, c2);
    h = (h ^ k) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (mul32(h, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0;
  const tail = blocks * 4;
  switch (bytes.length & 3) {
    case 3: k = (bytes[tail + 2] << 16) >>> 0; // fallthrough
    case 2: k = (k | (bytes[tail + 1] << 8)) >>> 0; // fallthrough
    case 1: k = (k | bytes[tail]) >>> 0;
      k = mul32(k, c1);
      k = ((k << 15) | (k >>> 17)) >>> 0;
      k = mul32(k, c2);
      h = (h ^ k) >>> 0;
  }
  h = (h ^ bytes.length) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = mul32(h, 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = mul32(h, 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}
function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = (c ^ b) >>> 0;
    for (let i = 0; i < 8; i++) c = ((c >>> 1) ^ (0xedb88320 & -(c & 1))) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function boostRange(bytes: number[]): number {
  let h = 0;
  for (const b of bytes) h = (h ^ ((b + 0x9e3779b9 + (h << 6) + (h >>> 2)) >>> 0)) >>> 0;
  return h >>> 0;
}
function splitmix32(x: number): number {
  let h = (x + 0x9e3779b9) >>> 0;
  h = mul32(h ^ (h >>> 16), 0x21f0aaad);
  h = mul32(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

const utf8 = (s: string) => [...Buffer.from(s, 'utf8')];

type KeyForm = { name: string; of: (stat: GroupStat) => number | string };

const KEY_FORMS: KeyForm[] = [
  { name: 'signal(5bit)', of: (s) => s.signal },
  { name: 'system*32+signal', of: (s) => s.system * 32 + s.signal },
  { name: '(system<<16)|signal', of: (s) => (s.system << 16) | s.signal },
  { name: '(signal<<21)|(system<<16) [c_status hi]', of: (s) => ((s.signal << 21) | (s.system << 16)) >>> 0 },
  { name: 'c_status first-obs (u32)', of: (s) => [...s.cStatusAll][0] >>> 0 },
  { name: 'column name "GPS_L1_CA"', of: (s) => s.name },
  { name: 'short name "L1_CA"', of: (s) => s.name.replace(/^[A-Z]+_/, '') },
  { name: 'enum rank (72-name table)', of: (s) => rankOf(s.system, s.signal) },
  { name: 'system*64+rank', of: (s) => s.system * 64 + rankOf(s.system, s.signal) },
  { name: 'ALL_SIGNAL (.so string-table order)', of: (s) => ALL_SIGNAL_LINUX[s.name] ?? -1 },
  { name: 'column name + "_Mean"', of: (s) => `${s.name}_Mean` },
  { name: 'short name + "_Mean"', of: (s) => `${s.name.replace(/^[A-Z]+_/, '')}_Mean` },
];

const HASHES: { name: string; of: (key: number | string) => number }[] = [
  { name: 'identity', of: (k) => Number(k) >>> 0 },
  { name: 'splitmix32', of: (k) => splitmix32(Number(k)) },
  { name: 'fnv1a32', of: (k) => fnv1a32(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff, (k >>> 16) & 0xff, (k >>> 24) & 0xff] : utf8(k)) },
  { name: 'fnv1a64', of: (k) => fnv1a64To32(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff, (k >>> 16) & 0xff, (k >>> 24) & 0xff] : utf8(k)) },
  { name: 'djb2', of: (k) => djb2(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k)) },
  { name: 'sdbm', of: (k) => sdbm(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k)) },
  { name: 'java31', of: (k) => java31(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k)) },
  { name: 'murmur3_32(0)', of: (k) => murmur3_32(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k), 0) },
  { name: 'murmur3_32(0xc70f6907)', of: (k) => murmur3_32(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k), 0xc70f6907) },
  { name: 'crc32', of: (k) => crc32(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k)) },
  { name: 'boost_hash_combine', of: (k) => boostRange(typeof k === 'number' ? [k & 0xff, (k >>> 8) & 0xff] : utf8(k)) },
];

/** 桶迭代约定。返回按桶组织后的下标序列。 */
const CONVENTIONS: { name: string; order: (bucket: number[], insetion: number[]) => number[] }[] = [
  {
    name: 'bucket asc + in-bucket insertion',
    order: (bucket) => bucket.map((_, i) => i).sort((a, b) => bucket[a] - bucket[b] || a - b),
  },
  {
    name: 'bucket asc + in-bucket reverse',
    order: (bucket) => bucket.map((_, i) => i).sort((a, b) => bucket[a] - bucket[b] || b - a),
  },
  {
    name: 'bucket first-use desc + in-bucket reverse (libstdc++ real)',
    order: (bucket) => {
      const firstUse = new Map<number, number>();
      bucket.forEach((bk, i) => { if (!firstUse.has(bk)) firstUse.set(bk, i); });
      return bucket.map((_, i) => i).sort((a, b) => (firstUse.get(bucket[b])! - firstUse.get(bucket[a])!) || b - a);
    },
  },
  {
    name: 'global list head-insert (pure reverse)',
    order: (bucket) => bucket.map((_, i) => i).reverse(),
  },
];

console.log('\n' + '='.repeat(96));
console.log('3. hash-family sweep (key x hash x table size x bucket convention)');
console.log('='.repeat(96));

const TARGETS: { chart: string; system: number; order: number[] }[] = [
  { chart: 'Mean', system: 0, order: [0, 9, 17, 16, 14] },
  { chart: 'Mean', system: 4, order: [1, 4, 6, 0, 2] },
  { chart: 'Mean', system: 5, order: [0, 17, 16, 14] },
  { chart: 'Signals', system: 0, order: [9, 0, 16, 17, 14] },
  { chart: 'Signals', system: 4, order: [4, 6, 1, 0, 2] },
  { chart: 'Signals', system: 5, order: [14, 0, 16, 17] },
];

const presentBySystem = new Map<number, GroupStat[]>();
for (const stat of stats.values()) {
  if (!presentBySystem.has(stat.system)) presentBySystem.set(stat.system, []);
  presentBySystem.get(stat.system)!.push(stat);
}
// 插入序：每组按"首次出现 block"升序（真插入次序）。另外两种插入序也各试一遍。
const INSERT_ORDERS: { name: string; of: (list: GroupStat[]) => GroupStat[] }[] = [
  { name: 'block-order', of: (l) => [...l].sort((a, b) => a.firstBlock - b.firstBlock) },
  { name: 'enum-order', of: (l) => [...l].sort((a, b) => rankOf(a.system, a.signal) - rankOf(b.system, b.signal)) },
  { name: 'signal-asc', of: (l) => [...l].sort((a, b) => a.signal - b.signal) },
];

const SIZES = [...Array.from({ length: 126 }, (_, i) => i + 2), 131, 193, 251];

let best = { score: 0, label: '', detail: '' };
let exact = 0;

for (const keyForm of KEY_FORMS) {
  for (const hash of HASHES) {
    for (const insert of INSERT_ORDERS) {
      for (const conv of CONVENTIONS) {
        for (const size of SIZES) {
          let hits = 0;
          const perTarget: string[] = [];
          for (const target of TARGETS) {
            const list = insert.of(presentBySystem.get(target.system) ?? []);
            const bucket = list.map((s) => hash.of(keyForm.of(s)) % size);
            const order = conv.order(bucket);
            const produced = order.map((i) => list[i].signal);
            const ok = produced.length === target.order.length && produced.every((v, i) => v === target.order[i]);
            if (ok) hits++;
            else perTarget.push(`${target.chart}/sys${target.system}`);
          }
          if (hits === TARGETS.length) {
            exact++;
            console.log(`  OK  all 6 targets: key=${keyForm.name} hash=${hash.name} insert=${insert.name} size=${size} conv=${conv.name}`);
          } else if (hits > best.score) {
            best = {
              score: hits,
              label: `key=${keyForm.name} hash=${hash.name} insert=${insert.name} size=${size} conv=${conv.name}`,
              detail: `missed: ${perTarget.join(', ')}`,
            };
          }
        }
      }
    }
  }
}

console.log(`\n  combinations: ${KEY_FORMS.length * HASHES.length * INSERT_ORDERS.length * CONVENTIONS.length * SIZES.length}`);
console.log(`  combos matching all 6 targets: ${exact}`);
console.log(`  best combo: ${best.score}/6  ${best.label}`);
console.log(`    ${best.detail}`);
console.log('  -> no hash-family member explains all 6 orderings' + (exact === 0 ? ' (0 combos)' : ''));

// ---------------------------------------------------------------- 通道号

console.log('\n' + '='.repeat(96));
console.log('4. c_status bit fields (first observation per group)');
console.log('='.repeat(96));
for (const stat of stats.values()) {
  const sample = allObs.find((o) => o.system === stat.system && o.signal === stat.signal)!;
  const c = sample.cStatus;
  console.log(
    `  ${stat.name.padEnd(16)} c_status=0x${c.toString(16).padStart(8, '0')}` +
      `  bits0-4=${c & 0x1f}  bits0-5=${c & 0x3f}  bits0-9=${c & 0x3ff}` +
      `  bits6-15=${(c >> 6) & 0x3ff}  system=${(c >> 16) & 7}  sig5=${(c >> 21) & 0x1f}  bits26-31=${(c >> 26) & 0x3f}`,
  );
}
