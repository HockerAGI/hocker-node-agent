import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Ordena las llaves de un objeto de forma profunda para garantizar
 * que el JSON.stringify siempre produzca exactamente el mismo string.
 * ESTA FUNCIÓN DEBE SER IDÉNTICA A LA DE nova.agi Y hocker.one.
 */
function sortKeysDeep(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(obj[key]);
        return acc;
      }, {} as Record<string, any>);
  }
  return obj;
}

/**
 * Verifica la firma criptográfica (Protocolo AEGIS/VERTX) de un comando entrante.
 * Retorna true si la firma es válida y el comando es seguro para ejecutar.
 */
export function verifyCommandSignature(
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: any,
  created_at: string,
  providedSignature: string
): boolean {
  try {
    const sortedPayload = sortKeysDeep(payload || {});
    const payloadStr = JSON.stringify(sortedPayload);
    
    // Matriz de integridad estricta (Mismo orden que en nova.agi)
    const data = `${id}|${project_id}|${node_id}|${command}|${payloadStr}|${created_at}`;
    
    const expectedSignature = crypto
      .createHmac("sha256", config.commandHmacSecret)
      .update(data)
      .digest("hex");

    // Previene ataques de timing (Timing attacks)
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(providedSignature)
    );
  } catch (error) {
    console.error("[VERTX SECURITY ERROR] Fallo en la validación de firma:", error);
    return false;
  }
}