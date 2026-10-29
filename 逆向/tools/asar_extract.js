// Extract an ASAR archive (optionally skipping node_modules) using its header.
// usage: node asar_extract.js <asar> <destDir> [--skip-node-modules] [--skip <regex>]
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dest = process.argv[3];
const skipNM = process.argv.includes('--skip-node-modules');
const skipIdx = process.argv.indexOf('--skip');
const skipRe = skipIdx > -1 ? new RegExp(process.argv[skipIdx + 1]) : null;

const fd = fs.openSync(src, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = 8 + headerPickleSize;
const unpackedRoot = src + '.unpacked';

let n = 0, bytes = 0, skipped = 0;
const entries = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p);
    else entries.push({ p, entry });
  }
})(header, '');

for (const { p, entry } of entries) {
  if (skipNM && (p === 'node_modules' || p.startsWith('node_modules/'))) { skipped++; continue; }
  if (skipRe && skipRe.test(p)) { skipped++; continue; }
  const out = path.join(dest, p);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (entry.unpacked) {
    const from = path.join(unpackedRoot, p);
    if (fs.existsSync(from)) fs.copyFileSync(from, out);
    else console.error('MISSING UNPACKED: ' + p);
  } else if (entry.link) {
    try { fs.symlinkSync(entry.link, out); } catch { fs.writeFileSync(out + '.link.txt', entry.link); }
  } else {
    const len = entry.size || 0;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const got = fs.readSync(fd, buf, read, len - read, dataStart + Number(entry.offset) + read);
      if (!got) break;
      read += got;
    }
    fs.writeFileSync(out, buf);
  }
  n++; bytes += entry.size || 0;
}
fs.closeSync(fd);
console.log(`extracted ${n} files, ${bytes} bytes, skipped ${skipped}`);
