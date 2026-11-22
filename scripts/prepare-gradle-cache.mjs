import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const properties = await readFile(new URL("../src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties", import.meta.url), "utf8");
const property = name => properties.match(new RegExp("^" + name + "=(.+)$", "m"))?.[1].trim();
const distributionUrl = property("distributionUrl")?.replaceAll("\\:", ":");
const checksum = property("distributionSha256Sum");
const version = /^https:\/\/services\.gradle\.org\/distributions\/gradle-(\d+\.\d+(?:\.\d+)?)-bin\.zip$/.exec(distributionUrl ?? "")?.[1];
if (!version || !/^[a-f0-9]{64}$/.test(checksum ?? "")) {
  throw new Error("The Gradle wrapper must declare an official stable binary distribution and its SHA-256 checksum.");
}
for (const name of ["distributionBase", "zipStoreBase"]) {
  if (property(name) !== "GRADLE_USER_HOME") throw new Error("Unsupported Gradle wrapper cache base: " + name);
}
for (const name of ["distributionPath", "zipStorePath"]) {
  if (property(name) !== "wrapper/dists") throw new Error("Unsupported Gradle wrapper cache path: " + name);
}

// Match the wrapper's PathAssembler; only seed the ZIP and let the wrapper install it.
const urlHash = BigInt("0x" + createHash("md5").update(distributionUrl).digest("hex")).toString(36);
const filename = `gradle-${version}-bin.zip`;
const gradleHome = resolve(process.env.GRADLE_USER_HOME || join(homedir(), ".gradle"));
const cacheDirectory = join(gradleHome, "wrapper", "dists", filename.slice(0, -4), urlHash);
const destination = join(cacheDirectory, filename);
const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

function githubApiHeaders(accept) {
  const headers = {
    Accept: accept,
    "User-Agent": "norea-ci",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }
  return headers;
}

async function fetchReleaseMetadata(releaseVersion) {
  const response = await fetch(
    `https://api.github.com/repos/gradle/gradle-distributions/releases/tags/v${encodeURIComponent(releaseVersion)}`,
    {
      headers: githubApiHeaders("application/vnd.github+json"),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub release API returned HTTP ${response.status}`);
  }
  return response.json();
}

async function downloadReleaseAsset(assetId, partialPath) {
  let response = await fetch(
    `https://api.github.com/repos/gradle/gradle-distributions/releases/assets/${assetId}`,
    {
      headers: githubApiHeaders("application/octet-stream"),
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    },
  );
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Gradle release asset redirect (${response.status}) lacked a Location header.`);
    }
    response = await fetch(location, {
      headers: { "User-Agent": "norea-ci" },
      signal: AbortSignal.timeout(180_000),
    });
  }
  if (!response.ok || !response.body) {
    throw new Error(`Gradle release asset download failed with HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "wx" }));
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

let cachedDistribution = false;
try {
  cachedDistribution = await sha256(destination) === checksum;
  if (cachedDistribution) {
    console.log(`Verified cached Gradle ${version} distribution.`);
  } else {
    console.warn("The cached Gradle ZIP does not match the pinned checksum; downloading a verified replacement.");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!cachedDistribution) {
  await mkdir(cacheDirectory, { recursive: true });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const partial = `${destination}.part-${process.pid}-${randomUUID()}`;
    try {
      // The release asset API avoids the public browser-download redirect that can return 504.
      const release = await fetchReleaseMetadata(version);
      const assets = release.assets?.filter(asset => asset.name === filename) ?? [];
      const asset = assets[0];
      if (assets.length !== 1 || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
          asset.digest !== "sha256:" + checksum) {
        throw new Error("The official Gradle release metadata does not match the pinned distribution checksum.");
      }
      await downloadReleaseAsset(asset.id, partial);
      if ((await stat(partial)).size !== asset.size || await sha256(partial) !== checksum) {
        throw new Error("The downloaded Gradle distribution failed size or SHA-256 verification.");
      }
      await rename(partial, destination);
      console.log(`Prepared verified Gradle ${version} ZIP in the wrapper cache.`);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Gradle preparation attempt ${attempt} failed: ${error.message}`);
      await delay(attempt * 1000);
    } finally {
      await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

// The Gradle Plugin Portal intermittently fails to serve the buildSrc `kotlin-dsl` plugin.
// Resolve buildSrc plugins with retries so the main build reads them from Gradle's cache.
const androidProject = fileURLToPath(new URL("../src-tauri/gen/android/", import.meta.url));
const windows = process.platform === "win32";
const warmupAttempts = 4;
for (let attempt = 1; attempt <= warmupAttempts; attempt++) {
  const warmup = spawnSync(windows ? "gradlew.bat" : "./gradlew", ["--project-dir", "buildSrc", "--no-daemon", "help"], {
    cwd: androidProject, stdio: "inherit", shell: windows, timeout: 600_000,
  });
  if (!warmup.error && warmup.status === 0) {
    console.log("Resolved buildSrc Gradle plugins.");
    break;
  }
  const reason = warmup.error?.message ?? `exit status ${warmup.status ?? warmup.signal}`;
  if (attempt === warmupAttempts) throw new Error(`Resolving buildSrc Gradle plugins failed: ${reason}`);
  console.warn(`buildSrc Gradle plugin resolution attempt ${attempt} failed: ${reason}`);
  await delay(attempt * 15_000);
}
