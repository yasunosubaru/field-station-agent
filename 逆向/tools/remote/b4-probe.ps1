# ASCII only.
# B4 probe: for each candidate log, does this OEM729 accept it, and does one ONCE produce a record?
#
# The port carries a permanent ~20 Hz RANGE stream (plus BESTPOS / RAWEPHEM, and RXSTATUS /
# PORTSTATS / HWMONITOR about once a second) that no UNLOG spelling clears - measured 2026-11-01:
# 63-79 kB/s after `UNLOGALL`, `UNLOG RANGEB` and `UNLOGALL USB2` alike, so it is not this port's
# log list. The probe therefore ignores message ids 41/42/43 when it asks "did a record arrive";
# anything else after the `<OK` came from the command. 93/72/963 are NOT ignored in the classifier
# below - they fire every window too, so a `DATA` line whose only ids are 93/72/963 means NODATA.
# (Reading that by eye is how the 13 false DATA lines of the first run were corrected.)
#
# No per-byte string building: 100 KB per window turned into 17 s of O(n^2) concatenation on the
# first attempt and the run never finished.
#
# Results per candidate:
#   DATA      - `<OK` and at least one record of another type in the window
#   OK-NODATA - `<OK` only (accepted, nothing to say yet: needs a mark, RTK, ...)
#   REFUSED   - `<ERROR:...`
#   NO-REPLY  - silence
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b4-probe.txt'),
  [int]$WindowMs = 1500,
  [int]$DrainSeconds = 3,
  # Comma-separated log names: probe these instead of the built-in suggested + supplementary list.
  [string]$Names = ''
)

# The 20 the batch brief suggested, in its order.
$suggested = @(
  'BESTXYZB', 'TRACKSTATB', 'MARKTIMEB', 'IONUTCB', 'GPSEPHEMERISB',
  'GLOEPHEMERISB', 'PSRPOSB', 'PSRXYZB', 'RTKPOSB', 'RTKVELB',
  'TIMEB', 'CLOCKMODELB', 'MATCHEDPOSB', 'ALMANACB', 'SBASRAWB',
  'GALFNAVEPHEMERISB', 'BDSBCNAV1EPHEMERISB', 'QZSSEPHEMERISB', 'NAVSSATBITSB', 'ABSSATEPHEMERISB'
)

# Supplementary candidates: dictionary messages no earlier capture has, picked for shape coverage and
# for being plausible on a static OEM729 (geoid / datum / antenna identity / MARK family / QZSS /
# BDS-3 nav / SBAS / platform INFO logs).
$extra = @(
  'UNDULATIONB', 'MAGVARB', 'DATUMB', 'USERDATUMB', 'AVEPOSB',
  'TRACKSVB', 'SATVISB', 'THISANTENNATYPEB', 'BASEANTENNATYPEB', 'ANTENNATYPEB',
  'GLOALMANACB', 'QZSSALMANACB', 'QZSSIONUTCB', 'QZSSRAWEPHEMB', 'QZSSRAWSUBFRAMEB',
  'BDSBCNAV3EPHEMERISB', 'BDSBCNAV1RAWMESSAGEB', 'BDSBCNAV3RAWMESSAGEB', 'BDSBCNAV2RAWMESSAGEB',
  'NAVICEPHEMERISB', 'RTKXYZB', 'MATCHEDXYZB', 'MASTERPOSB', 'ROVERPOSB',
  'PPPPOSB', 'HEADINGB', 'HEADING2B', 'HEADINGEXTB', 'HEADINGRATEB',
  'RTKDOPB', 'RTKSATSB', 'RAWSBASFRAMEB', 'RAWSBASFRAME2B', 'SBAS17B',
  'SBAS25B', 'SBAS26B', 'SBAS27B', 'SBAS3B', 'SBAS45B',
  'RXCONFIGUSERB', 'TILTSTATUSB', 'MARK2TIMEB', 'MARK3TIMEB', 'MARK4TIMEB',
  'MARK1PVAB', 'MARK2POSB', 'TERRASTARINFOB', 'OCEANIXINFOB', 'VERIPOSINFOB'
)

$list = @()
if ($Names -ne '') {
  foreach ($c in $Names.Split(',')) { $t = $c.Trim(); if ($t -ne '') { $list += $t } }
} else {
  foreach ($c in $suggested) { $list += $c }
  foreach ($c in $extra) { $list += $c }
}

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300
$buf = New-Object byte[] 65536
$latin1 = [Text.Encoding]::GetEncoding(28591)

function Drain-Some([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    try { $have = $sp.BytesToRead; if ($have -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $have)) } else { Start-Sleep -Milliseconds 5 } }
    catch { Start-Sleep -Milliseconds 5 }
  }
}

$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 200
$sp.Write("UNLOGALL USB2`r`n")
Drain-Some ($DrainSeconds * 1000)

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$report = @()
foreach ($name in $list) {
  $sp.DiscardInBuffer()
  $sp.Write('LOG ' + $name + " ONCE`r`n")
  Start-Sleep -Milliseconds $WindowMs
  $bytes = New-Object System.Collections.Generic.List[byte]
  $deadline = (Get-Date).AddMilliseconds(300)
  while ((Get-Date) -lt $deadline) {
    $have = $sp.BytesToRead
    if ($have -gt 0) { $r = $sp.Read($buf, 0, [Math]::Min($buf.Length, $have)); for ($i = 0; $i -lt $r; $i++) { $bytes.Add($buf[$i]) } }
    else { Start-Sleep -Milliseconds 5 }
  }
  $arr = $bytes.ToArray()
  $txt = $latin1.GetString($arr)
  $errAt = $txt.IndexOf('<ERROR')
  $okAt = $txt.IndexOf('<OK')

  $kind = 'NO-REPLY'
  $found = @{}
  if ($errAt -ge 0) {
    $kind = 'REFUSED'
  } elseif ($okAt -ge 0) {
    $kind = 'OK-NODATA'
    $from = [Math]::Max(0, $okAt)
    for ($i = $from; $i + 4 -lt $arr.Length; $i++) {
      if ($arr[$i] -eq 0xAA -and $arr[$i + 1] -eq 0x44 -and $arr[$i + 2] -eq 0x12 -and $arr[$i + 3] -eq 28) {
        $id = $arr[$i + 4] + 256 * $arr[$i + 5]
        if ($id -ne 41 -and $id -ne 42 -and $id -ne 43) { $kind = 'DATA'; $found[$id] = 1 + [int]$found[$id] }
        $i += 3
      }
    }
  }
  $ids = ''
  foreach ($k in $found.Keys) { $ids += ($k.ToString() + 'x' + $found[$k] + ' ') }
  $note = ''
  if ($kind -eq 'REFUSED') {
    $note = $txt.Substring($errAt, [Math]::Min(80, $txt.Length - $errAt))
    $note = ' ' + ($note -replace '[^ -~]', '.' -replace '\.{2,}', ' ').Trim()
  } elseif ($ids -ne '') {
    $note = ' ids ' + $ids
  }
  $report += ('{0,-21} {1,-10} {2,7} B{3}{4}' -f $name, $kind, $arr.Length, $note, '')
}

$report | Set-Content -Path $Out -Encoding ASCII
$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 300
$sp.Close()
$sp.Dispose()
foreach ($line in $report) { Write-Output $line }
