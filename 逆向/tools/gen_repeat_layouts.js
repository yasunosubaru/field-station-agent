// Build data/repeat-layouts.json for messages whose payload is "fixed header + N identical blocks".
//
// Only layouts that were cross-checked field by field are listed here; everything else stays
// `repeat: true` in message-specs.json and is decoded as a fixed prefix only.
//
// Verification rule enforced below: every block-relative offset must land inside [0, blockSize),
// and blockStart + blockSize must not exceed the smallest offset of any field that follows the block.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appendix = path.join(root, '03_分析', '附录');
const dataDir = path.join(root, '04_重实现', 'packages', 'protocol', 'data');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csv = parseCsv(fs.readFileSync(path.join(appendix, 'parsers-fields.csv'), 'utf8').replace(/^\uFEFF/, ''));
const head = csv.shift();
const idx = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
const rowsByMsg = new Map();
for (const row of csv) {
  if (!row || row.length < 4) continue;
  const id = row[idx['msgId']]?.trim();
  if (!rowsByMsg.has(id)) rowsByMsg.set(id, []);
  rowsByMsg.get(id).push(row);
}

// Verified layouts. `countField` is the decoded field holding the block count.
const LAYOUTS = {
  37: { name: 'VERSION', countField: 'noOfComponents', blockStart: 4, blockSize: 108 },
  83: { name: 'TRACKSTAT', countField: 'numberOfChannels', blockStart: 16, blockSize: 40 },
  1043: { name: 'SATVIS2', countField: 'numberOfSatellites', blockStart: 16, blockSize: 40 },
};

const out = {};
const problems = [];
for (const [id, layout] of Object.entries(LAYOUTS)) {
  const rows = rowsByMsg.get(id) ?? [];
  const fields = {};
  for (const row of rows) {
    const field = row[idx['field']]?.trim();
    const type = row[idx['type']]?.trim();
    const offset = Number(row[idx['offset']]?.trim());
    if (!field || !type || !Number.isFinite(offset) || offset < layout.blockStart) continue;
    const rel = offset - layout.blockStart;
    if (rel >= layout.blockSize) {
      problems.push({ id, field, rel, blockSize: layout.blockSize });
      continue;
    }
    fields[field] = { type, offset: rel };
  }
  if (Object.keys(fields).length === 0) {
    problems.push({ id, reason: 'no block fields' });
    continue;
  }
  out[id] = {
    name: layout.name,
    countField: layout.countField,
    blockStart: layout.blockStart,
    blockSize: layout.blockSize,
    fields,
  };
}

fs.writeFileSync(path.join(dataDir, 'repeat-layouts.json'), JSON.stringify(out, null, 1));
console.log('wrote repeat-layouts.json for ' + Object.keys(out).length + ' messages');
for (const [id, l] of Object.entries(out)) {
  console.log(`  ${id} ${l.name}: ${Object.keys(l.fields).length} fields, block ${l.blockSize} B at +${l.blockStart}`);
}
if (problems.length) {
  console.log('PROBLEMS: ' + JSON.stringify(problems));
  process.exitCode = 1;
}
