import crypto from "node:crypto";

function canonicalJson(value: any): string {
  const sortKeysDeep = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (v && typeof v === "object") {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
      return out;
    }
    return v;
  };

  return JSON.stringify(sortKeysDeep(value ?? {}));
}

/**
 * Firma v2 (recomendada y default):
 * id|project_id|node_id|command|created_at|canonical(payload)
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

// --- Compatibilidad (firmas viejas) ---
function stableJson(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

/** v1-hex: id:created_at:stableJson(payload) */
function signCommandV1Hex(secret: string, id: string, created_at: string, payload: any): string {
  const base = `${id}:${created_at}:${stableJson(payload ?? {})}`;
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

/** v1-base64: id.created_at.stableJson(payload) */
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

  // 1) v2 (actual)
  const v2 = signCommandV2(secret, id, project_id, node_id, command, payload, created_at);
  if (timingSafeEq(signature, v2)) return true;

  // 2) legacy
  const v1hex = signCommandV1Hex(secret, id, created_at, payload);
  if (timingSafeEq(signature, v1hex)) return true;

  const v1b64 = signCommandV1B64(secret, id, created_at, payload);
  if (timingSafeEq(signature, v1b64)) return true;

  return false;
}
