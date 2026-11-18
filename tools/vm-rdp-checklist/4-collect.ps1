# Write a single JSON blob with everything the three items need.
$ErrorActionPreference = 'Continue'
$out = 'C:\fsa_vm\rdp-collect.json'
$data = [ordered]@{ collected_at = (Get-Date).ToString('o') }
$data.fDenyTSConnections = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction SilentlyContinue).fDenyTSConnections
$data.sessions = @(query session 2>&1 | ForEach-Object { $_.ToString() })
$data.users    = @(query user 2>&1 | ForEach-Object { $_.ToString() })
$data.port3389 = @(netstat -an 2>&1 | Select-String ':3389' | ForEach-Object { $_.Line.Trim() })
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
$h = [W.U]::GetForegroundWindow()
$data.foreground = if ($h -eq [IntPtr]::Zero) { 'NONE' } else { 'OK' }
$data.foreground_handle = $h.ToInt64()
$data.autoupdate = $null
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7799/api/workflows/jobs?limit=5' -UseBasicParsing -TimeoutSec 20
  $j = ($r.Content | ConvertFrom-Json).jobs | Where-Object { $_.workflow -eq 'gui.suite.autoupdate' } | Select-Object -First 1
  if ($j) {
    $data.autoupdate = [ordered]@{ job_id=$j.job_id; status=$j.status; current_step=$j.current_step; step_index=$j.step_index }
  }
} catch { $data.autoupdate = 'ERR: ' + $_.Exception.Message }
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
$data | ConvertTo-Json -Depth 6 | Set-Content -Path $out -Encoding UTF8
Write-Output ('WROTE ' + $out)
Write-Output ($data | ConvertTo-Json -Depth 6)