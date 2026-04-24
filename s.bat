@echo off
setlocal

:: ── liq-cascade-terminal launcher ──────────────────────────────────────────
:: Serves the static frontend on your LAN IP so any device on the network
:: can open it.  Tries Python first, falls back to Node (npx serve).
:: ────────────────────────────────────────────────────────────────────────────

set PORT=8420

cd /d "%~dp0"

:: ── Resolve LAN IP (first non-loopback IPv4 on the active adapter) ─────────
for /f "tokens=2 delims=:" %%a in (
    'ipconfig ^| findstr /R /C:"IPv4.*192\." /C:"IPv4.*10\." /C:"IPv4.*172\."'
) do (
    for /f "tokens=1" %%b in ("%%a") do set LAN_IP=%%b
    goto :got_ip
)
:got_ip

if not defined LAN_IP (
    echo.
    echo  [warn]  Could not detect a LAN IP. Falling back to 0.0.0.0
    echo.
    set LAN_IP=0.0.0.0
)

set URL=http://%LAN_IP%:%PORT%

echo.
echo  [liq-cascade-terminal]  Binding to %URL%
echo  [liq-cascade-terminal]  Open this on any device on your network.
echo.

:: ── Check for Python ────────────────────────────────────────────────────────
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [server]  Using Python http.server
    start "" "%URL%"
    python -m http.server %PORT% --bind %LAN_IP%
    goto :eof
)

:: ── Fallback: Node / npx serve ───────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% == 0 (
    echo  [server]  Python not found – using npx serve
    start "" "%URL%"
    npx serve -l tcp://%LAN_IP%:%PORT% .
    goto :eof
)

:: ── Neither found ─────────────────────────────────────────────────────────
echo.
echo  [error]  Neither Python nor Node.js was found in PATH.
echo           Install either one and re-run s.bat.
echo.
pause
