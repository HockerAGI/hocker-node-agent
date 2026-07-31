import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("command transitions are scoped to command, project, node and signature", async () => {
  const source = await read("src/index.ts");

  assert.match(source, /\.eq\("id", command\.id\)/);
  assert.match(source, /\.eq\("project_id", config\.projectId\)/);
  assert.match(source, /\.eq\("node_id", config\.nodeId\)/);
  assert.match(source, /\.eq\("signature", command\.signature\)/);
  assert.match(source, /COMMAND_STATE_CONFLICT_DONE/);
});

test("Jurix HTTP endpoints are project scoped and bounded", async () => {
  const source = await read("src/index.ts");

  assert.match(source, /PROJECT_SCOPE_VIOLATION/);
  assert.match(source, /boundedLimit\(url\)/);
  assert.match(source, /VALID_SEVERITIES/);
  assert.match(source, /project_scope_violation/);
  assert.doesNotMatch(source, /\.order\("created_at", \{ ascending: false \}\);/);
});

test("public health is minimal and readiness checks dependencies", async () => {
  const source = await read("src/index.ts");

  assert.match(source, /service: "hocker-node-agent"/);
  assert.match(source, /dependency_unavailable/);
  assert.match(source, /server\.requestTimeout = 15_000/);
  assert.match(source, /server\.headersTimeout = 10_000/);
  assert.doesNotMatch(source, /orchestrator_configured/);
  assert.doesNotMatch(source, /sandbox_enabled/);
});

test("sandbox bounds writes, scripts and output", async () => {
  const source = await read("src/lib/sandbox.ts");

  assert.match(source, /MAX_WRITE_BYTES = 1024 \* 1024/);
  assert.match(source, /MAX_SHELL_SCRIPT_BYTES = 16 \* 1024/);
  assert.match(source, /MAX_SHELL_BUFFER_BYTES = 256 \* 1024/);
  assert.match(source, /HOCKER_SHELL_PATH/);
  assert.doesNotMatch(source, /maxBuffer: 10 \* 1024 \* 1024/);
});
