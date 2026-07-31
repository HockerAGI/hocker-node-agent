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
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
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
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 64) || config.projectId
  );
}

async function emitEvent(
  level: "info" | "warn" | "error",
  type: string,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    await sb.from("events").insert({
      project_id: config.projectId,
      node_id: config.nodeId,
      level,
      type,
      message,
      data: data as JsonObject,
    });
  } catch {
    // Telemetry must never stop command processing.
  }
}

async function getControls(): Promise<Controls> {
  try {
    const { data, error } = await sb
      .from("system_controls")
      .select("kill_switch,allow_write")
      .eq("project_id", config.projectId)
      .eq("id", "global")
      .maybeSingle();

    if (error || !data) throw new Error(error?.message || "CONTROLS_NOT_FOUND");
    return {
      kill_switch: Boolean((data as { kill_switch?: unknown }).kill_switch),
      allow_write: Boolean((data as { allow_write?: unknown }).allow_write),
    };
  } catch {
    return { kill_switch: true, allow_write: false };
  }
}

async function upsertNode(
  status: "online" | "degraded" | "offline" = "online",
): Promise<void> {
  await sb.from("nodes").upsert(
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

const stats = {
  totalHeartbeats: 0,
  lastHeartbeatAt: "",
  lastPollAt: "",
  commandsExecuted: 0,
  commandsFailed: 0,
  uptimeStart: Date.now(),
};

async function heartbeat(): Promise<void> {
  stats.totalHeartbeats += 1;
  stats.lastHeartbeatAt = nowIso();

  try {
    const controls = await getControls();
    await upsertNode(controls.kill_switch ? "degraded" : "online");
    if (stats.totalHeartbeats % 4 === 0) {
      await emitEvent("info", "agent.heartbeat", "Heartbeat", {
        total_heartbeats: stats.totalHeartbeats,
        commands_executed: stats.commandsExecuted,
        commands_failed: stats.commandsFailed,
        uptime_seconds: Math.floor((Date.now() - stats.uptimeStart) / 1000),
        kill_switch: controls.kill_switch,
        allow_write: controls.allow_write,
      });
    }
  } catch (error) {
    await emitEvent(
      "warn",
      "agent.heartbeat_error",
      error instanceof Error ? error.message : "heartbeat error",
    );
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
  return !error && Boolean(data);
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

async function finishErr(id: string, error: string): Promise<void> {
  await sb
    .from("commands")
    .update({ status: "error", error, finished_at: nowIso() })
    .eq("id", id);
}

async function executeCommand(
  command: AgentCommand,
  controls: Controls,
): Promise<JsonObject> {
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

async function loop(): Promise<void> {
  await ensureSandbox();
  await emitEvent("info", "agent.start", "Agente inicializado.", {
    command_policy: supportedLocalCommandsSummary(),
    shell_exec_enabled: config.shellExecEnabled,
  });

  for (;;) {
    try {
      stats.lastPollAt = nowIso();
      const controls = await getControls();
      await upsertNode(controls.kill_switch ? "degraded" : "online");

      if (controls.kill_switch) {
        await new Promise((resolve) => setTimeout(resolve, config.pollMs));
        continue;
      }

      for (const command of await fetchQueued()) {
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
          continue;
        }
        if (!(await markRunning(command.id))) continue;

        try {
          const result = await executeCommand(command, controls);
          await finishDone(command.id, result);
          stats.commandsExecuted += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await finishErr(command.id, message);
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

    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

function createHealthServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, {
        ok: true,
        project_id: config.projectId,
        node_id: config.nodeId,
        orchestrator_configured: Boolean(config.orchestratorUrl),
        sandbox_enabled: config.sandbox.enabled,
        ts: nowIso(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      writeJson(res, 200, { ok: true, ts: nowIso() });
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
        const projectId = normalizeProjectId(url.searchParams.get("project_id"));
        const { data, error } = await sb
          .from("audit_logs")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(200);
        if (error) throw new Error(error.message);
        writeJson(res, 200, { ok: true, logs: (data ?? []) as JsonValue[] });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : "audit query failed",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/jurix/compliance") {
      try {
        const projectId = normalizeProjectId(url.searchParams.get("project_id"));
        const { data, error } = await sb
          .from("compliance_events")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false });
        if (error) throw new Error(error.message);
        writeJson(res, 200, { ok: true, events: (data ?? []) as JsonValue[] });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : "compliance query failed",
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/jurix/compliance/create") {
      try {
        const body = await readJsonBody(req);
        const payload = {
          project_id: normalizeProjectId(body.project_id),
          category: String(body.category ?? "general").trim().slice(0, 80),
          severity: String(body.severity ?? "info").trim().slice(0, 32),
          title: String(body.title ?? "Compliance event").trim().slice(0, 200),
          description: String(body.description ?? "").trim().slice(0, 5000),
          evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 50) : [],
        };
        const { data, error } = await sb
          .from("compliance_events")
          .insert(payload)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        writeJson(res, 200, { ok: true, event: data as JsonValue });
      } catch (error) {
        const message = error instanceof Error ? error.message : "insert failed";
        writeJson(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    writeJson(res, 404, { ok: false, error: "not_found" });
  });
}

async function main(): Promise<void> {
  await ensureSandbox();
  createHealthServer().listen(config.port, config.host);

  if (config.shellExecEnabled) {
    await emitEvent(
      "warn",
      "agent.shell_enabled",
      "shell.exec está habilitado explícitamente y no es un sandbox de sistema operativo.",
    );
  }

  setInterval(() => void heartbeat(), config.heartbeatMs);
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

void main();
