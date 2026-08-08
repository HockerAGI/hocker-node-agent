import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("repository security controls exist", async () => {
  for (const path of [".github/CODEOWNERS", ".github/dependabot.yml", "SECURITY.md"]) {
    assert.ok((await read(path)).trim().length > 0, `${path} must exist`);
  }
});

test("workflow dependencies are immutable and checkout credentials are not persisted", async () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => /\.ya?ml$/i.test(name));
  const violations: string[] = [];

  for (const file of files) {
    const source = await read(`.github/workflows/${file}`);
    if (/actions\/checkout@/i.test(source) && !/persist-credentials:\s*false/.test(source)) {
      violations.push(`${file}: checkout persists credentials`);
    }
    for (const [index, line] of source.split("\n").entries()) {
      const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
      if (!match) continue;
      const ref = match[1];
      if (!ref) continue;
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
      if (!/@[0-9a-f]{40}$/i.test(ref)) violations.push(`${file}:${index + 1}: ${ref}`);
    }
  }

  assert.deepEqual(violations, [], `Supply-chain violations:\n${violations.join("\n")}`);
});
