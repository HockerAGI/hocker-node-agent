import crypto from "node:crypto";

function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

export function canonicalJson(value: any): string {
  const normalized = sortKeysDeep(value ?? {});
  return JSON.stringify(normalized);
}

/**
 * Firma HMAC estable (debe match con hocker.one signCommand):
 * base = id | project_id | node_id | command | created_at | canonical(payload)
 */
export function signCommand(
  secret: string,
  id: string,
  project_id: string,
  node_id: string,
  command: string,
  payload: any,
  created_at: string
): string {
  const base = [
    id,
    project_id,
    node_id,
    command,
    created_at,
    canonicalJson(payload),
  ].join("|");

  return crypto.createHmac("sha256", secret).update(base).digest("hex");
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
  const expected = signCommand(secret, id, project_id, node_id, command, payload, created_at);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}