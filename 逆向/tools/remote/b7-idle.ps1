# ASCII only. Final check: is anything still streaming to USB2 after the wrap-up?
# Writes what it saw so the leftover stream can be named.
param([string]$Port = 'COM10', [int]$Baud = 115200, [int]$Seconds = 3,
      [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b7-idle.bin'))
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $_.Exception.Message); exit 2 }
$bytes = New-Object System.Collections.Generic.List[byte]
$chunk = New-Object byte[] 65536
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $have = $sp.BytesToRead
  if ($have -gt 0) {
    $n = $sp.Read($chunk, 0, [Math]::Min($chunk.Length, $have))
    for ($i = 0; $i -lt $n; $i++) { $bytes.Add($chunk[$i]) }
  } else { Start-Sleep -Milliseconds 50 }
}
$sp.Close(); $sp.Dispose()
[System.IO.File]::WriteAllBytes($Out, $bytes.ToArray())
Write-Output ('idle check: ' + $bytes.Count + ' bytes in ' + $Seconds + ' s on ' + $Port)
