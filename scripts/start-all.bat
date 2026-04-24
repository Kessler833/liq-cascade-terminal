@echo off
echo [liqterm] Starting backend...
start "LiqTerm Backend" cmd /k "cd /d "%~dp0..\backend" && call start.bat"

timeout /t 2 /nobreak >nul

echo [liqterm] Starting frontend...
start "LiqTerm Frontend" cmd /k "cd /d "%~dp0..\frontend" && npm install && npm run dev"

echo.
echo [liqterm] Backend  -> http://localhost:8000
echo [liqterm] Frontend -> http://localhost:5173
echo.
pause
