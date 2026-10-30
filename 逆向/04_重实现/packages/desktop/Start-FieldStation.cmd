@echo off
rem ===========================================================================
rem  Field Station - double-click launcher (pure batch, no install, no npm)
rem
rem  Finds node, runs packages/desktop/src/cli.ts, which starts
rem  packages/app/src/server.ts, waits for HTTP 200 and opens the browser.
rem  The console window is this process: closing it or Ctrl+C stops the server.
rem
rem  Optional arguments (forwarded verbatim to the launcher):
rem    -NoBrowser     do not open a browser
rem    -NoMinimize    keep the console visible
rem    -Port 7790     preferred port (default 7788, then 7789.. up to 5 tries)
rem  Environment:
rem    FIELD_STATION_PORT, FIELD_STATION_NO_BROWSER, FIELD_STATION_LOG,
rem    FIELD_STATION_NODE (full path to node.exe)
rem ===========================================================================
setlocal EnableExtensions
title Field Station
chcp 65001 >nul 2>nul

set "HERE=%~dp0"
set "ENTRY=%HERE%src\cli.ts"
set "PF86=%ProgramFiles(x86)%"
set "NODE_EXE="

if not exist "%ENTRY%" (
  echo.
  echo [FieldStation] launcher entry not found:
  echo   %ENTRY%
  echo   Keep this .cmd inside packages\desktop\ next to src\.
  echo.
  pause
  exit /b 1
)

rem --- 1. an explicit override always wins -----------------------------------
if defined FIELD_STATION_NODE if exist "%FIELD_STATION_NODE%" set "NODE_EXE=%FIELD_STATION_NODE%"

rem --- 2. whatever PATH says -------------------------------------------------
if not defined NODE_EXE for /f "usebackq delims=" %%I in (`where node 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%I"

rem --- 3. the usual install locations, so a broken PATH still works ----------
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%PF86%\nodejs\node.exe" set "NODE_EXE=%PF86%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\hermes\node\node.exe" set "NODE_EXE=%LOCALAPPDATA%\hermes\node\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\current\node.exe" set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\shims\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\fnm_multishells\node.exe" set "NODE_EXE=%LOCALAPPDATA%\fnm_multishells\node.exe"

if not defined NODE_EXE (
  echo.
  echo [FieldStation] Node.js not found.
  echo   Install Node.js 22.6 or newer ^(https://nodejs.org^), or set
  echo   FIELD_STATION_NODE to the full path of node.exe.
  echo.
  pause
  exit /b 1
)

rem --- 4. hand over to the launcher; -Minimize is the double-click default ---
echo [FieldStation] node: %NODE_EXE%
"%NODE_EXE%" "%ENTRY%" -Minimize %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [FieldStation] launcher exited with code %RC%.
  echo   If a "Terminate batch job" prompt appears, answer N to read this.
  echo.
  pause
)

endlocal & exit /b %RC%
