import fs from "node:fs";
import path from "node:path";
import { sbAdmin } from "./supabase";
import { verifySignature } from "./security";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const NODE_ID = process.env.AGENT_NODE_ID || "node-hocker-01";
const PROJECT_ID = process.env.PROJECT_ID || "global";
const SANDBOX_ROOT = process.env.SANDBOX_ROOT || "/tmp/hocker-sandbox";
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 10 * 1024 * 1024);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function safeResolve(userPath: string) {
  const clean = userPath.replace(/^(\.\.(\/|\\|$))+/, "");
  const target = path.resolve(SANDBOX_ROOT, clean);
  const root = path.resolve(SANDBOX_ROOT);
  if (!target.startsWith(root)) throw new Error("Path traversal blocked");
  return target;
}

function ensureSandbox() {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
}

async function killSwitchOn(sb: ReturnType<typeof sbAdmin>) {
  const r = await sb.from("system_controls").select("kill_switch").eq("project_id", PROJECT_ID).single();
  if (r.error) return false;
  return Boolean(r.data?.kill_switch);
}

async function pollOnce(sb: ReturnType<typeof sbAdmin>) {
  if (await killSwitchOn(sb)) return;

  const q = await sb
    .from("commands")
    .select("id,command,payload,signature,created_at,project_id,node_id")
    .eq("project_id", PROJECT_ID)
    .eq("node_id", NODE_ID)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(5);

  if (q.error) {
    console.error("[agent] commands query error:", q.error.message);
    return;
  }

  for (const row of q.data ?? []) {
    const id = row.id as string;
    const command = row.command as string;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const signature = row.signature as string;
    const ts = String(row.created_at);

    // verify signature (must match canonical JSON)
    const ok = verifySignature(
      { node_id: NODE_ID, command, payload, project_id: PROJECT_ID, ts },
      signature
    );

    if (!ok) {
      await sb.from("commands").update({ status: "error", error: "Bad signature", finished_at: new Date().toISOString() }).eq("id", id);
      continue;
    }

    await sb.from("commands").update