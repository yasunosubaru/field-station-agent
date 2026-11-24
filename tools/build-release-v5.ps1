# build-release-v5.ps1 -- Build the AllPoweredFSA desktop package.
#
# Layout contract (from shell/electron/main.js):
#   REPO_ROOT = SHELL_DIR/..
#   SERVER_ENTRY = REPO_ROOT/<RE>/04_<RE>/packages/app/src/server.ts
#   python       = REPO_ROOT/dist/py-runtime/python.exe (official embeddable),
#                  fieldstation on sys.path via the bundled python311._pth
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
    [string]$OutDir = "dist\AllPoweredFSA-v5",
    # Unpacked dir of python.org *-embed-amd64.zip. Empty = .deps\python-embed.
    # A venv is rejected: the script checks for pyvenv.cfg and fails.
    [string]$PythonDir = ""
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
    # Exclude __pycache__: otherwise every build ships .pyc files into the package
    # (measured 2026-11-18: 62 stray entries, incl. a whole site-packages __pycache__).
    # Robo is the single funnel for all copies, so filtering here covers every caller.
    $xd = @('node_modules', '.git', '__pycache__') + $ExtraXD
    # *.bak* is this repo's backup naming convention (AGENTS.md requires a backup
    # before overwrite). Those must never ship: measured a
    # runner.py.bak-20261118-075550 sitting in dist/py-runtime.
    $null = robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD @xd /XF '*.bak*' '*.pyc' '*.pyo'
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
Write-Step "2/7 python runtime (official embeddable, NOT venv, NOT PyInstaller)"
# Must be the official **embeddable** distribution (self-contained), not a **venv**
# (which leans on the base Python installed on this machine).
#
# Why venv was dropped (measured 2026-11-17): the package built from .deps/venv
# carried a pyvenv.cfg pointing at this box's uv install, and had no
# python311.dll and no stdlib zip -- interpreter and stdlib lived outside the
# package. On another machine that package dies with "No module named 'encodings'"
# while still weighing 1489 MB (all of it site-packages).
# The two copies (dist/py-runtime and payload/runtime/python) were byte-identical
# at 1489.1 MB each -- that is where the double runtime came from.
#
# Now only an unpacked python.org python-3.x.y-embed-amd64.zip is accepted:
#   python.exe + python311.dll + python311.zip (stdlib) + python311._pth
# ~11 MB, no dependency on any Python installed on the host.
$EmbedDefault = Join-Path $Root '.deps\python-embed'
if (-not $PythonDir) { $PythonDir = $EmbedDefault }
# Refuse a venv even if dist/py-runtime already exists -- a stale wrong runtime
# would otherwise be silently reused and shipped again.
if (Test-Path -LiteralPath (Join-Path $PyRuntime 'pyvenv.cfg')) {
    Fail ("dist/py-runtime is still a venv (pyvenv.cfg found). Move it to the " +
          "Recycle Bin first, then rebuild: " + $PyRuntime)
}
if (-not (Test-Path -LiteralPath $PyRuntime)) {
    if ($SkipDeps) { Fail ("-SkipDeps given but " + $PyRuntime + " missing") }
    Need $PythonDir "python embeddable dir (--PythonDir, or .deps\python-embed)"
    # gate: reject venv (pyvenv.cfg) and require interpreter dll + stdlib zip
    if (Test-Path -LiteralPath (Join-Path $PythonDir 'pyvenv.cfg')) {
        Fail ("--PythonDir points at a venv (pyvenv.cfg found): " + $PythonDir +
              ". Use the unpacked python.org *-embed-amd64.zip instead.")
    }
    $dll = Get-ChildItem -LiteralPath $PythonDir -Filter 'python3*.dll' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    $zip = Get-ChildItem -LiteralPath $PythonDir -Filter 'python3*.zip' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $dll) { Fail ("embeddable has no python3xx.dll: " + $PythonDir) }
    if (-not $zip) { Fail ("embeddable has no stdlib zip (python3xx.zip): " + $PythonDir) }
    Write-Host ("  source             : " + $PythonDir)
    Write-Host ("  " + $dll.Name.PadRight(18) + " : " + [math]::Round($dll.Length/1MB,2) + " MB")
    Write-Host ("  " + $zip.Name.PadRight(18) + " : " + [math]::Round($zip.Length/1MB,2) + " MB")
    Robo $PythonDir $PyRuntime "embeddable -> dist/py-runtime"
    # Business package goes to Lib\site-packages (embeddable has no Scripts\;
    # its bundled ._pth controls sys.path).
    $site = Join-Path $PyRuntime 'Lib\site-packages'
    if (-not (Test-Path -LiteralPath $site)) { $null = New-Item -ItemType Directory -Path $site -Force }
    Robo $PySrc (Join-Path $site 'fieldstation') "src -> fieldstation"
}
Need (Join-Path $PyRuntime 'python.exe') "runtime python.exe"
# An embeddable python ignores PYTHONPATH completely when a `python3xx._pth` file
# sits next to python.exe. shell/electron/pyserver.js sets PYTHONPATH=<repo>/src,
# which therefore has NO effect inside the packaged app -- the package only works
# if Lib\site-packages is listed in that ._pth. Rewrite it deterministically.
$pth = Get-ChildItem -LiteralPath $PyRuntime -Filter 'python3*._pth' -ErrorAction SilentlyContinue |
        Select-Object -First 1
