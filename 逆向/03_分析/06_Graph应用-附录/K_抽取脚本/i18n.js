const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
function findObj(startPat) {
  const i = s.indexOf(startPat);
  if (i < 0) return null;
  let j = i + startPat.length;
  // skip to first {
  while (s[j] !== '{') j++;
  let depth = 0, q = null, esc = false;
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start: j, end: k, text: s.slice(j, k + 1) }; }
  }
  return null;
}
const out = {};
for (const [name, pat] of [['EN', 'translationEN='], ['FR', 'translationFR=']]) {
  const o = findObj(pat);
  out[name] = o ? { start: o.start, end: o.end, len: o.text.length, text: o.text } : null;
  console.log(name, o ? `${o.start}..${o.end} len=${o.text.length}` : 'NOT FOUND');
}
fs.mkdirSync('i18n', { recursive: true });
for (const k of Object.keys(out)) {
  if (!out[k]) continue;
  fs.writeFileSync(`i18n/${k}.json`, out[k].text, 'utf8');
  // flatten keys
  const parsed = JSON.parse(out[k].text);
  const flat = [];
  (function walk(o, p) {
    for (const [kk, vv] of Object.entries(o)) {
      if (vv && typeof vv === 'object') walk(vv, p ? p + '.' + kk : kk);
      else flat.push(`${p ? p + '.' : ''}${kk}\t${JSON.stringify(vv)}`);
    }
  })(parsed, '');
  fs.writeFileSync(`i18n/${k}_flat.tsv`, 'key\tvalue\n' + flat.join('\n'), 'utf8');
  console.log(k, 'keys', flat.length);
}
