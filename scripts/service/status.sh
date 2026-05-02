#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"
PORT="${PORT:-8081}"
LOG_FILE="${HOCKER_NODE_AGENT_LOG_FILE:-/tmp/hocker-node-agent-service.log}"

echo "=== PROCESO ==="

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "running: true"
    echo "pid: $PID"
  else
    echo "running: false"
  fi
else
  echo "running: false"
fi

echo
echo "=== HEALTH ==="
curl -sS "http://127.0.0.1:${PORT}/health" || true

echo
echo
echo "=== READY ==="
curl -sS "http://127.0.0.1:${PORT}/ready" || true

echo
echo
echo "=== LOG TAIL ==="
tail -40 "$LOG_FILE" 2>/dev/null || true
