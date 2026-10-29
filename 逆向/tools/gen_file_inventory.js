// Build 03_分析/附录/app-file-inventory.md — every file the application ships outside node_modules,
// with size/lines, grouped by area. This is the coverage ledger for the reverse-engineering docs.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = path.join(root, '01_解包', 'app');
const outFile = path.join(root, '03_分析', '附录', 'app-file-inventory.md');

const SKIP_DIRS = new Set(['node_modules', '.vscode']);
const rows = [];

function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const r = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, r);
      continue;
    }
    const size = fs.statSync(abs).size;
    let lines = '';
    if (/\.(js|html|css|json|md|txt|bat|cmd|toml|py)$/i.test(entry.name)) {
      try {
        lines = String(fs.readFileSync(abs, 'utf8').split('\n').length);
      } catch {
        lines = '?';
      }
    }
    rows.push({ rel: r, size, lines });
  }
}

walk(app);

function group(rel) {
  if (rel.includes('/helpFile/')) return 'G. 帮助文档(内嵌)';
  if (rel.startsWith('view/GRIT/')) return 'E. GRIT Monitor';
  if (rel.startsWith('view/convert/')) return 'C. Convert';
  if (rel.startsWith('view/languageSupport/') || rel.startsWith('view/json/')) return 'H. 国际化';
  if (rel.startsWith('view/images/') || rel.startsWith('view/fonts/') || rel.startsWith('view/css/')) return 'I. 静态资源';
  if (rel.startsWith('view/')) return 'B. Manage 视图层';
  if (rel.startsWith('model/')) return 'A2. 数据模型/消息目录';
  if (rel.startsWith('controller/')) return 'A1. 控制器/传输/解析';
  if (rel.startsWith('Edie/')) return 'J. Edie 原生解码层';
  if (rel.startsWith('shortcuts/') || rel.startsWith('Apps/') || rel === 'tosrec.exe' || rel === 'datablk.exe') return 'K. 安装/工具';
  return 'Z. 根目录入口';
}

const groups = new Map();
for (const row of rows) {
  const g = group(row.rel);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(row);
}

let md = '# 应用自带文件清单（不含 node_modules）\n\n';
md += '> 自动生成：`tools/gen_file_inventory.js`。行数为文本文件行数，二进制留空。\n';
md += '> 用途：证明「每一个文件都被某个子系统文档覆盖到」，是覆盖度账本。\n\n';
md += `总计 **${rows.length}** 个文件，**${(rows.reduce((n, r) => n + r.size, 0) / 1024 / 1024).toFixed(1)} MB**。\n\n`;

const order = [...groups.keys()].sort();
for (const g of order) {
  const list = groups.get(g).sort((a, b) => b.size - a.size);
  const totalMB = list.reduce((n, r) => n + r.size, 0) / 1024 / 1024;
  md += `## ${g}  (${list.length} 文件, ${totalMB.toFixed(2)} MB)\n\n`;
  md += '| 文件 | 行 | 字节 |\n|---|---:|---:|\n';
  for (const row of list) {
    if (row.size > 200000 && /\.(png|exe|node|zip|ttf|gif|jpg|ico|woff2?|eot|svg)$/i.test(row.rel)) {
      md += `| \`${row.rel}\` | — | ${row.size} |\n`;
    } else {
      md += `| \`${row.rel}\` | ${row.lines} | ${row.size} |\n`;
    }
  }
  md += '\n';
}

fs.writeFileSync(outFile, md);
console.log('wrote ' + outFile + ' (' + rows.length + ' files, ' + groups.size + ' groups)');
for (const g of order) console.log('  ' + g + ': ' + groups.get(g).length);
