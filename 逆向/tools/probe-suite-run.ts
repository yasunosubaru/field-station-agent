/**
 * Run the installed suite's Convert with arbitrary flags on a capture, keep what it wrote, and
 * print the files and the CLI's own report.
 *
 *   node 逆向/tools/probe-suite-run.ts <capture> [--keep <dir>] [--flag ...] [--args "-a --decimate=5"]
 *
 * Why a probe and not a test: every rule in `convert-pipeline.ts` is measured against the suite, and
 * a measurement needs the capture on a pure-ASCII path with no spaces (the suite silently converts
 * nothing otherwise). `--keep` copies the whole output tree somewhere it can be diffed later.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { SUITE, TEMP_ROOT } from './oracle.ts';

const argv = process.argv.slice(2);
const inputs: string[] = [];
let keep: string | undefined;
let extra = '';
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token === '--keep') keep = argv[++i];
  else if (token === '--args') extra = argv[++i];
  else if (!token.startsWith('--')) inputs.push(token);
}

for (const input of inputs) {
  const dir = mkdtempSync(join(TEMP_ROOT, 'suite-run-'));
  try {
    const copy = join(dir, basename(input).replace(/[^A-Za-z0-9_.-]/g, '_'));
    copyFileSync(input, copy);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    const flags = ['-a', '-o', out, ...extra.split(/\s+/).filter(Boolean), copy];
    console.log(`\n=== ${basename(input)}  flags: ${flags.slice(0, -1).join(' ')}`);
    let stdout = '';
    try {
      stdout = execFileSync(SUITE, flags, { encoding: 'latin1', timeout: 600_000 });
    } catch (error) {
      stdout = `${(error as { stdout?: string }).stdout ?? ''}`;
      console.log(`(exit nonzero) ${(error as Error).message}`);
    }
    const tail = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of tail) if (!/[|+]/.test(line)) console.log(`  ${line}`);
    const stem = readdirSync(out)[0];
    const stamp = stem ? readdirSync(join(out, stem))[0] : undefined;
    if (!stem || !stamp) { console.log('  (suite wrote nothing)'); continue; }
    const tree = join(out, stem, stamp);
    const dump = (sub: string) => {
      for (const entry of readdirSync(sub, { withFileTypes: true })) {
        const full = join(sub, entry.name);
        if (entry.isDirectory()) dump(full);
        else console.log(`  file ${full.slice(tree.length + 1).padEnd(44)} ${String(statSync(full).size).padStart(9)} B`);
      }
    };
    dump(tree);
    if (keep) {
      mkdirSync(keep, { recursive: true });
      cpSync(tree, join(keep, stem), { recursive: true });
      const summary = readdirSync(tree).find((name) => name.startsWith('Summary_'));
      if (summary) writeFileSync(join(keep, `Summary_${stem}.txt`), readFileSync(join(tree, summary)));
      console.log(`  kept in ${join(keep, stem)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
