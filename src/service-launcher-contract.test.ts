import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptUrl = (name: string) => new URL("../scripts/service/" + name, import.meta.url);
const read = (name: string) => readFile(scriptUrl(name), "utf8");

test("operational shell scripts parse correctly and load service.env as data", async () => {
  for (const filename of ["load-env.sh", "install-termux-ubuntu.sh", "start.sh",
    "stop.sh", "run.sh", "status.sh", "doctor.sh", "restart.sh"]) {
    const file = fileURLToPath(scriptUrl(filename));
    const check = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(check.status, 0, filename + ": " + check.stderr);
  }
  for (const filename of ["start.sh", "stop.sh", "run.sh", "status.sh", "doctor.sh"]) {
    const src = await read(filename);
    assert.match(src, /\. "\$SCRIPT_DIR\/load-env\.sh"/);
    assert.ok(src.indexOf("load-env.sh") < src.indexOf("HOCKER_NODE_AGENT_REPO_DIR") ||
      !src.includes("HOCKER_NODE_AGENT_REPO_DIR"));
  }
  const installer = await read("install-termux-ubuntu.sh");
  assert.match(installer, /scripts\/service\/load-env\.sh/);
  assert.match(installer, /chmod 600 "\$SERVICE_BASE\/service\.env"/);
  assert.doesNotMatch(installer, /printf 'PORT=/);
  assert.match(await read("load-env.sh"), /PORT in an older service\.env is deliberately ignored/);
});

test("service.env values are not evaluated as shell code, even with special characters", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "hocker service safe "));
  try {
    const helper = path.join(temp, "load-env.sh");
    const marker = path.join(temp, "should-not-exist");
    await copyFile(fileURLToPath(scriptUrl("load-env.sh")), helper);
    const literal = 'folder$(touch "' + marker + '")';
    await writeFile(path.join(temp, "service.env"),
      "HOCKER_NODE_AGENT_REPO_DIR=" + literal + "\nPORT=18181\nUNKNOWN_OPTION=ignored\n");
    const result = spawnSync("bash", ["-c",
      '. "$1"; printf "%s|%s|%s" "$HOCKER_NODE_AGENT_REPO_DIR" "$PORT" "${UNKNOWN_OPTION:-unset}"',
      "--", helper], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, literal + "||unset");
    assert.equal(existsSync(marker), false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("doctor is fail-closed, reveals no hashes or secret values and stop is PID scoped", async () => {
  const [doctor, stop, status, start] = await Promise.all([
    read("doctor.sh"), read("stop.sh"), read("status.sh"), read("start.sh"),
  ]);
  assert.doesNotMatch(doctor, /hashlib|hexdigest|sha256\(/i);
  assert.match(doctor, /"\$HEALTH_CODE" != "200" \|\| "\$READY_CODE" != "200"/);
  assert.match(doctor, /exit 1/);
  assert.doesNotMatch(stop, /pkill -f/);
  assert.match(stop, /PIDFILE_PROCESS_MISMATCH/);
  assert.match(status, /HOCKER_NODE_AGENT_SHOW_LOGS:-false/);
  assert.match(start, /PIDFILE_PROCESS_MISMATCH/);
});

test("custom repo .env port and inherited PORT remain authoritative over old service.env", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "hocker port precedence "));
  try {
    const helper = path.join(temp, "load-env.sh");
    const repo = path.join(temp, "app repo");
    await mkdir(repo);
    await copyFile(fileURLToPath(scriptUrl("load-env.sh")), helper);
    await writeFile(path.join(repo, ".env"), 'PORT="18443"\nNODE_ID=hocker-node-1\n');
    await writeFile(path.join(temp, "service.env"),
      "HOCKER_NODE_AGENT_REPO_DIR=" + repo + "\nPORT=8081\n");
    const script = '. "$1"; printf "%s" "$PORT"';
    const fromEnv = spawnSync("bash", ["-c", script, "--", helper], {
      encoding: "utf8", env: { ...process.env, PORT: "" },
    });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(fromEnv.stdout, "18443");
    const inherited = spawnSync("bash", ["-c", script, "--", helper], {
      encoding: "utf8", env: { ...process.env, PORT: "19555" },
    });
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(inherited.stdout, "19555");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
