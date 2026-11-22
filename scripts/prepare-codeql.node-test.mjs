import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("publishes a verified archive via redirected asset download without leaking auth headers and reuses it", async t => {
  const { directory, destination } = await fixture(t);
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, headers: options.headers ?? {}, redirect: options.redirect });
    if (url === "https://api.github.com/repos/github/codeql-action/releases/assets/1") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/bundle.tar.zst?sig=abc" },
      });
    }
    return new Response(bytes, { status: 200 });
  };
  await downloadCodeqlBundle(destination, asset, { fetchImpl, token: "secret-token", wait });
  await downloadCodeqlBundle(destination, asset, { fetchImpl, token: "secret-token", wait });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.Accept, "application/octet-stream");
  assert.equal(requests[0].headers.Authorization, "Bearer secret-token");
  assert.equal(requests[0].redirect, "manual");
  assert.equal(requests[1].url, "https://release-assets.githubusercontent.com/bundle.tar.zst?sig=abc");
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.deepEqual(await readFile(destination), bytes);
  assert.deepEqual(await readdir(directory), ["codeql-bundle-rust-linux64.tar.zst"]);
});

test("rejects an equal-sized corrupt archive and preserves the existing file", async t => {
  const { directory, destination } = await fixture(t);
  const previous = Buffer.from("previous archive");
  await writeFile(destination, previous);
  let downloads = 0;
  const fetchImpl = async () => {
    downloads++;
    return new Response(Buffer.alloc(bytes.length), { status: 200 });
  };
  await assert.rejects(downloadCodeqlBundle(destination, asset, { fetchImpl, token: "", wait }), /SHA-256 verification/);
  assert.equal(downloads, 3);
  assert.deepEqual(await readFile(destination), previous);
  assert.deepEqual(await readdir(directory), ["codeql-bundle-rust-linux64.tar.zst"]);
});

test("cleans incomplete downloads and retries before publishing a replacement", async t => {
  const { directory, destination } = await fixture(t);
  await writeFile(destination, "corrupt cache");
  let downloads = 0;
  const fetchImpl = async () => {
    downloads++;
    if (downloads === 1) {
      return new Response(null, { status: 504 });
    }
    return new Response(bytes, { status: 200 });
  };
  await downloadCodeqlBundle(destination, asset, { fetchImpl, token: "", wait });
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
