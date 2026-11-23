#!/usr/bin/env bash
# Container entrypoint: run both agents; if either exits, stop so the platform restarts us.
# Forwarding headers are trusted only from loopback (uvicorn's default), never from the
# Worker hop, so a caller cannot spoof its client address with X-Forwarded-For.
set -euo pipefail

UVICORN=(python -m uvicorn --host 0.0.0.0 --log-level warning)

"${UVICORN[@]}" champions.app:app --port 9100 &
"${UVICORN[@]}" personal.app:app --port 9200 &

wait -n
echo "an agent process exited; stopping the container" >&2
exit 1
