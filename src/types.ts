export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentStatus = "idle" | "running" | "degraded" | "offline";

export interface AgentCommand {
  id: string;
  project_id: string;
  node_id: string;
  command: string;
  payload: JsonObject;
  signature: string;
  created_at: string;
}

export interface AgentResult {
  ok: boolean;
  command_id: string;
  node_id: string;
  project_id: string;
  result?: JsonObject;
  error?: string;
}