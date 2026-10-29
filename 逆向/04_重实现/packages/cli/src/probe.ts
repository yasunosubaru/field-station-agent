#!/usr/bin/env node
/**
 * nas-probe — 无界面接收机探测工具。
 *
 * 用途：在没有 Electron / UI 的情况下连上真实接收机，验证协议层重实现是否与设备互通。
 * 这是重实现里唯一需要实机才能验证的部分，其余全部有单测覆盖。
 *
 * 用法：
 *   node packages/cli/src/probe.ts --host 192.168.3.1 --port 3001
 *   node packages/cli/src/probe.ts --host 192.168.3.1 --port 3001 --log BESTPOS --period 1 --duration 20
 *   node packages/cli/src/probe.ts --list BESTPOS --generation OEM7
 *
 * 选项：
 *   --host <ip>           TCP 目标地址（必填，除非 --serial）
 *   --port <n>            TCP 端口，默认 3001
 *   --udp                 使用 UDP 而不是 TCP
 *   --serial <path>       串口，例如 COM3
 *   --baud <n>            串口波特率，默认 115200
 *   --generation <gen>    OEM6 | OEM7 | OEMSTAR | SMART2 | GIII，默认 OEM7（用于名字→ID 查找）
 *   --log <NAME>          订阅一个日志（可重复），例如 --log BESTPOS
 *   --trigger <TRIG>      ONTIME | ONNEW | ONCHANGED | ONCE | ONCE 等，默认 ONTIME
 *   --period <sec>        ONTIME 周期，默认 1
 *   --ascii               订阅 ASCII 版本
 *   --duration <sec>      运行时长，默认 10
 *   --json                每条日志输出一行 JSON 而不是表格
 *   --raw                 同时打印原始字节数统计
 *   --list <NAME>         打印该日志在目录中的字段表后退出
 *   --catalog <dir>       目录数据目录，默认 <repo>/04_重实现/packages/protocol/data
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReceiverSession, loadCatalog, type DecodedLog } from '../../session/src/session.ts';
import { connectTcp, connectUdp, connectSerial, type Transport } from '../../session/src/transport.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultCatalogDir = resolve(here, '..', '..', 'protocol', 'data');

interface Args {
  host?: string;
  port: number;
  udp: boolean;
  serial?: string;
  baud: number;
  generation?: string;
  logs: string[];
  trigger: string;
  period: number;
  ascii: boolean;
  duration: number;
  json: boolean;
  raw: boolean;
  list?: string;
  catalogDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 3001,
    udp: false,
    baud: 115200,
    logs: [],
    trigger: 'ONTIME',
    period: 1,
    ascii: false,
    duration: 10,
    json: false,
    raw: false,
    catalogDir: defaultCatalogDir,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error('missing value for ' + arg);
      return v;
    };
    switch (arg) {
      case '--host': args.host = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--udp': args.udp = true; break;
      case '--serial': args.serial = next(); break;
      case '--baud': args.baud = Number(next()); break;
      case '--generation': args.generation = next().toUpperCase(); break;
      case '--log': args.logs.push(next()); break;
      case '--trigger': args.trigger = next().toUpperCase(); break;
      case '--period': args.period = Number(next()); break;
      case '--ascii': args.ascii = true; break;
      case '--duration': args.duration = Number(next()); break;
      case '--json': args.json = true; break;
      case '--raw': args.raw = true; break;
      case '--list': args.list = next(); break;
      case '--catalog': args.catalogDir = next(); break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: throw new Error('unknown option: ' + arg);
    }
  }
  return args;
}

function usage(): void {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
}

function printList(catalogDir: string, generation: string, name: string, json: boolean): void {
  const catalog = loadCatalog(catalogDir);
  const key = (catalog.msgids.aliases as Record<string, string>)?.[generation] ?? generation;
  const table = catalog.msgids[key] as Record<string, { Name: string }>;
  const wanted = name.toUpperCase();
  const hit = Object.entries(table ?? {}).find(([, info]) => info?.Name?.toUpperCase() === wanted);
  if (!hit) {
    console.error(`${name} is not in the ${key} catalogue`);
    process.exit(2);
  }
  const [id, info] = hit;
  const spec = catalog.specByMessage?.[id];
  if (json) {
    console.log(JSON.stringify({ id: Number(id), generation: key, info, spec }, null, 2));
    return;
  }
  console.log(`# ${info.Name}  id=${id}  generation=${key}` + (spec?.repeat ? '  (repeated block)' : ''));
  if (!spec) {
    console.log('  (no field spec)');
    return;
  }
  for (const [field, def] of Object.entries(spec.fields)) {
    const scale = def.scale === undefined ? '' : `  x${def.scale}`;
    const note = def.note ? `  // ${def.note}` : '';
    console.log(`  ${String(def.offset).padStart(4)}  ${def.type.padEnd(12)} ${field}${scale}${note}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return printList(args.catalogDir, args.generation ?? 'OEM7', args.list, args.json);

  const catalog = loadCatalog(args.catalogDir);
  let transport: Transport;
  let rawBytes = 0;

  const handlers = {
    onData: (bytes: Uint8Array) => {
      rawBytes += bytes.length;
      session.feed(bytes);
    },
    onError: (error: Error) => console.error('[transport error]', error.message),
  };

  if (args.serial) {
    // serialport is an optional native dependency; the core never requires it.
    let SerialPortCtor: any;
    try {
      ({ SerialPort: SerialPortCtor } = await import('serialport'));
    } catch {
      console.error('--serial needs the optional `serialport` package: npm i serialport');
      process.exit(2);
    }
    transport = await connectSerial(
      (path, options) =>
        new Promise((resolvePort, reject) => {
          const port = new SerialPortCtor({ path, ...options }, (err: Error | null) =>
            err ? reject(err) : resolvePort(port),
          );
        }),
      { path: args.serial, baudRate: args.baud, hardwareHandshake: false },
      handlers,
    );
  } else if (!args.host) {
    usage();
    console.error('\n--host or --serial is required');
    process.exit(2);
  } else if (args.udp) {
    transport = await connectUdp({ host: args.host, port: args.port }, handlers);
  } else {
    transport = await connectTcp({ host: args.host, port: args.port }, handlers);
  }

  const session = new ReceiverSession(transport, {
    catalog,
    generation: (args.generation as never) ?? undefined,
    heartbeat: { intervalMs: 5000, maxMisses: 2 },
  });

  let count = 0;
  session.on('ready', (generation) => console.error(`[ready] generation=${generation}`));
  session.on('heartbeat-miss', (n) => console.error(`[heartbeat] no data for ${n} ticks`));
  session.on('drop', (n, reason) => {
    if (args.raw) console.error(`[drop] ${n} bytes (${reason})`);
  });
  session.on('text', (prefix, text) => {
    if (args.json) console.log(JSON.stringify({ kind: 'text', prefix, text }));
    else process.stdout.write('TEXT ' + text);
  });
  session.on('log', (log: DecodedLog) => {
    count += 1;
    if (args.json) {
      console.log(JSON.stringify({
        kind: 'log',
        id: log.messageId,
        name: log.name,
        time: log.time.toISOString(),
        crcOk: log.crcOk,
        repeated: log.hasRepeatedBlock,
        fields: log.fields,
      }));
      return;
    }
    const summary = Object.entries(log.fields)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(6)) : v}`)
      .join(' ');
    console.log(`${log.time.toISOString()}  #${log.messageId} ${log.name.padEnd(16)} ${summary}`);
  });

  session.start();
  console.error(`[open] ${args.serial ?? `${args.host}:${args.port}${args.udp ? '/udp' : ''}`}`);

  if (args.logs.length === 0) {
    // Nothing requested: the VERSIONB request from start() is enough to prove the link works.
    console.error('[info] no --log given; only VERSIONB will be requested');
  }
  for (const name of args.logs) {
    try {
      session.log(name, { ascii: args.ascii, trigger: args.trigger, periodSeconds: args.period });
      console.error(`[log] ${name} ${args.trigger} ${args.period}`);
    } catch (error) {
      console.error(`[log] ${(error as Error).message}`);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, args.duration * 1000));
  session.stop();
  console.error(`[done] ${count} logs, ${rawBytes} bytes received`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
