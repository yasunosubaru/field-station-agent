'use strict';
/**
 * `payload.js` 的测试 —— 不碰 Electron、不联网、不需要真 payload.zip。
 *
 * 运行：
 *
 *   cd shell/electron && node --test test/payload.test.js
 *
 * ## 为什么自带一个极小的 zip 写入器
 *
 * 仓库里没有 JS 的 zip 库（也**不打算**为解压引一个第三方依赖：payload.zip 是外壳每次
 * 启动都要碰的东西，多一个传递依赖就多一处供应链面）。所以测试自己用 `zlib.deflateRawSync`
 * 拼 zip：这同时把「解压器读的是不是规范里的那几个字段」钉死了 —— 用别人的库造测试数据，
 * 两边一起错的时候看不出来。
 *
 * ## 为什么每条判定都要单独一条测试
 *
 * 幂等判定是「删掉 payload 目录能自愈、篡改 zip 必须发现」的唯一防线。
 * 只判目录存在是最容易写出来、也最容易在真机上骗过自己的那种实现；
 * 这里把 stamp / 清单 / 磁盘三方各造一次不一致。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const payload = require('../payload.js');

/* =============================================================================================
 * 测试用 zip 写入器（store / deflate 两种方法）
 * =========================================================================================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name: string, text?: string, data?: Buffer, deflate?: boolean,
 *                dir?: boolean, method?: number}>} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = file.dir ? Buffer.alloc(0) : Buffer.from(file.data ?? file.text ?? '', 'utf8');
    const method = file.dir ? 0 : (file.method ?? (file.deflate ? 8 : 0));
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);   // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);    // 1980-01-01，与 build_payload.py 的固定时间戳一致
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cd, eocd]);
}

/** 一份「像 build_payload.py 产出的」最小 payload：manifest + 两个文件 + 一个目录项。 */
function samplePayload({ extra = '' } = {}) {
  const a = Buffer.from(`alpha ${extra}`.repeat(3), 'utf8');
  const b = Buffer.from('中文内容'.repeat(10), 'utf8');
  const manifest = {
    schema: 1,
    product: 'All powered-FSA',
    payload: { files: 2, bytes: a.length + b.length, sha256_tree: 'deadbeef' },
    items: [{ name: 'src/fieldstation', files: 2, bytes: a.length + b.length }],
  };
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    manifest,
    manifestRaw: raw,
    zip: makeZip([
      { name: 'src/fieldstation/', dir: true },
      { name: 'src/fieldstation/a.txt', data: a, deflate: true },
      { name: 'src/fieldstation/中文.txt', data: b },
      { name: 'manifest.json', data: raw },
    ]),
    bytes: a.length + b.length,
    files: 2,
  };
}

function tempDir(prefix = 'fsa-payload-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeZip(dir, buffer, name = 'payload.zip') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

/* =============================================================================================
 * 一、中央目录解析
 * =========================================================================================== */

test('readCentralDirectory 读出成员名、大小、目录标记', async () => {
  const dir = tempDir();
  const sample = samplePayload();
  const zipPath = writeZip(dir, sample.zip);
  const cd = await payload.readCentralDirectory(zipPath);
  const names = cd.members.map((m) => m.name);
  assert.deepEqual(names, ['src/fieldstation/', 'src/fieldstation/a.txt',
    'src/fieldstation/中文.txt', 'manifest.json']);
  assert.equal(cd.members[0].isDirectory, true);
  assert.equal(cd.members[1].isDirectory, false);
  assert.equal(cd.members[1].method, 8);
  assert.equal(cd.members[1].uncompressedSize, Buffer.byteLength('alpha '.repeat(3), 'utf8'));
  assert.equal(cd.members[2].uncompressedSize, Buffer.byteLength('中文内容'.repeat(10), 'utf8'));
});

test('不支持的方法（method=12）明确报错，不静默写出空文件', async () => {
  const dir = tempDir();
  const zipPath = writeZip(dir, makeZip([{ name: 'x.bin', data: Buffer.from('abc'), method: 12 }]));
  await assert.rejects(payload.extractZip({ zipPath, destDir: path.join(dir, 'out') }),
    (error) => error instanceof payload.PayloadError && /method|方法/.test(error.message));
});

test('截断 / 不是 zip 的文件报「找不到 EOCD」', async () => {
  const dir = tempDir();
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, Buffer.from('this is not a zip at all'));
  await assert.rejects(payload.readCentralDirectory(bad),
    (error) => error instanceof payload.PayloadError && /EOCD|中央目录/.test(error.message));
});

