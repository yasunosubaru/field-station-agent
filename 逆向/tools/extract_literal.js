// Extract a top-level object/array literal assigned to `name` from a JS source file.
// usage: node extract_literal.js <file> <name> [outfile]
const fs = require('fs');
const [file, name, out] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');

function findAssignment(n) {
  // match: const|let|var|this. NAME =  or  NAME:  or NAME =
  const patterns = [
    new RegExp('(?:const|let|var|this\\.)\\s*' + n + '\\s*=\\s*', 'g'),
    new RegExp('\\b' + n + '\\s*=\\s*', 'g'),
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (m) return m.index + m[0].length;
  }
  return -1;
}
const start = findAssignment(name);
if (start < 0) { console.error('not found: ' + name); process.exit(1); }
const open = src[start];
if (open !== '{' && open !== '[') { console.error('not a literal at ' + start + ': ' + open); process.exit(1); }
const close = open === '{' ? '}' : ']';
let depth = 0, i = start, inS = null, esc = false;
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
const text = src.slice(start, i);
let value;
try { value = eval('(' + text + ')'); }
catch (e) { console.error('eval failed: ' + e.message); process.exit(2); }
const json = JSON.stringify(value, null, 1);
if (out) fs.writeFileSync(out, json);
console.log('extracted ' + name + ': ' + text.length + ' chars, keys=' + (Array.isArray(value) ? value.length : Object.keys(value).length));
