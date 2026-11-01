/**
 * Tools ▸ Interference Toolkit (§2.2.9) — the **write** half: six commands, their data maps, the
 * final ASCII line each Apply frames, and the read-back that follows.
 *
 * The oracle for every string is the shipped controller plus the manual:
 *
 *  - the data maps are `interferenceToolKit.js`'s own (`frameitDetectConfigCommand` :5960,
 *    `frameItSpectralAnalysisDataMap` :3211, `frameItProgFiltConfigDataMap` :3260,
 *    `frameItBandPassConfigDataMap` :3312, `frameItFrontEndModeDataMap` :3361), field for field;
 *  - the tokens are `NovatelIdConstants.js#commandsAndEnums` (the enum tables the shipped page
 *    indexes at `genericConfig.js:176`) and the manual's syntax (`§2.73`–`§2.78`);
 *  - the space-separated, upper-case form is the one this receiver answered `<OK` to on
 *    2026-11-01 (`03_分析/01_Manage主界面与视图层.md` §13.1: `ITWARNINGCONFIG 1`,
 *    `ITDETECTCONFIG ALL`, `ITSPECTRALANALYSIS PREDECIMATION GPSL2 1000 1K 1 1`), and the originals
 *    read back out of `b1-20261101.sbf`'s own `LOG RXCONFIGA ONCE` dump are
 *    `#ITWARNINGCONFIGA,…;3,0`, `#ITDETECTCONFIGA,…;ALL,0,0,0`,
 *    `#ITSPECTRALANALYSISA,…;PREDECIMATION,GPSL1,200,2K,1,1`, which is exactly what the page parses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ConfigHost } from '../src/config-host.ts';
import {
  applyConfigEvent,
  configLogRequests,
  feedConfigFromEntries,
} from '../src/config-http.ts';
import {
  ITK_RECORDS,
  emptyItkReport,
  frameItBandPassConfigDataMap,
  frameItDetectConfigCommand,
  frameItFrontEndModeDataMap,
  frameItProgFiltConfigDataMap,
  frameItSpectralAnalysisDataMap,
  frameItWarningConfigCommand,
  itkCommandsFor,
  itkCommandLine,
  itkFloatToken,
  itkReadbackRequest,
  itkRecordOf,
  itkReportApply,
  configLines,
  type ItkWriteValues,
} from '../../view/src/config/index.ts';

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

const options = () => ({
  appRoot: appRoot(),
  dataDir: join(here, '..', '..', 'protocol', 'data'),
});

/** Every control at a known value, so an Apply's string depends on nothing but the code. */
const VALUES: ItkWriteValues = {
  detectPath: 'ALL',
  warningLevel: '1',
  spectral: {
    mode: 'PREDECIMATION',
    frequency: 'GPSL2',
    updatePeriod: 1000,
    fftSize: '1K',
    timeAvg: 1,
    subCarrierAvg: 1,
  },
  frontEnd: { frequencyBand: 'LBAND', mode: 'HDR' },
  bandpass: { frequency: 'GPSL5', filterSwitch: 'ENABLE', cutOffFrequency: 1165.975 },
  progFilter: {
    frequency: 'GPSL1',
    filterId: 'PF0',
    filterSwitch: 'ENABLE',
    filterMode: 'NOTCHFILTER',
    cutOffFrequency: 1580,
    notchWidth: 1,
  },
};

/* ------------------------------------------------------------------ the maps, field for field */

test('ITDETECTCONFIG: the shipped map is the RF path plus three reserved words', () => {
  assert.deepEqual(frameItDetectConfigCommand('ALL'), [
    { rfpath: ['ALL', 'enum', 4] },
    { r1: [0, 'ulong', 4] },
    { r2: [0, 'ulong', 4] },
    { r3: [0, 'ulong', 4] },
  ]);
  assert.equal(
    itkCommandLine('ITDETECTCONFIG', frameItDetectConfigCommand('NONE')),
    'ITDETECTCONFIG NONE 0 0 0',
    'the reserved words are printed, and the enum token is upper-case',
  );
});

