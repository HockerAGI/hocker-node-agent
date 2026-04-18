import { createHmac, timingSafeEqual } from "node:crypto";
import { stableJson } from "../stable-json.js";
import type { JsonObject } from "../types.js";

function canonicalPayload(
  id: string,
  projectId: string,
  nodeId: string,
  command: string,
  createdAt: string,
  payload: JsonObject
): string {
  return [
    id.trim(),
    projectId.trim(),
    nodeId.trim(),
    command.trim(),
    createdAt.trim(),
    stableJson(payload ?? {}),
  ].join("|");
}

export function signCommand(
  secret: string,
  id: string,
  projectId: string,
  nodeId: string,
  command: string,
  payload: JsonObject,
  createdAt: string
): string {
  const body = canonicalPayload(id, projectId, nodeId, command, createdAt, payload);
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyCommand(
  secret: string,
  id: string,
  projectId: string,
  nodeId: string,
  command: string,
  payload: JsonObject,
  createdAt: string,
  signature: string,
  maxAgeMs: number,
  nowMs = Date.now()
): boolean {
  if (!secret || secret.length < 24) return false;
  if (!signature || signature.length < 32) return false;

  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return false;

  const age = Math.abs(nowMs - createdAtMs);
  if (age > maxAgeMs) return false;

  const expected = signCommand(secret, id, projectId, nodeId, command, payload, createdAt);

  try {
    const expectedBuf = Buffer.from(expected, "hex");
    const receivedBuf = Buffer.from(signature, "hex");
    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}