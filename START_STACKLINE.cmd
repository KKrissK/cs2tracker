@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not available in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

echo Starting Stackline...
echo Private app:      http://localhost:3000/#played-with
echo Read-only viewer: http://localhost:3001/#played-with
echo.
echo Keep this window open while Stackline is running.
echo Press Ctrl+C here, or run STOP_STACKLINE.cmd, to stop it.
echo.

start "" "http://localhost:3000/#played-with"
npm run dev

if errorlevel 1 (
  echo.
  echo Stackline stopped with an error. If it was already running, use
  echo STOP_STACKLINE.cmd first and then try again.
  pause
)

