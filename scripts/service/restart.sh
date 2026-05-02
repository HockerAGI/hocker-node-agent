#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/stop.sh" || true
sleep 3
"$SCRIPT_DIR/start.sh"
sleep 5
"$SCRIPT_DIR/status.sh"
