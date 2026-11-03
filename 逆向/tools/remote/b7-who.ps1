# ASCII only. Who owns the logs still flowing after the wrap-up?
param([string]$Port = 'COM10', [int]$Baud = 115200,
      [string]$Txt = (Join-Path $env:USERPROFILE 'AppData\Local\Temp\b7-who.txt'))
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 100
$sp.WriteTimeout = 1000
$sp.Open()
Start-Sleep -Milliseconds 300
$bytes = New-Object System.Collections.Generic.List[byte]
$chunk = New-Object byte[] 65536
function Drain-For([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
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
$sp.Write("LOG LOGLISTA ONCE`r`n")
Drain-For 4000
$sp.Write("UNLOGALL`r`n"); Drain-For 300
$sp.Write("UNLOGALL USB2_29`r`n"); Drain-For 300
$sp.Write("UNLOGALL USB2_30`r`n"); Drain-For 300
$sp.Write("UNLOGALL USB2`r`n"); Drain-For 300
$sp.Close(); $sp.Dispose()
[System.IO.File]::WriteAllBytes($Txt.Replace('.txt', '.bin'), $bytes.ToArray())
Write-Output ('captured ' + $bytes.Count + ' bytes')