test('ITWARNINGCONFIG: one level, no invented fields', () => {
  assert.deepEqual(frameItWarningConfigCommand(1), [{ level: [1, 'ulong', 4] }]);
  assert.equal(itkCommandLine('ITWARNINGCONFIG', frameItWarningConfigCommand('1')), 'ITWARNINGCONFIG 1');
  for (const level of ['0', '1', '2', '3']) {
    assert.equal(
      itkCommandLine('ITWARNINGCONFIG', frameItWarningConfigCommand(level)),
      `ITWARNINGCONFIG ${level}`,
    );
  }
});

test('ITSPECTRALANALYSIS: mode, frequency, period, FFT size, time avg, subcarrier avg', () => {
  assert.deepEqual(frameItSpectralAnalysisDataMap(VALUES.spectral as never), [
    { mode: ['PREDECIMATION', 'enum', 4] },
    { frequency: ['GPSL2', 'enum', 4] },
    { updatePeriod: [1000, 'ulong', 4] },
    { fftSize: ['1K', 'enum', 4] },
    { timeAvg: [1, 'ulong', 4] },
    { subCarrierAvg: [1, 'ulong', 4] },
  ]);
  assert.equal(
    itkCommandLine('ITSPECTRALANALYSIS', frameItSpectralAnalysisDataMap(VALUES.spectral as never)),
    'ITSPECTRALANALYSIS PREDECIMATION GPSL2 1000 1K 1 1',
    'the manual’s own example shape (§2.77), with this build’s values',
  );
});

test('ITPROGFILTCONFIG: frequency, filter, switch, mode, cutoff, notch width', () => {
  assert.deepEqual(frameItProgFiltConfigDataMap(VALUES.progFilter as never), [
    { frequency: ['GPSL1', 'enum', 4] },
    { filterId: ['PF0', 'enum', 4] },
    { filterSwitch: ['ENABLE', 'enum', 4] },
    { filterMode: ['NOTCHFILTER', 'enum', 4] },
    { cutOffFrequency: [1580, 'float', 4] },
    { notchWidth: [1, 'float', 4] },
  ]);
  assert.equal(
    itkCommandLine('ITPROGFILTCONFIG', frameItProgFiltConfigDataMap(VALUES.progFilter as never)),
    'ITPROGFILTCONFIG GPSL1 PF0 ENABLE NOTCHFILTER 1580 1',
    'the manual’s ASCII example (§2.76)',
  );
});

test('ITBANDPASSCONFIG: frequency, switch, cutoff', () => {
  assert.deepEqual(frameItBandPassConfigDataMap(VALUES.bandpass as never), [
    { frequency: ['GPSL5', 'enum', 4] },
    { filterSwitch: ['ENABLE', 'enum', 4] },
    { cutOffFrequency: [1165.975, 'float', 4] },
  ]);
  assert.equal(
    itkCommandLine('ITBANDPASSCONFIG', frameItBandPassConfigDataMap(VALUES.bandpass as never)),
    'ITBANDPASSCONFIG GPSL5 ENABLE 1165.975',
    'the manual’s ASCII example (§2.73)',
  );
});

test('ITFRONTENDMODE: frequency band and mode', () => {
  assert.deepEqual(frameItFrontEndModeDataMap(VALUES.frontEnd as never), [
    { frequencyBand: ['LBAND', 'enum', 4] },
    { mode: ['HDR', 'enum', 4] },
  ]);
  assert.equal(
    itkCommandLine('ITFRONTENDMODE', frameItFrontEndModeDataMap(VALUES.frontEnd as never)),
    'ITFRONTENDMODE LBAND HDR',
    'LBand is the shipped enum name; the ASCII token the manual prints is LBAND',
  );
});

test('the stop is the shipped page’s own ITSPECTRALANALYSIS OFF', () => {
  assert.deepEqual(itkCommandsFor('spectralStop', VALUES), [
    { line: 'ITSPECTRALANALYSIS OFF', readback: 'LOG ITSPECTRALANALYSISB ONCE' },
  ]);
});

