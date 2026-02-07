import crypto from "node:crypto";
import { stableStringify } from "./stable-json.js";

export function signCommand(
  secret: string,
  input: { id: string; project_id: string; node_id: string; command: string; payload: any }
) {
  const base = [
    String(input.id),
    String(input.project_id),
    String(input.node_id),
    String(input.command),
    stableStringify(input.payload ?? {})
  ].join(".");
  return crypto.createHmac("sha256", secret).update(base).digest("hex");
}

export function verifySignature(
  secret: string,
  sig: string,
  input: { id: string; project_id: string; node_id: string; command: string; payload: any }
) {
  const expected = signCommand(secret, input);
  const a = Buffer.from(String(sig || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}