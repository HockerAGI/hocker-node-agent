#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# service.env is parsed as data only (never evaluated as shell code).
. "$SCRIPT_DIR/load-env.sh"

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"

mkdir -p "$SERVICE_BASE"

if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ "${OLD_PID:-}" =~ ^[0-9]+$ ]] && (( OLD_PID > 1 )) && kill -0 "$OLD_PID" 2>/dev/null; then
    # The pidfile alone cannot prove that this PID is our supervised process.
    PROCESS_ARGS="$(ps -o args= -p "$OLD_PID" 2>/dev/null || true)"
    if [[ "$PROCESS_ARGS" == *"$SCRIPT_DIR/run.sh"* ]]; then
      echo "hocker-node-agent ya está corriendo. PID: $OLD_PID"
      exit 0
    fi
    echo "PIDFILE_PROCESS_MISMATCH: refusing duplicate startup" >&2
    exit 1
  fi
fi

nohup bash "$SCRIPT_DIR/run.sh" >/dev/null 2>&1 &
PID="$!"

echo "$PID" > "$PIDFILE"
echo "hocker-node-agent iniciado. PID: $PID"
