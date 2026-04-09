import crypto from "node:crypto";

// ─── Helpers internos ────────────────────────────────────────────────────────

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value ?? {}));
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
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

// ─── Algoritmos de firma ─────────────────────────────────────────────────────

/**
 * Algoritmo principal (Fabric v2).
 * Cubre: id, project_id, node_id, command, created_at, payload (JSON canónico).
 */
export function signCommand(
  secret: string,
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: unknown,
  created_at: string
): string {
  const base = [id, project_id, node_id, command, created_at, canonicalJson(payload)].join("|");
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

/** Algoritmo legado v1 — hex. Mantenido solo para compatibilidad con comandos existentes. */
function signLegacyHex(secret: string, id: string, created_at: string, payload: unknown): string {
  const base = `${id}:${created_at}:${stableJson(payload ?? {})}`;
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

/** Algoritmo legado v1 — base64. Mantenido solo para compatibilidad con comandos existentes. */
function signLegacyB64(secret: string, id: string, created_at: string, payload: unknown): string {
  const base = `${id}.${created_at}.${stableJson(payload ?? {})}`;
  return crypto.createHmac("sha256", secret).update(base).digest("base64");
}

// ─── Verificación ─────────────────────────────────────────────────────────────

/**
 * Verifica una firma contra todos los algoritmos activos y legados.
 * Retorna `true` si alguno coincide (comparación de tiempo constante).
 */
export function verifyCommand(
  secret: string,
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: unknown,
  created_at: string,
  signature: string | null | undefined
): boolean {
  if (!signature) return false;

  const current = signCommand(secret, id, project_id, node_id, command, payload, created_at);
  if (timingSafeEq(signature, current)) return true;

  if (timingSafeEq(signature, signLegacyHex(secret, id, created_at, payload))) return true;
  if (timingSafeEq(signature, signLegacyB64(secret, id, created_at, payload))) return true;

  return false;
}
