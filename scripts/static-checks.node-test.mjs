import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const biome = require.resolve("@biomejs/biome/bin/biome");

test("the frontend lint gate rejects duplicate switch cases", (t) => {
  mkdirSync(".tmp", { recursive: true });
  const cwd = mkdtempSync(".tmp/lint-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  copyFileSync("biome.json", join(cwd, "biome.json"));
  mkdirSync(join(cwd, "src"));
  const source = join(cwd, "src/example.ts");
  for (const [secondCase, expectedStatus] of [
    [2, 0],
    [1, 1],
  ]) {
    writeFileSync(source, `switch (value) { case 1: break; case ${secondCase}: break; }\n`);
    const result = spawnSync(process.execPath, [biome, "lint", "src"], { cwd, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 1) assert.match(result.stderr, /noDuplicateCase/);
  }
});
