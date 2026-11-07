@echo off
rem Starts the Options Backtesting app at http://localhost:3000
rem   start.bat        - live mode (npm start)
rem   start.bat demo   - demo mode (npm run demo)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 22 or newer from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000

rem Open the browser a few seconds after the server starts
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"

if /i "%~1"=="demo" (
  echo Starting in DEMO mode on port %PORT%...
  call npm run demo
) else (
  echo Starting on port %PORT%...
  call npm start
)

echo.
echo Server stopped.
pause
