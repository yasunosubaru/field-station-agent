
# ASCII only.
# Serial <-> TCP bridge: opens a COM port on this machine and serves its bytes on a TCP port,
# so a client on another machine (e.g. the laptop over Tailscale) can talk to the receiver
# exactly as if it owned the serial port.
#
# Usage (on the receiver host):
#   powershell -NoProfile -ExecutionPolicy Bypass -File serial-bridge.ps1 -Com COM10 -ListenPort 4002
#
# Notes:
#  - one client at a time; when it disconnects the bridge waits for the next one,
#  - the port must be free (the suite holds its own port while it is running),
#  - Ctrl+C (or Stop-Process) to stop; the serial port is closed on exit.
param(
  [string]$Com = 'COM10',
  [int]$Baud = 115200,
  [int]$ListenPort = 4002,
  [int]$PollMs = 5
)

$sp = New-Object System.IO.Ports.SerialPort -ArgumentList $Com, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 200
$sp.WriteTimeout = 500
try {
  $sp.Open()
} catch {
  Write-Output ("OPEN-FAILED " + $Com + ": " + $_.Exception.Message)
  exit 2
}
Write-Output ("serial " + $Com + " open at " + $Baud)

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Any), $ListenPort
$listener.Start()
Write-Output ("listening on 0.0.0.0:" + $ListenPort)

$buf = New-Object byte[] 8192
try {
  while ($true) {
    Write-Output "waiting for client"
    $client = $listener.AcceptTcpClient()
    $client.NoDelay = $true
    $stream = $client.GetStream()
    Write-Output ("client " + $client.Client.RemoteEndPoint)
    try {
      while ($client.Connected) {
        $moved = $false
        if ($sp.BytesToRead -gt 0) {
          $n = $sp.Read($buf, 0, $buf.Length)
          if ($n -gt 0) {
            $stream.Write($buf, 0, $n)
            $moved = $true
          }
        }
        if ($stream.DataAvailable) {
          $n = $stream.Read($buf, 0, $buf.Length)
          if ($n -gt 0) {
            $sp.Write($buf, 0, $n)
            $moved = $true
          }
        }
        if (-not $moved) { Start-Sleep -Milliseconds $PollMs }
      }
    } catch {
      Write-Output ("client ended: " + $_.Exception.Message)
    } finally {
      try { $client.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  try { $sp.Close() } catch { }
  $sp.Dispose()
  Write-Output "bridge stopped"
}
