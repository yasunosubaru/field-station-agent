# Two questions in one serial session (ASCII only):
#   1. what does a bare `INTERFACEMODE` query answer?
#   2. does `LOG INTERFACEMODEB ONCE` produce records, and how many?
param(
  [string]$Com = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\ifm-probe.bin'
)
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort $Com, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 300
$sp.WriteTimeout = 500
$sp.Open()
Start-Sleep -Milliseconds 300

$buffer = New-Object System.Collections.Generic.List[byte]
function Drain([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $n = $sp.BytesToRead
      if ($n -gt 0) {
        $chunk = New-Object byte[] $n
        $read = $sp.Read($chunk, 0, $n)
        for ($i = 0; $i -lt $read; $i++) { $buffer.Add($chunk[$i]) }
      } else { Start-Sleep -Milliseconds 60 }
    } catch { Start-Sleep -Milliseconds 60 }
  }
}
function Send-Line([string]$line) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`r`n")
  $sp.Write($bytes, 0, $bytes.Length)
}

Send-Line 'UNLOGALL'
Drain 8
$mark = $buffer.Count
Write-Output ("after drain: " + $mark)

Send-Line 'INTERFACEMODE'
Drain 2
$bareEnd = $buffer.Count
Write-Output ("bare INTERFACEMODE -> " + ($bareEnd - $mark) + " bytes")

Send-Line 'LOG INTERFACEMODEB ONCE'
Drain 6
Write-Output ("LOG INTERFACEMODEB ONCE -> " + ($buffer.Count - $bareEnd) + " bytes")

Send-Line 'UNLOGALL'
Drain 1
$sp.Close()
[System.IO.File]::WriteAllBytes($Out, $buffer.ToArray())
Write-Output ("wrote " + $buffer.Count + " bytes; bare-query slice 0.." + ($bareEnd - $mark))
