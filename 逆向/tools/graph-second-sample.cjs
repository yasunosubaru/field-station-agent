// Build a *second* Graph project unattended, from an ASCII-only directory, so the
// exported CSVs can be used as the second column-order sample
// (see `03_分析/13_Graph列序分析.md` §5.2 and `14_Graph第二份样本.md`).
//
//   set GRAPH_EXE=...\Graph\Graph.exe                     (optional, has a default)
//   set GRAPH_DIR=C:\...\gs2                              (project parent, must be pure ASCII)
//   set GRAPH_NAME=broad                                  (project name, must be pure ASCII)
//   set GRAPH_DATA=C:\...\gs2\broad.gps                   (data file, must be pure ASCII)
//   node tools/graph-second-sample.cjs
//
// Two independent bypasses of the native pickers are installed, because neither is
// guaranteed on its own:
//   1. main process: `dialog.showOpenDialog` is replaced by a queue (same trick as
//      `graph-export.cjs`, which is proven to work for `showSaveDialog`);
//   2. renderer: `window.file.selectDirectoryDialog` / `openFileDialogFilter` are
//      overwritten, which skips the IPC round trip altogether.
// Both answers are queued in step order (folder first, then the data file).
//
// Exits 0 only when `<GRAPH_DIR>\<GRAPH_NAME>\<GRAPH_NAME>.gpf` exists AND the wizard
// showed 100% file validation.
const PW = 'C:/Users/SunCh/AppData/Roaming/npm/node_modules/playwright';
const { _electron } = require(PW);
const fs = require('fs');
const path = require('path');

const EXE = process.env.GRAPH_EXE || 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\Graph\\Graph.exe';
const DIR = process.env.GRAPH_DIR;
const NAME = process.env.GRAPH_NAME;
const DATA = process.env.GRAPH_DATA;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!DIR || !NAME || !DATA) {
  console.error('set GRAPH_DIR, GRAPH_NAME and GRAPH_DATA');
  process.exit(2);
}
for (const [label, value] of [['GRAPH_DIR', DIR], ['GRAPH_NAME', NAME], ['GRAPH_DATA', DATA]]) {
  if (/[^\x20-\x7e]/.test(value)) {
    console.error(`${label} is not pure ASCII: ${value}`);
    process.exit(2);
  }
}
if (!fs.existsSync(DATA)) {
  console.error('data file missing:', DATA);
  process.exit(2);
}

const GPF = path.join(DIR, NAME, `${NAME}.gpf`);

(async () => {
  const app = await _electron.launch({ executablePath: EXE, args: [], timeout: 90000 });
  // (1) main-process pickers: answer in click order.
  await app.evaluate(async ({ dialog }, ctx) => {
    globalThis.__pickQueue = [ctx.dir, ctx.data];
    dialog.showOpenDialog = async () => {
      const next = globalThis.__pickQueue.shift();
      return { canceled: !next, filePaths: next ? [next] : [] };
    };
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, { dir: DIR, data: DATA });

  const page = await app.firstWindow({ timeout: 90000 });
  await page.waitForTimeout(4500);
  // (2) renderer-level pickers.
  await page.evaluate(({ dir, data }) => {
    const set = (obj, key, value) => {
      try { obj[key] = value; return true; } catch { return false; }
    };
    set(window.file, 'selectDirectoryDialog', async () => dir);
    set(window.file, 'openFileDialog', async () => data);
    set(window.file, 'openFileDialogFilter', async () => data);
    window.__pickers = [typeof window.file?.selectDirectoryDialog, typeof window.file?.openFileDialogFilter];
  }, { dir: DIR, data: DATA });
  log('renderer pickers patched:', await page.evaluate(() => window.__pickers));

  await page.getByRole('button', { name: 'New Project' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(2000);
  log('step 2 (project location)');

  const folderProbe = () => {
    const el = Array.from(document.querySelectorAll('#project-name-input')).find((e) => /[A-Za-z]:\\/.test(e.value || ''));
    return el ? el.value : null;
  };
  if (!(await page.evaluate(folderProbe))) {
    log('folder empty, clicking Select');
    await page.getByRole('button', { name: 'Select' }).click();
    for (let i = 0; i < 20 && !(await page.evaluate(folderProbe)); i++) await page.waitForTimeout(1000);
  }
  log('folder =', await page.evaluate(folderProbe));
  await page.locator('#project-name-input').last().fill(NAME);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(3000);
  log('step 3 (receiver data)');

  if (!(await page.evaluate(() => document.querySelector('#receiver-data-input')?.value || ''))) {
    log('data file empty, clicking Select');
    await page.getByRole('button', { name: 'Select' }).click();
    for (let i = 0; i < 20 && !(await page.evaluate(() => document.querySelector('#receiver-data-input')?.value || '')); i++) await page.waitForTimeout(1000);
  }
  log('data =', await page.evaluate(() => document.querySelector('#receiver-data-input')?.value || ''));
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(3000);

  // validation page: poll until 100% and Finish is clickable
  let best = '';
  let validated = false;
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(3000);
    const state = await page.evaluate(() => {
      const text = (document.body.innerText || '').replace(/\n+/g, ' | ');
      const finish = Array.from(document.querySelectorAll('button')).find((b) => /^Finish$/i.test((b.textContent || '').trim()));
      return { text: text.slice(0, 400), finishEnabled: !!(finish && !finish.disabled) };
    });
    if (state.text !== best) { log('progress:', state.text.slice(0, 220)); best = state.text; }
    if (state.finishEnabled) { validated = true; log('FINISH ENABLED'); break; }
  }
  if (!validated) {
    await page.screenshot({ path: path.join('C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode', 'graph-second-stall.png') });
    throw new Error('file validation never completed: ' + best.slice(0, 300));
  }
  log('final page:', await page.evaluate(() => (document.body.innerText || '').replace(/\n+/g, ' | ').slice(0, 400)));

  await page.getByRole('button', { name: 'Finish' }).click();
  await page.waitForTimeout(8000);
  for (let i = 0; i < 30 && !fs.existsSync(GPF); i++) await page.waitForTimeout(2000);
  log('after finish url:', await page.evaluate(() => location.href));
  await app.close();

  if (!fs.existsSync(GPF)) {
    console.error('project file was not created:', GPF);
    process.exit(1);
  }
  log('project written:', GPF);
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error.message.split('\n')[0]);
  process.exit(1);
});
