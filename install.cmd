@echo off
REM Double-click entry point for installing dsh-desktop-uia.
REM The window stays open so any error message can be read.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  ============================================
echo   dsh-desktop-uia  -  installer
echo  ============================================
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo  [X] PowerShell was not found on this system.
  echo      Install / repair PowerShell, then run this file again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "code=%ERRORLEVEL%"

echo.
if not "%code%"=="0" (
  echo  [X] Installation failed ^(exit code %code%^).
  echo      The messages above explain why.
) else (
  echo  [OK] Installed.
  echo       Restart DSH Desktop to load the plugin,
  echo       then open Settings - Desktop control.
)
echo.
pause
exit /b %code%
