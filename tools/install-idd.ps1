# install-idd.ps1 -- build, sign and install the bundled IDD instead of requiring
# a vendor client.
#
# WHY this exists: see docs/plans/2026-11-15-local-driver-plan.md section 3.3. The machine
# already has two virtual display drivers (Oray / GameViewer), but both only report a
# monitor when their client attaches it. We want a display that appears on every launch,
# with a mode we choose, no third-party process involved.
#
# WHAT it does, in order, and why each step is separate:
#   1. build      msbuild is NOT usable here (see SOURCE.md); build-cl.bat drives cl.
#   2. stage      copy the .dll next to the .inf with the exact name the INF expects.
#   3. stamp      stampinf fills DriverVer; the upstream INF has it blank, and a blank
#                 DriverVer makes the install fail with a misleading error.
#   4. catalog    inf2cat produces the .cat file that lists the file hashes.
#   5. sign       signtool signs the .cat. Secure Boot is off on this machine, but a
#                 signed catalog is still what makes an unattended install possible.
#   6. install    pnputil /add-driver /install.
#   7. verify     re-enumerate and assert the mode is visible. Never trust exit codes.
#
# EVERY step prints what it did. A failure exits non-zero with the reason, and does not
# continue with a half-installed driver.
#
# ASCII only: PS 5.1 reads a BOM-less .ps1 as ANSI and mangles non-ASCII literals.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-idd.ps1 -DryRun
#   ... -BuildOnly        # stop after building + staging
#   ... -SkipBuild        # use an existing tools\build\IddSampleDriver.dll
#   ... -Uninstall        # remove the driver again
#   ... -NoWait           # do not pause at the end (only matters when self-elevated)
#
# ## Elevation
#
# Signing with /sm and pnputil /add-driver both need an elevated token. Rather than tell
# the user "open an admin shell first" (which is exactly the step people get wrong), the
# script re-launches itself through UAC and then PAUSES at the end so the result can be
# read before the elevated window closes. -Elevated is internal: it marks the child
# process so the script does not elevate itself forever.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$BuildOnly,
    [switch]$SkipBuild,
    [switch]$Uninstall,
    [switch]$NoWait,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

$repo  = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$src   = Join-Path $repo 'tools\idd\IddSampleDriver'
$build = Join-Path $repo 'tools\build'
$stage = Join-Path $repo 'tools\idd\stage'
$kits  = 'C:\Program Files (x86)\Windows Kits\10'
$binV  = '10.0.26100.0'

$certSubject = 'CN=KernelLabTestCert'

# --------------------------------------------------------------------------- helpers
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# All exits go through here so that a self-elevated window stays open long enough to read
# the outcome. Without this, UAC closes the console the instant the script ends and the
# user sees nothing -- which is the same class of bug as reporting success without proof.
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

function Step {
    param([string]$Name)
    Write-Output ""
    Write-Output ("--- {0}" -f $Name)
}

