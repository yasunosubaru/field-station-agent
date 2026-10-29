const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const min = parseInt(process.argv[3] || '5', 10);
const out = [];
let cur = '';
let start = 0;
for (let i = 0; i < buf.length; i++) {
  const b = buf[i];
  if (b >= 32 && b < 127) {
    if (!cur) start = i;
    cur += String.fromCharCode(b);
  } else {
    if (cur.length >= min) out.push(`${start}\t${cur}`);
    cur = '';
  }
}
if (cur.length >= min) out.push(`${start}\t${cur}`);
fs.writeFileSync(process.argv[4] || 'strings.txt', out.join('\n'), 'utf8');
console.log('strings', out.length);
