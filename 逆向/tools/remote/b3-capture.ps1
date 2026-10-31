# ASCII only.
# B3 batch (batch 3 of the coverage sweep): the message families no earlier capture has had.
#
# What this batch is for - each entry is a shape the first two batches never exercised:
#   - %T, the millisecond counter printed as seconds with three decimals: GLORAWEPHEM, GALALMANAC,
#     GLOCLOCK / GALCLOCK (the GLO / GAL clocks), BDSCLOCK;
#   - %Z, a fixed-size blob as lowercase hex: GLORAWFRAME and GLORAWEPHEM (11 + a reserved byte per
#     element), GLORAWSTRING (11), BDSRAWNAVSUBFRAME and RAWGPSSUBFRAME (30);
#   - FIELD_ARRAY, an element count in front of a per-element struct: PSRDOP2, PSRTIME, PSRSATS;
#   - %id inside such an element: PSRSATS, SATXYZ2;
#   - enum + STRING in one record: J1939STATUS, SAFEMODESTATUS, REFSTATION;
#   - SHORT (%hd, BDSCLOCK, INSPVACMP has more but needs SPAN) and INT (%d, RAWGPSSUBFRAME) - the
#     integer widths the earlier batches never touched, which the reader used to fetch as one byte;
#   - the multi-definition ephemerides: BDSBCNAV2EPHEMERIS (%9.1lk / %0.10lk), GALINAVEPHEMERIS.
#
# Measured on this OEM729 with the probe pass (below), not guessed:
#   refused - `<ERROR:Message is invalid for this model`: FILESYSTEMSTATUS, FILESYSTEMCAPACITY,
#     FILESTATUS, FILETRANSFERSTATUS, RTKDOP, RTKDOP2, MATCHEDSATS;
#   accepted but silent for 30 s, both ONTIME and ONNEW, so left out of the list: GLORAWFRAME,
#     GLORAWSTRING, GALCLOCK, REFSTATION, RXSTATUSEVENT, BDSBCNAV1EPHEMERIS, GALFNAVEPHEMERIS,
#     GPSCNAVRAWMESSAGE, SBASALMANAC.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File b3-capture.ps1 -Port COM10 -Seconds 30 -Out C:\Temp\b3.sbf
#   powershell -NoProfile -ExecutionPolicy Bypass -File b3-capture.ps1 -Port COM10 -ProbeOnly -Out C:\Temp\b3-probe.txt
#
# ProbeOnly sends one LOG at a time, waits, and writes the printable part of the reply: `<OK` means
# the model takes the log, an `<ERROR:...` line means it does not. Do that before a 30 s capture -
# otherwise the error text a rejected LOG elicits lands inside the capture.
#
# Cleanup: a bare `UNLOGALL` clears the port this session is on. The port-argument form takes the
# RECEIVER's port name (USB1, COM2, ...), not the Windows COM name, so `UNLOGALL COM10` silently
# does nothing (03_analysis/09 section 9.x.8).
param(
  [string]$Port = 'COM10',
  [int]$Seconds = 30,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b3.sbf',
  [int]$Baud = 115200,
  [switch]$ProbeOnly
)

# Slow movers: one record each is all the coverage they need.
$once = @(
  'UPTIMEB ONCE',
  'IPSTATSB ONCE',
  'J1939STATUSB ONCE',
  'SAFEMODESTATUSB ONCE',
  'TIMESYNCB ONCE',
  'GLOCLOCKB ONCE',
  'BDSCLOCKB ONCE',
  'GALALMANACB ONCE',
  'BDSALMANACB ONCE',
  'GALIONOB ONCE',
  'BDSIONOB ONCE',
  'PSRSATSB ONCE',
  'SATXYZ2B ONCE',
  'NAVIGATEB ONCE',
  'PSRVELB ONCE',
  'BDSBCNAV2EPHEMERISB ONCE',
  'GALINAVEPHEMERISB ONCE'
)

