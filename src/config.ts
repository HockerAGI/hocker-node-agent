import "dotenv/config";
import { z } from "zod";
import type { Config } from "./types.js";

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = read(name);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

const nullableString = z.preprocess((value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().nullable());

const nullableUrl = z.preprocess((value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().url().nullable());

const Schema = z.object({
  port: z.coerce.number().int().positive().default(8081),
  pollMs: z.coerce.number().int().positive().default(2000),
  projectId: z.string().min(1).default("hocker-one"),
  nodeId: z.string().min(1).default("hocker-node-1"),
  agentKey: z.string().min(16, "HOCKER_AGENT_KEY must be at least 16 characters"),
  hmacSecret: z.string().min(24, "HOCKER_COMMAND_HMAC_SECRET must be at least 24 characters"),
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(20),
  maxCommandAgeMs: z.coerce.number().int().positive().default(5 * 60 * 1000),
  sandboxEnabled: z.boolean().default(true),
  sandboxRoot: z.string().min(1).default("./sandbox"),
  orchestratorUrl: nullableUrl,
  langfusePublicKey: nullableString,
  langfuseSecretKey: nullableString,
  langfuseBaseUrl: z.string().url().default("https://cloud.langfuse.com"),
});

const parsed = Schema.parse({
  port: read("PORT") || 8081,
  pollMs: read("POLL_MS") || 2000,
  projectId: read("PROJECT_ID") || "hocker-one",
  nodeId: read("NODE_ID") || "hocker-node-1",
  agentKey: read("HOCKER_AGENT_KEY"),
  hmacSecret: read("HOCKER_COMMAND_HMAC_SECRET"),
  supabaseUrl: read("SUPABASE_URL"),
  supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  maxCommandAgeMs: read("MAX_COMMAND_AGE_MS") || 300000,
  sandboxEnabled: readBool("SANDBOX_ENABLED", true),
  sandboxRoot: read("SANDBOX_ROOT") || "./sandbox",
  orchestratorUrl: read("ORCHESTRATOR_URL") || null,
  langfusePublicKey: read("LANGFUSE_PUBLIC_KEY") || null,
  langfuseSecretKey: read("LANGFUSE_SECRET_KEY") || null,
  langfuseBaseUrl: read("LANGFUSE_BASE_URL") || "https://cloud.langfuse.com",
});

export const config: Config = {
  ...parsed,
  langfuse: {
    publicKey: parsed.langfusePublicKey,
    secretKey: parsed.langfuseSecretKey,
    baseUrl: parsed.langfuseBaseUrl,
  },
};