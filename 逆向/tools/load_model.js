// Load the app's model data scripts in the order index.html loads them, then report
// which globals exist and the shape of MessageIdConstants.messageIds.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const appRoot = process.argv[2];
const files = process.argv.slice(3);
const sandbox = { console, navigator: { userAgent: 'node' }, window: {}, module: {}, exports: {} };
sandbox.global = sandbox;
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of files) {
  const p = path.join(appRoot, f);
  try {
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f, timeout: 30000 });
    console.log('ok   ' + f);
  } catch (e) {
    console.log('FAIL ' + f + ' :: ' + e.message);
  }
}
const M = sandbox.MessageIdConstants;
console.log('\nMessageIdConstants keys: ' + JSON.stringify(Object.keys(M || {})));
if (M && M.messageIds) {
  console.log('messageIds keys: ' + JSON.stringify(Object.keys(M.messageIds)));
  for (const k of Object.keys(M.messageIds)) {
    const v = M.messageIds[k];
    console.log('  ' + k + ' -> ' + (v && typeof v === 'object' ? Object.keys(v).length + ' entries' : String(v)));
  }
}
console.log('\nglobals: ' + Object.keys(sandbox).filter(k => !['console', 'navigator', 'window', 'module', 'exports', 'global', 'self'].includes(k)).join(', '));
