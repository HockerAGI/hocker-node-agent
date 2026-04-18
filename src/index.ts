import http from "node:http";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { config } from "./config.js";
import { sb } from "./supabase.js";
import type {
  AgentCommand,
  CommandStatus,
  Controls,
  HealthResponse,
  JsonObject,
} from "./types.js";
import { verifyCommand } from "./lib/signature.js";
import {
  ensureSandbox,
  executeLocalShell,
  listDir,
  readFileHead,
  safeMetadata,
  writeLocalFile,
} from "./lib/sandbox.js";

type CommandRow = AgentCommand & {
  status: CommandStatus;
  needs_approval: boolean;
  started_at: string | null;
  executed_at: string | null;
  finished_at: string | null;
  result: unknown;
  error: string | null;
};

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function printBanner(): void {
  console.clear();
  console.log(
    C.cyan + C.bold +
      `
  ██╗  ██╗ ██████╗  ██████╗██╗  ██╗███████╗██████╗ 
  ██║  ██║██╔═══██╗██╔════╝██║ ██╔╝██╔════╝██╔══██╗
  ███████║██║   ██║██║     █████╔╝ █████╗  ██████╔╝
  ██╔══██║██║   ██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗
  ██║  ██║╚██████╔╝╚██████╗██║  ██╗███████╗██║  ██║
  ╚═╝  ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
` +
      C.reset
  );
  console.log(`${C.dim}${"─".repeat(54)}${C.reset}`);
  console.log(`${C.bold}  Node Agent — Zero-Trust Executor  v2.1${C.reset}`);
  console.log(`${C.dim}  Node ID    :${C.reset} ${C.green}${config.nodeId}${C.reset}`);
  console.log(`${C.dim}  Project ID :${C.reset} ${C.green}${config.projectId}${C.reset}`);
  console.log(`${C.dim}  Health     :${C.reset} ${C.yellow}GET /health${C.reset}`);
  console.log(`${C.dim}  Ready      :${C.reset} ${C.yellow}GET /ready${C.reset}`);
  console.log(`${C.dim}${"─".repeat(54)}${C.reset}\n`);
}

async function emitEvent(
  level: "info" | "warn" | "error",
  type: string,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const metadata = data ?? {};

  try {
    await sb.from("events").insert({
      project_id: config.projectId,
      node_id: config.nodeId,
      level,
      type,
      message,
      data: metadata,
    });
  } catch {}

  try {
    await sb.from("agent_logs").insert({
      project_id: config.projectId,
      node_id: config.nodeId,
      agent_name: "hocker-node-agent",
      level,
      message,
      metadata: { type, ...metadata },
    });
  } catch {}
}

async function getControls(): Promise<Controls> {
  try {
    const { data } = await sb
      .from("system_controls")
      .select("kill_switch, allow_write")
      .eq("project_id", config.projectId)
      .eq("id", "global")
      .maybeSingle();

    return {
      kill_switch: Boolean((data as Record<string, unknown> | null)?.kill_switch),
      allow_write: Boolean((data as Record<string, unknown> | null)?.allow_write),
    };
  } catch {
    return { kill_switch: false, allow_write: false };
  }
}

async function upsertNode(): Promise<void> {
  await sb.from("nodes").upsert(
    {
      id: config.nodeId,
      project_id: config.projectId,
      name: `Node: ${config.nodeId}`,
      type: "agent",
      status: "online",
      last_seen_at: nowIso(),
      tags: ["physical", "on-premise"],
      meta: {
        runtime: "node",
        version: process.version,
        platform: process.platform,
      },
    },
    { onConflict: "id" }
  );
}

async function fetchQueued(): Promise<Pick<CommandRow, "id">[]> {
  const { data } = await sb
    .from("commands")
    .select("id")
    .eq("project_id", config.projectId)
    .eq("node_id", config.nodeId)
    .eq("status", "queued")
    .eq("needs_approval", false)
    .order("created_at", { ascending: true })
    .limit(5);

  return (data as Pick<CommandRow, "id">[]) ?? [];
}

