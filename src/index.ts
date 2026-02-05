import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { sbAdmin } from "./supabase.js";
import { verifySignature } from "./security.js";

const NODE_ID = process.env.HOCKER_NODE_ID ?? "node-hocker-01";
const PROJECT_ID = (process.env.HOCKER_PROJECT_ID ?? "global").toLowerCase();

const SIGN_SECRET = process.env.HOCKER_COMMAND_SIGNING_SECRET ?? "";
const POLL_MS = Number(process.env.POLL_MS ?? 1500);

const FS_ROOT = process.env.HOCKER_FS_ROOT ?? ".";
const ALLOWED_EXTS = (process.env.HOCKER_ALLOWED_EXTS ?? ".txt,.md,.json")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_FILE_BYTES = Number(process.env.HOCKER_MAX_FILE_BYTES ?? 65536);

function nowIso() {
  return new Date().toISOString();
}

async function killSwitch(sb: any) {
  const { data } = await sb
    .from("system_controls")
    .select("kill_switch")
    .eq("id", "global")
    .eq("project_id", PROJECT_ID)
    .single();
  return Boolean(data?.kill_switch);
}

async function heartbeat(sb: any) {
  await sb.from("nodes").upsert({
    id: NODE_ID,
    project_id: PROJECT_ID,
    name: NODE_ID,
    type: "local",
    status: "online",
    last_seen_at: nowIso(),
    meta: { hostname: os.hostname(), platform: os.platform(), arch: os.arch() }
  });
}

async function resolveSafe(userPath: string) {
  const rootAbs = path.resolve(FS_ROOT);
  const candidate = path.resolve(rootAbs, userPath || ".");
  const rootReal = await fs.realpath(rootAbs);

  // Si no existe, realpath tronará; lo forzamos a existir por seguridad.
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) throw new Error("Symlink bloqueado");

  const targetReal = await fs.realpath(candidate);
  if (!(targetReal === rootReal || targetReal.startsWith(rootReal + path.sep))) {
    throw new Error("Path fuera de ROOT");
  }

  return { rootReal, targetReal, stat };
}

async function readDirSafe(p: string) {
  const { targetReal, stat } = await resolveSafe(p);
  if (!stat.isDirectory()) throw new Error("No es directorio");

  const entries = await fs.readdir(targetReal, { withFileTypes: true });
  const out = entries.slice(0, 200).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other"
  }));

  return { ok: true, path: p, entries: out };
}

function extAllowed(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTS.includes(ext) || ALLOWED_EXTS.includes(filePath.toLowerCase());
}

async function readFileHeadSafe(p: string, maxBytes: number) {
  const { targetReal, stat } = await resolveSafe(p);
  if (!stat.isFile()) throw new Error("No es archivo");
  if (!extAllowed(targetReal)) throw new Error("Extensión no permitida");

  const size = stat.size;
  const cap = Math.min(Math.max(0, Number(maxBytes ?? 4096)), MAX_FILE_BYTES, size);

  let buf = Buffer.alloc(0);

  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(targetReal, { start: 0, end: cap > 0 ? cap - 1 : 0 });
    s.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
    });
    s.on("error", reject);
    s.on("end", () => resolve());
  });

  const text = buf.toString("utf8");
  return { ok: true, path: p, bytes: buf.length, head: text };
}

async function executeCommand(cmd: any) {
  if (cmd.command === "ping") return { ok: true, pong: true, ts: nowIso() };

  if (cmd.command === "status") {
    return {
      ok: true,
      node: NODE_ID,
      project_id: PROJECT_ID,
      ts: nowIso(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime_s: os.uptime(),
      loadavg: os.loadavg(),
      mem: { free: os.freemem(), total: os.totalmem() }
    };
  }

  if (cmd.command === "read_dir") {
    const p = String(cmd.payload?.path ?? ".");
    return await readDirSafe(p);
  }

  if (cmd.command === "read_file_head") {
    const p = String(cmd.payload?.path ?? ".");
    const max_bytes = Number(cmd.payload?.max_bytes ?? 4096);
    return await readFileHeadSafe(p, max_bytes);
  }

  throw new Error(`Unsupported command: ${cmd.command}`);
}

async function loop() {
  if (!SIGN_SECRET) throw new Error("Missing HOCKER_COMMAND_SIGNING_SECRET");

  const sb = sbAdmin();
  console.log(`[agent] node=${NODE_ID} project=${PROJECT_ID} started`);

  while (true) {
    try {
      await heartbeat(sb);

      if (await killSwitch(sb)) {
        await sb.from("events").insert({
          project_id: PROJECT_ID,
          node_id: NODE_ID,
          level: "warn",
          type: "killswitch",
          message: "Kill-switch activo: nodo en modo bloqueo",
          data: {}
        });

        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }

      const { data: commands, error } = await sb
        .from("commands")
        .select("id,project_id,node_id,command,payload,signature,status,created_at")
        .eq("project_id", PROJECT_ID)
        .eq("node_id", NODE_ID)
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(5);

      if (error) throw error;

      for (const cmd of commands ?? []) {
        const okSig = verifySignature(SIGN_SECRET, {
          id: cmd.id,
          node_id: cmd.node_id,
          command: cmd.command,
          payload: cmd.payload,
          signature: cmd.signature
        });

        if (!okSig) {
          await sb.from("commands").update({ status: "failed", finished_at: nowIso(), error: "Bad signature" }).eq("id", cmd.id);
          await sb.from("events").insert({
            project_id: PROJECT_ID,
            node_id: NODE_ID,
            command_id: cmd.id,
            level: "critical",
            type: "security",
            message: "Comando rechazado: firma inválida",
            data: {}
          });
          continue;
        }

        await sb.from("commands").update({ status: "running", executed_at: nowIso() }).eq("id", cmd.id);

        try {
          const result = await executeCommand(cmd);

          await sb.from("commands").update({ status: "succeeded", finished_at: nowIso(), result }).eq("id", cmd.id);

          await sb.from("events").insert({
            project_id: PROJECT_ID,
            node_id: NODE_ID,
            command_id: cmd.id,
            level: "info",
            type: "command",
            message: `Comando OK: ${cmd.command}`,
            data: result
          });
        } catch (e: any) {
          await sb.from("commands").update({ status: "failed", finished_at: nowIso(), error: e?.message ?? "Error" }).eq("id", cmd.id);

          await sb.from("events").insert({
            project_id: PROJECT_ID,
            node_id: NODE_ID,
            command_id: cmd.id,
            level: "error",
            type: "command",
            message: `Comando falló: ${cmd.command}`,
            data: { error: e?.message ?? "Error" }
          });
        }
      }
    } catch (e: any) {
      console.error("[agent] loop error:", e?.message ?? e);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

loop().catch((e) => {
  console.error("[agent] fatal:", e?.message ?? e);
  process.exit(1);
});