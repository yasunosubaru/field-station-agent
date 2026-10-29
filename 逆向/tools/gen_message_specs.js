// Join the field-level parser catalogue (03_分析/附录/parsers-fields.csv, produced from
// logparsers.js) with the enum tables in NovatelIdConstants, and emit a self-contained per-message
// spec that the decoder can consume without any further lookups.
//
// Output: 04_重实现/packages/protocol/data/message-specs.json
//   { "<msgId>": { "name": "...", "repeat": false, "fields": { "field": { "type": "...", "offset": n, "scale": k, "enum": {...} } } } }
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appendix = path.join(root, '03_分析', '附录');
const out = path.join(root, '04_重实现', 'packages', 'protocol', 'data', 'message-specs.json');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
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

const N = JSON.parse(fs.readFileSync(path.join(appendix, 'catalog-NovatelIdConstants.json'), 'utf8'));

/** Resolve `NovatelIdConstants.a.b.c` against the dumped constants, inverting value->key where needed. */
function resolveEnum(ref) {
  if (!ref) return undefined;
  const cleaned = ref.trim().replace(/^NovatelIdConstants\./, '');
  if (!cleaned) return undefined;
  let node = N;
  for (const part of cleaned.split('.')) {
    if (node === undefined || node === null) return undefined;
    node = node[part];
  }
  if (node === undefined || node === null || typeof node !== 'object') return undefined;
  // tables are usually value -> name; the decoder wants name -> value, so invert when needed.
  const entries = Object.entries(node);
  const invert = entries.every(([k, v]) => typeof v !== 'object' && /^-?\d+$/.test(k) && typeof v === 'string');
  const map = {};
  for (const [k, v] of entries) {
    if (invert) map[v] = Number(k);
    else if (typeof v === 'number') map[k] = v;
  }
  return Object.keys(map).length ? map : undefined;
}

const specs = {};
const problems = [];
for (let r = 1; r < csv.length; r++) {
  const row = csv[r];
  if (!row || row.length < 4) continue;
  const msgId = row[idx['msgId']]?.trim();
  const msgName = row[idx['msgName']]?.trim();
  const field = row[idx['field']]?.trim();
  const type = row[idx['type']]?.trim();
  const offsetRaw = row[idx['offset']]?.trim();
  const scale = row[idx['scaleFactor']]?.trim();
  const enumTable = row[idx['enumTable']]?.trim();
  const notes = row[idx['notes']]?.trim() ?? '';
  if (!msgId || !field || !type) continue;
  const offset = Number(offsetRaw);
  if (!Number.isFinite(offset)) { problems.push({ msgId, field, offsetRaw }); continue; }

  const spec = (specs[msgId] ??= { name: msgName, repeat: false, fields: {} });
  if (notes.includes('重复块')) spec.repeat = true;
  const entry = { type, offset };
  const k = scale === '' || scale === undefined ? 1 : Number(scale);
  if (Number.isFinite(k) && k !== 1) entry.scale = k;
  const enumMap = resolveEnum(enumTable);
  if (enumMap) entry['enum'] = enumMap;
  if (notes && !notes.includes('重复块')) entry.note = notes;
  spec.fields[field] = entry;
}

fs.writeFileSync(out, JSON.stringify(specs));
const ids = Object.keys(specs);
const fieldCount = ids.reduce((n, id) => n + Object.keys(specs[id].fields).length, 0);
console.log(`message-specs.json: ${ids.length} messages, ${fieldCount} fields, ${fs.statSync(out).size} bytes`);
console.log('repeated-block messages: ' + ids.filter((id) => specs[id].repeat).length);
if (problems.length) console.log('bad offsets: ' + JSON.stringify(problems.slice(0, 5)));

// sanity: BESTPOS should be complete and scaled 1
const bestpos = specs['42'];
console.log('BESTPOS fields: ' + Object.keys(bestpos.fields).length + '; sample: ' + JSON.stringify(bestpos.fields.latitude));
