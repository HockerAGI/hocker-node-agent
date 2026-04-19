import "dotenv/config";
import { z } from "zod";

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

const Schema = z.object({
  port: z.coerce.number().int().positive().default(8081),
  projectId: z.string().default("hocker-one"),
  nodeId: z.string().default("hocker-node-1"),
  pollMs: z.coerce.number().int().positive().default(5000),

  commandHmacSecret: z.string().min(24),
  orchestratorUrl: z.string().url().optional().default(""),

  supabase: z.object({
    url: z.string().url(),
    serviceRoleKey: z.string().min(20),
  }),

  langfuse: z.object({
    publicKey: z.string().optional().default(""),
    secretKey: z.string().optional().default(""),
    baseUrl: z.string().url().default("https://cloud.langfuse.com"),
  }),

  sandboxEnabled: z.coerce.boolean().default(true),
});

export const config = Schema.parse({
  port: Number(read("PORT") || 8081),
  projectId: read("PROJECT_ID") || "hocker-one",
  nodeId: read("NODE_ID") || "hocker-node-1",
  pollMs: Number(read("POLL_MS") || 5000),
  commandHmacSecret: read("HOCKER_COMMAND_HMAC_SECRET"),
  orchestratorUrl: read("ORCHESTRATOR_URL") || "",
  supabase: {
    url: read("SUPABASE_URL"),
    serviceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  },
  langfuse: {
    publicKey: read("LANGFUSE_PUBLIC_KEY"),
    secretKey: read("LANGFUSE_SECRET_KEY"),
    baseUrl: read("LANGFUSE_BASE_URL") || "https://cloud.langfuse.com",
  },
  sandboxEnabled: String(read("SANDBOX_ENABLED") || "true").toLowerCase() === "true",
});