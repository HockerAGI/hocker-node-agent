import { z } from "zod";
import "dotenv/config";

const Schema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  pollMs: z.coerce.number().int().positive().default(2000),
  
  projectId: z.string().min(1).default("global"),
  nodeId: z.string().min(1).default("hocker-node-1"),
  
  supabase: z.object({
    url: z.string().url(),
    serviceRoleKey: z.string().min(20)
  }),

  commandHmacSecret: z.string().min(24),

  sandboxRoot: z.string().default("./sandbox"),

  langfuse: z.object({
    publicKey: z.string().default("dummy"),
    secretKey: z.string().default("dummy"),
    baseUrl: z.string().url().default("https://cloud.langfuse.com")
  })
});

export type Config = z.infer<typeof Schema>;

export const config: Config = Schema.parse({
  port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
  pollMs: process.env.POLL_MS ? parseInt(process.env.POLL_MS) : 2000,
  
  projectId: process.env.PROJECT_ID || process.env.HOCKER_PROJECT_ID || "global",
  nodeId: process.env.NODE_ID || "hocker-node-1",
  
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },
  
  commandHmacSecret: process.env.COMMAND_HMAC_SECRET,
  
  sandboxRoot: process.env.SANDBOX_ROOT || "./sandbox",

  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || "dummy",
    secretKey: process.env.LANGFUSE_SECRET_KEY || "dummy",
    baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"
  }
});