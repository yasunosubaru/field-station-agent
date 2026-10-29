const fs = require('fs');
const p = process.argv[2];
const s = fs.readFileSync(p, 'utf8');
console.log('chars', s.length);
const lines = s.split('\n');
console.log('lines', lines.length);
console.log('top line lens', lines.map(l => l.length).sort((a, b) => b - a).slice(0, 5).join(','));
const marks = ['ipcRenderer', 'ipcMain', 'better-sqlite3', 'sqlite', 'SQLite', 'createSlice', 'createBrowserRouter',
  'createHashRouter', 'BrowserRouter', 'HashRouter', 'i18next', 'jspdf', 'html2canvas', 'echarts', 'protobuf',
  'sbf', 'novatel', 'Graph.exe', 'contextBridge', 'exposeInMainWorld', 'preload', 'redux', 'createApi',
  'webworker', 'Worker(', 'wasm', 'datablk', 'jsc'];
for (const m of marks) {
  let n = 0, i = 0;
  const low = s.toLowerCase(), ml = m.toLowerCase();
  while ((i = low.indexOf(ml, i)) !== -1) { n++; i += ml.length; }
  console.log(m, n);
}
