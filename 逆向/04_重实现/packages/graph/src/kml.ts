/**
 * `ExportKML` — byte-for-byte reproduction of `clean.kml`.
 *
 * Ground truth: `00_来源/samples/graph/export/clean.kml` (Graph 2.11.0, 2026-10-31): 5 728 bytes,
 * CRLF, no BOM, trailing `\r\n` after `</kml>`.
 *
 * Structure (one `<Folder>` per position type, styles first):
 *
 * ```
 * <!--Project Information-->                       ← 6 comment lines, hand-padded
 * <Document id="root_doc"><Folder><name>project</name>
 *   <Style id="Path<TYPE>">  … LineStyle/PolyStyle colour, width 4
 *   <Style id="Point<TYPE>"> … IconStyle colour + scale 0.75 + placemark_circle.png
 *   <Folder id="<TYPE>"><name><TYPE></name>
 *     <Folder id="Points"><name>Points</name>
 *       <Folder id="Starting Points"><name>Started <GPS time></name><description><TYPE></description>
 *         <Placemark> per fix: balloon "GPS: …", "<font color=red>TYPE</font>", "lat, lon, h",
 *                     "Std Dev: a, b, c M"; <Point><coordinates>lon,lat,h</coordinates>
 *       </Folder>
 *     </Folder>
 *     <Folder id="Paths"><name>Paths</name><Placemark> one LineString, all coordinates
 *   </Folder>
 * ```
 *
 * Numbers: coordinates `lon,lat` with 6 decimals, height with **3** decimals and trailing zeros
 * kept (`66.430`); the balloon's Std Dev triple also uses 3 decimals. Colours are KML
 * `AABBGGRR` built from the renderer's position-type colour (`#3C4AE7` → `ffe74a3c`).
 *
 * The quirky `</Placemark></Folder>` on one line after the last point is reproduced literally.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capture, CaptureRecord } from './capture.ts';
import { field } from './capture.ts';
import { POSITION_TYPE, formatDuration, formatGpsCommentTime, formatTrimmed } from './format.ts';
import type { GraphProject } from './project.ts';

/**
 * Position-type → colour. Verbatim from the renderer's table
 * (`index-B86bHcCD.js @1328196`, archived as `06_Graph应用-附录/D_位置类型与事件色表.json`);
 * every type maps to one of these groups.
 */
const TYPE_GROUP: Record<string, string> = {
  NO_SOLUTION: '#8E44AD',
  FIXED_POS: '#2980B9',
  NA: '#787878',
  SINGLE_POINT: '#3C4AE7',
  DGNSS: '#C88C32',
  SBAS: '#B47828',
  PROPAGATED: '#5A3282',
  RTK_FLOAT: '#E67E22',
  RTK_FIXED: '#2980B9',
  INS_SBAS: '#962864',
  INS_SP: '#146E14',
  INS_DGNSS: '#783C00',
  INS_RTK_FLOAT: '#640078',
  INS_RTK_FIXED: '#005A78',
  INS_EXT_CONSTRAINED: '#780028',
  PPP_CONVERGING: '#C88C32',
  PPP_FIXED: '#2980B9',
  OPERATIONAL: '#C88C32',
  WARNING: '#C88C32',
  OUT_OF_BOUNDS: '#787878',
  INS_PPP_CONVERGING: '#501482',
  INS_PPP_FIXED: '#005A78',
  PPP_BASIC_CONVERGING: '#C88C32',
  PPP_BASIC_CONVERGED: '#2980B9',
  INS_PPP_BASIC_CONVERGING: '#501482',
  INS_PPP_BASIC: '#005A78',
  INS: '#005A78',
};

/** `position_type` → colour group, for the types Graph can colour. */
const GROUP_OF_TYPE: Record<number, string> = (() => {
  const map: Record<number, string> = {};
  const assign = (group: string, types: number[]) => {
    for (const type of types) map[type] = group;
    map[-1] = map[-1] ?? group; // unused; keeps TS from widening the literal type
  };
  assign('NO_SOLUTION', [0]);
  assign('FIXED_POS', [1, 2]);
  assign('NA', [8]);
  assign('SINGLE_POINT', [16]);
  assign('DGNSS', [17]);
  assign('SBAS', [18]);
  assign('PROPAGATED', [19]);
  assign('RTK_FLOAT', [32, 34]);
  assign('RTK_FIXED', [48, 49, 50]);
  assign('INS_SBAS', [52]);
  assign('INS_SP', [53]);
  assign('INS_DGNSS', [54]);
  assign('INS_RTK_FLOAT', [55]);
  assign('INS_RTK_FIXED', [56]);
  assign('INS_EXT_CONSTRAINED', [67]);
  assign('PPP_CONVERGING', [68]);
  assign('PPP_FIXED', [69]);
  assign('OPERATIONAL', [70]);
  assign('WARNING', [71]);
  assign('OUT_OF_BOUNDS', [72]);
  assign('INS_PPP_CONVERGING', [73]);
  assign('INS_PPP_FIXED', [74]);
  assign('PPP_BASIC_CONVERGING', [77]);
  assign('PPP_BASIC_CONVERGED', [78]);
  assign('INS_PPP_BASIC_CONVERGING', [79]);
  assign('INS_PPP_BASIC', [80]);
  assign('INS', [65535]);
  delete map[-1];
  return map;
})();

