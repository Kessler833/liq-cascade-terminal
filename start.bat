@echo off
echo Starting Liq Cascade Terminal...
start cmd /k "cd backend && python main.py"
timeout /t 2 >nul
start cmd /k "cd frontend && npm run dev"
