import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLegacyAndroidDevAsset, uploadReleaseAssets } from "./upload-github-release-assets.mjs";

test("identifies legacy Android dev assets without matching canonical APK names", () => {
  assert.equal(isLegacyAndroidDevAsset("norea-arm64.apk"), false);
  assert.equal(isLegacyAndroidDevAsset("norea-x86_64.apk"), false);
  assert.equal(isLegacyAndroidDevAsset("SHA256SUMS.txt"), false);
  assert.equal(isLegacyAndroidDevAsset("norea-arm64-signed-release.apk"), true);
  assert.equal(isLegacyAndroidDevAsset("norea-x86_64-debug.apk.sha256"), true);
  assert.equal(isLegacyAndroidDevAsset("norea-signed-release-apk-checksums"), true);
});

test("creates missing dev prerelease and uploads assets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "norea-release-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "norea-arm64.apk"), "apk-bytes");
  await writeFile(join(dir, "SHA256SUMS.txt"), "hash  norea-arm64.apk\n");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body });
    if (url.endsWith("/releases/tags/dev-0.2")) {
      return new Response(null, { status: 404 });
    }
    if (url.endsWith("/releases") && options.method === "POST") {
      return new Response(JSON.stringify({ id: 42, assets: [] }), { status: 201 });
    }
    if (url.startsWith("https://uploads.github.com/repos/tinywind/norea/releases/42/assets?name=")) {
      return new Response(JSON.stringify({ id: 100 }), { status: 201 });
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${url}`);
  };

  await uploadReleaseAssets({
    repository: "tinywind/norea",
    tag: "dev-0.2",
    assetsDir: dir,
    token: "test-token",
    createPrerelease: true,
    title: "Latest 0.2 dev build",
    notes: "Notes",
    targetCommitish: "abc123",
    pruneLegacyAndroidDevAssets: true,
    fetchImpl,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), {
    tag_name: "dev-0.2",
    target_commitish: "abc123",
    name: "Latest 0.2 dev build",
    body: "Notes",
    prerelease: true,
  });
  assert.match(calls[2].url, /name=SHA256SUMS\.txt$/);
  assert.match(calls[3].url, /name=norea-arm64\.apk$/);
});

test("replaces clobbered assets and prunes legacy Android dev assets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "norea-release-clobber-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "norea-arm64.apk"), "new-apk");

  const deleted = [];
  const uploaded = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/releases/tags/dev-0.2")) {
      return new Response(JSON.stringify({
        id: 7,
        assets: [
          { id: 1, name: "norea-arm64.apk" },
          { id: 2, name: "norea-arm64-legacy.apk" },
          { id: 3, name: "norea-x64.exe" },
        ],
      }), { status: 200 });
    }
    if (options.method === "DELETE") {
      deleted.push(url.split("/").at(-1));
      return new Response(null, { status: 204 });
    }
    if (options.method === "POST") {
      uploaded.push(url);
      return new Response(JSON.stringify({ id: 9 }), { status: 201 });
    }
    throw new Error(`Unexpected request: ${options.method} ${url}`);
  };

  await uploadReleaseAssets({
    repository: "tinywind/norea",
    tag: "dev-0.2",
    assetsDir: dir,
    token: "test-token",
    pruneLegacyAndroidDevAssets: true,
    fetchImpl,
  });

  assert.deepEqual(deleted, ["1", "2"]);
  assert.equal(uploaded.length, 1);
  assert.match(uploaded[0], /name=norea-arm64\.apk$/);
});
