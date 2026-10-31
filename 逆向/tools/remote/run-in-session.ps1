
# ASCII only. Runs a PowerShell script inside the LOGGED-ON desktop session (interactive task),
# so GUI work (window screenshots, UI automation) happens where the desktop actually lives.
# SSH-spawned processes land in session 0 and see no desktop - that is why this exists.
#
# Run this ON the machine that owns the desktop:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-in-session.ps1 -Script C:\path\x.ps1
#   ... -Script x.ps1 -Wait 8 -Keep   (keep the task registered for debugging)
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [string]$TaskName = 'nova-task',
  [int]$Wait = 5,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Script)) { throw "script not found: $Script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '"')
$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Write-Output ('identity : ' + $who)
Write-Output ('script   : ' + $Script)
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds $Wait

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output ('result   : ' + $info.LastTaskResult)
Write-Output ('session  : ' + (Get-Process -Id $PID).SessionId + ' (this one; the task runs in the logged-on session)')
if (-not $Keep) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output 'task removed'
} else {
  Write-Output ('task kept: ' + $TaskName)
}
