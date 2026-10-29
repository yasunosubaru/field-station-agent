const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const lineStarts = [0];
for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lineStarts.push(i + 1);
function lineOf(off) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
const rows = fs.readFileSync('comp_index.tsv', 'utf8').split('\n').slice(1);
const out = ['component\tdefinition_offset\tline'];
for (const r of rows) {
  const [name, offs] = r.split('\t');
  const first = (offs || '').split(',')[0];
  out.push(`${name}\t${first || ''}\t${first ? lineOf(parseInt(first, 10)) : ''}`);
}
fs.writeFileSync(process.argv[2], out.join('\n'), 'utf8');
console.log(out.length - 1, 'rows');
