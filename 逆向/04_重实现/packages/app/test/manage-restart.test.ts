/**
 * Device ▸ Restart / Factory Reset — the original's `view/deviceRestart/deviceRestart.js`.
 *
 * What this pins, and why each one matters:
 *
 *   1. **The command strings.** `RESET` with no argument (the ASCII spelling of the binary message
 *      18 the shipped `resetFunc` frames for every non-GIII model), and `FRESET STANDARD` — the
 *      shipped `fresetFunc` sends message 20 with `target = STANDARD` and nothing else. A test that
 *      only checked "some FRESET was sent" would pass on `FRESET OEM`, which the original never
 *      sends, so the exact line and the absence of a second parameter are both asserted.
 *   2. **The copy** is the shipped English entry, read out of `01_解包/…/languageSupport/en.js`, not
 *      retyped here — a paraphrase would still look plausible in a screenshot.
 *   3. **The gates.** Restart needs its confirmation click; Factory Reset starts disabled and only
 *      opens when the model the receiver itself reports is typed in. With no live link neither can
 *      send, because `/api/live/command` answers "not connected" rather than queueing.
 *   4. **The wait is a pure machine** — drop → session back → VERSION #37 — and `done`/`failed` are
 *      terminal. "A failure is never retried" is therefore a property of the machine, not a promise
 *      the panel makes; the tests try every event after a failure and the state does not move.
 *   5. **The panel is only wiring**: the dialog's action starts `disabled`, both menu entries exist,
 *      and the VERSION read-back is the shipped `LOG VERSIONB` form, sent once.
 *
 * No receiver is involved: the Factory Reset line is verified as a string only, and this file never
 * claims a reset was executed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  CLEAR_LUA_LINES,
  NO_LINK_NOTE,
  RESET_ACTIONS,
  RESET_TIMING,
  RESET_VERIFY_LINE,
  normalizeModel,
  resetBegin,
  resetCommands,
  resetCopy,
  resetGate,
  resetObserve,
  resetPhaseText,
  resetReconnectBody,
} from '../src/web/panels/manage.js';

const here = dirname(fileURLToPath(import.meta.url));

function appRoot(): string {
  let directory = resolve(here, '../../..');
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, '01_解包', 'app', 'view');
    if (existsSync(candidate)) return join(directory, '01_解包', 'app');
    directory = resolve(directory, '..');
  }
  throw new Error('01_解包/app not found above ' + here);
}

/** One key of the shipped English dictionary, as the original's `__()` would see it. */
function shippedEnglish(key: string): string {
  const file = join(appRoot(), 'view', 'languageSupport', 'en.js');
  const text = readFileSync(file, 'utf8');
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  assert.ok(match, `${key} is in the shipped dictionary`);
  return match[1];
}

const LINK = { connected: true, session: '2026-11-02T10:00:00.000Z', target: 'TCP 127.0.0.1:3001' };
const NO_LINK = { connected: false, session: '', target: null };

/* ---------------------------------------------------------------- command strings ---- */

test('Restart sends RESET with no argument — the ASCII form of the shipped message 18', () => {
  assert.equal(RESET_ACTIONS.restart.command, 'RESET');
  assert.deepEqual(resetCommands('restart'), ['RESET']);
  // The GIII branch appends its own newline to a serial write; a `/api/live/command` line carries
  // the command only, and the server adds the terminator.
  assert.ok(!resetCommands('restart')[0].includes('\n'), 'the line has no terminator');
  assert.ok(!resetCommands('restart')[0].includes(' '), 'RESET takes no parameter');
});

test('Factory Reset sends FRESET STANDARD — the one target the shipped fresetFunc frames', () => {
  assert.equal(RESET_ACTIONS.factoryReset.command, 'FRESET STANDARD');
  assert.deepEqual(resetCommands('factoryReset'), ['FRESET STANDARD']);
  const line = resetCommands('factoryReset')[0];
  // Message 20 carries exactly one parameter, `target`; STANDARD is enum 0 in the shipped table.
  assert.equal(line.split(/\s+/).length, 2, 'exactly one argument');
  assert.match(line, /^FRESET STANDARD$/);
  for (const invented of ['FRESET OEM', 'FRESET COMMAND', 'FRESET GPSALMANAC', 'FRESET USER_ACCOUNTS']) {
    assert.notEqual(line, invented, 'no target the original does not send');
  }
});

