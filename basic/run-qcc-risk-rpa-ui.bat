@echo off
setlocal
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
title QCC Risk RPA UI
echo ================================================
echo  QCC Risk RPA UI
echo ================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-qcc-risk-rpa-ui.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start the UI service. Check the message above.
  pause
)
endlocal
