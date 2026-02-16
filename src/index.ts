import "dotenv/config";

import { createClient } from "@supabase/supabase-js";
import { verifyCommand } from "./lib/signature.js";
import { readDir, readFileHead, safePath, SandboxedFsError } from "./lib/sandbox.js";

type CommandRow = {
  id: string;
  project_id: string;
  node_id: string;
  command: string;
  payload: any;
  status: "queued" | "needs_approval" | "running" | "done" | "error" | "canceled";
  signature: string;
  created_at: string;
};

type Controls = { kill_switch: boolean; allow_write: boolean };

const PROJECT_ID = String(process.env.PROJECT_ID || "global").trim() || "global";
const NODE_ID = String(process.env.NODE_ID || "hocker-node-1").trim() || "hocker-node-1";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const COMMAND_HMAC_SECRET = String(process.env.COMMAND_HMAC_SECRET || "").trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !COMMAND_HMAC_SECRET) {
  console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMMAND_HMAC_SECRET");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ALLOWLIST = new Set(["ping", "status", "read_dir", "read_file_head"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

async function upsertNode() {
  await sb.from("nodes").upsert(
    {
      id: NODE_ID,
      project_id: PROJECT_ID,
      name: NODE_ID,
      type: "agent",
      status: "online",
      last_seen_at: nowIso(),
      meta: { agent: "hocker-node-agent", allowlist: Array.from(ALLOWLIST) }
    },
    { onConflict: "id" }
  );
}

async function getControls(): Promise<Controls> {
  const { data } = await sb
    .from("system_controls")
    .select("kill_switch, allow_write")
    .eq("project_id", PROJECT_ID)
    .eq("id", "global")
    .maybeSingle();

  return { kill_switch: Boolean(data?.kill_switch), allow_write: Boolean(data?.allow_write) };
}

async function emitEvent(level: "info" | "warn" | "error", type: string, message: string, data?: any) {
  await sb.from("events").insert({ project_id: PROJECT_ID, node_id: NODE_ID, level, type, message, data: data ?? null });
}

async function fetchQueued(): Promise<CommandRow[]> {
  const { data } = await sb
    .from("commands")
    .select("id, project_id, node_id, command, payload, status, signature, created_at")
    .eq("project_id", PROJECT_ID)
    .eq("node_id", NODE_ID)
    .eq("status", "queued")
    .eq("needs_approval", false)
    .order("created_at", { ascending: true })
    .limit(20);

  return (data as any) ?? [];
}

// Claim atómico real
async function claimQueued(cmd: CommandRow): Promise<CommandRow | null> {
  const t = nowIso();
  const { data, error } = await sb
    .from("commands")
    .update({ status: "running", started_at: t, executed_at: t })
    .eq("id", cmd.id)
    .eq("project_id", PROJECT_ID)
    .eq("status", "queued")
    .select("id, project_id, node_id, command, payload, status, signature, created_at")
    .maybeSingle();

  if (error) return null;
  return (data as any) ?? null;
}

async function finishOk(id: string, result: any) {
  const t = nowIso();
  await sb.from("commands").update({ status: "done", result, finished_at: t }).eq("id", id).eq("project_id", PROJECT_ID);
}

async function finishErr(id: string, err: string) {
  const t = nowIso();
  await sb.from("commands").update({ status: "error", error: err, finished_at: t }).eq("id", id).eq("project_id", PROJECT_ID);
}

async function cancel(id: string, reason: string) {
  const t = nowIso();
  await sb.from("commands").update({ status: "canceled", error: reason, finished_at: t }).eq("id", id).eq("project_id", PROJECT_ID);
}

async function runCommand(cmd: CommandRow) {
  if (!ALLOWLIST.has(cmd.command)) throw new Error(`Command not allowed: ${cmd.command}`);
  const payload = cmd.payload ?? {};

  switch (cmd.command) {
    case "ping":
      return { ok: true, node: NODE_ID, ts: nowIso() };

    case "status":
      return { ok: true, node: NODE_ID, project: PROJECT_ID, ts: nowIso(), allowlist: Array.from(ALLOWLIST) };

    case "read_dir": {
      const path = safePath(String(payload.path || "."));
      return { ok: true, path, entries: await readDir(path) };
    }

    case "read_file_head": {
      const path = safePath(String(payload.path || ""));
      const maxBytes = Math.min(256 * 1024, Math.max(1, Number(payload.maxBytes || 4096)));
      return { ok: true, path, head: await readFileHead(path, maxBytes) };
    }

    default:
      throw new Error(`Unknown command: ${cmd.command}`);
  }
}

async function loop() {
  await upsertNode();
  await emitEvent("info", "agent.start", "Node agent online.");

  while (true) {
    try {
      const controls = await getControls();
      if (controls.kill_switch) {
        await emitEvent("warn", "agent.killswitch", "Kill Switch ON: agent paused.");
        await sleep(5000);
        continue;
      }

      await upsertNode();

      const queued = await fetchQueued();
      for (const raw of queued) {
        const cmd = await claimQueued(raw);
        if (!cmd) continue;

        const ok = verifyCommand(
          COMMAND_HMAC_SECRET,
          cmd.id,
          cmd.project_id,
          cmd.node_id,
          cmd.command,
          cmd.payload,
          cmd.created_at,
          cmd.signature
        );

        if (!ok) {
          await cancel(cmd.id, "Bad signature.");
          await emitEvent("error", "command.bad_signature", `Bad signature for ${cmd.id}`, { command: cmd.command });
          continue;
        }

        await emitEvent("info", "command.started", `Running: ${cmd.command}`, { command_id: cmd.id });

        try {
          const result = await runCommand(cmd);
          await finishOk(cmd.id, result);
          await emitEvent("info", "command.done", `Done: ${cmd.command}`, { command_id: cmd.id });
        } catch (e: any) {
          const msg = e instanceof SandboxedFsError ? e.message : String(e?.message || e);
          await finishErr(cmd.id, msg);
          await emitEvent("error", "command.error", `Error: ${cmd.command}`, { command_id: cmd.id, error: msg });
        }
      }
    } catch (e: any) {
      await emitEvent("error", "agent.loop_error", "Agent loop error", { error: String(e?.message || e) });
    }

    await sleep(1500);
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
