import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { JsonObject } from "../types.js";

const exec = promisify(execCb);

type DB = {
  public: {
    Tables: {
      commands: {
        Row: {
          id: string;
          project_id: string;
          node_id: string;
          command: string;
          payload: JsonObject;
          signature: string;
          status: string;
          result: JsonObject | null;
          error: string | null;
          created_at: string;
          executed_at: string | null;
        };
      };
      events: {
        Row: {
          id: string;
          project_id: string;
          node_id: string | null;
          type: string;
          message: string;
          level: string;
          data: JsonObject | null;
          created_at: string;
        };
      };
    };
  };
};

export function createAdminSupabase(): SupabaseClient<DB> {
  return createClient<DB>(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function rootDir(): string {
  return process.env.HOCKER_SANDBOX_ROOT?.trim() || process.cwd();
}

function safePath(relPath: string): string {
  const root = path.resolve(rootDir());
  const resolved = path.resolve(root, relPath || ".");
  if (!resolved.startsWith(root)) {
    throw new Error("Sandbox escape bloqueado.");
  }
  return resolved;
}

export async function listDir(relPath: string) {
  const dir = safePath(relPath);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    isFile: e.isFile(),
    isDirectory: e.isDirectory(),
  }));
}

export async function readFileHead(relPath: string, maxBytes = 4096) {
  const file = safePath(relPath);
  const buf = await fs.readFile(file);
  const slice = buf.subarray(0, Math.max(128, Math.min(maxBytes, 256 * 1024)));
  return {
    bytes: slice.length,
    text: slice.toString("utf8"),
  };
}

export async function executeLocalShell(script: string, timeout = 120000) {
  const { stdout, stderr } = await exec(script, {
    cwd: rootDir(),
    shell: "/bin/sh",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });

  return { ok: true, stdout, stderr };
}

export async function writeLocalFile(relPath: string, content: string) {
  const file = safePath(relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}