@echo off
setlocal

:: ── liq-cascade-terminal launcher ──────────────────────────────────────────
:: Serves the static frontend on a local HTTP server and opens the browser.
:: Tries python first (http.server), falls back to Node (npx serve).
:: ────────────────────────────────────────────────────────────────────────────

set PORT=8420
set URL=http://localhost:%PORT%

cd /d "%~dp0"

echo.
echo  [liq-cascade-terminal]  Starting on %URL%
echo.

:: ── Check for Python ────────────────────────────────────────────────────────
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [server]  Using Python http.server on port %PORT%
    start "" "%URL%"
    python -m http.server %PORT% --bind 127.0.0.1
    goto :eof
)

:: ── Fallback: Node / npx serve ───────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% == 0 (
    echo  [server]  Python not found. Using npx serve on port %PORT%
    start "" "%URL%"
    npx serve -l %PORT% .
    goto :eof
)

:: ── Neither found ─────────────────────────────────────────────────────────
echo.
echo  [error]  Neither Python nor Node.js was found in PATH.
echo           Install either one and re-run s.bat.
echo.
pause
