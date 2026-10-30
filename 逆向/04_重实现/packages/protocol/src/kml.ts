/**
 * Convert's KML output (one file per position log), reproduced from
 * `samples/convert/golden-kml/clean-9600/.../KML/clean-9600_BESTPOS.KML`.
 *
 * Structure (all indentation is four spaces per level, exact strings matter):
 *
 *   <?xml version = '1.0' encoding = 'utf-8'?>
 *   <kml xmlns="http://www.opengis.net/kml/2.2">
 *       <Document id="root_doc">
 *           <Folder>
 *               <name>‹input›_BESTPOS</name>
 *               <Style id="Path‹type›"> … </Style>
 *               <Style id="Point‹type›"> … </Style>
 *               <Folder id="‹type›">
 *                   <name>‹type›</name>
 *                   <Folder id="Points">
 *                       <name>Points</name>
 *                       <Folder id="Starting Points">
 *                           <name>Started ‹week›,‹sow›</name>
 *                           <description>‹type›</description>
 *                           <Placemark> … </Placemark>      (one per epoch)
 *                       </Folder>
 *                   </Folder>
 *                   <Folder id="Paths">
 *                       <name>Paths</name>
 *                       <Placemark> … <LineString> … </Placemark>
 *                   </Folder>
 *               </Folder>
 *           </Folder>
 *       </Document>
 *   </kml>
 *
 * Quirks kept on purpose: the last `</Placemark>` of the Points folder is followed by
 * `</Folder>` on the same line; `<name> </name>` (a single space) above each point; and the
 * doubled blank `<p>&nbsp;</p>` separators in the balloon text.
 *
 * Only the `SINGLE` position type appears in the goldens, so the colour table has one verified
 * entry; other types fall back to the same colour and are marked in `KML_STYLE_COLORS`.
 */

export interface KmlPoint {
  week: number;
  milliseconds: number;
  latitude: number;
  longitude: number;
  /** Orthometric height (BESTPOS `orthometric_height`). */
  height: number;
  latitudeDeviation: number;
  longitudeDeviation: number;
  heightDeviation: number;
  positionType: string;
}

/** KML colour is aabbggrr. `SINGLE` is the only type verified against the golden. */
export const KML_STYLE_COLORS: Record<string, string> = {
  SINGLE: 'ffe74a3c',
};

const INDENT = '    ';

function styleColor(type: string): string {
  return KML_STYLE_COLORS[type] ?? KML_STYLE_COLORS.SINGLE;
}

function secondsOfWeek(week: number, milliseconds: number): string {
  // Convert divides the GPS seconds-of-week by 1000 before printing (golden: 463 098 s → `463.098`),
  // so the KML timestamps are a thousandth of the real value. Kept as-is for parity.
  const seconds = milliseconds / 1e6;
  return `${week},${seconds.toFixed(3)}`;
}

function coordinates(point: KmlPoint): string {
  return `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)},${point.height.toFixed(3)}`;
}

function pathStyle(type: string): string[] {
  const color = styleColor(type);
  return [
    `${INDENT.repeat(3)}<Style id="Path${type}">`,
    `${INDENT.repeat(4)}<LineStyle>`,
    `${INDENT.repeat(5)}<color>${color}</color>`,
    `${INDENT.repeat(5)}<width>4</width>`,
    `${INDENT.repeat(4)}</LineStyle>`,
    `${INDENT.repeat(4)}<PolyStyle>`,
    `${INDENT.repeat(5)}<color>${color}</color>`,
    `${INDENT.repeat(4)}</PolyStyle>`,
    `${INDENT.repeat(3)}</Style>`,
  ];
}

function pointStyle(type: string): string[] {
  const color = styleColor(type);
  return [
    `${INDENT.repeat(3)}<Style id="Point${type}">`,
    `${INDENT.repeat(4)}<IconStyle>`,
    `${INDENT.repeat(5)}<color>${color}</color>`,
    `${INDENT.repeat(5)}<scale>0.75</scale>`,
    `${INDENT.repeat(5)}<Icon>`,
    `${INDENT.repeat(6)}<href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>`,
    `${INDENT.repeat(5)}</Icon>`,
    `${INDENT.repeat(4)}</IconStyle>`,
    `${INDENT.repeat(4)}<BalloonStyle>`,
    `${INDENT.repeat(5)}<text><![CDATA[$[description]]]></text>`,
    `${INDENT.repeat(4)}</BalloonStyle>`,
    `${INDENT.repeat(3)}</Style>`,
  ];
}

