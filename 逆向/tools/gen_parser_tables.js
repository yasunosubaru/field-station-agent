// Extract every field-spec table (`const xxxJSON = { field: [type, offset], ... }`) out of
// 01_解包/app/model/logparsers.js so the reimplementation can decode logs from data instead of code.
//
// Output: 04_重实现/packages/protocol/data/parser-tables.json
//   { typeConstants: {...}, tables: { tableName: { field: [type, offset] } }, duplicates: [...] }
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, '01_解包', 'app', 'model', 'logparsers.js'), 'utf8');
const out = path.join(root, '04_重实现', 'packages', 'protocol', 'data', 'parser-tables.json');

// 1. type name constants, e.g. const ucharString = "UCHAR";
const typeConstants = {};
for (const m of src.matchAll(/const\s+(\w+)\s*=\s*"([A-Za-z_0-9]+)";/g)) typeConstants[m[1]] = m[2];

// 2. every `const NAME = {` block, brace-matched
const tables = {};
const duplicates = [];
let count = 0;
const re = /const\s+(\w+)\s*=\s*\{/g;
let m;
while ((m = re.exec(src))) {
  const name = m[1];
  const open = src.indexOf('{', m.index);
  let depth = 0, i = open, inS = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inS) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const text = src.slice(open, i);
  // only keep blocks that look like field specs: at least one `: [TYPE, number]`
  if (!/:\s*\[\s*\w+\s*,\s*\d+\s*\]/.test(text)) continue;
  const sandbox = { console };
  vm.createContext(sandbox);
  Object.assign(sandbox, typeConstants);
  let value;
  try {
    vm.runInContext('__out = ' + text, sandbox, { timeout: 5000 });
    value = sandbox.__out;
  } catch (e) {
    duplicates.push({ name, error: e.message });
    continue;
  }
  // normalise: keep only [type, offset] pairs
  const spec = {};
  for (const [field, def] of Object.entries(value)) {
    if (!Array.isArray(def) || typeof def[0] !== 'string' || typeof def[1] !== 'number') {
      duplicates.push({ name, field, reason: 'non-spec entry' });
      continue;
    }
    spec[field] = [def[0], def[1]];
  }
  if (Object.keys(spec).length === 0) continue;
  if (tables[name]) {
    duplicates.push({ name, reason: 'redeclared' });
  }
  tables[name] = spec;
  count++;
}

fs.writeFileSync(out, JSON.stringify({ typeConstants, tables, duplicates }, null, 0));
console.log('tables: ' + Object.keys(tables).length + '  bytes: ' + fs.statSync(out).size);
console.log('type constants: ' + Object.keys(typeConstants).length);
if (duplicates.length) console.log('skipped/notes: ' + JSON.stringify(duplicates.slice(0, 10)));
