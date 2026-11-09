import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Keep the CLI version already selected by the CodeQL Action in these workflows.
// Asset IDs, sizes and SHA-256 digests come from the official release API:
// https://api.github.com/repos/github/codeql-action/releases/tags/codeql-bundle-v2.27.4
// Update all four assets together when updating the CodeQL CLI version.
export const CODEQL_VERSION = "2.27.4";
export const CODEQL_BUNDLES = {
  actions: {
    language: "actions", id: 692238277, bytes: 97_007_028,
    sha256: "f12b84c1ed3540c54691257ddea1b72b62f785c8bb3eca907562c6a8a2361d32",
  },
  "javascript-typescript": {
    language: "javascript", id: 692239234, bytes: 136_296_871,
    sha256: "082e798c97831283a2a5f69e9198c51270e5767013d5333daeeab6520af9ce72",
  },
  rust: {
    language: "rust", id: 692239605, bytes: 98_269_325,
    sha256: "1c2f867094b80e43c9a0e511090e57e0ea3bf107600b4b3763c52b9020b4ec4b",
  },
  "java-kotlin": {
    language: "java", id: 692239162, bytes: 278_757_821,
    sha256: "dbeb8e2f4454bf4aad35fe16d8770dcc4a4ce0c3585d8952d57e41905396aff8",
  },
};

async function isVerified(path, asset) {
  try {
    if ((await stat(path)).size !== asset.bytes) return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest("hex") === asset.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Publish only a complete, verified archive; let CodeQL init extract it. */
export async function downloadCodeqlBundle(destination, asset, {
  run = spawnSync,
  wait = delay,
} = {}) {
  if (await isVerified(destination, asset)) return;
  await mkdir(dirname(destination), { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const partial = `${destination}.part-${process.pid}-${randomUUID()}`;
    try {
      const descriptor = openSync(partial, "wx");
      let result;
      try {
        result = run("gh", [
          "api", `repos/github/codeql-action/releases/assets/${asset.id}`,
          "-H", "Accept: application/octet-stream",
        ], {
          stdio: ["ignore", descriptor, "pipe"], encoding: "utf8",
          timeout: 180_000, maxBuffer: 64 * 1024,
        });
      } finally {
        closeSync(descriptor);
      }
      if (result.error || result.status !== 0) {
        throw new Error(`The official CodeQL asset download failed (${result.error?.code ?? result.status}).`);
      }
      if (!await isVerified(partial, asset)) {
        throw new Error("The CodeQL bundle failed its pinned size or SHA-256 verification.");
      }
      await rename(partial, destination);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`CodeQL preparation attempt ${attempt} failed: ${error.message}`);
      await wait(attempt * 1_000);
    } finally {
      await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const asset = Object.hasOwn(CODEQL_BUNDLES, process.env.CODEQL_LANGUAGE ?? "")
    ? CODEQL_BUNDLES[process.env.CODEQL_LANGUAGE] : undefined;
  if (process.platform !== "linux" || process.arch !== "x64" || !asset) {
    throw new Error("CodeQL bundle preparation requires Linux x64 and a supported CODEQL_LANGUAGE.");
  }
  if (!process.env.RUNNER_TEMP || !isAbsolute(process.env.RUNNER_TEMP) ||
      /[\r\n]/.test(process.env.RUNNER_TEMP) || !process.env.GITHUB_OUTPUT) {
    throw new Error("CodeQL bundle preparation requires RUNNER_TEMP and GITHUB_OUTPUT from GitHub Actions.");
  }
  const destination = join(process.env.RUNNER_TEMP, "norea-codeql", CODEQL_VERSION,
    `codeql-bundle-${asset.language}-linux64.tar.zst`);
  await downloadCodeqlBundle(destination, asset);
  await appendFile(process.env.GITHUB_OUTPUT, `tools=${destination}\n`);
  console.log(`Prepared verified CodeQL ${CODEQL_VERSION} bundle for ${asset.language}.`);
}