/* =============================================================================================
 * 二、成员名：路径穿越必须挡在写盘之前
 * =========================================================================================== */

test('safeMemberName 接受普通的相对路径', () => {
  assert.equal(payload.safeMemberName('src/fieldstation/a.py'), 'src/fieldstation/a.py');
  assert.equal(payload.safeMemberName('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(payload.safeMemberName('docs/operations/shell.md'), 'docs/operations/shell.md');
});

test('safeMemberName 拒绝 .. / 绝对路径 / 盘符', () => {
  for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/x.txt',
    '..', 'a/..', './a', 'a//b']) {
    assert.throws(() => payload.safeMemberName(bad), payload.PayloadError, `应当拒绝 ${bad}`);
  }
});

test('extractZip 遇到越界成员时不写盘', async () => {
  const dir = tempDir();
  const destDir = path.join(dir, 'out');
  const zipPath = writeZip(dir, makeZip([
    { name: '../escape.txt', text: 'should not exist' },
  ]));
  await assert.rejects(payload.extractZip({ zipPath, destDir }), payload.PayloadError);
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escape.txt')), false);
});

/* =============================================================================================
 * 三、清单
 * =========================================================================================== */

test('parseManifest 认 payload.files / payload.bytes', () => {
  const sample = samplePayload();
  const parsed = payload.parseManifest(sample.manifestRaw);
  assert.equal(parsed.files, 2);
  assert.equal(parsed.bytes, sample.bytes);
  assert.equal(parsed.items.length, 1);
});

test('parseManifest 拒绝非 JSON / 缺字段', () => {
  assert.throws(() => payload.parseManifest(Buffer.from('not json')), payload.PayloadError);
  assert.throws(() => payload.parseManifest(Buffer.from('{"schema":1}')), payload.PayloadError);
  assert.throws(() => payload.parseManifest(Buffer.from('{"payload":{"files":1}}')),
    payload.PayloadError);
});

test('readManifestFromZip 返回清单与它的 sha256', async () => {
  const dir = tempDir();
  const sample = samplePayload();
  const zipPath = writeZip(dir, sample.zip);
  const read = await payload.readManifestFromZip(zipPath);
  assert.equal(read.manifest.files, 2);
  assert.equal(read.digest, crypto.createHash('sha256').update(sample.manifestRaw).digest('hex'));
});

/* =============================================================================================
 * 四、磁盘统计
 * =========================================================================================== */

test('countTree 统计嵌套文件数与字节，排除 manifest 与 stamp', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'one.txt'), '12345');
  fs.writeFileSync(path.join(dir, 'a', 'two.txt'), '123');
  fs.writeFileSync(path.join(dir, payload.MANIFEST_NAME), '{"x":1}');
  fs.writeFileSync(path.join(dir, payload.STAMP_NAME), '{"y":1}');
  const counted = payload.countTree(dir);
  assert.equal(counted.files, 2);
  assert.equal(counted.bytes, 8);
  assert.equal(counted.exists, true);
});

test('countTree 对不存在的目录返回 exists:false', () => {
  const counted = payload.countTree(path.join(os.tmpdir(), 'fsa-does-not-exist-xyz'));
  assert.deepEqual(counted, { files: 0, bytes: 0, exists: false });
});

/* =============================================================================================
 * 五、幂等判定（这一节是壳-1 的核心）
 * =========================================================================================== */

const goodStamp = (zip, manifest, digest) => ({
  schema: payload.STAMP_SCHEMA,
  zip: { size: zip.size, sha256: zip.sha256 },
  manifest: { files: manifest.files, bytes: manifest.bytes, sha256: digest },
  extractedAt: '2026-11-09T00:00:00.000Z',
});

test('无 stamp → 解压（不能只看目录存在）', () => {
  const manifest = { files: 2, bytes: 10 };
  const decision = payload.decide({
    stamp: null,
    zip: { size: 100, sha256: 'a' },
    manifest: { ...manifest, sha256: 'm' },
    disk: { files: 2, bytes: 10, manifestSha: 'm', exists: true },
  });
  assert.equal(decision.action, 'extract');
  assert.equal(decision.reason, 'no-stamp');
});

