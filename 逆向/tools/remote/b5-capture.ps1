# ASCII only.
# B5 batch (batch 5 of the coverage sweep): the types no earlier capture has, measured on this OEM729.
#
# Measured 2026-11-01 with `b5-probe.ps1` (one LOG ... ONCE at a time, 1.5 s window, ids 41/42/43
# and 93/72/963 ignored because they fire on their own whatever the port is asked to log):
#
#   DATA (25 names, all captured below): VALIDMODELSB 206, COMCONFIGB 317, CHANCONFIGLISTB 1148,
#     BESTDATUMINFOB 2305, PSRDATUMINFOB 2300, BESTGNSSDATUMINFOB 2302, GEODETICDATUMSB 2296,
#     DATUMTRANSFORMATIONSB 2298, CLOCKSTEERINGB 26, SOFTLOADSTATUSB 1235, VERIPOSSTATUSB 1730,
#     PASSTHROUGHB 1342, PDPPOSB 469, PDPXYZB 471, PDPVELB 470, PDPSATSB 1234, RXSTATUSEVENTB 94,
#     RANGECMPB 140, RANGECMP2B 1273, RANGECMP3B 1734, RANGECMP4B 2050, RANGECMP5B 2537,
#     RANGEGPSL1B 631, GALINAVRAWEPHEMERISB 1126, BDSBCNAV3RAWMESSAGE2B 2520.
#   REFUSED - `<ERROR:Message is invalid for this model` (firmware option absent): SATELSTATUSB,
#     SATEL4INFOB, SATEL9INFOB, FILELISTB, FILESTATUSB, FILESYSTEMSTATUSB, FILESYSTEMCAPACITYB,
#     FILETRANSFERSTATUSB, LUASTATUSB, LUAFILELISTB, LUAFILESYSTEMSTATUSB, INSDATUMINFOB,
#     ITFILTTABLEB, ITBANDPASSBANKB, ITPROGFILTBANKB, TSS1B, INSVELXB, INSPVAXB, INSCONFIGB,
#     INSSTDEVB, HEAVEB, TILTDATAB, WIFISTATUSB, WIFINETLISTB, EXTERNALPVASB.
#     LBANDINFOB was refused with `<ERROR:Invalid Message. Field = 2` - the log does not exist under
#     that spelling even though the EDIE dictionary lists it.
#   OK-NODATA (17 names: accepted, one record never arrived in 30 s): MODELB, AUTHB, PDPDATUMINFOB,
#     RTKDATUMINFOB, USERANTENNAB, USERDATUMB, GALCLOCKB, GLORAWFRAMEB, GLORAWSTRINGB,
#     REFSTATIONINFOB, SAVEDSURVEYPOSITIONSB, USERCANSTATUSB, USERCANDATAB, QZSSCNAVRAWMESSAGEB,
#     GPSCNAVRAWMESSAGEB, GALCNAVRAWPAGEB, GALHASRAWMTB, PDPDOPB, PDPDOP2B, PROFILERESPONSEB,
#     HEADINGB.
#
# Nine names from the batch brief (FANSPEED / TEMPERATURE / PWRSTATUS / SUPERSWSTATUS / BLOBSTATUS /
# TIMEH / PPSTIME / PPSSTATUS / TRACKSTAT2) were not probed on purpose: none of them is in the
# 608-message EDIE dictionary, so a record could never reach the golden file even if the receiver
# sent one. HWMONITOR already covers the fan / temperature words this unit exposes.
#
# The phases exist because one port holds only about 32 active logs and a LOG past the limit is
# answered `<OK` and then never fires. Every phase starts from a bare UNLOGALL.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File b5-capture.ps1 -Port COM10 -Out C:\Temp\b5.sbf
#   powershell -ExecutionPolicy Bypass -File b5-capture.ps1 -ProbeOnly
#
# Cleanup is a bare `UNLOGALL` (the port-argument form takes the RECEIVER's port name, so
# `UNLOGALL COM10` does nothing).
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b5.sbf'),
  [int]$DrainSeconds = 3,
  [int]$RangeSeconds = 12,
  [int]$RawSeconds = 8,
  [int]$PdpSeconds = 8,
  [switch]$ProbeOnly
)

if ($ProbeOnly) {
  & (Join-Path $PSScriptRoot 'b5-probe.ps1') -Port $Port -Baud $Baud
  exit $LASTEXITCODE
}

# One record per line is enough for the identity / configuration families.
$phaseA = @(
  'VALIDMODELSB ONCE', 'COMCONFIGB ONCE', 'CHANCONFIGLISTB ONCE', 'BESTDATUMINFOB ONCE',
  'PSRDATUMINFOB ONCE', 'BESTGNSSDATUMINFOB ONCE', 'GEODETICDATUMSB ONCE',
  'DATUMTRANSFORMATIONSB ONCE', 'CLOCKSTEERINGB ONCE', 'SOFTLOADSTATUSB ONCE'
)
$phaseB = @(
  'VERIPOSSTATUSB ONCE', 'PASSTHROUGHB ONCE', 'RXSTATUSEVENTB ONCE',
  'PDPPOSB ONCE', 'PDPXYZB ONCE', 'PDPVELB ONCE', 'PDPSATSB ONCE'
)

# Repeating families: the compressed-range writers are the widest blobs in the dictionary, and the
# GAL I/NAV ephemeris / BDS B-CNAV3 page families fire per satellite.
$periodicRange = @(
  'RANGECMPB ONTIME 1', 'RANGECMP2B ONTIME 1', 'RANGECMP3B ONTIME 1',
  'RANGECMP4B ONTIME 1', 'RANGECMP5B ONTIME 1', 'RANGEGPSL1B ONTIME 1'
)
$periodicRaw = @(
  'GALINAVRAWEPHEMERISB ONTIME 1', 'BDSBCNAV3RAWMESSAGE2B ONTIME 1'
)
$periodicPdp = @(
  'PDPPOSB ONTIME 1', 'PDPXYZB ONTIME 1', 'PDPVELB ONTIME 1', 'PDPSATSB ONTIME 1'
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

foreach ($phase in @($phaseA, $phaseB)) {
  Unlog
  Drain-For 500
  foreach ($c in $phase) { $sp.Write('LOG ' + $c + "`r`n"); Start-Sleep -Milliseconds 150 }
  Drain-For 5000
}

foreach ($plan in @(
  @($periodicRange, $RangeSeconds),
  @($periodicRaw, $RawSeconds),
  @($periodicPdp, $PdpSeconds)
)) {
  Unlog
  Drain-For 500
  foreach ($c in $plan[0]) { $sp.Write('LOG ' + $c + "`r`n"); Start-Sleep -Milliseconds 150 }
  Drain-For ([int]$plan[1] * 1000)
}

Unlog
Drain-For 500
$fs.Close()

Unlog
Drain-For 400
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
