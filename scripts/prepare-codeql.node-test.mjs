import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { downloadCodeqlBundle } from "./prepare-codeql.mjs";

const bytes = Buffer.from("verified CodeQL archive fixture");
const asset = { id: 1, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const wait = async () => {};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "norea-codeql-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, destination: join(directory, "codeql-bundle-rust-linux64.tar.zst") };
}

test("publishes a verified archive and reuses it without another download", async t => {
  const { directory, destination } = await fixture(t);
  let downloads = 0;
  const run = (command, args, options) => {
    downloads++;
    assert.equal(command, "gh");
    assert.deepEqual(args, ["api", "repos/github/codeql-action/releases/assets/1", "-H", "Accept: application/octet-stream"]);
    writeSync(options.stdio[1], bytes);
    return { status: 0 };
  };
  await downloadCodeqlBundle(destination, asset, { run, wait });
  await downloadCodeqlBundle(destination, asset, { run, wait });
  assert.equal(downloads, 1);
  assert.deepEqual(await readFile(destination), bytes);
  assert.deepEqual(await readdir(directory), ["codeql-bundle-rust-linux64.tar.zst"]);
});

test("rejects an equal-sized corrupt archive and preserves the existing file", async t => {
  const { directory, destination } = await fixture(t);
  const previous = Buffer.from("previous archive");
  await writeFile(destination, previous);
  let downloads = 0;
  const run = (_command, _args, options) => {
    downloads++;
    writeSync(options.stdio[1], Buffer.alloc(bytes.length));
    return { status: 0 };
  };
  await assert.rejects(downloadCodeqlBundle(destination, asset, { run, wait }), /SHA-256 verification/);
  assert.equal(downloads, 3);
  assert.deepEqual(await readFile(destination), previous);
  assert.deepEqual(await readdir(directory), ["codeql-bundle-rust-linux64.tar.zst"]);
});

test("cleans incomplete downloads and retries before publishing a replacement", async t => {
  const { directory, destination } = await fixture(t);
  await writeFile(destination, "corrupt cache");
  let downloads = 0;
  const run = (_command, _args, options) => {
    downloads++;
    writeSync(options.stdio[1], downloads === 1 ? bytes.subarray(0, 5) : bytes);
    return downloads === 1 ? { status: null, error: { code: "ETIMEDOUT" } } : { status: 0 };
  };
  await downloadCodeqlBundle(destination, asset, { run, wait });
  assert.equal(downloads, 2);
  assert.deepEqual(await readFile(destination), bytes);
  assert.deepEqual(await readdir(directory), ["codeql-bundle-rust-linux64.tar.zst"]);
});

test("rejects unsupported language inputs without publishing a tools output", async t => {
  const { directory } = await fixture(t);
  const output = join(directory, "output");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./prepare-codeql.mjs", import.meta.url))], {
    env: { ...process.env, CODEQL_LANGUAGE: "__proto__", RUNNER_TEMP: directory, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supported CODEQL_LANGUAGE/);
  assert.deepEqual(await readdir(directory), []);
});
