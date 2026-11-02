/**
 * D5 (file half) — `FlagsInitialState` in a project's `.gpf`.
 *
 * Graph writes the Pre-process markers into the project file
 * (`FlagsInitialState: {allFlags, isFlagsPanelOpen}`, `index-B86bHcCD.js` @16246801 / @16247254).
 * `packages/graph/src/export-projects.ts` is where this build does the file I/O, because a `.gpf` is
 * a file the browser cannot reach. What is pinned here:
 *
 *  1. which `.gpf` belongs to a project (`<key>.gpf`, else `<name>.gpf`, else the only `*.gpf`);
 *  2. a **real** `clean.gpf` copied into a temp project: write → read gives the flags back, and every
 *     other key of the file is byte-for-byte what it was (key order included);
 *  3. the rest of the file's *shape* survives too — 2-space indentation, LF/CRLF, BOM, trailing
 *     newline — because the text is re-serialised with the input's own formatting;
 *  4. nothing is written when there is no `.gpf` (the caller falls back to `localStorage`), or when
 *     the `.gpf` is not parsable (it is user data; a broken file is reported, never replaced);
 *  5. two projects never share flags, and writing the same state twice is a no-op.
 *
 *   node --test --test-force-exit "packages/graph/test/gpf-flags.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeGpfFlags,
  projectGpfPath,
  readProjectFlags,
  resolveExportProject,
  writeProjectFlags,
  type ExportProject,
  type GpfFlagState,
} from '../src/export-projects.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');
/** The shipped project file, with every field a real `.gpf` carries. */
const CLEAN_GPF = join(SAMPLES, 'graph', 'project', 'clean.gpf');

/** A minimal export project directory, optionally carrying a `.gpf`. */
function makeProject(root: string, key: string, gpf?: string): ExportProject {
  const dir = join(root, key);
  mkdirSync(join(dir, 'csv'), { recursive: true });
  writeFileSync(
    join(dir, 'csv', 'Height.csv'),
    '#Project Name:          clean\r\ntimestamp (GPS week sec),Height\r\n2442  463097.350,1.000000\r\n',
    'utf8',
  );
  if (gpf !== undefined) writeFileSync(join(dir, `${key}.gpf`), gpf, 'utf8');
  const { project } = resolveExportProject(root, key);
  assert.ok(project, `${key} 应当被认成工程`);
  return project;
}

const flagState = (count: number, open = true): GpfFlagState => ({
  allFlags: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    timeCaptured: 1477384697350 + index * 1000,
    timeBase: 'gps',
    description: `flag ${index + 1}`,
    color: '#F95B61',
    latitude: 45.1 + index,
    longitude: -75.2 - index,
    height: 80 + index,
    state: 'activeFlag',
  })),
  isFlagsPanelOpen: open,
});

/** `{...}` with the flags block removed, serialised exactly as the file was. */
function withoutFlags(text: string): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.FlagsInitialState;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^\{\r?\n([ \t]+)"/.exec(body)?.[1] ?? '  ';
  let out = JSON.stringify(parsed, null, indent);
  if (newline === '\r\n') out = out.replace(/\n/g, '\r\n');
  return bom + out + (/\r?\n$/.test(body) ? newline : '');
}

/* ---------------- 1. which file owns the flags ---------------- */

