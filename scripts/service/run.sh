#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${HOCKER_NODE_AGENT_REPO_DIR:-$HOME/HOCKER_PUSH_REAL/hocker-node-agent}"
LOG_FILE="${HOCKER_NODE_AGENT_LOG_FILE:-/tmp/hocker-node-agent-service.log}"

cd "$REPO_DIR"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null || true

mkdir -p "$(dirname "$LOG_FILE")"

while true; do
  {
    echo
    echo "=== hocker-node-agent start $(date -Is) ==="
    echo "repo=$REPO_DIR"
    echo "node=$(node -v 2>/dev/null || echo missing)"
    echo "npm=$(npm -v 2>/dev/null || echo missing)"
  } >> "$LOG_FILE"

  npm run start >> "$LOG_FILE" 2>&1 || true

  {
    echo "=== hocker-node-agent stopped $(date -Is), restarting in 5s ==="
  } >> "$LOG_FILE"

  sleep 5
done
