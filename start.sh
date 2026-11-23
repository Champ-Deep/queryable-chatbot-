#!/usr/bin/env bash
# Starts both agents and opens the demo page (macOS / Linux).
#   ./start.sh
#
#   Champions Group Agent  http://127.0.0.1:9100  (A2A + MCP + OAuth, Agent Lab at /lab)
#   Personal Agent + demo  http://127.0.0.1:9200
# Press Ctrl+C to stop both agents.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON=.venv/bin/python
if [ ! -x "$PYTHON" ]; then
  echo "Creating virtual environment and installing requirements..."
  python3 -m venv .venv
  "$PYTHON" -m pip install -q -r requirements.txt
fi

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

mkdir -p logs
"$PYTHON" -m uvicorn champions.app:app --host 127.0.0.1 --port 9100 > logs/champions.log 2>&1 &
CHAMPIONS_PID=$!
"$PYTHON" -m uvicorn personal.app:app --host 127.0.0.1 --port 9200 > logs/personal.log 2>&1 &
PERSONAL_PID=$!
trap 'kill $CHAMPIONS_PID $PERSONAL_PID 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 30); do
  if curl -fs http://127.0.0.1:9200/api/health > /dev/null 2>&1; then break; fi
  sleep 1
done

echo "Demo:      http://127.0.0.1:9200"
echo "Agent Lab: http://127.0.0.1:9100/lab"
(command -v open > /dev/null && open http://127.0.0.1:9200) ||
  (command -v xdg-open > /dev/null && xdg-open http://127.0.0.1:9200) || true

wait
