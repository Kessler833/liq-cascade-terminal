@echo off
REM Liq Cascade Terminal — legacy start script
echo Starting backend...
cd /d "%~dp0.."
start cmd /k "cd backend && pip install -r requirements.txt && python main.py"
timeout /t 3 >nul
echo Starting frontend...
start cmd /k "cd frontend && npm install && npm run dev"
