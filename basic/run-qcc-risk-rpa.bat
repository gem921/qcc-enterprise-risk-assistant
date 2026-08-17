@echo off
setlocal
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or later is required. Install Node.js and try again.
  exit /b 1
)

node "%SCRIPT_DIR%qcc-risk-rpa.mjs" %*
endlocal
