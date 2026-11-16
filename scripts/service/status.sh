#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# service.env is parsed as data only (never evaluated as shell code).
. "$SCRIPT_DIR/load-env.sh"

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"
PORT="${PORT:-8081}"
LOG_FILE="${HOCKER_NODE_AGENT_LOG_FILE:-/tmp/hocker-node-agent-service.log}"

echo "=== PROCESO ==="
GROUPFILE="$SERVICE_BASE/service.group"
. "$SCRIPT_DIR/service-group.sh"
if [[ -f "$GROUPFILE" ]]; then
  read -r GROUP_ID SESSION_TOKEN < "$GROUPFILE" || true
  if [[ "${GROUP_ID:-}" =~ ^[0-9]+$ ]] &&
      [[ -n "$(service_group_pids "$GROUP_ID")" ]]; then
    if ! service_group_verified "$GROUP_ID" "${SESSION_TOKEN:-}"; then
      echo "running: unverified_process_group"
      exit 1
    fi
    if [[ -f "$PIDFILE" ]] &&
        [[ "$(cat "$PIDFILE" 2>/dev/null || true)" == "$GROUP_ID" ]] &&
        [[ "$(ps -o args= -p "$GROUP_ID" 2>/dev/null || true)" == *"$SCRIPT_DIR/run.sh"* ]]; then
      echo "running: true"
      echo "pid: $GROUP_ID"
    else
      echo "running: orphaned_group"
      echo "pgid: $GROUP_ID"
      exit 1
    fi
  else
    echo "running: false"
  fi
elif [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ "${PID:-}" =~ ^[0-9]+$ ]] && (( PID > 1 )) && kill -0 "$PID" 2>/dev/null &&
      [[ "$(ps -o args= -p "$PID" 2>/dev/null || true)" == *"$SCRIPT_DIR/run.sh"* ]]; then
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
if [[ "${HOCKER_NODE_AGENT_SHOW_LOGS:-false}" == "true" ]]; then
  echo "=== LOCAL LOG TAIL (may contain sensitive data) ==="
  tail -40 "$LOG_FILE" 2>/dev/null || true
else
  echo "Logs omitidos; habilitar HOCKER_NODE_AGENT_SHOW_LOGS=true solo localmente."
fi