test('zip 变了（sha256 不同）→ 重解压', () => {
  const zip = { size: 100, sha256: 'b' };
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: { ...goodStamp({ size: 100, sha256: 'a' }, manifest, 'm') },
    zip,
    manifest,
    disk: { files: 2, bytes: 10, manifestSha: 'm', exists: true },
  });
  assert.equal(decision.action, 'extract');
  assert.equal(decision.reason, 'zip-changed');
});

test('stamp schema 不认识 → 重解压（旧版本写的 stamp 不能当有效）', () => {
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: { ...goodStamp({ size: 100, sha256: 'a' }, manifest, 'm'), schema: 0 },
    zip: { size: 100, sha256: 'a' },
    manifest,
    disk: { files: 2, bytes: 10, manifestSha: 'm', exists: true },
  });
  assert.equal(decision.reason, 'stamp-schema');
});

test('磁盘上文件数不符 → 重解压', () => {
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: goodStamp({ size: 100, sha256: 'a' }, manifest, 'm'),
    zip: { size: 100, sha256: 'a' },
    manifest,
    disk: { files: 1, bytes: 10, manifestSha: 'm', exists: true },
  });
  assert.equal(decision.action, 'extract');
  assert.equal(decision.reason, 'disk-count');
});

test('磁盘上总字节不符 → 重解压', () => {
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: goodStamp({ size: 100, sha256: 'a' }, manifest, 'm'),
    zip: { size: 100, sha256: 'a' },
    manifest,
    disk: { files: 2, bytes: 9, manifestSha: 'm', exists: true },
  });
  assert.equal(decision.reason, 'disk-bytes');
});

test('磁盘上的 manifest.json 被换过 → 重解压', () => {
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: goodStamp({ size: 100, sha256: 'a' }, manifest, 'm'),
    zip: { size: 100, sha256: 'a' },
    manifest,
    disk: { files: 2, bytes: 10, manifestSha: 'other', exists: true },
  });
  assert.equal(decision.reason, 'manifest-changed');
});

test('目录整个不见了 → 重解压', () => {
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: goodStamp({ size: 100, sha256: 'a' }, manifest, 'm'),
    zip: { size: 100, sha256: 'a' },
    manifest,
    disk: { files: 0, bytes: 0, manifestSha: '', exists: false },
  });
  assert.equal(decision.reason, 'disk-missing');
});

