import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Node Agent defaults to loopback and requires explicit LAN opt-in", async () => {
  const config = await read("src/config.ts");
  const index = await read("src/index.ts");
  const env = await read(".env.example");

  assert.match(config, /HOCKER_AGENT_HOST/);
  assert.match(config, /127\.0\.0\.1/);
  assert.match(config, /HOCKER_AGENT_ALLOW_LAN/);
  assert.match(config, /!isLoopbackHost\(parsed\.host\) && !parsed\.allowLan/);
  assert.match(index, /listen\(config\.port, config\.host/);
  assert.doesNotMatch(index, /listen\(config\.port, "0\.0\.0\.0"/);
  assert.match(env, /HOCKER_AGENT_ALLOW_LAN=false/);
});

test("Node Agent separates API and command-signing secrets", async () => {
  const config = await read("src/config.ts");

  assert.match(config, /parsed\.commandHmacSecret === parsed\.agentKey/);
  assert.match(config, /deben ser secretos distintos/);
  assert.match(config, /SANDBOX_ROOT no puede ser la raíz/);
});
