const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
// build line start index
const lineStarts = [0];
for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lineStarts.push(i + 1);
function lineOf(off) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
const offs = JSON.parse(process.argv[2]);
const out = [];
for (const o of offs) out.push(`@${o}\tline ${lineOf(o)}`);
console.log(out.join('\n'));
// stats
const counts = {};
for (const o of offs) { const l = lineOf(o); counts[l] = (counts[l] || 0) + 1; }
console.log('lines used', Object.keys(counts).sort((a,b)=>a-b).join(','));
console.log('total lines', lineStarts.length);
