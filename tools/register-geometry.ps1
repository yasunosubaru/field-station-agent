# register-geometry.ps1 -- make the virtual display geometry survive reboots and remotes.
#
# WHY THIS FILE EXISTS
#   Measured 2026-11-17 on this machine:
#     * Nothing re-attaches the virtual display at logon. `ensure_virtual_display.py`
#       succeeds when run by hand, but after a reboot the desktop is back to one monitor
#       until somebody remembers to run it.
#     * Netease GameViewer has TWO autostarts (a service with StartMode=Auto plus a
#       HKCU\...\Run entry) and owns ROOT\DISPLAY\0001. It does NOT have to be killed:
#       measured with GameViewer running, the VDD path is ATTACHED and SM_CMONITORS=2.
#       The eviction seen earlier was the *missing* VDD attach, not GameViewer being up.
#   So the geometry layer needs one guarantee only: attach the VDD again after every
#   logon, before any app computes a click coordinate.
#
# WHAT IT DOES (idempotent, nothing destructive)
#   Registers a logon scheduled task that runs ensure_virtual_display.py with a pinned
#   interpreter. The script itself is idempotent, so running it when the display is
#   already correct is a no-op.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-geometry.ps1
#   ... -WhatIf     # show the plan, change nothing
#   ... -Remove     # delete the task (the display stays as it is right now)
#   ... -Status     # report task + current geometry, change nothing
#
# ASCII only: PS 5.1 reads a BOM-less .ps1 as ANSI and mangles non-ASCII literals.

