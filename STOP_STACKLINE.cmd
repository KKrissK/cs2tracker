@echo off
setlocal
echo Stopping Stackline processes on ports 3000, 3001, 3002, and 4300...

rem netstat text parsing missed IPv6 listeners such as [::1]:3000, which left a
rem dev server running and blocked the next start. Get-NetTCPConnection reports
rem both address families and gives the owning process directly.
powershell -NoProfile -NonInteractive -Command ^
  "$ports=3000,3001,3002,4300;" ^
  "$ids=foreach($p in $ports){(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).OwningProcess};" ^
  "$ids=$ids | Sort-Object -Unique | Where-Object {$_ -and $_ -ne 0};" ^
  "foreach($id in $ids){try{Stop-Process -Id $id -Force -ErrorAction Stop}catch{}};" ^
  "Start-Sleep -Seconds 2;" ^
  "$left=foreach($p in $ports){Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue};" ^
  "if($left){Write-Host ('Still listening on: ' + (($left.LocalPort | Sort-Object -Unique) -join ', '))}else{Write-Host 'All Stackline ports are free.'}"

echo Stackline is stopped. Any separate ngrok window must be stopped with Ctrl+C.
timeout /t 3 >nul
