import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadToolAsset, prepareToolset, WINDOWS_TOOL_ASSETS, WINDOWS_TOOLSETS } from "./prepare-windows-tools.mjs";

async function cacheFixture(tool, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "norea-windows-tools-test-"));
  await mkdir(path.join(root, tool.cacheName));
  await writeFile(path.join(root, tool.cacheName, "previous.txt"), "previous verified cache");
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const wix = WINDOWS_TOOLSETS[0];
const nsis = WINDOWS_TOOLSETS[1];
const fixtureBytes = Buffer.from("verified fixture");
const fixtureHashes = { sha256: createHash("sha256").update(fixtureBytes).digest("hex") };

test("an invalid asset response cannot create a cached archive", async () => {
  await cacheFixture(wix, async root => {
    const archive = path.join(root, "download.zip");
    await assert.rejects(downloadToolAsset(archive, WINDOWS_TOOL_ASSETS.wix, {
      run: async () => ({ stdout: Buffer.from("not the pinned WiX archive") }),
    }), /pinned hashes/);
    await assert.rejects(readFile(archive), { code: "ENOENT" });
  });
});

for (const asset of Object.values(WINDOWS_TOOL_ASSETS)) {
  test(`${asset.label} with the expected size still must pass its pinned hashes`, async () => {
    await cacheFixture(wix, async root => {
      const archive = path.join(root, "download.zip");
      await assert.rejects(downloadToolAsset(archive, asset, {
        run: async () => ({ stdout: Buffer.alloc(asset.bytes) }),
      }), /pinned hashes/);
      await assert.rejects(readFile(archive), { code: "ENOENT" });
    });
  });
}

test("verified bytes are written only after all configured hashes match", async () => {
  await cacheFixture(wix, async root => {
    const archive = path.join(root, "download.zip");
    const asset = { ...WINDOWS_TOOL_ASSETS.wix, bytes: fixtureBytes.length,
      hashes: { ...fixtureHashes, sha1: createHash("sha1").update(fixtureBytes).digest("hex") } };
    await downloadToolAsset(archive, asset, { run: async () => ({ stdout: fixtureBytes }) });
    assert.deepEqual(await readFile(archive), fixtureBytes);
  });
});

test("failed or interrupted downloads retry three times without replacing the cache", async () => {
  await cacheFixture(wix, async root => {
    let attempts = 0;
    await assert.rejects(prepareToolset(root, wix, {
      download: (archive, asset) => downloadToolAsset(archive, asset, {
        run: async () => { attempts++; throw new Error("HTTP 504 or interrupted stream"); },
        wait: async () => {},
      }),
      extract: async () => assert.fail("a failed download must never be extracted"),
    }), /three attempts/);
    assert.equal(attempts, 3);
    assert.equal(await readFile(path.join(root, wix.cacheName, "previous.txt"), "utf8"), "previous verified cache");
    assert.deepEqual(await readdir(root), [wix.cacheName]);
  });
});

test("incomplete extraction leaves the previous tools intact", async () => {
  await cacheFixture(wix, async root => {
    await assert.rejects(prepareToolset(root, wix, {
      download: async archive => writeFile(archive, fixtureBytes),
      extract: async (_archive, destination) => mkdir(destination),
    }), { code: "ENOENT" });
    assert.equal(await readFile(path.join(root, wix.cacheName, "previous.txt"), "utf8"), "previous verified cache");
    assert.deepEqual(await readdir(root), [wix.cacheName]);
  });
});

async function extractFixture(tool, destination) {
  for (const name of tool.requiredFiles) {
    if (tool.additionalFiles.some(file => file.path === name)) continue;
    const file = path.join(destination, tool.archiveRoot, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, fixtureBytes);
  }
}

test("a failed NSIS plugin download cannot replace an existing toolset", async () => {
  await cacheFixture(nsis, async root => {
    await assert.rejects(prepareToolset(root, nsis, {
      download: async (destination, asset) => {
        if (asset === WINDOWS_TOOL_ASSETS.nsisUtils) throw new Error("plugin download failed");
        await writeFile(destination, fixtureBytes);
      },
      extract: async (_archive, destination) => extractFixture(nsis, destination),
    }), /plugin download failed/);
    assert.equal(await readFile(path.join(root, nsis.cacheName, "previous.txt"), "utf8"), "previous verified cache");
    assert.deepEqual(await readdir(root), [nsis.cacheName]);
  });
});

for (const tool of WINDOWS_TOOLSETS) {
  test(`${tool.cacheName} publishes its exact cache layout including separately downloaded plugins`, async () => {
    await cacheFixture(tool, async root => {
      const fixtureTool = { ...tool, fileHashes: Object.fromEntries(Object.keys(tool.fileHashes).map(name => [name, fixtureHashes])) };
      const downloaded = [];
      const target = await prepareToolset(root, fixtureTool, {
        download: async (destination, asset) => { downloaded.push(asset.api); await writeFile(destination, fixtureBytes); },
        extract: async (_archive, destination) => extractFixture(tool, destination),
      });
      assert.equal(target, path.join(root, tool.cacheName));
      for (const name of tool.requiredFiles) assert.deepEqual(await readFile(path.join(target, name)), fixtureBytes);
      assert.deepEqual(downloaded, [tool.archive.api, ...tool.additionalFiles.map(file => file.asset.api)]);
      await assert.rejects(readFile(path.join(target, "previous.txt")), { code: "ENOENT" });
      assert.deepEqual(await readdir(root), [tool.cacheName]);
    });
  });
}
