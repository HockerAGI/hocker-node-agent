import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { Langfuse } from "langfuse-node";

import { config } from "./config.js";
import { verifyCommand } from "./lib/signature.js";
import { listDir, readFileHead, executeLocalShell, writeLocalFile } from "./lib/sandbox.js";

type Controls = { kill_switch: boolean; allow_write: boolean };

type CommandRow = {
  id: string;
  project_id: string;
  node_id: string;
  created_at: string;
  status: "queued" | "needs_approval" | "running" | "done" | "error" | "canceled";
  needs_approval: boolean;
  command: string;
  payload: any;
  signature: string;
  started_at: string | null;
  executed_at: string | null;
  finished_at: string | null;
  result: any;
  error: string | null;
};

const sb = createClient(config.supabase.url, config.supabase.serviceRoleKey, { auth: { persistSession: false } });

const langfuse = new Langfuse({
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  baseUrl: config.langfuse.baseUrl,
});

// UI de Terminal Pro
const C = { cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[90m", reset: "\x1b[0m", bold: "\x1b[1m" };

function printBanner() {
  console.clear();
  console.log(C.cyan + C.bold + `
  ██╗  ██╗███████╗ ██████╗██╗  ██╗███████╗██████╗ 
  ██║  ██║██╔════╝██╔════╝██║ ██╔╝██╔════╝██╔══██╗
  ███████║█████╗  ██║     █████╔╝ █████╗  ██████╔╝
  ██╔══██║██╔══╝  ██║     ██╔═██╗ ██╔══╝  ██╔══██╗
  ██║  ██║███████╗╚██████╗██║  ██╗███████╗██║  ██║
  ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ` + C.reset);
  console.log(`${C.dim}======================================================${C.reset}`);
  console.log(`${C.bold} NODO AGENTE FÍSICO (Zero-Trust) v2.0 - ONLINE${C.reset}`);
  console.log(`${C.dim} Node ID    :${C.reset} ${C.green}${config.nodeId}${C.reset}`);
  console.log(`${C.dim} Project ID :${C.reset} ${C.green}${config.projectId}${C.reset}`);
  console.log(`${C.dim} Server Port:${C.reset} ${C.yellow}${config.port} (Health Checks Only)${C.reset}`);
  console.log(`${C.dim}======================================================${C.reset}\n`);
}

// 1. SERVIDOR HTTP ORIGINAL (Vital para Google Cloud Run)
http.createServer((req, res) => {
  const u = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
  if (req.method === "GET" && u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, project_id: config.projectId, node_id: config.nodeId, ts: nowIso() }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  return res.end(JSON.stringify({ ok: false, error: "not_found" }));
}).listen(config.port, "0.0.0.0");

function nowIso() { return new Date().toISOString(); }
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

// Funciones de control y emisión originales
async function emitEvent(level: "info" | "warn" | "error", type: string, message: string, data?: any) {
  try {
    await sb.from("events").insert({
      project_id: config.projectId, node_id: config.nodeId, level, type, message, data: data ?? null
    });
  } catch {}
}

async function getControls(): Promise<Controls> {
  const { data } = await sb.from("system_controls").select("kill_switch, allow_write").eq("project_id", config.projectId).eq("id", "global").maybeSingle();
  return { kill_switch: Boolean((data as any)?.kill_switch), allow_write: Boolean((data as any)?.allow_write) };
}

async function upsertNode() {
  await sb.from("nodes").upsert({
    id: config.nodeId, project_id: config.projectId, name: `Physical Node: ${config.nodeId}`,
    type: "agent", status: "online", last_seen_at: nowIso(), tags: ["physical", "on-premise"],
    meta: { runtime: "node", version: process.version, platform: process.platform }
  }, { onConflict: "id" });
}

// Bloqueo atómico original de tareas
async function fetchQueued(): Promise<Pick<CommandRow, "id">[]> {
  const { data } = await sb.from("commands").select("id").eq("project_id", config.projectId).eq("node_id", config.nodeId).eq("status", "queued").eq("needs_approval", false).order("created_at", { ascending: true }).limit(5);
  return (data as any) || [];
}

async function claimQueued(cmd: Pick<CommandRow, "id">): Promise<CommandRow | null> {
  const started_at = nowIso();
  const { data } = await sb.from("commands").update({ status: "running", started_at, executed_at: started_at }).eq("project_id", config.projectId).eq("id", cmd.id).eq("status", "queued").select("*").maybeSingle();
  return (data as any) || null;
}

async function finishOk(id: string, result: any) {
  await sb.from("commands").update({ status: "done", finished_at: nowIso(), result, error: null }).eq("project_id", config.projectId).eq("id", id);
}

async function finishErr(id: string, msg: string) {
  await sb.from("commands").update({ status: "error", finished_at: nowIso(), result: null, error: msg }).eq("project_id", config.projectId).eq("id", id);
}

async function cancel(id: string, msg: string) {
  await sb.from("commands").update({ status: "canceled", finished_at: nowIso(), result: null, error: msg }).eq("project_id", config.projectId).eq("id", id);
}

// MOTOR DE EJECUCIÓN FUSIONADO
async function runCommand(cmd: CommandRow) {
  if (!verifyCommand(config.commandHmacSecret, cmd.id, cmd.project_id, cmd.node_id, cmd.command, cmd.payload, cmd.created_at, cmd.signature)) {
    throw new Error("invalid_signature");
  }

  const payload = cmd.payload ?? {};

  switch (cmd.command) {
    case "ping":
      return { ok: true, pong: true, now: nowIso() };
    case "status":
      return { ok: true, node_id: config.nodeId, uptime: process.uptime(), memory: process.memoryUsage() };
    case "read_dir":
      const relDir = String(payload.path || ".");
      return { ok: true, path: relDir, entries: await listDir(relDir) };
    case "read_file_head":
      const relPath = String(payload.path || "");
      const maxBytes = Math.min(256 * 1024, Math.max(128, Number(payload.maxBytes || 4096)));
      const head = await readFileHead(relPath, maxBytes);
      return { ok: true, path: relPath, bytes: head.bytes, head: head.text };
    case "shell.exec":
      const timeout = payload.timeout || 120000;
      return await executeLocalShell(payload.script, timeout);
    case "fs.write":
      const writtenPath = await writeLocalFile(payload.path, payload.content);
      return { ok: true, writtenPath };
    default:
      throw new Error(`command_not_allowed: ${cmd.command}`);
  }
}

// LOOP PRINCIPAL
async function loop() {
  printBanner();
  await emitEvent("info", "agent.boot", "Agent started (Hocker Fabric Ready)", { node_id: config.nodeId });

  while (true) {
    try {
      await upsertNode();
      const controls = await getControls();
      
      if (controls.kill_switch) {
        console.log(`${C.dim}[${new Date().toLocaleTimeString()}]${C.reset} ${C.red}Kill-switch activo. Agente en pausa.${C.reset}`);
        await sleep(config.pollMs * 2);
        continue;
      }

      const queued = await fetchQueued();
      for (const raw of queued) {
        const cmd = await claimQueued(raw);
        if (!cmd) continue;

        const timestamp = new Date().toLocaleTimeString();
        console.log(`${C.dim}[${timestamp}]${C.reset} ${C.yellow}⚡ EJECUTANDO:${C.reset} ${cmd.command} ${C.dim}(${cmd.id.split('-')[0]})${C.reset}`);

        const controls2 = await getControls();
        if (controls2.kill_switch) {
          await cancel(cmd.id, "Kill switch activado durante intercepción.");
          continue;
        }

        const trace = langfuse.trace({ name: "Node_Execution", metadata: { commandId: cmd.id } });
        await emitEvent("info", "command.started", `Running: ${cmd.command}`, { command_id: cmd.id });

        try {
          const result = await runCommand(cmd);
          await finishOk(cmd.id, result);
          await emitEvent("info", "command.done", `Done: ${cmd.command}`, { command_id: cmd.id });
          trace.event({ name: "Success", output: result });
          console.log(`${C.dim}[${timestamp}]${C.reset} ${C.green}✓ ÉXITO:${C.reset} Tarea completada.`);
        } catch (e: any) {
          const msg = String(e?.message || e);
          await finishErr(cmd.id, msg);
          await emitEvent("error", "command.error", `Error: ${cmd.command}`, { command_id: cmd.id, error: msg });
          trace.event({ name: "Failed", level: "ERROR", statusMessage: msg });
          console.log(`${C.dim}[${timestamp}]${C.reset} ${C.red}✖ FALLO:${C.reset} ${msg}`);
        }
        await langfuse.flushAsync();
      }
      await sleep(config.pollMs);
    } catch (e: any) {
      console.error(C.red + "[LOOP ERROR]" + C.reset, e.message);
      await sleep(config.pollMs);
    }
  }
}

loop();