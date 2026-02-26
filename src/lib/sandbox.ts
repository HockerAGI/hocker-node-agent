import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ExecutionResult = {
  ok: boolean;
  data?: any;
  error?: string;
};

/**
 * Motor de Ejecución Física (Hacker/NASA Level)
 * Capaz de ejecutar procesos efímeros o sesiones largas de Chido Wins.
 */
export async function executeLocalCommand(command: string, payload: any): Promise<ExecutionResult> {
  try {
    switch (command) {
      case "shell.exec":
        const script = payload?.script;
        // Dinámico: Si es un bot de casino, le damos hasta 15 minutos (900000ms), si no, 2 mins.
        const timeoutMs = payload?.timeout || 120000; 
        
        if (!script) throw new Error("Falla táctica: Falta payload.script");
        
        // Ejecución robusta con buffer amplio para logs pesados de Python/Selenium
        const { stdout, stderr } = await execAsync(script, { 
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 10 // 10MB de buffer para evitar crash por logs
        }); 
        
        return { ok: true, data: { stdout: stdout.trim(), stderr: stderr.trim() } };

      case "fs.write":
        const fs = await import("node:fs/promises");
        const path = payload?.path;
        const content = payload?.content;
        if (!path || !content) throw new Error("Falla táctica: Falta path o content");
        
        await fs.writeFile(path, content, "utf-8");
        return { ok: true, data: { message: `Archivo inyectado en ${path}` } };

      case "ping":
        return { ok: true, data: { message: "pong", timestamp: new Date().toISOString() } };

      default:
        return { ok: false, error: `Protocolo desconocido: '${command}' no está mapeado en la Matriz local.` };
    }
  } catch (error: any) {
    // Si el proceso es asesinado por timeout, avisamos a Numia/NOVA para no contar la apuesta
    const isTimeout = error.killed || error.signal === 'SIGTERM';
    return { 
        ok: false, 
        error: isTimeout ? "[CRITICAL] Proceso asesinado por exceder el tiempo límite (Timeout)." : (error.message || "Error catastrófico en el sandbox.") 
    };
  }
}