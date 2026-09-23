@echo off
REM Double-click entry point for removing dsh-desktop-uia.
REM Pass --purge to also delete the plugin's stored settings and action log.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  ============================================
echo   dsh-desktop-uia  -  uninstaller
echo  ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "code=%ERRORLEVEL%"

echo.
if not "%code%"=="0" (
  echo  [X] Uninstall failed ^(exit code %code%^).
) else (
  echo  [OK] Removed. Restart DSH Desktop to finish unloading.
)
echo.
pause
exit /b %code%
