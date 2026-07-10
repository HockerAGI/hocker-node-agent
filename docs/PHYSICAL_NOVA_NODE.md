# Physical NOVA Node — hocker-node-agent

## Qué es

`hocker-node-agent` es el agente ejecutor local/físico del ecosistema HOCKER. Se ejecuta en un servidor físico (o máquina virtual) y procesa comandos autorizados provenientes de Supabase para un `PROJECT_ID` y `NODE_ID` determinados.

A diferencia del Cloud Action Gateway (`hocker.one`), este agente **no** ejecuta comandos cloud-only como `github.*`. Su dominio es la ejecución local: shell, filesystem y lectura de estado del nodo.

## Arquitectura

```
Supabase (commands table)
        │
        ▼
  Poll loop (cada POLL_MS ms)
        │
        ├── getControls()  → system_controls (kill_switch, allow_write)
        ├── fetchQueued()  → commands WHERE status='queued'
        ├── verifyCommand() → HMAC-SHA256 + timestamp validation
        └── executeCommand()
              ├── ping
              ├── status
              ├── read_dir
              ├── read_file_head
              ├── shell.exec   (requiere allow_write=true)
              └── fs.write     (requiere allow_write=true)

  Health server (HTTP nativo, puerto PORT=8081)
        ├── GET /health              (público)
        ├── GET /ready               (público)
        ├── GET /stats               (requiere x-hocker-agent-key)
        ├── GET /v1/jurix/audit/logs
        └── GET /v1/jurix/compliance

  Heartbeat (cada HEARTBEAT_MS ms, independiente del poll loop)
        └── upsertNode() → nodes table
```

### Componentes principales

- **`src/index.ts`** — Loop principal, health server, ejecución de comandos, heartbeat.
- **`src/config.ts`** — Carga y validación de configuración vía Zod desde variables de entorno.
- **`src/supabase.ts`** — Cliente de Supabase con service role key.
- **`src/lib/sandbox.ts`** — Sandbox de filesystem y ejecución de shell aislada.
- **`src/lib/signature.ts`** — Firma y verificación HMAC-SHA256 de comandos.
- **`src/command-policy.ts`** — Política de comandos: cuáles son cloud-only, cuáles locales soportados.
- **`src/types.ts`** — Tipos compartidos (AgentCommand, Controls, ShellExecResult, etc.).

### Modo Mirror

Cuando `MIRROR_ENABLED=true`, el agente registra además un nodo espejo (`MIRROR_NODE_ID`) que replica la presencia del nodo principal (`MIRROR_PRIMARY_NODE_ID`). Útil para alta disponibilidad y monitoreo redundante.

## Instalación

### Requisitos

- Node.js 22.x (requerido por `engines` en `package.json`)
- Acceso a Supabase (URL + service role key)
- Secret HMAC para firmar comandos (`HOCKER_COMMAND_HMAC_SECRET`, mínimo 24 caracteres)

### Pasos

```bash
# Clonar el repositorio
git clone https://github.com/HockerAGI/hocker-node-agent.git
cd hocker-node-agent

# Instalar dependencias
npm ci

# Configurar entorno
cp .env.example .env
# Editar .env con tus credenciales reales

# Compilar
npm run build

# Iniciar
npm start
```

### Variables de entorno (.env)

| Variable | Descripción | Default |
|---|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase | (requerido) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key de Supabase | (requerido) |
| `HOCKER_COMMAND_HMAC_SECRET` | Secreto HMAC para firmar/verificar comandos | (requerido, min 24 chars) |
| `PROJECT_ID` | ID del proyecto | `hocker-one` |
| `NODE_ID` | ID del nodo | `hocker-node-1` |
| `PORT` | Puerto del health server | `8081` |
| `POLL_MS` | Intervalo del poll loop en ms | `5000` |
| `HEARTBEAT_MS` | Intervalo de heartbeat en ms | `15000` |
| `MAX_COMMAND_AGE_MS` | Edad máxima de comando aceptado | `300000` (5 min) |
| `SANDBOX_ENABLED` | Habilitar sandbox de filesystem | `true` |
| `SANDBOX_ROOT` | Directorio raíz del sandbox | `./sandbox` |
| `HOCKER_AGENT_KEY` | Key para autenticar endpoint `/stats` | (vacío = sin auth) |
| `ORCHESTRATOR_URL` | URL del orquestador (opcional) | (vacío) |
| `MIRROR_ENABLED` | Habilitar modo mirror | `false` |
| `MIRROR_NODE_ID` | ID del nodo espejo | (vacío) |
| `MIRROR_PRIMARY_NODE_ID` | ID del nodo principal espejado | (vacío) |

