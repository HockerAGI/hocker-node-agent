export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentStatus = "idle" | "running" | "degraded" | "offline";
export type CommandStatus = "queued" | "needs_approval" | "running" | "done" | "error" | "canceled";
export type LogLevel = "info" | "warn" | "error";

export interface AgentCommand {
  id: string;
  project_id: string;
  node_id: string;
  command: string;
  payload: JsonObject;
  signature: string;
  created_at: string;
  status?: CommandStatus;
  needs_approval?: boolean;
  started_at?: string | null;
  executed_at?: string | null;
  finished_at?: string | null;
  result?: JsonValue | null;
  error?: string | null;
}

export interface AgentResult {
  ok: boolean;
  command_id: string;
  node_id: string;
  project_id: string;
  result?: JsonObject;
  error?: string;
}

export interface Controls {
  kill_switch: boolean;
  allow_write: boolean;
}

export interface HealthResponse {
  ok: true;
  project_id: string;
  node_id: string;
  orchestrator_configured: boolean;
  sandbox_enabled: boolean;
  ts: string;
}

export interface DirEntryInfo {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export interface FileHeadResult {
  bytes: number;
  text: string;
}

export interface ShellExecResult {
  ok: true;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

export interface Config {
  port: number;
  pollMs: number;
  projectId: string;
  nodeId: string;
  agentKey: string;
  hmacSecret: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  maxCommandAgeMs: number;
  sandboxEnabled: boolean;
  sandboxRoot: string;
  orchestratorUrl: string | null;
  langfuse: {
    publicKey: string | null;
    secretKey: string | null;
    baseUrl: string;
  };
}