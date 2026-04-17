import "dotenv/config";
import { z } from "zod";

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

const Schema = z.object({
  port: z.coerce.number().int().positive().default(8081),
  projectId: z.string().default("hocker-one"),
  nodeId: z.string().default("hocker-node-1"),
  agentKey: z.string().min(16),
  hmacSecret: z.string().min(24),
  supabaseUrl: z.string().url(),
  supabaseServiceRoleKey: z.string().min(20),
  maxCommandAgeMs: z.coerce.number().int().positive().default(5 * 60 * 1000),
  sandboxEnabled: z.coerce.boolean().default(true)
});

export const config = Schema.parse({
  port: Number(read("PORT") || 8081),
  projectId: read("PROJECT_ID") || "hocker-one",
  nodeId: read("NODE_ID") || "hocker-node-1",
  agentKey: read("HOCKER_AGENT_KEY"),
  hmacSecret: read("HOCKER_COMMAND_HMAC_SECRET"),
  supabaseUrl: read("SUPABASE_URL"),
  supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  maxCommandAgeMs: Number(read("MAX_COMMAND_AGE_MS") || 300000),
  sandboxEnabled: String(read("SANDBOX_ENABLED") || "true").toLowerCase() === "true"
});