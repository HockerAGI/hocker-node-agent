# Hocker Node Agent

Agente ejecutor físico del ecosistema **Hocker ONE**. Se despliega en cualquier máquina local, servidor o VPS y recibe comandos firmados desde el orquestador **NOVA** a través de Supabase, ejecutándolos de forma segura dentro de un sandbox controlado.

---

## Arquitectura

```
hocker.one (Control Plane)
        │
        ▼
  nova.agi (Orquestador IA)
        │  inserta comandos en Supabase
        ▼
hocker-node-agent (este repo)
        │  polling → ejecuta → reporta resultado
        ▼
    Supabase DB
```

El agente **nunca expone puertos públicos** de ejecución. Toda comunicación es saliente (pull), lo que elimina la necesidad de abrir firewall rules hacia el nodo.

---

## Características

- **Zero-Trust**: cada comando lleva firma HMAC-SHA256. El agente la verifica antes de ejecutar.
- **Kill-switch**: cualquier ejecución puede pausarse en tiempo real desde `system_controls`.
- **Modo solo lectura**: `allow_write=false` bloquea `shell.exec` y `fs.write` sin detener el agente.
- **Sandbox de sistema de archivos**: todas las operaciones de archivo están confinadas a `SANDBOX_ROOT`.
- **Observabilidad**: cada evento se registra en Supabase (`events`, `agent_logs`) y en Langfuse.
- **Health check**: endpoint `GET /health` para monitoreo (Kubernetes, Coolify, Docker Compose, etc.).

---

## Instalación

### Requisitos

- Node.js ≥ 18
- Acceso a Supabase (URL + Service Role Key)
- `COMMAND_HMAC_SECRET` compartido con nova.agi

### Pasos

```bash
git clone https://github.com/tu-org/hocker-node-agent.git
cd hocker-node-agent
npm install
cp .env.example .env
# Editar .env con tus credenciales
npm run dev
```

### Docker

```bash
docker build -t hocker-node-agent .
docker run --env-file .env hocker-node-agent
```

---

## Variables de entorno

| Variable | Requerida | Por defecto | Descripción |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | — | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | Llave de servicio Supabase |
| `COMMAND_HMAC_SECRET` | ✅ | — | Secreto compartido para verificar firmas (mín. 24 chars) |
| `NODE_ID` | — | `hocker-node-1` | Identificador único de este nodo |
| `PROJECT_ID` | — | `global` | ID del proyecto al que pertenece |
| `PORT` | — | `8080` | Puerto del servidor de salud |
| `POLL_MS` | — | `2000` | Intervalo de polling en ms |
| `SANDBOX_ROOT` | — | `./sandbox` | Directorio raíz del sandbox de archivos |
| `ORCHESTRATOR_URL` | — | — | URL de nova.agi (opcional, para futura integración push) |
| `LANGFUSE_PUBLIC_KEY` | — | `dummy` | Llave pública de Langfuse |
| `LANGFUSE_SECRET_KEY` | — | `dummy` | Llave secreta de Langfuse |
| `LANGFUSE_BASE_URL` | — | `https://cloud.langfuse.com` | URL base de Langfuse |

---

## Comandos soportados

| Comando | Descripción | Payload |
|---|---|---|
| `ping` | Verificación de conectividad | — |
| `status` | Estado del proceso (uptime, memoria) | — |
| `read_dir` | Lista archivos en el sandbox | `{ path: string }` |
| `read_file_head` | Lee los primeros N bytes de un archivo | `{ path: string, maxBytes?: number }` |
| `shell.exec` | Ejecuta un script de shell | `{ script: string, timeout?: number }` |
| `fs.write` | Escribe un archivo en el sandbox | `{ path: string, content: string }` |

> `shell.exec` y `fs.write` requieren `allow_write=true` en `system_controls`.

---

## Seguridad

### Firma HMAC

Cada comando incluye una firma generada por nova.agi:

```
HMAC-SHA256( id | project_id | node_id | command | created_at | payload_json_canonical )
```

El agente verifica esta firma antes de ejecutar. Un comando sin firma válida es rechazado con `invalid_signature`.

### Sandbox

Todas las rutas de archivo se resuelven dentro de `SANDBOX_ROOT`. Cualquier intento de acceder a rutas fuera del sandbox (path traversal) lanza un error inmediato.

### Comandos bloqueados

El agente bloquea patrones destructivos como `rm -rf /`, `shutdown`, `mkfs`, etc., independientemente de los permisos.

---

## Scripts

```bash
npm run dev      # Modo desarrollo con tsx (hot reload)
npm run build    # Compilar TypeScript → dist/
npm run start    # Ejecutar desde dist/
```

---

## Integración con el ecosistema

- **hocker.one**: visualiza el estado del nodo en tiempo real (tabla `nodes`)
- **nova.agi**: inserta comandos firmados en la tabla `commands`
- **Supabase**: fuente de verdad compartida entre los tres servicios
