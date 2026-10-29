const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const re = /window\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
const map = new Map();
let m;
while ((m = re.exec(s)) !== null) {
  const k = m[1] + '.' + m[2];
  if (!map.has(k)) map.set(k, { n: 0, offs: [] });
  const e = map.get(k); e.n++; if (e.offs.length < 3) e.offs.push(m.index);
}
const rows = [...map.entries()].sort((a, b) => b[1].n - a[1].n);
let out = 'count\twindow.NS.method\tfirst_offsets\n';
for (const [k, v] of rows) out += `${v.n}\t${k}\t${v.offs.join(',')}\n`;
fs.writeFileSync(process.argv[2] || 'window_api.txt', out, 'utf8');
console.log('distinct', rows.length);
console.log(out.split('\n').slice(0, 80).join('\n'));
