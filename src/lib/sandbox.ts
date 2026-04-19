import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { DirEntryInfo, FileHeadResult, JsonObject, ShellExecResult } from "../types.js";

const execFileAsync = promisify(execFile);

export function rootDir(): string {
  return path.resolve(config.sandbox.root);
}

export async function ensureSandbox(): Promise<void> {
  await fs.mkdir(rootDir(), { recursive: true });
}

function assertInsideRoot(candidate: string): string {
  const root = rootDir();
  const resolved = path.resolve(root, candidate || ".");
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Sandbox escape bloqueado.");
  }
  return resolved;
}

export function safeMetadata(): JsonObject {
  return {
    root: rootDir(),
    enabled: config.sandbox.enabled,
    platform: process.platform,
    version: process.version,
  };
}

export async function listDir(relPath: string): Promise<DirEntryInfo[]> {
  const dir = assertInsideRoot(relPath);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: DirEntryInfo[] = [];

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const stat = await fs.lstat(abs);
    result.push({
      name: entry.name,
      type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  return result;
}

export async function readFileHead(relPath: string, maxBytes = 4096): Promise<FileHeadResult> {
  const file = assertInsideRoot(relPath);
  const buf = await fs.readFile(file);
  const slice = buf.subarray(0, Math.max(128, Math.min(maxBytes, 256 * 1024)));
  return { bytes: slice.length, text: slice.toString("utf8") };
}

export async function writeLocalFile(relPath: string, content: string): Promise<string> {
  const file = assertInsideRoot(relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}

export async function executeLocalShell(script: string, timeout = 30_000): Promise<ShellExecResult> {
  const start = Date.now();

  const result = await execFileAsync("/bin/sh", ["-lc", script], {
    cwd: rootDir(),
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: rootDir(),
      TMPDIR: path.join(rootDir(), ".tmp"),
    },
  }).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: NodeJS.Signals | null; code?: number | null; killed?: boolean }) => {
    return {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message),
      code: typeof error.code === "number" ? error.code : null,
      signal: error.signal ?? null,
      killed: Boolean(error.killed),
    };
  });

  return {
    ok: true,
    exitCode: "code" in result ? (result.code ?? 0) : 0,
    signal: "signal" in result ? (result.signal ?? null) : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: Boolean("killed" in result && result.killed),
    elapsedMs: Date.now() - start,
  };
}