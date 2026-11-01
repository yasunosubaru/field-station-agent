# ASCII only.
# B6 probe: same shape as b5-probe.ps1, candidate list generated from the dictionary this time.
#
# The list is not a guess. `packages/protocol/data/edie-layouts.json` holds 608 messages, 323 of
# them type LOG. 231 distinct type names already appear in one of the 17 stored ASCII goldens.
# That leaves 215 LOG types never seen in a golden; 83 of those were already probed in b4/b5
# (reported as REFUSED or OK-NODATA), so 132 were still unprobed. The families that b4/b5 already
# measured as model-level refused (RTK / SPAN-INS / Wi-Fi / storage-FILE / LUA / IT filter banks /
# SBAS pages with no bird) are represented here by ONE member each, not by their whole family -
# the family verdict is already on record and re-probing 40 SPAN logs would waste 70 s of port time.
#
# Port facts (measured 2026-11-01, do not re-learn):
#   * ids 41/42/43 (RANGE) and 93/72/963 (RXSTATUS / PORTSTATS / HWMONITOR) fire on their own, so a
#     probe verdict is decided by *message id*, never by "were there bytes";
#   * commands go out one at a time with a >=150 ms gap;
#   * a port holds ~32 active logs; probing uses `ONCE`, which does not accumulate;
#   * cleanup is a bare `UNLOGALL` + `UNLOGALL USB2`.
#
# Results per candidate:
#   DATA      - `<OK` and at least one record of another type in the window
#   OK-NODATA - `<OK` only (accepted, nothing to say yet)
#   REFUSED   - `<ERROR:...` (the message text says whether the name is unknown or model-gated)
#   NO-REPLY  - silence
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b6-probe.txt',
  [int]$WindowMs = 1500,
  [int]$DrainSeconds = 3,
  # Binary logs are `<name>B`; the bare name is the ASCII log, which never lands in an SBF capture.
  [string]$Suffix = 'B',
  # Comma-separated log names: probe these instead of the built-in list.
  [string]$Names = ''
)

$candidates = @(
  # LBand / TerraStar: LBANDTRACKSTAT is the one b4 noted as "can output" but never captured
  'LBANDTRACKSTAT', 'LBANDBEAMTABLE', 'RAWLBANDPACKET', 'TERRASTARSTATUS',
  # PPP auxiliaries (PPP itself works on this unit, so the seed / datum logs may too)
  'PPPDATUMINFO', 'PPPSEEDAPPLICATIONSTATUS', 'PPPSEEDSTORESTATUS',
  # reference station / baseline (needs a base, probed once)
  'REFSTATION', 'BSLNXYZ', 'SOURCETABLE',
  # SBAS pages: no bird on this unit, so one representative per page group only
  'SBAS18', 'SBASALMANAC', 'SBAS0', 'SBAS32', 'SBAS33', 'SBAS34', 'SBAS35',
  'SBAS1', 'SBAS2', 'SBAS4', 'SBAS5', 'SBAS6', 'SBAS7', 'SBAS9', 'SBAS10', 'SBAS12', 'SBAS24',
  # RTK leftovers (family already refused in b4 - two members to confirm RTKDOP2/MATCHEDSATS)
  'RTKDOP2', 'MATCHEDSATS', 'GPGGARTK', 'DUALANTENNAHEADING', 'GPHDTDUALANTENNA',
  # SPAN / IMU leftovers: one per shape, family already refused
  'RAWIMUSX', 'INSSTDEVS', 'INSATTX', 'INSPOSX', 'INSPVACMP', 'INSPVASDCMP', 'INSVELUSER',
  'IMURATEPVA', 'IMURATEPVAS', 'IMURATECORRIMUS', 'INSATTQS', 'CORRIMUS', 'CORRIMUDATA',
  'INSATT', 'INSCOV', 'INSPOS', 'INSSPD', 'INSVEL', 'INSPVA', 'INSATTS', 'INSCOVS',
  'INSPOSS', 'INSSPDS', 'INSVELS', 'INSPVAS', 'RAWIMU', 'RAWIMUS',
  'IMUTOANTOFFSETS', 'BESTLEVERARM', 'BESTLEVERARM2', 'VARIABLELEVERARM', 'GIMBALLEDPVA',
  'HEADINGSATS', 'HEADINGEXT2', 'ALIGNDOP', 'ALIGNBSLNXYZ', 'ALIGNBSLNENU',
  'GENERATEALIGNCORRECTIONS', 'INSUPDATESTATUS', 'INSCALSTATUS', 'INSSEEDSTATUS',
  'SYNCHEAVE', 'DELAYEDHEAVE',
  # mark / tagged-mark PVAs (no event marks configured)
  'MARK2PVA', 'MARK4POS', 'TAGGEDMARK1PVA',
  # pass-through families: one member per port kind
  'PASSCOM1', 'PASSXCOM1', 'PASSUSB1', 'PASSICOM1', 'PASSNCOM1', 'PASSAUX', 'PASSETH1',
  # misc single entries that no earlier batch touched
  'OCEANIXSTATUS', 'TECTONICSCOMPENSATION', 'SKCALIBRATESTATUS', 'SPRINKLERDATA',
  'SPRINKLERDATAH', 'TRANSFERPORTSTATUS', 'USERI2CRESPONSE', 'LUAOUTPUT',
  # constellation leftovers
  'NAVICRAWSUBFRAME', 'NAVICIONO', 'QZSSRAWCNAVMESSAGE',
  # Wi-Fi (family refused) - one member
  'WIFIAPSETTINGS'
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
# Each verdict is appended as soon as it is known, so a dropped SSH session costs the rest of the
# run and not the whole run. (Launching the probe detached with `Start-Process` does not work here:
# the first attempt produced a 0-byte log and no output file, and the child was gone within seconds.)
Set-Content -Path $Out -Value '' -Encoding ASCII

foreach ($name in $list) {
  $sp.DiscardInBuffer()
  $requested = $name + $Suffix
  $sp.Write('LOG ' + $requested + " ONCE`r`n")
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
    $note = $txt.Substring($errAt, [Math]::Min(90, $txt.Length - $errAt))
    $note = ' ' + ($note -replace '[^ -~]', '.' -replace '\.{2,}', ' ').Trim()
  } elseif ($ids -ne '') {
    $note = ' ids ' + $ids
  }
  $line = ('{0,-24} {1,-10} {2,7} B{3}' -f $requested, $kind, $arr.Length, $note)
  Add-Content -Path $Out -Value $line -Encoding ASCII
  Write-Output $line
}

$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 300
$sp.Close()
$sp.Dispose()
foreach ($line in $report) { Write-Output $line }
