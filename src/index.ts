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

async function sendHeartbeat() {
  try {
    await sb.from("nodes").upsert({
      id: config.nodeId,
      project_id: config.projectId,
      name: `Physical Node: ${config.nodeId}`,
      status: "online",
      last_seen_at: new Date().toISOString(),
      tags: ["physical", "on-premise"],
      meta: { engine: "hocker-node-agent", os: process.platform }
    }, { onConflict: "id" });
  } catch (err: any) {
    console.error("[HEARTBEAT ERROR]", err.message);
  }
}

async function pollCommands() {
  try {
    // 1. Buscar comandos designados exclusivamente para esta máquina y que estén en cola
    const { data: commands, error } = await sb
      .from("commands")
      .select("*")
      .eq("project_id", config.projectId)
      .eq("node_id", config.nodeId)
      .eq("status", "queued")
      .eq("needs_approval", false)
      .order("created_at", { ascending: true })
      .limit(5);

    if (error) throw error;
    if (!commands || commands.length === 0) return;

    for (const cmd of commands) {
      const trace = langfuse.trace({ name: "Physical_Node_Execution", metadata: { commandId: cmd.id, nodeId: config.nodeId } });
      console.log(`[+] Comando interceptado: ${cmd.command} (${cmd.id})`);

      // 2. Protocolo Zero-Trust: Validación de Firma Criptográfica
      const isValid = verifyCommandSignature(
        cmd.id,
        cmd.project_id,
        cmd.node_id,
        cmd.command,
        cmd.payload,
        cmd.created_at,
        cmd.signature
      );

      if (!isValid) {
        console.error(`[!] ALERTA VERTX: Firma inválida para el comando ${cmd.id}. Destruyendo tarea.`);
        await sb.from("commands").update({
          status: "error",
          error_text: "Fallo de validación criptográfica (Posible inyección maliciosa).",
          finished_at: new Date().toISOString()
        }).eq("id", cmd.id);
        
        trace.event({ name: "Signature_Verification_Failed", level: "CRITICAL", input: { command: cmd.command } });
        await langfuse.flushAsync();
        continue;
      }

      // 3. Marcar como corriendo
      await sb.from("commands").update({ status: "running", executed_at: new Date().toISOString() }).eq("id", cmd.id);
      trace.event({ name: "Command_Running", input: cmd.payload });

      // 4. Ejecutar en el Sandbox físico
      const result = await executeLocalCommand(cmd.command, cmd.payload);

      // 5. Reportar resultado a la Matriz
      if (result.ok) {
        await sb.from("commands").update({
          status: "done",
          result: result.data,
          finished_at: new Date().toISOString()
        }).eq("id", cmd.id);
        trace.event({ name: "Command_Success", output: result.data });
      } else {
        await sb.from("commands").update({
          status: "failed",
          error_text: result.error,
          finished_at: new Date().toISOString()
        }).eq("id", cmd.id);
        trace.event({ name: "Command_Failed", level: "ERROR", statusMessage: result.error });
      }

      await langfuse.flushAsync();
      console.log(`[✓] Comando finalizado: ${cmd.id} -> Estado: ${result.ok ? 'EXITO' : 'FALLO'}`);
    }
  } catch (err: any) {
    console.error("[POLLING ERROR]", err.message);
  }
}

// Inicialización del Agente
console.log("=========================================");
console.log(`[*] HOCKER NODE AGENT v1.0.0 (Zero-Trust)`);
console.log(`[*] Node ID: ${config.nodeId}`);
console.log(`[*] Project ID: ${config.projectId}`);
console.log("=========================================");

// Lanzar latido inicial y comenzar ciclos
sendHeartbeat();
setInterval(sendHeartbeat, 30000); // Latido cada 30 segundos
setInterval(pollCommands, 3000);   // Pregunta por tareas cada 3 segundos

// Manejo elegante de apagado
process.on("SIGINT", async () => {
  console.log("\n[!] Señal de apagado recibida. Avisando a la matriz...");
  await sb.from("nodes").update({ status: "offline" }).eq("id", config.nodeId);
  await langfuse.flushAsync();
  process.exit(0);
});