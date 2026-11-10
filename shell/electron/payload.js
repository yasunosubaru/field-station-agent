'use strict';
/**
 * payload 解压 —— 壳的唯一一件事。
 *
 * 图上原文：「只负责 payload 解压、拉起 Python 服务」。这个文件负责前半句。
 *
 * ## 输入从哪来
 *
 * `tools/build_payload.py` 是 payload.zip 的唯一生产者（`逆向/05_打包/payload.zip`）。
 * 它写进去的东西里有两样被这里用到：
 *
 *   · 每个成员的路径就是解压后的相对路径（`src/fieldstation/...`、`runtime/node.exe`）；
 *   · 根上的 `manifest.json` 记了 `payload.files` / `payload.bytes`（**不含 manifest 自己**，
 *     也不含空目录 —— `write_zip()` 在收集完文件之后才单独写 manifest）。
 *
 * 那份清单的 `sha256_tree` 只摘要「成员名 + 大小」，不是内容；所以这里不拿它当完整性
 * 证据，只用它做「这个 zip 是不是那个 zip」之外的辅助。真正的判据见下。
 *
 * ## 幂等怎么判（不要只判目录存在）
 *
 * 判定需要三方同时成立，缺一个就重解压：
 *
 *   1. `payload/.extracted` 里的 zip sha256 与当前 payload.zip 的 sha256 相同；
 *   2. `payload/manifest.json` 的 sha256 与 zip 里那份 manifest 的 sha256 相同；
 *   3. 磁盘上的**文件数**与**总字节**与 manifest 的 `payload.files` / `payload.bytes` 相同。
 *
 * 第 3 条是「不要只判目录存在」的落实：目录可能还在，文件被删了一半、被截断、
 * 被另一个版本的 payload 覆盖过。数与字节对不上就重来，代价是几十秒，收益是
 * 不会拿着半棵树去启动服务 —— 那种坏法在日志里长得像「Python 起不来」。
 *
 * zip 的 sha256 每次启动都要算（852 MB 约 1~2 秒）。这是`payload/.extracted` 的约定
 * （计划书 §壳-1 步骤 2 原话：内容为 `payload.zip` 的 sha256），不改成 mtime：
 * 复制/解压/回滚都会保留 mtime，却会换掉内容。
 *
 * ## 为什么不用第三方库
 *
 * 外壳已有的依赖只有 koffi（嵌入用）。解压是启动路径上的第一件事，多一个传递依赖
 * 就多一处供应链面，而 zip 的 store / deflate 两种方法用 `node:zlib` 十行就够。
 * 明确不支持：加密、分卷、zip64 边界（>4 GB 单文件 / >65535 成员）、除 0/8 以外的方法 ——
 * 遇到就报错，不静默写出错文件。
 *
 * ## 为什么先解到 `.partial` 再换名
 *
 * 解压中途失败（磁盘满、zip 坏、进程被杀）时，绝不能留下一个「看起来像已经解压好」
 * 的目录：那会让下一次启动的判定把它当成有效载荷。所以全部解完、校验过数与字节、
 * 写完 stamp 之后，才把旧目录删掉、把新目录换上去。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

/** 解压产物里的清单名，与 build_payload.py 的 `write_zip()` 一致。 */
const MANIFEST_NAME = 'manifest.json';
/** 幂等标记。内容是 JSON（见 `buildStamp`），不是裸哈希 —— 出问题时能直接看出差在哪。 */
const STAMP_NAME = '.extracted';
/** stamp 的版本。改了判定口径就 +1，旧 stamp 自动作废（见 `decide` 的第一条检查）。 */
const STAMP_SCHEMA = 1;

/** 认的压缩方法：0 = store，8 = deflate。其余一律报错，不猜。 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

/* ---------------------------------------------------------------------------------------------
 * zip：读中央目录
 * ------------------------------------------------------------------------------------------- */

/**
 * 读 zip 的中央目录。
 *
 * 用中央目录而不是顺序扫本地头：本地头的 `uncompressed size` 在流式写入时可能是 0，
 * 且可能带 data descriptor；中央目录是记录全的那一份。
 *
 * @returns {Promise<{members: Array<{name: string, method: number, compressedSize: number,
 *   uncompressedSize: number, crc32: number, offset: number, isDirectory: boolean}>,
 *   count: number}>}
 */
