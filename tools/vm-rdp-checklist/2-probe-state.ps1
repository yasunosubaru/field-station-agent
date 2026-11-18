# Collect the session state that items 02 / 03 / 10b depend on.
# Pure ASCII on purpose (PS 5.1 reads BOM-less scripts as ANSI).
$ErrorActionPreference = 'Continue'
Write-Output '=== fDenyTSConnections ==='
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction SilentlyContinue).fDenyTSConnections
Write-Output '=== query session ==='
query session
Write-Output '=== query user ==='
query user
Write-Output '=== 3389 ==='
netstat -an | Select-String ':3389'
Write-Output '=== foreground window ==='
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
$h = [W.U]::GetForegroundWindow()
Write-Output ('GetForegroundWindow=' + $h)
if ($h -eq [IntPtr]::Zero) { Write-Output 'FOREGROUND=NONE' } else { Write-Output 'FOREGROUND=OK' }
Write-Output '=== explorer / dwm ==='
Get-Process explorer, dwm -ErrorAction SilentlyContinue | Select-Object Name, Id, SessionId | Format-Table -AutoSize