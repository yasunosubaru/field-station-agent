# ASCII only. Wrap-up state of the receiver host: which COM ports will open (FREE) and what of ours
# is still running. Opening a port for 300 ms and closing it changes nothing on the receiver.
Write-Output ('now   : ' + (Get-Date).ToString('o'))
$ports = [System.IO.Ports.SerialPort]::GetPortNames()
Write-Output ('ports : ' + ($ports -join ','))
foreach ($p in $ports) {
  $sp = $null
  try {
    $sp = New-Object System.IO.Ports.SerialPort -ArgumentList $p, 115200, 'None', 8, 'One'
    $sp.Open()
    Start-Sleep -Milliseconds 300
    Write-Output ('port  : ' + $p + ' FREE')
  } catch {
    Write-Output ('port  : ' + $p + ' BUSY (' + $_.Exception.Message + ')')
  } finally {
    if ($sp) { try { $sp.Close(); $sp.Dispose() } catch { } }
  }
}
Get-Process powershell,pwsh,node -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -ne $PID } |
  ForEach-Object { Write-Output ('proc  : ' + $_.Id + ' ' + $_.ProcessName + ' ' + $_.StartTime) }
Get-ChildItem (Join-Path $env:USERPROFILE 'AppData\Local\Temp') -Filter 'b4*' -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Output ('file  : ' + $_.Name + ' ' + $_.Length) }