test('every Apply is followed by the read-back request for its own record', () => {
  const expected: Record<string, string> = {
    detect: 'ITDETECTCONFIG',
    warning: 'ITWARNINGCONFIG',
    spectral: 'ITSPECTRALANALYSIS',
    spectralStop: 'ITSPECTRALANALYSIS',
    hdr: 'ITFRONTENDMODE',
    bandpass: 'ITBANDPASSCONFIG',
    progFilter: 'ITPROGFILTCONFIG',
  };
  for (const [section, name] of Object.entries(expected)) {
    const commands = itkCommandsFor(section as never, VALUES);
    assert.equal(commands.length, 1, `${section}: one write`);
    assert.equal(commands[0].readback, `LOG ${name}B ONCE`, `${section}: reads its own record back`);
    assert.equal(commands[0].readback, itkReadbackRequest(name));
  }
  assert.equal(ITK_RECORDS.length, 6, 'six records, six commands');
  assert.deepEqual(
    ITK_RECORDS.map((record) => record.messageId),
    [2143, 2289, 1967, 2039, 1999, 2000],
  );
});

test('numbers are printed the way the receiver parses them: no exponent, no -0, no padding', () => {
  assert.equal(itkFloatToken(1165.975), '1165.975');
  assert.equal(itkFloatToken(1580), '1580');
  assert.equal(itkFloatToken(0), '0');
  assert.equal(itkFloatToken(-0), '0');
  assert.equal(itkFloatToken('1.000000'), '1');
  assert.equal(itkFloatToken(0.0000001), '0', 'below a millionth is not printed as 1e-7');
  assert.throws(() => itkFloatToken('abc'), /not a number/);
  assert.equal(
    itkCommandLine('ITBANDPASSCONFIG', frameItBandPassConfigDataMap({ cutOffFrequency: '1165.9750' })),
    'ITBANDPASSCONFIG GPSL5 ENABLE 1165.975',
    'the UI may hand over a padded string; the line does not keep the padding',
  );
});

/* -------------------------------------------------------------------------- the page's Apply */

test('each Apply button frames the exact line and asks for the read-back', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');

  const warn = applyConfigEvent('interferenceToolkit', '#itk-warning-level', { value: '1' });
  assert.equal(warn.applied, true);
  assert.equal(warn.commands.length, 0, 'choosing a level frames nothing');

  const applied = applyConfigEvent('interferenceToolkit', '#itk-apply-warning', { click: true });
  assert.deepEqual(
    applied.commands.map((command) => command.text),
    ['ITWARNINGCONFIG 1', 'LOG ITWARNINGCONFIGB ONCE'],
  );
  assert.ok(
    applied.commands.every((command) => command.kind === 'ascii'),
    'abbreviated ASCII is what the receiver’s parser takes',
  );
  assert.match(applied.shell, /Last framed: ITWARNINGCONFIG 1 · LOG ITWARNINGCONFIGB ONCE/);
});