/** `#3C4AE7` → KML `ffe74a3c` (`AABBGGRR`). */
export function kmlColour(hex: string): string {
  const value = hex.replace('#', '');
  const r = value.slice(0, 2).toLowerCase();
  const g = value.slice(2, 4).toLowerCase();
  const b = value.slice(4, 6).toLowerCase();
  return `ff${b}${g}${r}`;
}

interface TypeGroup {
  /** `SINGLE`, `RTK_FIXED`, … (the `positionType` name). */
  type: string;
  colour: string;
  points: CaptureRecord[];
}

function positionFixes(project: GraphProject, capture: Capture): CaptureRecord[] {
  const { StartTime, EndTime } = project.dataInfo;
  return capture
    .byName('BESTPOS')
    .filter((record) => record.gpsMs >= StartTime && record.gpsMs < EndTime);
}

function groupByType(fixes: CaptureRecord[]): TypeGroup[] {
  const groups: TypeGroup[] = [];
  for (const fix of fixes) {
    const typeCode = field(fix, 'position_type');
    const type = POSITION_TYPE[typeCode] ?? String(typeCode);
    let group = groups.find((candidate) => candidate.type === type);
    if (!group) {
      const colour = TYPE_GROUP[GROUP_OF_TYPE[typeCode] ?? 'SINGLE_POINT'] ?? '#3C4AE7';
      group = { type, colour, points: [] };
      groups.push(group);
    }
    group.points.push(fix);
  }
  return groups;
}

const INDENT = '    ';

function coordinates(fix: CaptureRecord): { lon: string; lat: string; height: string } {
  return {
    lat: formatTrimmed(field(fix, 'latitude'), 6),
    lon: formatTrimmed(field(fix, 'longitude'), 6),
    height: field(fix, 'orthometric_height').toFixed(3),
  };
}

function stdDev(fix: CaptureRecord): string {
  return [
    field(fix, 'latitude_std_dev').toFixed(3),
    field(fix, 'longitude_std_dev').toFixed(3),
    field(fix, 'height_std_dev').toFixed(3),
  ].join(', ');
}

function renderStyle(group: TypeGroup, out: string[]): void {
  const colour = kmlColour(group.colour);
  out.push(
    `${INDENT.repeat(3)}<Style id="Path${group.type}">`,
    `${INDENT.repeat(4)}<LineStyle>`,
    `${INDENT.repeat(5)}<color>${colour}</color>`,
    `${INDENT.repeat(5)}<width>4</width>`,
    `${INDENT.repeat(4)}</LineStyle>`,
    `${INDENT.repeat(4)}<PolyStyle>`,
    `${INDENT.repeat(5)}<color>${colour}</color>`,
    `${INDENT.repeat(4)}</PolyStyle>`,
    `${INDENT.repeat(3)}</Style>`,
    `${INDENT.repeat(3)}<Style id="Point${group.type}">`,
    `${INDENT.repeat(4)}<IconStyle>`,
    `${INDENT.repeat(5)}<color>${colour}</color>`,
    `${INDENT.repeat(5)}<scale>0.75</scale>`,
    `${INDENT.repeat(5)}<Icon>`,
    `${INDENT.repeat(6)}<href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>`,
    `${INDENT.repeat(5)}</Icon>`,
    `${INDENT.repeat(4)}</IconStyle>`,
    `${INDENT.repeat(4)}<BalloonStyle>`,
    `${INDENT.repeat(5)}<text><![CDATA[$[description]]]></text>`,
    `${INDENT.repeat(4)}</BalloonStyle>`,
    `${INDENT.repeat(3)}</Style>`,
  );
}

