# install-vdd.ps1 -- install the signed Virtual Display Driver package manually.
#
# WHY manual and not the vendor installer:
#
#   Virtual.Display.Driver-v25.05.03-setup-x64.exe   NotSigned
#   VDDControl-v25.05.03.exe                          NotSigned
#   MttVDD.dll                                        Valid  (SignPath Foundation / GlobalSign)
#   mttvdd.cat                                        Valid  (same signer)
#
# We only run the parts that carry a verifiable chain of trust. The two signing-less
# executables are left alone, which is also what keeps this unattended: nothing pops a
# GUI, nothing downloads anything.
#
# The package itself comes from
#   https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/tag/25.5.2
#   asset: Signed-Driver-v24.12.24-x64.zip
#
# ASCII only: PS 5.1 reads a BOM-less .ps1 as ANSI and mangles non-ASCII literals.
#
# Usage:
#   ... -DryRun           # verify everything, change nothing
#   ... -Uninstall        # remove the package again
#   (no switch)           # install

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$NoWait,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$src   = 'C:\Users\SunCh\AppData\Local\Temp\opencode\vdd\signed'
$stage = Join-Path $repo 'tools\vdd\stage'
$kits  = 'C:\Program Files (x86)\Windows Kits\10'
$binV  = '10.0.26100.0'

# Locale-independent rendering of pnputil's OEM id line. Built from code points because
# this file must stay pure ASCII.
$LOCAL_PUBLISHED = [string][char]0x53D1 + [char]0x5E03 + [char]0x540D + [char]0x79F0

