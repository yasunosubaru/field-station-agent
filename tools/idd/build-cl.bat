@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul 2>&1
if errorlevel 1 ( echo VCVARS_FAILED & exit /b 1 )

set WDK=C:\Program Files (x86)\Windows Kits\10
set V=10.0.26100.0
set UMDFV=2.23
set IDDCXV=1.2
set OUT=%~dp0..\build
if not exist "%OUT%" mkdir "%OUT%"

cl /nologo /LD /EHsc /std:c++17 /W3 /O2 /DNDEBUG ^
   /D_ATL_NO_WIN_SUPPORT /DUMDF_DRIVER /DIDDCX_VERSION_MAJOR=1 /DIDDCX_VERSION_MINOR=2 /DIDDCX_MINIMUM_VERSION_REQUIRED=2 ^
   /D_WIN64 /D_AMD64_ /DAMD64 ^
   /I"%WDK%\Include\wdf\umdf\%UMDFV%" ^
   /I"%WDK%\Include\%V%\um" /I"%WDK%\Include\%V%\um\iddcx\%IDDCXV%" /I"%WDK%\Include\%V%\um\iddcx\1.4" /I"%WDK%\Include\%V%\um\iddcx\1.2" ^
   /I"%WDK%\Include\%V%\shared" /I"%WDK%\Include\%V%\winrt" ^
   "%~dp0IddSampleDriver\Driver.cpp" ^
   /link /OUT:"%OUT%\IddSampleDriver.dll" ^
   "%WDK%\Lib\%V%\um\x64\iddcx\%IDDCXV%\iddcxstub.lib" ^
   "%WDK%\Lib\wdf\umdf\x64\%UMDFV%\WdfDriverStubUm.lib" ^
   OneCoreUAP.lib avrt.lib ntdll.lib ^
   /LIBPATH:"%WDK%\Lib\%V%\um\x64" /LIBPATH:"%WDK%\Lib\%V%\ucrt\x64"
if errorlevel 1 ( echo CL_FAILED & exit /b 1 )
echo BUILD_OK