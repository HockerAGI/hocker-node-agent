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

// 1. NUEVA FIRMA FABRIC (Alineada con NOVA AGI y Hocker One)
export function signCommandFabric(
  secret: string,
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: any,
  created_at: string
): string {
  const payloadStr = canonicalJson(payload);
  const data = `${id}|${project_id}|${node_id}|${command}|${payloadStr}|${created_at}`;
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

// 2. FIRMA V2 ORIGINAL
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

  // 1) Fabric (Nuevo estándar)
  if (timingSafeEq(signature, signCommandFabric(secret, id, project_id, node_id, command, payload, created_at))) return true;
  // 2) V2 (Original)
  if (timingSafeEq(signature, signCommandV2(secret, id, project_id, node_id, command, payload, created_at))) return true;
  // 3) Legacy V1
  if (timingSafeEq(signature, signCommandV1Hex(secret, id, created_at, payload))) return true;
  if (timingSafeEq(signature, signCommandV1B64(secret, id, created_at, payload))) return true;

  return false;
}