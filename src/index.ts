import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { config } from "./config.js";
import { sb } from "./supabase.js";
import type {
  AgentCommand,
  Controls,
  DirEntryInfo,
  JsonObject,
  JsonValue,
} from "./types.js";
import { verifyCommand } from "./lib/signature.js";
import {
  isCloudOnlyCommand,
  isLocalSupportedCommand,
  supportedLocalCommandsSummary,
} from "./command-policy.js";
import {
  ensureSandbox,
  executeLocalShell,
  listDir,
  readFileHead,
  safeMetadata,
  writeLocalFile,
} from "./lib/sandbox.js";

const nowIso = () => new Date().toISOString();
const VALID_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

let stopping = false;
let healthServer: http.Server | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatRunning = false;

function controlsToJson(controls: Controls): JsonObject {
  return {
    kill_switch: controls.kill_switch,
    allow_write: controls.allow_write,
  };
}

function dirEntriesToJson(entries: DirEntryInfo[]): JsonValue[] {
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.type,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  }));
}

function secureEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers["x-hocker-agent-key"];
  const received = Array.isArray(header)
    ? String(header[0] ?? "")
    : String(header ?? "");
  return received.length > 0 && secureEqual(received, config.agentKey);
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: JsonObject,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 256 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_JSON_BODY");
  }
  return parsed as Record<string, unknown>;
}

function normalizeProjectId(value: unknown): string {
  return (
    String(value ?? config.projectId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 64) || config.projectId
  );
}

function scopedProjectId(value: unknown): string {
  const requested = normalizeProjectId(value);
  if (requested !== config.projectId) {
    throw new Error("PROJECT_SCOPE_VIOLATION");
  }
  return config.projectId;
}

function boundedLimit(url: URL, fallback = 200, maximum = 200): number {
  const parsed = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), maximum);
}

async function emitEvent(
  level: "info" | "warn" | "error",
  type: string,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await sb.from("events").insert({
    project_id: config.projectId,
    node_id: config.nodeId,
    level,
    type,
    message: message.slice(0, 2000),
    data: data as JsonObject,
  });

  if (error) {
    console.error(`[hocker-node-agent] telemetry failed: ${error.message}`);
  }
}

type ControlsState = {
  controls: Controls;
  available: boolean;
};

async function getControlsState(): Promise<ControlsState> {
  try {
    const { data, error } = await sb
      .from("system_controls")
      .select("kill_switch,allow_write")
      .eq("project_id", config.projectId)
      .eq("id", "global")
      .maybeSingle();

    if (error || !data) throw new Error(error?.message || "CONTROLS_NOT_FOUND");
    return {
      available: true,
      controls: {
        kill_switch: Boolean((data as { kill_switch?: unknown }).kill_switch),
        allow_write: Boolean((data as { allow_write?: unknown }).allow_write),
      },
    };
  } catch {
    return {
      available: false,
      controls: { kill_switch: true, allow_write: false },
    };
  }
}

async function getControls(): Promise<Controls> {
  return (await getControlsState()).controls;
}

async function upsertNode(
  status: "online" | "degraded" | "offline" = "online",
): Promise<void> {
  const { error } = await sb.from("nodes").upsert(
    {
      id: config.nodeId,
      project_id: config.projectId,
      name: `Node: ${config.nodeId}`,
      type: config.mirror.enabled ? "mirror" : "agent",
      status,
      last_seen_at: nowIso(),
      tags: config.mirror.enabled
        ? ["agent", "physical", "mirror"]
        : ["agent", "physical"],
      meta: {
        ...safeMetadata(),
        mirror: config.mirror.enabled,
        primary_node_id: config.mirror.enabled
          ? config.mirror.primaryNodeId
          : null,
      },
      updated_at: nowIso(),
    },
    { onConflict: "id" },
  );

  if (error) throw new Error(error.message);

  if (config.mirror.enabled && config.mirror.mirrorNodeId) {
    const { error: mirrorError } = await sb.from("nodes").upsert(
      {
        id: config.mirror.mirrorNodeId,
        project_id: config.projectId,
        name: `Mirror: ${config.mirror.mirrorNodeId}`,
        type: "mirror",
        status,
        last_seen_at: nowIso(),
        tags: ["mirror"],
        meta: {
          primary_node_id: config.nodeId,
          mirror_of: config.nodeId,
          registered_at: nowIso(),
        },
        updated_at: nowIso(),
      },
      { onConflict: "id" },
    );
    if (mirrorError) throw new Error(mirrorError.message);
  }
}

