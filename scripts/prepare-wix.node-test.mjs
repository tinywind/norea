import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadWixArchive, prepareWixCache, WIX_CACHE_NAME, WIX_REQUIRED_FILES } from "./prepare-wix.mjs";

async function cacheFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "norea-wix-test-"));
  await mkdir(path.join(root, WIX_CACHE_NAME));
  await writeFile(path.join(root, WIX_CACHE_NAME, "previous.txt"), "previous verified cache");
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("an invalid asset response cannot create a cached archive", async () => {
  await cacheFixture(async root => {
    const archive = path.join(root, "download.zip");
    await assert.rejects(downloadWixArchive(archive, {
      run: async () => ({ stdout: Buffer.from("not the pinned WiX archive") }),
    }), /pinned SHA-256/);
    await assert.rejects(readFile(archive), { code: "ENOENT" });
  });
});

test("an asset with the expected size still must pass the pinned SHA-256", async () => {
  await cacheFixture(async root => {
    const archive = path.join(root, "download.zip");
    await assert.rejects(downloadWixArchive(archive, {
      run: async () => ({ stdout: Buffer.alloc(41_297_555) }),
    }), /pinned SHA-256/);
    await assert.rejects(readFile(archive), { code: "ENOENT" });
  });
});

test("failed or interrupted downloads retry three times without replacing the cache", async () => {
  await cacheFixture(async root => {
    let attempts = 0;
    await assert.rejects(prepareWixCache(root, {
      download: archive => downloadWixArchive(archive, {
        run: async () => { attempts++; throw new Error("HTTP 504 or interrupted stream"); },
        wait: async () => {},
      }),
      extract: async () => assert.fail("a failed download must never be extracted"),
    }), /three attempts/);
    assert.equal(attempts, 3);
    assert.equal(await readFile(path.join(root, WIX_CACHE_NAME, "previous.txt"), "utf8"), "previous verified cache");
    assert.deepEqual(await readdir(root), [WIX_CACHE_NAME]);
  });
});

test("incomplete extraction leaves the previous tools intact", async () => {
  await cacheFixture(async root => {
    await assert.rejects(prepareWixCache(root, {
      download: async archive => writeFile(archive, "verified fixture"),
      extract: async (_archive, destination) => mkdir(destination),
    }), { code: "ENOENT" });
    assert.equal(await readFile(path.join(root, WIX_CACHE_NAME, "previous.txt"), "utf8"), "previous verified cache");
    assert.deepEqual(await readdir(root), [WIX_CACHE_NAME]);
  });
});

test("a complete verified replacement is published without leaving partial tools", async () => {
  await cacheFixture(async root => {
    const target = await prepareWixCache(root, {
      download: async archive => writeFile(archive, "verified fixture"),
      extract: async (_archive, destination) => {
        await mkdir(destination);
        for (const name of WIX_REQUIRED_FILES) await writeFile(path.join(destination, name), "tool fixture");
      },
    });
    assert.equal(target, path.join(root, WIX_CACHE_NAME));
    assert.deepEqual((await readdir(target)).sort(), [...WIX_REQUIRED_FILES].sort());
    assert.deepEqual(await readdir(root), [WIX_CACHE_NAME]);
  });
});
