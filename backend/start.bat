@echo off
cd /d "%~dp0"

if not exist ".venv" (
  echo [liqterm] Creating virtualenv...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
pip install -q -r requirements.txt

set PORT=%1
if "%PORT%"=="" set PORT=8000

echo [liqterm] Starting backend on http://localhost:%PORT%
uvicorn main:app --host 0.0.0.0 --port %PORT% --reload
