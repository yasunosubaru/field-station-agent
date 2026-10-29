// context grep: node g.js <pattern> <before> <after> <limit> [outfile]
const fs = require('fs');
const p = process.env.GRAPHSRC;
const s = fs.readFileSync(p, 'utf8');
const pat = process.argv[2];
const before = parseInt(process.argv[3] || '60', 10);
const after = parseInt(process.argv[4] || '120', 10);
const limit = parseInt(process.argv[5] || '40', 10);
const outfile = process.argv[6];
const re = new RegExp(pat, 'gi');
let m, out = [], n = 0;
while ((m = re.exec(s)) !== null) {
  n++;
  const st = Math.max(0, m.index - before), en = Math.min(s.length, m.index + m[0].length + after);
  out.push(`@${m.index}\t${JSON.stringify(s.slice(st, en))}`);
  if (m[0].length === 0) re.lastIndex++;
  if (out.length >= limit) break;
}
const txt = `pattern=${pat} total_matched_shown=${out.length}\n` + out.join('\n');
if (outfile) fs.writeFileSync(outfile, txt, 'utf8');
else console.log(txt);
console.log(`#occurrences_counted=${n} shown=${out.length}`);
