# ASCII only. B7 phase 1: ask the receiver what ITK / events / multi-frequency support it has.
# Every command is sent alone, the reply is drained and written to a transcript next to the raw bytes,
# so a `<ERROR...>` can be quoted with the exact command that produced it.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File b7-probe.ps1 -Port COM10
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b7-probe.bin'),
  [string]$Txt = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b7-probe.txt'),
  [int]$WaitMs = 1500
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
function Ask([string]$line) {
  $before = $buf.Count
  $sp.Write($line + "`r`n")
  Drain-For $WaitMs
  $after = $buf.Count
  $slice = New-Object byte[] ($after - $before)
  for ($i = 0; $i -lt $slice.Length; $i++) { $slice[$i] = $buf[$before + $i] }
  $text = Flatten $slice
  $lines.Add('=== ' + $line + '  [' + $slice.Length + ' bytes]')
  if ($text.Length -gt 1400) { $lines.Add($text.Substring(0, 1400) + ' ...(cut)') } else { $lines.Add($text) }
  Write-Output ($line + ' -> ' + $slice.Length + ' bytes')
}

# A historic backlog streams when the port opens; clear it so the transcript starts at our commands.
$sp.Write("UNLOGALL`r`n"); Drain-For 3000
$sp.Write("UNLOGALL USB2`r`n"); Drain-For 1000
$lines.Add('### drain done; buffer ' + $buf.Count)

# --- 1. queries: what does the receiver accept, and what does it answer ---------
Ask 'VERSION'
Ask 'ITSPECTRALANALYSIS'
Ask 'ITDETECTCONFIG'
Ask 'ITWARNINGCONFIG'
Ask 'ITFRONTENDMODE'
Ask 'ITBANDPASSBANK'
Ask 'ITPROGFILTBANK'
Ask 'SPOOFDETECT'
Ask 'CHANCONFIGLIST'
Ask 'HWMONITOR'
Ask 'ITWARNINGCONFIG 1'   # try to read back level 1 only if the bare query was refused

# --- 2. one ONCE per ITK log, in small groups so the 32-log budget is never hit --
Ask 'UNLOGALL'
Ask 'LOG ITDETECTSTATUSB ONCE'
Ask 'LOG ITDETECTSTATUSA ONCE'
Ask 'LOG ITPSDDETECTB ONCE'
Ask 'LOG ITBANDPASSBANKB ONCE'
Ask 'LOG ITPROGFILTBANKB ONCE'
Ask 'LOG ITFRONTENDMODEB ONCE'
Ask 'LOG ITFILTTABLEB ONCE'
Ask 'LOG ITDETECTCONFIGB ONCE'
Ask 'LOG ITSPECTRALANALYSISB ONCE'
Ask 'LOG ITWARNINGCONFIGB ONCE'
Ask 'UNLOGALL'
Drain-For 500

# --- 3. the events channel: what does RXSTATUSEVENT say when it fires -----------
Ask 'LOG RXSTATUSEVENTA ONCHANGED'
Drain-For 1000
Ask 'LOG NOTAREALLOGB ONCE'
Ask 'LOG RANGEB NOTAREALTYPE ONCE'
Ask 'ITDETECTCONFIG 1 1 1 1 1 1 1 1'
Ask 'CHANCONFIGLIST BAD'
Drain-For 2000

$sp.Write("UNLOGALL`r`n"); Drain-For 400
$sp.Write("UNLOGALL USB2`r`n"); Drain-For 400
$sp.Close(); $sp.Dispose()

[System.IO.File]::WriteAllBytes($Out, $buf.ToArray())
[System.IO.File]::WriteAllLines($Txt, $lines.ToArray())
Write-Output ('wrote ' + $buf.Count + ' bytes to ' + $Out)
Write-Output ('transcript ' + $Txt)