test('the erase-NVM tick prepends the shipped SOFTLOAD series, in order', () => {
  assert.equal(CLEAR_LUA_LINES.length, 6);
  assert.equal(CLEAR_LUA_LINES[0], 'SOFTLOADRESET');
  assert.equal(CLEAR_LUA_LINES[CLEAR_LUA_LINES.length - 1], 'SOFTLOADCOMMIT');
  assert.match(CLEAR_LUA_LINES[1], /^SOFTLOADSREC "S0~P~M7QP,M7QPB,OEM718D/);
  assert.match(CLEAR_LUA_LINES[1], /OEM729,OEM729R,OEM729C,OEM729RC/);
  assert.match(CLEAR_LUA_LINES[4], /^SOFTLOADSREC "S30900000000FFFFFFFFFA"$/);
  for (const kind of ['restart', 'factoryReset']) {
    assert.deepEqual(resetCommands(kind, { eraseNvm: true }), [...CLEAR_LUA_LINES, RESET_ACTIONS[kind].command]);
  }
  // The default stays the one-line form: the erase series is opt-in, as `#erase-nvm` is.
  assert.deepEqual(resetCommands('factoryReset'), ['FRESET STANDARD']);
});

test('an unknown action yields no command at all', () => {
  assert.deepEqual(resetCommands('nope'), []);
  assert.equal(resetCopy('nope'), null);
  const gate = resetGate('nope', { link: LINK, confirmed: true });
  assert.equal(gate.ok, false);
  assert.equal(gate.line, '');
  assert.deepEqual(gate.lines, []);
});

/* ------------------------------------------------------------------------ the copy ---- */

test('the confirmation copy is the shipped language entry, word for word', () => {
  const restartBody = shippedEnglish('RECEIVERRESTART_1');
  const factoryBody = shippedEnglish('FRESETMESSAGE');

  // `%1` is the paragraph break the original substitutes (`<br> <br>`): the shipped string splits
  // into the statement and the question, and the panel prints exactly those two.
  const [restartStatement, restartQuestion] = restartBody.split('%1').map((part) => part.trim());
  const [factoryStatement, factoryQuestion] = factoryBody.split('%1').map((part) => part.trim());

  const copy = resetCopy('restart');
  assert.equal(copy?.title, shippedEnglish('RESTARTCONFIRMATION'));
  assert.equal(copy?.body, restartStatement);
  assert.equal(copy?.question, restartQuestion);
  assert.equal(copy?.command, 'RESET');
  assert.equal(copy?.needsModel, false);

  const freset = resetCopy('factoryReset');
  assert.equal(freset?.title, shippedEnglish('FACTORY_RESET_CONIFRM'));
  assert.equal(freset?.body, factoryStatement);
  assert.equal(freset?.question, factoryQuestion);
  assert.equal(freset?.command, 'FRESET STANDARD');
  assert.equal(freset?.needsModel, true);
});

/* ------------------------------------------------------------------------- the gate ---- */

test('Restart cannot leave without an explicit confirmation', () => {
  const refused = resetGate('restart', { link: LINK });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.lines, []);
  assert.match(refused.reason, /confirmation/);

  const loose = resetGate('restart', { link: LINK, confirmed: 'yes' });
  assert.equal(loose.ok, false, 'only a real boolean confirmation counts');

  const allowed = resetGate('restart', { link: LINK, confirmed: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.line, 'RESET');
  assert.deepEqual(allowed.lines, ['RESET']);
});

test('with no live link nothing is sent, and the note says why', () => {
  for (const kind of ['restart', 'factoryReset']) {
    const gate = resetGate(kind, {
      link: NO_LINK,
      confirmed: true,
      model: 'OEM729',
      typed: 'OEM729',
    });
    assert.equal(gate.ok, false, kind);
    assert.deepEqual(gate.lines, [], `${kind} sends no line`);
    assert.equal(gate.reason, NO_LINK_NOTE);
    assert.match(gate.reason, /not connected/);
  }
  assert.equal(resetGate('restart', { confirmed: true }).ok, false, 'a missing link object is a refusal');
});

test('Factory Reset is disabled until the receiver model is typed in', () => {
  // No model on the link: the token is never invented, so the action stays shut.
  const unknown = resetGate('factoryReset', { link: LINK, model: '', typed: 'OEM729' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /has not reported its model/);
  assert.deepEqual(unknown.lines, []);

  const untagged = resetGate('factoryReset', { link: LINK, model: 'OEM729', typed: '' });
  assert.equal(untagged.ok, false);
  assert.match(untagged.reason, /Type OEM729/);

  const wrong = resetGate('factoryReset', { link: LINK, model: 'OEM729', typed: 'OEM718D' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /Type OEM729/);
  assert.deepEqual(wrong.lines, []);

  const partial = resetGate('factoryReset', { link: LINK, model: 'OEM729', typed: 'OEM72' });
  assert.equal(partial.ok, false, 'a prefix is not the model');

  const ok = resetGate('factoryReset', { link: LINK, model: 'OEM729', typed: 'OEM729' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.lines, ['FRESET STANDARD']);

  // Typing is case- and space-insensitive: the receiver prints its own spelling, the user should
  // not lose a receiver over a trailing space.
  assert.equal(resetGate('factoryReset', { link: LINK, model: 'OEM729', typed: '  oem729 ' }).ok, true);
  assert.equal(normalizeModel('  oem729 '), 'OEM729');
});

/* ------------------------------------------------------------------- the wait, step by step ---- */

const T0 = 1_000_000;

function begin(kind: 'restart' | 'factoryReset' = 'restart', model = 'OEM729') {
  return resetBegin(kind, { at: T0, session: LINK.session, model });
}

test('a reset starts by waiting for the link to drop', () => {
  const state = begin();
  assert.equal(state.phase, 'awaiting-drop');
  assert.equal(state.deadline, T0 + RESET_TIMING.dropMs);
  assert.equal(state.session, LINK.session);
  assert.equal(state.expected, 'OEM729');
  assert.equal(state.verified, false);
});

test('drop → new session → VERSION #37 is the whole restart, and the model is read back', () => {
  let state = begin();
  state = resetObserve(state, { type: 'link', connected: false, session: '', at: T0 + 2000 });
  assert.equal(state.phase, 'awaiting-link');
  assert.equal(state.deadline, T0 + 2000 + RESET_TIMING.reconnectMs);

  state = resetObserve(state, {
    type: 'link',
    connected: true,
    session: '2026-11-02T10:00:20.000Z',
    at: T0 + 12000,
  });
  assert.equal(state.phase, 'awaiting-version');
  assert.equal(state.deadline, T0 + 12000 + RESET_TIMING.versionMs);
  assert.equal(state.session, '2026-11-02T10:00:20.000Z', 'the new session is remembered');

  state = resetObserve(state, { type: 'version', model: 'OEM729', at: T0 + 14000 });
  assert.equal(state.phase, 'done');
  assert.equal(state.verified, true);
  assert.equal(state.model, 'OEM729');
  assert.match(resetPhaseText(state).text, /Restarted — VERSION \(#37\) reads OEM729/);
  assert.equal(resetPhaseText(state).tone, 'good');
});

test('a different model coming back is reported, not swallowed', () => {
  let state = begin();
  state = resetObserve(state, { type: 'link', connected: false, at: T0 + 1000 });
  state = resetObserve(state, { type: 'link', connected: true, session: 'new', at: T0 + 2000 });
  state = resetObserve(state, { type: 'version', model: 'OEM718D', at: T0 + 3000 });
  assert.equal(state.phase, 'done');
  assert.equal(state.verified, false);
  assert.equal(resetPhaseText(state).tone, 'warn');
  assert.match(resetPhaseText(state).text, /OEM718D/);
});

test('a reboot that finished between two polls still counts (session id changed, link never seen down)', () => {
  let state = begin();
  state = resetObserve(state, { type: 'link', connected: true, session: LINK.session, at: T0 + 900 });
  assert.equal(state.phase, 'awaiting-drop', 'the same session is not a reboot');

  state = resetObserve(state, { type: 'link', connected: true, session: 'brand-new', at: T0 + 1800 });
  assert.equal(state.phase, 'awaiting-version');
});

test('the reconnect may land on the very first poll after the drop', () => {
  let state = begin();
  state = resetObserve(state, { type: 'link', connected: false, at: T0 + 1000 });
  state = resetObserve(state, { type: 'link', connected: true, session: 's2', at: T0 + 1000 });
  state = resetObserve(state, { type: 'version', model: '', at: T0 + 1100 });
  assert.equal(state.phase, 'done');
  assert.equal(state.verified, false, 'a VERSION without a model proves less, and says so');
  assert.match(resetPhaseText(state).text, /not |came back/i);
});

test('each phase has its own timeout, with a reason the dialog can print', () => {
  const cases: Array<[string, (s: ReturnType<typeof begin>) => ReturnType<typeof begin>, RegExp]> = [
    ['awaiting-drop', (s) => s, /never dropped/],
    [
      'awaiting-link',
      (s) => resetObserve(s, { type: 'link', connected: false, at: T0 + 1000 }),
      /did not come back/,
    ],
    [
      'awaiting-version',
      (s) =>
        resetObserve(
          resetObserve(s, { type: 'link', connected: false, at: T0 + 1000 }),
          { type: 'link', connected: true, session: 's2', at: T0 + 2000 },
        ),
      /VERSION \(#37\) never arrived/,
    ],
  ];
  for (const [phase, build, reason] of cases) {
    const state = build(begin());
    assert.equal(state.phase, phase);
    const before = resetObserve(state, { type: 'tick', at: state.deadline - 1 });
    assert.equal(before.phase, phase, `${phase} is still waiting one millisecond before its deadline`);
    const timedOut = resetObserve(state, { type: 'tick', at: state.deadline });
    assert.equal(timedOut.phase, 'failed', phase);
    assert.match(timedOut.reason, reason);
    assert.match(resetPhaseText(timedOut).text, /Nothing is retried automatically/);
    assert.equal(resetPhaseText(timedOut).tone, 'bad');
  }
});

test('a refused POST is a failure, not a silent wait', () => {
  const state = resetObserve(begin(), { type: 'error', reason: 'not connected', at: T0 + 10 });
  assert.equal(state.phase, 'failed');
  assert.match(resetPhaseText(state).text, /not connected/);
});

test('done and failed are terminal: nothing re-sends, nothing re-opens', () => {
  const failed = resetObserve(begin(), {
    type: 'error',
    reason: 'POST failed',
    at: T0 + 1,
  });
  for (const event of [
    { type: 'tick', at: T0 + 10_000_000 },
    { type: 'link', connected: false, at: T0 + 20 },
    { type: 'link', connected: true, session: 's3', at: T0 + 30 },
    { type: 'version', model: 'OEM729', at: T0 + 40 },
    { type: 'error', reason: 'again', at: T0 + 50 },
  ]) {
    assert.equal(resetObserve(failed, event), failed, `${event.type} cannot revive a failed reset`);
  }

  let done = begin();
  done = resetObserve(done, { type: 'link', connected: false, at: T0 + 1000 });
  done = resetObserve(done, { type: 'link', connected: true, session: 's2', at: T0 + 2000 });
  done = resetObserve(done, { type: 'version', model: 'OEM729', at: T0 + 3000 });
  assert.equal(done.phase, 'done');
  for (const event of [
    { type: 'tick', at: T0 + 10_000_000 },
    { type: 'link', connected: false, at: T0 + 4000 },
    { type: 'version', model: 'OEM729', at: T0 + 5000 },
  ]) {
    assert.equal(resetObserve(done, event), done, `${event.type} cannot re-open a finished reset`);
  }
});

test('the VERSION read-back is the shipped VERSIONB log, one shot', () => {
  // `deviceRestart.js:80` subscribes to `LOG  VERSIONB ONTIME 1` right before the reset; the
  // read-back here is the same log asked once, never a stream.
  assert.equal(RESET_VERIFY_LINE, 'LOG VERSIONB ONCE');
  assert.ok(!/ONTIME/.test(RESET_VERIFY_LINE), 'no continuous stream is left behind');
});

test('Factory Reset keeps its own wording once the receiver is back', () => {
  let state = resetBegin('factoryReset', { at: T0, session: LINK.session, model: 'OEM729' });
  state = resetObserve(state, { type: 'link', connected: false, at: T0 + 1000 });
  state = resetObserve(state, { type: 'link', connected: true, session: 's2', at: T0 + 2000 });
  state = resetObserve(state, { type: 'version', model: 'OEM729', at: T0 + 3000 });
  const text = resetPhaseText(state).text;
  assert.match(text, /Factory reset sent/);
  // The read-back proves the receiver restarted — it does not prove the defaults were restored,
  // and the dialog must not pretend otherwise.
  assert.match(text, /does not prove every setting was cleared/);
});

/* ---------------------------------------------------------------------------- wiring ---- */

const source = readFileSync(join(here, '..', 'src', 'web', 'panels', 'manage.js'), 'utf8');

test('the Device menu carries both fixed actions, wired', () => {
  assert.match(
    source,
    /\{ key: 'restart', label: RESET_ACTIONS\.restart\.menuLabel, wired: true \}/,
    'Restart… is a Device menu leaf',
  );
  assert.match(
    source,
    /\{ key: 'factoryReset', label: RESET_ACTIONS\.factoryReset\.menuLabel, wired: true \}/,
    'Factory Reset… is a Device menu leaf',
  );
  assert.match(source, /else if \(key === 'restart'\) openResetDialog\('restart'\)/);
  assert.match(source, /else if \(key === 'factoryReset'\) openResetDialog\('factoryReset'\)/);
});

test('both destructive actions go through the one gate, once per click', () => {
  // The only place a reset is posted is `sendReset`, and it posts `gate.lines` — the array the gate
  // builds. No other call site can invent a reset line.
  const sendBody = source.split('async function sendReset()')[1] ?? '';
  assert.ok(sendBody.includes('for (const line of gate.lines)'), 'the gate owns the lines');
  assert.ok(!/resetCommands\(/.test(sendBody), 'sendReset never assembles a command by hand');
  // Three posts in the whole panel: the Terminal, the reset itself, and the one-shot VERSION
  // read-back — the last one only ever carries `RESET_VERIFY_LINE`.
  assert.equal(
    (source.match(/api\.post\('\/api\/live\/command'/g) ?? []).length,
    3,
    'Terminal + reset + read-back, and nothing else posts a line',
  );
  const verifyBody = source.split('async function sendVerifyLine()')[1] ?? '';
  assert.match(verifyBody, /\{ line: RESET_VERIFY_LINE \}/, 'the read-back line is the constant');
});

test('the dialog starts disabled and its confirm button is not wired to a shortcut', () => {
  assert.match(source, /data-reset="go" disabled>Restart device</, 'the action starts disabled');
  assert.match(source, /data-reset="typeWrap" hidden/, 'the model input is hidden for Restart');
  assert.match(source, /resetEls\.go\.disabled = finished \? false : !gate\.ok/);
  // No key handler on the reset dialog: Enter in the model field cannot send a factory reset.
  assert.ok(!/data-reset[^\n]*keydown/.test(source), 'no keyboard shortcut sends a reset');
});

test('the factory-reset token comes from the live session, never from a capture', () => {
  // The capture header has a Model field too, and using it would mean confirming a factory reset
  // with the name of a file that is not connected to anything.
  const body = (source.split('function liveModel()')[1] ?? '').split('\n  }')[0];
  assert.ok(body.includes('live.latest.get(VERSION_LOG)'), 'reads the live VERSION record');
  assert.ok(!body.includes('state.version'), 'a replayed capture cannot supply the token');
});

test('auto-reconnect parses the two status-target shapes and refuses anything else', () => {
  assert.deepEqual(resetReconnectBody('tcp://100.120.149.8:4002'), {
    kind: 'tcp', host: '100.120.149.8', port: 4002,
  });
  assert.deepEqual(resetReconnectBody('udp://127.0.0.1:3001'), {
    kind: 'udp', host: '127.0.0.1', port: 3001,
  });
  assert.deepEqual(resetReconnectBody('COM10 @ 115200'), {
    kind: 'serial', path: 'COM10', baud: 115200,
  });
  assert.equal(resetReconnectBody(''), null);
  assert.equal(resetReconnectBody('something else'), null);
});
