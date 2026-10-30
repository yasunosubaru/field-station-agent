// Correlate the RINEX 2.1 SNR codes and LLI digits with the values they sit next to.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const end = lines.findIndex((line) => /END OF HEADER/.test(line));

const lliByField = new Map<number, Map<string, number>>();
const snrPairs = new Map<string, number>(); // `${cnr}` => code seen on the same satellite

let index = end + 1;
while (index < lines.length) {
  const epoch = lines[index];
  if (!epoch || epoch.length < 32) { index += 1; continue; }
  const count = Number(epoch.slice(29, 32));
  let cursor = index + 1;
  const satellites = [];
  for (let s = 0; s < count; s++) {
    const fields: Array<{ value: string; lli: string; snr: string }> = [];
    for (let line = 0; line < 2 && cursor < lines.length; line++) {
      const text = lines[cursor++];
      for (let f = 0; f < 5; f++) {
        const at = f * 16;
        if (at + 14 > text.length) break;
        fields.push({ value: text.slice(at, at + 14), lli: text.slice(at + 14, at + 15), snr: text.slice(at + 15, at + 16) });
      }
    }
    satellites.push(fields);
  }
  for (const fields of satellites) {
    fields.forEach((field, i) => {
      if (!lliByField.has(i)) lliByField.set(i, new Map());
      const bucket = lliByField.get(i)!;
      bucket.set(field.lli, (bucket.get(field.lli) ?? 0) + 1);
    });
    const cnr = fields[3]?.value.trim();
    const code = fields[0]?.snr;
    if (cnr && code && code !== ' ') snrPairs.set(cnr, (snrPairs.get(cnr) ?? 0) + 1);
  }
  index = cursor;
}

console.log('LLI digit histogram per field index:');
for (const [field, bucket] of [...lliByField.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  field ${field}: ${[...bucket.entries()].map(([k, v]) => `${JSON.stringify(k)}×${v}`).join(' ')}`);
}
const pairs = [...snrPairs.entries()].slice(0, 30);
console.log('C/N0 → SNR code (first 30):', pairs.map(([cnr, n]) => `${cnr}→?×${n}`).join(' '));
