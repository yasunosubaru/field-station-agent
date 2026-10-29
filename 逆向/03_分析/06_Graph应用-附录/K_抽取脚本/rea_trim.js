const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const g = j.normalized_result.graph;
const kinds = {}, edgeKinds = {};
for (const n of g.nodes) { const k = n.kind || n.type || 'unknown'; kinds[k] = (kinds[k] || 0) + 1; }
for (const e of g.edges) { const k = e.kind || e.type || 'unknown'; edgeKinds[k] = (edgeKinds[k] || 0) + 1; }
const interesting = [];
for (const n of g.nodes) {
  const k = n.kind;
  if (!['storage', 'native-addon', 'worker'].includes(k)) continue;
  const props = (n.observations && n.observations[0] && n.observations[0].properties) || {};
  interesting.push({
    kind: k,
    label: (n.observations && n.observations[0] && n.observations[0].label) || null,
    identity: n.identity && (n.identity.key || n.identity.sha256),
    namespace: n.identity && n.identity.namespace,
    props: props
  });
}
const out = {
  _note: "REA 6.5.0 analyze-javascript-application 的裁剪摘要；原始输出 175 MB 未入库（临时目录），可重跑：rea analyze-javascript-application \"01_解包/Graph\" --artifact-format directory --source-path out/renderer/assets/index-B86bHcCD.js --format json",
  evidence_id: j.evidence_id,
  subject: { name: j.subject.name, format: j.subject.format, sha256: j.subject.digest && j.subject.digest.sha256 },
  statistics: j.normalized_result.statistics,
  summary: j.normalized_result.summary,
  node_kinds: kinds,
  edge_kinds: edgeKinds,
  storage_native_worker_nodes: interesting,
  confirmations: [
    "text_bytes_read = 16 252 082，与 index-B86bHcCD.js 的字节数一致 → 产物未被改写",
    "ipc.literal_channels / renderer_transmissions / renderer_listeners 全为 0 → 渲染进程无 IPC 直连（本报告 R5）",
    "native-addon 节点 = win/linux 两份 graph-node-wrapper.node（带 sha256）",
    "storage 节点含具名 sessionStorage 键 EncryptionKey",
    "worker 节点 = new Worker(workerUrl,{name:'lcd_base'}) / {name:'lcd_gltf'}"
  ]
};
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1), 'utf8');
console.log('bytes', fs.statSync(process.argv[3]).size);
