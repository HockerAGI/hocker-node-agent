import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ExecutionResult = {
  ok: boolean;
  data?: any;
  error?: string;
};

/**
 * Ejecuta comandos mapeados a acciones físicas en la computadora.
 */
export async function executeLocalCommand(command: string, payload: any): Promise<ExecutionResult> {
  try {
    switch (command) {
      case "shell.exec":
        // Ejecuta un comando en la terminal local
        const script = payload?.script;
        if (!script) throw new Error("Falta payload.script para shell.exec");
        
        const { stdout, stderr } = await execAsync(script, { timeout: 60000 }); // Timeout de 1 min por seguridad
        return { ok: true, data: { stdout: stdout.trim(), stderr: stderr.trim() } };

      case "fs.write":
        // Ejemplo: Escribir un archivo de configuración en disco
        const fs = await import("node:fs/promises");
        const path = payload?.path;
        const content = payload?.content;
        if (!path || !content) throw new Error("Falta path o content para fs.write");
        
        await fs.writeFile(path, content, "utf-8");
        return { ok: true, data: { message: `Archivo escrito exitosamente en ${path}` } };

      case "ping":
        // Prueba de latencia básica
        return { ok: true, data: { message: "pong", timestamp: new Date().toISOString() } };

      default:
        // Si el agente no reconoce el comando nativo
        return { ok: false, error: `Comando '${command}' no soportado por este Agente Físico.` };
    }
  } catch (error: any) {
    return { ok: false, error: error.message || "Error desconocido en el sandbox." };
  }
}