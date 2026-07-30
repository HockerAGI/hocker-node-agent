import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "../config.js";
import type {
  DirEntryInfo,
  FileHeadResult,
  JsonObject,
  ShellExecResult,
} from "../types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SAFE_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const NO_FOLLOW =
  typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export function rootDir(): string {
  return path.resolve(config.sandbox.root);
}

function tmpDir(): string {
  return path.join(rootDir(), ".tmp");
}

function assertSandboxEnabled(): void {
  if (!config.sandbox.enabled) {
    throw new Error("Sandbox deshabilitado.");
  }
}

function normalizeRelativePath(input: string): string {
  const value = String(input ?? "").trim();
  if (!value) return ".";
  if (value.includes("\0") || path.isAbsolute(value)) {
    throw new Error("Ruta inválida.");
  }
  return path.normalize(value);
}

function lexicalPath(candidate: string): string {
  const root = rootDir();
  const resolved = path.resolve(root, normalizeRelativePath(candidate));
  const relative = path.relative(root, resolved);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Sandbox escape bloqueado.");
  }

  return resolved;
}

function assertCanonicalInside(canonicalRoot: string, candidate: string): string {
  const relative = path.relative(canonicalRoot, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Sandbox escape por enlace simbólico bloqueado.");
  }
  return candidate;
}

async function canonicalRoot(): Promise<string> {
  await ensureSandbox();
  return fs.realpath(rootDir());
}

async function resolveExistingInside(candidate: string): Promise<string> {
  assertSandboxEnabled();
  const lexical = lexicalPath(candidate);
  const root = await canonicalRoot();
  const canonical = await fs.realpath(lexical);
  return assertCanonicalInside(root, canonical);
}

function clampMaxBytes(maxBytes: number): number {
  if (!Number.isFinite(maxBytes)) return 4096;
  return Math.max(128, Math.min(Math.trunc(maxBytes), 256 * 1024));
}

function clampTimeout(timeout: number): number {
  if (!Number.isFinite(timeout)) return 30_000;
  return Math.max(1_000, Math.min(Math.trunc(timeout), 120_000));
}

function safeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: String(process.env.PATH || DEFAULT_SAFE_PATH),
    HOME: rootDir(),
    TMPDIR: tmpDir(),
    LANG: String(process.env.LANG || "C.UTF-8"),
    LC_ALL: String(process.env.LC_ALL || "C.UTF-8"),
    TZ: String(process.env.TZ || "UTC"),
  };

  if (process.env.TERM) env.TERM = String(process.env.TERM);
  return env;
}

export async function ensureSandbox(): Promise<void> {
  await fs.mkdir(rootDir(), { recursive: true, mode: 0o700 });
  await fs.mkdir(tmpDir(), { recursive: true, mode: 0o700 });
}

export function safeMetadata(): JsonObject {
  return {
    enabled: config.sandbox.enabled,
    shell_exec_enabled: config.shellExecEnabled,
    platform: process.platform,
    version: process.version,
  };
}

export async function listDir(relPath: string): Promise<DirEntryInfo[]> {
  const dir = await resolveExistingInside(relPath);
  const dirStat = await fs.lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error("La ruta no es un directorio válido.");
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: DirEntryInfo[] = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const stat = await fs.lstat(absolute);
    result.push({
      name: entry.name,
      type: entry.isFile()
        ? "file"
        : entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  return result;
}

export async function readFileHead(
  relPath: string,
  maxBytes = 4096,
): Promise<FileHeadResult> {
  const file = await resolveExistingInside(relPath);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("La ruta no es un archivo regular.");
  }

  const length = clampMaxBytes(maxBytes);
  const handle = await fs.open(file, constants.O_RDONLY | NO_FOLLOW);

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      bytes: bytesRead,
      text: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

export async function writeLocalFile(
  relPath: string,
  content: string,
): Promise<string> {
  assertSandboxEnabled();
  const lexical = lexicalPath(relPath);
  const root = await canonicalRoot();

  await fs.mkdir(path.dirname(lexical), { recursive: true, mode: 0o700 });
  const parent = assertCanonicalInside(root, await fs.realpath(path.dirname(lexical)));
  const file = assertCanonicalInside(root, path.join(parent, path.basename(lexical)));

  try {
    const existing = await fs.lstat(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Destino de escritura inválido.");
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_TRUNC |
    NO_FOLLOW;
  const handle = await fs.open(file, flags, 0o600);

  try {
    await handle.writeFile(String(content ?? ""), "utf8");
  } finally {
    await handle.close();
  }

  return file;
}

export async function executeLocalShell(
  script: string,
  timeout = 30_000,
): Promise<ShellExecResult> {
  assertSandboxEnabled();
  if (!config.shellExecEnabled) {
    throw new Error(
      "shell.exec deshabilitado. Requiere HOCKER_ALLOW_UNSANDBOXED_SHELL=true.",
    );
  }

  const cleanScript = String(script ?? "");
  if (!cleanScript.trim() || cleanScript.includes("\0")) {
    throw new Error("Script inválido.");
  }

  await ensureSandbox();
  const start = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", cleanScript], {
      cwd: await canonicalRoot(),
      timeout: clampTimeout(timeout),
      maxBuffer: 10 * 1024 * 1024,
      env: safeChildEnv(),
    });

    return {
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      timedOut: false,
      elapsedMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      signal?: NodeJS.Signals | null;
      code?: number | string | null;
      killed?: boolean;
    };
    const exitCode =
      typeof err.code === "number" ? err.code : err.killed ? 124 : null;
    const timedOut = Boolean(err.killed);

    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      signal: err.signal ?? null,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? "Shell execution failed."),
      timedOut,
      elapsedMs: Date.now() - start,
    };
  }
}
