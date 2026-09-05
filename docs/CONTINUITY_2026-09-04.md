# HOCKER Node Agent — Continuity 2026-09-04

- main: 41cf21627933fbbed70638668a0031321d5e20e7.
- Supabase JS is 2.112.4.
- Security boundary remains HMAC + project/node scope + allowlist + cloud-action rejection + sandbox/non-root + allow_write + telemetry.
- Current physical heartbeat evidence is stale; do not claim the node is live without a fresh heartbeat.
- The agent is ready for the final manual batch once software-side gates are closed.


## Post-merge evidence cut 2026-09-05

Latest main has changed. Re-query main/CI/deployment/runtime evidence before the next material mutation; repository state alone never proves liveness.
