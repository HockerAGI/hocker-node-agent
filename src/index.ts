import http from "node:http";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { sb } from "./supabase.js";
import type {
  AgentCommand,
  Controls,
  DirEntryInfo,
  HealthResponse,
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
  rootDir,
  safeMetadata,
  writeLocalFile,
} from "./lib/sandbox.js";

function nowIso(): string {
  return new Date().toISOString();
}

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

async function emitEvent(
  level: "info" | "warn" | "error",
  type: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await sb.from("events").insert({
      project_id: config.projectId,
      node_id: config.nodeId,
      level,
      type,
      message,
      data: (data ?? {}) as JsonObject,
    });
  } catch {
      // no-op
  }
}

async function getControls(): Promise<Controls> {
  try {
    const { data } = await sb
      .from("system_controls")
      .select("kill_switch,allow_write")
      .eq("project_id", config.projectId)
      .eq("id", "global")
      .maybeSingle();

    return {
      kill_switch: Boolean((data as { kill_switch?: unknown } | null)?.kill_switch),
      allow_write: Boolean((data as { allow_write?: unknown } | null)?.allow_write),
    };
  } catch {
    // Fail-safe: si no se pueden leer los controles, activar kill_switch y bloquear escrituras
    return { kill_switch: true, allow_write: false };
  }
}