test('projectGpfPath：先 <key>.gpf，再 <name>.gpf，最后目录里唯一的 .gpf', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-path-'));
  try {
    const named = makeProject(root, 'clean', '{}');
    assert.equal(projectGpfPath(named), join(named.directory, 'clean.gpf'));

    // 只有别的名字：目录里唯一一个 `.gpf` 就是它的。
    const other = makeProject(join(root, 'only'), 'b1', '{}');
    assert.equal(projectGpfPath(other), join(other.directory, 'b1.gpf'));

    // 目录名和工程名都和文件名不同时，唯一 `.gpf` 仍然能被认出来。
    const mismatch = makeProject(join(root, 'mis'), 'proj');
    writeFileSync(join(mismatch.directory, 'saved.gpf'), '{}');
    const { project: renamed } = resolveExportProject(join(root, 'mis'), 'proj');
    assert.equal(projectGpfPath(renamed!), join(mismatch.directory, 'saved.gpf'));

    // 多个互不相关的 `.gpf`：不猜。
    const many = makeProject(join(root, 'many'), 'dup');
    writeFileSync(join(many.directory, 'a.gpf'), '{}');
    writeFileSync(join(many.directory, 'b.gpf'), '{}');
    assert.equal(projectGpfPath(many), null);

    // 没有 `.gpf` 的工程就是没有 —— 调用方据此回退 localStorage。
    const bare = makeProject(join(root, 'bare'), 'bare');
    assert.equal(projectGpfPath(bare), null);
    assert.equal(readProjectFlags(bare), null);
    assert.deepEqual(writeProjectFlags(bare, flagState(1)), { ok: false, reason: 'no-gpf' });
    assert.deepEqual(readdirSync(bare.directory).sort(), ['csv'], '不会凭空造一个 .gpf');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- 2. the real clean.gpf round trip ---------------- */

test('工程名取自 CSV 注释：带路径的名字不能把 .gpf 写出工程目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-escape-'));
  try {
    const dir = join(root, 'escape');
    mkdirSync(join(dir, 'csv'), { recursive: true });
    writeFileSync(
      join(dir, 'csv', 'Height.csv'),
      '#Project Name:          ..\\..\\evil\r\ntimestamp (GPS week sec),Height\r\n2442  463097.350,1.000000\r\n',
      'utf8',
    );
    const { project } = resolveExportProject(root, 'escape');
    assert.ok(project);
    assert.equal(project.name, '..\\..\\evil', '工程名就是 CSV 里那一行，不做净化（只影响显示）');

    assert.equal(projectGpfPath(project), null, '带分隔符/.. 的名字不参与拼路径');
    assert.equal(writeProjectFlags(project, flagState(1)).ok, false);
    assert.equal(existsSync(join(root, 'evil.gpf')), false, '没有在工程外造文件');
    assert.equal(existsSync(join(dirname(root), 'evil.gpf')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('复制 clean.gpf：写 flags 后重新读回来，其他键逐字不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-roundtrip-'));
  try {
    const original = readFileSync(CLEAN_GPF, 'utf8');
    const project = makeProject(root, 'clean', original);
    const path = join(project.directory, 'clean.gpf');
    assert.equal(statSync(path).size, Buffer.byteLength(original, 'utf8'));

    const flags = flagState(3);
    const write = writeProjectFlags(project, flags);
    assert.equal(write.ok, true);
    assert.equal(write.path, path);

    // 文件真的变了，而且只剩新增的 FlagsInitialState。
    const merged = readFileSync(path, 'utf8');
    assert.notEqual(merged, original);
    assert.equal(withoutFlags(merged), original, '去掉 FlagsInitialState 后与原文件逐字节相同');
    assert.deepEqual(JSON.parse(merged).FlagsInitialState, {
      allFlags: flags.allFlags,
      isFlagsPanelOpen: true,
    });
    assert.ok(
      merged.lastIndexOf('"FlagsInitialState"') > merged.lastIndexOf('"checksum"'),
      '原文件没有这个键，新块追加在末尾',
    );

    // 重新打开 = 重新读一遍：flags 原样恢复。
    const read = readProjectFlags(project);
    assert.ok(read);
    assert.equal(read.path, path);
    assert.equal(read.error, undefined);
    assert.deepEqual(read.flags, { allFlags: flags.allFlags, isFlagsPanelOpen: true });

    // 再写一次同样的状态：字节不变（不会每次重排/增长）。
    const again = writeProjectFlags(project, flags);
    assert.equal(again.ok, true);
    assert.equal(readFileSync(path, 'utf8'), merged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('写 flags 不动同目录的其它文件，也不留临时文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-neighbours-'));
  try {
    const project = makeProject(root, 'clean', readFileSync(CLEAN_GPF, 'utf8'));
    const csv = join(project.directory, 'csv', 'Height.csv');
    const before = readFileSync(csv);
    const entries = readdirSync(project.directory).sort();

    assert.equal(writeProjectFlags(project, flagState(2)).ok, true);

    assert.deepEqual(readFileSync(csv), before, 'CSV 没被碰');
    assert.deepEqual(readdirSync(project.directory).sort(), entries, '目录里没有多出临时文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('文件形态随原文件：2 空格/LF/BOM/结尾换行都照原样', () => {
  const base = readFileSync(CLEAN_GPF, 'utf8');
  const variants: Array<{ name: string; text: string; indent: string }> = [
    { name: 'LF, 无结尾换行（样本本身）', text: base, indent: '  ' },
    { name: 'LF, 有结尾换行', text: base + '\n', indent: '  ' },
    { name: 'CRLF', text: base.replace(/\n/g, '\r\n'), indent: '  ' },
    { name: 'BOM + CRLF + 结尾换行', text: '\uFEFF' + base.replace(/\n/g, '\r\n') + '\r\n', indent: '  ' },
    { name: '四空格缩进', text: JSON.stringify(JSON.parse(base), null, 4), indent: '    ' },
  ];
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-shape-'));
  try {
    variants.forEach((variant, index) => {
      const project = makeProject(join(root, `shape${index}`), 'clean', variant.text);
      const write = writeProjectFlags(project, flagState(1, false));
      assert.equal(write.ok, true, variant.name);
      const merged = readFileSync(join(project.directory, 'clean.gpf'), 'utf8');

      assert.equal(withoutFlags(merged), variant.text, `${variant.name}：其它键逐字不变`);
      if (variant.text.includes('\r\n')) assert.ok(merged.includes('\r\n'), `${variant.name}：仍用 CRLF`);
      if (variant.text.startsWith('\uFEFF')) assert.ok(merged.startsWith('\uFEFF'), `${variant.name}：BOM 保留`);
      assert.equal(/\r?\n$/.test(merged), /\r?\n$/.test(variant.text), `${variant.name}：结尾换行一致`);
      assert.ok(merged.split(/\r?\n/)[1].startsWith(`${variant.indent}"`), `${variant.name}：缩进沿用原文件`);
      const read = readProjectFlags(project);
      assert.equal(read?.flags?.allFlags.length, 1, `${variant.name}：能读回来`);
      assert.equal(read?.flags?.isFlagsPanelOpen, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- 3. user data is never destroyed ---------------- */

test('坏 JSON / 坏 FlagsInitialState：报告但不改写文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-broken-'));
  try {
    const broken = makeProject(join(root, 'broken'), 'clean', '{ not json');
    const brokenPath = join(broken.directory, 'clean.gpf');
    const read = readProjectFlags(broken);
    assert.equal(read?.flags, null);
    assert.match(String(read?.error), /不是合法的 \.gpf JSON/);
    const refused = writeProjectFlags(broken, flagState(1));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'bad-json');
    assert.equal(readFileSync(brokenPath, 'utf8'), '{ not json', '坏文件原样留着');

    // FlagsInitialState 存在但 allFlags 不是数组：读不出来；写会把这一块修好（只动这一块，
    // 文件本身能解析，所以不算"毁掉用户数据"）。
    const oddGpf = JSON.stringify({ PageRoute: '/process', FlagsInitialState: { allFlags: 'nope' } }, null, 2);
    const odd = makeProject(join(root, 'odd'), 'clean', oddGpf);
    const oddRead = readProjectFlags(odd);
    assert.equal(oddRead?.flags, null);
    assert.match(String(oddRead?.error), /allFlags/);
    assert.equal(writeProjectFlags(odd, flagState(1)).ok, true);
    assert.equal(readProjectFlags(odd)?.flags?.allFlags.length, 1);
    assert.equal(JSON.parse(readFileSync(join(odd.directory, 'clean.gpf'), 'utf8')).PageRoute, '/process');

    // 不是对象的 JSON（数组/标量）也不是 `.gpf`。
    const notObject = makeProject(join(root, 'array'), 'clean', '[]');
    assert.match(String(readProjectFlags(notObject)?.error), /不是合法的 \.gpf JSON/);

    // 传入的 state 本身不合法时拒绝，而不是写一个空列表覆盖用户的 flags。
    const healthy = makeProject(join(root, 'healthy'), 'clean', readFileSync(CLEAN_GPF, 'utf8'));
    const healthyPath = join(healthy.directory, 'clean.gpf');
    const healthyText = readFileSync(healthyPath, 'utf8');
    const invalid = writeProjectFlags(healthy, { allFlags: 'nope' } as unknown as GpfFlagState);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, 'invalid');
    assert.equal(readFileSync(healthyPath, 'utf8'), healthyText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- 4. two projects, one store shape ---------------- */

test('两个工程各自的 .gpf 互不影响', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-gpf-two-'));
  try {
    const clean = makeProject(join(root, 'export'), 'csv', readFileSync(CLEAN_GPF, 'utf8'));
    const b1 = makeProject(join(root, 'export'), 'b1', readFileSync(CLEAN_GPF, 'utf8'));
    assert.notEqual(clean.directory, b1.directory);

    const cleanFlags = flagState(2, true);
    const b1Flags = flagState(4, false);
    assert.equal(writeProjectFlags(clean, cleanFlags).ok, true);
    assert.equal(writeProjectFlags(b1, b1Flags).ok, true);

    assert.deepEqual(readProjectFlags(clean)?.flags, { allFlags: cleanFlags.allFlags, isFlagsPanelOpen: true });
    assert.deepEqual(readProjectFlags(b1)?.flags, { allFlags: b1Flags.allFlags, isFlagsPanelOpen: false });

    // 清空 clean 不影响 b1。
    assert.equal(writeProjectFlags(clean, { allFlags: [], isFlagsPanelOpen: false }).ok, true);
    assert.deepEqual(readProjectFlags(clean)?.flags, { allFlags: [], isFlagsPanelOpen: false });
    assert.equal(readProjectFlags(b1)?.flags?.allFlags.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- 5. the merge itself ---------------- */

test('mergeGpfFlags：非对象返回 null，已有键保持原位，新键追加在末尾', () => {
  const withExisting = JSON.stringify({ PageRoute: '/process', FlagsInitialState: { allFlags: [], isFlagsPanelOpen: false }, TotalLogInstances: 119 }, null, 2);
  const merged = mergeGpfFlags(withExisting, flagState(1));
  assert.ok(merged);
  assert.deepEqual(Object.keys(JSON.parse(merged!)), ['PageRoute', 'FlagsInitialState', 'TotalLogInstances'], '已有键不被挪位置');
  assert.equal(JSON.parse(merged!).FlagsInitialState.allFlags.length, 1);

  const fresh = mergeGpfFlags(withExisting, flagState(1))!;
  assert.ok(fresh.includes('"FlagsInitialState"'));

  assert.equal(mergeGpfFlags('not json', flagState(1)), null);
  assert.equal(mergeGpfFlags('[]', flagState(1)), null);
  assert.equal(mergeGpfFlags('42', flagState(1)), null);
  assert.equal(mergeGpfFlags('', flagState(1)), null);
});

test('一次写入只增一个顶层键，checksum 等字段一个字节都不变', () => {
  const original = readFileSync(CLEAN_GPF, 'utf8');
  const merged = mergeGpfFlags(original, flagState(1))!;
  // 原来的每一行都还在；唯一允许的变化是"原来最后一个键"补一个逗号（JSON 语法，不是内容）。
  const after = new Set(merged.split('\n'));
  const missing = original.split('\n').filter((line) => !after.has(line) && !after.has(`${line},`));
  assert.deepEqual(missing, [], '原来的每一行都还在');

  const checksum = /^ {2}"checksum": .*$/m.exec(original)![0];
  const checksumLines = merged.split('\n').filter((line) => line.startsWith('  "checksum"'));
  assert.equal(checksumLines.length, 1);
  assert.ok(checksumLines[0].startsWith(checksum), 'checksum 的值逐字不变（只多了一个语法逗号）');
  assert.ok(merged.indexOf(checksum) < merged.indexOf('"FlagsInitialState"'), '新块在最后，checksum 未被顶掉');
  assert.ok(existsSync(CLEAN_GPF));
});
