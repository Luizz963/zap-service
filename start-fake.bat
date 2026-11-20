@echo off
title Chat Zap - TEST MODE (fake WhatsApp)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul
if not errorlevel 1 (
  echo Chat Zap is already running in another window.
  echo Close that window first, then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First time: installing, this takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo Install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo.
echo  Chat Zap - TEST MODE: fake WhatsApp, nothing goes to your real account.
echo  The browser opens by itself in a few seconds: http://localhost:5173
echo  To stop: close this window, or press Ctrl+C.
echo.

start "" /b cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:5173"
call npm run dev:fake
pause
