# ASCII only.
# B5 probe: same shape as b4-probe.ps1, new candidate list.
#
# Candidates are drawn from the 608-message EDIE dictionary minus the 97 names already in a golden,
# and minus everything the suite itself cannot render (FANSPEED / TEMPERATURE / PWRSTATUS /
# SUPERSWSTATUS / BLOBSTATUS / TIMEH / PPSTIME / PPSSTATUS / TRACKSTAT2 are NOT in the dictionary,
# so even a record would never reach the golden - not worth a probe slot).
#
# Port facts carried over from b4 (measured 2026-11-01, do not re-learn):
#   * the ~20 Hz RANGE stream on this port survives `UNLOGALL`, so "did a record arrive" is decided
#     by message id, never by "were there bytes";
#   * ids 41/42/43 (RANGE family) and 93/72/963 (RXSTATUS / PORTSTATS / HWMONITOR, ~1 Hz) fire on
#     their own - both are excluded from the classification AND from the printed id list;
#   * commands go out one at a time with a >=150 ms gap (10 back-to-back LOGs get 2 `<OK`);
#   * a port holds ~32 active logs; probing uses `ONCE`, which does not accumulate.
#
# Results per candidate:
#   DATA      - `<OK` and at least one record of another type in the window
#   OK-NODATA - `<OK` only (accepted, nothing to say yet)
#   REFUSED   - `<ERROR:...`  (the message text says whether the name is unknown or model-gated)
#   NO-REPLY  - silence
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b5-probe.txt',
  [int]$WindowMs = 1500,
  [int]$DrainSeconds = 3,
  # Comma-separated log names: probe these instead of the built-in list.
  [string]$Names = ''
)

$candidates = @(
  # identity / channel configuration
  'VALIDMODELSB', 'COMCONFIGB', 'CHANCONFIGLISTB', 'SATELSTATUSB', 'SATEL4INFOB',
  'SATEL9INFOB', 'MODELB', 'AUTHB',
  # storage / filesystem (FILESTATUSB was refused last batch - retried without assumption)
  'FILELISTB', 'FILESTATUSB', 'FILESYSTEMSTATUSB', 'FILESYSTEMCAPACITYB',
  'FILETRANSFERSTATUSB', 'LUASTATUSB', 'LUAFILELISTB', 'LUAFILESYSTEMSTATUSB',
  # datum identity family (4-field string logs, DATUMB already covered)
  'BESTDATUMINFOB', 'PSRDATUMINFOB', 'BESTGNSSDATUMINFOB', 'PDPDATUMINFOB',
  'RTKDATUMINFOB', 'INSDATUMINFOB', 'GEODETICDATUMSB', 'DATUMTRANSFORMATIONSB',
  'USERANTENNAB', 'USERDATUMB',
  # raw / clock / LBand / interference
  'GALCLOCKB', 'GLORAWFRAMEB', 'GLORAWSTRINGB', 'LBANDINFOB',
  'RANGECMPB', 'RANGECMP2B', 'RANGECMP3B', 'RANGECMP4B', 'RANGECMP5B', 'RANGEGPSL1B',
  'ITFILTTABLEB', 'ITBANDPASSBANKB', 'ITPROGFILTBANKB',
  'CLOCKSTEERINGB', 'RXSTATUSEVENTB', 'SOFTLOADSTATUSB',
  # platform status / misc identity
  'VERIPOSSTATUSB', 'REFSTATIONINFOB', 'TSS1B', 'PASSTHROUGHB',
  'SAVEDSURVEYPOSITIONSB', 'USERCANSTATUSB', 'USERCANDATAB',
  # computed / INS (no IMU expected, probe anyway - two slots)
  'INSVELXB', 'INSPVAXB', 'INSCONFIGB', 'INSSTDEVB',
  # constellation variants still unproven on this unit
  'QZSSCNAVRAWMESSAGEB', 'GPSCNAVRAWMESSAGEB', 'GALINAVRAWEPHEMERISB',
  'GALCNAVRAWPAGEB', 'GALHASRAWMTB',
  # PDP family (PPPPOSB works on this unit, so PDP may too)
  'PDPPOSB', 'PDPDOPB', 'PDPDOP2B', 'PDPXYZB', 'PDPSATSB', 'PDPVELB',
  # dictionary entries with no declared style - test the odd shapes
  'BDSBCNAV3RAWMESSAGE2B', 'PROFILERESPONSEB', 'HEAVEB', 'TILTDATAB',
  'WIFISTATUSB', 'WIFINETLISTB', 'EXTERNALPVASB', 'HEADINGB'
)

$list = @()
if ($Names -ne '') {
  foreach ($c in $Names.Split(',')) { $t = $c.Trim(); if ($t -ne '') { $list += $t } }
} else {
  $list = $candidates
}

# Ids that fire on their own: 41/42/43 RANGE, 93 RXSTATUS, 72 PORTSTATS, 963 HWMONITOR.
$ignore = @{ 41 = 1; 42 = 1; 43 = 1; 93 = 1; 72 = 1; 963 = 1 }

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
    for ($i = $okAt; $i + 4 -lt $arr.Length; $i++) {
      if ($arr[$i] -eq 0xAA -and $arr[$i + 1] -eq 0x44 -and $arr[$i + 2] -eq 0x12 -and $arr[$i + 3] -eq 28) {
        $id = $arr[$i + 4] + 256 * $arr[$i + 5]
        if (-not $ignore.ContainsKey($id)) { $kind = 'DATA'; $found[$id] = 1 + [int]$found[$id] }
        $i += 3
      }
    }
  }
  $ids = ''
  foreach ($k in ($found.Keys | Sort-Object)) { $ids += ($k.ToString() + 'x' + $found[$k] + ' ') }
  $note = ''
  if ($kind -eq 'REFUSED') {
    $note = $txt.Substring($errAt, [Math]::Min(80, $txt.Length - $errAt))
    $note = ' ' + ($note -replace '[^ -~]', '.' -replace '\.{2,}', ' ').Trim()
  } elseif ($ids -ne '') {
    $note = ' ids ' + $ids
  }
  $report += ('{0,-24} {1,-10} {2,7} B{3}' -f $name, $kind, $arr.Length, $note)
}

$report | Set-Content -Path $Out -Encoding ASCII
$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 300
$sp.Close()
$sp.Dispose()
foreach ($line in $report) { Write-Output $line }
