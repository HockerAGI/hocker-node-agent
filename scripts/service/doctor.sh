#!/usr/bin/env bash
set -Eeuo pipefail

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
echo "=== ENV CHECK ==="
python3 - <<'PY'
from pathlib import Path
import hashlib

env = Path(".env")
keys = {}
if env.exists():
    for raw in env.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        keys[k.strip()] = v.strip().strip('"').strip("'")

def fp(value):
    if not value:
        return "MISSING"
    return hashlib.sha256(value.encode()).hexdigest()[:12]

for key in [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "HOCKER_COMMAND_HMAC_SECRET",
    "COMMAND_HMAC_SECRET",
    "PROJECT_ID",
    "NODE_ID",
]:
    value = keys.get(key)
    if "SECRET" in key or "KEY" in key:
        print(f"{key}: {fp(value)}")
    else:
        print(f"{key}: {'SET' if value else 'MISSING'}")
PY

echo
echo "=== SERVICE STATUS ==="
"$(dirname "${BASH_SOURCE[0]}")/status.sh"

echo
echo "=== PROCESOS ==="
ps aux | grep -E "hocker-node-agent|node dist/index.js|run.sh" | grep -v grep || true

echo
echo "=== HEALTH DIRECT ==="
curl -sS "http://127.0.0.1:${PORT}/health" || true

echo
echo
echo "=== READY DIRECT ==="
curl -sS "http://127.0.0.1:${PORT}/ready" || true

echo
echo
echo "OK: doctor finalizado."
