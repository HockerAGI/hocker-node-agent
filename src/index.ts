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
    return { kill_switch: false, allow_write: false };
  }
}

async function upsertNode(status: "online" | "degraded" | "offline" = "online"): Promise<void> {
  await sb.from("nodes").upsert(
    {
      id: config.nodeId,
      project_id: config.projectId,
      name: `Node: ${config.nodeId}`,
      type: "agent",
      status,
      last_seen_at: nowIso(),
      tags: ["agent", "physical"],
      meta: safeMetadata(),
      updated_at: nowIso(),
    },
    { onConflict: "id" },
  );
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
  });

  for (;;) {
    try {
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
          await emitEvent(
            "info",
            "command.done",
            `Comando ejecutado: ${command.command}`,
            { command_id: command.id },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await finishErr(command.id, message);
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
  return http.createServer((req, res) => {
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

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
}

async function main(): Promise<void> {
  createHealthServer().listen(config.port, "0.0.0.0");
  await loop();
}

void main();
