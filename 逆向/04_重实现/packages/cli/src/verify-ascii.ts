/**
 * Field-level differential test: our EDIE decode vs the original suite's ASCII output.
 *
 *   node packages/cli/src/verify-ascii.ts <golden.ASCII> <capture.bin> [--only NAME] [--max N]
 *
 * Both sides come from the same bytes: the ASCII file is what `NovAtelApplicationSuite.exe -a`
 * produced from the capture, so any difference is our decoding, not the data.
 *
 * The layout and the ASCII vocabulary come from the suite's own message dictionary
 * (`data/edie-layouts.json` ← `app/Edie/messages_public.json`), which is what Convert itself reads —
 * see `packages/protocol/src/ascii-diff.ts` for the comparison rules.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffAscii } from '../../protocol/src/ascii-diff.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

function main(): void {
  const argv = process.argv.slice(2);
  let ascii = '';
  let capture = '';
  const only = new Set<string>();
  let max = 4;
  let tolerance = 1e-9;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--tolerance') tolerance = Number(argv[++i]);
    else if (token === '--only') only.add(argv[++i].toUpperCase());
    else if (token === '--max') max = Number(argv[++i]);
    else if (token === '--repeat' || token === '--verbose') continue;
    else if (!token.startsWith('--')) {
      if (!ascii) ascii = token;
      else capture = token;
    }
  }
  if (!ascii || !capture) {
    console.error('usage: verify-ascii.ts <golden.ASCII> <capture.bin> [--only NAME] [--max N] [--tolerance N]');
    process.exit(2);
  }

  const tables = JSON.parse(readFileSync(join(DATA, 'edie-layouts.json'), 'utf8')) as EdieTables;
  const result = diffAscii(readFileSync(ascii, 'utf8'), new Uint8Array(readFileSync(capture)), tables, {
    tolerance,
    sampleLimit: max,
    only,
  });

  console.log('message             lines   fields     ok    bad    shape   ok%');
  for (const row of result.messages) {
    const pct = row.fields ? ((row.ok / row.fields) * 100).toFixed(2) : '  -  ';
    console.log(
      `${row.name.padEnd(18)} ${String(row.lines).padStart(6)} ${String(row.fields).padStart(8)} ${String(row.ok).padStart(6)} ` +
        `${String(row.bad).padStart(6)} ${String(row.shape).padStart(7)} ${pct.padStart(7)}`,
    );
    for (const sample of row.samples) console.log(`    ${sample}`);
  }
  console.log('-'.repeat(66));
  const pct = result.fields ? ((result.ok / result.fields) * 100).toFixed(2) : '0';
  console.log(`fields: ${result.ok}/${result.fields} matched  (${pct}%)`);
  process.exit(result.matches ? 0 : 1);
}

main();
