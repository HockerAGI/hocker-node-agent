#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"

  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Deteniendo hocker-node-agent service PID: $PID"
    pkill -P "$PID" 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
    sleep 2
  fi

  rm -f "$PIDFILE"
fi

pkill -f "node dist/index.js" 2>/dev/null || true
pkill -f "hocker-node-agent.*run.sh" 2>/dev/null || true

echo "hocker-node-agent detenido."
