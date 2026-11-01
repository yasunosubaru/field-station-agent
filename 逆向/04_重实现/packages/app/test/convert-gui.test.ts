/**
 * The Convert page's **Output Settings**, from the five controls to what the pipeline does.
 *
 * Two halves, both against numbers the suite itself produced:
 *
 *  1. `outputSettings()` — the pure mapping the panel uses (`web/panels/convert.js`). Each control's
 *     rule is the one the shipped `convert.js` implements; the comments there carry the line numbers.
 *  2. `/api/convert` — the same request over HTTP, so the fields really reach `convertFrames`.
 *
 * The measurements (`-a` on `b2-20261101.sbf`, suite 2.11.0 via the CLI, and the same numbers
 * through the native `Convert` with `decimationFilter` set — the GUI's own path):
 *
 * ```
 * decimate 0.5 s (Sample Rate 2 Hz)   916 189 B / 327 lines
 * decimate 2.5 s                      199 291 B
 * decimate 2 s (Sample Rate 0.5 Hz)   364 859 B / 171 lines
 * --unknown-bytes=file                + b2-20261101.UNKNOWN 7 056 B
 * --start-time=2442,577760 --finish-time=2442,577770   1 362 914 B / 262 lines
 * Prefix `abc`                        abcb2-20261101.ASCII
 * Suffix `abc`                        b2-20261101abc.ASCII
 * ```
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { outputSettings } from '../src/web/panels/convert.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoRoot = resolve(here, '..', '..', '..', '..', '..');

/* ---------------------------------------------------------------------------------------------
 * 1. The controls → the request body
 * ------------------------------------------------------------------------------------------ */

test('Sample Rate is 1 / Hz seconds, and empty or 0 means no thinning', () => {
  const rate = (sampleRate: string) => outputSettings({ sampleRate }).body;
  // `decimationFilter = 1 / sampleRate` (`convert.js:1922`), and `--decimate` is that same field
  // (`cli.js:220`), so 100 Hz is a 10 ms interval.
  assert.equal(rate('100').decimate, 0.01);
  assert.equal(rate('1').decimate, 1);
  assert.equal(rate('2').decimate, 0.5);
  // 0.5 Hz — the half-rate case the GUI's `parseInt` check would truncate to 0 — is 2 s.
  assert.equal(rate('0.5').decimate, 2);
  assert.equal(rate('0.1').decimate, 10);
  assert.equal('decimate' in rate(''), false, 'empty means "do not decimate"');
  assert.equal('decimate' in rate('   '), false);
  assert.equal('decimate' in rate('0'), false, '`sampleRate == 0` is "off" in the suite too');
});

test('Sample Rate refuses what is not a rate instead of silently thinning by 0', () => {
  for (const bad of ['abc', '1,5', '-1', '1000', '1e9']) {
    const result = outputSettings({ sampleRate: bad });
    assert.equal(result.body, null, `${bad} is rejected`);
    assert.match(result.error!, /Sample Rate/);
  }
  // The suite's own upper bound (`convert.js:1854`).
  assert.equal(outputSettings({ sampleRate: '999.99' }).error, null);
});

test('Unknown Data maps SEPARATE / INTERLEAVE onto the native spellings', () => {
  // The GUI's `unconvertedBytes` values (`convert.js:52`, `convert.html:340-341`) and the native's
  // names for the CLI's `--unknown-bytes=file|interleave` (`cli.js:161-164`).
  assert.equal(outputSettings({ unknown: 'SEPARATE' }).body.unknown, 'separate');
  assert.equal(outputSettings({ unknown: 'INTERLEAVE' }).body.unknown, 'interleave');
  assert.equal(outputSettings({}).body.unknown, 'separate', 'Separate file is the default');
});

test('Destination sends a path only for "Select folder"', () => {
  const source = outputSettings({ destinationMode: 'SOURCE', destination: 'C:\\somewhere' }).body;
  assert.equal('destination' in source, false, 'Source file folder keeps the run in memory');
  const selected = outputSettings({ destinationMode: 'SELECTED', destination: '  C:\\out\\here  ' });
  assert.equal(selected.body.destination, 'C:\\out\\here', 'trimmed, sent verbatim');
  const empty = outputSettings({ destinationMode: 'SELECTED', destination: '  ' });
  assert.equal(empty.body, null);
  assert.match(empty.error!, /Destination/);
});

