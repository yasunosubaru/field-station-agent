# build-release-v5.ps1 -- Build the AllPoweredFSA desktop package.
#
# Layout contract (from shell/electron/main.js):
#   REPO_ROOT = SHELL_DIR/..
#   SERVER_ENTRY = REPO_ROOT/<RE>/04_<RE>/packages/app/src/server.ts
#   python       = REPO_ROOT/dist/py-runtime/Scripts/python.exe, PYTHONPATH=REPO_ROOT/src
#
# electron-builder cannot consume the Chinese directory name reliably:
# measured, `extraFiles` pointing at the reverse tree exits 0 with NO error but copies
# nothing, so the built package cannot start. Therefore this script stages the
# whole tree into dist/_stage/app (pure ASCII paths) first, and the yml only
# copies that one directory.
#
# ASCII only on purpose: PS 5.1 reads a BOM-less .ps1 as ANSI and mangles
# non-ASCII literals (see AGENTS.md).
#
# Usage:
#   powershell.exe -NoLogo -NoProfile -NonInteractive -File tools\build-release-v5.ps1
#   ... -SkipDeps    # reuse dist/py-runtime as-is
#   ... -SkipBuild   # only re-stage + collect release.json (no electron-builder)

[CmdletBinding()]
param(
    [switch]$SkipDeps,
    [switch]$SkipBuild,
    [string]$PayloadDir = "",
    [string]$OutDir = "dist\AllPoweredFSA-v5"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ShellDir = Join-Path $Root 'shell\electron'
# Reverse-engineering tree name, built from code points to keep this file ASCII:
#   U+9006 U+5411 \ 04_ U+91CD U+5B9E U+73B0
$ReName = ([char]0x9006).ToString() + ([char]0x5411) + '\04_' +
          ([char]0x91CD) + ([char]0x5B9E) + ([char]0x73B0)
$ReRoot = Join-Path $Root $ReName
$AppSrc = Join-Path $ReRoot 'packages\app\src'
$PySrc = Join-Path $Root 'src'
$PyRuntime = Join-Path $Root 'dist\py-runtime'
$Stage = Join-Path $Root 'dist\_stage\app'
$Out = Join-Path $Root $OutDir

function Write-Step([string]$m) {
    Write-Host ""
    Write-Host ("=== " + $m) -ForegroundColor Cyan
}

function Fail([string]$m) {
    Write-Host ("[FAIL] " + $m) -ForegroundColor Red
    exit 1
}

function Need([string]$p, [string]$what) {
    if (-not (Test-Path -LiteralPath $p)) { Fail ($what + " missing: " + $p) }
}

function Robo([string]$src, [string]$dst, [string]$label, [string[]]$ExtraXD = @()) {
    Write-Host ("  copy " + $label)
    $xd = @('node_modules', '.git') + $ExtraXD
    $null = robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD @xd
    if ($LASTEXITCODE -ge 8) { Fail ("robocopy " + $label + " failed, code " + $LASTEXITCODE) }
}

# ---------------------------------------------------------------- sanity
Write-Step "1/7 sanity check"
Need $ShellDir "electron shell"
Need (Join-Path $ShellDir 'main.js') "main.js"
Need (Join-Path $ShellDir 'pyserver.js') "pyserver.js"
Need $AppSrc "app src (server.ts)"
Need $PySrc "python source"

$verRaw = [System.IO.File]::ReadAllText(
    (Join-Path $ShellDir 'package.json'), [System.Text.Encoding]::UTF8)
$Version = [string](($verRaw | ConvertFrom-Json).version)
Write-Host ("  version            : " + $Version)
Write-Host ("  reverse tree       : " + $ReRoot)

# ---------------------------------------------------------------- py runtime
Write-Step "2/7 python runtime (scheme A: bundled venv, NOT PyInstaller)"
if (-not (Test-Path -LiteralPath $PyRuntime)) {
    if ($SkipDeps) { Fail ("-SkipDeps given but " + $PyRuntime + " missing") }
    $venv = Join-Path $Root '.deps\venv'
    Need $venv ".deps venv"
    Robo $venv $PyRuntime "venv -> dist/py-runtime"
    Robo $PySrc (Join-Path $PyRuntime 'fieldstation') "src -> fieldstation"
}
Need (Join-Path $PyRuntime 'Scripts\python.exe') "runtime python.exe"
$smoke = & (Join-Path $PyRuntime 'Scripts\python.exe') -c "import fieldstation, sys; print('ok', sys.version.split()[0])" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ($smoke | Out-String)
    Fail "packaged python cannot import fieldstation"
}
Write-Host ("  import smoke       : " + $smoke)