function placemark(point: KmlPoint): string[] {
  const time = secondsOfWeek(point.week, point.milliseconds);
  const balloon =
    `<p>GPS: ${time}</p><p>&nbsp;</p>` +
    `<p><font color="red">${point.positionType}</font></p><p>&nbsp;</p>` +
    `<p>${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}, ${point.height.toFixed(3)}</p><p>&nbsp;</p>` +
    `<p>Std Dev: ${point.latitudeDeviation.toFixed(3)}, ${point.longitudeDeviation.toFixed(3)}, ${point.heightDeviation.toFixed(3)} M</p>`;
  return [
    `${INDENT.repeat(6)}<Placemark>`,
    `${INDENT.repeat(7)}<name> </name>`,
    `${INDENT.repeat(7)}<description><![CDATA[${balloon}]]></description>`,
    `${INDENT.repeat(7)}<styleUrl>#Point${point.positionType}</styleUrl>`,
    `${INDENT.repeat(7)}<Point>`,
    `${INDENT.repeat(8)}<altitudeMode>clampToGround</altitudeMode>`,
    `${INDENT.repeat(8)}<coordinates>${coordinates(point)}</coordinates>`,
    `${INDENT.repeat(7)}</Point>`,
    `${INDENT.repeat(6)}</Placemark>`,
  ];
}

function pathPlacemark(points: KmlPoint[]): string[] {
  const type = points[0].positionType;
  const list = points.map((point) => `${coordinates(point)} `).join('');
  return [
    `${INDENT.repeat(5)}<Placemark>`,
    `${INDENT.repeat(6)}<name>Started ${secondsOfWeek(points[0].week, points[0].milliseconds)}</name>`,
    `${INDENT.repeat(6)}<description>${type}</description>`,
    `${INDENT.repeat(6)}<styleUrl>#Path${type}</styleUrl>`,
    `${INDENT.repeat(6)}<LineString>`,
    `${INDENT.repeat(7)}<altitudeMode>clampToGround</altitudeMode>`,
    `${INDENT.repeat(7)}<coordinates>${list}</coordinates>`,
    `${INDENT.repeat(6)}</LineString>`,
    `${INDENT.repeat(5)}</Placemark>`,
  ];
}

export interface KmlOptions {
  /** File/folder base name, e.g. `clean-9600_BESTPOS`. */
  name: string;
}

/** Build the KML text for one position log; points are grouped by position type, in input order. */
export function buildKml(points: KmlPoint[], options: KmlOptions): string {
  const types: string[] = [];
  for (const point of points) if (!types.includes(point.positionType)) types.push(point.positionType);

  const lines: string[] = [];
  lines.push("<?xml version = '1.0' encoding = 'utf-8'?>");
  lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
  lines.push(`${INDENT}<Document id="root_doc">`);
  lines.push(`${INDENT.repeat(2)}<Folder>`);
  lines.push(`${INDENT.repeat(3)}<name>${options.name}</name>`);
  for (const type of types) lines.push(...pathStyle(type));
  for (const type of types) lines.push(...pointStyle(type));

  for (const type of types) {
    const group = points.filter((point) => point.positionType === type);
    const start = secondsOfWeek(group[0].week, group[0].milliseconds);
    lines.push(`${INDENT.repeat(3)}<Folder id="${type}">`);
    lines.push(`${INDENT.repeat(4)}<name>${type}</name>`);
    lines.push(`${INDENT.repeat(4)}<Folder id="Points">`);
    lines.push(`${INDENT.repeat(5)}<name>Points</name>`);
    lines.push(`${INDENT.repeat(5)}<Folder id="Starting Points">`);
    lines.push(`${INDENT.repeat(6)}<name>Started ${start}</name>`);
    lines.push(`${INDENT.repeat(6)}<description>${type}</description>`);
    group.forEach((point, index) => {
      const block = placemark(point);
      // The suite glues `</Folder>` onto the last `</Placemark>`.
      if (index === group.length - 1) block[block.length - 1] += '</Folder>';
      lines.push(...block);
    });
    lines.push(`${INDENT.repeat(4)}</Folder>`);
    lines.push(`${INDENT.repeat(4)}<Folder id="Paths">`);
    lines.push(`${INDENT.repeat(5)}<name>Paths</name>`);
    lines.push(...pathPlacemark(group));
    lines.push(`${INDENT.repeat(4)}</Folder>`);
    lines.push(`${INDENT.repeat(3)}</Folder>`);
  }

  lines.push(`${INDENT.repeat(2)}</Folder>`);
  lines.push(`${INDENT}</Document>`);
  lines.push('</kml>');
  return `${lines.join('\r\n')}\r\n`;
}