# --------------------------------------------------------------------------- elevation
# Only the steps that touch the driver store / machine key need this, so -DryRun and
# -BuildOnly stay usable in a normal shell (build + stage + Inf2Cat need no rights).
$needsAdmin = -not $DryRun -and -not $BuildOnly
if ($needsAdmin -and -not (Test-Admin) -and -not $Elevated) {
    Write-Output "Requesting elevation (a UAC prompt should appear)..."
    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath
    )
    foreach ($sw in @('DryRun', 'BuildOnly', 'SkipBuild', 'Uninstall', 'NoWait')) {
        if ((Get-Variable -Name $sw -ValueOnly)) { $argList += "-$sw" }
    }
    $argList += '-Elevated'
    # Do NOT append '-NoWait:$false'. PowerShell's -File argument parsing treats
    # "-NoWait:$false" as a literal positional string, not as a switch with a value.
    # NoWait defaults to $false, which is exactly the "pause at the end" behaviour we
    # want in the elevated child, so simply omitting it is correct.
    try {
        # RunAs keeps the elevated child in its own console; we wait for it so the exit
        # code we return is the child's, not "we successfully launched something".
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList `
            -Verb RunAs -Wait -PassThru
        Write-Output ("elevated    : child exited with {0}" -f $proc.ExitCode)
        exit $proc.ExitCode
    } catch {
        Write-Output "ERROR elevation was declined or failed:"
        Write-Output ("      {0}" -f $_.Exception.Message)
        Write-Output "      Right-click PowerShell -> Run as administrator, then re-run."
        Finish 2
    }
}

# --------------------------------------------------------------------------- uninstall
if ($Uninstall) {
    if (-not (Test-Admin)) {
        Write-Output "ERROR -Uninstall needs an elevated shell."
        Finish 2
    }
    Write-Output "Looking for the driver package to remove..."
    $lines = & pnputil.exe /enum-drivers 2>&1 | Out-String
    # pnputil prints per-package blocks; the OEM id is on the "Published Name" line.
    $blocks = $lines -split '(?=Published Name\s*:)'
    $found = @()
    foreach ($b in $blocks) {
        if ($b -match 'IddSampleDriver') {
            if ($b -match 'Published Name\s*:\s*(\S+\.inf)') { $found += $Matches[1] }
        }
    }
    if ($found.Count -eq 0) {
        Write-Output "result      : no IddSampleDriver package installed, nothing to remove"
        Finish 0
    }
    foreach ($inf in $found) {
        Write-Output ("deleting    : {0}" -f $inf)
        if (-not $DryRun) {
            & pnputil.exe /delete-driver $inf /uninstall 2>&1 | ForEach-Object { "              $_" }
            if ($LASTEXITCODE -ne 0) {
                Write-Output ("ERROR pnputil /delete-driver failed rc={0}" -f $LASTEXITCODE)
                Finish 3
            }
        }
    }
    Write-Output "result      : removed"
    Finish 0
}

# --------------------------------------------------------------------------- preflight
Step 'preflight'
Write-Output ("admin       : {0}" -f (Test-Admin))
if ($needsAdmin -and -not (Test-Admin)) {
    # Reached only when elevation was skipped (-Elevated passed but token is not admin,
    # i.e. something went wrong) -- fail loudly instead of half-working.
    Write-Output "ERROR still not elevated. Run this script from an Administrator shell."
    Finish 2
}

$msbuildTool = Find-Tool 'msbuild.exe'
$stampTool   = Find-Tool 'stampinf.exe'
$catTool     = Find-Tool 'Inf2Cat.exe'
$signTool    = Find-Tool 'signtool.exe'
foreach ($pair in @(
    @('stampinf', $stampTool), @('Inf2Cat', $catTool), @('signtool', $signTool)
)) {
    Write-Output ("{0,-11} : {1}" -f $pair[0], $(if ($pair[1]) { $pair[1] } else { '(MISSING)' }))
}

# --------------------------------------------------------------------------- 1 build
if (-not $SkipBuild) {
    Step 'build'
    $bat = Join-Path $repo 'tools\idd\build-cl.bat'
    if (-not (Test-Path $bat)) {
        Write-Output ("ERROR missing {0}" -f $bat)
        Finish 2
    }
    if ($DryRun) {
        Write-Output ("result      : dry-run, would run {0}" -f $bat)
    } else {
        & cmd.exe /c $bat 2>&1 | ForEach-Object { "              $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Output ("ERROR build failed rc={0}" -f $LASTEXITCODE)
            Finish 3
        }
    }
}

$dll = Join-Path $build 'IddSampleDriver.dll'
if (-not $DryRun) {
    if (-not (Test-Path $dll)) {
        Write-Output ("ERROR build output missing: {0}" -f $dll)
        Finish 3
    }
    $size = (Get-Item $dll).Length
    Write-Output ("built dll   : {0} ({1} bytes)" -f $dll, $size)
    if ($size -lt 20000) {
        Write-Output "ERROR dll is suspiciously small -- the build probably did not link."
        Finish 3
    }
}

# --------------------------------------------------------------------------- 2 stage
Step 'stage'
if ($DryRun) {
    Write-Output ("result      : dry-run, would copy the dll into {0}" -f $stage)
} else {
    if (-not (Test-Path $stage)) { New-Item -ItemType Directory -Path $stage -Force | Out-Null }
    foreach ($f in @('IddSampleDriver.inf', 'IddSampleDriver.dll', 'Trace.h')) {
        $from = Join-Path $src $f
        if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination $stage -Force }
    }
    Copy-Item -LiteralPath $dll -Destination (Join-Path $stage 'IddSampleDriver.dll') -Force
    Get-ChildItem $stage -File | ForEach-Object {
        Write-Output ("              {0}  {1} bytes" -f $_.Name, $_.Length)
    }
}

# --------------------------------------------------------------------------- 3 stamp
Step 'stamp'
$inf = Join-Path $stage 'IddSampleDriver.inf'
if ($DryRun) {
    Write-Output "result      : dry-run, would run stampinf to fill DriverVer"
} elseif ($stampTool) {
    # The upstream INF has "DriverVer= ; TODO" -- a blank version. stampinf fills it.
    # THREE arguments matter and each was wrong at first:
    #   -a amd64   expands the $ARCH$ macro in [Manufacturer]. Without it, Inf2Cat fails
    #              with "does not have NTAMD64 decorated model sections".
    #   -d *       means "today". Passing '*.*' makes stampinf print
    #              "Error converting date: *.*" and leave DriverVer blank.
    #   -v         REQUIRED together with -d: "Both Version and Date must be specified to
    #              stamp DriverVer". Giving -d alone also leaves it blank.
    #   -u 2.15.0  expands $UMDFVERSION$. Without it the INF keeps the literal text
    #              "UmdfLibraryVersion=$UMDFVERSION$", the UMDF host cannot resolve which
    #              framework version to load, and the device node is created then silently
    #              removed. That failure leaves NO entry in any event log -- it looks
    #              exactly like "the driver does not work".
    #              The argument must be THREE components. '2.15' and '2.15.0.0' both make
    #              stampinf print "Error parsing UMDF version string" and expand nothing;
    #              only a full three-component value works. This matches the vendor drivers on this machine.
    Write-Output "stamping    : -a amd64 -v 1.0.0.1 -d * -u 2.23.0 (expands \$ARCH\$ and \$UMDFVERSION\$)"
    & $stampTool -f $inf -a amd64 -v '1.0.0.1' -d '*' -u '2.23.0' 2>&1 | ForEach-Object { "              $_" }
    # stampinf rewrites the file, so re-read the DriverVer we ended up with.
    $infText = [IO.File]::ReadAllText($inf)
    if ($infText -match 'DriverVer\s*=\s*([^;\r\n]+)') {
        $ver = $Matches[1].Trim()
        Write-Output ("DriverVer   : {0}" -f $ver)
        if (-not $ver) {
            Write-Output "ERROR DriverVer is still empty after stampinf"
            Finish 3
        }
    } else {
        Write-Output "ERROR could not find DriverVer after stampinf"
        Finish 3
    }
    if ($infText -match '\$ARCH\$') {
        Write-Output "ERROR \$ARCH\$ was not expanded -- Inf2Cat will reject the INF"
        Finish 3
    }
    if ($infText -match '\$UMDFVERSION\$') {
        # This one does NOT fail Inf2Cat: the string is perfectly valid INF syntax. It only
        # fails later, at load time, with no log entry at all. Check it explicitly.
        Write-Output "ERROR \$UMDFVERSION\$ was not expanded (pass -u <version>)"
        Finish 3
    }
    if ($infText -match 'UmdfLibraryVersion\s*=\s*([^\r\n]+)') {
        Write-Output ("UmdfLibraryVersion : {0}" -f $Matches[1].Trim())
    }
} else {
    Write-Output "ERROR stampinf.exe not found"
    Finish 2
}

# --------------------------------------------------------------------------- 4 sign the DLL
# ORDER MATTERS. The catalog stores a hash of every file in the package, so the DLL must
# be signed BEFORE Inf2Cat runs -- otherwise the catalog hashes the unsigned bytes and the
# installed file fails verification at load time.
#
# And the DLL must be signed at all: it is a UMDF user-mode driver, and Windows checks its
# own Authenticode signature when the host process loads it. Signing only the catalog
# produced this exact sequence: catalog verified, pnputil "added successfully", devcon
# "Device node created", device node then vanished, Get-AuthenticodeSignature NotSigned.
Step 'sign dll'
$certThumb = $null
if (-not $DryRun) {
    $cert = Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $certSubject } | Select-Object -First 1
    if (-not $cert) {
        Write-Output ("ERROR certificate {0} not found in LocalMachine\My" -f $certSubject)
        Write-Output "      create it first (see SOURCE.md), or import an existing one."
        Finish 2
    }
    $certThumb = $cert.Thumbprint
    Write-Output ("certificate : {0} ({1})" -f $cert.Subject, $certThumb)

    $dllToSign = Join-Path $stage 'IddSampleDriver.dll'
    if (-not (Test-Path $dllToSign)) {
        Write-Output ("ERROR missing {0}" -f $dllToSign)
        Finish 3
    }
    # /a (auto-select) picks by "best EKU" and fails with "No certificates were found"
    # even when ours is present. /sha1 pins it unambiguously.
    & $signTool sign /v /fd SHA256 /sm /sha1 $certThumb $dllToSign 2>&1 |
        ForEach-Object { "              $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Output ("ERROR signtool sign (dll) failed rc={0}" -f $LASTEXITCODE)
        Finish 3
    }
    $sig = Get-AuthenticodeSignature $dllToSign
    Write-Output ("verified    : IddSampleDriver.dll -> {0}" -f $sig.Status)
    if ($sig.Status -ne 'Valid') {
        Write-Output ("ERROR dll signature is {0}, expected Valid" -f $sig.Status)
        Finish 3
    }
} else {
    Write-Output "result      : dry-run, would sign IddSampleDriver.dll"
}

# --------------------------------------------------------------------------- 5 catalog
# After the DLL is signed, so the hash in the catalog matches the bytes we ship.
Step 'catalog'
$cat = Join-Path $stage 'IddSampleDriver.cat'
if ($DryRun) {
    Write-Output "result      : dry-run, would run Inf2Cat"
} elseif ($catTool) {
    & $catTool /driver:$stage /os:10_X64,10_NI_X64 /verbose 2>&1 | ForEach-Object { "              $_" }
    if (-not (Test-Path $cat)) {
        Write-Output ("ERROR catalog was not produced at {0}" -f $cat)
        Finish 3
    }
    Write-Output ("catalog     : {0} ({1} bytes)" -f $cat, (Get-Item $cat).Length)
} else {
    Write-Output "ERROR Inf2Cat.exe not found"
    Finish 2
}

# --------------------------------------------------------------------------- 6 sign catalog
Step 'sign catalog'
if ($DryRun) {
    Write-Output "result      : dry-run, would sign the catalog"
} elseif ($certThumb) {
    & $signTool sign /v /fd SHA256 /sm /sha1 $certThumb $cat 2>&1 |
        ForEach-Object { "              $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Output ("ERROR signtool sign (cat) failed rc={0}" -f $LASTEXITCODE)
        Finish 3
    }
    $sig = Get-AuthenticodeSignature $cat
    Write-Output ("verified    : IddSampleDriver.cat -> {0}" -f $sig.Status)
    if ($sig.Status -ne 'Valid') {
        Write-Output ("ERROR cat signature is {0}, expected Valid" -f $sig.Status)
        Finish 3
    }
} else {
    Write-Output "ERROR no certificate thumbprint, cannot sign the catalog"
    Finish 3
}

if ($BuildOnly -or $DryRun) {
    Write-Output ""
    Write-Output ("result      : stopped after build/sign (BuildOnly={0}, DryRun={1})" -f $BuildOnly, $DryRun)
    Finish 0
}

# --------------------------------------------------------------------------- 6 install
Step 'install'
# Snapshot the adapter list BEFORE installing. Without it, "verify" can only search for a
# mode string, and this machine's own screen already matches that string.
$BeforeDevices = @()
$probe = Join-Path $repo 'tools\setup_display.ps1'
if (Test-Path $probe) {
    $beforeList = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $probe -List 2>&1
    $BeforeDevices = @($beforeList | ForEach-Object {
        if ($_ -match '^\s+(\\\\.\\DISPLAY\d+)\s+\S') { $Matches[1].Trim() }
    } | Select-Object -Unique)
    Write-Output ("before      : {0} display adapter(s)" -f $BeforeDevices.Count)
}
$installInf = Join-Path $stage 'IddSampleDriver.inf'

# A driver package alone does not make a device appear. `pnputil /add-driver` only copies
# the package into the store; for a ROOT-enumerated device someone has to create the device
# node. That is what devcon does, and it needs the INF + the hardware id together.
#
# Also: re-running must not pile up oemNNN.inf copies, so remove any previous package first.
$devcon = $null
foreach ($sub in @('x64', 'arm64')) {
    $p2 = Join-Path $kits "Tools\$binV\$sub\devcon.exe"
    if (Test-Path $p2) { $devcon = $p2; break }
}

Write-Output ("devcon      : {0}" -f $(if ($devcon) { $devcon } else { '(MISSING)' }))

# Drop a previous copy of this package so the install below is not a silent no-op.
#
# THIS IS NOT OPTIONAL, and getting it wrong cost several hours: `pnputil /add-driver`
# will happily "add" a package whose file names already exist, but the FILE_QUEUE_COMMIT
# step reports "Existing file ... remains unchanged" and the old binary stays in
# C:\Windows\System32\drivers\UMDF\. The consequence is that you rebuild, reinstall,
# retest, and are still running the FIRST binary you ever installed -- every code fix
# appears to have no effect. Verify by comparing SHA256 of the build output against the
# deployed DLL (see the verify step below).
#
# pnputil localises its output, so the OEM id line is either "Published Name:" or the
# Chinese equivalent. Both are matched. The CJK text is built from code points because
# this file must stay pure ASCII (PS 5.1 reads a BOM-less .ps1 as ANSI).
$LOCAL_PUBLISHED = [string][char]0x53D1 + [char]0x5E03 + [char]0x540D + [char]0x79F0
$existing = & pnputil.exe /enum-drivers 2>&1 | Out-String
$stalePackages = @()
foreach ($b in ($existing -split "(?=$LOCAL_PUBLISHED\s*:)|(?=Published Name\s*:)")) {
    if ($b -match 'iddsampledriver\.inf' -and $b -match "(?:$LOCAL_PUBLISHED|Published Name)\s*:\s*(\S+\.inf)") {
        $stalePackages += $Matches[1]
    }
}
foreach ($old in $stalePackages) {
    Write-Output ("removing    : previous package {0}" -f $old)
    & pnputil.exe /delete-driver $old /uninstall 2>&1 | Select-Object -Last 1 |
        ForEach-Object { "              $_" }
}
if ($stalePackages.Count -gt 0) {
    # Also remove any device nodes left behind, otherwise they re-bind to the old package.
    Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -match 'IddSample' } | ForEach-Object {
            Write-Output ("removing    : device {0}" -f $_.InstanceId)
            & pnputil.exe /remove-device $_.InstanceId 2>&1 | Out-Null
        }
}

Write-Output ("installing  : {0}" -f $installInf)
# Do NOT use `pnputil /add-driver <inf> /install` here.
#
# /install only works for a driver that can be matched to an EXISTING device. A root
# enumerated UMDF device has no hardware to be discovered, so there is nothing to match
# and pnputil returns:
#     0x00000103 (ERROR_NO_MORE_ITEMS) -- "there is nothing to install"
# or:
#     0x00000057 (ERROR_INVALID_PARAMETER) when the package is already present
# Neither means the package is bad. The package is added with plain /add-driver (that is
# the "copy into the store" step), and the DEVICE NODE is created by devcon below.
& pnputil.exe /add-driver $installInf 2>&1 | ForEach-Object { "              $_" }
$rc = $LASTEXITCODE
if ($rc -ne 0) {
    Write-Output ("ERROR pnputil /add-driver failed rc={0} (0x{1:X8})" -f $rc, $rc)
    Write-Output "      Common causes: catalog not trusted, DriverVer missing, DriverBlocklist."
    Finish 3
}

# Create the device node itself. Without this the package sits in the store and nothing
# ever enumerates it -- which looks identical to "the driver does not work".
if ($devcon) {
    Write-Output "creating device node: Root\IddSampleDriver"
    & $devcon install $installInf 'Root\IddSampleDriver' 2>&1 | ForEach-Object { "              $_" }
    # devcon returns 2 in several normal cases (e.g. the device installs but its start is
    # deferred); do not treat that as fatal, verify what actually exists instead.
    Write-Output ("devcon rc   : {0} (informational)" -f $LASTEXITCODE)
} else {
    Write-Output "WARNING     : devcon.exe not found, cannot create the device node."
    Write-Output "              Package is in the store but no device will start."
}

# --------------------------------------------------------------------------- 7 verify
Step 'verify'
# FIRST: prove the binary that is actually loaded is the one we just built.
# pnputil can report success while leaving the old DLL in place, which makes every code
# change silently ineffective. Comparing hashes is the only reliable check.
$deployed = 'C:\Windows\System32\drivers\UMDF\IddSampleDriver.dll'
if ((Test-Path $deployed) -and (Test-Path $dllToSign)) {
    $hNew = (Get-FileHash -LiteralPath $dllToSign -Algorithm SHA256).Hash
    $hOld = (Get-FileHash -LiteralPath $deployed -Algorithm SHA256).Hash
    Write-Output ("deployed    : {0}" -f $deployed)
    Write-Output ("  built     : {0}" -f $hNew)
    Write-Output ("  deployed  : {0}" -f $hOld)
    if ($hNew -ne $hOld) {
        Write-Output "ERROR the deployed DLL is NOT the one we just built."
        Write-Output "      pnputil left an old file behind (see the comment in the install step)."
        Finish 3
    }
    Write-Output "  match     : yes"
} else {
    Write-Output "WARNING     : could not compare builds (missing $deployed)"
}

Start-Sleep -Seconds 2
$dev = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match 'IddSample|Indirect' -or $_.InstanceId -match 'IddSample' }
if ($dev) {
    $dev | ForEach-Object { Write-Output ("device      : {0} [{1}] {2}" -f $_.FriendlyName, $_.Status, $_.InstanceId) }
} else {
    Write-Output "device      : (no matching PnP device yet)"
}

# The real proof: does a NEW display enumerate a mode? Two traps here:
#
#   1. Searching the whole `-List` output for "supports target 1920x1080@60: True" is
#      WRONG -- this machine's own Intel screen already supports that mode, so the check
#      passed with no driver present at all. That is exactly what happened once.
#   2. A newly added root-enumerated driver does not necessarily create its device node
#      right away; the first scan often happens at boot.
#
# So the only trustworthy evidence is: an adapter that was NOT in $BeforeDevices.
$script = Join-Path $repo 'tools\setup_display.ps1'
if (Test-Path $script) {
    $list = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -List 2>&1
    $nowDevices = @($list | ForEach-Object {
        if ($_ -match '^\s+(\\\\.\\DISPLAY\d+)\s+\S') { $Matches[1].Trim() }
    } | Select-Object -Unique)
    Write-Output ("displays    : {0} adapter(s) after install (before: {1})" -f `
        $nowDevices.Count, @($BeforeDevices).Count)

    $new = @($nowDevices | Where-Object { @($BeforeDevices) -notcontains $_ })
    if ($new.Count -gt 0 -and $BeforeDevices) {
        Write-Output ("new adapter : {0}" -f ($new -join ', '))
        Write-Output ""
        Write-Output "result      : a NEW display appeared -- the layer works."
        Finish 0
    }
    Write-Output ""
    Write-Output "WARNING     : driver package installed, but NO new display appeared."
    Write-Output "              A root-enumerated IDD usually creates its device node at boot."
    Write-Output "              Reboot, then run: tools\setup_display.ps1 -List"
    Finish 4
}
Write-Output "result      : installed (setup_display.ps1 not found, skipped the mode check)"
Finish 0
