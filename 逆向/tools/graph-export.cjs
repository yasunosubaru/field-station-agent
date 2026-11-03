// Drive Graph.exe to export HTML / PDF / KML / CSV without touching a native dialog.
//
//   set GRAPH_EXE=...\Graph\Graph.exe
//   set GRAPH_GPF=...\clean\clean.gpf
//   set GRAPH_OUT=...\gexp
//   node tools/graph-export.cjs
//
// Why this works: the renderer asks the main process for a destination through
// `dialog.showSaveDialog` (title "Select a folder to save exported files"). Playwright can evaluate in
// the main process, so the dialog is replaced before any UI work and the export receives a path.
//
// Destination rule measured from the output (2026-10-30, Graph 2.11.0):
//   returned path `<D>\<name>` →
//     `<D>\<name>.html` (+ `<D>\html\icons`, `<D>\html\scripts\echarts.min.js`)
//     `<D>\<name>.pdf`
//     `<D>\<name>.kml`
//     `<D>\csv\*.csv`            (one file per chart, 13 of them for an OEM7 dataset)
//   i.e. the base name is used verbatim, and the CSV folder sits next to it, not inside it.
//
// The four export formats are checkboxes 6..9 of the Export panel (0..4 select which plots to
// export, 5 is "Project Information"); they are off by default.
const PW = 'C:/Users/<user>/AppData/Roaming/npm/node_modules/playwright';
const { _electron } = require(PW);
const fs = require('fs');
const path = require('path');

const EXE = process.env.GRAPH_EXE || 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\Graph\\Graph.exe';
const GPF = process.env.GRAPH_GPF;
const OUT = process.env.GRAPH_OUT;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!GPF || !OUT) {
  console.error('set GRAPH_GPF and GRAPH_OUT');
  process.exit(2);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const baseName = path.join(OUT, path.basename(GPF, path.extname(GPF)));

  const app = await _electron.launch({ executablePath: EXE, args: [], timeout: 90000 });
  await app.evaluate(async ({ dialog }, ctx) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ctx.project] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: ctx.base });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, { project: GPF, base: baseName });

  const page = await app.firstWindow({ timeout: 90000 });
  await page.waitForTimeout(4500);
  await page.getByRole('button', { name: 'Open Project' }).click();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    if (page.url().includes('#/process') || page.url().includes('#/overview')) break;
  }
  if (!page.url().includes('#/process')) {
    const plot = page.getByRole('button', { name: /^Plot$/ }).first();
    if (await plot.count()) { await plot.click(); await page.waitForTimeout(5000); }
  }

  await page.getByRole('button', { name: /^Export$/ }).first().click();
  await page.waitForTimeout(2500);
  const boxes = page.locator('input[type=checkbox]');
  const count = await boxes.count();
  for (let i = 6; i < Math.min(count, 10); i++) {
    const box = boxes.nth(i);
    if (!(await box.isChecked().catch(() => false))) {
      await box.check({ force: true }).catch(async () => box.evaluate((el) => el.click()));
    }
  }
  const confirm = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null);
    const cancel = buttons.findIndex((b) => /^Cancel$/i.test((b.textContent || '').trim()));
    const pool = cancel >= 0 ? buttons.slice(cancel + 1) : buttons;
    const target = pool.find((b) => /^Export$/i.test((b.textContent || '').trim()));
    if (!target) return 'not found';
    target.click();
    return 'clicked';
  });
  log('export:', confirm);

  const expected = [`${baseName}.html`, `${baseName}.pdf`, `${baseName}.kml`, path.join(OUT, 'csv')];
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    if (expected.every((entry) => fs.existsSync(entry))) break;
  }
  await page.waitForTimeout(2000);
  await app.close();

  const missing = expected.filter((entry) => !fs.existsSync(entry));
  log(missing.length ? `MISSING: ${missing.join(', ')}` : 'all four formats written');
  process.exit(missing.length ? 1 : 0);
})().catch((error) => {
  console.error('FAILED:', error.message.split('\n')[0]);
  process.exit(1);
});
