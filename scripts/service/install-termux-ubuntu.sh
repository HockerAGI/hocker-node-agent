#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${HOCKER_NODE_AGENT_REPO_DIR:-$HOME/HOCKER_PUSH_REAL/hocker-node-agent}"
SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"

cd "$REPO_DIR"
REPO_DIR="$(pwd -P)"

mkdir -p "$SERVICE_BASE"
SERVICE_BASE="$(cd "$SERVICE_BASE" && pwd -P)"
# Dedicated operational directory: no writable service configuration for others.
chmod 700 "$SERVICE_BASE"

cp -v scripts/service/load-env.sh "$SERVICE_BASE/load-env.sh"
cp -v scripts/service/run.sh "$SERVICE_BASE/run.sh"
cp -v scripts/service/start.sh "$SERVICE_BASE/start.sh"
cp -v scripts/service/stop.sh "$SERVICE_BASE/stop.sh"
cp -v scripts/service/restart.sh "$SERVICE_BASE/restart.sh"
cp -v scripts/service/status.sh "$SERVICE_BASE/status.sh"
cp -v scripts/service/doctor.sh "$SERVICE_BASE/doctor.sh"

chmod +x "$SERVICE_BASE"/*.sh
chmod +x scripts/service/*.sh

# The file is DATA, not sourced by any operational script.
# Write it with restrictive permissions; literal values may contain spaces.
(
  umask 077
  {
    printf 'HOCKER_NODE_AGENT_REPO_DIR=%s\n' "$REPO_DIR"
    printf 'HOCKER_NODE_AGENT_SERVICE_BASE=%s\n' "$SERVICE_BASE"
    printf 'HOCKER_NODE_AGENT_LOG_FILE=%s\n' "/tmp/hocker-node-agent-service.log"
  } > "$SERVICE_BASE/service.env"
)
chmod 600 "$SERVICE_BASE/service.env"

echo
echo "Servicio instalado en: $SERVICE_BASE"
echo "PORT se respeta desde el entorno del proceso o desde .env del repositorio."
echo
echo "Comandos:"
echo "$SERVICE_BASE/start.sh"
echo "$SERVICE_BASE/stop.sh"
echo "$SERVICE_BASE/restart.sh"
echo "$SERVICE_BASE/status.sh"
echo "$SERVICE_BASE/doctor.sh"
