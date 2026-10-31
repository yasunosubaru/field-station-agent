
# ASCII only.
# B1 coverage capture: enable a wide set of binary logs on OUR port, capture N seconds, then UNLOGALL
# that port so the receiver is left as we found it. The suite lives on COM9; do not touch that port.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File b1-capture.ps1 -Port COM8 -Seconds 25 -Out C:\Temp\b1.sbf
param(
  [string]$Port = 'COM8',
  [int]$Seconds = 25,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b1.sbf',
  [int]$Baud = 115200,
  [switch]$NoUnlog
)

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 300
$sp.WriteTimeout = 1000
try {
  $sp.Open()
} catch {
  Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message)
  exit 2
}
Start-Sleep -Milliseconds 300

$buf = New-Object byte[] 65536
$until = (Get-Date).AddMilliseconds(250)
while ((Get-Date) -lt $until) {
  try { if ($sp.BytesToRead -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead)) } } catch { }
}

# One-shot and slow logs first: they answer immediately and cost nothing.
$cmds = @(
  'VERSIONB ONCE',
  'MODELFEATURESB ONCHANGED',
  'SERIALCONFIGB ONCE',
  'IONUTCB ONCE',
  'GPSEPHEMB ONCE',
  'GALEPHEMERISB ONCE',
  'BDSEPHEMERISB ONCE',
  'GLOEPHEMERISB ONCE',
  'RAWEPHEMB ONCE',
  'RXCONFIGB ONCE',
  'LOGLISTB ONCE'
)
foreach ($c in $cmds) {
  $sp.Write('LOG ' + $c + "`r`n")
  Start-Sleep -Milliseconds 120
}

# Periodic logs: the aliases the OEM729 answers to (B suffix = binary SBF).
$periodic = @(
  'BESTPOSB ONTIME 1',
  'BESTVELB ONTIME 1',
  'BESTXYZB ONTIME 1',
  'PSRDOPB ONTIME 2',
  'BESTSATSB ONTIME 5',
  'TRACKSTATB ONTIME 2',
  'SATVIS2B ONTIME 5',
  'PORTSTATSB ONTIME 5',
  'HWMONITORB ONTIME 5',
  'TIMEB ONTIME 5',
  'ITPSDFINALB ONNEW',
  'ITPSDDETECTB ONNEW',
  'ITDETECTSTATUSB ONTIME 5'
)
foreach ($c in $periodic) {
  $sp.Write('LOG ' + $c + "`r`n")
  Start-Sleep -Milliseconds 120
}

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

if (-not $NoUnlog) {
  # Bare UNLOGALL clears the port this session is on. The port-argument form wants the RECEIVER's
  # port name (USB1, COM2, ...), not the Windows COM name, so `UNLOGALL COM10` silently does
  # nothing and leaves logs behind (see 03_分析/09 §9.x.8).
  $sp.Write("UNLOGALL`r`n")
  Start-Sleep -Milliseconds 400
}
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
