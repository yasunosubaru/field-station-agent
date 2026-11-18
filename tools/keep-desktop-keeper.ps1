# keep-desktop-keeper.ps1 -- holds ES_* flags for as long as it runs. ASCII only.
param([int]$Minutes = 0)
if (-not ('FsaAwake2' -as [type])) {
    Add-Type -Namespace '' -Name 'FsaAwake2' -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@
}
[void][FsaAwake2]::SetThreadExecutionState([uint32]2147483651)
$deadline = if ($Minutes -gt 0) { (Get-Date).AddMinutes($Minutes) } else { [datetime]::MaxValue }
while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 30 }
[void][FsaAwake2]::SetThreadExecutionState([uint32]2147483648)
