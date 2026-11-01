# ASCII only. B7 capture: the three sample gaps in one recording.
#
#   A. ITK      - ITDETECTSTATUSA / ITPSDFINALA / ITPSDDETECTA at 1 Hz plus the ONCE records
#                 (CHANCONFIGLIST, ITSPECTRALANALYSIS, ITDETECTCONFIG). This receiver detects
#                 interference in the room, so the status records are not all zeros.
#   B. events   - RXSTATUSEVENTA stays open while invalid commands and config changes are thrown at
#                 the receiver, so any description the receiver emits lands inside the capture.
#   C. bands    - RANGEB at 1 Hz next to TRACKSTATB, to see whether sv_freq ever leaves 0.
#
# The port carries the suite's leftover profile under two extra owners (USB2_29 / USB2_30); a bare
# UNLOGALL does not reach those, so all four forms are sent before and after.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File b7-capture.ps1 -Port COM10 -Seconds 45
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = 'C:\Users\niwawa\AppData\Local\Temp\b7.sbf',
  [string]$Txt = 'C:\Users\niwawa\AppData\Local\Temp\b7.txt',
  [int]$Seconds = 45,
  [int]$DrainSeconds = 2
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
}
function Clean([string]$why) {
  Drain-For 400
  Send 'UNLOGALL'
  Drain-For 300
  Send 'UNLOGALL USB2_29'
  Drain-For 300
  Send 'UNLOGALL USB2_30'
  Drain-For 300
  Send 'UNLOGALL USB2'
  Drain-For 300
  $notes.Add('clean ' + $why + ' at ' + $bytes.Count)
}

Clean 'before'
Drain-For ($DrainSeconds * 1000)

# --- 1. config snapshot, so a later read-back can prove nothing was left changed
Send 'LOG RXCONFIGA ONCE'
Drain-For 4000

# --- 2. the ITK ONCE records: what this unit reports about its own ITK settings
Send 'LOG CHANCONFIGLISTB ONCE'
Send 'LOG ITSPECTRALANALYSISB ONCE'
Send 'LOG ITDETECTCONFIGB ONCE'
Send 'LOG ITWARNINGCONFIGB ONCE'
Drain-For 3000

# --- 3. the rate phase: ITK + events + two-frequency RANGE
Send 'LOG ITDETECTSTATUSA ONTIME 1'
Send 'LOG ITPSDFINALA ONTIME 1'
Send 'LOG ITPSDDETECTA ONTIME 1'
Send 'LOG RANGEB ONTIME 1'
Send 'LOG TRACKSTATB ONTIME 5'
Send 'LOG RXSTATUSEVENTA ONCHANGED'
$notes.Add('rate phase starts at ' + $bytes.Count)

$provocations = @(
  @{ at = 10; lines = @('LOG NOTAREALLOGB ONCE') },
  @{ at = 16; lines = @('LOG RANGEB NOTAREALTYPE ONCE') },
  @{ at = 22; lines = @('ITWARNINGCONFIG 1') },
  @{ at = 28; lines = @('ITDETECTCONFIG ALL') },
  @{ at = 34; lines = @('INTERFACEMODE COM9 BAD BAD ON') },
  @{ at = 40; lines = @('ITSPECTRALANALYSIS PREDECIMATION GPSL2 1000 1K 1 1') }
)
$done = @{}
for ($t = 0; $t -lt $Seconds; $t++) {
  Drain-For 1000
  foreach ($p in $provocations) {
    if ($p.at -eq $t -and -not $done.ContainsKey($p.at)) {
      $done[$p.at] = $true
      foreach ($line in $p.lines) {
        $notes.Add('t=' + $t + ' send ' + $line + ' at ' + $bytes.Count)
        Send $line
      }
    }
  }
}
$notes.Add('rate phase ends at ' + $bytes.Count)

Clean 'after'
[System.IO.File]::WriteAllBytes($Out, $bytes.ToArray())
[System.IO.File]::WriteAllLines($Txt, $notes.ToArray())
Write-Output ('captured ' + $bytes.Count + ' bytes to ' + $Out)
