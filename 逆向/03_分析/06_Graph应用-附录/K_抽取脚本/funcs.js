const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const re = /function ([A-Z][A-Za-z0-9_$]{2,40})\(/g;
const rows = [];
let m;
while ((m = re.exec(s)) !== null) rows.push([m.index, m[1]]);
const seen = new Set();
const out = ['offset\tfunction\tnearest_preceding_var_context'];
for (const [off, name] of rows) {
  const ctx = s.slice(Math.max(0, off - 90), off).replace(/[\r\n]+/g, ' ');
  out.push(`${off}\t${name}\t${ctx}`);
}
fs.writeFileSync(process.argv[2] || 'funcs.tsv', out.join('\n'), 'utf8');
console.log('functions', rows.length, 'distinct', new Set(rows.map(r => r[1])).size);
