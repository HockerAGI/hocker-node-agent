# hocker-node-agent

Agente local/físico del ecosistema HOCKER.

## Rol real

Este servicio ejecuta comandos locales autorizados desde Supabase commands para PROJECT_ID=hocker-one y NODE_ID=hocker-node-1.

No ejecuta comandos cloud-only.

github.* -> hocker.one / cloud-hocker-one
shell/fs/local -> hocker-node-agent / hocker-node-1

## Comandos realmente soportados

Lectura local:
- ping
- status
- read_dir
- read_file_head

Escritura local/sandbox:
- shell.exec
- fs.write

## Seguridad

- Requiere firma HMAC válida.
- Respeta MAX_COMMAND_AGE_MS.
- shell.exec y fs.write requieren allow_write=true.
- github.* se rechaza explícitamente porque pertenece al Cloud Action Gateway.
