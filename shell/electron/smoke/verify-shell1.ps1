# Shell-1 acceptance: first start extracts payload.zip, second start skips.
#
# Usage (from repo root):
#   python shell/electron/smoke/make-payload.py
#   powershell -ExecutionPolicy Bypass -File shell/electron/smoke/verify-shell1.ps1
#
# Keep this file pure ASCII: PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# and CJK literals break quote pairing (TerminatorExpectedAtEndOfString).
#
# Step A: move %APPDATA%\nas-reimpl-shell\payload to recycle bin, start,
#         expect "extract" verdict + progress up to N/N.
# Step B: start again, expect "skip" verdict and no re-extract.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path -LiteralPath (Join-Path $here '..\..\..')).Path
$wd   = Join-Path $repo 'shell\electron'
$exe  = Join-Path $wd 'node_modules\electron\dist\electron.exe'
$zip  = Join-Path $here 'payload.zip'
$payloadDir = Join-Path $env:APPDATA 'nas-reimpl-shell\payload'

if (-not (Test-Path -LiteralPath $exe)) {
  throw "electron.exe not found: $exe  (run npm install in shell/electron first)"
}
if (-not (Test-Path -LiteralPath $zip)) {
  throw "payload.zip not found: $zip  (run: python shell/electron/smoke/make-payload.py)"
}

function Run-Once([string]$tag, [int]$port, [int]$pyPort) {
  $log = Join-Path $here ("s1_" + $tag + ".log")
  $err = $log + '.err'
  foreach ($f in @($log, $err)) {
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
  }
  # NOTE: Start-Process joins -ArgumentList with single spaces and does NOT
  # quote elements. Every value that may contain spaces must be pre-quoted
  # here, or the path is silently cut at the first space (this exact bug made
  # an earlier run report "no payload.zip" for a zip that was right there).
  $quotedZip = '"' + $zip + '"'
  $proc = Start-Process -FilePath $exe `
    -ArgumentList '.','--no-tray','--port',"$port",'--python-port',"$pyPort",'--payload-zip',$quotedZip `
    -WorkingDirectory $wd -RedirectStandardOutput $log -RedirectStandardError $err -PassThru

  $deadline = (Get-Date).AddSeconds(60)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $log) {
      $t = Get-Content -LiteralPath $log -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($t -and ($t -match ("http://127\.0\.0\.1:" + $port))) { $ok = $true; break }
    }
    Start-Sleep -Milliseconds 400
  }
  Start-Sleep -Seconds 2

  $win = Get-Process -Name electron -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($win) { [void]$win.CloseMainWindow() }
  [void]$proc.WaitForExit(40000)
  Start-Sleep -Seconds 2
  Write-Output ("===== " + $tag + " (node-ready=" + $ok + ") =====")
  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 }
  Write-Output ''
}

Write-Output ("payload dir = " + $payloadDir)
if (Test-Path -LiteralPath $payloadDir) {
  $abs = (Resolve-Path -LiteralPath $payloadDir).Path
  Write-Output ("moving to recycle bin: " + $abs)
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($abs, 'OnlyErrorDialogs', 'SendToRecycleBin')
  Write-Output ("still exists after delete = " + (Test-Path -LiteralPath $payloadDir))
} else {
  Write-Output 'payload dir does not exist (already clean)'
}
Write-Output ''

Run-Once 'first' 7817 8805
$stamp = Join-Path $payloadDir '.extracted'
if (Test-Path -LiteralPath $stamp) {
  Write-Output '--- .extracted ---'
  Get-Content -LiteralPath $stamp -Encoding UTF8
}
Write-Output ''

Run-Once 'second' 7818 8806

Write-Output '================ SUMMARY ================'
foreach ($tag in @('first', 'second')) {
  $log = Join-Path $here ("s1_" + $tag + ".log")
  if (-not (Test-Path -LiteralPath $log)) { Write-Output ($tag + ": NO LOG"); continue }
  $t = Get-Content -LiteralPath $log -Raw -Encoding UTF8
  # Match on ASCII markers only: the verdict words are CJK in the app log,
  # so key off the stable ASCII tokens "extract" / "skip" inside that line.
  $verdict = 'UNKNOWN'
  if ($t -match 'no-stamp') { $verdict = 'EXTRACT (first run)' }
  elseif ($t -match 'skip') { $verdict = 'SKIP (no re-extract)' }
  $prog = [regex]::Matches($t, '(\d+)/(\d+)')
  $lastProg = if ($prog.Count -gt 0) { $prog[$prog.Count - 1].Value } else { '(none)' }
  $ready = if ($t -match 'RUNTIME_GATEWAY_READY') { 'yes' } else { 'NO' }
  $killed = if ($t -match 'taskkill') { 'yes' } else { 'NO' }
  Write-Output ("{0,-7} verdict={1,-20} progress-events={2,-3} last={3,-8} gateway-ready={4} tree-killed={5}" -f `
    $tag, $verdict, $prog.Count, $lastProg, $ready, $killed)
}
