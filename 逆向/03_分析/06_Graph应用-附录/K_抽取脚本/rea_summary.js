const fs = require('fs');
const p = process.argv[2];
const t = fs.readFileSync(p, 'utf8');
const j = JSON.parse(t);
function summarize(o, depth = 0, prefix = '') {
  const out = [];
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) {
      let desc = '';
      if (Array.isArray(v)) desc = `array[${v.length}]`;
      else if (v && typeof v === 'object') desc = `object{${Object.keys(v).length}}`;
      else desc = JSON.stringify(v);
      if (desc.length > 120) desc = desc.slice(0, 120) + '…';
      out.push(`${'  '.repeat(depth)}${prefix}${k}: ${desc}`);
      if (depth < 2 && v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 40) {
        out.push(...summarize(v, depth + 1));
      }
    }
  }
  return out;
}
console.log(summarize(j).join('\n'));
