const fs = require('fs');
const p = process.argv[2];
const t = fs.readFileSync(p, 'utf8');
const rows = t.split('\n').filter(l => l.startsWith('| `') || l.startsWith('| —'));
console.log('table rows', rows.length);
