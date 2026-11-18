@echo off
REM Re-run gui.suite.autoupdate after the RDP session was dropped.
REM Baseline measured 2026-11-18 on the host:
REM   waiting_operator / dismiss_stale / idx=3  (3 runs identical)
set "OUT=C:\fsa_vm\rdp-collect.json"
echo [step] current sessions:
query session
echo [step] calling the workflow API ...
powershell -NoProfile -Command "try { $b = @{id='gui.suite.autoupdate';params=@{}} | ConvertTo-Json -Depth 4;$r = Invoke-WebRequest -Uri http://127.0.0.1:7799/api/workflows/run -Method POST -ContentType 'application/json' -Body $b -UseBasicParsing;Write-Output $r.Content } catch { Write-Output ('ERR: ' + $_.Exception.Message) }"
echo [step] waiting for the job to settle ...
timeout /t 20 /nobreak >nul
echo [step] collecting ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp04-collect.ps1"
