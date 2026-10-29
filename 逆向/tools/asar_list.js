// Minimal ASAR header reader: prints the file tree with sizes.
const fs = require('fs');
const path = process.argv[2];
const fd = fs.openSync(path, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const u1 = head.readUInt32LE(0);   // 4
const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = 8 + headerPickleSize;

let totalFiles = 0, totalBytes = 0;
const byExt = new Map();
const rows = [];

function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) {
      walk(entry, p);
    } else {
      totalFiles++;
      const size = entry.size || 0;
      totalBytes += size;
      const ext = (name.match(/\.[^.]+$/) || ['(none)'])[0].toLowerCase();
      byExt.set(ext, (byExt.get(ext) || 0) + size);
      rows.push({ p, size, unpacked: !!entry.unpacked, offset: entry.offset });
    }
  }
}
walk(header, '');
fs.closeSync(fd);

const out = process.argv[3];
fs.writeFileSync(out + '.tsv', rows.map(r => `${r.size}\t${r.unpacked ? 'U' : 'P'}\t${r.p}`).join('\n'));
rows.sort((a, b) => b.size - a.size);
console.log('dataStart=' + dataStart + ' headerPickleSize=' + headerPickleSize);
console.log('files=' + totalFiles + ' bytes=' + totalBytes);
console.log('--- top 40 largest ---');
for (const r of rows.slice(0, 40)) console.log(String(r.size).padStart(10) + '  ' + (r.unpacked ? 'U ' : 'P ') + r.p);
console.log('--- bytes by extension ---');
const extRows = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [e, s] of extRows) console.log(String(s).padStart(12) + '  ' + e);
console.log('--- top-level ---');
console.log(Object.keys(header.files).join('\n'));
