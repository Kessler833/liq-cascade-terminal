@echo off
cd /d "%~dp0"

npm install --silent

set PORT=%1
if "%PORT%"=="" set PORT=5173

echo [liqterm] Starting frontend on http://localhost:%PORT%
npx vite --host 0.0.0.0 --port %PORT%
