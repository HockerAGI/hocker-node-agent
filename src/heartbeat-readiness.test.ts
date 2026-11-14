import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hasFreshNodeHeartbeat } from "./heartbeat-readiness.js";

test("node readiness only accepts a recent persisted heartbeat", () => {
  const now=Date.parse("2026-11-14T03:00:00.000Z");
  const ts=(delta: number) => new Date(now-delta).toISOString();
  assert.equal(hasFreshNodeHeartbeat(ts(0),15_000,now),true);
  assert.equal(hasFreshNodeHeartbeat(ts(45_000),15_000,now),true);
  assert.equal(hasFreshNodeHeartbeat(ts(45_001),15_000,now),false);
  assert.equal(hasFreshNodeHeartbeat(ts(-1000),15_000,now),false);
  assert.equal(hasFreshNodeHeartbeat(null,15_000,now),false);
  assert.equal(hasFreshNodeHeartbeat("invalid",15_000,now),false);
  assert.equal(hasFreshNodeHeartbeat(ts(0),0,now),false);
});

test("physical node /ready checks successful persistence, not just attempted telemetry",async()=>{
  const source=await readFile(new URL("./index.ts",import.meta.url),"utf8");
  assert.match(source,/stats\.lastSuccessfulHeartbeatAt = nowIso\(\)/);
  assert.match(source,/const freshHeartbeat = hasFreshNodeHeartbeat\(/);
  assert.match(source,/!state\.controls\.kill_switch && freshHeartbeat/);
  assert.match(source,/heartbeat_not_fresh/);
  assert.match(source,/last_successful_at: stats\.lastSuccessfulHeartbeatAt \|\| null/);
});
