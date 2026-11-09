import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const runFile = promisify(execFile);

// Keep these aligned with the pinned Tauri CLI's MSI bundler:
// https://github.com/tauri-apps/tauri/blob/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle/windows/msi/mod.rs
export const WIX_SHA256 = "6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31";
const WIX_BYTES = 41_297_555;
const WIX_ASSET = "repos/wixtoolset/wix3/releases/assets/158158052";
export const WIX_CACHE_NAME = "WixTools314";
export const WIX_REQUIRED_FILES = [
  "candle.exe", "candle.exe.config", "darice.cub", "light.exe", "light.exe.config",
  "wconsole.dll", "winterop.dll", "wix.dll", "WixUIExtension.dll", "WixUtilExtension.dll",
];

/** GitHub's asset API can remain available when its browser download route returns 504. */
export async function downloadWixArchive(archive, {
  run = runFile,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  let bytes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await run("gh", ["api", WIX_ASSET, "-H", "Accept: application/octet-stream"], {
        encoding: "buffer", maxBuffer: WIX_BYTES + 1, timeout: 120_000,
        windowsHide: true,
      });
      bytes = result.stdout;
      break;
    } catch {
      if (attempt === 3) throw new Error("The official WiX asset download failed after three attempts.");
      await wait(attempt * 1_000);
    }
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== WIX_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== WIX_SHA256) {
    throw new Error("The WiX archive does not match Tauri's pinned SHA-256 and size.");
  }
  // No partial or unverified download is published to the tool cache.
  await writeFile(archive, bytes, { flag: "wx" });
}

async function extractWixArchive(archive, destination) {
  await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:NOREA_WIX_ARCHIVE -DestinationPath $env:NOREA_WIX_DESTINATION"], {
    env: { ...process.env, NOREA_WIX_ARCHIVE: archive, NOREA_WIX_DESTINATION: destination },
    timeout: 120_000, windowsHide: true,
  });
}

/** Prepare a verified replacement before touching a previously installed cache. */
export async function prepareWixCache(cacheRoot, {
  download = downloadWixArchive,
  extract = extractWixArchive,
} = {}) {
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(path.join(cacheRoot, ".norea-wix-"));
  const target = path.join(cacheRoot, WIX_CACHE_NAME);
  const unpacked = path.join(staging, WIX_CACHE_NAME);
  const previous = path.join(staging, "previous");
  let cleanup = true;
  let previousMoved = false;
  try {
    const archive = path.join(staging, "wix314-binaries.zip");
    await download(archive);
    await extract(archive, unpacked);
    for (const name of WIX_REQUIRED_FILES) {
      const entry = await lstat(path.join(unpacked, name));
      if (!entry.isFile() || entry.size === 0) throw new Error(`The WiX archive is missing a required file: ${name}`);
    }
    try {
      await rename(target, previous);
      previousMoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(unpacked, target);
    } catch (error) {
      if (previousMoved) {
        try { await rename(previous, target); }
        catch (restoreError) {
          cleanup = false;
          throw new AggregateError([error, restoreError], `WiX cache restoration failed; previous files remain in ${previous}`);
        }
      }
      throw error;
    }
    return target;
  } finally {
    if (cleanup) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw new Error("WiX cache preparation requires Windows and LOCALAPPDATA.");
  }
  const target = await prepareWixCache(path.join(process.env.LOCALAPPDATA, "tauri"));
  console.log(`Verified WiX 3.14.1 tools are ready at ${target}`);
}
