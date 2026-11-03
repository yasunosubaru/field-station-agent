# ASCII only.
# B6 retry probe: the same candidate names, but logged `ONTIME 1` for N seconds instead of `ONCE`.
#
# Why this exists: `LOG <name>B ONCE` asks for one record at the next epoch of that log. A log that
# only fires "on change" can answer `<OK` and then stay silent forever, so an ONCE verdict of
# OK-NODATA is not proof that the log never produces a record. This script gives every name a
# one-second rate for the whole window and counts the binary records by id, so a log that fires at
# all is caught no matter how rarely it decides to.
#
# Ids 41/42/43 (the permanent RANGE stream) and 93/72/963 count too here but are reported separately,
# so the verdict line is not confused by traffic that arrives whatever is logged.
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200,
  [string]$Out = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b6-retry.txt'),
  [int]$Seconds = 25,
  [string]$Names = ''
)

if ($Names -eq '') { Write-Output 'need -Names'; exit 2 }
$list = @()
foreach ($c in $Names.Split(',')) { $t = $c.Trim(); if ($t -ne '') { $list += $t } }
if ($list.Count -gt 30) { Write-Output ('too many names for one phase: ' + $list.Count); exit 2 }

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300
$buf = New-Object byte[] 65536

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Set-Content -Path $Out -Value '' -Encoding ASCII

$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 500

# Discard the backlog that the port streams on open.
$deadline = (Get-Date).AddMilliseconds(1500)
while ((Get-Date) -lt $deadline) {
  if ($sp.BytesToRead -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $sp.BytesToRead)) } else { Start-Sleep -Milliseconds 10 }
}

# The port holds ~32 logs; 30 names is the ceiling and the ONTIME form does accumulate.
foreach ($name in $list) {
  $sp.Write('LOG ' + $name + "B ONTIME 1`r`n")
  Start-Sleep -Milliseconds 160
}

$bytes = New-Object System.Collections.Generic.List[byte]
$deadline = (Get-Date).AddMilliseconds($Seconds * 1000)
while ((Get-Date) -lt $deadline) {
  $have = $sp.BytesToRead
  if ($have -gt 0) {
    $read = $sp.Read($buf, 0, [Math]::Min($buf.Length, $have))
    for ($i = 0; $i -lt $read; $i++) { $bytes.Add($buf[$i]) }
  } else { Start-Sleep -Milliseconds 10 }
}

$sp.Write("UNLOGALL`r`n")
Start-Sleep -Milliseconds 250
$sp.Write("UNLOGALL USB2`r`n")
Start-Sleep -Milliseconds 300
$sp.Close()
$sp.Dispose()

$arr = $bytes.ToArray()
$found = @{}
for ($i = 0; $i + 5 -lt $arr.Length; $i++) {
  if ($arr[$i] -eq 0xAA -and $arr[$i + 1] -eq 0x44 -and $arr[$i + 2] -eq 0x12 -and $arr[$i + 3] -eq 28) {
    $id = $arr[$i + 4] + 256 * $arr[$i + 5]
    $found[$id] = 1 + [int]$found[$id]
  }
}
$auto = @{ 41 = 1; 42 = 1; 43 = 1; 93 = 1; 72 = 1; 963 = 1 }
Add-Content -Path $Out -Value ('window ' + $Seconds + ' s, ' + $arr.Length + ' B, ' + $list.Count + ' names ONTIME 1') -Encoding ASCII
foreach ($k in ($found.Keys | Sort-Object)) {
  $tag = ''
  if ($auto.ContainsKey($k)) { $tag = '  (fires on its own)' }
  $line = ('id {0,-6} x{1,-5}{2}' -f $k, $found[$k], $tag)
  Add-Content -Path $Out -Value $line -Encoding ASCII
  Write-Output $line
}
$miss = @()
Get-Content $Out | Write-Output