# Repeating families: the raw-page logs fire as the receiver decodes them.
$periodic = @(
  'GLORAWEPHEMB ONTIME 1',
  'BDSRAWNAVSUBFRAMEB ONTIME 1',
  'RAWGPSSUBFRAMEB ONTIME 1',
  'RAWGPSWORDB ONTIME 1',
  'PSRDOP2B ONTIME 1',
  'PSRTIMEB ONTIME 1',
  'BESTVELXB ONTIME 1'
)

# Only speaks up when something happens (on this receiver: never, but it costs one LOG command).
$onNew = 'RXSTATUSEVENTB ONNEW'

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 300
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300

$buf = New-Object byte[] 65536
# Start from a clean port, both spellings: bare (current port) and the receiver's own name for it.
$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 400
$until = (Get-Date).AddMilliseconds(400)
while ((Get-Date) -lt $until) {
  try { if ($sp.BytesToRead -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead)) } } catch { }
}

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

if ($ProbeOnly) {
  # One command at a time, one reply window each: interleaving 24 commands makes it impossible to
  # tell which one the receiver refused.
  $all = @()
  foreach ($c in $once) { $all += $c }
  foreach ($p in $periodic) { $all += ($p -replace ' ONTIME [0-9]+$', ' ONCE') }
  $all += 'RXSTATUSEVENTB ONCE'
  $report = @()
  foreach ($c in $all) {
    $sp.DiscardInBuffer()
    $sp.Write('LOG ' + $c + "`r`n")
    Start-Sleep -Milliseconds 700
    $seen = ''
    while ($sp.BytesToRead -gt 0) {
      $n = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead))
      if ($n -le 0) { break }
      $seen += [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    }
    $clean = ''
    foreach ($ch in $seen.ToCharArray()) {
      $code = [int]$ch
      if ($code -ge 32 -and $code -lt 127) { $clean += $ch } else { $clean += '.' }
    }
    # The reply window also catches whatever the receiver is already streaming; collapse that noise.
    $clean = $clean -replace '\.{2,}', ' '
    if ($clean.Length -gt 200) { $clean = $clean.Substring(0, 200) }
    $ok = 'NO-REPLY'
    if ($clean -like '*ERROR*') { $ok = 'REFUSED: ' + ($clean.Substring($clean.IndexOf('ERROR')) -replace '\.+$', '') }
    elseif ($clean -like '*OK*') { $ok = 'OK' }
    $report += ('LOG ' + $c + '  =>  ' + $ok)
  }
  $report | Set-Content -Path $Out -Encoding ASCII
  $sp.Write("UNLOGALL`r`n")
  Start-Sleep -Milliseconds 500
  $sp.Close()
  $sp.Dispose()
  foreach ($line in $report) { Write-Output $line }
  exit 0
}

# A port only holds a limited number of active logs (the leftovers this receiver keeps streaming -
# RANGE, BESTPOS, RAWEPHEM, RXSTATUS, PORTSTATS, HWMONITOR - take six of the slots), and a LOG past
# the limit is accepted silently and then never fires. That is what swallowed five of the one-shot
# logs in the first 30 s capture: everything after the twelfth ONCE produced nothing. So the
# one-shots go out in two phases, each starting from UNLOGALL, and only then the repeating group.
$phaseA = @($once[0..8])
$phaseB = @($once[9..($once.Length - 1)])

$fs = [System.IO.File]::Create($Out)
$total = 0
function Drain-For([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $n = $sp.Read($buf, 0, $buf.Length)
      if ($n -gt 0) { $script:fs.Write($buf, 0, $n); $script:total += $n }
    } catch { }
  }
}

Drain-For 300
foreach ($phase in @($phaseA, $phaseB)) {
  $sp.Write("UNLOGALL`r`n")
  Drain-For 400
  foreach ($c in $phase) { $sp.Write('LOG ' + $c + "`r`n"); Start-Sleep -Milliseconds 150 }
  Drain-For 5000
}

$sp.Write("UNLOGALL`r`n")
Drain-For 400
foreach ($p in $periodic) { $sp.Write('LOG ' + $p + "`r`n"); Start-Sleep -Milliseconds 150 }
$sp.Write('LOG ' + $onNew + "`r`n")
Drain-For ($Seconds * 1000)
$fs.Close()

$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 400
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