test('三方一致 → 跳过', () => {
  const manifest = { files: 2, bytes: 10, sha256: 'm' };
  const decision = payload.decide({
    stamp: goodStamp({ size: 100, sha256: 'a' }, manifest, 'm'),
    zip: { size: 100, sha256: 'a' },
    manifest,
    disk: { files: 2, bytes: 10, manifestSha: 'm', exists: true },
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'ok');
});

/* =============================================================================================
 * 六、端到端：首次解压、二次跳过、删目录自愈、篡改 zip 重解压
 * =========================================================================================== */

test('extractPayloadIfNeeded：首次解压，进度到 M/M，文件真的落盘', async () => {
  const dir = tempDir();
  const sample = samplePayload();
  const zipPath = writeZip(dir, sample.zip);
  const payloadDir = path.join(dir, 'payload');
  const seen = [];
  const result = await payload.extractPayloadIfNeeded({
    zipPath,
    payloadDir,
    onProgress: (progress) => seen.push(progress),
  });

  assert.equal(result.status, 'extracted');
  assert.equal(result.files, sample.files);
  assert.equal(result.bytes, sample.bytes);
  assert.equal(fs.readFileSync(path.join(payloadDir, 'src/fieldstation/a.txt'), 'utf8'),
    'alpha '.repeat(3));
  assert.ok(fs.existsSync(path.join(payloadDir, 'src/fieldstation/中文.txt')));
  assert.ok(fs.existsSync(path.join(payloadDir, payload.STAMP_NAME)));

  assert.ok(seen.length >= 1);
  const first = seen[0];
  const last = seen[seen.length - 1];
  assert.equal(last.done, sample.files);
  assert.equal(last.total, sample.files);
  assert.ok(first.done <= last.done);
  for (const progress of seen) assert.ok(progress.done <= progress.total);
});

test('extractPayloadIfNeeded：二次启动跳过，且不重写已解压文件', async () => {
  const dir = tempDir();
  const sample = samplePayload();
  const zipPath = writeZip(dir, sample.zip);
  const payloadDir = path.join(dir, 'payload');
  await payload.extractPayloadIfNeeded({ zipPath, payloadDir });
  const marker = fs.statSync(path.join(payloadDir, 'src/fieldstation/a.txt')).mtimeMs;

  const logs = [];
  const second = await payload.extractPayloadIfNeeded({
    zipPath,
    payloadDir,
    log: (line) => logs.push(line),
  });
  assert.equal(second.status, 'skipped');
  assert.equal(fs.statSync(path.join(payloadDir, 'src/fieldstation/a.txt')).mtimeMs, marker);
  assert.ok(logs.some((line) => /跳过/.test(line)), `日志里要能看出跳过：${logs.join(' | ')}`);
});

test('extractPayloadIfNeeded：删掉 payload 目录后自动重解压', async () => {
  const dir = tempDir();
  const sample = samplePayload();
  const zipPath = writeZip(dir, sample.zip);
  const payloadDir = path.join(dir, 'payload');
  await payload.extractPayloadIfNeeded({ zipPath, payloadDir });
  fs.rmSync(payloadDir, { recursive: true, force: true });
  const again = await payload.extractPayloadIfNeeded({ zipPath, payloadDir });
  assert.equal(again.status, 'extracted');
  assert.ok(fs.existsSync(path.join(payloadDir, 'src/fieldstation/a.txt')));
});

test('extractPayloadIfNeeded：篡改 zip 后重新解压（stamp 里的 sha256 不再匹配）', async () => {
  const dir = tempDir();
  const sample = samplePayload();
  const zipPath = writeZip(dir, sample.zip);
  const payloadDir = path.join(dir, 'payload');
  await payload.extractPayloadIfNeeded({ zipPath, payloadDir });

  const tampered = samplePayload({ extra: 'TAMPERED' });
  fs.writeFileSync(zipPath, tampered.zip);
  const again = await payload.extractPayloadIfNeeded({ zipPath, payloadDir });
  assert.equal(again.status, 'extracted');
  assert.equal(fs.readFileSync(path.join(payloadDir, 'src/fieldstation/a.txt'), 'utf8'),
    'alpha TAMPERED'.repeat(3));
});

test('extractPayloadIfNeeded：zip 不存在时返回 absent，不抛', async () => {
  const dir = tempDir();
  const result = await payload.extractPayloadIfNeeded({
    zipPath: path.join(dir, 'nope.zip'),
    payloadDir: path.join(dir, 'payload'),
    log: () => {},
  });
  assert.equal(result.status, 'absent');
});

test('resolvePayloadZip：环境变量优先，其次 逆向/05_打包/payload.zip', () => {
  const repoRoot = path.join(os.tmpdir(), 'fsa-repo');
  const viaEnv = payload.resolvePayloadZip({
    repoRoot,
    cwd: 'H:/work',
    env: { NAS_PAYLOAD_ZIP: 'D:/x/payload.zip' },
  });
  assert.equal(viaEnv.path, path.resolve('H:/work', 'D:/x/payload.zip'));
  assert.equal(viaEnv.source, 'env');

  const fallback = payload.resolvePayloadZip({ repoRoot, env: {} });
  assert.equal(fallback.path, path.join(repoRoot, '逆向', '05_打包', 'payload.zip'));
  assert.equal(fallback.source, 'default');
});

test('resolvePayloadZip：相对路径按 cwd 变成绝对路径（日志里能看懂是哪份 zip）', () => {
  const resolved = payload.resolvePayloadZip({
    repoRoot: 'H:/repo',
    cwd: 'H:/repo/shell/electron',
    env: { NAS_PAYLOAD_ZIP: '../../outbound/smoke/payload.zip' },
  });
  assert.equal(resolved.path, path.resolve('H:/repo/shell/electron', '../../outbound/smoke/payload.zip'));
  assert.ok(path.isAbsolute(resolved.path));
});

test('formatProgress 的文案是「已解压 N/M」', () => {
  assert.match(payload.formatProgress(3, 10), /已解压 3\/10/);
  assert.match(payload.formatProgress(10, 10), /已解压 10\/10/);
});