# --------------------------------------------------------------------------- helpers
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Tool {
    param([string]$Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($sub in @('x64', 'x86', 'arm64')) {
        $p = Join-Path $kits "bin\$binV\$sub\$Name"
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Step { param([string]$Name) Write-Output ""; Write-Output ("--- {0}" -f $Name) }

function Finish {
    param([int]$Code)
    if ($Elevated -and -not $NoWait) {
        Write-Output ""
        Write-Output ("exit code   : {0}" -f $Code)
        Write-Output "Press Enter to close this elevated window..."
        try { [void](Read-Host) } catch { }
    }
    exit $Code
}

# --------------------------------------------------------------------------- elevation
if (-not $DryRun -and -not (Test-Admin) -and -not $Elevated) {
    Write-Output "Requesting elevation (a UAC prompt should appear)..."
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    foreach ($sw in @('DryRun', 'Uninstall', 'NoWait')) {
        if ((Get-Variable -Name $sw -ValueOnly)) { $argList += "-$sw" }
    }
    $argList += '-Elevated'
    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList `
            -Verb RunAs -Wait -PassThru
        Write-Output ("elevated    : child exited with {0}" -f $proc.ExitCode)
        exit $proc.ExitCode
    } catch {
        Write-Output "ERROR elevation was declined or failed:"
        Write-Output ("      {0}" -f $_.Exception.Message)
        Finish 2
    }
}

# --------------------------------------------------------------------------- uninstall
if ($Uninstall) {
    Step 'uninstall'
    $left = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -match 'MttVDD' }
    foreach ($n in $left) {
        Write-Output ("removing    : device {0}" -f $n.InstanceId)
        & pnputil.exe /remove-device $n.InstanceId 2>&1 | Out-Null
    }
    $all = & pnputil.exe /enum-drivers 2>&1 | Out-String
    $oems = @()
    foreach ($b in ($all -split "(?=$LOCAL_PUBLISHED\s*:)|(?=Published Name\s*:)")) {
        if ($b -match 'mttvdd\.inf' -and $b -match "(?:$LOCAL_PUBLISHED|Published Name)\s*:\s*(\S+\.inf)") {
            $oems += $Matches[1]
        }
    }
    if ($oems.Count -eq 0) {
        Write-Output "result      : no MttVDD package installed, nothing to remove"
        Finish 0
    }
    foreach ($o in $oems) {
        Write-Output ("deleting    : {0}" -f $o)
        & pnputil.exe /delete-driver $o /uninstall 2>&1 | Select-Object -Last 1 |
            ForEach-Object { "              $_" }
    }
    Write-Output "result      : removed"
    Finish 0
}

# --------------------------------------------------------------------------- preflight
Step 'preflight'
Write-Output ("admin       : {0}" -f (Test-Admin))
if (-not $DryRun -and -not (Test-Admin)) {
    Write-Output "ERROR still not elevated."
    Finish 2
}

if (-not (Test-Path $src)) {
    Write-Output ("ERROR package folder missing: {0}" -f $src)
    Write-Output "      Download Signed-Driver-v24.12.24-x64.zip from the 25.5.2 release"
    Write-Output "      and extract it there."
    Finish 2
}

$dllSrc = Join-Path $src 'MttVDD.dll'
$infSrc = Join-Path $src 'MttVDD.inf'
$catSrc = Join-Path $src 'mttvdd.cat'
foreach ($f in @($dllSrc, $infSrc, $catSrc)) {
    if (-not (Test-Path $f)) {
        Write-Output ("ERROR missing {0}" -f $f)
        Finish 2
    }
}
Write-Output ("package     : {0}" -f $src)

# --------------------------------------------------------------------------- 1 verify
Step 'verify signature'
# Never install a driver we have not verified in THIS run. The status can differ from the
# one seen at download time if the certificate was revoked in between.
foreach ($f in @($dllSrc, $catSrc)) {
    $sig = Get-AuthenticodeSignature $f
    $name = Split-Path -Leaf $f
    $hash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
    Write-Output ("{0,-12}: {1}" -f $name, $sig.Status)
    Write-Output ("  signer    : {0}" -f $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(none)' }))
    Write-Output ("  sha256    : {0}" -f $hash)
    if ($sig.Status -ne 'Valid') {
        Write-Output ("ERROR {0} is not Valid ({1}) -- refusing to install" -f $name, $sig.Status)
        Finish 3
    }
}

# --------------------------------------------------------------------------- 2 stage
Step 'stage'
if ($DryRun) {
    Write-Output ("result      : dry-run, would copy the package into {0}" -f $stage)
} else {
    if (-not (Test-Path $stage)) { New-Item -ItemType Directory -Path $stage -Force | Out-Null }
    foreach ($f in @($dllSrc, $infSrc, $catSrc)) {
        Copy-Item -LiteralPath $f -Destination $stage -Force
    }
    Get-ChildItem $stage -File | ForEach-Object {
        Write-Output ("              {0}  {1} bytes" -f $_.Name, $_.Length)
    }
}

# --------------------------------------------------------------------------- 3 settings
Step 'settings'
# vdd_settings.xml drives how many monitors the driver reports and which modes exist.
# Our geometry layer wants exactly ONE monitor on exactly ONE mode, so rewrite it rather
# than shipping the vendor default (count=1 but five resolutions and six refresh rates).
$settingsPath = 'C:\VirtualDisplayDriver\vdd_settings.xml'
$settings = @'
<?xml version="1.0" encoding="utf-8"?>
<!-- Written by tools/install-vdd.ps1 (FSA). See docs/plans/2026-11-15-local-driver-plan.md
     section 3.3: the geometry layer needs ONE monitor on ONE mode, because a second
     monitor or a second mode is a second coordinate basis. -->
<vdd_settings>
    <monitors>
        <count>1</count>
    </monitors>
    <gpu>
        <friendlyname>default</friendlyname>
    </gpu>
    <global>
        <g_refresh_rate>60</g_refresh_rate>
    </global>
    <resolutions>
        <resolution>
            <width>1920</width>
            <height>1080</height>
            <refresh_rate>60</refresh_rate>
        </resolution>
    </resolutions>
    <options>
        <CustomEdid>false</CustomEdid>
        <PreventSpoof>false</PreventSpoof>
        <EdidCeaOverride>false</EdidCeaOverride>
        <HardwareCursor>true</HardwareCursor>
        <SDR10bit>false</SDR10bit>
        <HDRPlus>false</HDRPlus>
        <logging>true</logging>
        <debuglogging>false</debuglogging>
    </options>
</vdd_settings>
'@
if ($DryRun) {
    Write-Output ("result      : dry-run, would write {0}" -f $settingsPath)
} else {
    $dir = Split-Path -Parent $settingsPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($settingsPath, $settings, [Text.UTF8Encoding]::new($false))
    Write-Output ("written     : {0}" -f $settingsPath)
    Write-Output "  count=1, modes=1920x1080@60, logging=on (so failures land in a file)"
}

if ($DryRun) {
    Step 'result'
    Write-Output "result      : dry-run complete, nothing changed"
    Finish 0
}

# --------------------------------------------------------------------------- 4 install
Step 'install'
# Remove a previous copy first. pnputil will otherwise leave the OLD binary in
# C:\Windows\System32\drivers\UMDF\ and report success -- see tools/idd/SOURCE.md.
$all = & pnputil.exe /enum-drivers 2>&1 | Out-String
foreach ($b in ($all -split "(?=$LOCAL_PUBLISHED\s*:)|(?=Published Name\s*:)")) {
    if ($b -match 'mttvdd\.inf' -and $b -match "(?:$LOCAL_PUBLISHED|Published Name)\s*:\s*(\S+\.inf)") {
        Write-Output ("removing    : previous package {0}" -f $Matches[1])
        & pnputil.exe /delete-driver $Matches[1] /uninstall 2>&1 | Out-Null
    }
}

$inf = Join-Path $stage 'MttVDD.inf'
Write-Output ("installing  : {0}" -f $inf)
& pnputil.exe /add-driver $inf 2>&1 | ForEach-Object { "              $_" }
if ($LASTEXITCODE -ne 0) {
    Write-Output ("ERROR pnputil /add-driver failed rc={0}" -f $LASTEXITCODE)
    Finish 3
}

# The package alone does not create the device node; root-enumerated devices have to be
# asked for. devcon ships with the WDK.
$devcon = $null
foreach ($sub in @('x64', 'arm64')) {
    $p2 = Join-Path $kits "Tools\$binV\$sub\devcon.exe"
    if (Test-Path $p2) { $devcon = $p2; break }
}
if (-not $devcon) {
    Write-Output "WARNING     : devcon.exe not found; the package is staged but no device exists."
    Finish 4
}
Write-Output "creating device node: Root\MttVDD"
& $devcon install $inf 'Root\MttVDD' 2>&1 | ForEach-Object { "              $_" }
Write-Output ("devcon rc   : {0} (informational)" -f $LASTEXITCODE)

# --------------------------------------------------------------------------- 5 verify
Step 'verify'
Start-Sleep -Seconds 3

$dev = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match 'MttVDD' }
if ($dev) {
    $dev | ForEach-Object {
        Write-Output ("device      : {0} [{1}] {2}" -f $_.FriendlyName, $_.Status, $_.InstanceId)
    }
} else {
    Write-Output "device      : (no MttVDD device yet)"
}

# Prove the binary we just installed is the one on disk.
$deployed = 'C:\Windows\System32\drivers\UMDF\MttVDD.dll'
if (Test-Path $deployed) {
    $hNew = (Get-FileHash -LiteralPath $dllSrc -Algorithm SHA256).Hash
    $hOld = (Get-FileHash -LiteralPath $deployed -Algorithm SHA256).Hash
    Write-Output ("deployed    : {0}" -f $deployed)
    Write-Output ("  package   : {0}" -f $hNew)
    Write-Output ("  deployed  : {0}" -f $hOld)
    if ($hNew -ne $hOld) {
        Write-Output "ERROR the deployed DLL is NOT the packaged one."
        Finish 3
    }
    Write-Output "  match     : yes"
} else {
    Write-Output ("WARNING     : {0} not found" -f $deployed)
}

# The only proof that matters: does a display enumerate 1920x1080@60 and is it attached?
$probe = Join-Path $repo 'tools\probe_activate_display.py'
if (Test-Path $probe) {
    Write-Output ""
    Write-Output "=== display adapters (tools\probe_activate_display.py --list) ==="
    & py -3 $probe --list 2>&1 | ForEach-Object { "  $_" }
}
Write-Output ""
Write-Output "Next: tools\probe_activate_display.py   (attaches the new display to the desktop)"
Finish 0