async function readCentralDirectory(zipPath) {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new PayloadError(`不是 zip（只有 ${size} 字节）：${zipPath}`);

    // EOCD 在文件尾，后面可能跟最多 64 KB 注释；从后往前找签名。
    const tailLength = Math.min(size, 22 + 0xFFFF);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new PayloadError(`找不到 EOCD（中央目录结束记录），不是 zip：${zipPath}`);

    const memberCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || memberCount === 0xFFFF) {
      throw new PayloadError('这个 zip 用了 zip64 的边界写法，本解压器不支持');
    }

    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);

    const members = [];
    let at = 0;
    for (let i = 0; i < memberCount; i++) {
      if (at + 46 > cd.length) throw new PayloadError('中央目录被截断');
      if (cd.readUInt32LE(at) !== SIG_CENTRAL) {
        throw new PayloadError(`中央目录第 ${i + 1} 条的签名不对（偏移 ${cdOffset + at}）`);
      }
      const flags = cd.readUInt16LE(at + 8);
      const method = cd.readUInt16LE(at + 10);
      const crc = cd.readUInt32LE(at + 16);
      const compressedSize = cd.readUInt32LE(at + 20);
      const uncompressedSize = cd.readUInt32LE(at + 24);
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const commentLength = cd.readUInt16LE(at + 32);
      const offset = cd.readUInt32LE(at + 42);
      const name = cd.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      members.push({
        name,
        method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        offset,
        // 加密位（bit 0）与「名字不是 UTF-8」（bit 11）都没处理；前者直接拒绝，
        // 后者仍按 UTF-8 解（build_payload.py 写的都是 UTF-8 路径）。
        encrypted: Boolean(flags & 0x0001),
        isDirectory: name.endsWith('/'),
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return { members, count: members.length };
  } finally {
    await handle.close();
  }
}

/** 读一个成员解压后的字节（只用于 manifest.json 这种小文件）。 */
async function readMember(zipPath, member) {
  if (member.encrypted) throw new PayloadError(`成员是加密的，不支持：${member.name}`);
  const header = Buffer.alloc(30);
  const handle = await fsp.open(zipPath, 'r');
  try {
    await handle.read(header, 0, 30, member.offset);
    if (header.readUInt32LE(0) !== SIG_LOCAL) {
      throw new PayloadError(`成员 ${member.name} 的本地头签名不对`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataStart = member.offset + 30 + nameLength + extraLength;
    const raw = Buffer.alloc(member.compressedSize);
    if (member.compressedSize > 0) await handle.read(raw, 0, raw.length, dataStart);
    if (member.method === METHOD_STORE) return raw;
    if (member.method === METHOD_DEFLATE) return zlib.inflateRawSync(raw);
    throw new PayloadError(`不支持的压缩方法 method=${member.method}（成员 ${member.name}）`);
  } finally {
    await handle.close();
  }
}

/* ---------------------------------------------------------------------------------------------
 * 成员名
 * ------------------------------------------------------------------------------------------- */

/**
 * 成员名 → 安全的相对路径（分隔符统一成 `/`）。
 *
 * zip 里的名字是**外部输入**：一个 `../../evil.exe` 成员在解压时会写到 payload 目录外面。
 * 拒绝而不是「清洗后接受」：会出现越界成员的 zip 本身就不该被信任，悄悄改名等于把
 * 一个坏包当成好包继续用。
 */
function safeMemberName(raw) {
  if (typeof raw !== 'string' || !raw) throw new PayloadError('成员名为空');
  if (raw.includes('\0')) throw new PayloadError(`成员名含 NUL：${JSON.stringify(raw)}`);
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/')) throw new PayloadError(`成员名是绝对路径：${raw}`);
  if (/^[A-Za-z]:/.test(name)) throw new PayloadError(`成员名带盘符：${raw}`);
  const segments = name.replace(/\/+$/, '').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PayloadError(`成员名含空段或路径穿越段：${raw}`);
    }
  }
  return segments.join('/');
}

/* ---------------------------------------------------------------------------------------------
 * 解压
 * ------------------------------------------------------------------------------------------- */

/** 边流边算 crc32 与字节数，用来确认「写下去的就是 zip 里那份」。 */
function makeVerifier(expectedCrc, expectedBytes) {
  let crc = 0;
  let bytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      crc = zlib.crc32(chunk, crc);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  transform.verify = () => {
    if (bytes !== expectedBytes) {
      throw new PayloadError(`解压后字节数不符：期望 ${expectedBytes}，实得 ${bytes}`);
    }
    if ((crc >>> 0) !== (expectedCrc >>> 0)) {
      throw new PayloadError(`解压后 crc32 不符：期望 ${expectedCrc}，实得 ${crc >>> 0}`);
    }
    return bytes;
  };
  return transform;
}

/**
 * 把 zip 全部解到 `destDir`（已存在的同名文件直接覆盖）。
 *
 * 不负责清理与换名 —— 那是 `extractPayloadIfNeeded` 的事，这样这一段可以单独测。
 *
 * **计数口径**：`files` / `bytes` 与进度里的 `done` / `total` 都**不含 `manifest.json`**，
 * 因为 `build_payload.py` 的 `payload.files` / `payload.bytes` 也不含它（清单是在收集完
 * 文件之后单独写进 zip 的）。口径必须和清单一致，否则「已解压 N/M」里的 M 与
 * 校验用的数会差 1，而这种差 1 只会表现成「每次启动都重解压」。
 *
 * @param {{zipPath: string, destDir: string,
 *          onProgress?: (p: {done: number, total: number, bytes: number, totalBytes: number,
 *                            name: string, text: string}) => void}} options
 * @returns {Promise<{files: number, bytes: number, members: number}>}
 */
async function extractZip({ zipPath, destDir, onProgress } = {}) {
  if (!zipPath) throw new PayloadError('extractZip 需要 zipPath');
  if (!destDir) throw new PayloadError('extractZip 需要 destDir');
  const { members } = await readCentralDirectory(zipPath);

  const writeMembers = members.filter((m) => !m.isDirectory);
  const total = writeMembers.filter((m) => m.name !== MANIFEST_NAME).length;
  const totalBytes = writeMembers
    .filter((m) => m.name !== MANIFEST_NAME)
    .reduce((sum, m) => sum + m.uncompressedSize, 0);
  await fsp.mkdir(destDir, { recursive: true });

  let done = 0;
  let bytes = 0;
  for (const member of writeMembers) {
    const counted = member.name !== MANIFEST_NAME;
    if (member.encrypted) throw new PayloadError(`成员是加密的，不支持：${member.name}`);
    if (member.method !== METHOD_STORE && member.method !== METHOD_DEFLATE) {
      throw new PayloadError(
        `不支持的压缩方法 method=${member.method}（成员 ${member.name}）`);
    }
    const relative = safeMemberName(member.name);
    const dest = path.join(destDir, ...relative.split('/'));
    // safeMemberName 已经挡掉了 `..`；这里再确认一次拼出来的绝对路径没跑出 destDir，
    // 因为 Windows 上还有 8.3 短名、UNC 之类不靠 `..` 也能越界的写法。
    const root = path.resolve(destDir);
    if (path.resolve(dest) !== root && !path.resolve(dest).startsWith(root + path.sep)) {
      throw new PayloadError(`成员会写到解压目录之外：${member.name}`);
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    if (member.compressedSize === 0) {
      if (member.uncompressedSize !== 0) {
        throw new PayloadError(`成员 ${member.name} 的压缩长度为 0 但应为 ${member.uncompressedSize} 字节`);
      }
      await fsp.writeFile(dest, Buffer.alloc(0));
    } else {
      const header = Buffer.alloc(30);
      const handle = await fsp.open(zipPath, 'r');
      let dataStart;
      try {
        await handle.read(header, 0, 30, member.offset);
        if (header.readUInt32LE(0) !== SIG_LOCAL) {
          throw new PayloadError(`成员 ${member.name} 的本地头签名不对`);
        }
        dataStart = member.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      } finally {
        await handle.close();
      }

      const verifier = makeVerifier(member.crc32, member.uncompressedSize);
      const source = fs.createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + member.compressedSize - 1,
      });
      const target = fs.createWriteStream(dest);
      if (member.method === METHOD_DEFLATE) {
        await pipeline(source, zlib.createInflateRaw(), verifier, target);
      } else {
        await pipeline(source, verifier, target);
      }
      verifier.verify();
    }

    if (!counted) continue;
    done += 1;
    bytes += member.uncompressedSize;
    if (onProgress) {
      onProgress({
        done, total, bytes, totalBytes, name: relative,
        text: formatProgress(done, total, bytes, totalBytes),
      });
    }
  }
  return { files: done, bytes, members: members.length };
}

