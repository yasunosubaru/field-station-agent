# Open a receiver port, ask it for its configuration logs, and dump every byte it answers.
# ASCII only (a .ps1 with non-ASCII literals gets mangled by the remote console).
param(
  [string]$Com = 'COM10',
  [int]$Baud = 115200,
  [int]$Seconds = 5,
  [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\cfg-probe.bin')
)

$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort $Com, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 500
$sp.WriteTimeout = 500
$sp.Open()
Start-Sleep -Milliseconds 300

function Send-Line([string]$line) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($line + "`r`n")
  $sp.Write($bytes, 0, $bytes.Length)
  Start-Sleep -Milliseconds 600
}

Send-Line 'UNLOGALL'
Start-Sleep -Milliseconds 800

$commands = @(
  'LOG INTERFACEMODEB ONCE',
  'LOG LOGLISTB ONCE',
  'LOG SERIALCONFIGB ONCE',
  'LOG ICOMCONFIGB ONCE',
  'LOG NTRIPCONFIGB ONCE',
  'LOG VERSIONB ONCE'
)
foreach ($command in $commands) { Send-Line $command }

$buffer = New-Object System.Collections.Generic.List[byte]
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  try {
    $n = $sp.BytesToRead
    if ($n -gt 0) {
      $chunk = New-Object byte[] $n
      $read = $sp.Read($chunk, 0, $n)
      for ($i = 0; $i -lt $read; $i++) { $buffer.Add($chunk[$i]) }
    } else {
      Start-Sleep -Milliseconds 100
    }
  } catch {
    Start-Sleep -Milliseconds 100
  }
}

Send-Line 'UNLOGALL'
Start-Sleep -Milliseconds 500
$sp.Close()
[System.IO.File]::WriteAllBytes($Out, $buffer.ToArray())
Write-Output ("wrote " + $buffer.Count + " bytes to " + $Out)