test('Prefix and Suffix become one of the two native affix types', () => {
  assert.equal(outputSettings({ affixName: 'abc', affixType: 'PREFIX' }).body.prefix, 'abc');
  assert.equal('suffix' in outputSettings({ affixName: 'abc', affixType: 'PREFIX' }).body, false);
  assert.equal(outputSettings({ affixName: 'abc', affixType: 'SUFFIX' }).body.suffix, 'abc');
  assert.equal('prefix' in outputSettings({ affixName: 'abc', affixType: 'SUFFIX' }).body, false);
  assert.equal('prefix' in outputSettings({ affixName: '   ' }).body, false, 'blank is no affix');
  // 18 characters is the box's `maxlength`; the suite also rejects path characters (`:1862-1873`).
  assert.equal(outputSettings({ affixName: 'abcdefghijklmnopqr' }).error, null);
  assert.match(outputSettings({ affixName: 'abcdefghijklmnopqrs' }).error!, /18/);
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    assert.match(outputSettings({ affixName: bad }).error!, /cannot contain/, bad);
  }
});

test('Time Interval sends both ends, and refuses an inverted window', () => {
  const start = new Date('2026-10-31T16:29:02Z');
  const finish = new Date('2026-10-31T16:29:12Z');
  const body = outputSettings({ start, finish }).body;
  assert.equal(body.start, '2026-10-31T16:29:02.000Z');
  assert.equal(body.finish, '2026-10-31T16:29:12.000Z', 'the finish used to be dropped');
  // One end only is legal: the suite sends whichever interval the user edited.
  assert.equal('start' in outputSettings({ start }).body, true);
  assert.equal('finish' in outputSettings({ start }).body, false);
  const inverted = outputSettings({ start: finish, finish: start });
  assert.equal(inverted.body, null);
  assert.match(inverted.error!, /before the start/);
  // An unparsed field is not an interval at all (`isTimeIntervalEdited` stays false in the suite).
  assert.equal('start' in outputSettings({ start: new Date('nonsense') }).body, false);
});

/* ---------------------------------------------------------------------------------------------
 * 2. The same request over HTTP
 * ------------------------------------------------------------------------------------------ */

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in 20s\nstderr:\n${stderr}`)), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stderr}`));
    });
  });
}

interface ConvertBody {
  ok: boolean;
  fileName: string;
  bytes: number;
  lineTotal: number;
  base: string;
  files: Array<{ fileName: string; bytes: number }>;
  directory: string | null;
  path: string | null;
  unknownBytes: number;
  unknownFileName: string | null;
  unConvertedBytes: number;
  decimate: number | null;
  unknown: string;
  prefix: string | null;
  suffix: string | null;
  start: { week: number; seconds: number } | null;
  finish: { week: number; seconds: number } | null;
}

async function convert(body: Record<string, unknown>): Promise<{ status: number; body: ConvertBody & { error?: string } }> {
  const response = await fetch(base + '/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ConvertBody & { error?: string } };
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    timer.unref();
  }
});

const B2 = 'b2-20261101.sbf';
const CLEAN = 'clean-9600.gps';

test('Sample Rate 2 Hz (= `--decimate=0.5`) matches the suite byte for byte', async () => {
  const { status, body } = await convert({ capture: B2, format: 'ASCII', decimate: 0.5 });
  assert.equal(status, 200);
  assert.equal(body.decimate, 0.5);
  // The suite's own `-a --decimate=0.5` on b2, and the native `decimationFilter: 0.5`.
  assert.equal(body.bytes, 916_189);
  assert.equal(body.lineTotal, 327);
});

test('Sample Rate 2.5 s matches the suite, and 0.5 Hz is the 2 s run', async () => {
  const slow = await convert({ capture: B2, format: 'ASCII', decimate: 2.5 });
  assert.equal(slow.body.bytes, 199_291);

  // What the panel sends for Sample Rate `0.5`: the native's `decimationFilter: 2`.
  const half = await convert({ capture: B2, format: 'ASCII', decimate: 1 / 0.5 });
  assert.equal(half.body.bytes, 364_859);
  assert.equal(half.body.lineTotal, 171);
});

test('Unknown Data SEPARATE writes `<base>.UNKNOWN` with the suite\'s 7 056 bytes', async () => {
  const { body } = await convert({ capture: B2, format: 'ASCII', unknown: 'separate' });
  assert.equal(body.unknownBytes, 7_056);
  assert.equal(body.unknownFileName, 'b2-20261101.UNKNOWN');
  assert.deepEqual(body.files.map((file) => file.fileName), ['b2-20261101.ASCII', 'b2-20261101.UNKNOWN']);
  assert.equal(body.files[1].bytes, 7_056);

  // Interleave splices the same bytes into the one output file instead of writing a second one.
  const interleaved = await convert({ capture: B2, format: 'ASCII', unknown: 'interleave' });
  assert.equal(interleaved.body.unknownFileName, null);
  assert.equal(interleaved.body.unknownBytes, 7_056);
  assert.equal(interleaved.body.files.length, 1);
  assert.ok(interleaved.body.bytes > 4_931_973, `${interleaved.body.bytes} > the plain 4 931 973`);
});

