#!/usr/bin/env bash
# Keep the local API (indexer, alerts, sandbox defenders) running; restart it if it exits.
# Usage: nohup scripts/run-api.sh >/dev/null 2>&1 &   Logs: ~/.rescueroom/api.log (mode 600)
cd "$(dirname "$0")/.." || exit 1
LOG="${RR_API_LOG:-$HOME/.rescueroom/api.log}"
touch "$LOG" && chmod 600 "$LOG"
while true; do
  echo "[$(date '+%F %T')] starting api" >> "$LOG"
  node --env-file-if-exists=.env server/src/index.js >> "$LOG" 2>&1
  echo "[$(date '+%F %T')] api exited with $?; restarting in 3s" >> "$LOG"
  sleep 3
done