async function claimQueued(cmd: Pick<CommandRow, "id">): Promise<CommandRow | null> {
  const { data } = await sb
    .from("commands")
    .update({ status: "running", started_at: nowIso() })
    .eq("project_id", config.projectId)
    .eq("id", cmd.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();

  return (data as CommandRow) ?? null;
}

async function finishOk(id: string, result: unknown): Promise<void> {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({ status: "done", executed_at: ts, finished_at: ts, result, error: null })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function finishErr(id: string, msg: string): Promise<void> {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({ status: "error", executed_at: ts, finished_at: ts, result: null, error: msg })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function cancelCmd(id: string, msg: string): Promise<void> {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({ status: "canceled", executed_at: ts, finished_at: ts, result: null, error: msg })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

function wantWrite(command: string): boolean {
  return command === "shell.exec" || command === "fs.write";
}

async function runCommand(cmd: CommandRow, controls: Controls): Promise<unknown> {
  const payload: JsonObject = safeMetadata(cmd.payload);
  const command = String(cmd.command || "").trim();

  const valid = verifyCommand(
    config.hmacSecret,
    cmd.id,
    cmd.project_id,
    cmd.node_id,
    command,
    payload,
    cmd.created_at,
    cmd.signature,
    config.maxCommandAgeMs
  );

  if (!valid) {
    throw new Error("invalid_signature");
  }

  if (!config.sandboxEnabled && wantWrite(command)) {
    throw new Error("sandbox_disabled");
  }

  if (!controls.allow_write && wantWrite(command)) {
    throw new Error("write_disabled");
  }

  switch (command) {
    case "ping":
      return { ok: true, pong: true, now: nowIso() };

    case "status":
      return {
        ok: true,
        node_id: config.nodeId,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sandbox_enabled: config.sandboxEnabled,
      };

    case "read_dir": {
      const relDir = String(payload.path ?? ".");
      return { ok: true, path: relDir, entries: await listDir(config.sandboxRoot, relDir) };
    }

    case "read_file_head": {
      const relPath = String(payload.path ?? "");
      const maxBytes = Math.min(256 * 1024, Math.max(128, Number(payload.maxBytes ?? 4096)));
      const head = await readFileHead(config.sandboxRoot, relPath, maxBytes);
      return { ok: true, path: relPath, bytes: head.bytes, head: head.text };
    }

    case "shell.exec": {
      const timeout = Number(payload.timeout ?? 120_000);
      return await executeLocalShell(config.sandboxRoot, String(payload.script ?? ""), timeout);
    }

    case "fs.write": {
      const writtenPath = await writeLocalFile(
        config.sandboxRoot,
        String(payload.path ?? ""),
        String(payload.content ?? "")
      );
      return { ok: true, writtenPath };
    }

    default:
      throw new Error(`command_not_allowed: ${command}`);
  }
}

async function loop(): Promise<void> {
  await ensureSandbox(config.sandboxRoot);
  printBanner();

  await emitEvent("info", "agent.boot", "Hocker Node Agent iniciado", {
    node_id: config.nodeId,
    project_id: config.projectId,
    sandbox_root: config.sandboxRoot,
  });

  let lastHeartbeatAt = 0;

  while (true) {
    try {
      await upsertNode();

      const now = Date.now();
      if (now - lastHeartbeatAt >= 60_000) {
        lastHeartbeatAt = now;
        await emitEvent("info", "node.heartbeat", "Heartbeat", {
          node_id: config.nodeId,
          uptime: process.uptime(),
        });
      }

      const controls = await getControls();

      if (controls.kill_switch) {
        console.log(
          `${C.dim}[${new Date().toLocaleTimeString()}]${C.reset} ${C.red}Kill-switch activo. Agente en pausa.${C.reset}`
        );
        await new Promise((resolve) => setTimeout(resolve, config.pollMs * 2));
        continue;
      }

      const queued = await fetchQueued();

      for (const raw of queued) {
        const cmd = await claimQueued(raw);
        if (!cmd) continue;

        const ts = new Date().toLocaleTimeString();
        console.log(
          `${C.dim}[${ts}]${C.reset} ${C.yellow}⚡ EJECUTANDO:${C.reset} ${cmd.command} ${C.dim}(${cmd.id.split("-")[0]})${C.reset}`
        );

        const controls2 = await getControls();

        if (controls2.kill_switch) {
          await cancelCmd(cmd.id, "Kill-switch activado durante ejecución.");
          await emitEvent("warn", "command.canceled", `Cancelado por kill-switch: ${cmd.command}`, {
            command_id: cmd.id,
          });
          continue;
        }

        if (!config.sandboxEnabled && wantWrite(cmd.command)) {
          await cancelCmd(cmd.id, "Sandbox deshabilitado.");
          await emitEvent("warn", "command.blocked", `Bloqueado (sandbox deshabilitado): ${cmd.command}`, {
            command_id: cmd.id,
          });
          continue;
        }

        if (!controls2.allow_write && wantWrite(cmd.command)) {
          await cancelCmd(cmd.id, "Modo solo lectura activo.");
          await emitEvent("warn", "command.blocked", `Bloqueado (modo solo lectura): ${cmd.command}`, {
            command_id: cmd.id,
          });
          continue;
        }

        await emitEvent("info", "command.started", `Iniciando: ${cmd.command}`, {
          command_id: cmd.id,
        });

        try {
          const result = await runCommand(cmd, controls2);
          await finishOk(cmd.id, result);
          await emitEvent("info", "command.done", `Completado: ${cmd.command}`, {
            command_id: cmd.id,
          });
          console.log(`${C.dim}[${ts}]${C.reset} ${C.green}✓ ÉXITO:${C.reset} ${cmd.command}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await finishErr(cmd.id, msg);
          await emitEvent("error", "command.error", `Error: ${cmd.command}`, {
            command_id: cmd.id,
            error: msg,
          });
          console.log(`${C.dim}[${ts}]${C.reset} ${C.red}✖ FALLO:${C.reset} ${msg}`);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    } catch (error) {
      console.error(C.red + "[LOOP ERROR]" + C.reset, error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
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
        sandbox_enabled: config.sandboxEnabled,
        ts: nowIso(),
      };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(body));
    }

    if (req.method === "GET" && u.pathname === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ok: true,
          project_id: config.projectId,
          node_id: config.nodeId,
          supabase_ready: true,
          sandbox_root: config.sandboxRoot,
          ts: nowIso(),
        })
      );
    }

    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
}

async function main(): Promise<void> {
  createHealthServer().listen(config.port, "0.0.0.0");
  await loop();
}

void main();