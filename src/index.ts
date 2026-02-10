import "dotenv/config";
import os from "node:os";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { listDir, readFileHead, sandboxRoot } from "./lib/sandbox.js";
import { verifyCommand } from "./lib/signature.js";

type Controls = { kill_switch: boolean; allow_write: boolean };
type CommandRow = {
  id: string;
  project_id: string;
  node_id: string | null;
  command: string;
  payload: any;
  status: "needs_approval" | "queued" | "running" | "done" | "failed" | "cancelled";
  signature?: string | null;
  created_at: string;
};

const ALLOWLIST = new Set(["ping", "status", "read_dir", "read_file_head"]);

function nowIso() {
  return new Date().toISOString();
}

function reqEnv(name: string) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Falta env: ${name}`);
  return v;
}

const SUPABASE_URL = reqEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = reqEnv("SUPABASE_SERVICE_ROLE_KEY");
const COMMAND_HMAC_SECRET = reqEnv("COMMAND_HMAC_SECRET");

const PROJECT_ID = String(process.env.PROJECT_ID || "global").trim() || "global";
const NODE_ID = reqEnv("NODE_ID");

const POLL_MS = Math.max(500, Number(process.env.POLL_MS || 2000));
const HEARTBEAT_MS = Math.max(2000, Number(process.env.HEARTBEAT_MS || 15000));

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function emitEvent(level: "info" | "warn" | "error", type: string, message: string, data?: any) {
  await sb.from("events").insert({
    project_id: PROJECT_ID,
    node_id: NODE_ID,
    level,
    type,
    message,
    data: data ?? null,
  });
}

async function getControls(): Promise<Controls> {
  const { data, error } = await sb
    .from("system_controls")
    .select("kill_switch, allow_write")
    .eq("project_id", PROJECT_ID)
    .eq("id", "global")
    .maybeSingle();

  if (error) return { kill_switch: false, allow_write: false };
  return {
    kill_switch: !!data?.kill_switch,
    allow_write: !!data?.allow_write,
  };
}

async function upsertNode() {
  const meta = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    agent_version: "0.1.0",
    sandbox_root: sandboxRoot(),
  };

  // nodes.id es PK. Si este NODE_ID existe en otro proyecto, eso es un problema real (y debe corregirse).
  const { error } = await sb.from("nodes").upsert(
    {
      id: NODE_ID,
      project_id: PROJECT_ID,
      name: NODE_ID,
      tags: ["agent", "nodejs"],
      last_seen_at: nowIso(),
      meta,
    },
    { onConflict: "id" }
  );

  if (error) {
    console.error("No pude upsert node:", error.message);
  }
}

async function heartbeat() {
  const meta = {
    hostname: os.hostname(),
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    loadavg: os.loadavg(),
    mem: {
      total: os.totalmem(),
      free: os.freemem(),
      rss: process.memoryUsage().rss,
    },
  };

  await sb.from("nodes").update({ last_seen_at: nowIso(), meta }).eq("id", NODE_ID);
}

async function claimQueued(cmd: CommandRow): Promise<CommandRow | null> {
  const { data, error } = await sb
    .from("commands")
    .update({ status: "running", executed_at: nowIso() })
    .eq("id", cmd.id)
    .eq("project_id", PROJECT_ID)
    .eq("status", "queued")
    .select("id, project_id, node_id, command, payload, status, signature, created_at")
    .maybeSingle();

  if (error) return null;
  return (data as any) ?? null;
}

async function finishOk(id: string, result: any) {
  await sb
    .from("commands")
    .update({ status: "done", result, error: null })
    .eq("id", id)
    .eq("project_id", PROJECT_ID);

  await emitEvent("info", "command.done", `Done: ${id}`, { command_id: id });
}

async function finishFail(id: string, errorMsg: string) {
  await sb
    .from("commands")
    .update({ status: "failed", error: errorMsg, result: null })
    .eq("id", id)
    .eq("project_id", PROJECT_ID);

  await emitEvent("error", "command.failed", `Failed: ${id}`, { command_id: id, error: errorMsg });
}

async function cancelByKillswitch(id: string) {
  await sb
    .from("commands")
    .update({ status: "cancelled", error: "Kill Switch ON: ejecución bloqueada por governance.", result: null })
    .eq("id", id)
    .eq("project_id", PROJECT_ID);

  await emitEvent("warn", "command.cancelled", `Cancelled by Kill Switch: ${id}`, { command_id: id });
}

async function execCommand(name: string, payload: any) {
  switch (name) {
    case "ping":
      return { ok: true, pong: nowIso() };

    case "status": {
      const mu = process.memoryUsage();
      return {
        ok: true,
        node_id: NODE_ID,
        project_id: PROJECT_ID,
        time: nowIso(),
        host: {
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus()?.length ?? null,
          loadavg: os.loadavg(),
          uptime_s: os.uptime(),
        },
        process: {
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
          rss: mu.rss,
          heapUsed: mu.heapUsed,
          heapTotal: mu.heapTotal,
        },
        sandbox_root: sandboxRoot(),
      };
    }

    case "read_dir": {
      const rel = String(payload?.path || ".").trim() || ".";
      const items = await listDir(rel);
      return { ok: true, path: rel, items };
    }

    case "read_file_head": {
      const rel = String(payload?.path || "").trim();
      if (!rel) throw new Error("payload.path requerido.");
      const bytes = Number(payload?.bytes || process.env.FILE_HEAD_BYTES || 65536);
      const head = await readFileHead(rel, bytes);
      return { ok: true, path: rel, ...head };
    }

    default:
      throw new Error("Comando no permitido por allowlist del agente.");
  }
}

async function loopOnce() {
  const controls = await getControls();

  const { data, error } = await sb
    .from("commands")
    .select("id, project_id, node_id, command, payload, status, signature, created_at")
    .eq("project_id", PROJECT_ID)
    .eq("node_id", NODE_ID)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error("Error listando commands:", error.message);
    return;
  }

  const items = (data ?? []) as unknown as CommandRow[];
  if (!items.length) return;

  for (const cmd of items) {
    // governance hard stop
    if (controls.kill_switch) {
      await cancelByKillswitch(cmd.id);
      continue;
    }

    // claim
    const claimed = await claimQueued(cmd);
    if (!claimed) continue;

    await emitEvent("info", "command.running", `Running: ${claimed.command}`, {
      command_id: claimed.id,
      command: claimed.command,
    });

    // signature verify
    const okSig = verifyCommand(
      COMMAND_HMAC_SECRET,
      claimed.id,
      PROJECT_ID,
      NODE_ID,
      claimed.command,
      claimed.payload ?? {},
      claimed.created_at,
      claimed.signature ?? null
    );

    if (!okSig) {
      await finishFail(claimed.id, "Firma inválida (HMAC). Comando bloqueado.");
      continue;
    }

    // allowlist gate (doble seguro)
    if (!ALLOWLIST.has(claimed.command)) {
      await finishFail(claimed.id, `Comando "${claimed.command}" bloqueado (no está en allowlist).`);
      continue;
    }

    try {
      const result = await execCommand(claimed.command, claimed.payload ?? {});
      await finishOk(claimed.id, result);
    } catch (e: any) {
      await finishFail(claimed.id, String(e?.message || "Error ejecutando comando."));
    }
  }
}

async function main() {
  console.log(`[agent] boot node_id=${NODE_ID} project_id=${PROJECT_ID}`);
  await upsertNode();
  await emitEvent("info", "agent.boot", "Node agent iniciado.", { node_id: NODE_ID, project_id: PROJECT_ID });

  setInterval(() => {
    heartbeat().catch((e) => console.error("heartbeat error:", e?.message || e));
  }, HEARTBEAT_MS);

  // poll loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await loopOnce();
    } catch (e: any) {
      console.error("loop error:", e?.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});