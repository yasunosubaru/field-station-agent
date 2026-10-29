const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const pats = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const res = {};
for (const [name, pat] of Object.entries(pats)) {
  const re = new RegExp(pat, 'g');
  const cnt = new Map();
  let m, offs = [];
  while ((m = re.exec(s)) !== null) {
    const key = m[1] !== undefined ? m[1] : m[0];
    cnt.set(key, (cnt.get(key) || 0) + 1);
    if (offs.length < 400) offs.push(m.index + (m[1] ? m[0].indexOf(m[1]) : 0));
    if (m[0].length === 0) re.lastIndex++;
  }
  res[name] = { distinct: cnt.size, total: offs.length, values: Object.fromEntries(cnt), offsets: offs };
}
fs.writeFileSync(process.argv[3] || 'uniq.json', JSON.stringify(res, null, 1), 'utf8');
for (const [k, v] of Object.entries(res)) {
  console.log('###', k, 'distinct=' + v.distinct, 'n=' + v.total);
  console.log(Object.keys(v.values).slice(0, 120).join(' | '));
}
