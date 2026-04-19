export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type CommandStatus = "queued" | "needs_approval" | "running" | "done" | "error" | "canceled";

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
  sandbox_root: string;
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