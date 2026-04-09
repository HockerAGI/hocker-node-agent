import { z } from "zod";
import "dotenv/config";

function readString(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

const Schema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  pollMs: z.coerce.number().int().positive().default(2000),

  projectId: z.string().min(1).default("global"),
  nodeId: z.string().min(1).default("hocker-node-1"),

  orchestratorUrl: z.string().trim().default(""),

  supabase: z.object({
    url: z.string().url(),
    serviceRoleKey: z.string().min(20),
  }),

  commandHmacSecret: z.string().min(24),

  sandboxRoot: z.string().default("./sandbox"),

  langfuse: z.object({
    publicKey: z.string().default("dummy"),
    secretKey: z.string().default("dummy"),
    baseUrl: z.string().url().default("https://cloud.langfuse.com"),
  }),
});

export type Config = z.infer<typeof Schema>;

export const config: Config = Schema.parse({
  port: readString("PORT") ?? 8080,
  pollMs: readString("POLL_MS") ?? 2000,

  projectId: readString("PROJECT_ID", "HOCKER_PROJECT_ID") ?? "global",
  nodeId: readString("NODE_ID") ?? "hocker-node-1",

  orchestratorUrl: readString("ORCHESTRATOR_URL") ?? "",

  supabase: {
    url: readString("SUPABASE_URL"),
    serviceRoleKey: readString("SUPABASE_SERVICE_ROLE_KEY"),
  },

  commandHmacSecret: readString("COMMAND_HMAC_SECRET"),

  sandboxRoot: readString("SANDBOX_ROOT") ?? "./sandbox",

  langfuse: {
    publicKey: readString("LANGFUSE_PUBLIC_KEY") ?? "dummy",
    secretKey: readString("LANGFUSE_SECRET_KEY") ?? "dummy",
    baseUrl: readString("LANGFUSE_BASE_URL") ?? "https://cloud.langfuse.com",
  },
});
