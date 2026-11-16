#!/usr/bin/env bash
# Dedicated launch group checks; do not source service.env as shell code.
# Works on the Linux/Ubuntu environment used by this supervised service.
service_group_pids() {
  local group="$1"
  [[ "$group" =~ ^[0-9]+$ ]] && (( group > 1 )) || return 1
  ps -eo pid=,pgid=,stat= | awk -v g="$group" '$2 == g && $3 !~ /^Z/ {print $1}'
}
service_group_verified() {
  local group="$1" marker="$2" member found=0
  [[ "$marker" =~ ^[a-f0-9]{32}$ ]] || return 1
  while IFS= read -r member; do
    [[ "$member" =~ ^[0-9]+$ ]] || continue
    if [[ ! -r "/proc/$member/environ" ]]; then
      # A process that exited while enumerating is not evidence of a foreign group.
      kill -0 "$member" 2>/dev/null && return 1
      continue
    fi
    if ! tr '\0' '\n' < "/proc/$member/environ" 2>/dev/null |
        grep -Fxq "HOCKER_NODE_AGENT_SERVICE_SESSION=$marker"; then
      kill -0 "$member" 2>/dev/null && return 1
      continue
    fi
    found=1
  done < <(service_group_pids "$group")
  (( found == 1 ))
}
