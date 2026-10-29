// Evaluate a browser-style data script in Node and dump the named global as JSON.
// usage: node eval_global.js <file> <globalName> <outfile>
const fs = require('fs');
const vm = require('vm');
const [file, gname, out] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
const sandbox = { console, module: {}, exports: {}, navigator: { userAgent: 'node' }, window: {} };
sandbox.global = sandbox;
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: file, timeout: 20000 });
} catch (e) {
  console.error('eval error: ' + e.message);
}
const value = sandbox[gname];
if (value === undefined) { console.error('global not defined: ' + gname); process.exit(1); }
const json = JSON.stringify(value, null, 1);
fs.writeFileSync(out, json);
console.log(gname + ': ' + json.length + ' bytes, top-level keys=' + Object.keys(value).length);