const stats = {
  totalHeartbeats: 0,
  lastHeartbeatAt: "",
  lastPollAt: "",
  commandsExecuted: 0,
  commandsFailed: 0,
  uptimeStart: Date.now(),
};

async function heartbeat(): Promise<void> {
  if (heartbeatRunning || stopping) return;
  heartbeatRunning = true;
  stats.totalHeartbeats += 1;
  stats.lastHeartbeatAt = nowIso();

  try {
    const state = await getControlsState();
    await upsertNode(
      !state.available || state.controls.kill_switch ? "degraded" : "online",
    );
    if (stats.totalHeartbeats % 4 === 0) {
      await emitEvent("info", "agent.heartbeat", "Heartbeat", {
        total_heartbeats: stats.totalHeartbeats,
        commands_executed: stats.commandsExecuted,
        commands_failed: stats.commandsFailed,
        uptime_seconds: Math.floor((Date.now() - stats.uptimeStart) / 1000),
        controls_available: state.available,
        kill_switch: state.controls.kill_switch,
        allow_write: state.controls.allow_write,
      });
    }
  } catch (error) {
    await emitEvent(
      "warn",
      "agent.heartbeat_error",
      error instanceof Error ? error.message : "heartbeat error",
    );
  } finally {
    heartbeatRunning = false;
  }
}

async function fetchQueued(): Promise<AgentCommand[]> {
  const { data, error } = await sb
    .from("commands")
    .select("*")
    .eq("project_id", config.projectId)
    .eq("node_id", config.nodeId)
    .eq("status", "queued")
    .eq("needs_approval", false)
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) throw new Error(error.message);
  return (data ?? []) as AgentCommand[];
}

