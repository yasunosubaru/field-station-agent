const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const REGION_START = 360000, REGION_END = 385000;
const region = s.slice(REGION_START, REGION_END);

// 1. collect variable assignments: ident="..." or ident=`...`
const vars = new Map();
const re = /(?:^|[,;{\s])([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
let m;
while ((m = re.exec(region)) !== null) {
  const name = m[1];
  let v = m[2];
  v = v.slice(1, -1);
  v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\t/g, '\t');
  vars.set(name, v);
}

function parseShorthand(objText) {
  // entries are either `KEY:VAR`, `KEY` (shorthand => var KEY), or `KEY:"literal"`
  const out = {};
  let depth = 0, buf = '', q = null, esc = false;
  const parts = [];
  for (let i = 1; i < objText.length - 1; i++) {
    const c = objText[i];
    if (q) { buf += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; buf += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const ci = t.indexOf(':');
    if (ci < 0) { out[t] = vars.has(t) ? vars.get(t) : '<UNRESOLVED:' + t + '>'; continue; }
    const key = t.slice(0, ci).trim().replace(/^["']|["']$/g, '');
    const val = t.slice(ci + 1).trim();
    if (val.startsWith('"') || val.startsWith('`')) out[key] = val.slice(1, -1).replace(/\\n/g, '\n');
    else out[key] = vars.has(val) ? vars.get(val) : '<UNRESOLVED:' + val + '>';
  }
  return out;
}

function extractObj(startPat) {
  const i = s.indexOf(startPat);
  if (i < 0) return null;
  let j = i + startPat.length;
  while (s[j] !== '{') j++;
  let depth = 0, q = null, esc = false;
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(j, k + 1); }
  }
  return null;
}

fs.mkdirSync('i18n', { recursive: true });
const report = [];
for (const lang of ['EN', 'FR']) {
  const objTxt = extractObj(`translation${lang}=`);
  if (!objTxt) { console.log(lang, 'not found'); continue; }
  const map = parseShorthand(objTxt);
  const keys = Object.keys(map);
  const unresolved = keys.filter(k => String(map[k]).startsWith('<UNRESOLVED'));
  report.push(`${lang}: keys=${keys.length} unresolved=${unresolved.length} ${unresolved.slice(0, 20).join(',')}`);
  const lines = ['key\tvalue'];
  for (const k of keys) lines.push(`${k}\t${JSON.stringify(map[k])}`);
  fs.writeFileSync(`i18n/${lang}_flat.tsv`, lines.join('\n'), 'utf8');
  const engLines = keys.map(k => `${k} = ${map[k]}`).join('\n');
  fs.writeFileSync(`i18n/${lang}.txt`, engLines, 'utf8');
}
fs.writeFileSync('i18n/_vars.tsv', 'var\tvalue\n' + [...vars].map(([k, v]) => `${k}\t${JSON.stringify(v)}`).join('\n'), 'utf8');
console.log(report.join('\n'));
console.log('vars', vars.size);
