/**
 * GRIT registers. The data itself is generated from the shipped façade by
 * `tools/gen_grit_registers.js` (`01_解包/app/view/GRIT/gritJarvisInterface.js:6-291`) — see
 * `src/grit/register-data.ts`; this file only adds the request shaping.
 */

import { GRIT_COMP_REGISTER, GRIT_LOG_REGISTER } from './register-data.ts';

export { GRIT_COMP_REGISTER, GRIT_LOG_REGISTER };

export interface GritLogRequest {
  name: string;
  trigger: string;
  period: number;
}

/** The components that own a status tile / panel in the GRIT shell (`gritJarvisInterface.js:438-597`). */
export const GRIT_COMPONENTS: readonly string[] = [
  'gritStatusBar',
  'gritMenuBar',
  'gritEvents',
  'spectrumViewer',
  'interferenceToolKit',
  'pointsOfInterest',
  'spoofingConfiguration',
];

/**
 * `gritCompReqlogs` (`gritJarvisInterface.js:1197-1264`): `message.name = key.slice(0,-1).toUpperCase()`
 * and **no de-duplication** — the original sends one command per register row, so `gritStatusBar`
 * really does request `LOGLIST` twice (24 rows, 23 distinct names).
 */
export function gritLogRequests(
  components: readonly string[] = Object.keys(GRIT_LOG_REGISTER),
): GritLogRequest[] {
  const out: GritLogRequest[] = [];
  for (const component of components) {
    for (const [raw, spec] of Object.entries(GRIT_LOG_REGISTER[component] ?? {})) {
      const [trigger, period] = spec.split(',');
      out.push({
        name: raw.slice(0, -1).toUpperCase(),
        trigger: trigger.toUpperCase(),
        period: Number(period),
      });
    }
  }
  return out;
}

/** Every message id any GRIT component subscribes to (`gritLogsCheck`, `:340-357`). */
export function gritMessageIds(): number[] {
  const ids = new Set<number>();
  for (const fields of Object.values(GRIT_COMP_REGISTER)) {
    for (const key of Object.keys(fields)) {
      const id = Number(key);
      if (Number.isInteger(id)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}
