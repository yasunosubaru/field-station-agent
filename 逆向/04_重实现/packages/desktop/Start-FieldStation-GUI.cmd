@echo off
rem ===========================================================================
rem  Field Station - GUI launcher (Electron window instead of a browser tab)
rem
rem  Runs packages\desktop\electron as an Electron app. The runtime is NOT
rem  hardcoded: FIELD_STATION_ELECTRON wins, otherwise this probes the local
rem  node_modules install, then known installs on this machine (DaVinci Resolve
rem  ships a full Electron 8 runtime), then PATH.
rem
rem  The server child needs a real node (Electron 8 bundles Node 12, which cannot
rem  run .ts), so this also locates node and exports FIELD_STATION_NODE.
rem ===========================================================================
setlocal EnableExtensions
title Field Station (Electron)
chcp 65001 >nul 2>nul

set "HERE=%~dp0"
set "APP_DIR=%HERE%electron"
set "PF86=%ProgramFiles(x86)%"
set "ELECTRON_EXE="
set "NODE_EXE="

if not exist "%APP_DIR%\main.cjs" (
  echo.
  echo [FieldStation] Electron app not found:
  echo   %APP_DIR%\main.cjs
  echo.
  pause
  exit /b 1
)

rem --- node (needed to run packages\app\src\server.ts) -----------------------
if defined FIELD_STATION_NODE if exist "%FIELD_STATION_NODE%" set "NODE_EXE=%FIELD_STATION_NODE%"
if not defined NODE_EXE for /f "usebackq delims=" %%I in (`where node 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%PF86%\nodejs\node.exe" set "NODE_EXE=%PF86%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\hermes\node\node.exe" set "NODE_EXE=%LOCALAPPDATA%\hermes\node\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\current\node.exe" set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\shims\node.exe"

rem --- Electron runtime: env override first ---------------------------------
if defined FIELD_STATION_ELECTRON if exist "%FIELD_STATION_ELECTRON%" set "ELECTRON_EXE=%FIELD_STATION_ELECTRON%"

rem --- project-local npm install (only exists after "npm i") -----------------
if not defined ELECTRON_EXE if exist "%HERE%node_modules\electron\dist\electron.exe" set "ELECTRON_EXE=%HERE%node_modules\electron\dist\electron.exe"

rem --- known runtimes on this machine (DaVinci Resolve ships Electron 8) -----
if not defined ELECTRON_EXE if exist "%ProgramFiles%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe" set "ELECTRON_EXE=%ProgramFiles%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe"
if not defined ELECTRON_EXE if exist "%PF86%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe" set "ELECTRON_EXE=%PF86%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe"
if not defined ELECTRON_EXE if exist "%ProgramFiles%\DaVinci Resolve\Electron\electron.exe" set "ELECTRON_EXE=%ProgramFiles%\DaVinci Resolve\Electron\electron.exe"

rem --- PATH, then the usual global npm / per-user locations ------------------
if not defined ELECTRON_EXE for /f "usebackq delims=" %%I in (`where electron 2^>nul`) do if not defined ELECTRON_EXE set "ELECTRON_EXE=%%I"
if not defined ELECTRON_EXE if exist "%APPDATA%\npm\node_modules\electron\dist\electron.exe" set "ELECTRON_EXE=%APPDATA%\npm\node_modules\electron\dist\electron.exe"
if not defined ELECTRON_EXE if exist "%LOCALAPPDATA%\Programs\electron\electron.exe" set "ELECTRON_EXE=%LOCALAPPDATA%\Programs\electron\electron.exe"
if not defined ELECTRON_EXE if exist "%LOCALAPPDATA%\electron\dist\electron.exe" set "ELECTRON_EXE=%LOCALAPPDATA%\electron\dist\electron.exe"

if not defined ELECTRON_EXE goto :no_electron
if not defined NODE_EXE goto :no_node

echo [FieldStation] node:     %NODE_EXE%
echo [FieldStation] electron: %ELECTRON_EXE%
echo [FieldStation]          %APP_DIR%

set "FIELD_STATION_NODE=%NODE_EXE%"
rem The app directory is a long non-ASCII path ("wen-jian-jia"), and passing such a path in argv
rem command line is exactly how it gets mangled (ANSI code pages, PowerShell 5.1, cmd /c chains).
rem Set it as the working directory and hand electron "." so argv stays pure ASCII.
pushd "%APP_DIR%" || goto :no_appdir
"%ELECTRON_EXE%" .
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
  echo.
  echo [FieldStation] Electron exited with code %RC%.
  echo   Log: %LOCALAPPDATA%\FieldStation\electron.log
  echo.
  pause
)

endlocal & exit /b %RC%

:no_appdir
echo.
echo [FieldStation] Cannot enter the app directory:
echo   %APP_DIR%
echo.
pause
exit /b 1

:no_electron
echo.
echo [FieldStation] No Electron runtime found. Looked at:
echo   FIELD_STATION_ELECTRON
echo   %HERE%node_modules\electron\dist\electron.exe
echo   %%ProgramFiles%%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe
echo   %%ProgramFiles%%\DaVinci Resolve\Electron\electron.exe
echo   electron.exe on PATH
echo   %%APPDATA%%\npm\node_modules\electron\dist\electron.exe
echo.
echo   Point FIELD_STATION_ELECTRON at an electron.exe, or use the browser
echo   launcher instead: Start-FieldStation.cmd
echo.
pause
exit /b 1

:no_node
echo.
echo [FieldStation] Node.js not found, and Electron cannot run the .ts server.
echo   Install Node.js 22.6+ ^(https://nodejs.org^) or set FIELD_STATION_NODE
echo   to the full path of node.exe.
echo.
pause
exit /b 1
