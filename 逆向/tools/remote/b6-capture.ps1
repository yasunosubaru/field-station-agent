# ASCII only.
# B6 batch (batch 6 of the coverage sweep): the types no earlier capture has, measured on this OEM729.
#
# Probed 2026-11-01 with `b6-probe.ps1`, one `LOG <name>B ONCE` at a time in a 1.5 s window, ids
# 41/42/43 and 93/72/963 ignored because they fire on their own:
#
#   DATA (9 names, all captured below): LBANDTRACKSTAT 1201, LBANDBEAMTABLE 1718, TERRASTARSTATUS
#     1729, PPPSEEDAPPLICATIONSTATUS 2250, PPPSEEDSTORESTATUS 2251, SOURCETABLE 1344,
#     OCEANIXSTATUS 2160, TECTONICSCOMPENSATION 2291, PASSCOM3 235.
#   REFUSED - `<ERROR:Message is invalid for this model`: every SPAN/IMU log (INSPVA, INSPVAS,
#     INSATT*, INSPOS*, INSSPD*, INSVEL*, INSATTX, INSPOSX, INSPOSS, INSSPDS, INSVELS, INSATTS,
#     INSPVACMP, INSPVASDCMP, INSVELUSER, RAWIMU, RAWIMUS, RAWIMUSX, IMURATEPVA, IMURATEPVAS,
#     IMURATECORRIMUS, CORRIMUS, INSATTQS, INSSTDEVS, VARIABLELEVERARM, GIMBALLEDPVA,
#     INSUPDATESTATUS, INSCALSTATUS, INSSEEDSTATUS, SYNCHEAVE, DELAYEDHEAVE, RELINSPVA), the RTK
#     logs (RTKDOP2, MATCHEDSATS, DUALANTENNAHEADING, GPHDTDUALANTENNA, MARK2PVA, MARK3PVA,
#     MARK4PVA, TAGGEDMARK*PVA), BSLNXYZ, SPRINKLERDATA*, TRANSFERPORTSTATUS, LUAOUTPUT,
#     WIFIAPSETTINGS, SKCALIBRATESTATUS.
#   REFUSED - `<ERROR:Invalid Message. Field = 2` (no such log on this receiver): RAWLBANDPACKET,
#     SBAS32, SBAS33, SBAS34, SBAS35, GPGGARTK, CORRIMUDATA, INSCOV, INSCOVS, IMUTOANTOFFSETS,
#     BESTLEVERARM, BESTLEVERARM2, PASSXCOM1, PASSXCOM2, PASSXCOM3, PASSETH1, INSUPDATE,
#     CORRIMUDATAS.
#   OK-NODATA (`<OK`, one record never arrived): the SBAS pages (no bird), PPPDATUMINFO,
#     REFSTATION, PPPSEED*, HEADINGSATS, HEADINGEXT2, ALIGNDOP, ALIGNBSLNXYZ, ALIGNBSLNENU,
#     GENERATEALIGNCORRECTIONS, MARK4POS, PASSCOM1/2/4..10, PASSUSB1..3, PASSICOM1..7,
#     PASSNCOM1..3, PASSAUX, USERI2CRESPONSE, NAVICRAWSUBFRAME, NAVICIONO, QZSSRAWCNAVMESSAGE.
#
# Forty-four of those OK-NODATA names were then re-tried with `LOG <name>B ONTIME 1` for 25 s
# (`b6-retry.ps1`, two phases of 19 and 25) on the theory that a change-triggered log may ignore
# `ONCE`: only ETHSTATUS fired, so the ONCE verdict stands for the rest. The retry also produced a
# third rejection this project had not seen before - `<ERROR:Trigger ONTIME not valid for this log`
# for PPPSEEDAPPLICATIONSTATUS, PPPSEEDSTORESTATUS and TECTONICSCOMPENSATION, i.e. those three are
# change-triggered only. That is why each of them contributes exactly one record below
# (the `ONCE` one) while the other six logs of the same phase contribute 15-17.
#
# One measured correction to the probe method itself: `LOG <name>` without the trailing `B` asks for
# the ASCII log, which answers `<OK` and never puts a binary record on the port. The first probe run
# used the bare names and reported 126 names as REFUSED/OK-NODATA with zero data; with `B` the same
# names produced nine logs. Every verdict above is from the `B` run.
#
# The phases exist because one port holds about 32 active logs. Every phase starts from a bare
# `UNLOGALL`, which is also what the port-argument form cannot do (`UNLOGALL COM10` does nothing -
# the argument is the RECEIVER's port name).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File b6-capture.ps1 -Port COM10 -Out C:\Temp\b6.sbf
#   powershell -ExecutionPolicy Bypass -File b6-capture.ps1 -ProbeOnly
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b6.sbf',
  [int]$DrainSeconds = 3,
  [int]$OnceSeconds = 6,
  [int]$RateSeconds = 15,
  [switch]$ProbeOnly
)

if ($ProbeOnly) {
  & (Join-Path $PSScriptRoot 'b6-probe.ps1') -Port $Port -Baud $Baud
  exit $LASTEXITCODE
}

# One record per type is enough to pin every field of the identity / status logs.
$onceList = @(
  'LBANDTRACKSTATB', 'LBANDBEAMTABLEB', 'TERRASTARSTATUSB', 'PPPSEEDAPPLICATIONSTATUSB',
  'PPPSEEDSTORESTATUSB', 'SOURCETABLEB', 'OCEANIXSTATUSB', 'TECTONICSCOMPENSATIONB',
  'PASSCOM3B', 'SBAS18B', 'SAVEDSURVEYPOSITIONSB'
)

# Repeating them at 1 Hz gives several records per type, which is what makes a wrong field count or
# a fixed stride visible instead of accidentally right on one sample. ETHSTATUS is here for the
# count field: the golden proves how many interface blocks this unit reports.
$rateList = @(
  'LBANDTRACKSTATB', 'LBANDBEAMTABLEB', 'TERRASTARSTATUSB', 'PPPSEEDAPPLICATIONSTATUSB',
  'PPPSEEDSTORESTATUSB', 'SOURCETABLEB', 'OCEANIXSTATUSB', 'TECTONICSCOMPENSATIONB',
  'ETHSTATUSB'
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
Unlog
Drain-For ($DrainSeconds * 1000)

Unlog
Drain-For 500
foreach ($c in $onceList) { $sp.Write('LOG ' + $c + " ONCE`r`n"); Start-Sleep -Milliseconds 160 }
Drain-For ($OnceSeconds * 1000)

Unlog
Drain-For 500
foreach ($c in $rateList) { $sp.Write('LOG ' + $c + " ONTIME 1`r`n"); Start-Sleep -Milliseconds 160 }
Drain-For ($RateSeconds * 1000)

Unlog
Drain-For 500
$fs.Flush()
$fs.Close()

Unlog
Drain-For 500
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
