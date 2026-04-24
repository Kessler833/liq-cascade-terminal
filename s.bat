@echo off
setlocal enabledelayedexpansion

:: ── liq-cascade-terminal launcher ──────────────────────────────────────────
:: Starts FastAPI backend (port 8000) + Vite frontend (port 5173)
:: both bound to your LAN IP so any device on the network can connect.
:: ────────────────────────────────────────────────────────────────────────────

set BACKEND_PORT=8000
set FRONTEND_PORT=5173

cd /d "%~dp0"

:: ── Resolve LAN IP ──────────────────────────────────────────────────────────
for /f "tokens=2 delims=:" %%a in (
    'ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."'
) do (
    for /f "tokens=1" %%b in ("%%a") do set LAN_IP=%%b
    goto :got_ip
)
:got_ip

if not defined LAN_IP (
    echo  [warn]  Could not detect LAN IP ^— falling back to 0.0.0.0
    set LAN_IP=0.0.0.0
)

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║         LIQ CASCADE TERMINAL  ^|  LAN launcher       ║
echo  ╠══════════════════════════════════════════════════════╣
echo  ║  Backend   http://%LAN_IP%:%BACKEND_PORT%
echo  ║  Frontend  http://%LAN_IP%:%FRONTEND_PORT%
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: ── Backend window ──────────────────────────────────────────────────────────
echo  [1/2]  Starting backend...
start "LiqTerm Backend" cmd /k "call ""%~dp0backend\start.bat"" %BACKEND_PORT%"

:: Give backend 3 seconds to boot before frontend starts
timeout /t 3 /nobreak >nul

:: ── Frontend window ─────────────────────────────────────────────────────────
echo  [2/2]  Starting frontend...
start "LiqTerm Frontend" cmd /k "call ""%~dp0frontend\start.bat"" %FRONTEND_PORT%"

:: ── Open browser ────────────────────────────────────────────────────────────
timeout /t 4 /nobreak >nul
start "" "http://%LAN_IP%:%FRONTEND_PORT%"

echo.
echo  Both services are running in separate windows.
echo  Close those windows (or Ctrl+C inside each) to stop.
echo.
pause
