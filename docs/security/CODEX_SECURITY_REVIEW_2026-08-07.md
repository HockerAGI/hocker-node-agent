# Hocker Node Agent — Codex Security Review — 2026-08-07

## Status

**Connector-assisted standard security review. No node rollout or production execution is authorized.**

This review follows the installed Codex Security standard methodology. The native Codex Security worker/scan-ID runtime is not exposed in this ChatGPT environment, so source inspection used the authenticated GitHub connector. Coverage is **partial / connector-assisted**.

Repository: `HockerAGI/hocker-node-agent`
Version: hardening candidate branch `hardening/production-readiness-20260807`

## Threat model

### Assets
- Agent API key and command HMAC secret.
- Host filesystem/process privileges.
- Sandbox workspace.
- Supabase service-role access and command queue.
- Governance kill switch / allow-write state.

### Trust boundaries
- Local/LAN caller → health/control HTTP surface.
- Supabase command row → signature/age validation → executor.
- Command payload → filesystem or shell operation.
- Governance state → permission to mutate host state.

### Security invariants
- Default bind is loopback; LAN exposure requires explicit opt-in.
- Agent key and HMAC signing secret must be distinct.
- Missing governance controls fail closed (`kill_switch=true`, `allow_write=false`).
- Only signed, fresh, project/node-scoped, approval-cleared commands execute.
- A queued command must be atomically claimed before execution.
- Filesystem reads/writes cannot escape the configured sandbox through path traversal or symlinks.
- Host shell execution is disabled by default.

## Validated controls

1. API key comparison is timing-safe.
2. Non-loopback binding requires explicit `HOCKER_AGENT_ALLOW_LAN=true`.
3. Configuration refuses identical agent-key/HMAC secrets.
4. Control lookup failures degrade to kill-switch enabled and writes disabled.
5. Command polling requires `status=queued` and `needs_approval=false`; state transitions verify expected status and returned row.
6. HMAC signature validation includes command identity, scope, payload, creation time and maximum age.
7. Sandbox path logic uses lexical and canonical path checks, blocks symlink escapes, limits read/write sizes and uses `O_NOFOLLOW` where available.
8. Environment passed to shell execution is intentionally stripped to a narrow environment.

## Residual findings

### P1/R4 — `shell.exec` is not an OS sandbox
`executeLocalShell` runs `/bin/sh -lc` on the host with the agent process privileges. The working directory and environment are restricted, but shell commands can still address host filesystem/network resources available to that OS identity. The configuration correctly names this control `HOCKER_ALLOW_UNSANDBOXED_SHELL` and defaults it to false.

**Required policy:** treat `shell.exec` as break-glass R4 only. Never enable it as a normal NOVA capability on a persistent production node. If productive arbitrary shell becomes necessary, move execution into a disposable container/VM with OS-level isolation, network policy and resource limits.

### P1 — service-role credential concentration
The node uses Supabase service-role access. Provider-side credential rotation and machine secret storage remain release requirements; values must never be stored in repo or general-purpose documents.

## Coverage

Reviewed high-risk surfaces include configuration/bind/auth, governance fail-closed behavior, command polling/claim/signature state machine and sandbox/shell implementation. This review does not assert exhaustive repository coverage or native independent Codex Security workers.
