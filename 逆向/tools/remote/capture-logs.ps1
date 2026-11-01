# Capture a receiver session: UNLOGALL, run the given LOG lines spaced out, dump every byte.
# ASCII only. Usage: capture-logs.ps1 -Commands "LOG XB ONTIME 1","LOG YB ONCE" -Seconds 20 -Out file
param(
  [string]$Com = 'COM10',
  [int]$Baud = 115200,
  [string[]]$Commands = @(),
  [int]$DrainSeconds = 8,
  [int]$Seconds = 20,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\capture.bin'
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
      } else { Start-Sleep -Milliseconds 50 }
    } catch { Start-Sleep -Milliseconds 50 }
  }
}
function Send-Line([string]$line) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`r`n")
  $sp.Write($bytes, 0, $bytes.Length)
}

Send-Line 'UNLOGALL'
Drain $DrainSeconds
$mark = $buffer.Count
Write-Output ("drained " + $mark + " bytes")

foreach ($command in $Commands) {
  Send-Line $command
  Start-Sleep -Milliseconds 150
}
Drain $Seconds
Write-Output ("captured " + ($buffer.Count - $mark) + " bytes after the commands")

Send-Line 'UNLOGALL'
Drain 2
$sp.Close()
[System.IO.File]::WriteAllBytes($Out, $buffer.ToArray())
Write-Output ("wrote " + $buffer.Count + " bytes to " + $Out)
