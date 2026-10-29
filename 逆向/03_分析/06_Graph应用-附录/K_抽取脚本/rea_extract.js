const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const g = j.normalized_result.graph;
const kinds = {};
for (const n of g.nodes) kinds[n.kind || n.type || 'unknown'] = (kinds[n.kind || n.type || 'unknown'] || 0) + 1;
const edgeKinds = {};
for (const e of g.edges) edgeKinds[e.kind || e.type || 'unknown'] = (edgeKinds[e.kind || e.type || 'unknown'] || 0) + 1;
const out = {
  evidence_id: j.evidence_id,
  subject: j.subject,
  statistics: j.normalized_result.statistics,
  summary: j.normalized_result.summary,
  graph_coverage: g.coverage,
  graph_limitations: g.limitations,
  node_kinds: kinds,
  edge_kinds: edgeKinds,
  semantic_coverage: j.normalized_result.semantic_graph.coverage,
  semantic_limitations: j.normalized_result.semantic_graph.limitations,
  sample_nodes: g.nodes.slice(0, 12)
};
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1), 'utf8');
console.log(JSON.stringify({ statistics: out.statistics, summary: out.summary, node_kinds: kinds, edge_kinds: edgeKinds }, null, 1));
