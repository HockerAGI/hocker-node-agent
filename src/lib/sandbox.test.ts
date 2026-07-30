import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hocker-agent-test-"));
const sandboxRoot = path.join(workspace, "sandbox");
const outsideRoot = path.join(workspace, "outside");

process.env.HOCKER_COMMAND_HMAC_SECRET = "hmac-secret-for-tests-1234567890";
process.env.HOCKER_AGENT_KEY = "agent-key-for-tests-1234567890";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests-1234567890";
process.env.SANDBOX_ROOT = sandboxRoot;
process.env.SANDBOX_ENABLED = "true";
process.env.HOCKER_ALLOW_UNSANDBOXED_SHELL = "false";

const sandbox = await import("./sandbox.js");

test("sandbox blocks symlink reads, writes and shell by default", async () => {
  await fs.mkdir(outsideRoot, { recursive: true });
  await sandbox.ensureSandbox();

  const outsideFile = path.join(outsideRoot, "secret.txt");
  await fs.writeFile(outsideFile, "secret", "utf8");
  await fs.symlink(outsideFile, path.join(sandboxRoot, "escape.txt"));

  await assert.rejects(
    () => sandbox.readFileHead("escape.txt"),
    /sandbox|enlace simbólico|archivo regular/i,
  );

  await assert.rejects(
    () => sandbox.writeLocalFile("escape.txt", "overwrite"),
    /destino|enlace simbólico|sandbox/i,
  );

  await assert.rejects(
    () => sandbox.executeLocalShell("cat /etc/passwd"),
    /deshabilitado/i,
  );

  assert.equal(await fs.readFile(outsideFile, "utf8"), "secret");
});

test.after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});
