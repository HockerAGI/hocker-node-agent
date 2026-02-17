import "dotenv/config";

import http from "node:http";

import { createClient } from "@supabase/supabase-js";
import { verifyCommand } from "./lib/signature.js";
import { listDir, readFileHead, safeSandboxPath } from "./lib/sandbox.js";

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

const PROJECT_ID = (process.env.PROJECT_ID ?? "global").trim();
const NODE_ID = (process.env.NODE_ID ?? "hocker-node-1").trim();

const POLL_MS = Math.max(500, Number(process.env.POLL_MS || 2000));

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

const COMMAND_HMAC_SECRET = (process.env.COMMAND_HMAC_SECRET ?? "").trim();

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!COMMAND_HMAC_SECRET) throw new Error("Missing COMMAND_HMAC_SECRET");

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Cloud Run / Fly / Render suelen exigir que el contenedor abra un puerto.
// Este server SOLO expone /health (sin comandos remotos).
const PORT = Number(process.env.PORT || 8080);
http
  .createServer((req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && u.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, project_id: PROJECT_ID, node_id: NODE_ID, ts: nowIso() }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "not_found" }));
  })
  .listen(PORT, "0.0.0.0");

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function emitEvent(level: "info" | "warn" | "error", type: string, message: string, data?: any) {
  try {
    await sb.from("events").insert({
      id: crypto.randomUUID(),
      project_id: PROJECT_ID,
      node_id: NODE_ID,
      level,
      type,
      message,
      data: data ?? null
    });
  } catch {
    // best-effort
  }
}

async function getControls(): Promise<Controls> {
  const { data, error } = await sb
    .from("system_controls")
    .select("kill_switch, allow_write")
    .eq("project_id", PROJECT_ID)
    .eq("id", "global")
    .maybeSingle();

  if (error) return { kill_switch: false, allow_write: false };
  return { kill_switch: Boolean((data as any)?.kill_switch), allow_write: Boolean((data as any)?.allow_write) };
}

async function upsertNode() {
  const { error } = await sb.from("nodes").upsert(
    {
      id: NODE_ID,
      project_id: PROJECT_ID,
      name: NODE_ID,
      type: "agent",
      status: "online",
      last_seen_at: nowIso(),
      meta: {
        runtime: "node",
        version: process.version,
        platform: process.platform,
        arch: process.arch
      }
    },
    { onConflict: "id" }
  );

  if (error) throw new Error(error.message);
}

async function fetchQueued(): Promise<Pick<CommandRow, "id">[]> {
  const { data, error } = await sb
    .from("commands")
    .select("id")
    .eq("project_id", PROJECT_ID)
    .eq("node_id", NODE_ID)
    .eq("status", "queued")
    .eq("needs_approval", false)
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) throw new Error(error.message);
  return (data as any) || [];
}

async function claimQueued(cmd: Pick<CommandRow, "id">): Promise<CommandRow | null> {
  const started_at = nowIso();

  const { data, error } = await sb
    .from("commands")
    .update({ status: "running", started_at, executed_at: started_at })
    .eq("project_id", PROJECT_ID)
    .eq("id", cmd.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();

  if (error) return null;
  return (data as any) || null;
}

async function finishOk(id: string, result: any) {
  const finished_at = nowIso();
  const { error } = await sb
    .from("commands")
    .update({ status: "done", finished_at, result, error: null })
    .eq("project_id", PROJECT_ID)
    .eq("id", id);

  if (error) throw new Error(error.message);
}

async function finishErr(id: string, msg: string) {
  const finished_at = nowIso();
  const { error } = await sb
    .from("commands")
    .update({ status: "error", finished_at, result: null, error: msg })
    .eq("project_id", PROJECT_ID)
    .eq("id", id);

  if (error) throw new Error(error.message);
}

async function cancel(id: string, msg: string) {
  const finished_at = nowIso();
  const { error } = await sb
    .from("commands")
    .update({ status: "canceled", finished_at, result: null, error: msg })
    .eq("project_id", PROJECT_ID)
    .eq("id", id);

  if (error) throw new Error(error.message);
}

async function runCommand(cmd: CommandRow) {
  if (!verifyCommand(cmd, COMMAND_HMAC_SECRET)) throw new Error("invalid_signature");

  const payload = cmd.payload ?? {};

  switch (cmd.command) {
    case "ping":
      return { ok: true, pong: true, now: nowIso() };

    case "status":
      return {
        ok: true,
        node_id: NODE_ID,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      };

    case "read_dir": {
      const rel = String(payload.path || ".");
      const resolved = safeSandboxPath(rel);
      return { ok: true, path: rel, resolved, entries: await listDir(rel) };
    }

    case "read_file_head": {
      const rel = String(payload.path || "");
      const resolved = safeSandboxPath(rel);
      const maxBytes = Math.min(256 * 1024, Math.max(128, Number(payload.maxBytes || 4096)));
      const head = await readFileHead(rel, maxBytes);
      return { ok: true, path: rel, resolved, bytes: head.bytes, head: head.text };
    }

    default:
      throw new Error("command_not_allowed");
  }
}

async function loop() {
  await emitEvent("info", "agent.boot", "Agent started", { project_id: PROJECT_ID, node_id: NODE_ID });

  while (true) {
    try {
      await upsertNode();

      const controls = await getControls();
      if (controls.kill_switch) {
        await emitEvent("warn", "agent.kill_switch", "Kill-switch activo. Agente en pausa.", { project_id: PROJECT_ID });
        await sleep(POLL_MS);
        continue;
      }

      const queued = await fetchQueued();
      for (const raw of queued) {
        const cmd = await claimQueued(raw);
        if (!cmd) continue;

        // Kill-switch puede activarse mientras el agente está corriendo.
        const controls2 = await getControls();
        if (controls2.kill_switch) {
          await cancel(cmd.id, "Kill switch ON");
          await emitEvent("warn", "command.blocked", "Command blocked (kill switch).", { command_id: cmd.id });
          continue;
        }

        await emitEvent("info", "command.started", `Running: ${cmd.command}`, { command_id: cmd.id });

        try {
          const result = await runCommand(cmd);
          await finishOk(cmd.id, result);
          await emitEvent("info", "command.done", `Done: ${cmd.command}`, { command_id: cmd.id });
        } catch (e: any) {
          const msg = String(e?.message || e);
          await finishErr(cmd.id, msg);
          await emitEvent("error", "command.error", `Error: ${cmd.command}`, { command_id: cmd.id, error: msg });
        }
      }

      await sleep(POLL_MS);
    } catch (e: any) {
      await emitEvent("error", "agent.loop_error", "Error en loop principal", { error: String(e?.message || e) });
      await sleep(POLL_MS);
    }
  }
}

loop();