#!/usr/bin/env bash
# Shared, non-evaluating parser for the installer's service.env.
# Values are treated literally, so a configured path cannot execute shell code.
SERVICE_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -f "$SERVICE_SCRIPT_DIR/service.env" ]]; then
  if [[ ! -r "$SERVICE_SCRIPT_DIR/service.env" ]]; then
    echo "SERVICE_ENV_NOT_READABLE" >&2
    return 1
  fi
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    case "$key" in
      HOCKER_NODE_AGENT_REPO_DIR|HOCKER_NODE_AGENT_SERVICE_BASE|HOCKER_NODE_AGENT_LOG_FILE)
        export "$key=$value"
        ;;
    esac
  done < "$SERVICE_SCRIPT_DIR/service.env"
fi

# Preserve the application port precedence: launch environment first,
# then the repository .env (dotenv's source), then the runtime default.
# PORT in an older service.env is deliberately ignored to avoid overriding
# an existing deployment's listening port during upgrades.
if [[ -z "${PORT:-}" && -n "${HOCKER_NODE_AGENT_REPO_DIR:-}" &&
      -f "$HOCKER_NODE_AGENT_REPO_DIR/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    key="${key//[[:space:]]/}"
    [[ "$key" == "PORT" ]] || continue
    value="${line#*=}"
    value="${value%%#*}"
    value="${value//[[:space:]]/}"
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )); then
      export PORT="$value"
    fi
    # dotenv resolves duplicate definitions using the final one; preserve
    # that behavior instead of selecting the first PORT entry.
  done < "$HOCKER_NODE_AGENT_REPO_DIR/.env"
fi
