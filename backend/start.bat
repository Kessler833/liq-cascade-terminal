@echo off
cd /d "%~dp0"

if not exist ".venv" (
  echo [liqterm] Creating virtualenv...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
pip install -q -r requirements.txt

echo [liqterm] Starting backend on http://localhost:8000
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