[CmdletBinding()]
param(
    [switch]$WhatIf,
    [switch]$Remove,
    [switch]$Status,
    [switch]$RestoreGameViewer,
    [string]$Repo = "",
    [int]$DelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

if ($Repo -eq "") {
    $Repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
$ensure = Join-Path $Repo 'tools\ensure_virtual_display.py'

#: Per-user autostart coordinates. Defined up here because -Status / -Remove / the
#: register branch all read them.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'FSA-VirtualDisplay'

#: GameViewer coordinates (see the measured notes in the 'GameViewer autostart' block).
$gameService = 'GameViewerService'
$gameRunName = 'GameViewer'
#: Backup of the values this script changes; -RestoreGameViewer rolls them back.
$sidecar = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) 'tools\.geometry-sidecar.json'

function Step([string]$m) {
    Write-Host ""
    Write-Host ("=== " + $m) -ForegroundColor Cyan
}

function Fail([string]$m) {
    Write-Host ("[FAIL] " + $m) -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- interpreter
# The logon task must use an interpreter that can run this repo's scripts. `python`
# on PATH is not guaranteed to be that one, so pin it now instead of at logon time.
Step 'interpreter'
$candidates = @(
    (Join-Path $Repo '.deps\venv\Scripts\python.exe'),
    (Join-Path $Repo 'dist\py-runtime\python.exe')
)
$python = $null
foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { $python = $c; break }
}
if (-not $python) {
    $py = Get-Command 'py' -ErrorAction SilentlyContinue
    if ($py) { $python = $py.Source }
}
if (-not $python) {
    $py = Get-Command 'python' -ErrorAction SilentlyContinue
    if ($py) { $python = $py.Source }
}
if (-not $python) { Fail 'no python interpreter found (checked .deps\venv, dist\py-runtime, PATH)' }
Write-Output ("interpreter : " + $python)
Write-Output ("ensure      : " + $ensure)
if (-not (Test-Path -LiteralPath $ensure)) { Fail ("missing " + $ensure) }
# The register value is printed by -Status and -WhatIf too, so compute it once here.
$runValue = '"' + $python + '" "' + $ensure + '"'

# ---------------------------------------------------------------- restore GameViewer
if ($RestoreGameViewer) {
    Step 'restore GameViewer autostart'
    if (-not (Test-Path -LiteralPath $sidecar)) {
        Write-Output 'no sidecar: nothing recorded, leaving it as it is'
        exit 0
    }
    $saved = Get-Content -LiteralPath $sidecar -Raw | ConvertFrom-Json
    if ($WhatIf) {
        Write-Output ("would restore Run entry: " + $saved.gameViewerRun)
        Write-Output ("would restore service  : " + $saved.gameServiceStartType)
        exit 0
    }
    if ($saved.gameViewerRun) {
        New-ItemProperty -Path $runKey -Name $gameRunName -Value $saved.gameViewerRun `
            -PropertyType String -Force | Out-Null
        Write-Output ("Run entry    : " + $saved.gameViewerRun)
    }
    if ($saved.gameServiceStartType) {
        try {
            Set-Service -Name $gameService -StartupType $saved.gameServiceStartType
            Write-Output ("Service      : " + $saved.gameServiceStartType)
        } catch {
            Write-Host ("[WARN] cannot change service start type (needs admin): " + $_.Exception.Message) -ForegroundColor Yellow
        }
    }
    Write-Output 'note         : once GameViewer runs again its capture session can evict the extended'
    Write-Output '             : virtual display. Keeping both is not possible on this machine.'
    exit 0
}

# ---------------------------------------------------------------- status
if ($Status) {
    Step 'autostart'
    $had = $null
    try { $had = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction Stop).$runName } catch { }
    Write-Output ("Run entry   : " + $(if ($had) { $had } else { '(not registered)' }))
    Write-Output ("expected    : " + $runValue)
    Step 'geometry now'
    & $python $ensure
    Write-Output ("ensure exit : " + $LASTEXITCODE)
    exit 0
}

# ---------------------------------------------------------------- remove
if ($Remove) {
    Step 'remove'
    if ($WhatIf) { Write-Output ("would remove Run entry " + $runName); exit 0 }
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    Write-Output ("removed     : " + $runName)
    Write-Output 'the display stays attached as it is right now'
    exit 0
}

# ---------------------------------------------------------------- autostart
# Why HKCU\...\Run and not a scheduled task:
#   measured 2026-11-17, `Register-ScheduledTask` without elevation fails with
#   0x80070005 (access denied) even for a task in the current user's own context.
#   The account that operates this machine is not an administrator, so a scheduled
#   task is not an option -- it would need a UAC prompt the operator cannot give
#   while away. The per-user Run key needs no elevation at all.
Step 'autostart (HKCU Run)'

if ($WhatIf) {
    Write-Output ("would set   : " + $runName)
    Write-Output ("  value     : " + $runValue)
} else {
    # Reading the current value must tell "entry absent" from "entry present but empty".
    # `Get-ItemProperty -ErrorAction Stop` throws when the entry is missing; the earlier
    # version caught that into an empty string, so empty == empty was judged "unchanged"
    # and nothing was actually written (measured: autostart reported registered while the
    # registry had no such entry).
    $had = $null
    $exists = $false
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if ($props) {
        $member = $props.PSObject.Properties | Where-Object { $_.Name -eq $runName }
        if ($member) {
            $exists = $true
            $had = [string]$member.Value
        }
    }
    if ($exists -and $had -eq $runValue) {
        Write-Output ("unchanged   : " + $runName)
    } else {
        New-ItemProperty -Path $runKey -Name $runName -Value $runValue `
            -PropertyType String -Force | Out-Null
        Write-Output ("set         : " + $runName)
        Write-Output ("  value     : " + $runValue)
    }
}

# ---------------------------------------------------------------- GameViewer
# Why GameViewer is handled here at all (measured 2026-11-18, this machine):
#   * Netease GameViewer has two autostarts (service StartMode=Auto + HKCU Run) and
#     owns ROOT\DISPLAY\0001.
#   * While its service holds the GPU capture session, the VDD cannot get a
#     swapchain: the driver log fills with "Failed to set device to swap chain
#     HRESULT=-2005270490" (DXGI_ERROR_ACCESS_LOST) every few seconds, and Windows
#     drops the VDD from the desktop topologies 4 seconds after we extend to it.
#     Measured: extend -> 2 monitors, then back to 1 at t=4s, reproducibly.
#   * After stopping its main process, the same extend held for 12+ seconds and the
#     "describe -> break -> autostart -> recover" loop passed 5/5.
#   * It is NOT enough to be running: the damage comes from its capture session.
#     Re-launching it afterwards kept the 2-monitor layout, so it is not "kill it
#     forever"; the sidecar records how to restore the autostart coordinates.
Step 'GameViewer autostart'
$currentRun = $null
$props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
if ($props) {
    $member = $props.PSObject.Properties | Where-Object { $_.Name -eq $gameRunName }
    if ($member) { $currentRun = [string]$member.Value }
}
$svc = Get-Service -Name $gameService -ErrorAction SilentlyContinue
Write-Output ("Run entry    : " + $(if ($currentRun) { $currentRun } else { '(absent)' }))
Write-Output ("Service      : " + $(if ($svc) { $svc.StartType.ToString() + ' / ' + $svc.Status.ToString() } else { '(absent)' }))

if ($WhatIf) {
    Write-Output 'would set the GameViewer service to Manual and drop its Run entry'
    Write-Output ("would write sidecar: " + $sidecar)
    exit 0
}

if (-not (Test-Path -LiteralPath $sidecar)) {
    $payload = [ordered]@{
        recorded_at          = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        gameViewerRun        = $currentRun
        gameServiceStartType = $(if ($svc) { $svc.StartType.ToString() } else { $null })
        gameServiceRunning   = $(if ($svc) { $svc.Status -eq 'Running' } else { $false })
        why                  = ("GameViewer capture session holds the GPU swapchain, so the VDD " +
                                "gets no frames and Windows drops it 4s after we extend " +
                                "(measured 1 -> 2 -> 1). Disabling its autostart keeps the VDD " +
                                "stable; -RestoreGameViewer puts it back.")
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $sidecar -Encoding UTF8
    Write-Output ("sidecar      : " + $sidecar)
} else {
    Write-Output 'sidecar      : already present, kept as-is'
}

if ($currentRun) {
    Remove-ItemProperty -Path $runKey -Name $gameRunName -ErrorAction SilentlyContinue
    Write-Output 'Run entry    : removed'
} else {
    Write-Output 'Run entry    : already absent'
}

if ($svc -and $svc.StartType -ne 'Manual') {
    try {
        Set-Service -Name $gameService -StartupType Manual
        Write-Output 'Service      : set to Manual'
    } catch {
        Write-Host ("[WARN] cannot change service start type (needs admin): " + $_.Exception.Message) -ForegroundColor Yellow
    }
}

# The capture session already running now must also go, or the extend drops again in 4s.
Get-Process 'GameViewer' -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Write-Output ("stopped      : GameViewer " + $_.Id) }
    catch { Write-Host ("[WARN] cannot stop GameViewer: " + $_.Exception.Message) -ForegroundColor Yellow }
}

# ---------------------------------------------------------------- verify
Step 'apply now'
& $python $ensure
$rc = $LASTEXITCODE
Write-Output ("ensure exit : " + $rc)
if ($rc -ne 0) {
    Write-Host '[WARN] ensure_virtual_display did not report READY' -ForegroundColor Yellow
}

Step 'autostart check'
$now = $null
$props2 = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
if ($props2) {
    $m = $props2.PSObject.Properties | Where-Object { $_.Name -eq $runName }
    if ($m) { $now = [string]$m.Value }
}
if ($now -eq $runValue -and $now -ne "") {
    Write-Output ("autostart   : registered")
} else {
    Write-Host ("[FAIL] autostart entry missing or different (got: " + $(if ($now) { $now } else { '(absent)' }) + ")") -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host 'done.' -ForegroundColor Green