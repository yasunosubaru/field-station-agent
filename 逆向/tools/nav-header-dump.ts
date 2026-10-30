// Dump a RINEX nav file's header bytes, line lengths and line endings.
import { readFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  const text = bytes.toString('latin1');
  const lines = text.split('\r\n');
  console.log(`=== ${file}  ${bytes.length} bytes, ${lines.length} split parts (last=${JSON.stringify(lines.at(-1))})`);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  console.log(`crlf=${crlf} loneLf=${loneLf}`);
  lines.slice(0, 5).forEach((line, i) => console.log(`${i}: len=${line.length} ${JSON.stringify(line)}`));
  const last = lines.filter((l) => l.length).at(-1)!;
  console.log(`last content line: len=${last.length} ${JSON.stringify(last)}`);
}
