# build_release.ps1 - build the All powered-FSA single-file desktop release.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page,
# so any non-ASCII literal here would turn into mojibake. Repository paths that contain CJK
# characters are resolved at run time by tools/build_payload.py (--print-default-out) instead
# of being spelled out in this file.
#
#   powershell -NoProfile -File tools\build_release.ps1
#   powershell -NoProfile -File tools\build_release.ps1 -Version 0.2.0 -WithOriginal
#   powershell -NoProfile -File tools\build_release.ps1 -SkipPayload
#
# Steps:
#   1. python tools/build_payload.py        -> <shell dir>\payload.zip   (unless -SkipPayload)
#   2. dotnet publish single-file win-x64   -> dist\AllPoweredFSA-<ver>-win-x64\
#   3. SHA256 of the exe + release.json     -> dist\AllPoweredFSA-<ver>-win-x64\release.json
#
# This script never touches git and never writes outside dist\ and the shell directory.

[CmdletBinding()]
param(
    [string]$Version = "0.2.0",
    [switch]$WithOriginal,
    [switch]$SkipPayload,
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# build_payload.py prints UTF-8 (paths contain CJK characters). Windows PowerShell 5.1 decodes
# native stdout with the OEM code page by default, which would garble the resolved path.
$env:PYTHONIOENCODING = "utf-8"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Get-Sha256([string]$Path) {
    # Get-FileHash lives in a module that has failed to auto-load under load; do it directly.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $bytes = $sha.ComputeHash($stream)
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha.Dispose()
    }
    return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
}

function Test-Python([string]$Exe) {
    if (-not $Exe) { return $false }
    if (-not (Test-Path -LiteralPath $Exe)) { return $false }
    # The Microsoft Store alias at ...\WindowsApps\python.exe exists but exits 9009 when Python
    # is not actually installed, so every candidate has to prove it runs.
    & $Exe -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Find-Python {
    if ($env:FSA_PYTHON) {
        if (Test-Python $env:FSA_PYTHON) { return $env:FSA_PYTHON }
        throw "FSA_PYTHON does not run Python 3.9+: $env:FSA_PYTHON"
    }
    $uv = Join-Path $env:APPDATA "uv\python\cpython-3.11-windows-x86_64-none\python.exe"
    if (Test-Python $uv) { return $uv }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Python $cmd.Source)) { return $cmd.Source }
    throw "python 3.9+ not found: install Python, or set FSA_PYTHON to a working python.exe"
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 0.2.0 (got '$Version')"
}

$Root = Split-Path -Parent $PSScriptRoot
$PayloadScript = Join-Path $PSScriptRoot "build_payload.py"
if (-not (Test-Path -LiteralPath $PayloadScript)) {
    throw "missing $PayloadScript"
}

$Python = Find-Python
Write-Step "build_release $Version ($Runtime, $Configuration)"
Write-Host "root      : $Root"
Write-Host "python    : $Python"

# ------------------------------------------------------------------ 1. payload
$PayloadZip = (& $Python $PayloadScript --root $Root --print-default-out | Select-Object -Last 1)
if ($PayloadZip) { $PayloadZip = $PayloadZip.Trim() }
if (-not $PayloadZip -or -not (Test-Path -LiteralPath (Split-Path -Parent $PayloadZip))) {
    throw "could not resolve the payload path from build_payload.py"
}
$ShellDir = Split-Path -Parent $PayloadZip
$Project = Join-Path $ShellDir "NasGui.csproj"
if (-not (Test-Path -LiteralPath $Project)) {
    throw "missing project file: $Project"
}
Write-Host "shell     : $ShellDir"

$declared = Select-String -LiteralPath $Project -Pattern '<Version>([^<]+)</Version>' |
    Select-Object -First 1
