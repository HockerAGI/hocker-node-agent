import "dotenv/config";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { supabaseAdmin } from "./supabase.js";
import { verifySig } from "./security.js";

const exec = promisify(execCb);

const PROJECT_ID = process.env.HOCKER_PROJECT_ID!;
const NODE_ID = process.env.HOCKER_NODE_ID!;
const WORKDIR = process.env.HOCKER_WORKDIR || process.cwd();

// Allowlist default (ajústalo)
const DEFAULT_ALLOW = [
  /^uname\b/, /^node\b/, /^npm\b/, /^pnpm\b/, /^yarn\b/,
  /^git\b/, /^pm2\b/,
  /^ls\b/, /^cat\b/, /^pwd\b/, /^whoami\b/, /^df\b/, /^free\b/
];
const CUSTOM_ALLOW = (process.env.HOCKER_SHELL_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map((rx) => new RegExp(rx));

function allowedShell(cmd: string) {
  const list = CUSTOM_ALLOW.length ? CUSTOM_ALLOW : DEFAULT_ALLOW;
  return list.some(rx => rx.test(cmd.trim()));
}

function safePath(rel: string) {
  const full = path.resolve(WORKDIR, rel);
  const root = path.resolve(WORKDIR);
  if (!full.startsWith(root)) throw new Error("Path escape blocked");
  return full;
}

async function heartbeat(sb: ReturnType<typeof supabaseAdmin>) {
  await sb.from("nodes").upsert({
    id: NODE_ID,
    project_id: PROJECT_ID,
    name: process.env.HOCKER_NODE_NAME || "node-agent",
    status: "online",
    last_seen: new Date().toISOString()
  });
}

async function killSwitchOn(sb: ReturnType<typeof supabaseAdmin>) {
  const { data } = await sb.from("system_controls").select("kill_switch").eq("id", "global").maybeSingle();
  return data?.kill_switch === true;
}

async function nextCommand(sb: ReturnType<typeof supabaseAdmin>) {
  const { data } = await sb
    .from("commands")
    .select("*")
    .eq("project_id", PROJECT_ID)
    .eq("node_id", NODE_ID)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

async function setStatus(sb: ReturnType<typeof supabaseAdmin>, id: string, status: string, result?: any) {
  await sb.from("commands").update({ status, result }).eq("id", id);
}

async function log(sb: ReturnType<typeof supabaseAdmin>, type: string, message: string, meta: any = {}) {
  await sb.from("events").insert({
    project_id: PROJECT_ID,
    type,
    message,
    meta: { node_id: NODE_ID, ...meta }
  });
}

async function main() {
  if (!PROJECT_ID || !NODE_ID) throw new Error("Missing HOCKER_PROJECT_ID / HOCKER_NODE_ID");
  const sb = supabaseAdmin();

  await log(sb, "agent.start", "Node Agent online", { workdir: WORKDIR });

  while (true) {
    try {
      await heartbeat(sb);

      if (await killSwitchOn(sb)) {
        await log(sb, "agent.killswitch", "Kill switch active. Sleeping...");
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const cmd = await nextCommand(sb);
      if (!cmd) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }

      // firma (si viene del panel)
      const okSig = verifySig(cmd);
      if (!okSig) {
        await setStatus(sb, cmd.id, "failed", { error: "Bad signature" });
        await log(sb, "command.failed", "Bad signature", { command_id: cmd.id });
        continue;
      }

      await setStatus(sb, cmd.id, "running");
      await log(sb, "command.running", cmd.command, { command_id: cmd.id });

      if (cmd.command === "fs.list") {
        const dir = safePath(cmd.payload?.path || ".");
        const items = await fs.readdir(dir);
        await setStatus(sb, cmd.id, "done", { items });
      }

      else if (cmd.command === "fs.read") {
        const file = safePath(cmd.payload?.path);
        const content = await fs.readFile(file, "utf8");
        await setStatus(sb, cmd.id, "done", { content });
      }

      else if (cmd.command === "fs.write") {
        const file = safePath(cmd.payload?.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, String(cmd.payload?.content || ""), "utf8");
        await setStatus(sb, cmd.id, "done", { ok: true, path: cmd.payload?.path });
      }

      else if (cmd.command === "shell.exec") {
        const c = String(cmd.payload?.cmd || "");
        const timeoutMs = Number(cmd.payload?.timeoutMs || 60000);

        if (!allowedShell(c)) {
          await setStatus(sb, cmd.id, "failed", { error: "Shell command blocked by allowlist", cmd: c });
        } else {
          const { stdout, stderr } = await exec(c, { cwd: WORKDIR, timeout: timeoutMs });
          await setStatus(sb, cmd.id, "done", { stdout, stderr });
        }
      }

      else {
        await setStatus(sb, cmd.id, "failed", { error: "Unknown command" });
      }

      await log(sb, "command.done", cmd.command, { command_id: cmd.id });
    } catch (e: any) {
      const sb = supabaseAdmin();
      await log(sb, "agent.error", e?.message || "error", { stack: e?.stack });
      await new Promise(r => setTimeout(r, 1200));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});