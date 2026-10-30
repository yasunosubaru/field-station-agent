// Derive the RINEX 2.1 observation layout from the golden file: epoch line, per-satellite field
// positions and the LLI/SNR flag bytes.
import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
const lines = text.split(/\r?\n/);
const end = lines.findIndex((line) => /END OF HEADER/.test(line));
console.log('header lines:', end + 1, ' data lines:', lines.length - end - 1);

const epoch = lines[end + 1];
console.log('epoch:', JSON.stringify(epoch), 'len', epoch.length);
// 2.10 epoch record: yy mm dd hh mm ss.sssssss  flag nsat  list(3 chars each)
console.log('epoch slices:', JSON.stringify({
  yy: epoch.slice(0, 3),
  mm: epoch.slice(3, 6),
  dd: epoch.slice(6, 9),
  hh: epoch.slice(9, 12),
  mi: epoch.slice(12, 15),
  ss: epoch.slice(15, 26),
  flag: epoch.slice(26, 29),
  nsat: epoch.slice(29, 32),
  sats: epoch.slice(32, 32 + 3 * 9),
}));

// First satellite block: 8 observations => 2 lines (5 + 3).
for (let i = end + 2; i < end + 4; i++) {
  const line = lines[i];
  console.log(`line ${i - end - 1}: len=${line.length}`);
  for (let f = 0; f < 5; f++) {
    const at = f * 16;
    if (at >= line.length) break;
    console.log(`  field ${f} @${at}: value=${JSON.stringify(line.slice(at, at + 14))} lli=${JSON.stringify(line.slice(at + 14, at + 15))} snr=${JSON.stringify(line.slice(at + 15, at + 16))}`);
  }
}

// Count distinct epoch block shapes.
const shapes = new Map();
for (let i = end + 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const key = `${line.length}:${line.slice(0, 2)}`;
  shapes.set(key, (shapes.get(key) ?? 0) + 1);
}
console.log('line shape histogram (length:prefix):', JSON.stringify([...shapes.entries()].slice(0, 12)));

// Multi-line epoch header (more than 12 satellites) sample.
for (let i = end + 1; i < lines.length; i++) {
  const line = lines[i];
  if (/^ {32}/.test(line) && line.length === 80) {
    console.log('continuation line:', JSON.stringify(line));
    break;
  }
}
