# ASCII only. B7 restore: put back the two settings this session touched, read them back, then unlog.
#
# The originals are not guesses: both come out of `b1-20261101.sbf`, whose own RXCONFIGA dump on
# 2026-11-01 (before any b7 command) carried
#     #ITWARNINGCONFIGA,...;3,0
#     #ITSPECTRALANALYSISA,...;PREDECIMATION,GPSL1,200,2K,1,1
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File b7-restore.ps1 -Port COM10
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b7-restore.bin'),
  [string]$Txt = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b7-restore.txt')
)
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300

$bytes = New-Object System.Collections.Generic.List[byte]
$notes = New-Object System.Collections.Generic.List[string]
$chunk = New-Object byte[] 65536
function Drain-For([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $have = $sp.BytesToRead
      if ($have -gt 0) {
        $n = $sp.Read($chunk, 0, [Math]::Min($chunk.Length, $have))
        for ($i = 0; $i -lt $n; $i++) { $bytes.Add($chunk[$i]) }
      } else { Start-Sleep -Milliseconds 5 }
    } catch { Start-Sleep -Milliseconds 5 }
  }
}
function Send([string]$line) {
  $sp.Write($line + "`r`n")
  Start-Sleep -Milliseconds 160
  $notes.Add('send ' + $line)
}

Send 'UNLOGALL'
Drain-For 400
Send 'UNLOGALL USB2_29'
Drain-For 300
Send 'UNLOGALL USB2_30'
Drain-For 300
Send 'UNLOGALL USB2'
Drain-For 500

Send 'ITWARNINGCONFIG 3'
Drain-For 500
Send 'ITSPECTRALANALYSIS PREDECIMATION GPSL1 200 2K 1 1'
Drain-For 500

# read back through the config dump, which is where the original values came from
Send 'LOG RXCONFIGA ONCE'
Drain-For 6000

Send 'UNLOGALL'
Drain-For 400
Send 'UNLOGALL USB2_29'
Drain-For 300
Send 'UNLOGALL USB2_30'
Drain-For 300
Send 'UNLOGALL USB2'
Drain-For 500
$sp.Close(); $sp.Dispose()

[System.IO.File]::WriteAllBytes($Out, $bytes.ToArray())
[System.IO.File]::WriteAllLines($Txt, $notes.ToArray())
Write-Output ('wrote ' + $bytes.Count + ' bytes')
