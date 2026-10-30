/**
 * Graph export driver — the reimplemented `ExportCSV` / `ExportKML` without the Electron app.
 *
 *   node packages/cli/src/graph.ts --project <project.gpf> [--capture <log>] --out <dir> [--csv] [--kml]
 *                                  [--golden <export-dir>] [--time-format GPS|UTC]
 *
 * `--csv` writes `<out>/csv/<chart>.csv` and `--kml` writes `<out>/<project>.kml`, i.e. the same
 * destination layout Graph uses (CSV in a **sibling** `csv/` folder of the KML).
 *
 * `--golden` is optional: point it at a Graph export folder (`…/export`) and every produced file is
 * compared byte for byte, which is how the acceptance run is checked.
 *
 * The capture comes from the project's own `filePath` when that file still exists; otherwise pass
 * `--capture` (the shipped sample project points at `C:\Users\…\Temp\gs\clean.gps`, which is gone).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadProject } from '../../graph/src/project.ts';
import { loadCapture } from '../../graph/src/capture.ts';
import { exportCsv } from '../../graph/src/csv.ts';
import { renderKml } from '../../graph/src/kml.ts';

interface Args {
  project?: string;
  capture?: string;
  out?: string;
  csv: boolean;
  kml: boolean;
  golden?: string;
  timeFormat: 'GPS' | 'UTC';
}

function parse(argv: string[]): Args {
  const args: Args = { csv: false, kml: false, timeFormat: 'GPS' };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--project' || token === '-p') args.project = argv[++i];
    else if (token === '--capture' || token === '-c') args.capture = argv[++i];
    else if (token === '--out' || token === '-o') args.out = argv[++i];
    else if (token === '--golden' || token === '-g') args.golden = argv[++i];
    else if (token === '--time-format') args.timeFormat = String(argv[++i]).toUpperCase() === 'UTC' ? 'UTC' : 'GPS';
    else if (token === '--csv') args.csv = true;
    else if (token === '--kml') args.kml = true;
  }
  return args;
}

function compare(path: string, goldenPath: string): string {
  if (!existsSync(goldenPath)) return 'golden missing';
  const ours = readFileSync(path);
  const golden = readFileSync(goldenPath);
  if (Buffer.compare(ours, golden) === 0) return 'identical to golden';
  // Report the first differing line so a mismatch is actionable instead of "differs".
  const a = ours.toString('utf8').split('\r\n');
  const b = golden.toString('utf8').split('\r\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `DIFFERS at line ${i}\n    ours  : ${JSON.stringify(a[i])}\n    golden: ${JSON.stringify(b[i])}`;
    }
  }
  return 'DIFFERS (length only)';
}

function main(): void {
  const args = parse(process.argv.slice(2));
  if (!args.project || !args.out || (!args.csv && !args.kml)) {
    console.error(
      'usage: graph.ts --project <project.gpf> [--capture <log>] --out <dir> [--csv] [--kml] [--golden <export-dir>]',
    );
    process.exit(2);
  }
  if (args.timeFormat === 'UTC') {
    console.error('warning: --time-format UTC is not verified against a golden; output will use GPS labels');
  }

  const project = loadProject(resolve(args.project));
  const capturePath = args.capture ? resolve(args.capture) : project.capturePath;
  if (!existsSync(capturePath)) {
    console.error(`capture not found: ${capturePath}\npass --capture <log> (the .gpf keeps the original absolute path)`);
    process.exit(2);
  }
  const capture = loadCapture(capturePath);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const rows: string[] = [];
  if (args.csv) {
    const dir = join(outDir, 'csv');
    mkdirSync(dir, { recursive: true });
    for (const result of exportCsv(project, capture)) {
      const path = join(dir, result.fileName);
      writeFileSync(path, result.buffer);
      const verdict = args.golden ? `  [${compare(path, join(resolve(args.golden), 'csv', result.fileName))}]` : '';
      rows.push(`  csv/${result.fileName.padEnd(26)} ${String(result.bytes).padStart(7)} B${verdict}`);
    }
  }
  if (args.kml) {
    const buffer = renderKml(project, capture);
    const path = join(outDir, `${project.projectName}.kml`);
    writeFileSync(path, buffer);
    const verdict = args.golden ? `  [${compare(path, join(resolve(args.golden), `${project.projectName}.kml`))}]` : '';
    rows.push(`  ${project.projectName}.kml${' '.repeat(30)} ${String(buffer.length).padStart(7)} B${verdict}`);
  }

  console.log(`project ${project.projectName}  (${project.projectDirectory})`);
  console.log(`capture ${capturePath}  (${capture.records.length} records)`);
  console.log(`charts  ${exportCsv(project, capture).length} csv chart(s) implemented`);
  console.log(rows.join('\n'));
}

main();