function renderPoints(group: TypeGroup, out: string[]): void {
  const startedAt = formatGpsCommentTime(group.points[0].gpsMs);
  out.push(
    `${INDENT.repeat(4)}<Folder id="Points">`,
    `${INDENT.repeat(5)}<name>Points</name>`,
    `${INDENT.repeat(5)}<Folder id="Starting Points">`,
    `${INDENT.repeat(6)}<name>Started ${startedAt}</name>`,
    `${INDENT.repeat(6)}<description>${group.type}</description>`,
  );
  group.points.forEach((fix, index) => {
    const { lat, lon, height } = coordinates(fix);
    const balloon =
      `<p>GPS: ${formatGpsCommentTime(fix.gpsMs)}</p><p>&nbsp;</p>` +
      `<p><font color="red">${group.type}</font></p><p>&nbsp;</p>` +
      `<p>${lat}, ${lon}, ${height}</p><p>&nbsp;</p>` +
      `<p>Std Dev: ${stdDev(fix)} M</p>`;
    out.push(
      `${INDENT.repeat(6)}<Placemark>`,
      `${INDENT.repeat(7)}<name> </name>`,
      `${INDENT.repeat(7)}<description><![CDATA[${balloon}]]></description>`,
      `${INDENT.repeat(7)}<styleUrl>#Point${group.type}</styleUrl>`,
      `${INDENT.repeat(7)}<Point>`,
      `${INDENT.repeat(8)}<altitudeMode>clampToGround</altitudeMode>`,
      `${INDENT.repeat(8)}<coordinates>${lon},${lat},${height}</coordinates>`,
      `${INDENT.repeat(7)}</Point>`,
      `${INDENT.repeat(6)}</Placemark>`,
    );
    if (index === group.points.length - 1) {
      // The original closes the point folder on the last placemark's line.
      out[out.length - 1] = `${INDENT.repeat(6)}</Placemark></Folder>`;
    }
  });
  out.push(`${INDENT.repeat(4)}</Folder>`);
}

function renderPaths(group: TypeGroup, out: string[]): void {
  const coords = group.points
    .map((fix) => {
      const { lat, lon, height } = coordinates(fix);
      return `${lon},${lat},${height}`;
    })
    .join(' ');
  out.push(
    `${INDENT.repeat(4)}<Folder id="Paths">`,
    `${INDENT.repeat(5)}<name>Paths</name>`,
    `${INDENT.repeat(5)}<Placemark>`,
    `${INDENT.repeat(6)}<name>Started ${formatGpsCommentTime(group.points[0].gpsMs)}</name>`,
    `${INDENT.repeat(6)}<description>${group.type}</description>`,
    `${INDENT.repeat(6)}<styleUrl>#Path${group.type}</styleUrl>`,
    `${INDENT.repeat(6)}<LineString>`,
    `${INDENT.repeat(7)}<altitudeMode>clampToGround</altitudeMode>`,
    `${INDENT.repeat(7)}<coordinates>${coords} </coordinates>`,
    `${INDENT.repeat(6)}</LineString>`,
    `${INDENT.repeat(5)}</Placemark>`,
    `${INDENT.repeat(4)}</Folder>`,
  );
}

/** Render `clean.kml` for one project. */
export function renderKml(project: GraphProject, capture: Capture): Buffer {
  const groups = groupByType(positionFixes(project, capture));
  const out: string[] = [
    `<?xml version = '1.0' encoding = 'utf-8'?>`,
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    `${INDENT}<!--Project Information-->`,
    `${INDENT}<!--Project Name : ${project.projectName}-->`,
    `${INDENT}<!--Project Directory  : ${project.projectDirectory}-->`,
    `${INDENT}<!--Data File Name   : ${project.dataFileName}-->`,
    `${INDENT}<!--Start Time(gps) : ${formatGpsCommentTime(project.dataInfo.StartTime)}-->`,
    `${INDENT}<!--End Time(gps) : ${formatGpsCommentTime(project.dataInfo.EndTime)}-->`,
    `${INDENT}<!--Duration    : ${formatDuration(project.dataInfo.Duration)}-->`,
    `${INDENT}<Document id="root_doc">`,
    `${INDENT.repeat(2)}<Folder>`,
    `${INDENT.repeat(3)}<name>${project.projectName}</name>`,
  ];
  for (const group of groups) renderStyle(group, out);
  for (const group of groups) {
    out.push(`${INDENT.repeat(3)}<Folder id="${group.type}">`, `${INDENT.repeat(4)}<name>${group.type}</name>`);
    renderPoints(group, out);
    renderPaths(group, out);
    out.push(`${INDENT.repeat(3)}</Folder>`);
  }
  out.push(`${INDENT.repeat(2)}</Folder>`, `${INDENT}</Document>`, '</kml>');
  return Buffer.from(out.join('\r\n') + '\r\n', 'utf8');
}

/** Write `<outDir>/<project>.kml`. */
export function writeKml(project: GraphProject, capture: Capture, outDir: string, fileName = project.projectName): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${fileName}.kml`);
  writeFileSync(path, renderKml(project, capture));
  return path;
}