async function updateCommandState(
  command: AgentCommand,
  expectedStatus: "queued" | "running",
  patch: JsonObject,
): Promise<boolean> {
  let query = sb
    .from("commands")
    .update(patch)
    .eq("id", command.id)
    .eq("project_id", config.projectId)
    .eq("node_id", config.nodeId)
    .eq("signature", command.signature)
    .eq("status", expectedStatus);

  if (expectedStatus === "queued") {
    query = query.eq("needs_approval", false);
  }

  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function markRunning(command: AgentCommand): Promise<boolean> {
  return updateCommandState(command, "queued", {
    status: "running",
    started_at: nowIso(),
  });
}

async function finishDone(command: AgentCommand, result: JsonObject): Promise<void> {
  const finishedAt = nowIso();
  const updated = await updateCommandState(command, "running", {
    status: "done",
    result,
    executed_at: finishedAt,
    finished_at: finishedAt,
    error: null,
  });
  if (!updated) throw new Error("COMMAND_STATE_CONFLICT_DONE");
}

async function finishErr(
  command: AgentCommand,
  error: string,
  expectedStatus: "queued" | "running",
): Promise<void> {
  const updated = await updateCommandState(command, expectedStatus, {
    status: "error",
    error: error.slice(0, 2000),
    finished_at: nowIso(),
  });
  if (!updated) throw new Error("COMMAND_STATE_CONFLICT_ERROR");
}

async function executeCommand(
  command: AgentCommand,
  controls: Controls,
): Promise<JsonObject> {
  if (command.project_id !== config.projectId || command.node_id !== config.nodeId) {
    throw new Error("COMMAND_SCOPE_VIOLATION");
  }

  const payload = (command.payload ?? {}) as Record<string, unknown>;

  if (isCloudOnlyCommand(command.command) || !isLocalSupportedCommand(command.command)) {
    await emitEvent(
      "error",
      "command.rejected",
      `Comando local rechazado: ${command.command}`,
      { command_id: command.id, command: command.command },
    );
    throw new Error(`Comando no soportado por hocker-node-agent: ${command.command}`);
  }

  switch (command.command) {
    case "ping":
      return { ok: true, pong: true, node_id: config.nodeId, ts: nowIso() };
    case "status":
      return {
        ok: true,
        node_id: config.nodeId,
        project_id: config.projectId,
        controls: controlsToJson(controls),
        sandbox: safeMetadata(),
      };
    case "read_dir":
      return {
        ok: true,
        path: String(payload.path ?? "."),
        entries: dirEntriesToJson(await listDir(String(payload.path ?? "."))),
      };
    case "read_file_head": {
      const result = await readFileHead(
        String(payload.path ?? ""),
        Number(payload.maxBytes ?? 4096),
      );
      return {
        ok: true,
        path: String(payload.path ?? ""),
        bytes: result.bytes,
        text: result.text,
      };
    }
    case "shell.exec": {
      if (!controls.allow_write) {
        throw new Error("shell.exec bloqueado por governance allow_write=false.");
      }
      const result = await executeLocalShell(
        String(payload.script ?? ""),
        Number(payload.timeout ?? 30000),
      );
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        elapsedMs: result.elapsedMs,
      };
    }
    case "fs.write": {
      if (!controls.allow_write) {
        throw new Error("fs.write bloqueado por governance allow_write=false.");
      }
      return {
        ok: true,
        path: await writeLocalFile(
          String(payload.path ?? ""),
          String(payload.content ?? ""),
        ),
      };
    }
    default:
      throw new Error(`Comando no soportado: ${command.command}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop(): Promise<void> {
  await ensureSandbox();
  await emitEvent("info", "agent.start", "Agente inicializado.", {
    command_policy: supportedLocalCommandsSummary(),
    shell_exec_enabled: config.shellExecEnabled,
  });

  while (!stopping) {
    try {
      stats.lastPollAt = nowIso();
      const state = await getControlsState();
      await upsertNode(
        !state.available || state.controls.kill_switch ? "degraded" : "online",
      );

      if (!state.available || state.controls.kill_switch) {
        await sleep(config.pollMs);
        continue;
      }

      for (const command of await fetchQueued()) {
        if (stopping) break;

        const valid = verifyCommand(
          config.commandHmacSecret,
          command.signature,
          command.id,
          command.project_id,
          command.node_id,
          command.command,
          command.payload,
          command.created_at,
          config.maxCommandAgeMs,
        );

        if (!valid) {
          try {
            await finishErr(command, "Firma inválida o expirada.", "queued");
          } catch (error) {
            await emitEvent(
              "error",
              "command.state_error",
              error instanceof Error ? error.message : "state error",
              { command_id: command.id },
            );
          }
          stats.commandsFailed += 1;
          continue;
        }

        if (!(await markRunning(command))) continue;

        try {
          const result = await executeCommand(command, state.controls);
          await finishDone(command, result);
          stats.commandsExecuted += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await finishErr(command, message, "running");
          } catch (stateError) {
            await emitEvent(
              "error",
              "command.state_error",
              stateError instanceof Error ? stateError.message : "state error",
              { command_id: command.id },
            );
          }
          stats.commandsFailed += 1;
          await emitEvent("error", "command.error", message, {
            command_id: command.id,
            command: command.command,
          });
        }
      }
    } catch (error) {
      await emitEvent(
        "error",
        "agent.loop_error",
        error instanceof Error ? error.message : String(error),
        { trace_id: randomUUID() },
      );
    }

    if (!stopping) await sleep(config.pollMs);
  }
}

function createHealthServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, {
          ok: true,
          service: "hocker-node-agent",
          ts: nowIso(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/ready") {
        const state = await getControlsState();
        const ready = state.available && !state.controls.kill_switch;
        writeJson(res, ready ? 200 : 503, {
          ok: ready,
          status: !state.available
            ? "dependency_unavailable"
            : state.controls.kill_switch
              ? "paused"
              : "ready",
          ts: nowIso(),
        });
        return;
      }

      if (!isAuthorized(req)) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/stats") {
        writeJson(res, 200, {
          ok: true,
          node_id: config.nodeId,
          project_id: config.projectId,
          mirror_enabled: config.mirror.enabled,
          heartbeat: {
            total: stats.totalHeartbeats,
            last_at: stats.lastHeartbeatAt,
            interval_ms: config.heartbeatMs,
          },
          commands: {
            executed: stats.commandsExecuted,
            failed: stats.commandsFailed,
          },
          uptime_seconds: Math.floor((Date.now() - stats.uptimeStart) / 1000),
          poll_ms: config.pollMs,
          ts: nowIso(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/jurix/audit/logs") {
        try {
          const projectId = scopedProjectId(url.searchParams.get("project_id"));
          const { data, error } = await sb
            .from("audit_logs")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false })
            .limit(boundedLimit(url));
          if (error) throw new Error(error.message);
          writeJson(res, 200, { ok: true, logs: (data ?? []) as JsonValue[] });
        } catch (error) {
          const message = error instanceof Error ? error.message : "audit query failed";
          if (message === "PROJECT_SCOPE_VIOLATION") {
            writeJson(res, 403, { ok: false, error: "project_scope_violation" });
          } else {
            await emitEvent("error", "jurix.audit_query_error", message);
            writeJson(res, 500, { ok: false, error: "audit_query_failed" });
          }
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/jurix/compliance") {
        try {
          const projectId = scopedProjectId(url.searchParams.get("project_id"));
          const { data, error } = await sb
            .from("compliance_events")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false })
            .limit(boundedLimit(url));
          if (error) throw new Error(error.message);
          writeJson(res, 200, { ok: true, events: (data ?? []) as JsonValue[] });
        } catch (error) {
          const message = error instanceof Error ? error.message : "compliance query failed";
          if (message === "PROJECT_SCOPE_VIOLATION") {
            writeJson(res, 403, { ok: false, error: "project_scope_violation" });
          } else {
            await emitEvent("error", "jurix.compliance_query_error", message);
            writeJson(res, 500, { ok: false, error: "compliance_query_failed" });
          }
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/jurix/compliance/create") {
        try {
          const body = await readJsonBody(req);
          const severity = String(body.severity ?? "info").trim().toLowerCase();
          if (!VALID_SEVERITIES.has(severity)) throw new Error("INVALID_SEVERITY");

          const title = String(body.title ?? "").trim().slice(0, 200);
          if (!title) throw new Error("TITLE_REQUIRED");

          const payload = {
            project_id: scopedProjectId(body.project_id),
            category: String(body.category ?? "general").trim().slice(0, 80) || "general",
            severity,
            title,
            description: String(body.description ?? "").trim().slice(0, 5000),
            evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 50) : [],
          };
          const { data, error } = await sb
            .from("compliance_events")
            .insert(payload)
            .select("*")
            .single();
          if (error) throw new Error(error.message);
          writeJson(res, 201, { ok: true, event: data as JsonValue });
        } catch (error) {
          const message = error instanceof Error ? error.message : "insert failed";
          const status = message === "PAYLOAD_TOO_LARGE"
            ? 413
            : message === "UNSUPPORTED_MEDIA_TYPE"
              ? 415
              : message === "PROJECT_SCOPE_VIOLATION"
                ? 403
                : 400;
          writeJson(res, status, {
            ok: false,
            error: message.toLowerCase(),
          });
        }
        return;
      }

      writeJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      await emitEvent(
        "error",
        "agent.http_error",
        error instanceof Error ? error.message : "http error",
      );
      if (!res.headersSent) {
        writeJson(res, 500, { ok: false, error: "internal_error" });
      } else {
        res.destroy();
      }
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  await emitEvent("info", "agent.stop", `Agente detenido por ${signal}.`).catch(() => undefined);
  await upsertNode("offline").catch(() => undefined);

  const server = healthServer;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  await ensureSandbox();
  healthServer = createHealthServer();
  await listen(healthServer);

  if (config.shellExecEnabled) {
    await emitEvent(
      "warn",
      "agent.shell_enabled",
      "shell.exec está habilitado explícitamente y no es un sandbox de sistema operativo.",
    );
  }

  heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatMs);
  await heartbeat();

  if (config.mirror.enabled) {
    await emitEvent(
      "info",
      "agent.mirror_enabled",
      `Mirror mode activo. Mirror: ${config.mirror.mirrorNodeId}, Primary: ${config.mirror.primaryNodeId}`,
    );
  }

  await loop();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});

void main().catch((error) => {
  console.error("[hocker-node-agent] startup failed");
  console.error(error);
  process.exitCode = 1;
});
