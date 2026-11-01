# ASCII only. B7 phase 2: with the suite's leftover profile cleared (see b7-flood.ps1), ask the ITK
# questions one at a time. Every reply is written to a transcript keyed by the exact command, so a
# verdict ("refused / no data / no interference") can be quoted with the receiver's own words.
#
# The first command is RXCONFIG: it dumps the current configuration as text (ITK settings and every
# port's INTERFACEMODE included), which is what a later restore is checked against.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File b7-probe2.ps1 -Port COM10
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b7-probe2.bin',
  [string]$Txt = 'C:\Users\niwawa\AppData\Local\Temp\b7-probe2.txt',
  [int]$WaitMs = 1600
)
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 400

$buf = New-Object System.Collections.Generic.List[byte]
$lines = New-Object System.Collections.Generic.List[string]

function Drain-For([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  $chunk = New-Object byte[] 65536
  while ((Get-Date) -lt $deadline) {
    try {
      $have = $sp.BytesToRead
      if ($have -gt 0) {
        $n = $sp.Read($chunk, 0, [Math]::Min($chunk.Length, $have))
        for ($i = 0; $i -lt $n; $i++) { $buf.Add($chunk[$i]) }
      } else { Start-Sleep -Milliseconds 10 }
    } catch { Start-Sleep -Milliseconds 10 }
  }
}
function Flatten([byte[]]$bytes) {
  $latin = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $latin.ToCharArray()) {
    $code = [int][char]$c
    if ($code -eq 13 -or $code -eq 10) { [void]$sb.Append(' | ') }
    elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append('.') }
    else { [void]$sb.Append($c) }
  }
  return $sb.ToString()
}
function Ask([string]$line, [int]$ms = 0) {
  if ($ms -le 0) { $ms = $WaitMs }
  $before = $buf.Count
  $sp.Write($line + "`r`n")
  Start-Sleep -Milliseconds 120
  Drain-For $ms
  $after = $buf.Count
  $slice = New-Object byte[] ($after - $before)
  for ($i = 0; $i -lt $slice.Length; $i++) { $slice[$i] = $buf[$before + $i] }
  $text = Flatten $slice
  $lines.Add('=== ' + $line + '  [' + $slice.Length + ' bytes]')
  if ($text.Length -gt 3000) { $lines.Add($text.Substring(0, 3000) + ' ...(cut)') } else { $lines.Add($text) }
  Write-Output ('{0,-44} {1,7} bytes' -f $line, $slice.Length)
}

# --- clean slate: the suite's multi-port owner streams on USB2_29/USB2_30, a bare UNLOGALL misses it
Ask 'UNLOGALL' 600
Ask 'UNLOGALL USB2_29' 400
Ask 'UNLOGALL USB2_30' 400
Ask 'UNLOGALL USB2' 400

# --- 1. what the receiver is configured to do right now (restore reference)
Ask 'RXCONFIG' 9000

# --- 2. multi-frequency: does this unit even have L2/L5 channels configured
Ask 'LOG CHANCONFIGLISTB ONCE' 2500

# --- 3. the ITK records, one ONCE each
Ask 'LOG ITDETECTSTATUSB ONCE' 2500
Ask 'LOG ITDETECTCONFIGB ONCE' 2500
Ask 'LOG ITSPECTRALANALYSISB ONCE' 2500
Ask 'LOG ITPSDDETECTB ONCE' 2500
Ask 'LOG ITFILTTABLEB ONCE' 2000

# --- 4. the ASCII side at 1 Hz: what the detection status actually says
Ask 'UNLOGALL' 400
Ask 'LOG ITDETECTSTATUSA ONTIME 1' 5000
Ask 'LOG ITPSDFINALA ONTIME 1' 4000
Ask 'LOG ITPSDDETECTA ONTIME 1' 4000

# --- 5. events: keep RXSTATUSEVENTA open and provoke it
Ask 'UNLOGALL' 400
Ask 'LOG RXSTATUSEVENTA ONCHANGED' 1200
Ask 'LOG NOTAREALLOGB ONCE' 1200
Ask 'LOG RANGEB NOTAREALTYPE ONCE' 1200
Ask 'LOG RANGEB ONTIME' 1200
Ask 'ITWARNINGCONFIG' 1200
Ask 'ITWARNINGCONFIG 1' 1200
Ask 'ITDETECTCONFIG ALL' 1200
Ask 'INTERFACEMODE COM9 BAD BAD ON' 1200
Ask 'LOG USB2 RANGEB ONTIME 0' 1200
Drain-For 3000

# --- 6. what the receiver says now: did any of that change the config
Ask 'RXCONFIG' 9000

Ask 'UNLOGALL' 600
Ask 'UNLOGALL USB2_29' 400
Ask 'UNLOGALL USB2_30' 400
Ask 'UNLOGALL USB2' 400
$sp.Close(); $sp.Dispose()

[System.IO.File]::WriteAllBytes($Out, $buf.ToArray())
[System.IO.File]::WriteAllLines($Txt, $lines.ToArray())
Write-Output ('wrote ' + $buf.Count + ' bytes; transcript ' + $Txt)
