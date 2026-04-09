import path from "node:path";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execAsync = promisify(exec);

const READ_DIR_LIMIT = Number(process.env.READ_DIR_LIMIT ?? 200);
const FILE_HEAD_BYTES = Number(process.env.FILE_HEAD_BYTES ?? 65_536);
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const BLOCKED_PATTERNS = [
  "rm -rf /",
  "shutdown",
  "reboot",
  ":(){:|:&};:",
  "mkfs",
  "dd if=",
];

export type DirEntry = {
  name: string;
  type: "file" | "dir" | "other";
  size?: number;
  mtime?: string;
};

export function sandboxRoot(): string {
  return path.resolve(process.cwd(), config.sandboxRoot);
}

export function safeSandboxPath(rel: string): string {
  const root = sandboxRoot();
  const cleaned = String(rel || ".").trim() || ".";
  const full = path.resolve(root, cleaned);

  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("Ruta fuera del sandbox permitido.");
  }
  return full;
}

export async function listDir(relDir: string): Promise<DirEntry[]> {
  const full = safeSandboxPath(relDir || ".");
  const items = await fs.readdir(full, { withFileTypes: true });
  const out: DirEntry[] = [];

  for (const it of items.slice(0, READ_DIR_LIMIT)) {
    const p = path.join(full, it.name);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(p);
    } catch {}

    out.push({
      name: it.name,
      type: it.isDirectory() ? "dir" : it.isFile() ? "file" : "other",
      size: stat?.isFile() ? stat.size : undefined,
      mtime: stat?.mtime ? new Date(stat.mtime).toISOString() : undefined,
    });
  }
  return out;
}

export async function readFileHead(
  relPath: string,
  maxBytes: number
): Promise<{ bytes: number; text: string }> {
  const full = safeSandboxPath(relPath);
  const cap = Math.max(256, Math.min(maxBytes, FILE_HEAD_BYTES));

  const fh = await fs.open(full, "r");
  try {
    const buf = Buffer.allocUnsafe(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    return { bytes: bytesRead, text: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await fh.close();
  }
}

export async function executeLocalShell(
  script: string,
  timeoutMs = 120_000
): Promise<{ stdout: string; stderr: string }> {
  const cmd = String(script || "").trim();
  if (!cmd) throw new Error("El script no puede estar vacío.");

  for (const pattern of BLOCKED_PATTERNS) {
    if (cmd.includes(pattern)) {
      throw new Error(`Comando bloqueado por política de seguridad: "${pattern}"`);
    }
  }

  const { stdout, stderr } = await execAsync(cmd, {
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    cwd: sandboxRoot(),
  });

  return {
    stdout: (stdout || "").trim(),
    stderr: (stderr || "").trim(),
  };
}

export async function writeLocalFile(relPath: string, content: string): Promise<string> {
  const full = safeSandboxPath(relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, String(content ?? ""), "utf-8");
  return full;
}
