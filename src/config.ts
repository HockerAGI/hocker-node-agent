import "dotenv/config";
import path from "node:path";
import { z } from "zod";

function read(name: string): string {
  return String(process.env[name] ?? "").trim();
}

const Schema = z.object({
  port: z.coerce.number().int().positive().default(8081),
  projectId: z.string().min(1).default("hocker-one"),
  nodeId: z.string().min(1).default("hocker-node-1"),
  pollMs: z.coerce.number().int().positive().default(5000),
  heartbeatMs: z.coerce.number().int().positive().default(15000),
  maxCommandAgeMs: z.coerce.number().int().positive().default(5 * 60 * 1000),
  commandHmacSecret: z.string().min(24),
  agentKey: z.string().default(""),
  orchestratorUrl: z.string().url().optional().or(z.literal("")).default(""),
  supabase: z.object({
    url: z.string().url(),
    serviceRoleKey: z.string().min(20),
  }),
  sandbox: z.object({
    enabled: z.coerce.boolean().default(true),
    root: z.string().min(1),
  }),
  mirror: z.object({
    enabled: z.coerce.boolean().default(false),
    primaryNodeId: z.string().default(""),
    mirrorNodeId: z.string().default(""),
  }),
});

const parsed = Schema.parse({
  port: read("PORT") || 8081,
  projectId: read("PROJECT_ID") || "hocker-one",
  nodeId: read("NODE_ID") || "hocker-node-1",
  pollMs: read("POLL_MS") || 5000,
  heartbeatMs: read("HEARTBEAT_MS") || 15000,
  maxCommandAgeMs: read("MAX_COMMAND_AGE_MS") || 5 * 60 * 1000,
  commandHmacSecret: read("HOCKER_COMMAND_HMAC_SECRET") || read("COMMAND_HMAC_SECRET"),
  agentKey: read("HOCKER_AGENT_KEY"),
  orchestratorUrl: read("ORCHESTRATOR_URL"),
  supabase: {
    url: read("SUPABASE_URL"),
    serviceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  },
  sandbox: {
    enabled: String(read("SANDBOX_ENABLED") || "true").toLowerCase() === "true",
    root: read("SANDBOX_ROOT") || read("HOCKER_SANDBOX_ROOT") || path.resolve(process.cwd(), "sandbox"),
  },
  mirror: {
    enabled: String(read("MIRROR_ENABLED") || "false").toLowerCase() === "true",
    primaryNodeId: read("MIRROR_PRIMARY_NODE_ID") || "",
    mirrorNodeId: read("MIRROR_NODE_ID") || "",
  },
});

export const config = parsed;