test('the six buttons produce the six strings, from the controls’ own values', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');

  const cases: Array<[string, string, string]> = [
    ['#itk-detect-path', 'L1', 'ITDETECTCONFIG L1 0 0 0'],
    ['#itk-warning-level', '0', 'ITWARNINGCONFIG 0'],
    ['#itk-hdr-band', 'L2', 'ITFRONTENDMODE L2 CIC3'],
    ['#itk-bandpass-frequency', 'GPSL1', 'ITBANDPASSCONFIG GPSL1 ENABLE 0'],
    ['#itk-progfilt-id', 'PF1', 'ITPROGFILTCONFIG GPSL1 PF1 DISABLE NOTCHFILTER 0 0'],
  ];
  const applyFor: Record<string, string> = {
    '#itk-detect-path': '#itk-apply-detect',
    '#itk-warning-level': '#itk-apply-warning',
    '#itk-hdr-band': '#itk-apply-hdr',
    '#itk-bandpass-frequency': '#itk-apply-bandpass',
    '#itk-progfilt-id': '#itk-apply-progfilt',
  };
  for (const [control, value, line] of cases) {
    applyConfigEvent('interferenceToolkit', control, { value });
    const applied = applyConfigEvent('interferenceToolkit', applyFor[control], { click: true });
    assert.equal(applied.commands[0]?.text, line, `${control}=${value}`);
  }

  /* The spectral group has its own two buttons: Start writes the six fields, Stop writes OFF. */
  applyConfigEvent('interferenceToolkit', '#itk-spectral-frequency', { value: 'GPSL2' });
  const start = applyConfigEvent('interferenceToolkit', '#itk-apply-spectral', { click: true });
  assert.equal(start.commands[0]?.text, 'ITSPECTRALANALYSIS PREDECIMATION GPSL2 200 2K 10 5');
  const stop = applyConfigEvent('interferenceToolkit', '#itk-apply-spectral-stop', { click: true });
  assert.equal(stop.commands[0]?.text, 'ITSPECTRALANALYSIS OFF');
});

test('without a live link the page says the lines were framed but not sent', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  const applied = applyConfigEvent(
    'interferenceToolkit',
    '#itk-apply-spectral-stop',
    { click: true },
    { connected: false, sent: 0 },
  );
  assert.equal(applied.commands.length, 2, 'the write and its read-back are both framed');
  assert.match(String(applied.note), /2 command\(s\) were framed by this page but not sent/);
  assert.match(String(applied.note), /no live receiver session/);
});

test('a value outside the receiver’s range is refused before anything is framed', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');

  applyConfigEvent('interferenceToolkit', '#itk-spectral-period', { value: '5' });
  const refused = applyConfigEvent('interferenceToolkit', '#itk-apply-spectral', { click: true });
  assert.deepEqual(refused.commands, [], 'nothing reaches the transport');
  assert.match(
    refused.shell,
    /Not sent: Spectrum update period must be 50\.\.100000 \(got 5\)/,
    'and the page says which field and which range',
  );

  applyConfigEvent('interferenceToolkit', '#itk-spectral-timeavg', { value: '51' });
  applyConfigEvent('interferenceToolkit', '#itk-spectral-period', { value: '200' });
  const tooLong = applyConfigEvent('interferenceToolkit', '#itk-apply-spectral', { click: true });
  assert.deepEqual(tooLong.commands, []);
  assert.match(tooLong.shell, /Time averaging must be 0\.\.50 \(got 51\)/);

  applyConfigEvent('interferenceToolkit', '#itk-spectral-timeavg', { value: '1' });
  const accepted = applyConfigEvent('interferenceToolkit', '#itk-apply-spectral', { click: true });
  assert.equal(accepted.commands.length, 2, 'and the same group still applies once it is valid');
});

test('the receiver’s <ERROR is shown with its own words, not swallowed', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  applyConfigEvent('interferenceToolkit', '#itk-apply-warning', { click: true });

  const failed = applyConfigEvent('interferenceToolkit', '#itk-command-reply', {
    value: '<ERROR:Message is invalid for this model',
  });
  assert.match(failed.shell, /Receiver: &lt;ERROR:Message is invalid for this model/);
  assert.match(failed.shell, /data-itk-reply-error="1"/, 'and is marked as a failure');

  const ok = applyConfigEvent('interferenceToolkit', '#itk-command-reply', { value: '<OK' });
  assert.match(ok.shell, /Receiver: &lt;OK/);
  assert.equal(/data-itk-reply-error="1"/.test(ok.shell), false, 'a success clears the mark');
});

/* ------------------------------------------------------------------------ the read-back */

