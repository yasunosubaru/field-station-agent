/**
 * Probe: compare our `-b` output with the suite's for every capture in the live sample set.
 *
 *   node 逆向/tools/probe-binary-captures.ts            # b1…b7
 *   node 逆向/tools/probe-binary-captures.ts b1 b7 live-nav
 *
 * The suite needs a pure-ASCII output directory; it is created under the temp root.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';

const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
const TEMP = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';
const SAMPLES = 'H:\\Archive\\文件夹 老版\\personal content\\课程资料\\其他\\大创项目\\野外台站智能体\\逆向\\00_来源\\samples\\live-20261031';
const tables = JSON.parse(
  readFileSync(new URL('../04_重实现/packages/protocol/data/edie-layouts.json', import.meta.url), 'utf8'),
) as EdieTables;

const asked = process.argv.slice(2).filter((token) => !token.startsWith('-'));
const names = asked.length ? asked : ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

for (const name of names) {
  const file = /^b\d$/.test(name) ? `${name}-20261101.sbf` : `${name}.sbf`;
  const path = join(SAMPLES, file);
  const capture = new Uint8Array(readFileSync(path));
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(capture)];
  deframer.end();
  const ours = convertFrames(frames, {
    format: 'BINARY',
    at: new Date('2026-10-30T17:10:00Z'),
    tables,
    name: file,
  });
  const ourBytes = ours.files[0]!.bytes;

  const dir = mkdtempSync(join(TEMP, 'oracle-capture-'));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, capture);
    const out = join(dir, 'BINARY');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, ['-b', '-o', out, input], { stdio: 'pipe', timeout: 180_000 });
    const stem = readdirSync(out)[0];
    const stamp = readdirSync(join(out, stem))[0];
    const binDir = join(out, stem, stamp, 'BINARY');
    const suiteBytes = new Uint8Array(readFileSync(join(binDir, readdirSync(binDir)[0])));
    const same = ourBytes.length === suiteBytes.length && sha(ourBytes) === sha(suiteBytes);
    console.log(`${same ? 'OK  ' : 'FAIL'} ${name.padEnd(14)} ours ${ourBytes.length} B  suite ${suiteBytes.length} B  ours sha ${sha(ourBytes)}  suite sha ${sha(suiteBytes)}`);
    if (ours.unencodedText.length) console.log(`  unencoded text: ${JSON.stringify(ours.unencodedText.slice(0, 5))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
