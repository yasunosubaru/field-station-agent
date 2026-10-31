
# ASCII only.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File remote-capture.ps1 -Port COM9 -Seconds 15 -Out C:\Temp\x.sbf
param(
  [string]$Port = 'COM9',
  [int]$Seconds = 15,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\nova-capture.sbf',
  [int]$Baud = 115200
)

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 300
$sp.WriteTimeout = 1000
$sp.Open()
Start-Sleep -Milliseconds 300

$buf = New-Object byte[] 65536
# drain backlog
$until = (Get-Date).AddMilliseconds(250)
while ((Get-Date) -lt $until) {
  try { if ($sp.BytesToRead -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead)) } } catch { }
}

# ask for the navigation logs plus a couple of periodic ones (B suffix = binary)
$cmds = @(
  'LOG BDSEPHEMERISB ONCE',
  'LOG GLOEPHEMERISB ONCE',
  'LOG GPSEPHEMB ONCE',
  'LOG RAWEPHEMB ONCE',
  'LOG BESTPOSB ONTIME 1',
  'LOG RANGEB ONTIME 1',
  'LOG RXSTATUSB ONTIME 5',
  'LOG HWMONITORB ONTIME 10'
)
foreach ($c in $cmds) {
  $sp.Write($c + "`r`n")
  Start-Sleep -Milliseconds 150
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
$sp.Close()
$sp.Dispose()
Write-Output ("captured " + $total + " bytes to " + $Out)