test('Time Interval keeps both ends: the suite\'s window is 1 362 914 B', async () => {
  // `--start-time=2442,577760 --finish-time=2442,577770` on b2.
  const { body } = await convert({
    capture: B2,
    format: 'ASCII',
    start: { week: 2442, seconds: 577760 },
    finish: { week: 2442, seconds: 577770 },
  });
  assert.equal(body.bytes, 1_362_914);
  assert.equal(body.lineTotal, 262);
  assert.deepEqual(body.start, { week: 2442, seconds: 577760 });
  assert.deepEqual(body.finish, { week: 2442, seconds: 577770 });

  // The page sends ISO instants; `utcDateToGps` must land on the same GPS week/second.
  const iso = await convert({
    capture: B2,
    format: 'ASCII',
    start: '2026-10-31T16:29:02Z',
    finish: '2026-10-31T16:29:12Z',
  });
  assert.equal(iso.body.bytes, body.bytes, 'ISO and {week, seconds} name the same window');
});

test('Prefix/Suffix land on the output base, before the extension', async () => {
  const prefix = await convert({ capture: CLEAN, format: 'ASCII', prefix: 'abc' });
  assert.equal(prefix.body.fileName, 'abcclean-9600.ASCII');
  assert.equal(prefix.body.prefix, 'abc');
  const suffix = await convert({ capture: CLEAN, format: 'ASCII', suffix: 'abc' });
  assert.equal(suffix.body.fileName, 'clean-9600abc.ASCII');
  assert.equal(suffix.body.suffix, 'abc');
  // Measured on the native, the affix is on `.UNKNOWN` as well.
  const both = await convert({ capture: CLEAN, format: 'ASCII', prefix: 'abc', unknown: 'separate' });
  assert.equal(both.body.unknownFileName, 'abcclean-9600.UNKNOWN');
});

test('Destination is written in the suite\'s layout, path and directory come back', async () => {
  const destination = mkdtempSync(join(tmpdir(), 'convert-gui-'));
  try {
    const { body } = await convert({
      capture: CLEAN,
      format: 'ASCII',
      prefix: 'abc',
      unknown: 'separate',
      destination,
      at: '2026-11-01T00:00:00Z',
    });
    assert.ok(body.directory, 'directory is reported');
    assert.ok(body.path, 'path is reported');
    // `SelectedFolder/Source/TimeStamp/Format/FileName` (manual 4.3.2.5).
    assert.equal(
      body.directory,
      join(destination, 'clean-9600', 'Converted_On_20261101_T0000', 'ASCII'),
    );
    assert.equal(body.path, join(body.directory!, 'abcclean-9600.ASCII'));
    for (const file of body.files) {
      const written = join(body.directory!, file.fileName);
      assert.equal(statSync(written).size, file.bytes, `${file.fileName} is on disk`);
    }
    assert.ok(existsSync(join(body.directory!, 'abcclean-9600.UNKNOWN')));
    assert.ok(readFileSync(body.path!).length > 0);

    // Without a Destination nothing is written: the same run has no path at all.
    const memory = await convert({ capture: CLEAN, format: 'ASCII', at: '2026-11-01T00:00:00Z' });
    assert.equal(memory.body.directory, null);
    assert.equal(memory.body.path, null);

    // Every file of a multi-file format lands as well: RINEX writes the observation plus its nav
    // files (`<base>.26O/.26N/.26G`), and only the first one is previewed.
    const rinex = await convert({
      capture: CLEAN,
      format: 'RINEX21',
      destination,
      at: '2026-11-01T00:00:00Z',
    });
    assert.deepEqual(rinex.body.files.map((file) => file.fileName), [
      'clean-9600.26O',
      'clean-9600.26N',
      'clean-9600.26G',
    ]);
    assert.equal(rinex.body.path, join(rinex.body.directory!, 'clean-9600.26O'));
    for (const file of rinex.body.files) {
      assert.equal(statSync(join(rinex.body.directory!, file.fileName)).size, file.bytes);
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test('a bad Output Setting is a readable 400, not a silent conversion', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ decimate: 0 }, /decimate/],
    [{ decimate: 'abc' }, /decimate/],
    [{ decimate: -1 }, /decimate/],
    [{ unknown: 'maybe' }, /unknown/],
    [{ prefix: 'ab/c' }, /Prefix/],
    [{ prefix: 'abcdefghijklmnopqrs' }, /18/],
    [{ prefix: 'a', suffix: 'b' }, /prefix/],
    [{ start: 'not-a-date' }, /start/],
    [{ finish: 42 }, /finish/],
    [{ destination: 'relative\\path' }, /absolute|绝对/],
    [{ destination: 'C:\\Windows\\..\\Users' }, /\.\./],
    [{ destination: 'C:\\Windows\\win.ini' }, /目录/],
  ];
  for (const [patch, pattern] of cases) {
    const { status, body } = await convert({ capture: CLEAN, format: 'ASCII', ...patch });
    assert.equal(status, 400, JSON.stringify(patch));
    assert.match(String(body.error), pattern, JSON.stringify(patch));
  }
});
