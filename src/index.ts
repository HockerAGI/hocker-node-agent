import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { Langfuse } from "langfuse-node";

import { config } from "./config.js";
import { verifyCommand } from "./lib/signature.js";
import { listDir, readFileHead, executeLocalShell, writeLocalFile } from "./lib/sandbox.js";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Controls = { kill_switch: boolean; allow_write: boolean };

type CommandRow = {
  id: string;
  project_id: string;
  node_id: string;
  created_at: string;
  status: "queued" | "needs_approval" | "running" | "done" | "error" | "canceled";
  needs_approval: boolean;
  command: string;
  payload: Record<string, unknown>;
  signature: string;
  started_at: string | null;
  executed_at: string | null;
  finished_at: string | null;
  result: unknown;
  error: string | null;
};

// ─── Clientes ─────────────────────────────────────────────────────────────────

const sb = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

const langfuse = new Langfuse({
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  baseUrl: config.langfuse.baseUrl,
});

// ─── Terminal colors ──────────────────────────────────────────────────────────

const C = {
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  dim:    "\x1b[90m",
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
} as const;

// ─── Utilidades ───────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function printBanner() {
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
` + C.reset
  );
  console.log(`${C.dim}${"─".repeat(54)}${C.reset}`);
  console.log(`${C.bold}  Node Agent — Zero-Trust Executor  v2.1${C.reset}`);
  console.log(`${C.dim}  Node ID    :${C.reset} ${C.green}${config.nodeId}${C.reset}`);
  console.log(`${C.dim}  Project ID :${C.reset} ${C.green}${config.projectId}${C.reset}`);
  console.log(`${C.dim}  Health     :${C.reset} ${C.yellow}:${config.port}/health${C.reset}`);
  console.log(`${C.dim}${"─".repeat(54)}${C.reset}\n`);
}

// ─── Servidor de salud ────────────────────────────────────────────────────────

http
  .createServer((req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
    if (req.method === "GET" && u.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ok: true,
          project_id: config.projectId,
          node_id: config.nodeId,
          orchestrator_configured: Boolean(config.orchestratorUrl),
          ts: nowIso(),
        })
      );
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "not_found" }));
  })
  .listen(config.port, "0.0.0.0");

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function emitEvent(
  level: "info" | "warn" | "error",
  type: string,
  message: string,
  data?: Record<string, unknown>
) {
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
      kill_switch: Boolean((data as Record<string, unknown>)?.kill_switch),
      allow_write: Boolean((data as Record<string, unknown>)?.allow_write),
    };
  } catch {
    return { kill_switch: false, allow_write: false };
  }
}

async function upsertNode() {
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

async function finishOk(id: string, result: unknown) {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({ status: "done", executed_at: ts, finished_at: ts, result, error: null })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function finishErr(id: string, msg: string) {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({ status: "error", executed_at: ts, finished_at: ts, result: null, error: msg })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function cancelCmd(id: string, msg: string) {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({ status: "canceled", executed_at: ts, finished_at: ts, result: null, error: msg })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

// ─── Ejecutor de comandos ─────────────────────────────────────────────────────

async function runCommand(cmd: CommandRow, controls: Controls): Promise<unknown> {
  const valid = verifyCommand(
    config.commandHmacSecret,
    cmd.id,
    cmd.project_id,
    cmd.node_id,
    cmd.command,
    cmd.payload,
    cmd.created_at,
    cmd.signature
  );

  if (!valid) throw new Error("invalid_signature");

  const payload = cmd.payload ?? {};
  const command = String(cmd.command || "").trim();

  if (!controls.allow_write && (command === "shell.exec" || command === "fs.write")) {
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
      };

    case "read_dir": {
      const relDir = String(payload.path ?? ".");
      return { ok: true, path: relDir, entries: await listDir(relDir) };
    }

    case "read_file_head": {
      const relPath = String(payload.path ?? "");
      const maxBytes = Math.min(256 * 1024, Math.max(128, Number(payload.maxBytes ?? 4096)));
      const head = await readFileHead(relPath, maxBytes);
      return { ok: true, path: relPath, bytes: head.bytes, head: head.text };
    }

    case "shell.exec": {
      const timeout = Number(payload.timeout ?? 120_000);
      return await executeLocalShell(String(payload.script ?? ""), timeout);
    }

    case "fs.write": {
      const writtenPath = await writeLocalFile(
        String(payload.path ?? ""),
        String(payload.content ?? "")
      );
      return { ok: true, writtenPath };
    }

    default:
      throw new Error(`command_not_allowed: ${command}`);
  }
}

// ─── Loop principal ───────────────────────────────────────────────────────────

async function loop() {
  printBanner();

  await emitEvent("info", "agent.boot", "Hocker Node Agent iniciado", {
    node_id: config.nodeId,
    project_id: config.projectId,
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
        await sleep(config.pollMs * 2);
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

        if (!controls2.allow_write && (cmd.command === "shell.exec" || cmd.command === "fs.write")) {
          await cancelCmd(cmd.id, "Modo solo lectura activo.");
          await emitEvent("warn", "command.blocked", `Bloqueado (modo solo lectura): ${cmd.command}`, {
            command_id: cmd.id,
          });
          continue;
        }

        const trace = langfuse.trace({
          name: "Node_Execution",
          metadata: { commandId: cmd.id, nodeId: config.nodeId, projectId: config.projectId },
        });

        await emitEvent("info", "command.started", `Iniciando: ${cmd.command}`, {
          command_id: cmd.id,
        });

        try {
          const result = await runCommand(cmd, controls2);
          await finishOk(cmd.id, result);
          await emitEvent("info", "command.done", `Completado: ${cmd.command}`, {
            command_id: cmd.id,
          });
          trace.event({ name: "Success", output: result as object });
          console.log(`${C.dim}[${ts}]${C.reset} ${C.green}✓ ÉXITO:${C.reset} ${cmd.command}`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          await finishErr(cmd.id, msg);
          await emitEvent("error", "command.error", `Error: ${cmd.command}`, {
            command_id: cmd.id,
            error: msg,
          });
          trace.event({ name: "Failed", level: "ERROR", statusMessage: msg });
          console.log(`${C.dim}[${ts}]${C.reset} ${C.red}✖ FALLO:${C.reset} ${msg}`);
        }

        await langfuse.flushAsync();
      }

      await sleep(config.pollMs);
    } catch (e: unknown) {
      console.error(C.red + "[LOOP ERROR]" + C.reset, e instanceof Error ? e.message : e);
      await sleep(config.pollMs);
    }
  }
}

loop();
