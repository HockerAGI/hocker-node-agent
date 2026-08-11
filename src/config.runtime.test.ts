import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOCKER_AGENT_HOST: "127.0.0.1",
  HOCKER_AGENT_ALLOW_LAN: "false",
  PORT: "8081",
  PROJECT_ID: "hocker-one",
  NODE_ID: "hocker-node-test",
  POLL_MS: "5000",
  HEARTBEAT_MS: "15000",
  MAX_COMMAND_AGE_MS: "300000",
  HOCKER_COMMAND_HMAC_SECRET: "command-signing-secret-test-1234567890",
  HOCKER_AGENT_KEY: "agent-api-secret-test-0987654321",
  ORCHESTRATOR_URL: "",
  HOCKER_ALLOW_UNSANDBOXED_SHELL: "false",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-test-1234567890",
  SANDBOX_ENABLED: "true",
  SANDBOX_ROOT: "./sandbox-test",
  MIRROR_ENABLED: "false",
  MIRROR_PRIMARY_NODE_ID: "",
  MIRROR_NODE_ID: "",
};

function loadConfig(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", "import('./src/config.ts')"],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, ...overrides },
      encoding: "utf8",
    },
  );
}

function output(result: ReturnType<typeof loadConfig>) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

test("runtime config accepts the safe baseline", () => {
  const result = loadConfig();
  assert.equal(result.status, 0, output(result));
});

test("runtime config rejects non-loopback binding without explicit LAN opt-in", () => {
  const result = loadConfig({ HOCKER_AGENT_HOST: "0.0.0.0" });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /HOCKER_AGENT_ALLOW_LAN=true/);
});

test("runtime config rejects shared API and command-signing secrets", () => {
  const shared = "shared-secret-test-12345678901234567890";
  const result = loadConfig({
    HOCKER_COMMAND_HMAC_SECRET: shared,
    HOCKER_AGENT_KEY: shared,
  });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /deben ser secretos distintos/);
});

test("runtime config rejects unsandboxed shell execution", () => {
  const result = loadConfig({
    HOCKER_ALLOW_UNSANDBOXED_SHELL: "true",
    SANDBOX_ENABLED: "false",
  });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /shell\.exec requiere SANDBOX_ENABLED=true/);
});

test("runtime config rejects filesystem root as sandbox", () => {
  const result = loadConfig({ SANDBOX_ROOT: "/" });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /SANDBOX_ROOT no puede ser la raíz/);
});

test("runtime config enforces schema validation for URL and secret length", () => {
  const invalidUrl = loadConfig({ SUPABASE_URL: "not-a-url" });
  assert.notEqual(invalidUrl.status, 0);

  const shortSecret = loadConfig({ HOCKER_AGENT_KEY: "too-short" });
  assert.notEqual(shortSecret.status, 0);
});
