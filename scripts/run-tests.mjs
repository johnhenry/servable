// `node --test <glob>` support varies across Node's supported version range
// -- passing a single concrete file to `--test` is universally supported,
// so this file *is* that one file: it just imports every compiled test
// module, whose top-level test() calls register into the same run.
// Mirrors fileable's scripts/run-tests.mjs.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const testDir = fileURLToPath(new URL("../dist/test/", import.meta.url));
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.js"));

for (const file of files) {
  await import(pathToFileURL(join(testDir, file)).href);
}