test('a read-back record fills the table and the controls, and says it is live', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');

  // `b1-20261101.sbf`'s own `LOG RXCONFIGA ONCE` body for ITWARNINGCONFIG is `3,0`; 2 is a value
  // the Apply above could have written, and the page must follow whatever arrives.
  const warning = 'ITWARNINGCONFIGA,USB2,276,68.5,SATTIME,0,0.000,03801800,3ae4,18278;2,0*75d69af9';
  const detect = 'ITDETECTCONFIGA,SPECIAL,174,71.0,UNKNOWN,0,2.090,03800800,c942,18278;NONE,0,0,0*ce59cb72';
  const spectral =
    'ITSPECTRALANALYSISA,SPECIAL,55,71.0,UNKNOWN,0,2.355,03800800,73eb,18278;' +
    'POSTDECIMATION,GPSL5,500,4K,20,1*335a68f4';
  assert.equal(host.feedItkRecord(2289, warning), true, 'the warning record was read');
  assert.equal(host.feedItkRecord(2143, detect), true, 'so was the detection switch');
  assert.equal(host.feedItkRecord(1967, spectral), true, 'and the spectral settings');

  const html = host.elementHtml('#itk-config') ?? '';
  assert.match(
    html,
    /<td class="itk-config-item">Warning level<\/td><td class="itk-config-value">2<\/td><td class="itk-config-source">ITWARNINGCONFIG \(#2289\) level · live read-back<\/td>/,
  );
  assert.match(html, /<td class="itk-config-value">NONE<\/td>/, 'the detection switch followed');
  assert.match(html, /<td class="itk-config-value">POSTDECIMATION<\/td>/);
  assert.match(html, /<td class="itk-config-value">GPSL5<\/td>/);
  assert.match(html, /<td class="itk-config-value">500<\/td>/);
  assert.match(html, /<td class="itk-config-value">4K<\/td>/);
  assert.match(html, /<td class="itk-config-value">20<\/td>/);

  const controls = host.elementHtml('#itk-write') ?? '';
  assert.match(
    controls,
    /<option value="2" selected="">2<\/option>/,
    'the warning level control sits on the value the receiver reported',
  );
  assert.match(
    host.html(),
    /3 configuration record\(s\) read back from the receiver: ITDETECTCONFIG, ITWARNINGCONFIG, ITSPECTRALANALYSIS\./,
  );
});

test('the live link’s own entry stream is what feeds that read-back', () => {
  // `LOG ITWARNINGCONFIGB ONCE` answers with a decoded record whose rendered line is exactly this
  // (`live.ts#renderAscii`, measured on the desk OEM729 2026-11-02); `server.ts` hands the entries to
  // `feedConfigFromEntries`, which must route the `IT*CONFIG` ids to the page even though
  // `configSliceOf` has no branch for them.
  const fed = feedConfigFromEntries([
    {
      messageId: 2289,
      ascii: '#ITWARNINGCONFIGA,SPECIAL,0,75.5,COARSESTEERING,2443,42138.863,03800800,3ae4,18278;1,0*243066ec',
    },
    { messageId: 42, ascii: 'SOL_COMPUTED,SINGLE,30.5,114.3,63.2,-14.4,WGS84,0.0,0.0,0.0,0' },
  ]);
  assert.equal(fed, 1, 'the ITK record was fed; the BESTPOS line is not this page’s');
  const shell = applyConfigEvent('interferenceToolkit', '#itk-refresh', {}).shell;
  assert.match(shell, /<td class="itk-config-value">1<\/td>/, 'the page shows the level just read back');
});

test('the three lead-ins the receiver uses all parse: <, # and abbreviated ASCII', () => {
  const expected = { level: '3' };
  for (const line of [
    'ITWARNINGCONFIGA,USB2,276,68.5,SATTIME,0,0.000,03801800,3ae4,18278;3,0*75d69af9',
    '#ITWARNINGCONFIGA,SPECIAL,0,75.5,COARSESTEERING,2443,42138.863,03800800,3ae4,18278;3,0*243066ec',
    '<ITWARNINGCONFIG 3 0',
  ]) {
    const record = itkRecordOf(2289, line);
    assert.ok(record, line);
    assert.equal(record.body[0], expected.level, line);
  }
});

