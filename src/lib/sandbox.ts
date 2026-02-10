import path from "node:path";
import fs from "node:fs/promises";

export type DirEntry = {
  name: string;
  type: "file" | "dir" | "other";
  size?: number;
  mtime?: string;
};

export function sandboxRoot(): string {
  const root = String(process.env.SANDBOX_ROOT || "./sandbox");
  return path.resolve(process.cwd(), root);
}

export function safeSandboxPath(rel: string): string {
  const root = sandboxRoot();
  const cleaned = String(rel || ".").trim() || ".";
  const full = path.resolve(root, cleaned);

  // traversal guard
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("Ruta fuera de sandbox (blocked).");
  }
  return full;
}

export async function listDir(relDir: string): Promise<DirEntry[]> {
  const full = safeSandboxPath(relDir || ".");
  const limit = Number(process.env.READ_DIR_LIMIT || 200);

  const items = await fs.readdir(full, { withFileTypes: true });
  const out: DirEntry[] = [];

  for (const it of items.slice(0, limit)) {
    const p = path.join(full, it.name);
    let stat: any = null;
    try { stat = await fs.stat(p); } catch {}

    out.push({
      name: it.name,
      type: it.isDirectory() ? "dir" : it.isFile() ? "file" : "other",
      size: stat?.isFile?.() ? stat.size : undefined,
      mtime: stat?.mtime ? new Date(stat.mtime).toISOString() : undefined,
    });
  }
  return out;
}

export async function readFileHead(relPath: string, maxBytes: number): Promise<{ bytes: number; text: string }> {
  const full = safeSandboxPath(relPath);
  const cap = Math.max(256, Math.min(maxBytes, Number(process.env.FILE_HEAD_BYTES || 65536)));

  const buf = await fs.readFile(full);
  const head = buf.subarray(0, cap);

  // texto “best effort”
  const text = head.toString("utf8");
  return { bytes: head.length, text };
}