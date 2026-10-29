const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const g = j.normalized_result.graph;
const want = process.argv[3].split(',');
for (const n of g.nodes) {
  const k = n.kind || n.type;
  if (want.includes(k)) console.log(JSON.stringify(n));
}
