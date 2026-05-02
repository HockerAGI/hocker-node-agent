#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$SERVICE_BASE"

if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "hocker-node-agent ya está corriendo. PID: $OLD_PID"
    exit 0
  fi
fi

nohup bash "$SCRIPT_DIR/run.sh" >/dev/null 2>&1 &
PID="$!"

echo "$PID" > "$PIDFILE"
echo "hocker-node-agent iniciado. PID: $PID"
