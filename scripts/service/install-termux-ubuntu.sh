#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${HOCKER_NODE_AGENT_REPO_DIR:-$HOME/HOCKER_PUSH_REAL/hocker-node-agent}"
SERVICE_BASE="${HOCKER_NODE_AGENT_SERVICE_BASE:-/root/HOCKER_SERVICES/hocker-node-agent}"

cd "$REPO_DIR"

mkdir -p "$SERVICE_BASE"

cp -v scripts/service/run.sh "$SERVICE_BASE/run.sh"
cp -v scripts/service/start.sh "$SERVICE_BASE/start.sh"
cp -v scripts/service/stop.sh "$SERVICE_BASE/stop.sh"
cp -v scripts/service/restart.sh "$SERVICE_BASE/restart.sh"
cp -v scripts/service/status.sh "$SERVICE_BASE/status.sh"
cp -v scripts/service/doctor.sh "$SERVICE_BASE/doctor.sh"

chmod +x "$SERVICE_BASE"/*.sh
chmod +x scripts/service/*.sh

cat > "$SERVICE_BASE/service.env" <<ENV
HOCKER_NODE_AGENT_REPO_DIR=$REPO_DIR
HOCKER_NODE_AGENT_SERVICE_BASE=$SERVICE_BASE
HOCKER_NODE_AGENT_LOG_FILE=/tmp/hocker-node-agent-service.log
PORT=8081
ENV

echo
echo "Servicio instalado en: $SERVICE_BASE"
echo
echo "Comandos:"
echo "$SERVICE_BASE/start.sh"
echo "$SERVICE_BASE/stop.sh"
echo "$SERVICE_BASE/restart.sh"
echo "$SERVICE_BASE/status.sh"
echo "$SERVICE_BASE/doctor.sh"
