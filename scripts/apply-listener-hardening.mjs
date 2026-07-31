import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/index.ts", import.meta.url);
const source = await readFile(path, "utf8");
const target = 'createHealthServer().listen(config.port, "0.0.0.0");';
const replacement = "createHealthServer().listen(config.port, config.host);";

if (source.includes(replacement)) {
  console.log("Agent listener already hardened.");
} else if (source.includes(target)) {
  await writeFile(path, source.replace(target, replacement), "utf8");
  console.log("Agent listener hardened.");
} else {
  throw new Error("Unable to find the Node Agent listener binding.");
}
