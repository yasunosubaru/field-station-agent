/**
 * Compare the bytes **we** call unknown with the bytes the suite writes to `<base>.UNKNOWN`.
 *
 *   node 逆向/tools/unknown-diff.ts <capture.sbf> [--suite <file.UNKNOWN>] [--show <n>]
 *
 * Without `--suite` it runs the suite itself (`--unknown-bytes=file`). The comparison is a plain
 * byte diff: our stream comes from `convert-pipeline.ts#unknownSpans`, the same one
 * `--unknown-bytes=file` writes, so a difference names the rule that is still missing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { suiteConvert } from './suite-unknown.ts';

const tables: EdieTables = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'),
  'utf8',
));

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
const asText = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');

function main(): void {
  const argv = process.argv.slice(2);
  let suitePath: string | undefined;
  let show = 6;
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite') suitePath = argv[++i];
    else if (argv[i] === '--show') show = Number(argv[++i]);
    else if (!argv[i].startsWith('-')) inputs.push(argv[i]);
  }

  for (const input of inputs) {
    const capture = new Uint8Array(readFileSync(input));
    const deframer = new SbfDeframer({ crcMode: 'validate' });
    const frames = deframer.push(capture);
    deframer.end();
    const outcome = convertFrames(frames, {
      format: 'ABBREV_ASCII',
      at: new Date('2026-11-01T00:00:00Z'),
      tables,
      name: input.split(/[\\/]/).pop()!,
      source: capture,
    });
    const ours = outcome.unknown;
    const suite = suitePath ? new Uint8Array(readFileSync(suitePath)) : suiteConvert(input, 'file').unknown ?? new Uint8Array(0);

    console.log(`\n=== ${input}`);
    console.log(`ours  ${ours.length} B   summary row would read ${outcome.unknownCount}`);
    console.log(`suite ${suite.length} B`);
    console.log(ours.length === suite.length && ours.every((byte, index) => byte === suite[index])
      ? 'identical'
      : `DIFFERS (${ours.length - suite.length} B)`);

    let same = 0;
    while (same < ours.length && same < suite.length && ours[same] === suite[same]) same += 1;
    console.log(`common prefix ${same} B`);
    if (same === ours.length && same === suite.length) continue;
    for (let k = 0; k < show; k++) {
      const at = same + k * 32;
      if (at >= Math.max(ours.length, suite.length)) break;
      const slice = (bytes: Uint8Array) => bytes.subarray(at, Math.min(at + 32, bytes.length));
      console.log(`@${at}`);
      console.log(`  ours  ${hex(slice(ours)).padEnd(96)} |${asText(slice(ours))}|`);
      console.log(`  suite ${hex(slice(suite)).padEnd(96)} |${asText(slice(suite))}|`);
    }
  }
}

main();
