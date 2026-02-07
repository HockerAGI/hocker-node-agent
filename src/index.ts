import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { sbAdmin } from "./supabase.js";
import { verifySignature } from "./security.js";

const PORT = Number(process.env.PORT ?? "8080");
const NODE_ID = process.env.NODE_ID ?? "node-cloudrun-01";
const PROJECT_ID = process.env.PROJECT_ID ?? "global";
const POLL_MS = Number(process.env.POLL_MS ?? "1500");

const SIGNING_SECRET = process.env.HOCKER_COMMAND_SIGNING_SECRET ?? "";
if (!SIGNING_SECRET) throw new Error("Falta HOCKER_COMMAND_SIGNING_SECRET");

const SANDBOX = process.env.AGENT_SANDBOX_DIR ?? "/tmp/hocker-sandbox";
const allowlist = (process.env.SHELL_ALLOWLIST ?? "").split(",").map(s => s.trim()).filter(Boolean);
const SHELL_TIMEOUT_MS = Number(process.env.SHELL_TIMEOUT_MS ?? "15000");
const SHELL_MAX_OUTPUT_KB = Number(process.env.SHELL_MAX_OUTPUT_KB ?? "256");

function nowIso() { return new Date().toISOString(); }

function safeJoin(rel: string) {
  const clean = rel.replace(/^(\.\.(\/|\\|$))+/, "").replace(/^\/+/, "");
  const p = path.resolve(SANDBOX, clean);
  if (!p.startsWith(path.resolve(SANDBOX))) throw new Error("Path fuera de sandbox");
  return p;
}

async function ensureSandbox() {
  await fs.mkdir(SANDBOX, { recursive: true });
}

async function heartbeat(sb: ReturnType<typeof sbAdmin>) {
  await sb.from("nodes").upsert(
    {
      id: NODE_ID,
      project_id: PROJECT_ID,
      name: NODE_ID,
      type: "agent",
      status: "online",
      last_seen_at: nowIso(),
      meta: { agent: "hocker-node-agent", sandbox: SANDBOX, platform: "cloudrun" }
    },
    { onConflict: "id" }
  );
}

async function systemFlags(sb: ReturnType<typeof sbAdmin>) {
  const { data } = await sb
    .from("system_controls")
    .select("kill_switch, allow_shell, allow_filesystem")
    .eq("project_id", PROJECT_ID)
    .eq("id", "global")
    .maybeSingle();

  return {
    kill: Boolean(data?.kill_switch),
    allowShell: Boolean(data?.allow_shell),
    allowFs: data?.allow_filesystem !== false
  };
}

async function execShell(cmd: string, args: string[]) {
  if (!allowlist.includes(cmd)) throw new Error(`Shell bloqueado: ${cmd} (no está en allowlist)`);

  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  let err = "";
  const cap = SHELL_MAX_OUTPUT_KB * 1024;
  const t = setTimeout(() => child.kill("SIGKILL"), SHELL_TIMEOUT_MS);

  child.stdout.on("data", (d) => { if (out.length < cap) out += d.toString(); });
  child.stderr.on("data", (d) => { if (err.length < cap) err += d.toString(); });

  const code: number = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(t);

  return { code, out: out.slice(0, cap), err: err.slice(0, cap) };
}

async function handleCommand(command: string, payload: any, flags: { allowShell: boolean; allowFs: boolean }) {
  if (command === "status") {
    return {
      ok: true,
      node: NODE_ID,
      project: PROJECT_ID,
      host: os.hostname(),
      uptime_sec: Math.floor(os.uptime()),
      loadavg: os.loadavg(),
      mem: { total: os.totalmem(), free: os.freemem() },
      time: nowIso()
    };
  }

  if (command === "fs.list") {
    if (!flags.allowFs) throw new Error("FS deshabilitado por system_controls");
    await ensureSandbox();
    const rel = String(payload?.path ?? "");
    const p = safeJoin(rel || ".");
    const items = await fs.readdir(p, { withFileTypes: true });
    return items.map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }));
  }

  if (command === "fs.read") {
    if (!flags.allowFs) throw new Error("FS deshabilitado por system_controls");
    await ensureSandbox();
    const rel = String(payload?.path ?? "");
    const p = safeJoin(rel);
    const data = await fs.readFile(p, "utf8");
    return { ok: true, content: data };
  }

  if (command === "fs.write") {
    if (!flags.allowFs) throw new Error("FS deshabilitado por system_controls");
    await ensureSandbox();
    const rel = String(payload?.path ?? "");
    const p = safeJoin(rel);
    const content = String(payload?.content ?? "");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    return { ok: true, path: rel, bytes: Buffer.byteLength(content) };
  }

  if (command === "shell.exec") {
    if (!flags.allowShell) throw new Error("Shell deshabilitado por system_controls");
    const cmd = String(payload?.cmd ?? "");
    const args = Array.isArray(payload?.args) ? payload.args.map(String) : [];
    if (!cmd) throw new Error("Falta payload.cmd");
    return await execShell(cmd, args);
  }

  throw new Error(`Comando desconocido: ${command}`);
}

async function loopOnce(sb: ReturnType<typeof sbAdmin>) {
  const flags = await systemFlags(sb);

  if (flags.kill) {
    await sb.from("events").insert({
      project_id: PROJECT_ID,
      node_id: NODE_ID,
      level: "warn",
      type: "agent.paused",
      message: "Kill-switch activo, agent en pausa",
      data: {}
    });
    return;
  }

  const { data: cmds } = await sb
    .from("commands")
    .select("id, project_id, node_id, command, payload, signature, status")
    .eq("project_id", PROJECT_ID)
    .eq("node_id", NODE_ID)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  const cmd = (cmds ?? [])[0];
  if (!cmd) return;

  const okSig = verifySignature(SIGNING_SECRET, cmd.signature, {
    id: cmd.id,
    project_id: cmd.project_id,
    node_id: cmd.node_id,
    command: cmd.command,
    payload: cmd.payload ?? {}
  });

  if (!okSig) {
    await sb.from("commands").update({ status: "failed", error: "Firma inválida", finished_at: nowIso() }).eq("id", cmd.id);
    return;
  }

  await sb.from("commands").update({ status: "running", executed_at: nowIso() }).eq("id", cmd.id);

  try {
    const result = await handleCommand(cmd.command, cmd.payload, { allowShell: flags.allowShell, allowFs: flags.allowFs });
    await sb.from("commands").update({ status: "succeeded", result, finished_at: nowIso() }).eq("id", cmd.id);
  } catch (e: any) {
    await sb.from("commands").update({ status: "failed", error: String(e?.message ?? e), finished_at: nowIso() }).eq("id", cmd.id);
  }
}

async function main() {
  const sb = sbAdmin();

  // server mínimo para Cloud Run
  http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, node: NODE_ID, project: PROJECT_ID }));
  }).listen(PORT, () => {
    console.log(`[agent] http listening on :${PORT}`);
  });

  // heartbeat continuo
  setInterval(() => heartbeat(sb).catch(() => {}), 5000);
  await heartbeat(sb);

  // loop
  while (true) {
    await loopOnce(sb).catch(() => {});
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});