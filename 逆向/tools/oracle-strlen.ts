/**
 * Side question raised by the `pack(4)` sweep: how long is a `variable` `%s` string?
 *
 * `stringWireSize` caps the text at `arrayLength` (the declared maximum) and pads to 4 bytes. The
 * sweep's patterned payloads have no NUL, and the suite then printed the rest of the payload as one
 * string — so either it does not cap, or it stops only at a NUL. `SURVEYPOSITION`'s `id` is declared
 * 5 bytes; here it holds `abcdefghij\0` (11 bytes) followed by a recognisable `latitude`.
 */

import { Payload, capture, frame, oracle, show } from './oracle.ts';

function survey(id: string): Uint8Array {
  const payload = new Payload(48);
  payload.u32(0, 1);                       // option
  payload.ascii(4, id);                    // id, declared `arrayLength` 5
  payload.f64(16, 12.5);                   // latitude — either at 4+wireSize or at the dense 9
  payload.f64(24, 34.25);                  // longitude
  payload.f64(32, 56.125);                 // height
  payload.f64(40, 0.5);                    // tolerance
  return frame(1952, payload.bytes, { sequence: 1 });
}

const result = oracle(capture(survey('abcdefghij\u0000')), 'strlen');
show('oracle ASCII', result.ascii);
