# Ask the receiver for its port configuration logs, one command at a time, and dump every byte.
# ASCII only. Drains the port before asking so a command is never lost to a full buffer.
param(
  [string]$Com = 'COM10',
  [int]$Baud = 115200,
  [int]$DrainSeconds = 8,
  [int]$AfterSeconds = 12,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\cfg-probe2.bin'
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
      } else {
        Start-Sleep -Milliseconds 60
      }
    } catch {
      Start-Sleep -Milliseconds 60
    }
  }
}

function Send-Line([string]$line) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`r`n")
  $sp.Write($bytes, 0, $bytes.Length)
}

Send-Line 'UNLOGALL'
Drain $DrainSeconds
Write-Output ("after drain: " + $buffer.Count + " bytes")

$mark = $buffer.Count
$commands = @('LOG INTERFACEMODEB ONCE', 'LOG LOGLISTB ONCE', 'LOG SERIALCONFIGB ONCE', 'LOG ICOMCONFIGB ONCE', 'LOG VERSIONB ONCE')
foreach ($command in $commands) {
  Send-Line $command
  Drain 3
  Write-Output ($command + " -> total " + $buffer.Count)
}
Drain $AfterSeconds

Send-Line 'UNLOGALL'
Drain 1
$sp.Close()
[System.IO.File]::WriteAllBytes($Out, $buffer.ToArray())
Write-Output ("wrote " + $buffer.Count + " bytes to " + $Out)
