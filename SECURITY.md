# Security Policy

## Supported version

Security fixes target the current `main` release line and are validated on an isolated hardening branch before promotion.

## Reporting a vulnerability

Do not open a public issue for exposed credentials, command-signature weaknesses, unauthorized execution, unsafe filesystem or shell behavior, cross-project access, personal-data exposure, or infrastructure weaknesses.

Report privately to **contacto.hocker@gmail.com** with the affected component, safe reproduction steps, impact, required privileges, and minimal redacted evidence.

Never include live credentials, personal data, destructive payloads, or production records in a public report.

Critical command-authentication, authorization, signing, destructive-action, secrets, and cross-tenant issues block release until remediated and regression-tested. Fixes must preserve signed execution, audit evidence, and rollback capability.
