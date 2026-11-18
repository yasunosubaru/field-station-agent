# keep-desktop.ps1 -- keep the desktop painting while an unattended RPA run is in progress.
#
# WHY: when an RDP session disconnects, Windows marks the session "Disc". From that moment
# the desktop stops painting: GetForegroundWindow() returns 0, Graphics.CopyFromScreen
# throws "The handle is invalid", and Electron stops repainting. CDP cannot fix this --
# it only changes what the page THINKS its viewport is; it cannot make Windows draw.
#
# Three independent measures, each covering a different failure:
#
#   1. RemoteDesktop_SuppressWhenMinimized = 2   (HKCU, no admin needed)
#      keeps painting while the RDP window is minimised.
#   2. tscon <id> /dest:console                  (needs admin for other sessions)
#      hands a DISCONNECTED session back to the console so it keeps a display.
#   3. SetThreadExecutionState(...)              (no admin)
#      stops the display/system from going to sleep mid-run.
#
# Measure 2 leaves the console session UNLOCKED. Anyone who can see the physical screen
# can then use the logged-in desktop. Only use it on machines where that is acceptable.
#
# ASCII only on purpose: PS 5.1 reads a BOM-less .ps1 as ANSI and mangles non-ASCII literals.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\keep-desktop.ps1
#   ... -Apply          # actually set the registry value and enable keep-awake
#   ... -Reconnect      # also tscon any disconnected session to console (needs admin)
#   ... -Status         # report current state, change nothing
#   ... -Revert         # remove the registry value and release keep-awake
#
# Without -Apply/-Reconnect/-Revert the script behaves like -Status.
#
# Exit codes:
#   0  state is as requested (or status printed)
#   2  could not apply (missing privilege / unsupported)
#   3  applied but verification failed

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Reconnect,
    [switch]$Revert,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$keyPath = 'HKCU:\Software\Microsoft\Terminal Server Client'
$valueName = 'RemoteDesktop_SuppressWhenMinimized'

# --------------------------------------------------------------------------- helpers
# Localised session states. A .ps1 here must stay pure ASCII (PS 5.1 reads a BOM-less
# file as ANSI and mangles non-ASCII literals), so the CJK tokens are built from code
# points instead of written as literals:
#   RUNNING  = U+8FD0 U+884C U+4E2D  (Chinese "running")
#   DISCONN  = U+65AD U+5F00         (Chinese "disconnected")
#   ACTIVE2  = U+6D3B U+52A8         (Chinese "active")
$LOCAL_RUNNING = [string][char]0x8FD0 + [char]0x884C + [char]0x4E2D
$LOCAL_DISC = [string][char]0x65AD + [char]0x5F00
$LOCAL_ACTIVE = [string][char]0x6D3B + [char]0x52A8

function Get-Sessions {
    # Parse `query session`. The STATE column is localised ("Running"/"Disc" on English,
    # CJK on Chinese Windows), so both spellings are accepted. `services` and `rdp-tcp`
    # are excluded by the caller; they are not user sessions.
    $out = @()
    $lines = & query.exe session 2>$null
    foreach ($line in $lines) {
        if ($line -notmatch '^\s*[> ]?\s*(\S+)\s+(\S*)\s+(\d+)\s+(.+?)\s*$') { continue }
        $name = $Matches[1]
        if ($name -eq 'SESSIONNAME' -or $name -match '^-+$') { continue }
        $rest = $Matches[4].Trim()
        $isDisc = ($rest -match 'Disc') -or ($rest.Contains($LOCAL_DISC))
        $isActive = ($rest -match 'Active') -or ($rest.Contains($LOCAL_RUNNING)) -or ($rest.Contains($LOCAL_ACTIVE))
        $out += [PSCustomObject]@{
            Name     = $name
            User     = $Matches[2]
            Id       = [int]$Matches[3]
            State    = $rest
            IsDisc   = $isDisc
            IsActive = $isActive
        }
    }
    return $out
}

function Show-Status {
    # NOTE: the caller does `$current = Show-Status`, which captures EVERYTHING this
    # function writes to the output stream -- including Write-Output. So the human
    # readable lines must go to the host directly (Write-Host), and only the machine
    # readable object may be returned. Using Write-Output here silently swallowed the
    # whole status report.
    $value = $null
    if (Test-Path $keyPath) {
        $value = (Get-ItemProperty -Path $keyPath -Name $valueName -ErrorAction SilentlyContinue).$valueName
    }
    if ($null -eq $value) {
        Write-Host ("registry    : {0} not set (minimised RDP window stops painting)" -f $valueName)
    } else {
        Write-Host ("registry    : {0} = {1}" -f $valueName, $value)
    }

    $sessions = Get-Sessions
    $userSessions = @($sessions | Where-Object { $_.Name -ne 'services' -and $_.Name -ne 'rdp-tcp' })
    $disc = @($userSessions | Where-Object { $_.IsDisc })
    Write-Host ("sessions    : {0} total, {1} disconnected (excluding services)" -f `
        $sessions.Count, $disc.Count)
    if ($sessions.Count -eq 0) {
        Write-Host ("              (query.exe session returned nothing parseable)")
    }
    foreach ($s in $userSessions) {
        Write-Host ("              {0,-12} user={1,-16} id={2,-4} {3}" -f `
            $s.Name, $s.User, $s.Id, $s.State)
    }
    return [PSCustomObject]@{ RegistryValue = $value; Disconnected = $disc; Sessions = $sessions }
}

