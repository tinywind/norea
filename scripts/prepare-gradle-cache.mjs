import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

try {
  if (await sha256(destination) === checksum) {
    console.log(`Verified cached Gradle ${version} distribution.`);
    process.exit(0);
  }
  console.warn("The cached Gradle ZIP does not match the pinned checksum; downloading a verified replacement.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(cacheDirectory, { recursive: true });

for (let attempt = 1; attempt <= 3; attempt++) {
  const partial = `${destination}.part-${process.pid}-${randomUUID()}`;
  try {
    // The release asset API avoids the public browser-download redirect that can return 504.
    const release = JSON.parse(execFileSync("gh", ["api", `repos/gradle/gradle-distributions/releases/tags/v${version}`], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }));
    const assets = release.assets?.filter(asset => asset.name === filename) ?? [];
    const asset = assets[0];
    if (assets.length !== 1 || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        asset.digest !== "sha256:" + checksum) {
      throw new Error("The official Gradle release metadata does not match the pinned distribution checksum.");
    }
    const descriptor = openSync(partial, "wx");
    let download;
    try {
      download = spawnSync("gh", ["api", `repos/gradle/gradle-distributions/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"], {
        stdio: ["ignore", descriptor, "pipe"], encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024,
      });
    } finally {
      closeSync(descriptor);
    }
    if (download.error || download.status !== 0) {
      throw new Error(`Gradle release asset download failed: ${download.error?.message ?? download.stderr?.trim() ?? download.status}`);
    }
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
