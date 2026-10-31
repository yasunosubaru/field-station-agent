
# ASCII only.
# B1 batch 2: a second sweep of binary logs the earlier captures never had, mostly the
# position/velocity/status families plus the compressed RANGE messages (VARIABLE_LENGTH_ARRAY
# with %Z / %hu) that the ASCII writer has never been checked against.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File b2-capture.ps1 -Port COM10 -Seconds 30 -Out C:\Temp\b2.sbf
#
# Cleanup note (learned the hard way): `UNLOGALL <name>` needs the RECEIVER's port name (USB1,
# COM2, ...), not the Windows COM name, so a failed cleanup looks like `UNLOGALL COM10` silently
# doing nothing. A bare `UNLOGALL` clears the port this bridge is on, which is what we want.
param(
  [string]$Port = 'COM10',
  [int]$Seconds = 30,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b2.sbf',
  [int]$Baud = 115200
)

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 300
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300

$buf = New-Object byte[] 65536
$until = (Get-Date).AddMilliseconds(250)
while ((Get-Date) -lt $until) {
  try { if ($sp.BytesToRead -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead)) } } catch { }
}

# One-shot / rarely changing logs.
$once = @(
  'ALMANACB ONCE',
  'RAWALMB ONCE',
  'GLORAWALMB ONCE',
  'CLOCKMODELB ONCE',
  'BESTUTMB ONCE',
  'BESTGNSSPOSB ONCE',
  'IPSTATUSB ONCE',
  'ETHSTATUSB ONCE',
  'WIFISTATUSB ONCE'
)
foreach ($c in $once) { $sp.Write('LOG ' + $c + "`r`n"); Start-Sleep -Milliseconds 130 }

# Periodic families.
$periodic = @(
  'PSRPOSB ONTIME 1',
  'PSRXYZB ONTIME 1',
  'RTKPOSB ONTIME 1',
  'RTKXYZB ONTIME 1',
  'MARKPOSB ONTIME 1',
  'MATCHEDPOSB ONTIME 1',
  'MATCHEDXYZB ONTIME 1',
  'BESTGNSSVELB ONTIME 1',
  'PPPXYZB ONTIME 2',
  'RAIMSTATUSB ONTIME 5',
  'RANGECMP2B ONTIME 1',
  'RANGECMP4B ONTIME 1',
  'TILTDATAB ONTIME 2'
)
foreach ($c in $periodic) { $sp.Write('LOG ' + $c + "`r`n"); Start-Sleep -Milliseconds 130 }

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$fs = [System.IO.File]::Create($Out)
$sw = [Diagnostics.Stopwatch]::StartNew()
$total = 0
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  try {
    $n = $sp.Read($buf, 0, $buf.Length)
    if ($n -gt 0) { $fs.Write($buf, 0, $n); $total += $n }
  } catch { }
}
$fs.Close()

# Bare UNLOGALL = "the port I am on" (see the note at the top of this file).
$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 500
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
