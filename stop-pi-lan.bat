@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
where powershell.exe >nul 2>nul
if errorlevel 1 (
	>&2 echo powershell.exe not found. Install Windows PowerShell or run stop-pi-lan.ps1 directly.
	exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%stop-pi-lan.ps1" %*
exit /b %ERRORLEVEL%