test('ITFRONTENDMODE is per band: the record names its band and keeps the other bands', () => {
  const reported = [
    'ITFRONTENDMODEA,USB2,1,0.0,UNKNOWN,0,0.000,00000000,0000,0;L1,0*1111',
    'ITFRONTENDMODEA,USB2,2,0.0,UNKNOWN,0,0.000,00000000,0000,0;L2,1*2222',
  ].reduce((accumulated, line) => {
    const record = itkRecordOf(2039, line);
    assert.ok(record, 'the line is an ITFRONTENDMODE record');
    return itkReportApply(accumulated, record);
  }, emptyItkReport());
  assert.deepEqual(reported.frontEnd, [
    { band: 'L1', mode: 'CIC3' },
    { band: 'L2', mode: 'HDR' },
  ]);
  const rows = configLines(undefined, reported);
  const hdr = rows.find((row) => row[0] === 'Enable HDR Mode');
  assert.equal(hdr?.[1], 'L1 CIC3 · L2 HDR');
  assert.match(String(hdr?.[2]), /live read-back/);
});

test('the page asks for the records this model answers, and not for the three it refuses', () => {
  // Measured 2026-11-02 on the desk OEM729: `LOG ITFRONTENDMODEB|ITBANDPASSCONFIGB|
  // ITPROGFILTCONFIGB ONCE` answer `<ERROR:Message is invalid for this model`, so opening the page
  // does not put three errors on the link.
  assert.deepEqual(configLogRequests('interferenceToolkit'), [
    'LOG ITDETECTCONFIGB ONCE',
    'LOG ITWARNINGCONFIGB ONCE',
    'LOG ITSPECTRALANALYSISB ONCE',
  ]);
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  assert.deepEqual(
    host.requiredLogs('interferenceToolkit').map((request) => request.name),
    ['ITDETECTCONFIG', 'ITWARNINGCONFIG', 'ITSPECTRALANALYSIS'],
  );
  /* A write still asks for its own record: on a receiver that answers, the page fills from it. */
  assert.equal(
    itkCommandsFor('hdr', VALUES)[0].readback,
    'LOG ITFRONTENDMODEB ONCE',
    'ITFRONTENDMODE is still read back after it is written',
  );
  assert.equal(ITK_RECORDS.length, 6, 'all six records stay in the page’s own table');
});

test('a line that is not one of the six records is refused, not guessed at', () => {
  assert.equal(itkRecordOf(2289, 'ITDETECTCONFIGA,USB2,1,0.0,UNKNOWN,0,0,0,0,0;ALL,0,0,0'), undefined);
  assert.equal(itkRecordOf(1234, 'ITWARNINGCONFIG 3'), undefined);
  assert.equal(itkRecordOf(2289, ''), undefined);
  assert.equal(itkRecordOf(2289, 'LOG ITWARNINGCONFIGB ONCE'), undefined);

  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  assert.equal(host.feedItkRecord(2289, 'SOMETHINGELSE 1,2'), false);
  assert.equal(host.feedItkRecord(2289, 'ITWARNINGCONFIG 0'), true, 'abbreviated ASCII parses too');
});

test('the detection list and its empty state are untouched by any of this', () => {
  const host = new ConfigHost(options());
  host.show('interferenceToolkit');
  const applied = applyConfigEvent('interferenceToolkit', '#itk-capture', {
    value: 'b7-20261101.sbf',
  });
  assert.equal((applied.shell.match(/<tr class="itk-detection-row/g) ?? []).length, 25);
  assert.match(applied.shell, /47 ITDETECTSTATUS record\(s\)/);
  assert.match(applied.shell, /38 carrying a detection/);
  /* The capture holds no `ITFRONTENDMODE`, and the page still says so rather than printing a zero. */
  assert.match(applied.shell, /Not in this capture, so shown as --: ITFRONTENDMODE/);
  /* The plot is still not drawn: its container and its Settings button stay hidden. */
  assert.match(applied.shell, /id="itk-settings"[^>]*style="display: none"/);
});
