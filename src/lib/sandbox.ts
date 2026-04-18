import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DirEntryInfo, FileHeadResult, JsonObject, ShellExecResult } from "../types.js";

const execFileAsync = promisify(execFile);

const BLOCKED_SCRIPT_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/\b/i,
  /\brm\s+-rf\s+\*\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\binit\s+0\b/i,
  /\bhalt\b/i,
  /\bdd\s+if=/i,
  /\b:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/i,
  /\bsudo\b/i,
  /\buseradd\b/i,
  /\bgroupadd\b/i,
  /\bchown\s+-R\s+root:root\s+\/\b/i,
  /\bchmod\s+777\s+\/\b/i,
];

function ensureSandboxRoot(root: string): string {
  return path.resolve(root);
}

function ensureInsideRoot(root: string, target: string): string {
  const resolvedRoot = ensureSandboxRoot(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);

  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes sandbox: ${target}`);
  }

  return resolvedTarget;
}

function detectEntryType(entry: Awaited<ReturnType<typeof readdir>>[number]): DirEntryInfo["type"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function assertSafeScript(script: string): void {
  const normalized = script.trim();
  if (!normalized) {
    throw new Error("Empty shell script");
  }

  for (const pattern of BLOCKED_SCRIPT_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`Blocked shell script pattern detected: ${pattern.source}`);
    }
  }
}

export async function ensureSandbox(root: string): Promise<string> {
  const resolved = ensureSandboxRoot(root);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export async function listDir(root: string, relPath = "."): Promise<DirEntryInfo[]> {
  const sandboxRoot = await ensureSandbox(root);
  const abs = ensureInsideRoot(sandboxRoot, relPath);
  const entries = await readdir(abs, { withFileTypes: true });

  const result: DirEntryInfo[] = [];
  for (const entry of entries) {
    const entryPath = path.join(abs, entry.name);
    const info = await stat(entryPath);
    result.push({
      name: entry.name,
      type: detectEntryType(entry),
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFileHead(
  root: string,
  relPath: string,
  maxBytes = 4096
): Promise<FileHeadResult> {
  const sandboxRoot = await ensureSandbox(root);
  const abs = ensureInsideRoot(sandboxRoot, relPath);

  const limit = Math.min(Math.max(maxBytes, 128), 256 * 1024);
  const file = await readFile(abs);
  const slice = file.subarray(0, limit);

  return {
    bytes: slice.length,
    text: slice.toString("utf8"),
  };
}

export async function writeLocalFile(
  root: string,
  relPath: string,
  content: string
): Promise<string> {
  const sandboxRoot = await ensureSandbox(root);
  const abs = ensureInsideRoot(sandboxRoot, relPath);

  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");

  return path.relative(sandboxRoot, abs);
}

export async function executeLocalShell(
  root: string,
  script: string,
  timeoutMs = 120_000
): Promise<ShellExecResult> {
  const sandboxRoot = await ensureSandbox(root);
  assertSafeScript(script);

  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", script], {
      cwd: sandboxRoot,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: sandboxRoot,
        TMPDIR: path.join(sandboxRoot, ".tmp"),
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      },
    });

    return {
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      timedOut: false,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number | null;
      signal?: NodeJS.Signals | null;
      timedOut?: boolean;
      killed?: boolean;
      message?: string;
    };

    return {
      ok: true,
      exitCode: typeof err.code === "number" ? err.code : err.killed ? 137 : null,
      signal: err.signal ?? null,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? "shell execution failed"),
      timedOut: Boolean(err.timedOut),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export function safeMetadata(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}