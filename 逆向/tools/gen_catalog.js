// Generate the reimplementation's data catalog from the extracted application tables.
// Inputs : 03_分析/附录/catalog-*.json (produced from 01_解包/app by tools/extract_literal.js / eval_global.js)
// Outputs: 04_重实现/packages/protocol/data/*.json
// Mirrors 01_解包/app/view/html/index.html:1182-1198 (catalog assembly + tweak overlay).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = path.join(root, '03_分析', '附录');
const out = path.join(root, '04_重实现', 'packages', 'protocol', 'data');
fs.mkdirSync(out, { recursive: true });

const read = (n) => JSON.parse(fs.readFileSync(path.join(app, n), 'utf8'));
const write = (n, v) => {
  fs.writeFileSync(path.join(out, n), JSON.stringify(v));
  console.log(`${n}: ${(fs.statSync(path.join(out, n)).size / 1024).toFixed(1)} KB`);
};

// ---- 1. message id catalogs ----
const M6 = read('catalog-M6MessageIdConstants.json').messageIds;
const M7 = read('catalog-M7MessageIdConstants.json').messageIds;
const GIII = read('catalog-GIIIMessageIdConstants.json').messageIds;
const tweaks = read('catalog-MessageIdTweaks.json').messageIds;

// index.html overlays tweaks onto the two tables that already contain the id.
for (const id of Object.keys(tweaks)) {
  if (id in M6) M6[id] = tweaks[id];
  if (id in M7) M7[id] = tweaks[id];
}

write('msgids.json', {
  // OEMSTAR and OEM6 share one object; OEM7 and SMART2 share one object (index.html:1182-1186).
  OEM6: M6,
  OEM7: M7,
  GIII,
  aliases: { OEMSTAR: 'OEM6', SMART2: 'OEM7' },
});
console.log(`  OEM6=${Object.keys(M6).length}  OEM7=${Object.keys(M7).length}  GIII=${Object.keys(GIII).length}  tweaks=${Object.keys(tweaks).length}`);

// ---- 2. command catalog (message ids + per-field enum maps) ----
const N = read('catalog-NovatelIdConstants.json');
const commands = {};
for (const [name, def] of Object.entries(N.commandsAndEnums || {})) {
  commands[name] = { messageId: def.messageId, enums: {} };
  for (const [field, val] of Object.entries(def)) {
    if (field === 'messageId') continue;
    commands[name].enums[field] = val;
  }
}
write('commands.json', commands);
console.log('  commands=' + Object.keys(commands).length);

// ---- 3. port name list used by the ASCII command builder ----
write('portnames.json', read('catalog-NovatelPortNamesList.json'));

// ---- 4. required field spec per message id (drives the parsers) ----
write('fields-required.json', read('catalog-dummyJSON.json'));

// ---- 5. port address tables ----
// `portsMap` is address -> name (107 entries); `commandsAndEnums.log.port` is name -> address
// (43 entries) and is what the binary LOG payload actually uses.
write('portaddresses.json', {
  addressToName: N.portsMap || {},
  addressToNameForLoglist: N.portsMapForLoglist || {},
  nameToAddressForLog: (commands.log && commands.log.enums.port) || {},
  logTrigger: (commands.log && commands.log.enums.trigger) || {},
  logHold: (commands.log && commands.log.enums.hold) || {},
});

// ---- 6. component -> log registration tables ----
write('components.json', {
  compRegister: read('catalog-compRegister.json'),
  compLogsRegister: read('catalog-compLogsRegister.json'),
  gIIICompRegister: read('catalog-gIIICompRegister.json'),
  gIIIcompLogsRegister: read('catalog-gIIIcompLogsRegister.json'),
  gIIIfields: read('catalog-dummyGIIIJSON.json'),
  statusComponents: (N.statusComponents || []).length ? N.statusComponents : undefined,
  configComponents: (N.configComponents || []).length ? N.configComponents : undefined,
  gritStatusComponents: (N.gritStatusComponents || []).length ? N.gritStatusComponents : undefined,
  gritConfigComponents: (N.gritConfigComponents || []).length ? N.gritConfigComponents : undefined,
});
console.log('done');