if (-not $pth) {
    Fail ("embeddable has no python3xx._pth: " + $PyRuntime + " (cannot wire sys.path)")
}
$zipName = (Get-ChildItem -LiteralPath $PyRuntime -Filter 'python3*.zip' | Select-Object -First 1).Name
$pthBody = $zipName + "`r`n.`r`nLib\site-packages`r`n"
[IO.File]::WriteAllText($pth.FullName, $pthBody, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("  " + $pth.Name.PadRight(18) + " : " + ($pthBody -replace "`r`n", ' | ').Trim())
if (-not (Get-ChildItem -LiteralPath $PyRuntime -Filter 'python3*.dll' -ErrorAction SilentlyContinue)) {
    Fail ("dist/py-runtime has no python3xx.dll: not an embeddable runtime")
}
# Run with -I (isolated): ignores PYTHONPATH/PYTHONHOME, so passing proves the
# package really stands alone.
# Refresh the business package first: when dist/py-runtime is reused (second run),
# the branch above is skipped and fieldstation would otherwise stay stale.
$siteFinal = Join-Path $PyRuntime 'Lib\site-packages'
if (-not (Test-Path -LiteralPath $siteFinal)) { $null = New-Item -ItemType Directory -Path $siteFinal -Force }
Robo $PySrc (Join-Path $siteFinal 'fieldstation') "src -> runtime site-packages" @('__pycache__')
$smoke = & (Join-Path $PyRuntime 'python.exe') -I -c "import sys, fieldstation; print('ok', sys.version.split()[0]); print(sys.base_prefix)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ($smoke | Out-String)
    Fail "packaged python cannot import fieldstation in isolated mode"
}
$basePrefix = ($smoke | Select-Object -Last 1)
$resolvedPy = (Resolve-Path -LiteralPath $PyRuntime).Path
if ($basePrefix -notlike ($resolvedPy.TrimEnd('\') + '*')) {
    Fail ("python base_prefix is outside the package: " + $basePrefix + " (expected prefix " + $resolvedPy + ")")
}
Write-Host ("  import smoke       : " + ($smoke | Select-Object -First 1))
Write-Host ("  base_prefix        : " + $basePrefix + "  (inside package: OK)")

# ---------------------------------------------------------------- stage
Write-Step "3/7 stage (final layout, pure ASCII paths)"
if (Test-Path -LiteralPath $Stage) {
    # Clean staging: do NOT erase, only rename it out of the way.
    #
    # Why rename instead of erasing: repo rules say any deletion must land in the
    # Recycle Bin, and any erase-style API inside a build script is blocked by the
    # guard -- the guard refuses to run the whole script when it sees the keyword.
    # Renaming triggers nothing and keeps everything from the previous build
    # (logs, half-written artifacts) recoverable by renaming back.
    # Actual cleanup is the user's call: .retired-* dirs can go to the Recycle Bin.
    $resolved = (Resolve-Path -LiteralPath $Stage).Path
    if ($resolved -notlike ($Root + '\dist\_stage\app')) {
        Fail ("refusing to touch unexpected path: " + $resolved)
    }
    $retired = $resolved + '.retired-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Write-Host ("  retire stage       : " + $resolved)
    Write-Host ("                    -> " + $retired)
    Move-Item -LiteralPath $resolved -Destination $retired -Force
}
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

# 3.1 shell entry files -> app/shell/electron/ (layout main.js expects)
# ALL runtime modules main.js requires must be listed here. A missing one is a
# hard startup failure: main.js does `require('./environment.js')` at module
# scope, so the app dies before any window/log exists (measured 2026-11-17:
# environment.js forgotten -> "startup failed: prepareEnvironment is not defined" in
# the source tree, and a silent dead process in the packaged build).
$stageShell = Join-Path $Stage 'shell\electron'
New-Item -ItemType Directory -Force -Path $stageShell | Out-Null
foreach ($f in @('main.js','preload.js','pyserver.js','payload.js','deeplink.js',
                 'environment.js','embed.js','package.json')) {
    Need (Join-Path $ShellDir $f) "shell entry file"
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

# samples/ is data the Node engine serves (server.ts health + capture lookups).
# Robo above only copies packages/, so the samples data dir never makes it in.
# Without it the API works but every capture lookup is empty.
$srcName = '00_' + ([char]0x6765) + ([char]0x6E90)
$samplesSrc = Join-Path $ReRoot ($srcName + '\samples')
$samplesDst = Join-Path $stageApp ($ReName + '\' + $srcName + '\samples')
if (Test-Path -LiteralPath $samplesSrc) {
    $null = robocopy $samplesSrc $samplesDst /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { Fail ("robocopy samples failed: " + $LASTEXITCODE) }
    Write-Host "  copy samples (Node engine data)"
}

# Bundled Node runtime: main.js spawns `node` to run server.ts. A double-clicked
# single-file exe has no system Node on PATH, so ship node.exe in the package and
# main.js auto-detects <app>/runtime/node/node.exe (NAS_NODE still overrides).
# Node.js is MIT-licensed and freely redistributable.
$bundledNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$stageNodeDir = Join-Path $Stage 'runtime\node'
if (Test-Path -LiteralPath $bundledNode) {
    New-Item -ItemType Directory -Force -Path $stageNodeDir | Out-Null
    Copy-Item -LiteralPath $bundledNode -Destination (Join-Path $stageNodeDir 'node.exe') -Force
    Write-Host "  copy bundled node.exe (self-contained engine)"
} else {
    Write-Host "  WARN: system node.exe not found; package will rely on PATH"
}
# `server.ts` is ESM. Node decides the module type by the NEAREST package.json,
# so put one at packages/app/ with type=module. Measured without it:
#   SyntaxError: Cannot use import statement outside a module
$appPkg = [ordered]@{ name = 'app'; version = '0.1.0'; private = $true; type = 'module' }
[System.IO.File]::WriteAllText(
    (Join-Path $stageApp 'packages\app\package.json'),
    ($appPkg | ConvertTo-Json -Depth 3),
    [System.Text.UTF8Encoding]::new($false))
Write-Host "  write packages/app/package.json (type=module for server.ts)"
# Copy the app's own node_modules (serialport, node-gyp-build, @serialport...).
# server.ts imports them at runtime; without them Node dies with
# ERR_MODULE_NOT_FOUND and the window shows "Node service exited" instead of the UI.
# NOTE: Robo (above) always passes -XD node_modules, so the copy at 3.2 never
# brings it along and the old `Test-Path` on the STAGE path was always false.
# Read from the SOURCE tree and copy explicitly.
$appNmSrc = Join-Path $Root "$ReName\packages\app\node_modules"
if (Test-Path -LiteralPath $appNmSrc) {
    $appNmDst = Join-Path $stageApp 'packages\app\node_modules'
    $null = robocopy $appNmSrc $appNmDst /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { Fail ("robocopy app/node_modules failed: " + $LASTEXITCODE) }
    $nmCount = (Get-ChildItem -LiteralPath $appNmDst -ErrorAction SilentlyContinue).Count
    if ($nmCount -eq 0) { Fail ("app/node_modules staged empty: " + $appNmDst) }
    Write-Host ("  copy app/node_modules (" + $nmCount + " entries)")
} else {
    Fail ("missing app node_modules (server.ts needs serialport): " + $appNmSrc)
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
#     The whole embeddable tree (python.exe + python3xx.dll + python3xx.zip +
#     Lib\site-packages\fieldstation + python3xx._pth) travels along, so the
#     packaged app carries its own interpreter, stdlib and business package.
$stageRuntime = Join-Path $Stage 'payload\runtime\python'
New-Item -ItemType Directory -Force -Path $stageRuntime | Out-Null
Robo $PyRuntime $stageRuntime "py-runtime -> payload/runtime/python"
# Guard: the staged runtime must still be self-contained (a partial copy would
# only fail on the target machine, where nobody can debug it).
foreach ($req in @('python.exe', $zipName, $pth.Name, 'Lib\site-packages\fieldstation\__init__.py')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stageRuntime $req))) {
        Fail ("staged runtime missing " + $req + ": " + $stageRuntime)
    }
}
$stagedSmoke = & (Join-Path $stageRuntime 'python.exe') -I -c "import fieldstation; print('staged-ok')" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ($stagedSmoke | Out-String)
    Fail "staged runtime cannot import fieldstation in isolated mode"
}
Write-Host ("  staged import smoke: " + ($stagedSmoke | Select-Object -First 1))

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
    # main.js requires these at module scope -- missing any one = dead app, no log.
    @{p = (Join-Path $Stage 'shell\electron\environment.js'); what = 'shell/electron/environment.js'},
    @{p = (Join-Path $Stage 'shell\electron\payload.js'); what = 'shell/electron/payload.js'},
    @{p = (Join-Path $Stage 'shell\electron\pyserver.js'); what = 'shell/electron/pyserver.js'},
    @{p = (Join-Path $Stage 'shell\electron\deeplink.js'); what = 'shell/electron/deeplink.js'},
    @{p = (Join-Path $Stage 'shell\electron\preload.js'); what = 'shell/electron/preload.js'},
    @{p = (Join-Path $Stage ($ReName + '\packages\app\src\server.ts')); what = 'server.ts'},
    @{p = (Join-Path $Stage ($ReName + '\packages\app\node_modules')); what = 'app/node_modules (serialport)'},
    @{p = (Join-Path $Stage ($ReName + '\packages\app\src\web\index.html')); what = 'web/index.html'},
    @{p = (Join-Path $Stage 'src\fieldstation\runtimes\server.py'); what = 'python server'},
    @{p = (Join-Path $Stage 'payload\runtime\python\python.exe'); what = 'runtime python'},
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

REM Auto-detect the local proxy port.
REM Do NOT hardcode: Clash rotates its mixed port on restart (seen 7897 -> 7900 -> 7955).
REM A dead port gives WinError 10061 "target machine actively refused" and the chat
REM fails with a ProviderError, which looks like a code bug but is just a stale port.
if "%FSA_HTTP_PROXY%"=="" (
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$c=@(7897,7900,7955,7890,10809); foreach($p in $c){ if((Test-NetConnection 127.0.0.1 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue)){ Write-Output ('http://127.0.0.1:' + $p); break } }"`) do set "FSA_HTTP_PROXY=%%P"
)
if "%FSA_HTTP_PROXY%"=="" (
  echo [start] WARNING: no local proxy found; the gateway may refuse the direct connection.
) else (
  echo [start] proxy auto-detected: %FSA_HTTP_PROXY%
)
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
REM The packaged runtime is the official embeddable: python.exe sits at the root.
set "NAS_PYTHON=%APP_DIR%resources\app\payload\runtime\python\python.exe"
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
$pyVer = (& (Join-Path $PyRuntime 'python.exe') --version 2>&1 | Out-String).Trim()

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
    python     = 'scheme A (official embeddable, not PyInstaller)'
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