if ($declared -and $declared.Matches[0].Groups[1].Value -ne $Version) {
    Write-Warning ("NasGui.csproj says <Version>{0}</Version> but -Version is {1}; the exe will report the latter." -f `
            $declared.Matches[0].Groups[1].Value, $Version)
}

if ($SkipPayload) {
    if (-not (Test-Path -LiteralPath $PayloadZip)) {
        throw "-SkipPayload was given but $PayloadZip does not exist"
    }
    Write-Step "1/3 payload skipped (reusing $(Split-Path -Leaf $PayloadZip))"
}
else {
    Write-Step "1/3 building payload"
    $payloadArgs = @($PayloadScript, "--root", $Root, "--out", $PayloadZip)
    if ($WithOriginal) {
        $payloadArgs += "--with-original"
        Write-Warning "with-original: the payload will carry the installed NovAtel Application " +
            "Suite. That tree is proprietary - do not redistribute it without a licence from NovAtel."
    }
    & $Python @payloadArgs
    if ($LASTEXITCODE -ne 0) { throw "build_payload.py failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $PayloadZip)) {
    throw "payload.zip missing after the payload step: $PayloadZip"
}

# Sanity check the embedded archive before spending minutes on dotnet publish.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($PayloadZip)
try {
    $names = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($entry in $zip.Entries) { [void]$names.Add($entry.FullName) }
}
finally {
    $zip.Dispose()
}
$requiredMembers = @("manifest.json", "runtime/node.exe")
foreach ($member in $requiredMembers) {
    if (-not $names.Contains($member)) { throw "payload.zip is missing member: $member" }
}
# The Node entry point sits under a CJK directory name, which this ASCII-only script must not
# spell out; match it by suffix instead.
$hasServer = $false
foreach ($name in $names) {
    if ($name.EndsWith("packages/app/src/server.ts", [System.StringComparison]::Ordinal)) {
        $hasServer = $true
        break
    }
}
if (-not $hasServer) { throw "payload.zip has no packages/app/src/server.ts" }
$zipSize = (Get-Item -LiteralPath $PayloadZip).Length
$zipMb = $zipSize / 1MB
if ($zipMb -ge 1) {
    Write-Host ("payload   : {0:N0} B ({1:N1} MB), {2} members" -f $zipSize, $zipMb, $names.Count)
}
else {
    Write-Host ("payload   : {0:N0} B, {1} members" -f $zipSize, $names.Count)
}

# ------------------------------------------------------------------ 2. publish
$OutDir = Join-Path $Root ("dist\AllPoweredFSA-{0}-{1}" -f $Version, $Runtime)
Write-Step "2/3 dotnet publish -> $OutDir"
if (Test-Path -LiteralPath $OutDir) {
    Remove-Item -LiteralPath $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

Push-Location $ShellDir
try {
    & dotnet publish "NasGui.csproj" `
        -c $Configuration `
        -r $Runtime `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true `
        -p:DebugType=None `
        "-p:Version=$Version" `
        -o $OutDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$Exe = Join-Path $OutDir "AllPoweredFSA.exe"
if (-not (Test-Path -LiteralPath $Exe)) {
    throw "publish produced no AllPoweredFSA.exe in $OutDir"
}

# ------------------------------------------------------------------ 3. release.json
Write-Step "3/3 checksums"
$exeItem = Get-Item -LiteralPath $Exe
$exeSha = Get-Sha256 $Exe
$payloadSha = Get-Sha256 $PayloadZip
$dotnetVersion = (& dotnet --version | Select-Object -Last 1)
$nodeVersion = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVersion = (& node --version | Select-Object -Last 1)
}

$release = [ordered]@{
    product      = "All powered-FSA"
    version      = $Version
    runtime      = $Runtime
    configuration = $Configuration
    built_at     = (Get-Date).ToUniversalTime().ToString("o")
    exe          = [ordered]@{
        name   = $exeItem.Name
        bytes  = $exeItem.Length
        sha256 = $exeSha
    }
    payload      = [ordered]@{
        name       = (Split-Path -Leaf $PayloadZip)
        bytes      = $zipSize
        members    = $names.Count
        sha256     = $payloadSha
        with_original = [bool]$WithOriginal
    }
    toolchain    = [ordered]@{
        dotnet = "$dotnetVersion"
        node   = "$nodeVersion"
        python = "$Python"
    }
    notes = @(
        "Single-file exe; the payload is embedded and extracted on first run.",
        "Requires Windows 10/11 x64 and the WebView2 runtime."
    )
}

$releaseJson = Join-Path $OutDir "release.json"
$json = $release | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($releaseJson, $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host ("exe       : {0}" -f $Exe)
Write-Host ("exe bytes : {0:N0}" -f $exeItem.Length)
Write-Host ("exe sha256: {0}" -f $exeSha)
Write-Host ("payload   : {0}" -f $payloadSha)
Write-Host ("release   : {0}" -f $releaseJson)
Write-Host ""
Write-Host "done." -ForegroundColor Green
