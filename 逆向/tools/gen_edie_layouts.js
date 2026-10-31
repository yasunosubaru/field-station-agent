// Generate `data/edie-layouts.json` from the suite's own message dictionary
// (`01_解包/app/Edie/messages_public.json`, 608 messages / 240 enums / 7.2 MB).
//
// This is the table Convert uses to read binary logs and to print ASCII, so it is a better
// authority than `logparsers.js` (which only declares what the UI panel consumes) and better than
// the manual (which has no conversion strings).
//
// Layout model, verified against real payload lengths in `samples/convert/broad-clean.gps`:
//   SIMPLE / ENUM      -> fixed `dataType.length` bytes
//   FIELD_ARRAY        -> 4-byte element count, then N elements of `stride` bytes
//                         (RANGE 2204 = 4 + 50*44, RXSTATUS 88 = 4 + 4 + 5*16, BESTSATS 292 = 4 + 18*16)
//   FIXED_LENGTH_ARRAY -> `arrayLength` elements, no count prefix
//   VARIABLE_LENGTH_ARRAY -> `arrayLengthFieldSize` count prefix (absent for RXCONFIG/RXCONFIGUSER,
//                         whose whole payload is the data), then N scalars of `dataType.length` bytes
//
// The last rule was missing until 2026-11-01 and cost 149 log lines: ITPSDFINAL/ITPSDDETECT carry
// their 1024 power samples as a VARIABLE_LENGTH_ARRAY, and without it the field was emitted as one
// `%hu` scalar, so the ASCII writer printed `...,97656.250,1024` where the suite prints 1024 samples
// after that count (`samples/live-20261031/remote-23types.sbf` vs `golden-remote-23types.ASCII`).
//
// Output: 04_重实现/packages/protocol/data/edie-layouts.json
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, '01_解包', 'app', 'Edie', 'messages_public.json');
const out = path.join(root, '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json');

const edie = JSON.parse(fs.readFileSync(source, 'utf8'));

const TYPE = {
  USHORT: 'u16',
  ULONG: 'u32',
  ENUM: 'enum',
  LONG: 'i32',
  FLOAT: 'f32',
  DOUBLE: 'f64',
  UCHAR: 'u8',
  BOOL: 'bool',
  SATELLITEID: 'satid',
  CHAR: 'char',
};

const enums = {};
for (const table of edie.enums) {
  const values = {};
  for (const entry of table.enumerators ?? []) values[String(entry.value)] = entry.name;
  enums[table._id] = { name: table.name, values };
}

/** Byte width of a dataType; FIELD_ARRAY's own length is its count prefix, not the element size. */
function scalarWidth(field) {
  return Number(field.dataType?.length ?? 0);
}