async function upsertNode(status: "online" | "degraded" | "offline" = "online"): Promise<void> {
  await sb.from("nodes").upsert(
    {
      id: config.nodeId,
      project_id: config.projectId,
      name: `Node: ${config.nodeId}`,
      type: config.mirror.enabled ? "mirror" : "agent",
      status,
      last_seen_at: nowIso(),
      tags: config.mirror.enabled ? ["agent", "physical", "mirror"] : ["agent", "physical"],
      meta: {
        ...safeMetadata(),
        mirror: config.mirror.enabled,
        primary_node_id: config.mirror.enabled ? config.mirror.primaryNodeId : undefined,
      },
      updated_at: nowIso(),
    },
    { onConflict: "id" },
  );

  // If mirror mode is enabled, also register the mirror node
  if (config.mirror.enabled && config.mirror.mirrorNodeId) {
    await sb.from("nodes").upsert(
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
  }
}

// Track heartbeat stats for real-time monitoring
let heartbeatStats = {
  totalHeartbeats: 0,
  lastHeartbeatAt: "",
  lastPollAt: "",
  commandsExecuted: 0,
  commandsFailed: 0,
  uptimeStart: Date.now(),
};

async function heartbeat(): Promise<void> {
  heartbeatStats.totalHeartbeats++;
  heartbeatStats.lastHeartbeatAt = nowIso();

  try {
    const controls = await getControls();
    const status: "online" | "degraded" | "offline" = controls.kill_switch ? "degraded" : "online";

    await upsertNode(status);

    // Emit heartbeat event (debug level, low volume)
    if (heartbeatStats.totalHeartbeats % 4 === 0) {
      // Only every 4th heartbeat to reduce event volume
      await emitEvent("info", "agent.heartbeat", "Heartbeat", {
        total_heartbeats: heartbeatStats.totalHeartbeats,
        commands_executed: heartbeatStats.commandsExecuted,
        commands_failed: heartbeatStats.commandsFailed,
        uptime_seconds: Math.floor((Date.now() - heartbeatStats.uptimeStart) / 1000),
        kill_switch: controls.kill_switch,
        allow_write: controls.allow_write,
        mirror_enabled: config.mirror.enabled,
      });
    }
  } catch (error) {
    // Heartbeat failure is non-fatal — the poll loop will retry
    await emitEvent("warn", "agent.heartbeat_error", error instanceof Error ? error.message : "heartbeat error");
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

async function markRunning(id: string): Promise<boolean> {
  const { data, error } = await sb
    .from("commands")
    .update({ status: "running", started_at: nowIso() })
    .eq("id", id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();

  if (error) return false;
  return Boolean(data);
}

async function finishDone(id: string, result: JsonObject): Promise<void> {
  await sb
    .from("commands")
    .update({
      status: "done",
      result,
      executed_at: nowIso(),
      finished_at: nowIso(),
      error: null,
    })
    .eq("id", id);
}

async function finishErr(id: string, errorMessage: string): Promise<void> {
  await sb
    .from("commands")
    .update({
      status: "error",
      error: errorMessage,
      finished_at: nowIso(),
    })
    .eq("id", id);
}

async function executeCommand(command: AgentCommand, controls: Controls): Promise<JsonObject> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;

  if (isCloudOnlyCommand(command.command)) {
    await emitEvent(
      "error",
      "command.cloud_only_rejected",
      `Agente local rechazó comando cloud-only: ${command.command}`,
      { command_id: command.id, command: command.command, node_id: command.node_id },
    );
    throw new Error(`Comando cloud-only no soportado por hocker-node-agent: ${command.command}`);
  }

  if (!isLocalSupportedCommand(command.command)) {
    await emitEvent(
      "error",
      "command.unsupported_local_command",
      `Agente local rechazó comando no soportado: ${command.command}`,
      { command_id: command.id, command: command.command, node_id: command.node_id },
    );
    throw new Error(`Comando no soportado por hocker-node-agent: ${command.command}`);
  }

  switch (command.command) {
    case "ping":
      return {
        ok: true,
        pong: true,
        node_id: config.nodeId,
        ts: nowIso(),
      };

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
        ok: true,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
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

      const file = await writeLocalFile(
        String(payload.path ?? ""),
        String(payload.content ?? ""),
      );

      return {
        ok: true,
        path: file,
      };
    }

    default:
      throw new Error(`Comando no soportado por el agente: ${command.command}`);
  }
}

async function loop(): Promise<void> {
  await ensureSandbox();
  await emitEvent("info", "agent.start", "Agente inicializado.", {
    sandbox_root: rootDir(),
    command_policy: supportedLocalCommandsSummary(),
  });

  await emitEvent("info", "command.local_policy_loaded", "Política local del agente cargada.", {
    command_policy: supportedLocalCommandsSummary(),
  });

  for (;;) {
    try {
      heartbeatStats.lastPollAt = nowIso();
      const controls = await getControls();
      await upsertNode(controls.kill_switch ? "degraded" : "online");

      if (controls.kill_switch) {
        await emitEvent("warn", "agent.paused", "Kill switch activo. Loop en pausa.");
        await new Promise((resolve) => setTimeout(resolve, config.pollMs));
        continue;
      }

      const queued = await fetchQueued();

      for (const command of queued) {
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
          await finishErr(command.id, "Firma inválida o expirada.");
          await emitEvent(
            "error",
            "command.invalid_signature",
            "Comando rechazado por firma inválida.",
            { command_id: command.id },
          );
          continue;
        }

        const locked = await markRunning(command.id);
        if (!locked) continue;

        try {
          const result = await executeCommand(command, controls);
          await finishDone(command.id, result);
          heartbeatStats.commandsExecuted++;
          await emitEvent(
            "info",
            "command.done",
            `Comando ejecutado: ${command.command}`,
            { command_id: command.id },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await finishErr(command.id, message);
          heartbeatStats.commandsFailed++;
          await emitEvent(
            "error",
            "command.error",
            `Error ejecutando ${command.command}`,
            { command_id: command.id, error: message },
          );
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

    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

function createHealthServer(): http.Server {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);

    if (req.method === "GET" && u.pathname === "/health") {
      const body: HealthResponse = {
        ok: true,
        project_id: config.projectId,
        node_id: config.nodeId,
        orchestrator_configured: Boolean(config.orchestratorUrl),
        sandbox_enabled: config.sandbox.enabled,
        sandbox_root: rootDir(),
        ts: nowIso(),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "GET" && u.pathname === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: nowIso() }));
      return;
    }

    // ── Real-time stats endpoint for Hocker ONE monitoring (requires auth) ──
    if (req.method === "GET" && u.pathname === "/stats") {
      if (config.agentKey && req.headers["x-hocker-agent-key"] !== config.agentKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const uptimeSeconds = Math.floor((Date.now() - heartbeatStats.uptimeStart) / 1000);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        node_id: config.nodeId,
        project_id: config.projectId,
        mirror_enabled: config.mirror.enabled,
        mirror_node_id: config.mirror.mirrorNodeId || null,
        primary_node_id: config.mirror.primaryNodeId || null,
        heartbeat: {
          total: heartbeatStats.totalHeartbeats,
          last_at: heartbeatStats.lastHeartbeatAt,
          interval_ms: config.heartbeatMs,
        },
        commands: {
          executed: heartbeatStats.commandsExecuted,
          failed: heartbeatStats.commandsFailed,
        },
        uptime_seconds: uptimeSeconds,
        poll_ms: config.pollMs,
        ts: nowIso(),
      }));
      return;
    }

    // ── Jurix audit endpoints (migrated from Fastify routes) ──
    if (req.method === "GET" && u.pathname === "/v1/jurix/audit/logs") {
      const project_id = String(u.searchParams.get("project_id") ?? config.projectId)
        .trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 64) || config.projectId;

      try {
        const { data, error } = await sb
          .from("audit_logs")
          .select("*")
          .eq("project_id", project_id)
          .order("created_at", { ascending: false })
          .limit(200);

        if (error) throw new Error(error.message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, logs: data ?? [] }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "audit_logs query failed" }));
      }
      return;
    }

    if (req.method === "GET" && u.pathname === "/v1/jurix/compliance") {
      const project_id = String(u.searchParams.get("project_id") ?? config.projectId)
        .trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 64) || config.projectId;

      try {
        const { data, error } = await sb
          .from("compliance_events")
          .select("*")
          .eq("project_id", project_id)
          .order("created_at", { ascending: false });

        if (error) throw new Error(error.message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, events: data ?? [] }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "compliance_events query failed" }));
      }
      return;
    }

    // POST /v1/jurix/compliance/create — create a compliance event (migrated from Fastify route)
    if (req.method === "POST" && u.pathname === "/v1/jurix/compliance/create") {
      if (config.agentKey && req.headers["x-hocker-agent-key"] !== config.agentKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

        const projectIdRaw = String(body.project_id ?? config.projectId);
        const project_id = projectIdRaw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 64) || config.projectId;

        const payload = {
          project_id,
          category: String(body.category ?? "general").trim(),
          severity: String(body.severity ?? "info").trim(),
          title: String(body.title ?? "Compliance event").trim(),
          description: String(body.description ?? "").trim(),
          evidence: Array.isArray(body.evidence) ? body.evidence : [],
        };

        const { data, error } = await sb.from("compliance_events").insert(payload).select("*").single();

        if (error) throw new Error(error.message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, event: data }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "compliance_events insert failed" }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
}

async function main(): Promise<void> {
  createHealthServer().listen(config.port, "0.0.0.0");

  // Start heartbeat interval — runs independently of the poll loop
  // This ensures the node reports presence even during long command execution
  setInterval(() => void heartbeat(), config.heartbeatMs);

  // Initial heartbeat before entering the poll loop
  await heartbeat();

  // If mirror mode is enabled, log it
  if (config.mirror.enabled) {
    await emitEvent("info", "agent.mirror_enabled", `Mirror mode activo. Mirror: ${config.mirror.mirrorNodeId}, Primary: ${config.mirror.primaryNodeId}`);
  }

  await loop();
}

void main();
