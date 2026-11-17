#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# service.env is parsed as data only (never evaluated as shell code).
. "$SCRIPT_DIR/load-env.sh"

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"
GROUPFILE="$SERVICE_BASE/service.group"
. "$SCRIPT_DIR/service-group.sh"

mkdir -p "$SERVICE_BASE"
chmod 700 "$SERVICE_BASE"
if [[ -f "$GROUPFILE" ]]; then
  read -r OLD_GROUP OLD_MARKER < "$GROUPFILE" || true
  if [[ "${OLD_GROUP:-}" =~ ^[0-9]+$ ]] && (( OLD_GROUP > 1 )); then
    OLD_PIDS="$(service_group_pids "$OLD_GROUP")" || {
      echo "SERVICE_GROUP_ENUMERATION_FAILED: preserving startup metadata" >&2
      exit 1
    }
    if [[ -n "$OLD_PIDS" ]]; then
    if service_group_verified "$OLD_GROUP" "${OLD_MARKER:-}"; then
      echo "SERVICE_GROUP_EXISTS: stop the existing group before starting another" >&2
    else
      echo "SERVICE_GROUP_UNVERIFIED: refusing duplicate startup" >&2
    fi
      exit 1
    fi
  fi
  rm -f "$GROUPFILE" "$PIDFILE"
fi

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

if ! command -v setsid >/dev/null 2>&1; then
  echo "SETSID_REQUIRED: cannot isolate hocker-node-agent service" >&2
  exit 1
fi
# NVM-only hosts have no Node before run.sh sources nvm.sh.
if ! command -v od >/dev/null 2>&1; then
  echo "SECURE_RANDOM_REQUIRED: od is not available" >&2
  exit 1
fi
TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^[a-f0-9]{32}$ ]] || { echo "SERVICE_MARKER_CREATION_FAILED" >&2; exit 1; }
# A fresh session/process group isolates supervisor AND orphaned descendants.
HOCKER_NODE_AGENT_SERVICE_SESSION="$TOKEN" setsid bash "$SCRIPT_DIR/run.sh" >/dev/null 2>&1 &
PID="$!"
sleep 0.1
PGID="$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$PGID" != "$PID" ]]; then
  echo "SERVICE_GROUP_START_UNVERIFIED: no PID files written" >&2
  exit 1
fi
(
  umask 077
  printf '%s %s\n' "$PGID" "$TOKEN" > "$GROUPFILE"
  printf '%s\n' "$PID" > "$PIDFILE"
)
echo "hocker-node-agent supervisor iniciado. PID / group: $PID"
