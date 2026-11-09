import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const runFile = promisify(execFile);

// Tauri CLI 2.12.4's MSI/NSIS bundlers define the cache layout and upstream hashes:
// https://github.com/tauri-apps/tauri/tree/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle/windows
// NSIS SHA-256 pins additionally match the official GitHub release asset digests.
export const WINDOWS_TOOL_ASSETS = {
  wix: {
    label: "WiX 3.14.1", name: "wix314-binaries.zip", bytes: 41_297_555,
    api: "repos/wixtoolset/wix3/releases/assets/158158052",
    hashes: { sha256: "6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31" },
  },
  nsis: {
    label: "NSIS 3.13", name: "nsis-3.13.zip", bytes: 2_363_925,
    api: "repos/tauri-apps/binary-releases/releases/assets/623832696",
    hashes: {
      sha256: "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
      sha1: "db14f8af2ea346b786c6ae19343f61aaf5e09b8e",
    },
  },
  nsisUtils: {
    label: "Tauri NSIS utilities 0.5.3", name: "nsis_tauri_utils.dll", bytes: 34_304,
    api: "repos/tauri-apps/nsis-tauri-utils/releases/assets/345882097",
    hashes: {
      sha256: "5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709",
      sha1: "75197fee3c6a814fe035788d1c34ead39349b860",
    },
  },
};

export const WINDOWS_TOOLSETS = [
  {
    cacheName: "WixTools314", archive: WINDOWS_TOOL_ASSETS.wix, archiveRoot: "",
    requiredFiles: [
      "candle.exe", "candle.exe.config", "darice.cub", "light.exe", "light.exe.config",
      "wconsole.dll", "winterop.dll", "wix.dll", "WixUIExtension.dll", "WixUtilExtension.dll",
    ],
    additionalFiles: [], fileHashes: {},
  },
  {
    cacheName: "NSIS", archive: WINDOWS_TOOL_ASSETS.nsis, archiveRoot: "nsis-3.13",
    requiredFiles: [
      "NSIS.exe", "makensis.exe", "Bin/makensis.exe", "Stubs/lzma-x86-unicode", "Stubs/lzma_solid-x86-unicode",
      "Plugins/x86-unicode/additional/nsis_tauri_utils.dll", "Include/MUI2.nsh", "Include/FileFunc.nsh",
      "Include/x64.nsh", "Include/nsDialogs.nsh", "Include/WinMessages.nsh", "Include/Win/COM.nsh",
      "Include/Win/Propkey.nsh", "Include/Win/RestartManager.nsh",
    ],
    additionalFiles: [{
      path: "Plugins/x86-unicode/additional/nsis_tauri_utils.dll", asset: WINDOWS_TOOL_ASSETS.nsisUtils,
    }],
    fileHashes: {
      "NSIS.exe": { sha1: "6d45d4e8ccf18fe1fdac9164058f356102a2ecf2" },
      "Plugins/x86-unicode/additional/nsis_tauri_utils.dll": WINDOWS_TOOL_ASSETS.nsisUtils.hashes,
    },
  },
];

function matchesHashes(bytes, hashes) {
  return Object.entries(hashes).every(([algorithm, expected]) => createHash(algorithm).update(bytes).digest("hex") === expected);
}

/** GitHub's asset API can remain available when its browser download route returns 504. */
export async function downloadToolAsset(destination, asset, {
  run = runFile,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  let bytes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await run("gh", ["api", asset.api, "-H", "Accept: application/octet-stream"], {
        encoding: "buffer", maxBuffer: asset.bytes + 1, timeout: 120_000,
        windowsHide: true,
      });
      bytes = result.stdout;
      break;
    } catch {
      if (attempt === 3) throw new Error(`The official ${asset.label} asset download failed after three attempts.`);
      await wait(attempt * 1_000);
    }
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== asset.bytes || !matchesHashes(bytes, asset.hashes)) {
    throw new Error(`The ${asset.label} asset does not match its pinned hashes and size.`);
  }
  // No partial or unverified download is published to the tool cache.
  await writeFile(destination, bytes, { flag: "wx" });
}

async function extractToolArchive(archive, destination) {
  await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:NOREA_TOOL_ARCHIVE -DestinationPath $env:NOREA_TOOL_DESTINATION"], {
    env: { ...process.env, NOREA_TOOL_ARCHIVE: archive, NOREA_TOOL_DESTINATION: destination },
    timeout: 120_000, windowsHide: true,
  });
}

/** Prepare a verified replacement, including plugins, before touching the installed cache. */
export async function prepareToolset(cacheRoot, tool, {
  download = downloadToolAsset,
  extract = extractToolArchive,
} = {}) {
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(path.join(cacheRoot, ".norea-windows-tools-"));
  const target = path.join(cacheRoot, tool.cacheName);
  const extracted = path.join(staging, "extracted");
  const unpacked = path.join(extracted, tool.archiveRoot);
  const previous = path.join(staging, "previous");
  let cleanup = true;
  let previousMoved = false;
  try {
    const archive = path.join(staging, tool.archive.name);
    await download(archive, tool.archive);
    await extract(archive, extracted);
    for (const additional of tool.additionalFiles) {
      const destination = path.join(unpacked, additional.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await download(destination, additional.asset);
    }
    for (const name of tool.requiredFiles) {
      const entry = await lstat(path.join(unpacked, name));
      if (!entry.isFile() || entry.size === 0) throw new Error(`The ${tool.cacheName} archive is missing a required file: ${name}`);
    }
    for (const [name, hashes] of Object.entries(tool.fileHashes)) {
      if (!matchesHashes(await readFile(path.join(unpacked, name)), hashes)) {
        throw new Error(`The ${tool.cacheName} file does not match Tauri's pinned hashes: ${name}`);
      }
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
          throw new AggregateError([error, restoreError], `Tool cache restoration failed; previous files remain in ${previous}`);
        }
      }
      throw error;
    }
    return target;
  } finally {
    if (cleanup) await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareWindowsTools(cacheRoot) {
  for (const tool of WINDOWS_TOOLSETS) await prepareToolset(cacheRoot, tool);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    throw new Error("Windows bundler cache preparation requires Windows and LOCALAPPDATA.");
  }
  const cacheRoot = path.join(process.env.LOCALAPPDATA, "tauri");
  await prepareWindowsTools(cacheRoot);
  console.log(`Verified WiX 3.14.1 and NSIS 3.13 tools are ready at ${cacheRoot}`);
}
