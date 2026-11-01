/**
 * The configuration pages read a per-port dictionary, and `config-feed.ts` is the only thing that
 * turns the receiver's own records into it. These tests use lines copied verbatim from the desk
 * OEM729 (2026-11-01, `LOG INTERFACEMODEB/LOGLISTB/SERIALCONFIGB/ICOMCONFIGB/NTRIPCONFIGB/
 * SOURCETABLEB ONCE` on COM10 = receiver USB2), so a change in the parser has to explain itself
 * against bytes a receiver actually sent.
 *
 * The port names are the receiver's own and look odd on purpose: `CCOM1`-`CCOM6` are real
 * `INTERFACEMODE` ports on this model (`NOVATELMINBINARY`/`AUTO`), not a stray letter — the page
 * renders exactly what the record says.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_MESSAGE_IDS, configBodyTokens, configSliceOf, createAccumulator } from '../src/config-feed.ts';

const INTERFACE = '#INTERFACEMODEA,SPECIAL,26,73.5,UNKNOWN,0,2.180,03801800,7a68,18278;COM1,NOVATEL,NOVATEL,ON*4af43302';
const CCOM = '#INTERFACEMODEA,SPECIAL,20,73.5,UNKNOWN,0,2.078,03801800,7a68,18278;CCOM1,NOVATELMINBINARY,NOVATELMINBINARY,ON*00000000';
const SERIAL = '#SERIALCONFIGA,SPECIAL,2,73.5,UNKNOWN,0,2.177,03801800,6be8,18278;COM1,9600,N,8,1,N,ON*ce240d0e';
const ICOM = '#ICOMCONFIGA,SPECIAL,6,73.5,UNKNOWN,0,2.322,03801800,1faa,18278;ICOM1,TCP,":2000",ALL*0b82fead';
const NTRIP = '#NTRIPCONFIGA,SPECIAL,2,73.5,UNKNOWN,0,2.119,03801800,4f72,18278;NCOM1,DISABLED,V1,"","","","",ALL*8b535eb2';
const SOURCE = '#SOURCETABLEA,SPECIAL,0,76.0,COARSESTEERING,2443,8199.000,03801800,71dd,18278;"",0,0,""*4cb149b8';
const LOGLIST = '#LOGLISTA,SPECIAL,0,76.5,COARSESTEERING,2443,7847.000,03801800,c00c,18278;2,COM1,RXSTATUSEVENTA,ONNEW,0.000000,0.000000,HOLD,USB1,RAWEPHEMB,ONNEW,0.000000,0.000000,HOLD*00000000';

test('the body of a full-ASCII record is what sits after the last `;`, quotes stripped', () => {
  assert.deepEqual(configBodyTokens(INTERFACE), ['COM1', 'NOVATEL', 'NOVATEL', 'ON']);
  assert.deepEqual(configBodyTokens(ICOM), ['ICOM1', 'TCP', ':2000', 'ALL']);
  // Abbreviated ASCII has no body delimiter; guessing there would fabricate ports.
  assert.equal(configBodyTokens('<INTERFACEMODE COM1 NOVATEL NOVATEL ON'), null);
  assert.equal(configBodyTokens(''), null);
});

test('INTERFACEMODE becomes the page\'s rxType/txType per port', () => {
  const slice = configSliceOf(3, INTERFACE, null);
  assert.deepEqual(slice, {
    name: 3,
    data: { port: 'COM1', rxType: 'NOVATEL', txType: 'NOVATEL', responses: 'ON' },
  });
  // `CCOM1` is a port this model really reports; it must not be "corrected" to `COM1`.
  const ccom = configSliceOf(3, CCOM, null);
  assert.equal((ccom?.data as Record<string, unknown>).port, 'CCOM1');
});

test('SERIALCONFIG accumulates one whole per-port table', () => {
  const accumulator = createAccumulator();
  const first = configSliceOf(1246, SERIAL, accumulator);
  assert.deepEqual(first?.data, { COM1: { baud: 9600, parity: 'N', databits: 8, stopbits: 1 } });
  const second = configSliceOf(
    1246,
    '#SERIALCONFIGA,SPECIAL,1,73.5,UNKNOWN,0,2.176,03801800,6be8,18278;COM2,38400,N,8,1,N,ON*d4b6d70b',
    accumulator,
  );
  // The page replaces `current[1246]` wholesale, so every feed carries every port seen so far.
  assert.deepEqual(Object.keys(second?.data ?? {}), ['COM1', 'COM2']);
  assert.equal((second?.data as Record<string, Record<string, unknown>>).COM2.baud, 38400);
});

test('LOGLIST becomes a port → message → trigger table, as the chips read it', () => {
  const slice = configSliceOf(5, LOGLIST, createAccumulator());
  const table = slice?.data as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(table), ['COM1', 'USB1']);
  assert.equal(table.COM1.RXSTATUSEVENTA.name, 'RXSTATUSEVENTA');
  assert.equal(table.COM1.RXSTATUSEVENTA.trigger, 'ONNEW');
  assert.equal(table.USB1.RAWEPHEMB.hold, 'HOLD');
});

test('ICOMCONFIG, NTRIPCONFIG and SOURCETABLE keep the shape their pages nest on', () => {
  const icom = configSliceOf(1248, ICOM, null);
  assert.equal((icom?.data as Record<string, unknown>).port, 'ICOM1');
  const ntrip = configSliceOf(1249, NTRIP, null);
  assert.equal((ntrip?.data as Record<string, unknown>).port, 'NCOM1');
  assert.equal((ntrip?.data as Record<string, unknown>).type, 'DISABLED');
  const source = configSliceOf(1344, SOURCE, null);
  assert.deepEqual(source?.data, { endPoint: '', entryData: '' });
});

test('the message ids the feed listens to are exactly the configuration pages\' own', () => {
  assert.deepEqual([...CONFIG_MESSAGE_IDS], [3, 5, 1246, 1248, 1249, 1344]);
});
