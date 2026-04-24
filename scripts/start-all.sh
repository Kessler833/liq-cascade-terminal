#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[liqterm] Starting backend..."
bash "$ROOT/backend/start.sh" &
BACKEND_PID=$!

sleep 2

echo "[liqterm] Starting frontend..."
cd "$ROOT/frontend"
npm install --silent
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend  -> http://localhost:8000"
echo "  Frontend -> http://localhost:5173"
echo ""
echo "  Ctrl+C to stop both"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM
wait
