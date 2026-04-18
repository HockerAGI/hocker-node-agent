# Hocker Node Agent

Agente ejecutor físico del ecosistema HOCKER. Consume comandos firmados desde Supabase, los valida por HMAC y los ejecuta dentro de un sandbox local.

## Variables clave
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `HOCKER_COMMAND_HMAC_SECRET`
- `HOCKER_AGENT_KEY`
- `NODE_ID`
- `PROJECT_ID`
- `PORT`
- `POLL_MS`
- `SANDBOX_ENABLED`
- `SANDBOX_ROOT`

## Comandos soportados
- `ping`
- `status`
- `read_dir`
- `read_file_head`
- `shell.exec`
- `fs.write`

## Seguridad
- Firma HMAC obligatoria
- Ventana máxima de edad para comandos
- Rutas confinadas al sandbox
- Escritura bloqueable por `system_controls.allow_write`
- Pausa total con `system_controls.kill_switch`