function Enable-KeepAwake {
    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
    # NOTE: this only holds while THIS process lives. The scheduled task that calls
    # keep-desktop.ps1 exits right after, so the flag is released with it. That is why
    # the caller must keep a long-lived guard process, or call this in the RPA process.
    if (-not ('FsaAwake' -as [type])) {
        Add-Type -Namespace '' -Name 'FsaAwake' -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
    }
    $flags = [uint32]2147483649  # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1)
    $flags = $flags -bor 0x2     # | ES_DISPLAY_REQUIRED (0x2)
    $prev = [FsaAwake]::SetThreadExecutionState($flags)
    return $prev
}

function New-KeeperScript {
    # The flag lives only as long as the calling thread, so the real keeper has to be a
    # long-lived process. We write it out once and let Task Scheduler run it.
    $dir = Split-Path -Parent $PSCommandPath
    $keeper = Join-Path $dir 'keep-desktop-keeper.ps1'
    $body = @'
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
'@
    Set-Content -Path $keeper -Value $body -Encoding ASCII
    return $keeper
}

# --------------------------------------------------------------------------- status
$current = Show-Status

if ($Revert) {
    if (Test-Path $keyPath) {
        # Write the unset directive as a .reg file and import it. The temp file is left in
        # the system temp dir (this repo forbids delete operations inside scripts).
        $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('fsa-unset-suppress-{0}.reg' -f ([guid]::NewGuid().ToString('N'))))
        $text = "Windows Registry Editor Version 5.00`r`n`r`n[HKEY_CURRENT_USER\Software\Microsoft\Terminal Server Client]`r`n`"$valueName`"=-`r`n"
        [System.IO.File]::WriteAllText($tmp, $text, [System.Text.Encoding]::ASCII)
        # reg.exe prints "The operation completed successfully." on STDERR even when it
        # worked, which PowerShell 5.1 then wraps into a NativeCommandError. Redirect it.
        & reg.exe import $tmp 2>&1 | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -ne 0) {
            Write-Output ("ERROR reg import failed rc={0}" -f $rc)
            exit 3
        }
        Write-Output ("revert      : imported {0}" -f $tmp)
    }
    if (-not ('FsaAwake' -as [type])) {
        Add-Type -Namespace '' -Name 'FsaAwake' -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
    }
    [void][FsaAwake]::SetThreadExecutionState([uint32]2147483648)
    Write-Output "result      : reverted (registry value removed, keep-awake released)"
    exit 0
}

if (-not $Apply -and -not $Reconnect) {
    Write-Output "result      : status only (pass -Apply / -Reconnect / -Revert to change)"
    exit 0
}

# --------------------------------------------------------------------------- apply
if ($Apply) {
    if (-not (Test-Path $keyPath)) {
        New-Item -Path $keyPath -Force | Out-Null
    }
    New-ItemProperty -Path $keyPath -Name $valueName -Value 2 -PropertyType DWord -Force | Out-Null
    $got = (Get-ItemProperty -Path $keyPath -Name $valueName).$valueName
    Write-Output ("registry    : set to {0}" -f $got)
    if ($got -ne 2) {
        Write-Output "ERROR registry value did not stick"
        exit 3
    }

    $keeper = New-KeeperScript
    Write-Output ("keeper      : {0}" -f $keeper)
    [void](Enable-KeepAwake)
    Write-Output "keep-awake  : enabled for this process (use the keeper for long runs)"
}

if ($Reconnect) {
    $disc = @($current.Disconnected)
    if ($disc.Count -eq 0) {
        Write-Output "reconnect   : no disconnected session, nothing to do"
    } else {
        $ok = $true
        foreach ($s in $disc) {
            Write-Output ("reconnect   : tscon {0} /dest:console" -f $s.Id)
            $out = & tscon.exe $s.Id /dest:console 2>&1
            $rc = $LASTEXITCODE
            if ($rc -ne 0) {
                Write-Output ("              failed rc={0}: {1}" -f $rc, ($out -join ' '))
                if ($rc -eq 5 -or "$out" -match 'access is denied|denied') {
                    Write-Output "              needs an elevated shell (Run as Administrator)"
                }
                $ok = $false
            } else {
                Write-Output "              ok"
            }
        }
        Start-Sleep -Milliseconds 800
        $after = @((Show-Status).Disconnected)
        Write-Output ("reconnect   : disconnected sessions after = {0}" -f $after.Count)
        if (-not $ok) { exit 2 }
        if ($after.Count -ne 0) { exit 3 }
    }
}

exit 0
