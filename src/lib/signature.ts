import crypto from "node:crypto";

function sortKeysDeep(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeysDeep(obj[k]);
    return out;
  }
  return obj;
}

function canonicalJson(value: any): string {
  return JSON.stringify(sortKeysDeep(value ?? {}));
}

/**
 * ✅ ESTÁNDAR REAL (alineado con hocker.one y nova.agi)
 * base = id|project_id|node_id|command|created_at|canonical(payload)
 */
export function signCommandV2(
  secret: string,
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: any,
  created_at: string
): string {
  const base = [id, project_id, node_id, command, created_at, canonicalJson(payload)].join("|");
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

/**
 * Legacy V1 (compat): no lo usamos para firmar, solo para verificar si hay comandos viejos.
 */
function stableJson(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as any)[k])}`).join(",")}}`;
}

function signCommandV1Hex(secret: string, id: string, created_at: string, payload: any): string {
  const base = `${id}:${created_at}:${stableJson(payload ?? {})}`;
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

function signCommandV1B64(secret: string, id: string, created_at: string, payload: any): string {
  const base = `${id}.${created_at}.${stableJson(payload ?? {})}`;
  return crypto.createHmac("sha256", secret).update(base).digest("base64");
}

function timingSafeEq(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function verifyCommand(
  secret: string,
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: any,
  created_at: string,
  signature: string | null | undefined
): boolean {
  if (!signature) return false;

  // ✅ principal
  if (timingSafeEq(signature, signCommandV2(secret, id, project_id, node_id, command, payload, created_at))) return true;

  // legacy
  if (timingSafeEq(signature, signCommandV1Hex(secret, id, created_at, payload))) return true;
  if (timingSafeEq(signature, signCommandV1B64(secret, id, created_at, payload))) return true;

  return false;
}