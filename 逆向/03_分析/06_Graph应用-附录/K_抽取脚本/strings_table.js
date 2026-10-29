const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const outDir = process.argv[2];
const re = /"((?:[^"\\\n]|\\.){2,300})"|'((?:[^'\\\n]|\\.){2,300})'|`((?:[^`\\$]|\\.){2,300})`/g;
const counts = new Map();
let m;
while ((m = re.exec(s)) !== null) {
  const v = m[1] ?? m[2] ?? m[3];
  counts.set(v, (counts.get(v) || 0) + 1);
}
const rows = [...counts.entries()];
console.log('distinct', rows.length);
// all table
const all = rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
fs.writeFileSync(outDir + '/H1_字符串全表.tsv',
  'count\tstring\n' + all.slice(0, 80000).map(([k, v]) => `${v}\t${JSON.stringify(k)}`).join('\n'), 'utf8');
// UI-ish
const isUi = k => {
  if (k.length < 3 || k.length > 160) return false;
  if (/^[._a-zA-Z0-9-]+$/.test(k) && k.length > 40) return false; // hashes/classes
  if (/^[A-Za-z0-9+/=]{40,}$/.test(k)) return false; // base64
  const hasSpace = /\s/.test(k);
  const hasNonAscii = /[^\x20-\x7e]/.test(k);
  const looksSentence = /^[A-Z0-9][\w\s.,:'’"()\-/%&+!?…]*$/.test(k) && hasSpace;
  return hasNonAscii || looksSentence;
};
const ui = all.filter(([k]) => isUi(k));
fs.writeFileSync(outDir + '/H2_UI文案.tsv',
  'count\tstring\n' + ui.map(([k, v]) => `${v}\t${JSON.stringify(k)}`).join('\n'), 'utf8');
console.log('ui-ish', ui.length);
