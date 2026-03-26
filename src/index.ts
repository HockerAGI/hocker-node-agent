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

const sb = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

const langfuse = new Langfuse({
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  baseUrl: config.langfuse.baseUrl,
});

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function printBanner() {
  console.clear();
  console.log(
    C.cyan +
      C.bold +
      `
  ██╗  ██╗███████╗ ██████╗██╗  ██╗███████╗██████╗ 
  ██║  ██║██╔════╝██╔════╝██║ ██╔╝██╔════╝██╔══██╗
  ███████║█████╗  ██║     █████╔╝ █████╗  ██████╔╝
  ██╔══██║██╔══╝  ██║     ██╔═██╗ ██╔══╝  ██╔══██╗
  ██║  ██║███████╗╚██████╗██║  ██╗███████╗██║  ██║
  ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ` +
      C.reset
  );

  console.log(`${C.dim}======================================================${C.reset}`);
  console.log(`${C.bold} NODO AGENTE FÍSICO (Zero-Trust) v2.0 - ONLINE${C.reset}`);
  console.log(`${C.dim} Node ID    :${C.reset} ${C.green}${config.nodeId}${C.reset}`);
  console.log(`${C.dim} Project ID :${C.reset} ${C.green}${config.projectId}${C.reset}`);
  console.log(`${C.dim} Server Port:${C.reset} ${C.yellow}${config.port} (Health Checks Only)${C.reset}`);
  console.log(`${C.dim}======================================================${C.reset}\n`);
}

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
          orchestrator_url_configured: Boolean(config.orchestratorUrl),
          ts: nowIso(),
        })
      );
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "not_found" }));
  })
  .listen(config.port, "0.0.0.0");

async function emitEvent(level: "info" | "warn" | "error", type: string, message: string, data?: any) {
  const metadata = data && typeof data === "object" ? data : {};

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
      metadata: {
        type,
        ...metadata,
      },
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
      kill_switch: Boolean((data as any)?.kill_switch),
      allow_write: Boolean((data as any)?.allow_write),
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
      name: `Physical Node: ${config.nodeId}`,
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

  return (data as any) || [];
}

async function claimQueued(cmd: Pick<CommandRow, "id">): Promise<CommandRow | null> {
  const started_at = nowIso();

  const { data } = await sb
    .from("commands")
    .update({ status: "running", started_at })
    .eq("project_id", config.projectId)
    .eq("id", cmd.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();

  return (data as any) || null;
}

async function finishOk(id: string, result: any) {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({
      status: "done",
      executed_at: ts,
      finished_at: ts,
      result,
      error: null,
    })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function finishErr(id: string, msg: string) {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({
      status: "error",
      executed_at: ts,
      finished_at: ts,
      result: null,
      error: msg,
    })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function cancel(id: string, msg: string) {
  const ts = nowIso();
  await sb
    .from("commands")
    .update({
      status: "canceled",
      executed_at: ts,
      finished_at: ts,
      result: null,
      error: msg,
    })
    .eq("project_id", config.projectId)
    .eq("id", id);
}

async function runCommand(cmd: CommandRow, controls: Controls) {
  if (
    !verifyCommand(
      config.commandHmacSecret,
      cmd.id,
      cmd.project_id,
      cmd.node_id,
      cmd.command,
      cmd.payload,
      cmd.created_at,
      cmd.signature
    )
  ) {
    throw new Error("invalid_signature");
  }

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
      const relDir = String(payload.path || ".");
      return { ok: true, path: relDir, entries: await listDir(relDir) };
    }

    case "read_file_head": {
      const relPath = String(payload.path || "");
      const maxBytes = Math.min(256 * 1024, Math.max(128, Number(payload.maxBytes || 4096)));
      const head = await readFileHead(relPath, maxBytes);
      return { ok: true, path: relPath, bytes: head.bytes, head: head.text };
    }

    case "shell.exec": {
      const timeout = Number(payload.timeout || 120000);
      return await executeLocalShell(String(payload.script || ""), timeout);
    }

    case "fs.write": {
      const writtenPath = await writeLocalFile(String(payload.path || ""), String(payload.content ?? ""));
      return { ok: true, writtenPath };
    }

    default:
      throw new Error(`command_not_allowed: ${command}`);
  }
}

async function loop() {
  printBanner();

  await emitEvent("info", "agent.boot", "Agent started (Hocker Fabric Ready)", {
    node_id: config.nodeId,
    project_id: config.projectId,
  });

  let lastHeartbeatLogAt = 0;

  while (true) {
    try {
      await upsertNode();

      const now = Date.now();
      if (now - lastHeartbeatLogAt >= 60_000) {
        lastHeartbeatLogAt = now;
        await emitEvent("info", "node.heartbeat", "Heartbeat", {
          node_id: config.nodeId,
          project_id: config.projectId,
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

        const timestamp = new Date().toLocaleTimeString();
        console.log(
          `${C.dim}[${timestamp}]${C.reset} ${C.yellow}⚡ EJECUTANDO:${C.reset} ${cmd.command} ${C.dim}(${cmd.id.split("-")[0]})${C.reset}`
        );

        const controls2 = await getControls();
        if (controls2.kill_switch) {
          await cancel(cmd.id, "Kill switch activado durante intercepción.");
          await emitEvent("warn", "command.canceled", `Canceled by kill switch: ${cmd.command}`, {
            command_id: cmd.id,
          });
          continue;
        }

        if (!controls2.allow_write && (cmd.command === "shell.exec" || cmd.command === "fs.write")) {
          await cancel(cmd.id, "Modo lectura activo (allow_write=false).");
          await emitEvent("warn", "command.blocked", `Blocked by read-only mode: ${cmd.command}`, {
            command_id: cmd.id,
          });
          continue;
        }

        const trace = langfuse.trace({
          name: "Node_Execution",
          metadata: { commandId: cmd.id, nodeId: config.nodeId, projectId: config.projectId },
        });

        await emitEvent("info", "command.started", `Running: ${cmd.command}`, {
          command_id: cmd.id,
        });

        try {
          const result = await runCommand(cmd, controls2);
          await finishOk(cmd.id, result);
          await emitEvent("info", "command.done", `Done: ${cmd.command}`, {
            command_id: cmd.id,
          });
          trace.event({ name: "Success", output: result });
          console.log(`${C.dim}[${timestamp}]${C.reset} ${C.green}✓ ÉXITO:${C.reset} Tarea completada.`);
        } catch (e: any) {
          const msg = String(e?.message || e);
          await finishErr(cmd.id, msg);
          await emitEvent("error", "command.error", `Error: ${cmd.command}`, {
            command_id: cmd.id,
            error: msg,
          });
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