function buildFields(fields) {
  const segments = [];
  let offset = 0;
  for (const field of fields ?? []) {
    if ((field.type === 'FIXED_LENGTH_ARRAY' || field.type === 'STRING') && !field.fields) {
      // CHAR/UCHAR arrays are printed as one quoted string (`base_id` → `""`), not as N numbers.
      // `STRING` is the same thing with a different type name: `arrayLength` bytes of CHAR
      // (ICOMCONFIG's `endpoint` is 80, DGPSTXID's `dgps_id` is 5). Missing it made those fields
      // one-byte scalars and shifted every field behind them — 20 RXCONFIG lines in
      // `samples/live-20261031/b1-20261101.sbf` printed `"65"`/`"58"` where the suite prints
      // `"ANY"`/`":3002"`.
      //
      // A `STRING` field's `arrayLength` is a **maximum**, not the wire size: on the wire the text
      // runs to a NUL and is zero-padded to a 4-byte boundary (ICOMCONFIG's `":3002"` occupies 8
      // bytes, so the payload is 20 = 4+4+8+4, not 92). `variable` tells the writer to measure the
      // padding instead of trusting `arrayLength`.
      const width = Number(field.dataType?.length ?? 1);
      const fixed = field.type === 'FIXED_LENGTH_ARRAY';
      const size = width * Number(field.arrayLength ?? 0);
      // Only CHAR/UCHAR arrays are strings. A fixed array of FLOATs keeps its conversion string
      // and prints one number per element (SETDIFFCODEBIASES: 40 × `%7.3k` inside 160 bytes).
      if (width === 1) {
        segments.push({
          name: field.name,
          kind: 'string',
          offset,
          size,
          format: field.conversionString ?? null,
          ...(fixed ? {} : { variable: true }),
        });
        offset += size;
        continue;
      }
    }
    if (field.type === 'FIELD_ARRAY' || field.type === 'FIXED_LENGTH_ARRAY') {
      const elementFields = field.fields ?? [{ ...field, type: 'SIMPLE', fields: undefined, arrayLength: null }];
      const elements = buildFields(elementFields);
      const stride = elements.reduce((n, el) => Math.max(n, el.offset + (el.size ?? 0)), 0);
      const countPrefix = field.type === 'FIELD_ARRAY' ? Number(field.dataType?.length ?? 4) : 0;
      const segment = {
        name: field.name,
        kind: 'array',
        offset,
        countSize: countPrefix,
        fixedCount: field.type === 'FIXED_LENGTH_ARRAY' ? Number(field.arrayLength ?? 0) : undefined,
        stride,
        elements,
      };
      segments.push(segment);
      // A fixed array's element count comes from the definition, so the payload cannot grow.
      offset += countPrefix + (segment.fixedCount ?? 0) * stride;
    } else if (field.type === 'VARIABLE_LENGTH_ARRAY') {
      // Repeated scalar: the count prefix width comes from `arrayLengthFieldSize` (4 everywhere it
      // exists), and a missing one means "the rest of the payload" — RXCONFIG's payload is a whole
      // embedded SBF frame with no length in front of it.
      const width = scalarWidth(field);
      const countPrefix = Number(field.arrayLengthFieldSize ?? 0);
      const element = {
        name: field.name,
        kind: 'scalar',
        offset: 0,
        size: width,
        type: TYPE[field.dataType?.name] ?? String(field.dataType?.name ?? 'u8').toLowerCase(),
        format: field.conversionString ?? null,
      };
      segments.push({
        name: field.name,
        kind: 'array',
        offset,
        countSize: countPrefix,
        stride: width,
        // The conversion string belongs to the field, so it goes on the array too: `%R` is one
        // whole embedded message, not one per byte (see `ascii-log.ts`'s `%R` branch).
        format: field.conversionString ?? null,
        elements: [element],
      });
      offset += countPrefix;
    } else {
      const width = scalarWidth(field);
      const segment = {
        name: field.name,
        kind: 'scalar',
        offset,
        size: width,
        type: TYPE[field.dataType?.name] ?? String(field.dataType?.name ?? 'u8').toLowerCase(),
        format: field.conversionString ?? null,
      };
      if (field.enumID) segment.enum = field.enumID;
      segments.push(segment);
      offset += width;
    }
  }
  return segments;
}

const messages = {};
for (const message of edie.messages) {
  const variant = message.fields?.[message.latestMsgDefCrc];
  if (!variant) continue;
  messages[String(message.messageID)] = {
    name: message.name,
    style: message.messageStyle,
    type: message.messageType,
    fields: buildFields(variant),
  };
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ meta: edie.meta, enums, messages }));

const ids = Object.keys(messages);
const segments = ids.reduce((n, id) => n + messages[id].fields.length, 0);
console.log(`edie-layouts.json: ${ids.length} messages, ${Object.keys(enums).length} enums, ${segments} top-level segments, ${fs.statSync(out).size} bytes`);

// sanity: payload sizes we have measured on the wire
const expect = { 42: 72, 43: 2204, 72: 1044, 83: 7096, 93: 88, 99: 44, 963: 84, 1194: 292, 1043: 1296, 2065: 40, 101: 44, 1968: 2064, 2063: 2064, 5: 4100 };
function fixedSize(segments) {
  let n = 0;
  for (const s of segments) {
    if (s.kind === 'scalar') n += s.size;
    else if (s.fixedCount !== undefined) n += s.countSize + s.fixedCount * s.stride;
    else return null;
  }
  return n;
}
for (const [id, size] of Object.entries(expect)) {
  const layout = messages[id];
  if (!layout) { console.log(`  ${id}: MISSING`); continue; }
  const fixed = fixedSize(layout.fields);
  const ok = fixed === null ? 'variable' : fixed === size ? 'ok' : `MISMATCH fixed=${fixed}`;
  console.log(`  ${id} ${layout.name}: ${ok} (capture ${size})`);
}
