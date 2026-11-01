import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const cli = join(repo, '04_重实现', 'packages', 'cli', 'src', 'convert.ts');
const live = join(repo, '00_来源', 'samples', 'live-20261031');
const convert = join(repo, '00_来源', 'samples', 'convert');

interface Row {
  capture: string; format: string; golden: string;
}

const rows: Row[] = [
  { capture: join(live, 'b1-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b1-20261101.ABBREV_Summary.txt') },
  { capture: join(live, 'b2-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b2-20261101.ABBREV_Summary.txt') },
  { capture: join(live, 'b3-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b3-20261101.ABBREV_Summary.txt') },
  { capture: join(live, 'b5-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b5-20261101.ABBREV_Summary.txt') },
  { capture: join(live, 'b5-20261101.sbf'), format: 'ASCII', golden: join(live, 'golden-b5-20261101.Summary.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'RINEX21', golden: join(convert, 'golden-rinex2_1', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'RINEX301', golden: join(convert, 'golden-rinex3_01', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'RINEX302', golden: join(convert, 'golden-rinex3_02', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'RINEX303', golden: join(convert, 'golden-rinex3_03', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'RINEX304', golden: join(convert, 'golden-rinex3_04', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'ASCII', golden: join(convert, 'golden-ascii', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
  { capture: join(convert, 'clean-9600.gps'), format: 'KML', golden: join(convert, 'golden-kml', 'clean-9600', 'Converted_On_20261030_T1710', 'Summary_clean-9600.txt') },
];

/** Everything that is inherently per-run: the stamp and the two paths. */
function comparable(summary: string): string {
  return summary
    .split('\n')
    .filter((_line, index) => index !== 1 && index !== 4 && index !== 7)
    .join('\n');
}

let failures = 0;
for (const row of rows) {
  const stem = row.capture.split(/[\\/]/).pop()!.replace(/\.(sbf|gps)$/i, '');
  const out = mkdtempSync(join(tmpdir(), 'sum-'));
  try {
    execFileSync(process.execPath, [cli, row.capture, '--to', row.format, '--out', out, '--at', '2026-11-01T00:00:00'], { stdio: 'pipe' });
    const root = join(out, stem);
    const stamp = readdirSync(root).find((entry) => entry.startsWith('Converted_On_'));
    const ours = readFileSync(join(root, stamp!, `Summary_${stem}.txt`), 'utf8');
    const golden = readFileSync(row.golden, 'utf8');
    const same = comparable(ours) === comparable(golden);
    if (!same) {
      failures += 1;
      const a = comparable(ours).split('\n');
      const b = comparable(golden).split('\n');
      const diff: string[] = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) diff.push(`  line ${i}: ours ${JSON.stringify(a[i])} vs golden ${JSON.stringify(b[i])}`);
      }
      console.log(`FAIL ${row.format.padEnd(13)} ${stem}\n${diff.slice(0, 8).join('\n')}`);
    } else {
      console.log(`OK   ${row.format.padEnd(13)} ${stem}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
console.log(failures === 0 ? `\nall ${rows.length} summaries identical` : `\n${failures} summar(ies) differ`);