/** 「已解压 N/M」+ 体积；日志与进度窗共用这一句，免得两处措辞不一致。 */
function formatProgress(done, total, bytes = 0, totalBytes = 0) {
  const head = `已解压 ${done}/${total}`;
  if (!totalBytes) return head;
  return `${head}（${formatBytes(bytes)} / ${formatBytes(totalBytes)}）`;
}

function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

/* ---------------------------------------------------------------------------------------------
 * 清单
 * ------------------------------------------------------------------------------------------- */

/**
 * 解析清单。只认 `payload.files` / `payload.bytes` 这两个数与 `items[]`。
 *
 * 缺字段就抛：宁可启动时报「这个 payload 不完整」，也不要拿着 `undefined` 去和
 * 磁盘做比较 —— `undefined !== 1234` 会让每次启动都重解压，而没人看出为什么。
 */
function parseManifest(raw) {
  let doc;
  try {
    doc = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch (error) {
    throw new PayloadError(`manifest.json 不是合法 JSON：${error.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new PayloadError('manifest.json 不是对象');
  const payload = doc.payload;
  if (!payload || typeof payload !== 'object') {
    throw new PayloadError('manifest.json 缺 payload 段');
  }
  const files = payload.files;
  const bytes = payload.bytes;
  if (!Number.isInteger(files) || files < 0) {
    throw new PayloadError(`manifest.payload.files 不是非负整数：${JSON.stringify(files)}`);
  }
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new PayloadError(`manifest.payload.bytes 不是非负整数：${JSON.stringify(bytes)}`);
  }
  return {
    schema: doc.schema,
    product: doc.product,
    version: doc.version,
    files,
    bytes,
    items: Array.isArray(doc.items) ? doc.items : [],
    sha256Tree: payload.sha256_tree || null,
  };
}

/** 从 zip 里读 manifest.json（build_payload.py 保证它在根上）。 */
async function readManifestFromZip(zipPath) {
  const { members } = await readCentralDirectory(zipPath);
  const member = members.find((m) => !m.isDirectory && m.name === MANIFEST_NAME);
  if (!member) throw new PayloadError(`payload.zip 里没有 ${MANIFEST_NAME}`);
  const raw = await readMember(zipPath, member);
  return {
    manifest: parseManifest(raw),
    digest: crypto.createHash('sha256').update(raw).digest('hex'),
    raw,
  };
}

/* ---------------------------------------------------------------------------------------------
 * 磁盘统计
 * ------------------------------------------------------------------------------------------- */

/**
 * 数一棵树：文件数、总字节，以及根上 manifest.json 的 sha256。
 *
 * **排除** manifest.json 与 stamp：build_payload.py 的 `payload.files` 是「被收集的文件数」，
 * manifest 自己是在循环之后单独写进去的，不计入。不排除就会永远对不上，
 * 然后每次启动都重解压一次 —— 这个 bug 只会表现为「启动慢」。
 */
function countTree(dir) {
  if (!dir || !fs.existsSync(dir)) return { files: 0, bytes: 0, exists: false };
  let files = 0;
  let bytes = 0;
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const stampPath = path.join(dir, STAMP_NAME);
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (current === dir && (full === manifestPath || full === stampPath)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch (error) { /* 统计时消失的文件：算不存在，判定会因此要求重解压 */ }
      }
      // 符号链接 / 设备文件不计：payload 里不该有，也不该跟着它走出目录。
    }
  };
  walk(dir);
  return {
    files,
    bytes,
    exists: true,
    manifestSha: fs.existsSync(manifestPath) ? sha256File(manifestPath) : '',
  };
}

function sha256File(file) {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

/* ---------------------------------------------------------------------------------------------
 * 幂等判定（纯函数）
 * ------------------------------------------------------------------------------------------- */

/**
 * 该不该解压。**纯函数**，没有任何 IO —— 判定口径改起来最容易出错，所以要能逐条测。
 *
 * @param {{stamp: object|null,
 *          zip: {size: number, sha256: string},
 *          manifest: {files: number, bytes: number, sha256: string},
 *          disk: {files: number, bytes: number, manifestSha: string, exists: boolean}}} input
 * @returns {{action: 'extract'|'skip', reason: string}}
 */
function decide({ stamp, zip, manifest, disk }) {
  if (!stamp) return { action: 'extract', reason: 'no-stamp' };
  if (stamp.schema !== STAMP_SCHEMA) return { action: 'extract', reason: 'stamp-schema' };
  if (!stamp.zip || stamp.zip.sha256 !== zip.sha256 || stamp.zip.size !== zip.size) {
    return { action: 'extract', reason: 'zip-changed' };
  }
  if (!disk || !disk.exists) return { action: 'extract', reason: 'disk-missing' };
  if (!stamp.manifest
    || stamp.manifest.sha256 !== manifest.sha256
    || stamp.manifest.files !== manifest.files
    || stamp.manifest.bytes !== manifest.bytes) {
    return { action: 'extract', reason: 'manifest-changed' };
  }
  if (disk.manifestSha !== manifest.sha256) return { action: 'extract', reason: 'manifest-changed' };
  if (disk.files !== manifest.files) return { action: 'extract', reason: 'disk-count' };
  if (disk.bytes !== manifest.bytes) return { action: 'extract', reason: 'disk-bytes' };
  return { action: 'skip', reason: 'ok' };
}

function buildStamp({ zip, manifest, now = new Date() }) {
  return {
    schema: STAMP_SCHEMA,
    zip: { size: zip.size, sha256: zip.sha256 },
    manifest: { files: manifest.files, bytes: manifest.bytes, sha256: manifest.sha256 },
    extractedAt: now.toISOString(),
  };
}

function readStamp(payloadDir) {
  const file = path.join(payloadDir, STAMP_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;   // 坏的 stamp 当作没有：重解压一次比带着半信半疑的判定跑下去便宜
  }
}

/* ---------------------------------------------------------------------------------------------
 * 路径
 * ------------------------------------------------------------------------------------------- */

/**
 * payload.zip 在哪。`NAS_PAYLOAD_ZIP` 优先（打包后 exe 旁边那份、或本地自己 build 的一份），
 * 否则用 `tools/build_payload.py` 的默认输出常量（同一个相对路径，见那边的 `DEFAULT_OUT`）。
 *
 * 相对路径按 `cwd` 解析成绝对路径：日志里出现 `..\..\outbound\x.zip` 这种相对写法时，
 * 看日志的人没法判断它到底指哪儿。
 */
function resolvePayloadZip({ repoRoot, env = process.env, cwd = process.cwd() } = {}) {
  if (env && env.NAS_PAYLOAD_ZIP) {
    return { path: path.resolve(cwd, env.NAS_PAYLOAD_ZIP), source: 'env' };
  }
  return {
    path: path.join(repoRoot, '逆向', '05_打包', 'payload.zip'),
    source: 'default',
  };
}

/* ---------------------------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------------------------- */

/**
 * 保证 `payloadDir` 里有一份与 `zipPath` 一致的解压树。
 *
 * 返回值里的 `status` 只有三种，调用方据此决定日志与是否继续：
 *
 *   · `absent`    没有 payload.zip（开发态常见：从没 build 过）→ 不阻塞启动
 *   · `skipped`   三方校验通过，一秒都不用等
 *   · `extracted` 真解压了，`files` / `bytes` / `reason` 说明为什么
 *
 * 抛 `PayloadError` 的场合：zip 损坏、清单缺失或与磁盘对不上、成员越界、方法不支持。
 * 这些都是「这份 payload 不能用」，不能降级成跳过 —— 跳过等于拿坏树去起服务。
 *
 * @param {{zipPath: string, payloadDir: string,
 *          onProgress?: Function, log?: (line: string) => void}} options
 */
async function extractPayloadIfNeeded({ zipPath, payloadDir, onProgress, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  if (!zipPath) throw new PayloadError('extractPayloadIfNeeded 需要 zipPath');
  if (!payloadDir) throw new PayloadError('extractPayloadIfNeeded 需要 payloadDir');

  if (!fs.existsSync(zipPath)) {
    say(`[payload] 没有 payload.zip，跳过解压：${zipPath}`);
    return { status: 'absent', zipPath, payloadDir };
  }

  const zipSize = fs.statSync(zipPath).size;
  const zipSha = sha256File(zipPath);
  const zip = { size: zipSize, sha256: zipSha };

  const fromZip = await readManifestFromZip(zipPath);
  const manifest = {
    files: fromZip.manifest.files,
    bytes: fromZip.manifest.bytes,
    sha256: fromZip.digest,
  };

  const stamp = readStamp(payloadDir);
  const disk = countTree(payloadDir);
  const decision = decide({ stamp, zip, manifest, disk });

  // 这一行是「二次启动能不能从日志看出没重复解压」的唯一依据，所以 skip 时要
  // 明写「跳过」两个字，而不是只打一个 `action=skip` —— 看日志的是人。
  say(`[payload] 判定：${decision.action}（${decision.reason}）`
    + (decision.action === 'skip' ? ' 跳过解压' : ' 需要解压')
    + ` 清单 ${manifest.files} 文件 / ${formatBytes(manifest.bytes)}`
    + ` 磁盘 ${disk.files} 文件 / ${formatBytes(disk.bytes)}`);

  if (decision.action === 'skip') {
    return {
      status: 'skipped', reason: decision.reason, zipPath, payloadDir,
      files: manifest.files, bytes: manifest.bytes,
    };
  }

  const staging = `${payloadDir}.partial`;
  await fsp.rm(staging, { recursive: true, force: true });

  say(`[payload] 开始解压：${zipPath} → ${payloadDir}`
    + `（${manifest.files} 文件，${formatBytes(manifest.bytes)}）`);
  const started = Date.now();
  let lastLogged = 0;
  const extracted = await extractZip({
    zipPath,
    destDir: staging,
    onProgress: (progress) => {
      if (onProgress) onProgress(progress);
      // 5223 个文件逐个打日志会淹掉终端；按 5% 打一次，进度仍然看得见。
      const step = Math.max(1, Math.floor(progress.total / 20));
      if (progress.done === progress.total || progress.done - lastLogged >= step) {
        lastLogged = progress.done;
        say(`[payload] ${progress.text}`);
      }
    },
  });

  // 清单校验：解出来的东西必须与清单说的一致，否则不换名、不写 stamp。
  if (extracted.files !== manifest.files) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw new PayloadError(
      `解压出的文件数与清单不符：清单 ${manifest.files}，实得 ${extracted.files}`);
  }
  if (extracted.bytes !== manifest.bytes) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw new PayloadError(
      `解压出的总字节与清单不符：清单 ${manifest.bytes}，实得 ${extracted.bytes}`);
  }
  const stagedManifest = path.join(staging, MANIFEST_NAME);
  if (!fs.existsSync(stagedManifest)) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw new PayloadError(`解压结果里没有 ${MANIFEST_NAME}`);
  }
  if (sha256File(stagedManifest) !== manifest.sha256) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw new PayloadError('解压出来的 manifest.json 与 zip 里那份不一致');
  }

  const stampDoc = buildStamp({ zip, manifest });
  await fsp.writeFile(path.join(staging, STAMP_NAME),
    `${JSON.stringify(stampDoc, null, 2)}\n`, 'utf8');

  await fsp.rm(payloadDir, { recursive: true, force: true });
  await fsp.rename(staging, payloadDir);
  // rename 之后 stamp 才跟着新树一起出现；这一步的顺序是有意的：
  // 先有树、后有 stamp，中途被杀只会在下次启动时重解压，不会把半棵树当有效。

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  say(`[payload] 解压完成：${extracted.files} 文件 / ${formatBytes(extracted.bytes)}，`
    + `耗时 ${elapsed}s`);

  return {
    status: 'extracted',
    reason: decision.reason,
    zipPath,
    payloadDir,
    files: extracted.files,
    bytes: extracted.bytes,
    elapsedMs: Date.now() - started,
  };
}

/**
 * `main.js` 用的一个入口：解析 zip 路径、定 payload 目录、按需解压。
 *
 * 目录固定为 `<userData>/payload`（计划书 §壳-1 步骤 2 原话）。
 */
async function preparePayload({
  repoRoot, userDataDir, env = process.env, cwd = process.cwd(), onProgress, log,
} = {}) {
  if (!userDataDir) throw new PayloadError('preparePayload 需要 userDataDir');
  const zip = resolvePayloadZip({ repoRoot, env, cwd });
  const payloadDir = path.join(userDataDir, 'payload');
  const result = await extractPayloadIfNeeded({
    zipPath: zip.path, payloadDir, onProgress, log,
  });
  return { ...result, zipSource: zip.source };
}

module.exports = {
  PayloadError,
  MANIFEST_NAME,
  STAMP_NAME,
  STAMP_SCHEMA,
  readCentralDirectory,
  safeMemberName,
  extractZip,
  parseManifest,
  readManifestFromZip,
  countTree,
  sha256File,
  decide,
  buildStamp,
  readStamp,
  resolvePayloadZip,
  extractPayloadIfNeeded,
  preparePayload,
  formatProgress,
  formatBytes,
};
