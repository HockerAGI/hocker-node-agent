import { spawn } from "node:child_process";

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export async function runSandboxed(command: string, args: string[], timeoutMs = 15000): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: "/tmp",
        NODE_ENV: "production"
      }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code: code ?? -1
      });
    });
  });
}