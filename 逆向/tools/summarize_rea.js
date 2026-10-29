// Summarise the 171 MB REA Evidence JSON into a readable README next to it.
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', '02_证据');
const jsonPath = path.join(dir, 'rea-app-analysis.json');
const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const nr = j.normalized_result;
const out = [];

out.push('# REA 认证级静态分析摘要');
out.push('');
out.push('- evidence_id: `' + j.evidence_id + '`');
out.push('- operation: `' + j.operation + '`');
out.push('- provider: `' + JSON.stringify(j.provider) + '`');
out.push('- 主体: `' + (j.subject && (j.subject.path || j.subject.sha256)) + '`');
out.push('- root_artifact_sha256: `' + nr.root_artifact_sha256 + '`');
out.push('- inventory_graph_sha256: `' + nr.inventory_graph_sha256 + '`');
out.push('- integrity_contradictions: ' + JSON.stringify(nr.integrity_contradictions));
out.push('');
out.push('## statistics');
out.push('```json');
out.push(JSON.stringify(nr.statistics, null, 1));
out.push('```');
out.push('');
out.push('## Electron 面（summary）');
out.push('```json');
out.push(JSON.stringify(nr.summary, null, 1).slice(0, 4000));
out.push('```');
out.push('');
out.push('## limitations（共 ' + (nr.limitations || []).length + ' 条）');
for (const l of nr.limitations || []) out.push('- ' + l);
out.push('');
out.push('## 说明');
out.push('- 本文件是 `rea-app-analysis.json`（约 171 MB，完整 Evidence）的可读摘要；完整文件保留在同目录。');
out.push('- 分析对象是**已解包的目录** `01_解包/app`（`--artifact-format directory`），不是 `app.asar` 本体，');
out.push('  因此 `root_artifact_sha256` 指向目录清单。ASAR 原始哈希见 `00_来源/SHA256-安装目录基线.txt`。');
out.push('- 静态分析的已知边界见上面 `limitations`：IPC 通道、preload 暴露面属于**语法观察**，');
out.push('  不能据此断言运行时可达性；动态通道保持未解。');
out.push('- 功能行为的权威证据仍是 `03_分析/` 下的逐文件文档（每条带 `文件:行号`）。');

const target = path.join(dir, 'README.md');
fs.writeFileSync(target, out.join('\n'));
console.log('wrote ' + target);
console.log(out.slice(0, 40).join('\n'));
