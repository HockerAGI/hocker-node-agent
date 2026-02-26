import { config } from "./config.js";
import { sb } from "./supabase.js";
import { verifyCommandSignature } from "./security.js";
import { executeLocalCommand } from "./lib/sandbox.js";
import { Langfuse } from "langfuse-node";

// Conexión Cuántica a la memoria de Syntia
const langfuse = new Langfuse({
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  baseUrl: config.langfuse.baseUrl,
});

// UX/UI de Terminal (Colores ANSI)
const C = {
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", 
  red: "\x1b[31m", dim: "\x1b[90m", reset: "\x1b[0m", bold: "\x1b[1m"
};

function printBanner() {
  console.clear();
  console.log(C.cyan + C.bold + `
  ██╗  ██╗ ██████╗  ██████╗██╗  ██╗███████╗██████╗ 
  ██║  ██║██╔═══██╗██╔════╝██║ ██╔╝██╔════╝██╔══██╗
  ███████║██║   ██║██║     █████╔╝ █████╗  ██████╔╝
  ██╔══██║██║   ██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗
  ██║  ██║╚██████╔╝╚██████╗██║  ██╗███████╗██║  ██║
  ╚═╝  ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ` + C.reset);
  console.log(`${C.dim}======================================================${C.reset}`);
  console.log(`${C.bold} AGENTE FANTASMA (Zero-Trust) v2.0 - ONLINE${C.reset}`);
  console.log(`${C.dim} Node ID    :${C.reset} ${C.green}${config.nodeId}${C.reset}`);
  console.log(`${C.dim} Project ID :${C.reset} ${C.green}${config.projectId}${C.reset}`);
  console.log(`${C.dim} Signature  :${C.reset} ${C.cyan}AEGIS HMAC-SHA256 Active${C.reset}`);
  console.log(`${C.dim}======================================================${C.reset}\n`);
}

async function sendHeartbeat() {
  try {
    await sb.from("nodes").upsert({
      id: config.nodeId,
      project_id: config.projectId,
      name: `Ghost Node: ${config.nodeId}`,
      status: "online",
      last_seen_at: new Date().toISOString(),
      tags: ["physical", "on-premise", "stealth"],
      meta: { engine: "hocker-node-agent", os: process.platform }
    }, { onConflict: "id" });
  } catch (err) {}
}

async function pollCommands() {
  try {
    const { data: commands, error } = await sb
      .from("commands")
      .select("*")
      .eq("project_id", config.projectId)
      .eq("node_id", config.nodeId)
      .eq("status", "queued")
      .eq("needs_approval", false)
      .order("created_at", { ascending: true })
      .limit(3);

    if (error) throw error;
    if (!commands || commands.length === 0) return;

    for (const cmd of commands) {
      const trace = langfuse.trace({ name: "Physical_Node_Execution", metadata: { commandId: cmd.id } });
      const timestamp = new Date().toLocaleTimeString();
      console.log(`${C.dim}[${timestamp}]${C.reset} ${C.yellow}⚡ INTERCEPCIÓN:${C.reset} ${cmd.command} ${C.dim}(${cmd.id.split('-')[0]})${C.reset}`);

      // Validación Zero-Trust
      const isValid = verifyCommandSignature(
        cmd.id, cmd.project_id, cmd.node_id, cmd.command, cmd.payload, cmd.created_at, cmd.signature
      );

      if (!isValid) {
        console.log(`${C.dim}[${timestamp}]${C.reset} ${C.red}☠️  ALERTA VERTX: Firma inválida. Paquete destruido.${C.reset}`);
        await sb.from("commands").update({ status: "error", error_text: "Fallo de validación criptográfica." }).eq("id", cmd.id);
        trace.event({ name: "Signature_Failed", level: "CRITICAL" });
        await langfuse.flushAsync();
        continue;
      }

      await sb.from("commands").update({ status: "running", executed_at: new Date().toISOString() }).eq("id", cmd.id);
      
      // Ejecución en Sandbox
      const result = await executeLocalCommand(cmd.command, cmd.payload);

      if (result.ok) {
        await sb.from("commands").update({ status: "done", result: result.data, finished_at: new Date().toISOString() }).eq("id", cmd.id);
        trace.event({ name: "Command_Success", output: result.data });
        console.log(`${C.dim}[${timestamp}]${C.reset} ${C.green}✓  ÉXITO:${C.reset} Operación finalizada.`);
      } else {
        await sb.from("commands").update({ status: "failed", error_text: result.error, finished_at: new Date().toISOString() }).eq("id", cmd.id);
        trace.event({ name: "Command_Failed", level: "ERROR", statusMessage: result.error });
        console.log(`${C.dim}[${timestamp}]${C.reset} ${C.red}✖  FALLO:${C.reset} ${result.error}`);
      }
      await langfuse.flushAsync();
    }
  } catch (err: any) {}
}

printBanner();
sendHeartbeat();
setInterval(sendHeartbeat, 30000); 
setInterval(pollCommands, 3000);   

process.on("SIGINT", async () => {
  console.log(`\n${C.red}[!] Iniciando protocolo de apagado fantasma...${C.reset}`);
  await sb.from("nodes").update({ status: "offline" }).eq("id", config.nodeId);
  await langfuse.flushAsync();
  process.exit(0);
});