## Comandos soportados

### Lectura local (no requieren `allow_write`)

| Comando | Descripción | Parámetros |
|---|---|---|
| `ping` | Verifica que el agente responde | — |
| `status` | Estado del nodo, controles y sandbox | — |
| `read_dir` | Lista contenido de un directorio | `path` (relativo al sandbox) |
| `read_file_head` | Lee los primeros bytes de un archivo | `path`, `maxBytes` (default 4096) |

### Escritura local (requieren `allow_write=true`)

| Comando | Descripción | Parámetros |
|---|---|---|
| `shell.exec` | Ejecuta un script en `/bin/sh -lc` | `script`, `timeout` (default 30s, max 120s) |
| `fs.write` | Escribe contenido a un archivo | `path`, `content` |

### Comandos rechazados

- `github.*` — Cloud-only, se ejecutan en `hocker.one` / Cloud Action Gateway.
- Cualquier comando no listado arriba.

## Seguridad

- **Firma HMAC**: Todo comando debe tener una firma HMAC-SHA256 válida verificada contra `HOCKER_COMMAND_HMAC_SECRET`.
- **Timestamp**: Los comandos con más de `MAX_COMMAND_AGE_MS` de antigüedad o con timestamp futuro >30s son rechazados.
- **Kill switch**: Si `system_controls.kill_switch=true`, el agente pausa la ejecución. Si hay error al leer controles, fail-safe = kill_switch activado.
- **Allow write**: `shell.exec` y `fs.write` requieren `allow_write=true` en `system_controls`.
- **Sandbox**: Filesystem aislado bajo `SANDBOX_ROOT`. Prevención de path traversal (sandbox escape).
- **Auth en /stats**: El endpoint `/stats` requiere header `x-hocker-agent-key` cuando `HOCKER_AGENT_KEY` está configurado.

## Endpoints HTTP

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/health` | Público | Estado del nodo, project_id, sandbox |
| GET | `/ready` | Público | readiness check simple |
| GET | `/stats` | `x-hocker-agent-key` | Métricas en tiempo real: heartbeats, comandos, uptime |
| GET | `/v1/jurix/audit/logs` | — | Logs de auditoría (tabla `audit_logs`) |
| GET | `/v1/jurix/compliance` | — | Eventos de compliance (tabla `compliance_events`) |

## Scripts de servicio

El repositorio incluye scripts bash para gestionar el agente como servicio en un servidor físico. Se encuentran en `scripts/service/`.

### Instalación del servicio

```bash
bash scripts/service/install-termux-ubuntu.sh
```

Esto copia los scripts a `$HOCKER_NODE_AGENT_SERVICE_BASE` (default: `/root/HOCKER_SERVICES/hocker-node-agent`) y crea un archivo `service.env`.

### Comandos del servicio

| Script | Descripción |
|---|---|
| `start.sh` | Inicia el agente con `nohup`, guarda PID en `service.pid` |
| `stop.sh` | Detiene el agente (mata proceso y limpia PID) |
| `restart.sh` | Stop + start + status |
| `status.sh` | Muestra estado del proceso, health, ready y log tail |
| `doctor.sh` | Diagnóstico completo: git, node, build, env, servicio, procesos, health |
| `run.sh` | Loop principal del servicio con auto-restart (reinicia tras 5s si se cae) |

### Flujo del servicio

1. `start.sh` → lanza `run.sh` con `nohup`, guarda PID
2. `run.sh` → loop infinito: `npm run start` → si muere, espera 5s y reinicia
3. `stop.sh` → mata el proceso del PID + `pkill` de procesos huérfanos
4. `status.sh` → verifica PID activo, consulta `/health` y `/ready`, muestra log tail

### Variables del servicio

| Variable | Default | Descripción |
|---|---|---|
| `HOCKER_NODE_AGENT_REPO_DIR` | `$HOME/HOCKER_PUSH_REAL/hocker-node-agent` | Directorio del repo |
| `HOCKER_NODE_AGENT_SERVICE_BASE` | `/root/HOCKER_SERVICES/hocker-node-agent` | Directorio del servicio |
| `HOCKER_NODE_AGENT_LOG_FILE` | `/tmp/hocker-node-agent-service.log` | Archivo de log |
| `PORT` | `8081` | Puerto del health server |

## Docker

El agente incluye un `Dockerfile` multi-stage basado en `node:22-slim`:

```bash
docker build -t hocker-node-agent .
docker run -d \
  --env-file .env \
  -p 8081:8081 \
  hocker-node-agent
```

El contenedor corre con usuario no-root `hocker` y usa `dumb-init` como PID 1 para manejo correcto de señales.
