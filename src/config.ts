import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function read(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = read(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} debe ser true o false.`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

const Schema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  allowLan: z.boolean().default(false),
  port: z.coerce.number().int().positive().max(65535).default(8081),
  projectId: z.string().regex(SAFE_ID).default("hocker-one"),
  nodeId: z.string().regex(SAFE_ID).default("hocker-node-1"),
  pollMs: z.coerce.number().int().min(250).max(60_000).default(5000),
  heartbeatMs: z.coerce.number().int().min(1000).max(600_000).default(15000),
  maxCommandAgeMs: z.coerce.number().int().min(10_000).max(3_600_000).default(5 * 60 * 1000),
  commandHmacSecret: z.string().min(24),
  agentKey: z.string().min(24),
  orchestratorUrl: z.string().url().optional().or(z.literal("")).default(""),
  shellExecEnabled: z.boolean().default(false),
  supabase: z.object({
    url: z.string().url(),
    serviceRoleKey: z.string().min(20),
  }),
  sandbox: z.object({
    enabled: z.boolean().default(true),
    root: z.string().min(1),
  }),
  mirror: z.object({
    enabled: z.boolean().default(false),
    primaryNodeId: z.string().default(""),
    mirrorNodeId: z.string().default(""),
  }),
});

const parsed = Schema.parse({
  host: read("HOCKER_AGENT_HOST") || "127.0.0.1",
  allowLan: readBoolean("HOCKER_AGENT_ALLOW_LAN", false),
  port: read("PORT") || 8081,
  projectId: read("PROJECT_ID") || "hocker-one",
  nodeId: read("NODE_ID") || "hocker-node-1",
  pollMs: read("POLL_MS") || 5000,
  heartbeatMs: read("HEARTBEAT_MS") || 15000,
  maxCommandAgeMs: read("MAX_COMMAND_AGE_MS") || 5 * 60 * 1000,
  commandHmacSecret:
    read("HOCKER_COMMAND_HMAC_SECRET") || read("COMMAND_HMAC_SECRET"),
  agentKey: read("HOCKER_AGENT_KEY"),
  orchestratorUrl: read("ORCHESTRATOR_URL"),
  shellExecEnabled: readBoolean("HOCKER_ALLOW_UNSANDBOXED_SHELL", false),
  supabase: {
    url: read("SUPABASE_URL"),
    serviceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
  },
  sandbox: {
    enabled: readBoolean("SANDBOX_ENABLED", true),
    root:
      read("SANDBOX_ROOT") ||
      read("HOCKER_SANDBOX_ROOT") ||
      path.resolve(process.cwd(), "sandbox"),
  },
  mirror: {
    enabled: readBoolean("MIRROR_ENABLED", false),
    primaryNodeId: read("MIRROR_PRIMARY_NODE_ID") || "",
    mirrorNodeId: read("MIRROR_NODE_ID") || "",
  },
});

if (!isLoopbackHost(parsed.host) && !parsed.allowLan) {
  throw new Error(
    "HOCKER_AGENT_HOST expone una interfaz no local. Define HOCKER_AGENT_ALLOW_LAN=true de forma explícita para habilitar acceso LAN.",
  );
}

if (parsed.commandHmacSecret === parsed.agentKey) {
  throw new Error(
    "HOCKER_AGENT_KEY y HOCKER_COMMAND_HMAC_SECRET deben ser secretos distintos.",
  );
}

if (parsed.shellExecEnabled && !parsed.sandbox.enabled) {
  throw new Error("shell.exec requiere SANDBOX_ENABLED=true.");
}

const sandboxRoot = path.resolve(parsed.sandbox.root);
if (sandboxRoot === path.parse(sandboxRoot).root) {
  throw new Error("SANDBOX_ROOT no puede ser la raíz del sistema de archivos.");
}

if (parsed.mirror.enabled) {
  if (!SAFE_ID.test(parsed.mirror.primaryNodeId) || !SAFE_ID.test(parsed.mirror.mirrorNodeId)) {
    throw new Error(
      "MIRROR_PRIMARY_NODE_ID y MIRROR_NODE_ID son obligatorios y deben ser IDs seguros cuando MIRROR_ENABLED=true.",
    );
  }
  if (parsed.mirror.mirrorNodeId === parsed.nodeId) {
    throw new Error("MIRROR_NODE_ID debe ser distinto de NODE_ID.");
  }
}

export const config = {
  ...parsed,
  sandbox: {
    ...parsed.sandbox,
    root: sandboxRoot,
  },
};
