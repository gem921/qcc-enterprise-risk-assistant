@echo off
setlocal
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install Node.js and try again.
  exit /b 1
)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo Unable to detect the Node.js version.
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22 or later is required. Current major version: %NODE_MAJOR%.
  exit /b 1
)

node "%SCRIPT_DIR%qcc-risk-rpa.mjs" %*
endlocal
