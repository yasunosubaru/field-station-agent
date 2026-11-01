# ASCII only.
# B4 batch (batch 4 of the coverage sweep): the types no earlier capture has, measured on this OEM729.
#
# Measured 2026-11-01 with `b4-probe.ps1` (one LOG ... ONCE at a time, 1.5 s window, ids 41/42/43
# ignored because the port carries a permanent ~20 Hz RANGE stream):
#
#   refused - `<ERROR:Message is invalid for this model`: RTKPOSB, RTKVELB, MATCHEDPOSB, RTKXYZB,
#     RTKDOPB, RTKSATSB, RTKASSISTSTATUSB, MARK1PVAB, TILTSTATUSB. These are model-gated
#     (RTK / SPAN / dual-antenna firmware options this unit does not have).
#   refused - `<ERROR:Invalid Message. Field = 2` (the log name itself is unknown): GPSEPHEMERISB,
#     SBASRAWB, NAVSSATBITSB, ABSSATEPHEMERISB, SBAS45B, LBANDINFOB, RAWLBANDFRAMEB. Four of the
#     brief's names are not NovAtel log names at all - the dictionary spells them GPSEPHEM and
#     RAWSBASFRAME, and NAVSSATBITS / ABSSATEPHEMERIS do not exist anywhere in it.
#   accepted but silent for 30 s (41 names): GALFNAVEPHEMERISB, BDSBCNAV1EPHEMERISB, USERDATUMB,
#     THISANTENNATYPEB, BASEANTENNATYPEB, ANTENNATYPEB, MATCHEDXYZB, MASTERPOSB, ROVERPOSB,
#     HEADINGB, HEADING2B, HEADINGEXTB, HEADINGRATEB, MARK2TIMEB, MARK3TIMEB, MARK4TIMEB,
#     MARK2POSB, MARK3POSB, SBAS17B, SBAS25B, SBAS26B, SBAS27B, SBAS3B, RAWSBASFRAMEB,
#     RAWSBASFRAME2B, GPSCNAVRAWMESSAGEB, QZSSCNAVRAWMESSAGEB, GALINAVRAWWORDB, GALFNAVRAWPAGEB,
#     GALFNAVRAWEPHEMERISB, GALFNAVRAWALMANACB, GALCNAVRAWPAGEB, NAVICALMANACB, NAVICSYSCLOCKB,
#     NAVICEPHEMERISB, SAVEDSURVEYPOSITIONSB, SURVEYPOSITIONB, PROFILEB, PROFILEINFOB,
#     BDSBCNAV1RAWMESSAGEB, RAWCNAVFRAMEB.
#   the two EPHEMERIS logs are kept in the periodic group anyway - they cost one line each and
#     would prove a fix if the receiver ever starts decoding those signals.
#
# The phases exist because one port holds only about 32 active logs and a LOG past the limit is
# answered `<OK` and then never fires. Every phase starts from a bare UNLOGALL.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File b4-capture.ps1 -Port COM10 -Seconds 35 -Out C:\Temp\b4.sbf
#   powershell -ExecutionPolicy Bypass -File b4-capture.ps1 -ProbeOnly
#
# Cleanup is a bare `UNLOGALL` (the port-argument form takes the RECEIVER's port name, so
# `UNLOGALL COM10` does nothing).
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [int]$Seconds = 35,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b4.sbf',
  [int]$DrainSeconds = 3,
  [switch]$ProbeOnly
)

if ($ProbeOnly) {
  & (Join-Path $PSScriptRoot 'b4-probe.ps1') -Port $Port -Baud $Baud
  exit $LASTEXITCODE
}

# One record per line is enough for the static / identity families.
$phaseA = @(
  'UNDULATIONB ONCE', 'MAGVARB ONCE', 'DATUMB ONCE', 'AVEPOSB ONCE', 'TRACKSVB ONCE',
  'SATVISB ONCE', 'GLOALMANACB ONCE', 'QZSSALMANACB ONCE', 'QZSSIONUTCB ONCE', 'MARKTIMEB ONCE'
)
$phaseB = @(
  'MARK1TIMEB ONCE', 'TERRASTARINFOB ONCE', 'OCEANIXINFOB ONCE', 'VERIPOSINFOB ONCE',
  'PPPPOSB ONCE', 'PPPSATSB ONCE', 'PPPDOPB ONCE', 'PPPDOP2B ONCE', 'RADARSTATUSB ONCE',
  'AUTHCODESB ONCE'
)
$phaseC = @(
  'LOGLISTB ONCE', 'PTPDELTATIMEB ONCE', 'QZSSRAWALMANACB ONCE', 'GALINAVRAWALMANACB ONCE',
  'RXCONFIGUSERB ONCE'
)

# Repeating families: the raw pages and ephemerides fire as the receiver decodes them.
$periodic = @(
  'QZSSRAWEPHEMB ONTIME 1',
  'QZSSRAWSUBFRAMEB ONTIME 1',
  'QZSSRAWALMANACB ONTIME 1',
  'BDSBCNAV2RAWMESSAGEB ONTIME 1',
  'BDSBCNAV3RAWMESSAGEB ONTIME 1',
  'BDSBCNAV3EPHEMERISB ONTIME 1',
  'QZSSEPHEMERISB ONTIME 1',
  'GALINAVRAWALMANACB ONTIME 1',
  'GALFNAVEPHEMERISB ONTIME 1',
  'BDSBCNAV1EPHEMERISB ONTIME 1'
)

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300
$buf = New-Object byte[] 65536

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$fs = [System.IO.File]::Create($Out)
$total = 0
function Drain-For([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $have = $sp.BytesToRead
      if ($have -gt 0) {
        $n = $sp.Read($buf, 0, [Math]::Min($buf.Length, $have))
        if ($n -gt 0) { $script:fs.Write($buf, 0, $n); $script:total += $n }
      } else { Start-Sleep -Milliseconds 5 }
    } catch { Start-Sleep -Milliseconds 5 }
  }
}
function Unlog {
  $sp.Write("UNLOGALL`r`n")
  Start-Sleep -Milliseconds 250
  $sp.Write("UNLOGALL USB2`r`n")
  Start-Sleep -Milliseconds 250
}

# The port streams a historic backlog when it opens; the first record is usually cut in half and
# the deframer resyncs, which is exactly what the suite does too.
$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Drain-For ($DrainSeconds * 1000)

foreach ($phase in @($phaseA, $phaseB, $phaseC)) {
  Unlog
  Drain-For 500
  foreach ($c in $phase) { $sp.Write('LOG ' + $c + "`r`n"); Start-Sleep -Milliseconds 150 }
  Drain-For 5000
}

Unlog
Drain-For 500
foreach ($p in $periodic) { $sp.Write('LOG ' + $p + "`r`n"); Start-Sleep -Milliseconds 150 }
Drain-For ($Seconds * 1000)
$fs.Close()

Unlog
Drain-For 400
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
