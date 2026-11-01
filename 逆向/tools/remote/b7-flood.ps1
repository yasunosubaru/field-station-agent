# ASCII only. B7 step 0: who is streaming on this port and which command stops it.
# Every step is 2 s of drained bytes; the counts are printed so the winning command is the one whose
# step drops to a few hundred bytes.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File b7-flood.ps1 -Port COM10
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b7-flood.bin',
  [string]$Txt = 'C:\Users\niwawa\AppData\Local\Temp\b7-flood.txt',
  [int]$StepMs = 2000
)
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 400

$bytes = New-Object System.Collections.Generic.List[byte]
$logLines = New-Object System.Collections.Generic.List[string]
function Drain-For([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  $chunk = New-Object byte[] 65536
  while ((Get-Date) -lt $deadline) {
    try {
      $have = $sp.BytesToRead
      if ($have -gt 0) {
        $n = $sp.Read($chunk, 0, [Math]::Min($chunk.Length, $have))
        for ($i = 0; $i -lt $n; $i++) { $bytes.Add($chunk[$i]) }
      } else { Start-Sleep -Milliseconds 10 }
    } catch { Start-Sleep -Milliseconds 10 }
  }
}
function Step([string]$line) {
  $before = $bytes.Count
  if ($line -ne '') {
    $sp.Write($line + "`r`n")
    Start-Sleep -Milliseconds 250
  }
  Drain-For $StepMs
  $n = $bytes.Count - $before
  $tag = if ($line -eq '') { '(baseline)' } else { $line }
  $logLines.Add(('{0,-32} {1,8} bytes in {2} ms' -f $tag, $n, $StepMs))
  Write-Output ('{0,-32} {1,8} bytes' -f $tag, $n)
}

Step ''
Step 'UNLOGALL'
Step 'UNLOGALL USB2'
Step 'UNLOG USB2 RANGEB'
Step 'UNLOG USB2_29 RANGEB'
Step 'UNLOGALL USB2_29'
Step 'UNLOGALL USB2_30'
Step 'LOG LOGLISTA ONCE'
Drain-For 2000

$sp.Close(); $sp.Dispose()
[System.IO.File]::WriteAllBytes($Out, $bytes.ToArray())
[System.IO.File]::WriteAllLines($Txt, $logLines.ToArray())
Write-Output ('wrote ' + $bytes.Count + ' bytes')
