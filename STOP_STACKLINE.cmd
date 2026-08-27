@echo off
setlocal
echo Stopping Stackline processes on ports 3000, 3001, 3002, and 4300...

for %%P in (3000 3001 3002 4300) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    taskkill /PID %%A /T /F >nul 2>nul
  )
)

echo Stackline is stopped. Any separate ngrok window must be stopped with Ctrl+C.
timeout /t 3 >nul
