#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# service.env is parsed as data only (never evaluated as shell code).
. "$SCRIPT_DIR/load-env.sh"

REPO_DIR="${HOCKER_NODE_AGENT_REPO_DIR:-$HOME/HOCKER_PUSH_REAL/hocker-node-agent}"
PORT="${PORT:-8081}"

cd "$REPO_DIR"

echo "=== HOCKER NODE AGENT DOCTOR ==="
echo "repo: $REPO_DIR"
echo "date: $(date -Is)"

echo
echo "=== GIT ==="
git status --short || true
git log -5 --oneline --decorate || true

echo
echo "=== NODE ==="
node -v || true
npm -v || true

echo
echo "=== BUILD CHECK ==="
npm run typecheck
npm run build

echo
echo "=== ENV CHECK (presence only: NO secret hashes or values) ==="
python3 - <<'PY'
from pathlib import Path
import sys

env = Path(".env")
keys = {}
if env.is_file():
    for raw in env.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        keys[key.strip()] = bool(value.strip().strip('"').strip("'"))

required = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HOCKER_AGENT_KEY",
    "PROJECT_ID", "NODE_ID",
]
missing = [key for key in required if not keys.get(key)]
hmac = keys.get("HOCKER_COMMAND_HMAC_SECRET") or keys.get("COMMAND_HMAC_SECRET")
for key in required:
    print(f"{key}: {'SET' if keys.get(key) else 'MISSING'}")
print(f"COMMAND_HMAC: {'SET' if hmac else 'MISSING'}")
sys.exit(1 if missing or not hmac else 0)
PY

echo
echo "=== SERVICE STATUS ==="
"$(dirname "${BASH_SOURCE[0]}")/status.sh"

echo
echo "=== PROCESOS ==="
ps aux | grep -E "hocker-node-agent|node dist/index.js|run.sh" | grep -v grep || true

echo
echo "=== HEALTH / READY HTTP (no secret payloads) ==="
HEALTH_CODE="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)"
READY_CODE="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${PORT}/ready" || true)"
echo "health_http: $HEALTH_CODE"
echo "ready_http: $READY_CODE"

if [[ "$HEALTH_CODE" != "200" || "$READY_CODE" != "200" ]]; then
  echo "NODE_NOT_READY: proceso, controles o heartbeat requieren diagnóstico local" >&2
  exit 1
fi
echo "LOCAL_HEALTH_READY_CONFIRMED: HTTP 200/200"
echo "Nota: valida por separado heartbeat fresco en Supabase; no declara runtime dedicado verificado."
