@echo off
REM Enable RDP on this VM. Needs an elevated prompt.
REM fDenyTSConnections=1 currently blocks it entirely (measured 2026-11-18).
net session >nul 2>&1
if errorlevel 1 (
  echo [FAIL] run this as Administrator
  exit /b 1
)
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f
netsh advfirewall firewall add rule name="RDP-3389" dir=in action=allow protocol=TCP localport=3389
net start TermService >nul 2>&1
echo [ok] RDP enabled. Reboot the VM, then verify:
echo      netstat -an ^| findstr :3389
