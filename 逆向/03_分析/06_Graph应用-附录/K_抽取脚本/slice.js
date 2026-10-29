const fs = require('fs');
const s = fs.readFileSync(process.env.GRAPHSRC, 'utf8');
const a = parseInt(process.argv[2], 10), b = parseInt(process.argv[3], 10);
process.stdout.write(s.slice(a, b));
