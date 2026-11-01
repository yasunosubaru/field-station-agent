/**
 * Probe A10: the inner CRC of a text `#RXCONFIGA` record, and which embedded names are dropped.
 *
 * Layout in both the capture and the golden:
 *
 *   #RXCONFIGA,<head>;#<INNER>,<innerHead>;<innerBody>*<innerCrc>*<outerCrc>
 *
 * The suite re-renders the inner record and prints a CRC that is neither the capture's nor the
 * plain CRC of the re-rendered text. This tries every plausible byte span against
 * `golden-b7-20261101.ASCII` and counts how many of the 247 records each convention reproduces, so
 * a convention is only adopted when every record matches.
 *
 *   node 逆向/tools/probe-rxconfiga.ts
 *
 * Result (2026-11-01): `~novatelCrc32("NAME,<head>;<body>")` — 247/247, everything else 0/247.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { novatelCrc32 } from '../04_重实现/packages/protocol/src/crc.ts';
import { latin1Bytes } from '../04_重实现/packages/protocol/src/ascii-log.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';

const root = join(import.meta.dirname, '..');
const live = join(root, '00_来源', 'samples', 'live-20261031');
const tables: EdieTables = JSON.parse(
  readFileSync(join(root, '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
);

const readText = (path: string): string => {
  const bytes = readFileSync(path);
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

const bytes = new Uint8Array(readFileSync(join(live, 'b7-20261101.sbf')));
const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(bytes)];
const raw = frames
  .filter((frame) => frame.kind === 'text' && frame.text.startsWith('#RXCONFIG'))
  .map((frame) => frame.text.replace(/[\r\n]+$/, ''));
const golden = readText(join(live, 'golden-b7-20261101.ASCII'))
  .split('\r\n')
  .filter((line) => line.startsWith('#RXCONFIGA'));
console.log(`raw ${raw.length}, golden ${golden.length}`);

const crc = (text: string): string => novatelCrc32(latin1Bytes(text)).toString(16).padStart(8, '0');
const complement = (text: string): string =>
  ((novatelCrc32(latin1Bytes(text)) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');

// ---------------------------------------------------------------- ① which embedded names drop

const names = new Set(Object.values(tables.messages).map((message) => message.name));
const unknown = new Map<string, number>();
for (const line of raw) {
  const blob = line.slice(line.indexOf(';') + 1);
  const innerName = blob.slice(1, blob.indexOf(','));
  const base = innerName.replace(/[A-Z]$/, '');
  if (!names.has(base)) unknown.set(innerName, (unknown.get(innerName) ?? 0) + 1);
}
const dropped = [...unknown.values()].reduce((sum, count) => sum + count, 0);
console.log(`\nembedded names the dictionary lacks: ${unknown.size} distinct, ${dropped} records`);
console.log([...unknown].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join(' '));
console.log(`269 − ${dropped} = ${raw.length - dropped} (golden has ${golden.length})`);

// ---------------------------------------------------------------- ② the inner CRC convention

interface Parts {
  /** `RXCONFIGA,<head>`, no leading `#`. */
  outerHead: string;
  /** `INNER,<head>;<body>` — the inner record as printed, no `#` and no `*`. */
  innerText: string;
  innerNameHead: string;
  innerBody: string;
  innerCrc: string;
  outerCrc: string;
}

function split(line: string): Parts | undefined {
  const last = line.lastIndexOf('*');
  if (last < 0) return undefined;
  const before = line.slice(0, last);
  const innerAt = before.lastIndexOf('*');
  if (innerAt < 0) return undefined;
  const record = before.slice(0, innerAt);
  const innerStart = record.indexOf('#', 1);
  if (innerStart < 0) return undefined;
  const innerText = record.slice(innerStart + 1);
  const semicolon = record.indexOf(';');
  return {
    outerHead: record.slice(1, semicolon),
    innerText,
    innerNameHead: innerText.slice(0, innerText.indexOf(';')),
    innerBody: innerText.slice(innerText.indexOf(';') + 1),
    innerCrc: before.slice(innerAt + 1),
    outerCrc: line.slice(last + 1),
  };
}

const bySequence = new Map<string, string>();
for (const line of golden) bySequence.set(line.split(',')[2], line);

/** Every span we could think of, computed from the **golden** (re-rendered) text. */
const conventions: Record<string, (p: Parts) => string> = {
  'INNER,head;body': (p) => p.innerText,
  '#INNER,head;body': (p) => `#${p.innerText}`,
  'INNER,head;body*': (p) => `${p.innerText}*`,
  '#INNER,head;body*': (p) => `#${p.innerText}*`,
  'body': (p) => p.innerBody,
  'body*': (p) => `${p.innerBody}*`,
  'INNER;body': (p) => `${p.innerNameHead};${p.innerBody}`,
  '#INNER;body': (p) => `#${p.innerNameHead};${p.innerBody}`,
  'outer,head;inner': (p) => `${p.outerHead};#${p.innerText}`,
  '#outer,head;inner': (p) => `#${p.outerHead};#${p.innerText}`,
};

const score = new Map<string, number>(Object.keys(conventions).map((name) => [name, 0]));
let paired = 0;
for (const line of raw) {
  const gold = bySequence.get(line.split(',')[2]);
  if (!gold) continue;
  const goldParts = split(gold);
  if (!goldParts) continue;
  paired += 1;
  for (const [name, build] of Object.entries(conventions)) {
    if (crc(build(goldParts)) === goldParts.innerCrc) score.set(name, (score.get(name) ?? 0) + 1);
  }
}

console.log(`\ninner CRC conventions, crc(text) === golden inner CRC (paired ${paired}):`);
for (const [name, hits] of [...score].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(hits).padStart(4)}/${paired}  ${name}`);
}

// ---------------------------------------------------------------- ③ the convention that works

let complementHits = 0;
let outerHits = 0;
for (const gold of golden) {
  const parts = split(gold);
  if (!parts) continue;
  if (complement(parts.innerText) === parts.innerCrc) complementHits += 1;
  if (crc(`${parts.outerHead};#${parts.innerText}*${parts.innerCrc}`) === parts.outerCrc) outerHits += 1;
}
console.log(`\n~novatelCrc32("INNER,<head>;<body>") === inner CRC: ${complementHits}/${golden.length}`);
console.log(` novatelCrc32("<outer>,<head>;#INNER…*<innerCrc>") === outer CRC: ${outerHits}/${golden.length}`);

// ---------------------------------------------------------------- ④ the three numbers, one line

const SEQUENCE = '265';
const text = split(golden.find((line) => line.split(',')[2] === SEQUENCE)!);
const rawLine = raw.find((line) => line.split(',')[2] === SEQUENCE)!;
console.log(`\nsequence ${SEQUENCE}:`);
console.log(`  capture  ${split(rawLine)?.innerText}*${split(rawLine)?.innerCrc}`);
console.log(`  golden   ${text.innerText}*${text.innerCrc}`);
const original = split(rawLine)!.innerText;
console.log(`  plain CRC of the capture text   ${crc(original)}  (its complement ${complement(original)})`);
console.log(`  plain CRC of the re-rendered    ${crc(text.innerText)}  (its complement ${complement(text.innerText)})`);
