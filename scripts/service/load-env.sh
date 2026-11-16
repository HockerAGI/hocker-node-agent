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
      HOCKER_NODE_AGENT_REPO_DIR|HOCKER_NODE_AGENT_SERVICE_BASE|HOCKER_NODE_AGENT_LOG_FILE|PORT)
        export "$key=$value"
        ;;
    esac
  done < "$SERVICE_SCRIPT_DIR/service.env"
fi
