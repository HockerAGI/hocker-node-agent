#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# service.env is parsed as data only (never evaluated as shell code).
. "$SCRIPT_DIR/load-env.sh"

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"

# Kill ONLY the process tree rooted in our verified run.sh supervisor.
# Never use a global pkill pattern; other services may also run node dist/index.js.
terminate_descendants() {
  local parent="$1" child
  while IFS= read -r child; do
    [[ "$child" =~ ^[0-9]+$ ]] || continue
    terminate_descendants "$child"
    kill "$child" 2>/dev/null || true
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ "${PID:-}" =~ ^[0-9]+$ ]] && (( PID > 1 )) && kill -0 "$PID" 2>/dev/null; then
    PROCESS_ARGS="$(ps -o args= -p "$PID" 2>/dev/null || true)"
    if [[ "$PROCESS_ARGS" != *"$SCRIPT_DIR/run.sh"* ]]; then
      echo "PIDFILE_PROCESS_MISMATCH: refusing to kill an unrelated process" >&2
      exit 1
    fi
    echo "Deteniendo supervisor local PID: $PID"
    terminate_descendants "$PID"
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

echo "hocker-node-agent detenido."
