# ASCII only.
# Read-only attempt to read back two receiver settings, and what it actually measured.
#
# The assumption going in was that a bare `SBASCONTROL` / `ETHCONFIG` prints the current setting
# (NovAtel's usual query form). Measured 2026-11-01 on this OEM729, both answer
# `<ERROR:Message missing field`: on this firmware they are write-only, so the SBAS setting and the
# number of configured ethernet interfaces cannot be read back this way. Nothing was written.
#
# Kept as a tool because it is the shortest way to re-check that claim on another unit, and because
# the mistake is worth remembering: "the suite's config pages show these values" does not mean the
# receiver answers a bare command.
#
# The port is opened, the two commands are typed, the replies are copied out, and the port is closed.
param(
  [string]$Port = 'COM10',
  [int]$Baud = 115200
)

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
try { $sp.Open() } catch { Write-Output ("OPEN-FAILED " + $Port + ": " + $_.Exception.Message); exit 2 }
Start-Sleep -Milliseconds 300
$buf = New-Object byte[] 65536
$latin1 = [Text.Encoding]::GetEncoding(28591)

function Drain-Some([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    try { $have = $sp.BytesToRead; if ($have -gt 0) { $null = $sp.Read($buf, 0, [Math]::Min($buf.Length, $have)) } else { Start-Sleep -Milliseconds 5 } }
    catch { Start-Sleep -Milliseconds 5 }
  }
}

# Let the permanent RANGE stream settle, then throw the backlog away so only the reply is captured.
Drain-Some 1500

foreach ($cmd in @('SBASCONTROL', 'ETHCONFIG')) {
  $sp.DiscardInBuffer()
  $sp.Write($cmd + "`r`n")
  Start-Sleep -Milliseconds 600
  $bytes = New-Object System.Collections.Generic.List[byte]
  $deadline = (Get-Date).AddMilliseconds(400)
  while ((Get-Date) -lt $deadline) {
    $have = $sp.BytesToRead
    if ($have -gt 0) { $r = $sp.Read($buf, 0, [Math]::Min($buf.Length, $have)); for ($i = 0; $i -lt $r; $i++) { $bytes.Add($buf[$i]) } }
    else { Start-Sleep -Milliseconds 5 }
  }
  $txt = $latin1.GetString($bytes.ToArray())
  # Binary records in the same window would be noise; keep only the printable reply text.
  $clean = ($txt -replace '[^ -~\r\n]', ' ' -replace ' {2,}', ' ').Trim()
  Write-Output ('--- ' + $cmd + ' ---')
  Write-Output $clean
}

$sp.Close()
$sp.Dispose()
