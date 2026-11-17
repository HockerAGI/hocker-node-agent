#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# service.env is parsed as data only (never evaluated as shell code).
. "$SCRIPT_DIR/load-env.sh"

SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"
PIDFILE="$SERVICE_BASE/service.pid"
GROUPFILE="$SERVICE_BASE/service.group"
. "$SCRIPT_DIR/service-group.sh"

if [[ -f "$GROUPFILE" ]]; then
  read -r GROUP_ID SESSION_TOKEN < "$GROUPFILE" || true
  if [[ ! "${GROUP_ID:-}" =~ ^[0-9]+$ ]] ||
      [[ ! "${SESSION_TOKEN:-}" =~ ^[a-f0-9]{32}$ ]] ||
      (( GROUP_ID <= 1 )); then
    echo "SERVICE_GROUP_METADATA_INVALID: refusing unsafe termination" >&2
    exit 1
  fi
  GROUP_PIDS="$(service_group_pids "$GROUP_ID")" || {
    echo "SERVICE_GROUP_ENUMERATION_FAILED: preserving shutdown metadata" >&2
    exit 1
  }
  if [[ -n "$GROUP_PIDS" ]]; then
    if ! service_group_verified "$GROUP_ID" "$SESSION_TOKEN"; then
      echo "PIDFILE_PROCESS_MISMATCH: foreign or unverifiable service group; refusing kill" >&2
      exit 1
    fi
    echo "Stopping isolated service process group $GROUP_ID"
    kill -TERM -- "-$GROUP_ID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      GROUP_PIDS="$(service_group_pids "$GROUP_ID")" || {
        echo "SERVICE_GROUP_ENUMERATION_FAILED: preserving shutdown metadata" >&2
        exit 1
      }
      [[ -z "$GROUP_PIDS" ]] && break
      sleep 0.25
    done
    GROUP_PIDS="$(service_group_pids "$GROUP_ID")" || {
      echo "SERVICE_GROUP_ENUMERATION_FAILED: preserving shutdown metadata" >&2
      exit 1
    }
    if [[ -n "$GROUP_PIDS" ]]; then
      echo "SERVICE_GROUP_STILL_RUNNING: intervention required; refusing false success" >&2
      exit 1
    fi
  fi
  rm -f "$GROUPFILE" "$PIDFILE"
  echo "hocker-node-agent detenido; grupo verificado vacío."
  exit 0
fi

# Backward-compatible legacy PIDFILE: only the verified living supervisor
# can be stopped safely. An orphan from the old launcher cannot be scoped.
if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ "${PID:-}" =~ ^[0-9]+$ ]] && (( PID > 1 )) &&
      kill -0 "$PID" 2>/dev/null; then
    ARGS="$(ps -o args= -p "$PID" 2>/dev/null || true)"
    if [[ "$ARGS" != *"$SCRIPT_DIR/run.sh"* ]]; then
      echo "PIDFILE_PROCESS_MISMATCH: refusing to kill unrelated process" >&2
      exit 1
    fi
    echo "Stopping verified legacy supervisor PID $PID"
    terminate_descendants() {
      local parent="$1" child
      while IFS= read -r child; do
        [[ "$child" =~ ^[0-9]+$ ]] || continue
        terminate_descendants "$child"
        kill "$child" 2>/dev/null || true
      done < <(pgrep -P "$parent" 2>/dev/null || true)
    }
    terminate_descendants "$PID"
    kill "$PID" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "Legacy supervisor stopped. Check for old orphan workers manually."
    exit 0
  fi
  echo "LEGACY_ORPHAN_UNVERIFIABLE: supervisor absent; manual host inspection required" >&2
  exit 1
fi
echo "hocker-node-agent no tiene PIDFILE; no se inició una parada."