# ---------------------------------------------------------------- stage
Write-Step "3/7 stage (final layout, pure ASCII paths)"
if (Test-Path -LiteralPath $Stage) {
    # Only remove our own staging dir. Recursive delete is deliberate and scoped.
    $resolved = (Resolve-Path -LiteralPath $Stage).Path
    if ($resolved -notlike ($Root + '\dist\_stage\app')) {
        Fail ("refusing to delete unexpected path: " + $resolved)
    }
    Write-Host ("  clean stage        : " + $resolved)
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

# 3.1 shell entry files -> app/shell/electron/ (layout main.js expects)
$stageShell = Join-Path $Stage 'shell\electron'
New-Item -ItemType Directory -Force -Path $stageShell | Out-Null
foreach ($f in @('main.js','preload.js','pyserver.js','payload.js','deeplink.js',
                 'embed.js','package.json')) {
    Copy-Item -LiteralPath (Join-Path $ShellDir $f) -Destination $stageShell -Force
}
Write-Host "  copy shell entry files"

# 3.1b app root: electron-builder treats the app dir root as the package root,
# so it needs main.js + package.json at the top. They forward to shell/electron/
# so that REPO_ROOT = <app>/shell/electron/.. = <app>, matching the repo layout.
$rootPkg = [ordered]@{
    name    = 'allpoweredfsa'
    version = $Version
    main    = 'shell/electron/main.js'
    # Keep CommonJS at the root: main.js/pyserver.js use require().
    type    = 'commonjs'
}
[System.IO.File]::WriteAllText(
    (Join-Path $Stage 'package.json'),
    ($rootPkg | ConvertTo-Json -Depth 3),
    [System.Text.UTF8Encoding]::new($false))
Write-Host "  write app root package.json (main -> shell/electron/main.js)"

# 3.2 web server + assets -> app/<RE>/04_<RE>/packages/**
#     Copy the WHOLE packages tree, not just app/: server.ts imports sibling
#     packages (packages/protocol/src/convert-pipeline.ts). Measured with only
#     app/: ERR_MODULE_NOT_FOUND at startup.
$stageApp = Join-Path $Stage $ReName
Robo (Join-Path $ReRoot 'packages') (Join-Path $stageApp 'packages') "reverse packages"
# `server.ts` is ESM. Node decides the module type by the NEAREST package.json,
# so put one at packages/app/ with type=module. Measured without it:
#   SyntaxError: Cannot use import statement outside a module
$appPkg = [ordered]@{ name = 'app'; version = '0.1.0'; private = $true; type = 'module' }
[System.IO.File]::WriteAllText(
    (Join-Path $stageApp 'packages\app\package.json'),
    ($appPkg | ConvertTo-Json -Depth 3),
    [System.Text.UTF8Encoding]::new($false))
Write-Host "  write packages/app/package.json (type=module for server.ts)"
# drop the app's own node_modules if robocopy pulled it (server.ts may need serialport)
$appNm = Join-Path $Root (Join-Path $ReName 'packages\app\node_modules')
if (Test-Path -LiteralPath $appNm) {
    Robo $appNm (Join-Path $stageApp 'packages\app\node_modules') "app/node_modules"
}

# 3.3b config -> app/config (runtime reads <app>/config/providers.json)
$stageConfig = Join-Path $Stage 'config'
New-Item -ItemType Directory -Force -Path $stageConfig | Out-Null
Robo (Join-Path $Root 'config') $stageConfig "config"
Write-Host "  copy config (providers.json -> runtime backend)"

# 3.3c tools -> app/tools
#     ** chat DEPENDS on tools/agent_server.py. **
#     agent-bridge.ts lazily spawns <repo>/tools/agent_server.py for the MCP
# A bare double-click on the exe has none of these -- chat 404s. Use this.
#     Measured once: the whole tools/ dir was missing from the package.
#
#     Copy only what runtime needs: .py plus json/md data.
#     Skip DevChatApp/bin|obj (most of the 487 MB is that .NET build output),
#     plus __pycache__ and oversized test fixtures.
$stageTools = Join-Path $Stage 'tools'
New-Item -ItemType Directory -Force -Path $stageTools | Out-Null
Robo (Join-Path $Root 'tools') $stageTools "tools (agent_server + rpa)" `
     -ExtraXD 'DevChatApp', '__pycache__', '.pytest_cache'
Write-Host "  copy tools (agent_server.py is REQUIRED for chat)"

# 3.3d workflows -> app/workflows
#     fieldstation.workflows.spec.load_all() reads <app>/workflows/*.yaml (8 RPA flows).
#     Without it every workflow_* tool throws at runtime:
#       WorkflowSpecError: workflow dir not found
#     Measured: it surfaces as an error tool card inside the chat.
$stageWf = Join-Path $Stage 'workflows'
New-Item -ItemType Directory -Force -Path $stageWf | Out-Null
Robo (Join-Path $Root 'workflows') $stageWf "workflows (8 RPA yaml)"
Write-Host "  copy workflows (required by workflow_* tools)"

# 3.3e docs/operations -> app/docs/operations
#     `/api/suite/field-parity` reads <app>/docs/operations/suite-field-parity.md verbatim and
#     returns it as markdown (suite.js parses it client side). Without the file the route 404s
#     and the suite inspector is empty -- measured: /api/suite/field-parity -> 404.
#     Only the operations subdir is needed; the rest of docs/ (plans, spec) is not runtime data.
$stageDocs = Join-Path $Stage 'docs\operations'
New-Item -ItemType Directory -Force -Path $stageDocs | Out-Null
Robo (Join-Path $Root 'docs\operations') $stageDocs "docs/operations (parity table)"
Write-Host "  copy docs/operations (suite field-parity source)"

# 3.3 python package -> app/src/fieldstation
$stagePy = Join-Path $Stage 'src\fieldstation'
New-Item -ItemType Directory -Force -Path $stagePy | Out-Null
Robo (Join-Path $PySrc 'fieldstation') $stagePy "src/fieldstation"

# 3.4 bundled python runtime -> app/payload/runtime/python
#     `pyserver.js::resolvePython` looks for `<payloadDir>/runtime/python/python.exe`
#     first, so putting it there makes the packaged app find its own interpreter
#     without touching the resolver logic.
$stageRuntime = Join-Path $Stage 'payload\runtime\python'
New-Item -ItemType Directory -Force -Path $stageRuntime | Out-Null
Robo $PyRuntime $stageRuntime "py-runtime -> payload/runtime/python"

# 3.5 payload (optional)
if ($PayloadDir -eq "") {
    $cand = Join-Path $Root 'payload'
    if (Test-Path -LiteralPath $cand) { $PayloadDir = $cand }
}
if (($PayloadDir -ne "") -and (Test-Path -LiteralPath $PayloadDir)) {
    Robo $PayloadDir (Join-Path $Stage 'payload') "payload"
    $psz = (Get-ChildItem -LiteralPath $PayloadDir -Recurse -File |
            Measure-Object -Property Length -Sum).Sum
    Write-Host ("  payload            : " + [math]::Round($psz/1MB,1) + " MB")
} else {
    Write-Host "  payload            : NONE (slim build)"
}

$stageItems = Get-ChildItem -LiteralPath $Stage -Recurse -File
$stageCount = $stageItems.Count
$stageBytes = ($stageItems | Measure-Object -Property Length -Sum).Sum
if (-not $stageBytes) { $stageBytes = 0 }
Write-Host ("  stage size         : " + $stageCount + " files, " +
            [math]::Round($stageBytes/1MB,1) + " MB")

# ---------------------------------------------------------------- verify stage
Write-Step "4/7 verify stage layout"
$checks = @(
    @{p = (Join-Path $Stage 'shell\electron\main.js'); what = 'main.js'},
    @{p = (Join-Path $Stage ($ReName + '\packages\app\src\server.ts')); what = 'server.ts'},
    @{p = (Join-Path $Stage ($ReName + '\packages\app\src\web\index.html')); what = 'web/index.html'},
    @{p = (Join-Path $Stage 'src\fieldstation\runtimes\server.py'); what = 'python server'},
    @{p = (Join-Path $Stage 'payload\runtime\python\Scripts\python.exe'); what = 'runtime python'},
    # Missing this = chat is dead (front end calls /api/agent/*).
    @{p = (Join-Path $Stage 'tools\agent_server.py'); what = 'tools/agent_server.py (chat)'},
    @{p = (Join-Path $Stage 'workflows'); what = 'workflows/ (8 RPA yaml, workflow_* tools)'},
    @{p = (Join-Path $Stage 'config\providers.json'); what = 'config/providers.json'}
)
foreach ($c in $checks) {
    if (-not (Test-Path -LiteralPath $c.p)) {
        Fail ("stage missing " + $c.what + ": " + $c.p)
    }
    Write-Host ("  ok " + $c.what)
}

# ---------------------------------------------------------------- build
Write-Step "5/7 electron-builder"
if ($SkipBuild) {
    Write-Host "  -SkipBuild given, skipping"
} else {
    $eb = Join-Path $ShellDir 'node_modules\.bin\electron-builder.cmd'
    Need $eb "electron-builder (npm i -D electron-builder)"
    Push-Location $ShellDir
    try {
        & $eb --win --x64 --config electron-builder.yml
        if ($LASTEXITCODE -ne 0) { Fail ("electron-builder failed, code " + $LASTEXITCODE) }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------- launcher
# Contents of start.cmd. Must stay pure ASCII (cmd runs under GBK console).
# Three jobs:
#   1. read the API key from a private file into the env (no disk write, no echo)
#   2. point NAS_PYTHON / NAS_AGENT_SERVER at the bundled interpreter and entry
#   3. launch the exe
$LauncherScript = @'
@echo off
REM Start AllPoweredFSA with the commandcode backend wired in.
REM The API key is read from a private file at run time; never written here.

setlocal
set "SECRET_FILE=%USERPROFILE%\.config\openchamber\secrets\3af7a0500bf1ab33e11119384b8a6ca1"

if not exist "%SECRET_FILE%" (
  echo [start] missing API key file: %SECRET_FILE%
  exit /b 1
)
set /p FSA_OPENAI_API_KEY=<"%SECRET_FILE%"

if "%FSA_HTTP_PROXY%"=="" set "FSA_HTTP_PROXY=http://127.0.0.1:7900"
REM NOTE: no /v1 suffix -- provider appends /v1/chat/completions itself.
set "FSA_OPENAI_BASE_URL=https://api.commandcode.ai/provider"
set "FSA_OPENAI_MODEL=deepseek/deepseek-v4.1-flash"
set "FSA_AGENT_PROVIDER=openai_compatible"

set "APP_DIR=%~dp0"
if not exist "%APP_DIR%AllPoweredFSA.exe" (
  echo [start] AllPoweredFSA.exe not found next to this script.
  exit /b 1
)

REM agent-bridge resolves NAS_PYTHON -> <repo>/runtime/python/python.exe -> PATH.
REM The packaged runtime is a venv, so Scripts\ is part of the path.
set "NAS_PYTHON=%APP_DIR%resources\app\payload\runtime\python\Scripts\python.exe"
set "NAS_AGENT_SERVER=%APP_DIR%resources\app\tools\agent_server.py"

if not exist "%NAS_PYTHON%" (
  echo [start] bundled python missing: %NAS_PYTHON%
  exit /b 1
)
if not exist "%NAS_AGENT_SERVER%" (
  echo [start] agent_server.py missing: %NAS_AGENT_SERVER%
  echo [start] this package was built without tools\ - chat will not work.
  exit /b 1
)

echo [start] backend: %FSA_OPENAI_BASE_URL%
echo [start] model  : %FSA_OPENAI_MODEL%
echo [start] proxy  : %FSA_HTTP_PROXY%
echo [start] python : %NAS_PYTHON%
echo [start] agent  : %NAS_AGENT_SERVER%

start "" "%APP_DIR%AllPoweredFSA.exe"
endlocal
'@

# ---------------------------------------------------------------- collect
Write-Step "6/7 collect artifacts"
$distDir = Join-Path $ShellDir 'dist'
Need $distDir "electron-builder output"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Sha256([string]$p) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = [System.IO.File]::OpenRead($p)
    try { $bytes = $sha.ComputeHash($fs) } finally { $fs.Dispose(); $sha.Dispose() }
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

$artifacts = @()
foreach ($f in (Get-ChildItem -LiteralPath $distDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)) {
    $dest = Join-Path $Out $f.Name
    Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    $artifacts += [ordered]@{
        name = $f.Name; kind = 'portable'
        bytes = (Get-Item -LiteralPath $dest).Length
        sha256 = (Sha256 $dest)
    }
}

$unpacked = Join-Path $distDir 'win-unpacked'
if (Test-Path -LiteralPath $unpacked) {
    $slimDir = Join-Path $Out 'AllPoweredFSA-dir'
    if (-not (Test-Path -LiteralPath $slimDir)) {
        New-Item -ItemType Directory -Force -Path $slimDir | Out-Null
    }
    Robo $unpacked $slimDir "win-unpacked -> out"
    # Generate the launcher: injects API key, backend URL, interpreter path.
    # A bare double-click has none of these -- chat 404s. Use this launcher.
    $startCmd = Join-Path $slimDir 'start.cmd'
    [System.IO.File]::WriteAllText($startCmd, $LauncherScript,
        [System.Text.UTF8Encoding]::new($false))
    Write-Host "  write start.cmd (env + agent_bridge paths)"

    $exe = Join-Path $slimDir 'AllPoweredFSA.exe'
    if (Test-Path -LiteralPath $exe) {
        $artifacts += [ordered]@{
            name = 'AllPoweredFSA-dir\AllPoweredFSA.exe'; kind = 'dir'
            bytes = (Get-Item -LiteralPath $exe).Length
            sha256 = (Sha256 $exe)
        }
    }
}

# ---------------------------------------------------------------- release.json
Write-Step "7/7 release.json"
$gitCommit = (& git -C $Root rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -ne 0) { $gitCommit = 'unknown' }
$pyVer = (& (Join-Path $PyRuntime 'Scripts\python.exe') --version 2>&1 | Out-String).Trim()

$payloadInfo = $null
if (($PayloadDir -ne "") -and (Test-Path -LiteralPath $PayloadDir)) {
    $pf = Get-ChildItem -LiteralPath $PayloadDir -Recurse -File
    $payloadInfo = [ordered]@{
        files = $pf.Count
        bytes = ($pf | Measure-Object -Property Length -Sum).Sum
    }
}

$release = [ordered]@{
    product    = 'AllPoweredFSA'
    version    = $Version
    built_at   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    git_commit = [string]$gitCommit
    python     = 'scheme A (bundled venv, not PyInstaller)'
    toolchain  = [ordered]@{
        powershell = $PSVersionTable.PSVersion.ToString()
        node       = (& node --version 2>$null | Out-String).Trim()
        python     = $pyVer
    }
    stage      = [ordered]@{
        files = $stageFiles.Count
        bytes = $stageBytes
    }
    payload    = $payloadInfo
    artifacts  = $artifacts
}

$releasePath = Join-Path $Out 'release.json'
[System.IO.File]::WriteAllText(
    $releasePath,
    ($release | ConvertTo-Json -Depth 6),
    [System.Text.UTF8Encoding]::new($false))
Write-Host ("  release.json       : " + $releasePath)

Write-Step "DONE"
Write-Host ("  output             : " + $Out)
foreach ($a in $artifacts) {
    Write-Host ("  " + $a.name + "  " + [math]::Round($a.bytes/1MB,1) + " MB  " +
                $a.sha256.Substring(0,16) + "...")
}
exit 0
